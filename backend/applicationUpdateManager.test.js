const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  APPLY_APPLICATION_UPDATE_CONFIRMATION,
  ROLLBACK_APPLICATION_UPDATE_CONFIRMATION,
  createApplicationUpdateManager,
  createEncryptedVolumeSnapshotAdapter,
  reverseDependentServices
} = require('./applicationUpdateManager');
const { createEncryptionStore } = require('./encryptionStore');

const APPLICATION_ID = 'res_' + 'a'.repeat(32);
const OLD_N8N_IMAGE = 'sha256:' + '1'.repeat(64);
const OLD_RUNNER_IMAGE = 'sha256:' + '2'.repeat(64);
const NEW_N8N_IMAGE = 'sha256:' + '3'.repeat(64);
const NEW_RUNNER_IMAGE = 'sha256:' + '4'.repeat(64);
const N8N_CONTAINER = '5'.repeat(64);
const RUNNER_CONTAINER = '6'.repeat(64);
const NEW_N8N_CONTAINER = '7'.repeat(64);
const NEW_RUNNER_CONTAINER = '8'.repeat(64);
const ROLLBACK_N8N_CONTAINER = '9'.repeat(64);
const ROLLBACK_RUNNER_CONTAINER = 'a'.repeat(64);

test('reverse dependent graph includes sidecars that depend on the selected service, not its database dependencies', () => {
  const services = {
    database: {},
    n8n: { depends_on: { database: { condition: 'service_healthy' } } },
    runners: { depends_on: ['n8n'] },
    observer: { depends_on: { runners: {} } },
    unrelated: {}
  };
  assert.deepEqual(reverseDependentServices(services, 'n8n'), ['n8n', 'runners', 'observer']);
});

test('stateful update snapshot streams encrypted volume data and restores the exact pre-update contents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-volume-snapshot-'));
  const hostRoot = path.join(root, 'host');
  const dataRoot = path.join(root, 'data');
  const mountedData = path.join(hostRoot, 'var/lib/docker/volumes/example-data/_data');
  fs.mkdirSync(mountedData, { recursive: true });
  fs.writeFileSync(path.join(mountedData, 'database.sqlite'), 'before-update');
  fs.mkdirSync(path.join(mountedData, 'binaryData'));
  fs.writeFileSync(path.join(mountedData, 'binaryData', 'item'), 'payload');
  const adapter = createEncryptedVolumeSnapshotAdapter({
    dataRoot,
    hostRoot,
    encryptionStore: createEncryptionStore({ dataRoot }),
    dockerRequest: async () => ({ Mountpoint: '/var/lib/docker/volumes/example-data/_data' })
  });
  const volume = { name: 'example-data' };
  const capacity = await adapter.inspectCapacity({ volumes: [volume], maximumTransactionBytes: 1024 * 1024 });
  assert.equal(capacity.supported, true);
  assert.equal(capacity.withinTransactionLimit, true);
  assert.equal(capacity.capacitySufficient, true);
  const snapshot = await adapter.create({ operationId: 'auop_' + 'c'.repeat(32), volume });
  assert.equal(fs.readFileSync(path.join(dataRoot, snapshot.file)).includes(Buffer.from('before-update')), false);
  fs.writeFileSync(path.join(mountedData, 'database.sqlite'), 'after-update');
  fs.writeFileSync(path.join(mountedData, 'new-file'), 'new');
  await adapter.restore({ snapshot, volume });
  assert.equal(fs.readFileSync(path.join(mountedData, 'database.sqlite'), 'utf8'), 'before-update');
  assert.equal(fs.readFileSync(path.join(mountedData, 'binaryData', 'item'), 'utf8'), 'payload');
  assert.equal(fs.existsSync(path.join(mountedData, 'new-file')), false);
});

