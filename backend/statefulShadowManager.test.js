const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { tarContentDigest } = require('./adoptionManager');
const { classifyResource } = require('./resourceClassification');
const { createEncryptionStore } = require('./encryptionStore');
const { createSecretManager } = require('./secretManager');
const {
  canonicalJson,
  statefulRehearsalResourceFingerprint
} = require('./applicationManifestManager');
const {
  PLAN_STATEFUL_SHADOW_CONFIRMATION,
  createStatefulShadowManager,
  runConfirmation
} = require('./statefulShadowManager');

const SOURCE_RESOURCE_ID = 'res_' + '1'.repeat(32);
const SOURCE_CONTAINER_ID = 'a'.repeat(64);
const SHADOW_CONTAINER_ID = 'b'.repeat(64);
const IMAGE_ID = 'sha256:' + 'c'.repeat(64);
const DATA_VOLUME = 'provider-beszel-data';
const SOCKET_VOLUME = 'provider-beszel-socket';
const SECRET_VALUE = 'never-write-this-secret-to-a-record';

function tarHeader(name, size = 0) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function tarArchive(name, content) {
  const data = Buffer.from(content);
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([tarHeader(name, data.length), data, padding, Buffer.alloc(1024)]);
}

function sourceResource() {
  const value = {
    schemaVersion: 1,
    id: SOURCE_RESOURCE_ID,
    kind: 'container',
    name: 'beszel-hub',
    role: 'application',
    ownership: 'observed',
    provider: 'coolify',
    protected: false,
    provenance: { imported: false, safeLabels: {}, project: 'tools', service: 'beszel' },
    runtime: {
      engine: 'docker',
      containerId: SOURCE_CONTAINER_ID,
      image: 'henrygd/beszel:latest',
      imageId: IMAGE_ID,
      state: 'running',
      status: 'Up 1 day (healthy)',
      restartPolicy: 'unless-stopped',
      health: { configured: true, status: 'healthy' },
      constraints: {
        user: '', privileged: false, readOnlyRootFilesystem: false,
        noNewPrivileges: false, allCapabilitiesDropped: false,
        memoryBytes: null, nanoCpus: null, pidsLimit: null
      },
      environmentVariableCount: 3,
      inspection: 'complete'
    },
    ports: [{ privatePort: 8090, protocol: 'tcp', hostIp: null, hostPort: null }],
    routes: [{ domain: 'beszel.example.test', path: '/', tls: true }],
    mounts: [
      { type: 'volume', name: DATA_VOLUME, destination: '/beszel_data', readOnly: false },
      { type: 'volume', name: SOCKET_VOLUME, destination: '/beszel_socket', readOnly: false }
    ],
    networks: [{ name: 'provider-network' }],
    adoption: { stage: 'observed', eligible: false, ready: false, blockers: [] }
  };
  return { ...value, classification: classifyResource(value) };
}

