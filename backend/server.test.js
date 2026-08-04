const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { APP_CATALOG, getCatalogApp } = require('./appCatalog');
const { iconCandidatesFromHtml, safeHttpUrl } = require('./appIcon');
const {
  catalogContainerForApp,
  createContainerPayload,
  discoveredAppStates,
  externalUrlForContainer,
  imagePullPath,
  stateForCatalogApp,
  validateInstallOptions
} = require('./appManager');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-test-'));
process.env.DATA_ROOT = path.join(testRoot, 'data');
process.env.HOST_ROOT = testRoot;
process.env.HOST_EXECUTION = 'local';
process.env.DOCKER_SOCKET = path.join(testRoot, 'docker.sock');

let mockContainer = null;
let lastContainerPayload = null;
const dockerRequestLog = [];
const mockContainerId = 'b'.repeat(64);

const dockerMock = http.createServer((req, res) => {
  dockerRequestLog.push({ method: req.method, url: req.url });
  const respond = (status, payload = null) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(payload === null ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload));
  };

  if (req.method === 'GET' && req.url === '/containers/json?all=1') {
    return respond(200, mockContainer ? [mockContainer] : []);
  }
  if (req.method === 'GET' && req.url === '/images/json?all=0') {
    return respond(200, mockContainer ? [{
      Id: mockContainer.ImageID || 'sha256:' + '9'.repeat(64),
      RepoTags: mockContainer.Image ? [mockContainer.Image] : [],
      RepoDigests: [],
      Size: 1024,
      Created: 1722729600
    }] : []);
  }
  if (req.method === 'GET' && req.url === '/networks') {
    return respond(200, [{
      Id: 'network-id',
      Name: 'bridge',
      Driver: 'bridge',
      Scope: 'local',
      Internal: false,
      Attachable: false,
      Ingress: false,
      Labels: {}
    }]);
  }
  if (req.method === 'GET' && req.url === '/volumes') {
    const volumeMount = mockContainer && (mockContainer.Mounts || [])
      .find((mount) => mount.Type === 'volume' && mount.Name);
    return respond(200, {
      Volumes: volumeMount ? [{
        Name: volumeMount.Name,
        Driver: 'local',
        Scope: 'local',
        Mountpoint: volumeMount.Source,
        Labels: { 'private.token': 'must-not-leak' },
        Options: { password: 'must-not-leak' }
      }] : [],
      Warnings: []
    });
  }
  if (req.method === 'POST' && req.url.startsWith('/images/create?')) {
    return respond(200, '{"status":"downloaded"}\n{"status":"complete"}\n');
  }
  if (req.method === 'POST' && req.url.startsWith('/containers/create?')) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      lastContainerPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const portKey = Object.keys(lastContainerPayload.HostConfig.PortBindings)[0];
      const binding = lastContainerPayload.HostConfig.PortBindings[portKey][0];
      mockContainer = {
        Id: mockContainerId,
        Image: lastContainerPayload.Image,
        ImageID: 'sha256:' + '8'.repeat(64),
        Names: ['/foxos-app-' + lastContainerPayload.Labels['com.foxos.app.id']],
        State: 'created',
        Status: 'Created',
        Labels: lastContainerPayload.Labels,
        Ports: [{
          PrivatePort: Number(portKey.split('/')[0]),
          PublicPort: Number(binding.HostPort),
          Type: 'tcp',
          IP: binding.HostIp
        }]
      };
      respond(201, { Id: mockContainerId, Warnings: [] });
    });
    return;
  }
  if (req.method === 'GET' && mockContainer && req.url === '/containers/' + mockContainer.Id + '/json') {
    return respond(200, {
      Image: mockContainer.ImageID || 'sha256:' + '9'.repeat(64),
      Config: {
        Image: mockContainer.Image || 'unknown',
        Labels: mockContainer.Labels || {},
        Env: mockContainer.Env || [],
        Healthcheck: mockContainer.Healthcheck || null
      },
      Created: mockContainer.Created || '2026-08-04T00:00:00.000000000Z',
      HostConfig: {
        RestartPolicy: mockContainer.RestartPolicy || { Name: 'no', MaximumRetryCount: 0 },
        PortBindings: mockContainer.PortBindings || {}
      },
      Mounts: mockContainer.Mounts || [],
      NetworkSettings: mockContainer.NetworkSettings || { Networks: {} },
      State: {
        Status: mockContainer.State || 'unknown',
        Health: mockContainer.HealthStatus ? { Status: mockContainer.HealthStatus } : null
      }
    });
  }
  if (req.method === 'POST' && mockContainer && req.url === '/containers/' + mockContainer.Id + '/update') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      mockContainer.RestartPolicy = payload.RestartPolicy;
      respond(200, { Warnings: [] });
    });
    return;
  }
  if (req.method === 'POST' && mockContainer && req.url.startsWith('/containers/' + mockContainer.Id + '/')) {
    if (req.url.includes('/stop')) {
      mockContainer.State = 'exited';
      mockContainer.Status = 'Exited (0)';
    } else {
      mockContainer.State = 'running';
      mockContainer.Status = 'Up 1 second';
    }
    return respond(204);
  }
  if (req.method === 'DELETE' && req.url.startsWith('/containers/' + mockContainerId)) {
    mockContainer = null;
    return respond(204);
  }
  if (req.method === 'DELETE' && req.url.startsWith('/volumes/')) {
    return respond(204);
  }
  return respond(404, { message: 'Docker mock route not found' });
});

