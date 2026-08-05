const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptionStore } = require('./encryptionStore');
const { classifyResource } = require('./resourceClassification');
const { createSecretManager } = require('./secretManager');
const {
  PLAN_STATEFUL_REHEARSAL_CONFIRMATION,
  createStatefulRehearsalManager,
  runConfirmation,
  tarHasMaterialEntries
} = require('./statefulRehearsalManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const SOURCE_ID = 'a'.repeat(64);
const CANDIDATE_ID = 'b'.repeat(64);
const IMAGE_ID = 'sha256:' + 'c'.repeat(64);
const DATA_VOLUME = 'provider-beszel-data';
const SOCKET_VOLUME = 'provider-beszel-socket';
const SECRET_VALUE = 'must-never-enter-rehearsal-records';

function tarHeader(name, type, size = 0) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(type === '5' ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function tarArchive(name, content) {
  const data = Buffer.from(content);
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([tarHeader(name, '0', data.length), data, padding, Buffer.alloc(1024)]);
}

function emptyDirectoryArchive() {
  return Buffer.concat([tarHeader('.', '5'), Buffer.alloc(1024)]);
}

function resource(overrides = {}) {
  const base = {
    schemaVersion: 1,
    id: RESOURCE_ID,
    kind: 'container',
    name: 'beszel-hub',
    role: 'application',
    ownership: 'observed',
    provider: 'coolify',
    protected: false,
    provenance: {
      imported: false,
      safeLabels: {},
      project: 'tools',
      service: 'beszel'
    },
    runtime: {
      engine: 'docker',
      containerId: SOURCE_ID,
      image: 'henrygd/beszel:latest',
      imageId: IMAGE_ID,
      state: 'running',
      status: 'Up 1 day (healthy)',
      restartPolicy: 'unless-stopped',
      health: { configured: true, status: 'healthy' },
      constraints: {
        user: '',
        privileged: false,
        readOnlyRootFilesystem: false,
        noNewPrivileges: false,
        allCapabilitiesDropped: false,
        memoryBytes: null,
        nanoCpus: null,
        pidsLimit: null
      },
      environmentVariableCount: 3,
      inspection: 'complete'
    },
    ports: [{ privatePort: 8090, protocol: 'tcp', hostIp: null, hostPort: null }],
    routes: [{ domain: 'beszel.example.test', path: '/', tls: true }],
    mounts: [
      {
        type: 'volume',
        name: DATA_VOLUME,
        source: '/var/lib/docker/volumes/data/_data',
        destination: '/beszel_data',
        readOnly: false
      },
      {
        type: 'volume',
        name: SOCKET_VOLUME,
        source: '/var/lib/docker/volumes/socket/_data',
        destination: '/beszel_socket',
        readOnly: false
      }
    ],
    networks: [{ name: 'provider-network' }],
    adoption: { stage: 'observed', eligible: false, ready: false, blockers: [] }
  };
  const merged = { ...base, ...overrides };
  return { ...merged, classification: overrides.classification || classifyResource(merged) };
}

function sourceDetails({
  paused = false,
  environment = null,
  healthStatus = 'healthy',
  dockerHealth = true
} = {}) {
  return {
    Id: SOURCE_ID,
    Image: IMAGE_ID,
    Config: {
      Image: 'henrygd/beszel:latest',
      Env: environment || [
        'APP_MODE=production',
        'TOKEN=' + SECRET_VALUE,
        'COOLIFY_FQDN=https://beszel.example.test'
      ],
      Cmd: null,
      Entrypoint: ['/beszel'],
      User: '',
      WorkingDir: '/',
      ...(dockerHealth ? { Healthcheck: {
        Test: ['CMD', '/beszel', 'health', '--url', 'http://localhost:8090'],
        Interval: 5000000000,
        Timeout: 2000000000,
        Retries: 3
      } } : {})
    },
    HostConfig: {
      Privileged: false,
      NetworkMode: 'provider-network',
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      Devices: [],
      CapAdd: null,
      Binds: [
        DATA_VOLUME + ':/beszel_data:rw',
        SOCKET_VOLUME + ':/beszel_socket:rw'
      ]
    },
    Mounts: [
      { Type: 'volume', Name: DATA_VOLUME, Destination: '/beszel_data', RW: true },
      { Type: 'volume', Name: SOCKET_VOLUME, Destination: '/beszel_socket', RW: true }
    ],
    State: {
      Status: 'running',
      Paused: paused,
      ...(dockerHealth ? { Health: { Status: healthStatus } } : {})
    }
  };
}

function imageDetails() {
  return {
    Id: IMAGE_ID,
    Config: {
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
      Cmd: null,
      Entrypoint: ['/beszel'],
      User: '',
      WorkingDir: '/'
    }
  };
}

function createHarness({
  failCandidateHealth = false,
  emptyArchive = null,
  sourceHealth = 'healthy',
  sourceDockerHealth = true
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateful-rehearsal-'));
  const calls = [];
  const persistentArchive = tarArchive('data/state.db', 'beszel stateful data\n');
  const socketArchive = emptyArchive || emptyDirectoryArchive();
  let currentEnvironment = sourceDetails().Config.Env;
  let sourcePaused = false;
  let candidateExists = false;
  let candidateRunning = false;
  let candidatePayload = null;
  let candidateName = null;
  let networkName = null;
  const temporaryVolumes = new Set();
  const restoredByDestination = new Map();
  const currentResource = resource();
  if (!sourceDockerHealth) currentResource.runtime.health = { configured: false, status: null };
  const snapshot = {
    schemaVersion: 1,
    snapshotId: 'snap_' + '2'.repeat(24),
    resources: [currentResource],
    relationships: [],
    inventory: { images: [], volumes: [], networks: [] }
  };
  const encryptionStore = createEncryptionStore({ dataRoot: root });
  const secretManager = createSecretManager({ dataRoot: root, encryptionStore });
  const secret = secretManager.putSecret('workload/' + RESOURCE_ID + '/TOKEN', SECRET_VALUE);
  const environment = secretManager.createEnvironmentRevision(RESOURCE_ID, {
    ordinary: { APP_MODE: 'production' },
    secretRefs: { TOKEN: { secretId: secret.secretId, revision: secret.revision } },
    excluded: { COOLIFY_FQDN: 'provider-runtime-metadata' }
  });

  async function dockerRequest(method, requestPath, payload = null) {
    calls.push({ method, requestPath, payload });
    if (method === 'GET' && requestPath === '/containers/' + SOURCE_ID + '/json') {
      return sourceDetails({
        paused: sourcePaused,
        environment: currentEnvironment,
        healthStatus: sourceHealth,
        dockerHealth: sourceDockerHealth
      });
    }
    if (method === 'GET' && requestPath === '/images/' + encodeURIComponent(IMAGE_ID) + '/json') {
      return imageDetails();
    }
    if (method === 'POST' && requestPath === '/containers/' + SOURCE_ID + '/pause') {
      sourcePaused = true;
      return null;
    }
    if (method === 'POST' && requestPath === '/containers/' + SOURCE_ID + '/unpause') {
      sourcePaused = false;
      return null;
    }
    if (method === 'POST' && requestPath === '/networks/create') {
      networkName = payload.Name;
      return { Id: 'network-' + payload.Name };
    }
    if (method === 'POST' && requestPath === '/volumes/create') {
      temporaryVolumes.add(payload.Name);
      return { Name: payload.Name };
    }
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      candidateExists = true;
      candidateName = decodeURIComponent(requestPath.split('name=')[1]);
      candidatePayload = payload;
      return { Id: CANDIDATE_ID };
    }
    if (method === 'POST' && requestPath === '/containers/' + CANDIDATE_ID + '/start') {
      candidateRunning = true;
      return null;
    }
    if (method === 'GET' && requestPath === '/containers/' + CANDIDATE_ID + '/json') {
      return {
        Id: CANDIDATE_ID,
        State: {
          Status: candidateRunning ? 'running' : 'created',
          ...(sourceDockerHealth ? {
            Health: { Status: failCandidateHealth ? 'unhealthy' : candidateRunning ? 'healthy' : 'starting' }
          } : {})
        },
        NetworkSettings: {
          Networks: networkName ? { [networkName]: {} } : {},
          Ports: { '8090/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] }
        }
      };
    }
    if (method === 'DELETE' && requestPath.startsWith('/containers/')) {
      const requestedName = decodeURIComponent(requestPath.split('/containers/')[1].split('?')[0]);
      if (!candidateExists || requestedName !== candidateName) throw new Error('No such container: ' + requestedName);
      candidateExists = false;
      candidateRunning = false;
      return null;
    }
    if (method === 'DELETE' && requestPath.startsWith('/volumes/')) {
      const name = decodeURIComponent(requestPath.slice('/volumes/'.length));
      if (!temporaryVolumes.delete(name)) throw new Error('no such volume: ' + name);
      return null;
    }
    if (method === 'DELETE' && requestPath.startsWith('/networks/')) {
      const name = decodeURIComponent(requestPath.slice('/networks/'.length));
      if (!networkName || name !== networkName) throw new Error('network not found: ' + name);
      networkName = null;
      return null;
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  }

  async function dockerArchiveRequest(method, requestPath, archive = null) {
    calls.push({ method, requestPath, archiveBytes: archive && archive.length || 0 });
    if (method === 'GET' && requestPath.startsWith('/containers/' + SOURCE_ID + '/archive?path=')) {
      const target = decodeURIComponent(requestPath.split('path=')[1]);
      return target.startsWith('/beszel_data') ? persistentArchive : socketArchive;
    }
    if (method === 'PUT' && requestPath.startsWith('/containers/' + CANDIDATE_ID + '/archive?path=')) {
      const target = decodeURIComponent(requestPath.split('path=')[1]);
      restoredByDestination.set(target, archive);
      return null;
    }
    if (method === 'GET' && requestPath.startsWith('/containers/' + CANDIDATE_ID + '/archive?path=')) {
      const target = decodeURIComponent(requestPath.split('path=')[1]).replace(/\/\.$/, '');
      return restoredByDestination.get(target);
    }
    throw new Error('Unexpected Docker archive request: ' + method + ' ' + requestPath);
  }

  const manager = createStatefulRehearsalManager({
    dataRoot: root,
    dockerRequest,
    dockerArchiveRequest,
    resourceRegistry: { getLatest: () => snapshot },
    encryptionStore,
    secretManager,
    httpProbe: async ({ port, healthPath }) => {
      calls.push({ method: 'HTTP_GET', requestPath: `http://127.0.0.1:${port}${healthPath}` });
      return { statusCode: failCandidateHealth ? 503 : 200 };
    },
    clock: () => new Date('2026-08-05T02:00:00.000Z'),
    randomUUID: (() => {
      let counter = 1;
      return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
    })(),
    wait: async () => {}
  });

  return {
    calls,
    environment,
    manager,
    persistentArchive,
    root,
    state: () => ({
      candidateExists,
      candidatePayload,
      networkName,
      sourcePaused,
      temporaryVolumes: [...temporaryVolumes]
    }),
    setEnvironment: (entries) => { currentEnvironment = entries; }
  };
}

function plan(manager, overrides = {}) {
  return manager.createPlan({
    resourceId: RESOURCE_ID,
    persistentVolumes: [DATA_VOLUME],
    emptyVolumes: [SOCKET_VOLUME],
    privatePort: 8090,
    confirmation: PLAN_STATEFUL_REHEARSAL_CONFIRMATION,
    ...overrides
  });
}

test('planning is GET-only, redacted and requires complete explicit volume classification', async () => {
  const harness = createHarness();
  try {
    await assert.rejects(
      () => harness.manager.createPlan({ resourceId: RESOURCE_ID }),
      (error) => error.code === 'confirmation-required'
    );
    await assert.rejects(
      () => harness.manager.createPlan({
        resourceId: RESOURCE_ID,
        persistentVolumes: [DATA_VOLUME],
        privatePort: 8090,
        confirmation: PLAN_STATEFUL_REHEARSAL_CONFIRMATION
      }),
      (error) => error.code === 'incomplete-volume-classification'
    );
    const created = await plan(harness.manager);
    assert.equal(created.environment.valuesIncluded, false);
    assert.equal(created.health.commandIncluded, false);
    assert.equal(created.guarantees.sourceStopIncluded, false);
    assert.equal(created.guarantees.offHostRecoveryProven, false);
    assert.equal(created.confirmation, runConfirmation(created.planId));
    assert.equal(JSON.stringify(created).includes(SECRET_VALUE), false);
    assert.deepEqual(new Set(harness.calls.map((call) => call.method)), new Set(['GET']));
    assert.equal(fs.statSync(harness.manager.paths.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(harness.manager.paths.plansRoot, created.planId + '.json')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('planning fails closed when the source health check is not currently healthy', async () => {
  const harness = createHarness({ sourceHealth: 'unhealthy' });
  try {
    await assert.rejects(
      () => plan(harness.manager),
      (error) => error.code === 'source-not-healthy'
    );
    assert.deepEqual(new Set(harness.calls.map((call) => call.method)), new Set(['GET']));
    assert.equal(harness.manager.status().summary.plans, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('a source without Docker health requires an explicit bounded loopback HTTP proof', async () => {
  const harness = createHarness({ sourceDockerHealth: false });
  try {
    await assert.rejects(
      () => plan(harness.manager),
      (error) => error.code === 'invalid-http-health-path'
    );
    await assert.rejects(
      () => plan(harness.manager, { httpHealthPath: '/health?token=unsafe' }),
      (error) => error.code === 'invalid-http-health-path'
    );
    const created = await plan(harness.manager, { httpHealthPath: '/' });
    assert.equal(created.health.mode, 'loopback-http');
    assert.equal(created.health.healthPath, '/');
    assert.equal(created.health.expectedStatus, 200);
    const operation = await harness.manager.runPlan(created.planId, created.confirmation);
    const state = harness.state();
    assert.equal(operation.status, 'verified-and-cleaned');
    assert.equal(operation.candidate.healthMode, 'loopback-http');
    assert.equal(operation.source.healthAfterProof.status, 'running');
    assert.equal(operation.source.healthAfterProof.paused, false);
    assert.equal(operation.source.healthAfterProof.health, null);
    assert.equal(Object.hasOwn(state.candidatePayload, 'Healthcheck'), false);
    assert.equal(
      harness.calls.some((call) => call.method === 'HTTP_GET' && call.requestPath === 'http://127.0.0.1:49152/'),
      true
    );
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('the persistent operation lock prevents a second process from starting a run', async () => {
  const harness = createHarness();
  try {
    const created = await plan(harness.manager);
    fs.writeFileSync(
      harness.manager.paths.operationLockFile,
      JSON.stringify({ schemaVersion: 1, pid: 'unknown', purpose: 'other-process' }),
      { mode: 0o600 }
    );
    await assert.rejects(
      () => harness.manager.runPlan(created.planId, created.confirmation),
      (error) => error.code === 'rehearsal-busy'
    );
    assert.equal(harness.manager.status().summary.operations, 0);
    assert.equal(harness.calls.some((call) => call.method !== 'GET'), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('a successful rehearsal encrypts, restores, health-gates and completely cleans temporary Docker state', async () => {
  const harness = createHarness();
  try {
    const created = await plan(harness.manager);
    const operation = await harness.manager.runPlan(created.planId, created.confirmation);
    const state = harness.state();
    assert.equal(operation.status, 'verified-and-cleaned');
    assert.equal(operation.source.stopped, false);
    assert.equal(operation.source.recreated, false);
    assert.equal(operation.source.pauseState, 'unpaused');
    assert.equal(operation.restore.verified, true);
    assert.equal(operation.restore.volumes[0].verified, true);
    assert.equal(operation.restore.emptyVolumesRecreated[0].recreatedEmpty, true);
    assert.equal(operation.candidate.health, 'healthy');
    assert.equal(operation.candidate.internalNetwork, true);
    assert.equal(operation.candidate.hostBinding, '127.0.0.1:dynamic');
    assert.equal(operation.candidate.removedAfterProof, true);
    assert.equal(operation.guarantees.routeMutated, false);
    assert.equal(operation.guarantees.providerMetadataMutated, false);
    assert.equal(operation.guarantees.offHostRecoveryProven, false);
    assert.equal(state.sourcePaused, false);
    assert.equal(state.candidateExists, false);
    assert.equal(state.networkName, null);
    assert.deepEqual(state.temporaryVolumes, []);
    assert.deepEqual(state.candidatePayload.Env.sort(), [
      'APP_MODE=production',
      'TOKEN=' + SECRET_VALUE
    ]);
    assert.equal(state.candidatePayload.Env.some((entry) => entry.startsWith('COOLIFY_')), false);
    assert.equal(state.candidatePayload.HostConfig.NetworkMode.startsWith('foxos-stateful-rehearsal-'), true);
    assert.deepEqual(state.candidatePayload.HostConfig.PortBindings['8090/tcp'], [
      { HostIp: '127.0.0.1', HostPort: '0' }
    ]);
    const archiveFile = path.join(harness.root, operation.backups[0].archiveFile);
    const encrypted = fs.readFileSync(archiveFile);
    assert.equal(encrypted.includes(harness.persistentArchive), false);
    assert.equal(encrypted.includes(Buffer.from(SECRET_VALUE)), false);
    assert.equal(fs.statSync(archiveFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(archiveFile)).mode & 0o777, 0o700);
    const serialized = JSON.stringify(operation);
    assert.equal(serialized.includes(SECRET_VALUE), false);
    assert.equal(harness.manager.status().summary.verified, 1);
    assert.equal(harness.manager.status().guarantees.interruptedOperationsReplayed, false);
    assert.equal(harness.calls.some((call) => call.requestPath.includes('/stop')), false);
    assert.equal(harness.calls.some((call) => call.requestPath.includes('/rename')), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('candidate health failure unpauses the source, removes every temporary object and never creates current proof', async () => {
  const harness = createHarness({ failCandidateHealth: true });
  try {
    const created = await plan(harness.manager);
    await assert.rejects(
      () => harness.manager.runPlan(created.planId, created.confirmation),
      (error) => error.code === 'candidate-health-failed'
    );
    const operation = harness.manager.status().operations[0];
    const state = harness.state();
    assert.equal(operation.status, 'failed-and-cleaned');
    assert.equal(operation.failure.code, 'candidate-health-failed');
    assert.equal(operation.cleanup.completed, true);
    assert.equal(state.sourcePaused, false);
    assert.equal(state.candidateExists, false);
    assert.equal(state.networkName, null);
    assert.deepEqual(state.temporaryVolumes, []);
    assert.equal(harness.manager.status().summary.verified, 0);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('environment drift fails before source pause or temporary Docker creation', async () => {
  const harness = createHarness();
  try {
    const created = await plan(harness.manager);
    harness.setEnvironment([
      'APP_MODE=changed',
      'TOKEN=' + SECRET_VALUE,
      'COOLIFY_FQDN=https://beszel.example.test'
    ]);
    await assert.rejects(
      () => harness.manager.runPlan(created.planId, created.confirmation),
      (error) => error.code === 'rehearsal-plan-stale'
    );
    assert.equal(harness.calls.some((call) => call.requestPath.endsWith('/pause')), false);
    assert.equal(harness.calls.some((call) => call.requestPath === '/networks/create'), false);
    assert.equal(harness.manager.status().operations[0].status, 'failed-and-cleaned');
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('an empty-ephemeral volume containing data fails closed after immediate source unpause', async () => {
  const harness = createHarness({ emptyArchive: tarArchive('unexpected.sock', 'not empty') });
  try {
    const created = await plan(harness.manager);
    await assert.rejects(
      () => harness.manager.runPlan(created.planId, created.confirmation),
      (error) => error.code === 'ephemeral-volume-not-empty'
    );
    const state = harness.state();
    assert.equal(state.sourcePaused, false);
    assert.equal(state.candidateExists, false);
    assert.equal(state.networkName, null);
    assert.equal(harness.manager.status().operations[0].source.pauseState, 'unpaused');
    assert.equal(harness.manager.status().operations[0].status, 'failed-and-cleaned');
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('startup recovery unpauses and cleans but never replays interrupted operations', async () => {
  const harness = createHarness();
  try {
    const operationId = 'sro_' + 'f'.repeat(32);
    const temporary = {
      candidateName: 'foxos-stateful-rehearsal-recovery',
      networkName: 'foxos-stateful-rehearsal-recovery',
      volumes: [{ temporaryName: 'foxos-stateful-rehearsal-recovery-v1' }]
    };
    harness.state();
    const stateFile = path.join(harness.manager.paths.operationsRoot, operationId + '.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 1,
      operationId,
      resourceId: RESOURCE_ID,
      status: 'running',
      startedAt: '2026-08-05T01:00:00.000Z',
      source: {
        containerId: SOURCE_ID,
        pauseRequested: true,
        pauseState: 'requested'
      },
      temporary
    }), { mode: 0o600 });

    const recovery = await harness.manager.recoverInterruptedOperations();
    assert.equal(recovery.replayed, false);
    assert.equal(recovery.recovered[0].status, 'interrupted-cleaned');
    const recovered = harness.manager.getOperation(operationId);
    assert.equal(recovered.cleanup.completed, true);
    assert.equal(recovered.cleanup.replayed, false);
    assert.equal(recovered.status, 'interrupted-cleaned');
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('tar empty-volume classification distinguishes directory-only and material archives', () => {
  assert.equal(tarHasMaterialEntries(emptyDirectoryArchive()), false);
  assert.equal(tarHasMaterialEntries(tarArchive('data/file', 'content')), true);
});
