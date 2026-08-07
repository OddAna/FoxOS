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
  containerName,
  createContainerPayload,
  discoveredAppStates,
  externalUrlForContainer,
  isManagedMigrationCandidate,
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
  if (req.method === 'GET' && req.url.startsWith('/volumes/')) {
    const volumeMount = mockContainer && (mockContainer.Mounts || [])
      .find((mount) => mount.Type === 'volume' && mount.Name === decodeURIComponent(req.url.slice('/volumes/'.length)));
    return volumeMount
      ? respond(200, { Name: volumeMount.Name, Mountpoint: volumeMount.Source })
      : respond(404, { message: 'No such volume' });
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
        Names: ['/' + lastContainerPayload.Labels['com.foxos.app.id']],
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
  assert.equal(containerName('uptime-kuma'), 'uptime-kuma');
  assert.deepEqual(payload.HostConfig.PortBindings['3001/tcp'], [
    { HostIp: '127.0.0.1', HostPort: '43001' }
  ]);
  assert.ok(payload.HostConfig.Binds.includes('uptime-kuma-data:/app/data'));
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

test('a server-managed migration candidate remains discoverable without a published port or provider route label', () => {
  const candidate = {
    Id: '7'.repeat(64),
    Image: 'sha256:' + '8'.repeat(64),
    Names: ['/defter-example-com'],
    State: 'running',
    Status: 'Up 1 hour',
    Labels: {
      'com.foxos.managed': 'true',
      'com.foxos.migration.source-resource-id': 'res_' + '9'.repeat(32),
      'com.foxos.stateless-migration.id': 'smop_' + 'a'.repeat(32)
    },
    Ports: []
  };

  const discovered = discoveredAppStates([candidate], []);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].containerId, candidate.Id);
  assert.equal(discovered[0].managedByFoxOS, true);
  assert.equal(discovered[0].installationSource, 'foxos');
  assert.equal(discovered[0].state, 'running');
  assert.equal(isManagedMigrationCandidate(candidate), true);
  assert.equal(isManagedMigrationCandidate({ ...candidate, Labels: {
    ...candidate.Labels,
    'com.foxos.stateless-migration.id': 'invalid'
  } }), false);
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

test('a recovered Firefox runtime keeps its readable application identity and icon', () => {
  const container = {
    Id: '6'.repeat(64),
    Image: 'jlesage/firefox@sha256:' + '7'.repeat(64),
    Names: ['/firefox'],
    State: 'running',
    Status: 'Up 1 minute (healthy)',
    Labels: {
      'com.foxos.managed': 'true',
      'com.foxos.app.id': 'res_' + '8'.repeat(32),
      'com.foxos.app.name': 'firefox',
      'com.foxos.image.reference': 'jlesage/firefox'
    },
    Ports: []
  };

  const discovered = discoveredAppStates([container], []);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].profileId, 'firefox');
  assert.equal(discovered[0].name, 'Firefox');
  assert.equal(discovered[0].containerPort, null);
  assert.equal(discovered[0].managedByFoxOS, true);
  assert.equal(discovered[0].image, 'jlesage/firefox');
  assert.equal(discovered[0].logoUrl.endsWith('/firefox.svg'), true);
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

  const adoptionsResponse = await fetch(baseUrl() + '/api/adoptions');
  assert.equal(adoptionsResponse.status, 401);
  const routesResponse = await fetch(baseUrl() + '/api/routes');
  assert.equal(routesResponse.status, 401);
  const secretsResponse = await fetch(baseUrl() + '/api/secrets');
  assert.equal(secretsResponse.status, 401);
  const recoveryResponse = await fetch(baseUrl() + '/api/recovery/status');
  assert.equal(recoveryResponse.status, 401);
  const deploymentsResponse = await fetch(baseUrl() + '/api/deployments');
  assert.equal(deploymentsResponse.status, 401);
  const composeDeploymentsResponse = await fetch(baseUrl() + '/api/compose-deployments');
  assert.equal(composeDeploymentsResponse.status, 401);
  const imageUpdatesResponse = await fetch(baseUrl() + '/api/image-updates');
  assert.equal(imageUpdatesResponse.status, 401);
  const applicationManifestsResponse = await fetch(baseUrl() + '/api/application-manifests');
  assert.equal(applicationManifestsResponse.status, 401);
  const workloadEvidenceResponse = await fetch(baseUrl() + '/api/workload-evidence');
  assert.equal(workloadEvidenceResponse.status, 401);
  const statefulRehearsalsResponse = await fetch(baseUrl() + '/api/stateful-rehearsals');
  assert.equal(statefulRehearsalsResponse.status, 401);
  const statefulCutoverPlanResponse = await fetch(baseUrl() + '/api/stateful-rehearsals/cutover-plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(statefulCutoverPlanResponse.status, 401);
  const statefulCutoverRunResponse = await fetch(
    baseUrl() + '/api/stateful-rehearsals/cutover-plans/srp_' + '1'.repeat(24) + '/run',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  );
  assert.equal(statefulCutoverRunResponse.status, 401);
  const statefulShadowsResponse = await fetch(baseUrl() + '/api/stateful-shadows');
  assert.equal(statefulShadowsResponse.status, 401);
  const independenceAuditsResponse = await fetch(baseUrl() + '/api/independence-audits');
  assert.equal(independenceAuditsResponse.status, 401);
  const migrationOrchestratorResponse = await fetch(baseUrl() + '/api/migration-orchestrator');
  assert.equal(migrationOrchestratorResponse.status, 401);
  const migrationPlanResponse = await fetch(baseUrl() + '/api/migration-orchestrator/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(migrationPlanResponse.status, 401);
  const migrationSelectionResponse = await fetch(baseUrl() + '/api/migration-selections/current');
  assert.equal(migrationSelectionResponse.status, 401);
  const migrationSelectionSaveResponse = await fetch(baseUrl() + '/api/migration-selections/current', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(migrationSelectionSaveResponse.status, 401);
  const migrationRunsResponse = await fetch(baseUrl() + '/api/migration-runs');
  assert.equal(migrationRunsResponse.status, 401);
  const connectionsResponse = await fetch(baseUrl() + '/api/connections');
  assert.equal(connectionsResponse.status, 401);
  const applicationOperationsId = 'res_' + '7'.repeat(32);
  assert.equal((await fetch(baseUrl() + '/api/applications/' + applicationOperationsId + '/update-check')).status, 401);
  assert.equal((await fetch(baseUrl() + '/api/applications/' + applicationOperationsId + '/update-plans', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })).status, 401);
  assert.equal((await fetch(baseUrl() + '/api/applications/' + applicationOperationsId + '/update-status')).status, 401);
  assert.equal((await fetch(baseUrl() + '/api/application-update-plans/auplan_' + '8'.repeat(32) + '/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })).status, 401);
  assert.equal((await fetch(baseUrl() + '/api/application-update-operations/auop_' + '9'.repeat(32) + '/rollback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })).status, 401);
  assert.equal((await fetch(baseUrl() + '/api/applications/' + applicationOperationsId + '/compose-files')).status, 401);
  assert.equal((await fetch(baseUrl() + '/api/applications/' + applicationOperationsId + '/desktop-shortcut', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"visible":false}'
  })).status, 401);
  const migrationRunStartResponse = await fetch(baseUrl() + '/api/migration-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(migrationRunStartResponse.status, 401);
  const migrationRunResponse = await fetch(
    baseUrl() + '/api/migration-runs/mrun_' + '1'.repeat(32)
  );
  assert.equal(migrationRunResponse.status, 401);
  const statelessMigrationsResponse = await fetch(baseUrl() + '/api/stateless-migrations');
  assert.equal(statelessMigrationsResponse.status, 401);
  const statelessMigrationPlanResponse = await fetch(baseUrl() + '/api/stateless-migrations/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(statelessMigrationPlanResponse.status, 401);
  const statelessReviewPath = '/api/stateless-migrations/plans/smplan_' + '1'.repeat(32) + '/review';
  const statelessMigrationReviewResponse = await fetch(baseUrl() + statelessReviewPath);
  assert.equal(statelessMigrationReviewResponse.status, 401);
  const statelessMigrationReviewSaveResponse = await fetch(baseUrl() + statelessReviewPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(statelessMigrationReviewSaveResponse.status, 401);
  const statelessMigrationRunResponse = await fetch(
    baseUrl() + '/api/stateless-migrations/plans/smplan_' + '1'.repeat(32) + '/run',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  );
  assert.equal(statelessMigrationRunResponse.status, 401);
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

  const connectionsResponse = await fetch(baseUrl() + '/api/connections', {
    headers: { Cookie: cookie }
  });
  assert.equal(connectionsResponse.status, 200);
  const connections = (await connectionsResponse.json()).connections;
  assert.equal(connections.length, 1);
  assert.equal(connections[0].id, 'cloudflare');
  assert.equal(connections[0].connected, false);
  assert.equal(connections[0].tokenIncluded, false);

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

  const secretResponse = await fetch(baseUrl() + '/api/secrets', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'server-test-token', value: 'server-test-sensitive-value' })
  });
  assert.equal(secretResponse.status, 201);
  const secretPayload = await secretResponse.json();
  assert.equal(secretPayload.secret.valueIncluded, false);
  assert.equal(JSON.stringify(secretPayload).includes('server-test-sensitive-value'), false);

  const testResourceId = 'res_' + '5'.repeat(32);
  const environmentResponse = await fetch(baseUrl() + '/api/resources/' + testResourceId + '/environment-revisions', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ordinary: { FOXOS_MODE: 'test' },
      secretRefs: { FOXOS_API_TOKEN: 'server-test-token' }
    })
  });
  assert.equal(environmentResponse.status, 201);
  const environmentPayload = await environmentResponse.json();
  assert.equal(environmentPayload.environment.secretValuesIncluded, false);
  assert.equal(JSON.stringify(environmentPayload).includes('server-test-sensitive-value'), false);

  const recoveryResponse = await fetch(baseUrl() + '/api/recovery/status', {
    headers: { Cookie: cookie }
  });
  assert.equal(recoveryResponse.status, 200);
  const recoveryPayload = await recoveryResponse.json();
  assert.equal(recoveryPayload.encryption.initialized, true);
  assert.equal(recoveryPayload.backup.ready, false);
  assert.equal(recoveryPayload.backup.credentialsIncluded, false);

  const applicationManifestStatusResponse = await fetch(baseUrl() + '/api/application-manifests', {
    headers: { Cookie: cookie }
  });
  assert.equal(applicationManifestStatusResponse.status, 200);
  const applicationManifestStatus = await applicationManifestStatusResponse.json();
  assert.equal(applicationManifestStatus.authority, 'server-owned-provider-neutral');
  assert.equal(applicationManifestStatus.guarantees.externalProviderRequired, false);

  const initialAppsResponse = await fetch(baseUrl() + '/api/apps', {
    headers: { Cookie: cookie }
  });
  assert.equal(initialAppsResponse.status, 200);
  assert.equal((await initialAppsResponse.json()).apps.every((catalogApp) => !catalogApp.installed), true);

  const initialApplicationInventoryResponse = await fetch(baseUrl() + '/api/applications', {
    headers: { Cookie: cookie }
  });
  assert.equal(initialApplicationInventoryResponse.status, 200);
  const initialApplicationInventory = await initialApplicationInventoryResponse.json();
  assert.equal(initialApplicationInventory.schemaVersion, 2);
  assert.deepEqual(initialApplicationInventory.applications, []);

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

  const applicationInventoryResponse = await fetch(baseUrl() + '/api/applications', {
    headers: { Cookie: cookie }
  });
  assert.equal(applicationInventoryResponse.status, 200);
  const applicationInventory = await applicationInventoryResponse.json();
  assert.equal(applicationInventory.applications.length, 1);
  assert.match(applicationInventory.applications[0].id, /^res_[a-f0-9]{32}$/);
  assert.equal(applicationInventory.applications[0].runtime.containerId, mockContainer.Id);
  assert.equal(applicationInventory.applications[0].runtime.operationalState, 'stopped');
  assert.equal(applicationInventory.applications[0].authority, 'observed');
  assert.equal(applicationInventory.applications[0].capabilities.start, true);
  assert.equal(applicationInventory.applications[0].capabilities.stop, false);
  assert.equal(applicationInventory.applications[0].desktopShortcutVisible, true);

  const applicationId = applicationInventory.applications[0].id;
  const hideShortcutResponse = await fetch(baseUrl() + '/api/applications/' + applicationId + '/desktop-shortcut', {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible: false })
  });
  assert.equal(hideShortcutResponse.status, 200);
  const hiddenInventoryResponse = await fetch(baseUrl() + '/api/applications', { headers: { Cookie: cookie } });
  assert.equal((await hiddenInventoryResponse.json()).applications[0].desktopShortcutVisible, false);
  const showShortcutResponse = await fetch(baseUrl() + '/api/applications/' + applicationId + '/desktop-shortcut', {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible: true })
  });
  assert.equal(showShortcutResponse.status, 200);

  const composeFilesResponse = await fetch(baseUrl() + '/api/applications/' + applicationId + '/compose-files', {
    headers: { Cookie: cookie }
  });
  assert.equal(composeFilesResponse.status, 200);
  assert.equal((await composeFilesResponse.json()).compose.editable, false);

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
  const registryVolumePath = path.join(testRoot, 'var/lib/docker/volumes/registry-data/_data');
  fs.mkdirSync(registryVolumePath, { recursive: true });
  fs.writeFileSync(path.join(registryVolumePath, 'registry.db'), 'test-data');
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

  const manifestDraftResponse = await fetch(baseUrl() + '/api/application-manifests/drafts', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceId: scanPayload.snapshot.resources[0].id,
      confirmation: 'PLAN APPLICATION MANIFEST'
    })
  });
  assert.equal(manifestDraftResponse.status, 201);
  const manifestDraftPayload = await manifestDraftResponse.json();
  assert.equal(manifestDraftPayload.draft.gates.status, 'blocked');
  assert.equal(
    manifestDraftPayload.draft.gates.blockers.some((blocker) => blocker.code === 'external-provider-authority'),
    true
  );
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

  dockerRequestLog.length = 0;
  const serverMigrationPlanResponse = await fetch(baseUrl() + '/api/migration-orchestrator/plans', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: 'PLAN SERVER MIGRATION' })
  });
  assert.equal(serverMigrationPlanResponse.status, 201);
  const serverMigrationPlan = (await serverMigrationPlanResponse.json()).plan;
  assert.equal(serverMigrationPlan.mode, 'read-only-server-migration-plan');
  assert.equal(serverMigrationPlan.summary.resources, 1);
  assert.equal(serverMigrationPlan.summary.migrationRequired, 1);
  assert.equal(serverMigrationPlan.resources[0].strategy, 'shadow-refresh-bounded-quiesce');
  assert.equal(serverMigrationPlan.resources[0].availability.sourcePauseBudgetMs, 120000);
  assert.equal(serverMigrationPlan.guarantees.dockerRequestsMade, 0);
  assert.equal(serverMigrationPlan.guarantees.runtimeMutated, false);
  assert.equal(serverMigrationPlan.guarantees.applyImplemented, true);
  assert.equal(serverMigrationPlan.guarantees.zeroDowntimeStatefulPostRoadmap, true);
  assert.equal(dockerRequestLog.length, 0);
  assert.equal(JSON.stringify(serverMigrationPlan).includes(registrySecret), false);

  const persistedMigrationPlanResponse = await fetch(
    baseUrl() + '/api/migration-orchestrator/plans/' + serverMigrationPlan.planId,
    { headers: { Cookie: cookie } }
  );
  assert.equal(persistedMigrationPlanResponse.status, 200);
  assert.equal((await persistedMigrationPlanResponse.json()).plan.planId, serverMigrationPlan.planId);
  const migrationPlanFile = path.join(
    process.env.DATA_ROOT,
    'migration-orchestrator',
    'plans',
    serverMigrationPlan.planId + '.json'
  );
  assert.equal(fs.statSync(migrationPlanFile).mode & 0o777, 0o600);

  const migrationSelectionStatusResponse = await fetch(
    baseUrl() + '/api/migration-selections/current',
    { headers: { Cookie: cookie } }
  );
  assert.equal(migrationSelectionStatusResponse.status, 200);
  const migrationSelectionStatus = await migrationSelectionStatusResponse.json();
  assert.equal(migrationSelectionStatus.state, 'empty');
  assert.equal(migrationSelectionStatus.guarantees.reviewOnly, true);
  assert.equal(migrationSelectionStatus.guarantees.applyImplemented, false);

  const statefulMigrationSelectionResponse = await fetch(
    baseUrl() + '/api/migration-selections/current',
    {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverPlanId: serverMigrationPlan.planId,
        resourceIds: [serverMigrationPlan.resources[0].resourceId],
        confirmation: 'SAVE MIGRATION SELECTION'
      })
    }
  );
  assert.equal(statefulMigrationSelectionResponse.status, 200);
  const statefulSelection = await statefulMigrationSelectionResponse.json();
  assert.deepEqual(statefulSelection.selection.selectedResourceIds, [serverMigrationPlan.resources[0].resourceId]);
  assert.equal(dockerRequestLog.length, 0);

  const migrationRunsStatusResponse = await fetch(baseUrl() + '/api/migration-runs', {
    headers: { Cookie: cookie }
  });
  assert.equal(migrationRunsStatusResponse.status, 200);
  const migrationRunsStatus = await migrationRunsStatusResponse.json();
  assert.equal(migrationRunsStatus.summary.runs, 0);
  assert.equal(migrationRunsStatus.guarantees.separateSaveActionRequired, false);

  const blockedMigrationRunResponse = await fetch(baseUrl() + '/api/migration-runs', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverPlanId: serverMigrationPlan.planId,
      resourceIds: ['res_' + '9'.repeat(32)],
      confirmation: 'START SERVER MIGRATION'
    })
  });
  assert.equal(blockedMigrationRunResponse.status, 409);
  assert.equal((await blockedMigrationRunResponse.json()).code, 'resource-not-in-plan');
  assert.equal(dockerRequestLog.length, 0);

  dockerRequestLog.length = 0;
  const statelessStatusResponse = await fetch(baseUrl() + '/api/stateless-migrations', {
    headers: { Cookie: cookie }
  });
  assert.equal(statelessStatusResponse.status, 200);
  const statelessStatus = await statelessStatusResponse.json();
  assert.equal(statelessStatus.executionGate.status, 'ui-approval-required');
  assert.equal(statelessStatus.executionGate.runtimeAdapterConfigured, true);
  assert.equal(statelessStatus.executionGate.manifestCompilerConfigured, true);
  assert.equal(statelessStatus.executionGate.uiApprovalRequired, true);
  assert.equal(statelessStatus.executionGate.runEndpointExposed, false);
  assert.equal(statelessStatus.executionGate.approveEndpointExposed, false);
  assert.equal(statelessStatus.summary.operations, 0);
  assert.equal(statelessStatus.guarantees.sourceStopAllowed, false);
  assert.equal(statelessStatus.guarantees.providerDetachIncluded, false);
  assert.equal(dockerRequestLog.length, 0);

  const blockedStatelessPlanResponse = await fetch(baseUrl() + '/api/stateless-migrations/plans', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverPlanId: serverMigrationPlan.planId,
      resourceId: serverMigrationPlan.resources[0].resourceId,
      confirmation: 'PREPARE STATELESS MIGRATION'
    })
  });
  assert.equal(blockedStatelessPlanResponse.status, 403);
  assert.equal((await blockedStatelessPlanResponse.json()).code, 'unsupported-resource-class');
  assert.equal(dockerRequestLog.length, 0);

  const absentStatelessRunResponse = await fetch(
    baseUrl() + '/api/stateless-migrations/plans/smplan_' + '1'.repeat(32) + '/run',
    { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }
  );
  assert.equal(absentStatelessRunResponse.status, 404);
  const absentStatelessApprovalResponse = await fetch(baseUrl() + '/api/stateless-migrations/approvals', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(absentStatelessApprovalResponse.status, 404);

  dockerRequestLog.length = 0;
  const blockedAdoptionResponse = await fetch(
    baseUrl() + '/api/resources/' + scanPayload.snapshot.resources[0].id + '/adoption-plan',
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'PLAN DISPOSABLE ' + scanPayload.snapshot.resources[0].id,
        healthPrivatePort: 8080,
        healthPath: '/'
      })
    }
  );
  assert.equal(blockedAdoptionResponse.status, 403);
  assert.equal((await blockedAdoptionResponse.json()).code, 'pilot-resource-only');
  assert.equal(dockerRequestLog.every((request) => request.method === 'GET'), true);
  mockContainer = null;
});