function harness({ failUp = false, failBuild = false, failPublicOnce = false, sharedVolume = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-app-update-'));
  const hostRoot = path.join(root, 'host');
  const dataRoot = path.join(root, 'data');
  const composeHostPath = '/srv/n8n/docker-compose.yml';
  const composeMountedPath = path.join(hostRoot, 'srv/n8n/docker-compose.yml');
  fs.mkdirSync(path.dirname(composeMountedPath), { recursive: true });
  fs.writeFileSync(composeMountedPath, [
    'services:',
    '  n8n:',
    '    build:',
    '      context: .',
    '      dockerfile_inline: |',
    '        FROM n8nio/n8n:latest',
    '    volumes:',
    '      - n8n-data:/home/node/.n8n',
    '  task-runners:',
    '    image: n8nio/runners:latest',
    '    depends_on:',
    '      n8n:',
    '        condition: service_healthy',
    'volumes:',
    '  n8n-data:',
    ''
  ].join('\n'));

  const staleRollbackOverride = '/srv/n8n/.server-update-deadbeefcafe-rollback.yml';
  fs.writeFileSync(path.join(hostRoot, '.' + staleRollbackOverride), 'services: {}\n');
  const labelsFor = (service) => ({
    'com.docker.compose.project': 'n8n-project',
    'com.docker.compose.service': service,
    'com.docker.compose.project.working_dir': '/srv/n8n',
    'com.docker.compose.project.config_files': composeHostPath + ',' + staleRollbackOverride,
    'coolify.managed': 'true'
  });
  let runtime = 'old';
  const summary = (service, current) => ({
    Id: current.id,
    ImageID: current.image,
    Names: ['/' + current.name],
    Labels: labelsFor(service),
    State: 'running',
    Status: 'Up (healthy)'
  });
  const old = {
    n8n: { id: N8N_CONTAINER, image: OLD_N8N_IMAGE, name: 'n8n-project-n8n-1' },
    'task-runners': { id: RUNNER_CONTAINER, image: OLD_RUNNER_IMAGE, name: 'n8n-project-task-runners-1' }
  };
  const fresh = {
    n8n: { id: NEW_N8N_CONTAINER, image: NEW_N8N_IMAGE, name: 'n8n-project-n8n-1' },
    'task-runners': { id: NEW_RUNNER_CONTAINER, image: NEW_RUNNER_IMAGE, name: 'n8n-project-task-runners-1' }
  };
  const rolledBack = {
    n8n: { id: ROLLBACK_N8N_CONTAINER, image: OLD_N8N_IMAGE, name: 'n8n-project-n8n-1' },
    'task-runners': { id: ROLLBACK_RUNNER_CONTAINER, image: OLD_RUNNER_IMAGE, name: 'n8n-project-task-runners-1' }
  };
  const commands = [];
  const snapshots = [];
  const restores = [];
  const routeRebinds = [];
  let routeContainerId = N8N_CONTAINER;
  let publicProbeCalls = 0;
  let uuidIndex = 0;
  const ids = ['a'.repeat(32), 'b'.repeat(32)];

  function valuesForRuntime() {
    if (runtime.includes('new')) return fresh;
    if (runtime.includes('rollback')) return rolledBack;
    return old;
  }

  function detailsFor(service, current) {
    return {
      Id: current.id,
      Image: current.image,
      Config: { Image: service === 'n8n' ? 'n8n-built:latest' : 'n8nio/runners:latest', Labels: labelsFor(service) },
      State: runtime.startsWith('stopped-')
        ? { Running: false }
        : { Running: true, Health: { Status: 'healthy' } },
      Mounts: service === 'n8n' ? [{
        Type: 'volume', Name: 'n8n-project_n8n-data', Destination: '/home/node/.n8n', RW: true
      }] : []
    };
  }

  const manager = createApplicationUpdateManager({
    dataRoot,
    hostRoot,
    getApplicationInventory: async () => ({ applications: [{
      id: APPLICATION_ID,
      name: 'n8n.example.test',
      externalUrl: 'https://n8n.example.test',
      runtime: { containerId: valuesForRuntime().n8n.id }
    }] }),
    checkApplicationUpdate: async () => ({
      status: 'update-available', updateAvailable: true,
      source: { reference: 'n8nio/n8n:latest', type: 'compose-build-base' },
      current: { imageId: OLD_N8N_IMAGE, version: '2.28.7', digest: null },
      latest: { version: '2.33.5', digest: 'sha256:' + '9'.repeat(64) },
      message: '2.28.7 sürümünden 2.33.5 sürümüne güncelleme bulundu.'
    }),
    dockerRequest: async (method, requestPath) => {
      if (requestPath.startsWith('/containers/json?')) {
        const values = valuesForRuntime();
        const result = Object.entries(values).map(([service, current]) => summary(service, current));
        if (runtime.startsWith('stopped-')) {
          for (const container of result) {
            container.State = 'exited';
            container.Status = 'Exited (0)';
          }
        }
        if (requestPath === '/containers/json?all=true' && sharedVolume) {
          result.push({
            Id: 'f'.repeat(64), Names: ['/unrelated'], Labels: {}, State: 'running', Status: 'Up',
            Mounts: [{ Type: 'volume', Name: 'n8n-project_n8n-data', Destination: '/shared' }]
          });
        }
        return result;
      }
      if (requestPath.startsWith('/containers/')) {
        const id = requestPath.split('/')[2];
        const values = valuesForRuntime();
        const entry = Object.entries(values).find(([, current]) => current.id === id);
        if (!entry) throw new Error('unknown container ' + id);
        return detailsFor(entry[0], entry[1]);
      }
      if (method === 'POST' && requestPath.startsWith('/images/')) return null;
      throw new Error('unexpected Docker request ' + method + ' ' + requestPath);
    },
    composeRunner: async (input) => {
      commands.push({ operation: input.operation, services: [...input.services] });
      if (input.operation === 'build' && failBuild) throw new Error('build failed');
      if (input.operation === 'up') {
        if (failUp) {
          runtime = 'new';
          throw new Error('new health failed');
        }
        runtime = 'new';
      }
      if (input.operation === 'stop') {
        if (runtime.includes('new')) runtime = 'stopped-new';
        else if (runtime.includes('rollback')) runtime = 'stopped-rollback';
        else runtime = 'stopped-old';
      }
      if (input.operation === 'rollback') runtime = 'rollback';
      return { success: true };
    },
    volumeSnapshots: {
      create: async ({ operationId, volume }) => {
        const result = { operationId, volumeName: volume.name, file: 'snapshot.enc' };
        snapshots.push(result);
        return result;
      },
      restore: async ({ snapshot, volume }) => restores.push({ snapshot, volume })
    },
    routeRuntime: {
      operationRuntimeBinding: (containerId) => {
        assert.equal(containerId, N8N_CONTAINER);
        return {
          operationIds: ['rtop_' + 'c'.repeat(32)],
          runtimeContainerId: N8N_CONTAINER,
          routeIds: ['rt_' + 'd'.repeat(24)],
          aliases: ['server-app'],
          fingerprint: 'route-fingerprint'
        };
      },
      assertOperationRuntimeBinding: (binding, expectedContainerId) => {
        assert.equal(binding.fingerprint, 'route-fingerprint');
        assert.equal(routeContainerId, expectedContainerId);
      },
      rebindOperationRuntime: async (binding, containerId, expectedContainerId) => {
        assert.equal(binding.fingerprint, 'route-fingerprint');
        assert.equal(routeContainerId, expectedContainerId);
        routeRebinds.push({ from: expectedContainerId, to: containerId });
        routeContainerId = containerId;
        return { ...binding, runtimeContainerId: containerId };
      }
    },
    publicHealthProbe: async () => {
      publicProbeCalls += 1;
      if (failPublicOnce && publicProbeCalls === 1) throw new Error('Public endpoint returned HTTP 502');
      return { status: 200 };
    },
    quiesce: async () => {},
    clock: () => new Date('2026-08-07T12:00:00.000Z'),
    randomUUID: () => ids[uuidIndex++]
  });
  return { commands, dataRoot, hostRoot, manager, restores, routeRebinds, snapshots, staleRollbackOverride };
}

test('Compose update applies selected service and reverse-dependent runner as one health-gated transaction', async () => {
  const { commands, hostRoot, manager, restores, routeRebinds, snapshots, staleRollbackOverride } = harness();
  const plan = await manager.createPlan(APPLICATION_ID);
  assert.deepEqual(plan.services.map((service) => service.name), ['n8n', 'task-runners']);
  assert.deepEqual(plan.services.map((service) => service.action), ['build', 'pull']);
  assert.deepEqual(plan.statefulVolumes, ['n8n-project_n8n-data']);
  assert.equal(plan.providerMayOverwrite, true);

  const operation = await manager.applyPlan(plan.planId, { confirmation: APPLY_APPLICATION_UPDATE_CONFIRMATION });
  assert.equal(operation.status, 'completed');
  assert.equal(operation.rollbackAvailable, true);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(commands.map((command) => command.operation), ['build', 'pull', 'stop', 'up']);
  assert.deepEqual(operation.services.map((service) => service.health), ['healthy', 'healthy']);
  assert.deepEqual(routeRebinds, [{ from: N8N_CONTAINER, to: NEW_N8N_CONTAINER }]);
  assert.equal(fs.existsSync(path.join(hostRoot, '.' + staleRollbackOverride)), false);

  const rolledBack = await manager.rollbackOperation(operation.operationId, {
    confirmation: ROLLBACK_APPLICATION_UPDATE_CONFIRMATION
  });
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(restores.length, 1);
  assert.deepEqual(commands.slice(-2).map((command) => command.operation), ['stop', 'rollback']);
  assert.deepEqual(routeRebinds[1], { from: NEW_N8N_CONTAINER, to: ROLLBACK_N8N_CONTAINER });
  assert.equal(
    fs.existsSync(path.join(hostRoot, 'srv/n8n/.server-update-' + operation.operationId.slice(-12) + '-rollback.yml')),
    true
  );
});

test('failed health-gated cutover automatically restores old images and stateful data', async () => {
  const { commands, manager, restores } = harness({ failUp: true });
  const plan = await manager.createPlan(APPLICATION_ID);
  await assert.rejects(
    manager.applyPlan(plan.planId, { confirmation: APPLY_APPLICATION_UPDATE_CONFIRMATION }),
    (error) => error.code === 'application-update-rolled-back'
  );
  const current = manager.current(APPLICATION_ID);
  assert.equal(current.status, 'rolled-back-after-failure');
  assert.equal(restores.length, 1);
  assert.deepEqual(commands.slice(-3).map((command) => command.operation), ['up', 'stop', 'rollback']);
});

test('public route failure after cutover rebinds the rollback runtime before public verification', async () => {
  const { manager, routeRebinds } = harness({ failPublicOnce: true });
  const plan = await manager.createPlan(APPLICATION_ID);
  await assert.rejects(
    manager.applyPlan(plan.planId, { confirmation: APPLY_APPLICATION_UPDATE_CONFIRMATION }),
    (error) => error.code === 'application-update-rolled-back'
  );
  assert.deepEqual(routeRebinds, [
    { from: N8N_CONTAINER, to: NEW_N8N_CONTAINER },
    { from: NEW_N8N_CONTAINER, to: ROLLBACK_N8N_CONTAINER }
  ]);
});

test('preparation failure leaves running services untouched', async () => {
  const { commands, manager, restores } = harness({ failBuild: true });
  const plan = await manager.createPlan(APPLICATION_ID);
  await assert.rejects(
    manager.applyPlan(plan.planId, { confirmation: APPLY_APPLICATION_UPDATE_CONFIRMATION }),
    (error) => error.code === 'application-update-preparation-failed'
  );
  assert.deepEqual(commands.map((command) => command.operation), ['build']);
  assert.equal(restores.length, 0);
  assert.equal(manager.current(APPLICATION_ID).status, 'failed-before-cutover');
});

test('planning rejects a named volume that another running container can still write', async () => {
  const { manager } = harness({ sharedVolume: true });
  await assert.rejects(
    manager.createPlan(APPLICATION_ID),
    (error) => error.code === 'application-update-shared-volume-blocked'
  );
});

test('server-owned stateful runtime updates and rolls back without reactivating its retained provider Compose source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-managed-update-'));
  const dataRoot = path.join(root, 'data');
  const hostRoot = path.join(root, 'host');
  const operationId = 'stmop_' + '1'.repeat(32);
  const oldContainerId = 'b'.repeat(64);
  const newContainerId = 'c'.repeat(64);
  const rollbackContainerId = 'd'.repeat(64);
  const oldImageId = 'sha256:' + '2'.repeat(64);
  const newImageId = 'sha256:' + '3'.repeat(64);
  const latestDigest = 'sha256:' + '4'.repeat(64);
  const runtimeReference = 'local/db-example-com:current';
  const upstreamReference = 'nocodb/nocodb:latest';
  const operationFile = path.join(dataRoot, 'stateful-migrations/operations', operationId + '.json');
  const adapterFile = path.join(dataRoot, 'production-stateful-adapter/operations', operationId + '.json');
  fs.mkdirSync(path.dirname(operationFile), { recursive: true });
  fs.mkdirSync(path.dirname(adapterFile), { recursive: true });
  fs.writeFileSync(operationFile, JSON.stringify({
    operationId,
    status: 'traffic-on-server-source-preserved',
    candidate: { containerId: oldContainerId, imageId: oldImageId }
  }));
  fs.writeFileSync(adapterFile, JSON.stringify({
    operationId,
    candidate: { containerId: oldContainerId, imageId: oldImageId, imageReference: runtimeReference }
  }));

  const labels = {
    'com.foxos.managed': 'true',
    'com.foxos.stateful-migration.id': operationId,
    'com.foxos.image.reference': runtimeReference
  };
  const networkState = {
    'server-egress': { Aliases: null },
    'server-routing': { Aliases: ['db-example-com'] }
  };
  const baseDetails = (id, image, name = '/db-example-com') => ({
    Id: id,
    Image: image,
    Name: name,
    Config: {
      Image: runtimeReference,
      Env: ['NC_DB=secret-value-that-must-not-be-persisted'],
      Labels: labels,
      ExposedPorts: { '8080/tcp': {} },
      Healthcheck: { Test: ['CMD', 'true'] }
    },
    HostConfig: {
      NetworkMode: 'server-routing',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      Mounts: [{ Type: 'volume', Source: 'db-example-data', Target: '/usr/app/data' }]
    },
    Mounts: [{ Type: 'volume', Name: 'db-example-data', Destination: '/usr/app/data', RW: true }],
    NetworkSettings: { Networks: JSON.parse(JSON.stringify(networkState)) },
    State: { Running: true, Status: 'running', Health: { Status: 'healthy' } }
  });
  const containers = new Map([[oldContainerId, baseDetails(oldContainerId, oldImageId)]]);
  const imageReferences = new Map([
    [runtimeReference, oldImageId],
    [oldImageId, oldImageId],
    [newImageId, newImageId],
    [upstreamReference, newImageId]
  ]);
  let activeContainerId = oldContainerId;
  let createIndex = 0;
  let routeContainerId = oldContainerId;
  const creates = [];
  const restores = [];
  const routeRebinds = [];
  const ids = ['5'.repeat(32), '6'.repeat(32)];
  let uuidIndex = 0;

  const dockerRequest = async (method, requestPath, body) => {
    if (method === 'GET' && requestPath === '/containers/json?all=true') {
      return [...containers.values()].map((details) => ({
        Id: details.Id,
        State: details.State.Running ? 'running' : 'exited',
        Mounts: details.Mounts
      }));
    }
    if (method === 'GET' && requestPath.startsWith('/containers/')) {
      const id = requestPath.split('/')[2];
      const details = containers.get(id);
      if (!details) throw new Error('No such container');
      return details;
    }
    if (method === 'POST' && requestPath.startsWith('/images/create?')) {
      imageReferences.set(upstreamReference, newImageId);
      return {};
    }
    if (method === 'GET' && requestPath.startsWith('/images/')) {
      const reference = decodeURIComponent(requestPath.slice('/images/'.length).replace(/\/json$/, ''));
      const id = imageReferences.get(reference);
      if (!id) throw new Error('unknown image ' + reference);
      return {
        Id: id,
        RepoDigests: id === newImageId ? ['nocodb/nocodb@' + latestDigest] : []
      };
    }
    if (method === 'POST' && requestPath.includes('/tag?repo=')) {
      const source = decodeURIComponent(requestPath.slice('/images/'.length, requestPath.indexOf('/tag?')));
      const query = new URLSearchParams(requestPath.slice(requestPath.indexOf('?') + 1));
      const sourceId = imageReferences.get(source) || source;
      imageReferences.set(query.get('repo') + ':' + query.get('tag'), sourceId);
      return {};
    }
    if (method === 'POST' && requestPath.includes('/stop?')) {
      const id = requestPath.split('/')[2];
      containers.get(id).State = { Running: false, Status: 'exited', Health: { Status: 'healthy' } };
      return {};
    }
    if (method === 'POST' && requestPath.includes('/rename?name=')) {
      const id = requestPath.split('/')[2];
      containers.get(id).Name = '/' + decodeURIComponent(requestPath.split('name=')[1]);
      return {};
    }
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      const id = [newContainerId, rollbackContainerId][createIndex++];
      const name = decodeURIComponent(requestPath.split('name=')[1]);
      const image = imageReferences.get(body.Image);
      const details = baseDetails(id, image, '/' + name);
      details.Config = { ...details.Config, ...body, Image: body.Image };
      details.HostConfig = body.HostConfig;
      details.State = { Running: false, Status: 'created', Health: { Status: 'healthy' } };
      details.NetworkSettings = { Networks: { 'server-routing': { Aliases: body.NetworkingConfig.EndpointsConfig['server-routing'].Aliases } } };
      containers.set(id, details);
      creates.push({ id, body });
      activeContainerId = id;
      return { Id: id };
    }
    if (method === 'POST' && requestPath.includes('/networks/') || method === 'POST' && requestPath.startsWith('/networks/')) {
      const network = decodeURIComponent(requestPath.split('/')[2]);
      const details = containers.get(body.Container);
      details.NetworkSettings.Networks[network] = { Aliases: body.EndpointConfig.Aliases };
      return {};
    }
    if (method === 'POST' && requestPath.endsWith('/start')) {
      const id = requestPath.split('/')[2];
      containers.get(id).State = { Running: true, Status: 'running', Health: { Status: 'healthy' } };
      activeContainerId = id;
      return {};
    }
    if (method === 'DELETE' && requestPath.startsWith('/containers/')) {
      const id = requestPath.split('/')[2].split('?')[0];
      containers.delete(id);
      return {};
    }
    throw new Error('unexpected Docker request ' + method + ' ' + requestPath);
  };

  const manager = createApplicationUpdateManager({
    dataRoot,
    hostRoot,
    dockerRequest,
    getApplicationInventory: async () => ({ applications: [{
      id: APPLICATION_ID,
      name: 'db.example.com',
      externalUrl: 'https://db.example.com',
      managedByServer: true,
      runtime: { containerId: activeContainerId }
    }] }),
    checkApplicationUpdate: async () => ({
      status: 'update-available',
      updateAvailable: true,
      source: { reference: upstreamReference, type: 'migration-compose-image' },
      current: { imageId: oldImageId, version: null, digest: 'sha256:' + '7'.repeat(64) },
      latest: { version: null, digest: latestDigest },
      message: 'Registry’de daha yeni bir imaj bulundu.'
    }),
    composeRunner: async () => { throw new Error('retained provider Compose must not run'); },
    volumeSnapshots: {
      create: async ({ operationId: updateOperationId, volume }) => ({
        operationId: updateOperationId,
        volumeName: volume.name,
        file: 'snapshot.enc'
      }),
      restore: async ({ snapshot, volume }) => restores.push({ snapshot, volume })
    },
    routeRuntime: {
      operationRuntimeBinding: (containerId) => ({
        operationIds: [operationId],
        runtimeContainerId: containerId,
        routeIds: ['route_' + '8'.repeat(24)],
        aliases: ['db-example-com'],
        fingerprint: 'managed-route'
      }),
      assertOperationRuntimeBinding: (binding, expectedContainerId) => {
        assert.equal(binding.fingerprint, 'managed-route');
        assert.equal(routeContainerId, expectedContainerId);
      },
      rebindOperationRuntime: async (binding, containerId, expectedContainerId) => {
        assert.equal(routeContainerId, expectedContainerId);
        routeRebinds.push({ from: expectedContainerId, to: containerId });
        routeContainerId = containerId;
        return { ...binding, runtimeContainerId: containerId };
      }
    },
    publicHealthProbe: async () => ({ status: 200 }),
    quiesce: async () => {},
    wait: async () => {},
    readinessAttempts: 2,
    clock: () => new Date('2026-08-08T00:00:00.000Z'),
    randomUUID: () => ids[uuidIndex++]
  });

  const plan = await manager.createPlan(APPLICATION_ID);
  assert.equal(plan.services.length, 1);
  assert.equal(plan.services[0].action, 'pull');
  assert.deepEqual(plan.statefulVolumes, ['db-example-data']);
  const persistedPlan = fs.readFileSync(path.join(dataRoot, 'application-updates/plans', plan.planId + '.json'), 'utf8');
  assert.equal(persistedPlan.includes('secret-value-that-must-not-be-persisted'), false);

  const applied = await manager.applyPlan(plan.planId, { confirmation: APPLY_APPLICATION_UPDATE_CONFIRMATION });
  assert.equal(applied.status, 'completed');
  assert.equal(applied.services[0].containerId, newContainerId);
  assert.equal(applied.services[0].imageId, newImageId);
  assert.equal(creates[0].body.Env.includes('NC_DB=secret-value-that-must-not-be-persisted'), true);
  assert.equal(readJsonForTest(operationFile).candidate.containerId, newContainerId);
  assert.equal(readJsonForTest(adapterFile).candidate.containerId, newContainerId);

  const rolledBack = await manager.rollbackOperation(applied.operationId, {
    confirmation: ROLLBACK_APPLICATION_UPDATE_CONFIRMATION
  });
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(rolledBack.services[0].containerId, rollbackContainerId);
  assert.equal(rolledBack.services[0].imageId, oldImageId);
  assert.equal(restores.length, 1);
  assert.deepEqual(routeRebinds, [
    { from: oldContainerId, to: newContainerId },
    { from: newContainerId, to: rollbackContainerId }
  ]);
  assert.equal(readJsonForTest(operationFile).candidate.containerId, rollbackContainerId);
  assert.equal(readJsonForTest(adapterFile).candidate.containerId, rollbackContainerId);
});

function readJsonForTest(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
