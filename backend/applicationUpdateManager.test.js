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

function harness({ failUp = false, failBuild = false, sharedVolume = false } = {}) {
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

  const labelsFor = (service) => ({
    'com.docker.compose.project': 'n8n-project',
    'com.docker.compose.service': service,
    'com.docker.compose.project.working_dir': '/srv/n8n',
    'com.docker.compose.project.config_files': composeHostPath,
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
  const commands = [];
  const snapshots = [];
  const restores = [];
  let uuidIndex = 0;
  const ids = ['a'.repeat(32), 'b'.repeat(32)];

  function detailsFor(service, current) {
    return {
      Id: current.id,
      Image: current.image,
      Config: { Image: service === 'n8n' ? 'n8n-built:latest' : 'n8nio/runners:latest', Labels: labelsFor(service) },
      State: { Running: true, Health: { Status: 'healthy' } },
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
      runtime: { containerId: runtime === 'old' ? old.n8n.id : fresh.n8n.id }
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
        const values = runtime === 'old' ? old : fresh;
        const result = Object.entries(values).map(([service, current]) => summary(service, current));
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
        const values = runtime === 'old' ? old : fresh;
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
      if (input.operation === 'rollback') runtime = 'old';
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
    publicHealthProbe: async () => ({ status: 200 }),
    clock: () => new Date('2026-08-07T12:00:00.000Z'),
    randomUUID: () => ids[uuidIndex++]
  });
  return { commands, manager, restores, snapshots };
}

test('Compose update applies selected service and reverse-dependent runner as one health-gated transaction', async () => {
  const { commands, manager, restores, snapshots } = harness();
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

  const rolledBack = await manager.rollbackOperation(operation.operationId, {
    confirmation: ROLLBACK_APPLICATION_UPDATE_CONFIRMATION
  });
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(restores.length, 1);
  assert.deepEqual(commands.slice(-2).map((command) => command.operation), ['stop', 'rollback']);
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