test('rollback and source/Compose/image-update control containers stay out of Store discovery', () => {
  const rollbackContainer = {
    Id: 'f'.repeat(64),
    Image: 'example/web:0.0.1',
    Names: ['/foxos-adoption-lab-foxos-rollback-1234abcd'],
    State: 'exited',
    Status: 'Exited (0)',
    Labels: {},
    Ports: [{ PrivatePort: 80, PublicPort: 18088, Type: 'tcp', IP: '127.0.0.1' }]
  };
  const deploymentContainers = [
    'foxos-deployment-lab',
    'foxos-deployment-lab-candidate-1234abcd',
    'foxos-deployment-lab-rollback-1234abcd',
    'foxos-compose-lab-web',
    'foxos-compose-lab-candidate-1234abcd-api',
    'foxos-compose-lab-rollback-1234abcd-web',
    'foxos-image-update-lab',
    'foxos-image-update-lab-candidate-1234abcd',
    'foxos-image-update-lab-rollback-1234abcd'
  ]
    .map((name, index) => ({
      ...rollbackContainer,
      Id: String(index + 1).repeat(64),
      Names: ['/' + name],
      State: index === 0 ? 'running' : 'exited'
    }));
  assert.deepEqual(discoveredAppStates([rollbackContainer, ...deploymentContainers], []), []);
});