dockerMock.listen(process.env.DOCKER_SOCKET);

const app = require('./server');
const server = app.listen(0, '127.0.0.1');

const baseUrl = () => {
  const address = server.address();
  return 'http://127.0.0.1:' + address.port;
};

test('catalog installations create real managed Docker container definitions', () => {
  assert.equal(APP_CATALOG.length, 4);
  const uptimeKuma = getCatalogApp('uptime-kuma');
  const options = validateInstallOptions(uptimeKuma, {
    hostPort: '43001',
    bindAddress: '127.0.0.1'
  });
  const payload = createContainerPayload(uptimeKuma, options);

  assert.equal(payload.Image, 'louislam/uptime-kuma:2');
  assert.equal(payload.Labels['com.foxos.managed'], 'true');
  assert.equal(payload.Labels['com.foxos.app.id'], 'uptime-kuma');
  assert.deepEqual(payload.HostConfig.PortBindings['3001/tcp'], [
    { HostIp: '127.0.0.1', HostPort: '43001' }
  ]);
  assert.ok(payload.HostConfig.Binds.includes('foxos-app-uptime-kuma-data:/app/data'));
  assert.equal(payload.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(
    imagePullPath('docker.stirlingpdf.com/stirlingtools/stirling-pdf:latest'),
    '/images/create?fromImage=docker.stirlingpdf.com%2Fstirlingtools%2Fstirling-pdf&tag=latest'
  );
});

test('catalog validates exposure and derives installation state from Docker', () => {
  const itTools = getCatalogApp('it-tools');
  assert.throws(
    () => validateInstallOptions(itTools, { hostPort: 80, bindAddress: '127.0.0.1' }),
    /between 1024 and 65535/
  );
  assert.throws(
    () => validateInstallOptions(itTools, { hostPort: 8083, bindAddress: '192.0.2.10' }),
    /private or public/
  );

  const state = stateForCatalogApp(itTools, [{
    Id: 'a'.repeat(64),
    State: 'running',
    Status: 'Up 10 seconds',
    Labels: {
      'com.foxos.managed': 'true',
      'com.foxos.app.id': 'it-tools'
    },
    Ports: [{ PrivatePort: 80, PublicPort: 8083, Type: 'tcp', IP: '0.0.0.0' }]
  }]);

  assert.equal(state.installed, true);
  assert.equal(state.managedByFoxOS, true);
  assert.equal(state.canManage, true);
  assert.equal(state.state, 'running');
  assert.equal(state.hostPort, 8083);
  assert.equal(state.bindAddress, '0.0.0.0');
});

test('catalog recognizes an existing matching image without taking ownership', () => {
  const uptimeKuma = getCatalogApp('uptime-kuma');
  const existingContainer = {
    Id: 'c'.repeat(64),
    Image: 'louislam/uptime-kuma:1',
    Names: ['/existing-uptime-kuma'],
    State: 'running',
    Status: 'Up 2 days',
    Labels: {},
    Ports: [{ PrivatePort: 3001, PublicPort: 13001, Type: 'tcp', IP: '0.0.0.0' }]
  };

  assert.equal(catalogContainerForApp([existingContainer], uptimeKuma), existingContainer);
  const state = stateForCatalogApp(uptimeKuma, [existingContainer]);
  assert.equal(state.installed, true);
  assert.equal(state.managedByFoxOS, false);
  assert.equal(state.canManage, true);
  assert.equal(state.installationSource, 'docker');
  assert.equal(state.hostPort, 13001);
});

test('discovery returns user-facing applications and excludes dependencies', () => {
  const n8nContainer = {
    Id: 'd'.repeat(64),
    Image: 'custom-n8n-build:latest',
    Names: ['/n8n-service'],
    State: 'running',
    Status: 'Up 1 hour',
    Labels: {
      'coolify.managed': 'true',
      'coolify.type': 'service',
      'coolify.service.subType': 'application',
      'coolify.service.subName': 'n8n',
      'coolify.serviceName': 'workflow-automation',
      'coolify.projectName': 'automation',
      'coolify.resourceName': 'n8n-production',
      'traefik.http.routers.http-n8n.rule': 'Host(`n8n.example.test`) && PathPrefix(`/`)',
      'traefik.http.routers.https-n8n.rule': 'Host(`n8n.example.test`) && PathPrefix(`/`)'
    },
    Ports: [{ PrivatePort: 5678, Type: 'tcp' }]
  };
  const databaseContainer = {
    Id: 'e'.repeat(64),
    Image: 'postgres:16-alpine',
    Names: ['/postgres'],
    State: 'running',
    Status: 'Up 1 hour',
    Labels: {
      'coolify.managed': 'true',
      'coolify.type': 'service',
      'coolify.service.subType': 'database',
      'coolify.service.subName': 'postgres'
    },
    Ports: [{ PrivatePort: 5432, Type: 'tcp' }]
  };
  const workerContainer = {
    Id: 'f'.repeat(64),
    Image: 'n8nio/runners:latest',
    Names: ['/task-runner'],
    State: 'running',
    Status: 'Up 1 hour',
    Labels: {
      'coolify.managed': 'true',
      'coolify.type': 'service',
      'coolify.service.subType': 'application',
      'coolify.service.subName': 'task-runners'
    },
    Ports: [{ PrivatePort: 5680, Type: 'tcp' }]
  };

  assert.equal(externalUrlForContainer(n8nContainer), 'https://n8n.example.test');
  const discovered = discoveredAppStates([n8nContainer, databaseContainer, workerContainer], APP_CATALOG);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].name, 'n8n');
  assert.equal(discovered[0].installed, true);
  assert.equal(discovered[0].canManage, true);
  assert.equal(discovered[0].installationSource, 'coolify');
  assert.equal(discovered[0].externalUrl, 'https://n8n.example.test');
});