function createHarness({ failHealth = false, preexistingShadow = false, foreignVolumeAfterCreate = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateful-shadow-'));
  const source = sourceResource();
  const calls = [];
  const archive = tarArchive('data/state.db', 'beszel persistent state\n');
  const contentDigest = tarContentDigest(archive);
  const encryptionStore = createEncryptionStore({ dataRoot: root });
  const secretManager = createSecretManager({ dataRoot: root, encryptionStore });
  const secret = secretManager.putSecret('workload/' + SOURCE_RESOURCE_ID + '/TOKEN', SECRET_VALUE);
  const environment = secretManager.createEnvironmentRevision(SOURCE_RESOURCE_ID, {
    ordinary: { APP_MODE: 'production' },
    secretRefs: { TOKEN: { secretId: secret.secretId, revision: secret.revision } },
    excluded: { COOLIFY_FQDN: 'provider-runtime-metadata' }
  });
  const sourceEnvironment = [
    'APP_MODE=production',
    'TOKEN=' + SECRET_VALUE,
    'COOLIFY_FQDN=https://beszel.example.test'
  ];
  const healthcheck = {
    Test: ['CMD', '/beszel', 'health', '--url', 'http://localhost:8090'],
    Interval: 5000000000,
    Timeout: 2000000000,
    Retries: 3
  };
  const rehearsalOperationId = 'sro_' + '2'.repeat(32);
  const rehearsalPlanId = 'srp_' + '3'.repeat(32);
  const archiveContext = {
    purpose: 'foxos-stateful-rehearsal-volume',
    schemaVersion: 2,
    operationId: rehearsalOperationId,
    resourceId: SOURCE_RESOURCE_ID,
    volumeName: DATA_VOLUME,
    destination: '/beszel_data',
    contentDigest
  };
  const encrypted = encryptionStore.encryptBuffer(archive, archiveContext);
  const archiveFile = path.join(root, 'stateful-rehearsals', 'archives', rehearsalOperationId, 'volume.foxosenc');
  encryptionStore.atomicWriteBuffer(archiveFile, encrypted);
  const healthFingerprint = encryptionStore.fingerprint(Buffer.from(canonicalJson(healthcheck), 'utf8'));
  const environmentFingerprint = secretManager.fingerprintEnvironment(sourceEnvironment);
  const rehearsalOperation = {
    schemaVersion: 2,
    operationId: rehearsalOperationId,
    planId: rehearsalPlanId,
    resourceId: SOURCE_RESOURCE_ID,
    rehearsalResourceFingerprint: statefulRehearsalResourceFingerprint(source),
    status: 'verified-and-cleaned',
    completedAt: '2026-08-05T10:00:00.000Z',
    source: {
      containerId: SOURCE_CONTAINER_ID,
      imageId: IMAGE_ID,
      stopped: false,
      recreated: false,
      pauseState: 'unpaused',
      pauseDurationMs: 50,
      healthAfterProof: { status: 'running', paused: false, health: 'healthy' }
    },
    environment: {
      revision: environment.revision,
      managedVariableCount: 2,
      excludedProviderVariableCount: 1,
      valuesIncluded: false
    },
    backups: [{
      volumeName: DATA_VOLUME,
      destination: '/beszel_data',
      archiveFile: path.relative(root, archiveFile),
      contentDigest,
      encryptedDigest: 'sha256:' + require('node:crypto').createHash('sha256').update(encrypted).digest('hex'),
      algorithm: 'aes-256-gcm',
      keyId: encryptionStore.keyId(),
      authenticated: true,
      plaintextStored: false,
      offHost: false
    }],
    restore: {
      verified: true,
      volumes: [{ volumeName: DATA_VOLUME, destination: '/beszel_data', verified: true }],
      emptyVolumesRecreated: [{ volumeName: SOCKET_VOLUME, destination: '/beszel_socket', recreatedEmpty: true }]
    },
    candidate: {
      health: 'healthy',
      healthMode: 'docker-healthcheck',
      internalNetwork: true,
      externalNetwork: false,
      hostBinding: 'none',
      hostPortPublished: false,
      removedAfterProof: true
    },
    cleanup: { completed: true },
    guarantees: {
      routeMutated: false,
      trafficCutover: false,
      providerMetadataMutated: false,
      providerDetached: false,
      candidateHadExternalNetwork: false,
      candidateHostPortPublished: false,
      environmentValuesIncluded: false,
      secretValuesIncluded: false,
      plaintextArchiveStored: false
    }
  };
  const rehearsalPlan = {
    schemaVersion: 2,
    planId: rehearsalPlanId,
    resourceId: SOURCE_RESOURCE_ID,
    environmentFingerprint,
    volumes: [
      { name: DATA_VOLUME, destination: '/beszel_data', policy: 'persistent' },
      { name: SOCKET_VOLUME, destination: '/beszel_socket', policy: 'empty-ephemeral' }
    ],
    privatePort: 8090,
    health: {
      configured: true,
      mode: 'docker-healthcheck',
      sourceFingerprint: healthFingerprint,
      fingerprint: 'ignored-by-shadow',
      commandIncluded: false
    }
  };

  let latestSnapshot = {
    schemaVersion: 1,
    snapshotId: 'snap_' + '4'.repeat(24),
    observedAt: '2026-08-05T10:05:00.000Z',
    resources: [source],
    relationships: [],
    inventory: { images: [], networks: [], volumes: [] }
  };
  let containerPayload = null;
  let shadowRunning = false;
  let shadowExists = preexistingShadow;
  let networkName = null;
  let networkLabels = null;
  const volumes = new Set();
  const volumeLabels = new Map();

  function shadowDetails() {
    const portKey = '8090/tcp';
    return {
      Id: SHADOW_CONTAINER_ID,
      Image: IMAGE_ID,
      Config: { Labels: containerPayload.Labels, Env: containerPayload.Env, Healthcheck: healthcheck },
      HostConfig: containerPayload.HostConfig,
      State: {
        Status: shadowRunning ? 'running' : 'created',
        Health: { Status: shadowRunning ? (failHealth ? 'unhealthy' : 'healthy') : 'starting' }
      },
      NetworkSettings: {
        Ports: { [portKey]: [] },
        Networks: { [networkName]: { IPAddress: '172.28.0.2' } }
      }
    };
  }

  async function dockerRequest(method, requestPath, payload = null) {
    calls.push({ method, requestPath, payload });
    if (method === 'GET' && requestPath === '/containers/' + SOURCE_CONTAINER_ID + '/json') {
      return {
        Id: SOURCE_CONTAINER_ID,
        Image: IMAGE_ID,
        Config: { Env: sourceEnvironment, Healthcheck: healthcheck },
        State: { Status: 'running', Paused: false, Health: { Status: 'healthy' } }
      };
    }
    if (method === 'GET' && requestPath.startsWith('/containers/foxos-stateful-shadow-')) {
      if (!shadowExists) throw new Error('No such container');
      if (!containerPayload) return { Id: 'preexisting-shadow-container' };
      return shadowDetails();
    }
    if (method === 'GET' && requestPath.startsWith('/networks/foxos-stateful-shadow-')) {
      if (networkName && requestPath === '/networks/' + encodeURIComponent(networkName)) {
        return { Id: 'network-shadow', Name: networkName, Internal: true, Labels: networkLabels };
      }
      throw new Error('network not found');
    }
    if (method === 'GET' && requestPath.startsWith('/volumes/foxos-stateful-shadow-')) {
      const volumeName = decodeURIComponent(requestPath.slice('/volumes/'.length));
      if (volumes.has(volumeName)) return { Name: volumeName, Labels: volumeLabels.get(volumeName) };
      throw new Error('no such volume');
    }
    if (method === 'POST' && requestPath === '/networks/create') {
      networkName = payload.Name;
      networkLabels = payload.Labels;
      return { Id: 'network-shadow' };
    }
    if (method === 'GET' && requestPath === '/networks/network-shadow') {
      return { Id: 'network-shadow', Name: networkName, Internal: true, Labels: networkLabels };
    }
    if (method === 'POST' && requestPath === '/volumes/create') {
      volumes.add(payload.Name);
      volumeLabels.set(payload.Name, foreignVolumeAfterCreate
        ? { 'com.foxos.stateful-shadow.operation': 'foreign-operation' }
        : payload.Labels);
      return { Name: payload.Name };
    }
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      shadowExists = true;
      containerPayload = payload;
      return { Id: SHADOW_CONTAINER_ID };
    }
    if (method === 'POST' && requestPath === '/containers/' + SHADOW_CONTAINER_ID + '/start') {
      shadowRunning = true;
      return null;
    }
    if (method === 'GET' && requestPath === '/containers/' + SHADOW_CONTAINER_ID + '/json') {
      return shadowDetails();
    }
    if (method === 'DELETE' && requestPath.startsWith('/containers/')) {
      shadowExists = false;
      shadowRunning = false;
      return null;
    }
    if (method === 'DELETE' && requestPath.startsWith('/volumes/')) {
      const volumeName = decodeURIComponent(requestPath.slice('/volumes/'.length));
      volumes.delete(volumeName);
      volumeLabels.delete(volumeName);
      return null;
    }
    if (method === 'DELETE' && requestPath.startsWith('/networks/')) {
      networkName = null;
      networkLabels = null;
      return null;
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  }

  async function dockerArchiveRequest(method, requestPath, payload) {
    calls.push({ method, requestPath, payload });
    if (method === 'PUT') return null;
    if (method === 'GET') return archive;
    throw new Error('Unexpected archive request');
  }

  const resourceRegistry = {
    getLatest: () => latestSnapshot,
    scan: async () => {
      const labels = containerPayload.Labels;
      const shadow = {
        schemaVersion: 1,
        id: labels['com.foxos.resource.id'],
        kind: 'container',
        name: 'foxos-stateful-shadow-test',
        role: 'application',
        ownership: 'foxos-managed',
        provider: 'foxos',
        protected: false,
        provenance: { imported: false, safeLabels: labels, project: null, service: null },
        runtime: {
          engine: 'docker', containerId: SHADOW_CONTAINER_ID, image: IMAGE_ID, imageId: IMAGE_ID,
          state: 'running', restartPolicy: 'unless-stopped', health: { configured: true, status: 'healthy' },
          constraints: {
            privileged: false, noNewPrivileges: true,
            memoryBytes: containerPayload.HostConfig.Memory,
            nanoCpus: containerPayload.HostConfig.NanoCpus,
            pidsLimit: containerPayload.HostConfig.PidsLimit
          },
          environmentVariableCount: containerPayload.Env.length,
          inspection: 'complete'
        },
        ports: [{ privatePort: 8090, protocol: 'tcp', hostIp: null, hostPort: null }],
        routes: [],
        mounts: containerPayload.HostConfig.Mounts.map((mount) => ({
          type: 'volume', name: mount.Source, destination: mount.Target, readOnly: false
        })),
        networks: [{ name: networkName }]
      };
      latestSnapshot = {
        ...latestSnapshot,
        snapshotId: 'snap_' + '5'.repeat(24),
        observedAt: '2026-08-05T10:06:00.000Z',
        resources: [source, shadow]
      };
      return latestSnapshot;
    }
  };

  let uuidCounter = 6;
  const manager = createStatefulShadowManager({
    dataRoot: root,
    dockerRequest,
    dockerArchiveRequest,
    resourceRegistry,
    encryptionStore,
    secretManager,
    statefulRehearsalStatus: () => ({
      current: [rehearsalOperation],
      operations: [rehearsalOperation],
      plans: [rehearsalPlan],
      guarantees: {}
    }),
    clock: () => new Date('2026-08-05T10:07:00.000Z'),
    randomUUID: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
    wait: () => Promise.resolve()
  });

  return {
    calls,
    getContainerPayload: () => containerPayload,
    manager,
    root,
    source,
    state: () => ({ shadowExists, shadowRunning, volumes: [...volumes] })
  };
}

test('creates a persistent isolated FoxOS-owned shadow from an authenticated rehearsal snapshot', async () => {
  const harness = createHarness();
  const plan = await harness.manager.createPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_CONFIRMATION
  });
  assert.equal(plan.guarantees.sourceMutationIncluded, false);
  assert.equal(plan.guarantees.trafficCutover, false);
  assert.notEqual(plan.shadow.shadowResourceId, SOURCE_RESOURCE_ID);

  const operation = await harness.manager.runPlan(plan.planId, runConfirmation(plan.planId));
  assert.equal(operation.status, 'active');
  assert.equal(operation.registryProof.verified, true);
  assert.equal(operation.shadow.health.verified, true);
  assert.equal(operation.shadow.volumesRestored.length, 2);
  assert.equal(harness.state().shadowExists, true);
  assert.equal(harness.state().shadowRunning, true);

  const payload = harness.getContainerPayload();
  assert.equal(payload.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(payload.HostConfig.NetworkMode.startsWith('foxos-stateful-shadow-'), true);
  assert.equal(payload.HostConfig.PortBindings, undefined);
  assert.equal(payload.Labels['com.foxos.managed'], 'true');
  assert.equal(payload.Labels['com.foxos.stateful-shadow.source-resource-id'], SOURCE_RESOURCE_ID);
  assert.notEqual(payload.Labels['com.foxos.resource.id'], SOURCE_RESOURCE_ID);
  assert.equal(JSON.stringify(operation).includes(SECRET_VALUE), false);
  assert.equal(JSON.stringify(plan).includes(SECRET_VALUE), false);

  const sourceCalls = harness.calls.filter((call) => call.requestPath.includes(SOURCE_CONTAINER_ID));
  assert.deepEqual([...new Set(sourceCalls.map((call) => call.method))], ['GET']);
  const status = harness.manager.status();
  assert.equal(status.summary.active, 1);
  assert.equal(status.summary.stale, 0);
});