test('disposable stateless migration source, candidate and route gateway stay out of Store discovery', () => {
  const containers = ['source', 'candidate', 'gateway'].map((role, index) => ({
    Id: String(index + 3).repeat(64),
    Image: role === 'gateway' ? 'foxos:0.0.1' : 'traefik/whoami@sha256:' + 'a'.repeat(64),
    Names: ['/foxos-stateless-lab-' + role + '-123456789abc'],
    State: 'running',
    Status: 'Up 1 second',
    Ports: [{ IP: '127.0.0.1', PrivatePort: role === 'gateway' ? 8443 : 80, PublicPort: 41000 + index, Type: 'tcp' }],
    Labels: { 'com.foxos.stateless-migration.disposable': 'true' }
  }));
  assert.deepEqual(discoveredAppStates(containers, []), []);
});

test('stateful shadows stay out of Store discovery even when their image has an app profile', () => {
  const shadow = {
    Id: 'e'.repeat(64),
    Image: 'henrygd/beszel:latest',
    Names: ['/foxos-stateful-shadow-example'],
    State: 'running',
    Status: 'Up 1 minute',
    Labels: {
      'com.foxos.managed': 'true',
      'com.foxos.stateful-shadow': 'true',
      'com.foxos.resource.id': 'res_' + '1'.repeat(32),
      'com.foxos.stateful-shadow.source-resource-id': 'res_' + '2'.repeat(32)
    },
    Ports: [{ PrivatePort: 8090, Type: 'tcp' }]
  };
  assert.deepEqual(discoveredAppStates([shadow], []), []);
  const beszel = { id: 'beszel', image: 'henrygd/beszel:latest', imageAliases: [] };
  const source = {
    ...shadow,
    Id: 'f'.repeat(64),
    Names: ['/provider-beszel'],
    Labels: { 'coolify.managed': 'true' }
  };
  assert.equal(catalogContainerForApp([shadow, source], beszel).Id, source.Id);
});