test('multiple WordPress instances remain separate and use their route identities', () => {
  const wordpressContainers = ['one', 'two'].map((instance, index) => ({
    Id: String(index + 1).repeat(64),
    Image: 'wordpress:latest',
    Names: ['/wordpress-' + instance],
    State: 'running',
    Status: 'Up 1 hour',
    Labels: {
      'coolify.managed': 'true',
      'coolify.type': 'service',
      'coolify.service.subType': 'application',
      'coolify.service.subName': 'wordpress',
      'coolify.resourceName': 'wordpress-' + instance,
      [`traefik.http.routers.https-wordpress-${instance}.rule`]: `Host(\`blog-${instance}.example.test\`)`
    },
    Ports: [{ PrivatePort: 80, Type: 'tcp' }]
  }));
  wordpressContainers[0].State = 'exited';
  wordpressContainers[0].Status = 'Exited (0) 1 minute ago';
  wordpressContainers[0].Ports = [];

  const discovered = discoveredAppStates(wordpressContainers, APP_CATALOG);
  assert.equal(discovered.length, 2);
  assert.deepEqual(discovered.map((appState) => appState.name), [
    'WordPress · blog-one.example.test',
    'WordPress · blog-two.example.test'
  ]);
  assert.notEqual(discovered[0].id, discovered[1].id);
  assert.deepEqual(discovered.map((appState) => appState.containerName), [
    'wordpress-one',
    'wordpress-two'
  ]);
  assert.equal(discovered[0].state, 'exited');
  assert.equal(discovered[0].hostPort, null);
  assert.equal(discovered.every((appState) => appState.canManage), true);
  assert.equal(discovered.every((appState) => appState.logoUrl.endsWith('/wordpress.svg')), true);
});

test('custom application icon discovery resolves safe favicon sources', () => {
  const candidates = iconCandidatesFromHtml(`
    <link href="/assets/app-mark.svg" rel="icon">
    <link rel="apple-touch-icon" href="icons/touch.png">
    <link rel="stylesheet" href="/styles.css">
  `, 'https://app.example.test/dashboard');

  assert.deepEqual(candidates, [
    'https://app.example.test/assets/app-mark.svg',
    'https://app.example.test/icons/touch.png'
  ]);
  assert.equal(safeHttpUrl('https://app.example.test/favicon.ico').hostname, 'app.example.test');
  assert.equal(safeHttpUrl('file:///etc/passwd'), null);
  assert.equal(safeHttpUrl('https://user:password@app.example.test/icon.svg'), null);
});