test('cleans only its exact shadow resources when health verification fails', async () => {
  const harness = createHarness({ failHealth: true });
  const plan = await harness.manager.createPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_CONFIRMATION
  });
  await assert.rejects(
    harness.manager.runPlan(plan.planId, runConfirmation(plan.planId)),
    (error) => error.code === 'shadow-health-failed'
  );
  assert.equal(harness.state().shadowExists, false);
  assert.deepEqual(harness.state().volumes, []);
  assert.equal(harness.manager.status().summary.active, 0);
  const operation = harness.manager.status().operations[0];
  assert.equal(operation.status, 'failed-and-cleaned');
  assert.equal(operation.cleanup.completed, true);
});

test('fails closed without deleting a same-named resource it did not create', async () => {
  const harness = createHarness({ preexistingShadow: true });
  const plan = await harness.manager.createPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_CONFIRMATION
  });
  await assert.rejects(
    harness.manager.runPlan(plan.planId, runConfirmation(plan.planId)),
    (error) => error.code === 'shadow-resource-already-exists'
  );
  assert.equal(harness.state().shadowExists, true);
  assert.equal(harness.calls.some((call) => call.method === 'DELETE'), false);
});

test('a persistent operation lock prevents a second process from running the same shadow plan', async () => {
  const harness = createHarness();
  const plan = await harness.manager.createPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_CONFIRMATION
  });
  fs.writeFileSync(harness.manager.paths.operationLockFile, JSON.stringify({
    schemaVersion: 1,
    pid: null,
    token: 'owned-by-another-process'
  }), { mode: 0o600 });
  await assert.rejects(
    harness.manager.runPlan(plan.planId, runConfirmation(plan.planId)),
    (error) => error.code === 'stateful-shadow-busy'
  );
  assert.equal(harness.manager.status().operations.length, 0);
});

test('cleanup refuses to delete a raced volume whose operation label is not its own', async () => {
  const harness = createHarness({ foreignVolumeAfterCreate: true });
  const plan = await harness.manager.createPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_CONFIRMATION
  });
  await assert.rejects(
    harness.manager.runPlan(plan.planId, runConfirmation(plan.planId)),
    (error) => error.code === 'shadow-volume-ownership-failed'
  );
  assert.equal(harness.state().volumes.length, 1);
  assert.equal(
    harness.calls.some((call) => call.method === 'DELETE' && call.requestPath.startsWith('/volumes/')),
    false
  );
  const operation = harness.manager.status().operations[0];
  assert.equal(operation.status, 'failed-cleanup-required');
  assert.equal(operation.cleanup.errors.includes('volume:ownership-mismatch'), true);
});