test.after(async () => {
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => dockerMock.close(resolve))
  ]);
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('health is public while management APIs require a session', async () => {
  const healthResponse = await fetch(baseUrl() + '/api/health');
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok' });

  const filesResponse = await fetch(baseUrl() + '/api/files');
  assert.equal(filesResponse.status, 401);

  const resourcesResponse = await fetch(baseUrl() + '/api/resources');
  assert.equal(resourcesResponse.status, 401);
});

test('setup creates an authenticated session and unlocks the workspace', async () => {
  const weakPasswordResponse = await fetch(baseUrl() + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'short' })
  });
  assert.equal(weakPasswordResponse.status, 400);

  const setupResponse = await fetch(baseUrl() + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'correct-horse-battery' })
  });
  assert.equal(setupResponse.status, 201);
  const cookie = setupResponse.headers.get('set-cookie').split(';')[0];

  const statusResponse = await fetch(baseUrl() + '/api/auth/status', {
    headers: { Cookie: cookie }
  });
  assert.deepEqual(await statusResponse.json(), {
    isSetup: true,
    authenticated: true,
    username: 'tester'
  });

  const filesResponse = await fetch(baseUrl() + '/api/files?path=%2F', {
    headers: { Cookie: cookie }
  });
  assert.equal(filesResponse.status, 200);
  const workspace = await filesResponse.json();
  assert.ok(workspace.items.some((entry) => entry.name === 'Sunucu' && entry.symlink));

  const terminalResponse = await fetch(baseUrl() + '/api/terminal', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'printf foxos-ok', cwd: '/' })
  });
  assert.equal(terminalResponse.status, 200);
  assert.equal((await terminalResponse.json()).output, 'foxos-ok');

  const initialAppsResponse = await fetch(baseUrl() + '/api/apps', {
    headers: { Cookie: cookie }
  });
  assert.equal(initialAppsResponse.status, 200);
  assert.equal((await initialAppsResponse.json()).apps.every((catalogApp) => !catalogApp.installed), true);

  const installResponse = await fetch(baseUrl() + '/api/apps/it-tools/install', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostPort: 54321, bindAddress: '127.0.0.1' })
  });
  assert.equal(installResponse.status, 201);
  assert.equal((await installResponse.json()).app.state, 'running');
  assert.equal(lastContainerPayload.Image, 'corentinth/it-tools:latest');
  assert.equal(lastContainerPayload.Labels['com.foxos.app.id'], 'it-tools');

  const stopResponse = await fetch(baseUrl() + '/api/apps/it-tools/stop', {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.equal(stopResponse.status, 200);
  assert.equal((await stopResponse.json()).app.state, 'exited');

  const removeResponse = await fetch(baseUrl() + '/api/apps/it-tools?removeData=false', {
    method: 'DELETE',
    headers: { Cookie: cookie }
  });
  assert.equal(removeResponse.status, 200);
  assert.equal(mockContainer, null);

  mockContainer = {
    Id: 'c'.repeat(64),
    Image: 'corentinth/it-tools:2024.10.22-7ca5933',
    Names: ['/existing-it-tools'],
    State: 'running',
    Status: 'Up 2 days',
    Labels: {},
    Ports: [{ PrivatePort: 80, PublicPort: 18083, Type: 'tcp', IP: '0.0.0.0' }]
  };

  const discoveredCatalogResponse = await fetch(baseUrl() + '/api/apps', {
    headers: { Cookie: cookie }
  });
  const discoveredCatalogApps = (await discoveredCatalogResponse.json()).apps;
  const discoveredItTools = discoveredCatalogApps.find((catalogApp) => catalogApp.id === 'it-tools');
  assert.equal(discoveredItTools.installed, true);
  assert.equal(discoveredItTools.canManage, true);

  const duplicateInstallResponse = await fetch(baseUrl() + '/api/apps/it-tools/install', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostPort: 18084, bindAddress: '127.0.0.1' })
  });
  assert.equal(duplicateInstallResponse.status, 409);

  const externalStopResponse = await fetch(baseUrl() + '/api/apps/it-tools/stop', {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.equal(externalStopResponse.status, 404);

  const discoveredContainerStopResponse = await fetch(baseUrl() + '/api/containers/' + mockContainer.Id + '/stop', {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.equal(discoveredContainerStopResponse.status, 200);
  assert.equal(mockContainer.State, 'exited');

  const settingsResponse = await fetch(baseUrl() + '/api/containers/' + mockContainer.Id + '/settings', {
    headers: { Cookie: cookie }
  });
  assert.equal(settingsResponse.status, 200);
  assert.equal((await settingsResponse.json()).settings.restartPolicy, 'no');

  const updateSettingsResponse = await fetch(baseUrl() + '/api/containers/' + mockContainer.Id + '/settings', {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restartPolicy: 'unless-stopped' })
  });
  assert.equal(updateSettingsResponse.status, 200);
  assert.equal((await updateSettingsResponse.json()).settings.restartPolicy, 'unless-stopped');
  assert.equal(mockContainer.RestartPolicy.Name, 'unless-stopped');

  mockContainer = {
    Id: 'd'.repeat(64),
    Image: 'example/custom-web-app:latest',
    Names: ['/stopped-custom-web-app'],
    State: 'exited',
    Status: 'Exited (0)',
    Labels: { 'com.docker.compose.service': 'custom-web-app' },
    Ports: [],
    PortBindings: {
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18085' }]
    }
  };
  const stoppedCustomAppsResponse = await fetch(baseUrl() + '/api/apps', {
    headers: { Cookie: cookie }
  });
  assert.equal(stoppedCustomAppsResponse.status, 200);
  const stoppedCustomApps = (await stoppedCustomAppsResponse.json()).apps;
  const stoppedCustomApp = stoppedCustomApps.find((candidate) => candidate.containerId === mockContainer.Id);
  assert.equal(stoppedCustomApp.state, 'exited');
  assert.equal(stoppedCustomApp.hostPort, 18085);

  const registrySecret = 'http-registry-secret-value';
  mockContainer = {
    Id: 'e'.repeat(64),
    Image: 'example/registry-web:latest',
    ImageID: 'sha256:' + '7'.repeat(64),
    Names: ['/registry-web'],
    State: 'running',
    Status: 'Up 10 minutes',
    Labels: {
      'coolify.managed': 'true',
      'coolify.type': 'application',
      'coolify.projectName': 'registry-test',
      'coolify.resourceName': 'registry-web',
      'traefik.http.routers.registry.rule': 'Host(`registry.example.test`)',
      'traefik.http.routers.registry.entrypoints': 'websecure',
      'private.token': registrySecret
    },
    Ports: [{ PrivatePort: 8080, PublicPort: 18086, Type: 'tcp', IP: '127.0.0.1' }],
    PortBindings: {
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18086' }]
    },
    RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    Env: [`API_TOKEN=${registrySecret}`, 'NODE_ENV=production'],
    Healthcheck: { Test: ['CMD-SHELL', `curl -H 'Authorization: ${registrySecret}' http://localhost/`] },
    HealthStatus: 'healthy',
    Mounts: [{
      Type: 'volume',
      Name: 'registry-data',
      Source: '/var/lib/docker/volumes/registry-data/_data',
      Destination: '/app/data',
      RW: true
    }],
    NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2', Gateway: '172.17.0.1' } } }
  };
  dockerRequestLog.length = 0;

  const scanResponse = await fetch(baseUrl() + '/api/resources/scan', {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.equal(scanResponse.status, 201);
  const scanPayload = await scanResponse.json();
  assert.equal(scanPayload.snapshot.summary.resources, 1);
  assert.equal(scanPayload.snapshot.resources[0].provider, 'coolify');
  assert.equal(scanPayload.snapshot.resources[0].routes[0].domain, 'registry.example.test');
  assert.equal(scanPayload.snapshot.guarantees.runtimeMutated, false);
  assert.equal(dockerRequestLog.every((request) => request.method === 'GET'), true);
  assert.equal(JSON.stringify(scanPayload).includes(registrySecret), false);

  const registryResponse = await fetch(baseUrl() + '/api/resources', {
    headers: { Cookie: cookie }
  });
  assert.equal(registryResponse.status, 200);
  const registryPayload = await registryResponse.json();
  assert.equal(registryPayload.registry.status, 'ready');
  assert.equal(registryPayload.snapshot.snapshotId, scanPayload.snapshot.snapshotId);

  const exportResponse = await fetch(baseUrl() + '/api/resources/export', {
    headers: { Cookie: cookie }
  });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-disposition'), /foxos-resource-plan-snap_/);
  const exportedPlan = await exportResponse.text();
  assert.equal(exportedPlan.includes(registrySecret), false);
  assert.equal(JSON.parse(exportedPlan).exportType, 'foxos-resource-migration-plan');
  mockContainer = null;
});
