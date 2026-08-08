const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { tarContentDigest } = require('./adoptionManager');
const {
  canonicalJson,
  statefulRehearsalResourceFingerprint
} = require('./applicationManifestManager');
const { classifyResource } = require('./resourceClassification');
const { createEncryptionStore } = require('./encryptionStore');
const { createSecretManager } = require('./secretManager');
const {
  PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION,
  createStatefulShadowManager,
  refreshConfirmation,
  shadowNames
} = require('./statefulShadowManager');

const SOURCE_RESOURCE_ID = 'res_' + '1'.repeat(32);
const SOURCE_CONTAINER_ID = 'a'.repeat(64);
const OLD_SHADOW_CONTAINER_ID = 'b'.repeat(64);
const NEW_SHADOW_CONTAINER_ID = 'd'.repeat(64);
const IMAGE_ID = 'sha256:' + 'c'.repeat(64);
const DATA_VOLUME = 'provider-beszel-data';
const SOCKET_VOLUME = 'provider-beszel-socket';
const SECRET_VALUE = 'refresh-secret-never-persisted';
const OLD_REHEARSAL_OPERATION_ID = 'sro_' + '2'.repeat(32);
const OLD_REHEARSAL_PLAN_ID = 'srp_' + '3'.repeat(32);
const NEW_REHEARSAL_OPERATION_ID = 'sro_' + '4'.repeat(32);
const NEW_REHEARSAL_PLAN_ID = 'srp_' + '5'.repeat(32);
const OLD_SHADOW_OPERATION_ID = 'sso_' + '6'.repeat(32);
const OLD_SHADOW_PLAN_ID = 'ssp_' + '7'.repeat(32);

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

function createHarness({ failCandidateHealth = false, failPreviousCleanup = false, newerRehearsal = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shadow-refresh-'));
  const source = sourceResource();
  const calls = [];
  const events = [];
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
  const healthFingerprint = encryptionStore.fingerprint(Buffer.from(canonicalJson(healthcheck), 'utf8'));
  const environmentFingerprint = secretManager.fingerprintEnvironment(sourceEnvironment);
  const volumes = [
    { name: DATA_VOLUME, destination: '/beszel_data', policy: 'persistent' },
    { name: SOCKET_VOLUME, destination: '/beszel_socket', policy: 'empty-ephemeral' }
  ];

  function rehearsal(operationId, planId, completedAt, content) {
    const archive = tarArchive('data/state.db', content);
    const contentDigest = tarContentDigest(archive);
    const context = {
      purpose: 'foxos-stateful-rehearsal-volume',
      schemaVersion: 2,
      operationId,
      resourceId: SOURCE_RESOURCE_ID,
      volumeName: DATA_VOLUME,
      destination: '/beszel_data',
      contentDigest
    };
    const encrypted = encryptionStore.encryptBuffer(archive, context);
    const archiveFile = path.join(root, 'stateful-rehearsals', 'archives', operationId, 'volume.foxosenc');
    encryptionStore.atomicWriteBuffer(archiveFile, encrypted);
    const plan = {
      schemaVersion: 2,
      planId,
      resourceId: SOURCE_RESOURCE_ID,
      environmentFingerprint,
      volumes,
      privatePort: 8090,
      health: {
        configured: true,
        mode: 'docker-healthcheck',
        sourceFingerprint: healthFingerprint,
        fingerprint: 'health-proof',
        commandIncluded: false
      }
    };
    const operation = {
      schemaVersion: 2,
      operationId,
      planId,
      resourceId: SOURCE_RESOURCE_ID,
      rehearsalResourceFingerprint: statefulRehearsalResourceFingerprint(source),
      status: 'verified-and-cleaned',
      completedAt,
      source: {
        containerId: SOURCE_CONTAINER_ID,
        imageId: IMAGE_ID,
        stopped: false,
        recreated: false,
        pauseState: 'unpaused',
        pauseDurationMs: 40,
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
        encryptedDigest: 'sha256:' + crypto.createHash('sha256').update(encrypted).digest('hex'),
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
    return { archive, operation, plan };
  }

  const oldRehearsal = rehearsal(
    OLD_REHEARSAL_OPERATION_ID,
    OLD_REHEARSAL_PLAN_ID,
    '2026-08-05T10:00:00.000Z',
    'old snapshot\n'
  );
  const freshRehearsal = newerRehearsal
    ? rehearsal(
      NEW_REHEARSAL_OPERATION_ID,
      NEW_REHEARSAL_PLAN_ID,
      '2026-08-05T11:00:00.000Z',
      'new snapshot\n'
    )
    : oldRehearsal;
  const oldNames = shadowNames(SOURCE_RESOURCE_ID, volumes);
  const limits = { memoryBytes: 268435456, nanoCpus: 500000000, pidsLimit: 256 };
  const oldLabels = {
    'com.foxos.managed': 'true',
    'com.foxos.stateful-shadow': 'true',
    'com.foxos.stateful-shadow.source-resource-id': SOURCE_RESOURCE_ID,
    'com.foxos.stateful-shadow.operation': OLD_SHADOW_OPERATION_ID,
    'com.foxos.resource.id': oldNames.shadowResourceId
  };
  const containerById = new Map();
  const containerNameToId = new Map();
  const networksByName = new Map();
  const networksById = new Map();
  const dockerVolumes = new Map();
  let previousCleanupFailures = failPreviousCleanup ? 1 : 0;

  function addNetwork(name, id, labels) {
    const value = { Id: id, Name: name, Internal: true, Attachable: false, Driver: 'bridge', Labels: labels };
    networksByName.set(name, value);
    networksById.set(id, value);
  }

  function addContainer(id, name, payload, running = true) {
    const networkName = payload.HostConfig.NetworkMode;
    const value = {
      Id: id,
      Name: '/' + name,
      Image: payload.Image,
      Config: {
        Labels: payload.Labels,
        Env: payload.Env,
        Healthcheck: payload.Healthcheck || healthcheck
      },
      HostConfig: payload.HostConfig,
      State: {
        Status: running ? 'running' : 'created',
        Paused: false,
        Health: { Status: running && failCandidateHealth && id === NEW_SHADOW_CONTAINER_ID ? 'unhealthy' : running ? 'healthy' : 'starting' }
      },
      NetworkSettings: {
        Ports: { '8090/tcp': [] },
        Networks: { [networkName]: { IPAddress: id === OLD_SHADOW_CONTAINER_ID ? '172.28.0.2' : '172.29.0.2' } }
      }
    };
    containerById.set(id, value);
    containerNameToId.set(name, id);
    return value;
  }

  addNetwork(oldNames.networkName, 'old-network-id', oldLabels);
  for (const volume of oldNames.volumes) dockerVolumes.set(volume.shadowName, { Name: volume.shadowName, Labels: oldLabels });
  addContainer(OLD_SHADOW_CONTAINER_ID, oldNames.containerName, {
    Image: IMAGE_ID,
    Env: ['APP_MODE=production', 'TOKEN=' + SECRET_VALUE],
    Labels: oldLabels,
    Healthcheck: healthcheck,
    HostConfig: {
      Mounts: oldNames.volumes.map((volume) => ({
        Type: 'volume', Source: volume.shadowName, Target: volume.destination, ReadOnly: false
      })),
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      NetworkMode: oldNames.networkName,
      SecurityOpt: ['no-new-privileges:true'],
      Memory: limits.memoryBytes,
      NanoCpus: limits.nanoCpus,
      PidsLimit: limits.pidsLimit,
      Privileged: false
    }
  });

  function dockerShadowResource(details) {
    const labels = details.Config.Labels;
    return {
      schemaVersion: 1,
      id: labels['com.foxos.resource.id'],
      kind: 'container',
      name: details.Name.replace(/^\//, ''),
      role: 'application',
      ownership: 'foxos-managed',
      provider: 'foxos',
      protected: false,
      provenance: { imported: false, safeLabels: labels, project: null, service: null },
      runtime: {
        engine: 'docker',
        containerId: details.Id,
        image: IMAGE_ID,
        imageId: IMAGE_ID,
        state: details.State.Status,
        restartPolicy: details.HostConfig.RestartPolicy.Name,
        health: { configured: true, status: details.State.Health.Status },
        constraints: {
          privileged: false,
          noNewPrivileges: true,
          memoryBytes: details.HostConfig.Memory,
          nanoCpus: details.HostConfig.NanoCpus,
          pidsLimit: details.HostConfig.PidsLimit
        },
        environmentVariableCount: details.Config.Env.length,
        inspection: 'complete'
      },
      ports: [{ privatePort: 8090, protocol: 'tcp', hostIp: null, hostPort: null }],
      routes: [],
      mounts: details.HostConfig.Mounts.map((mount) => ({
        type: 'volume', name: mount.Source, destination: mount.Target, readOnly: false
      })),
      networks: [{ name: details.HostConfig.NetworkMode }]
    };
  }

  let latestSnapshot = {
    schemaVersion: 1,
    snapshotId: 'snap_' + '8'.repeat(24),
    observedAt: '2026-08-05T10:30:00.000Z',
    resources: [source, dockerShadowResource(containerById.get(OLD_SHADOW_CONTAINER_ID))],
    relationships: [],
    inventory: { images: [], networks: [], volumes: [] }
  };

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
    if (requestPath.startsWith('/containers/')) {
      const raw = decodeURIComponent(requestPath.slice('/containers/'.length).split(/[/?]/)[0]);
      const id = containerById.has(raw) ? raw : containerNameToId.get(raw);
      if (method === 'GET' && requestPath.endsWith('/json')) {
        if (!id) throw new Error('No such container');
        return containerById.get(id);
      }
      if (method === 'POST' && requestPath.endsWith('/start')) {
        if (!id) throw new Error('No such container');
        const details = containerById.get(id);
        details.State.Status = 'running';
        details.State.Health.Status = failCandidateHealth && id === NEW_SHADOW_CONTAINER_ID ? 'unhealthy' : 'healthy';
        return null;
      }
      if (method === 'DELETE') {
        if (!id) throw new Error('No such container');
        if (previousCleanupFailures > 0 && id === OLD_SHADOW_CONTAINER_ID) {
          previousCleanupFailures -= 1;
          throw new Error('injected previous cleanup failure');
        }
        const details = containerById.get(id);
        const name = details.Name.replace(/^\//, '');
        events.push('delete-container:' + name);
        containerById.delete(id);
        containerNameToId.delete(name);
        return null;
      }
    }
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      const name = decodeURIComponent(requestPath.split('name=')[1]);
      addContainer(NEW_SHADOW_CONTAINER_ID, name, payload, false);
      return { Id: NEW_SHADOW_CONTAINER_ID };
    }
    if (method === 'POST' && requestPath === '/networks/create') {
      const id = 'new-network-id';
      addNetwork(payload.Name, id, payload.Labels);
      return { Id: id };
    }
    if (method === 'GET' && requestPath.startsWith('/networks/')) {
      const nameOrId = decodeURIComponent(requestPath.slice('/networks/'.length));
      const network = networksByName.get(nameOrId) || networksById.get(nameOrId);
      if (!network) throw new Error('network not found');
      return network;
    }
    if (method === 'DELETE' && requestPath.startsWith('/networks/')) {
      const nameOrId = decodeURIComponent(requestPath.slice('/networks/'.length));
      const network = networksByName.get(nameOrId) || networksById.get(nameOrId);
      if (!network) throw new Error('network not found');
      events.push('delete-network:' + network.Name);
      networksByName.delete(network.Name);
      networksById.delete(network.Id);
      return null;
    }
    if (method === 'POST' && requestPath === '/volumes/create') {
      dockerVolumes.set(payload.Name, { Name: payload.Name, Labels: payload.Labels });
      return { Name: payload.Name };
    }
    if (method === 'GET' && requestPath.startsWith('/volumes/')) {
      const name = decodeURIComponent(requestPath.slice('/volumes/'.length));
      if (!dockerVolumes.has(name)) throw new Error('no such volume');
      return dockerVolumes.get(name);
    }
    if (method === 'DELETE' && requestPath.startsWith('/volumes/')) {
      const name = decodeURIComponent(requestPath.slice('/volumes/'.length));
      if (!dockerVolumes.has(name)) throw new Error('no such volume');
      events.push('delete-volume:' + name);
      dockerVolumes.delete(name);
      return null;
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  }

  async function dockerArchiveRequest(method) {
    if (method === 'PUT') return null;
    if (method === 'GET') return freshRehearsal.archive;
    throw new Error('Unexpected archive request');
  }

  let scanCounter = 0;
  const resourceRegistry = {
    getLatest: () => latestSnapshot,
    scan: async () => {
      const shadows = [...containerById.values()].map(dockerShadowResource);
      events.push('scan:' + shadows.map((entry) => entry.name).sort().join(','));
      latestSnapshot = {
        ...latestSnapshot,
        snapshotId: 'snap_' + String(++scanCounter).padStart(24, '9'),
        observedAt: '2026-08-05T11:10:00.000Z',
        resources: [source, ...shadows]
      };
      return latestSnapshot;
    }
  };

  let uuidCounter = 10;
  const manager = createStatefulShadowManager({
    dataRoot: root,
    dockerRequest,
    dockerArchiveRequest,
    resourceRegistry,
    encryptionStore,
    secretManager,
    statefulRehearsalStatus: () => ({
      current: [freshRehearsal.operation],
      operations: [oldRehearsal.operation, freshRehearsal.operation],
      plans: [oldRehearsal.plan, freshRehearsal.plan],
      guarantees: {}
    }),
    clock: () => new Date('2026-08-05T11:15:00.000Z'),
    randomUUID: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
    wait: () => Promise.resolve()
  });

  const oldPlan = {
    schemaVersion: 1,
    action: 'create',
    planId: OLD_SHADOW_PLAN_ID,
    sourceResourceId: SOURCE_RESOURCE_ID,
    health: oldRehearsal.plan.health,
    privatePort: 8090
  };
  const oldRecord = {
    schemaVersion: 1,
    action: 'create',
    operationId: OLD_SHADOW_OPERATION_ID,
    planId: OLD_SHADOW_PLAN_ID,
    sourceResourceId: SOURCE_RESOURCE_ID,
    sourceResourceFingerprint: statefulRehearsalResourceFingerprint(source),
    shadowResourceId: oldNames.shadowResourceId,
    status: 'active',
    startedAt: '2026-08-05T10:05:00.000Z',
    completedAt: '2026-08-05T10:10:00.000Z',
    source: {
      containerId: SOURCE_CONTAINER_ID,
      imageId: IMAGE_ID,
      mutated: false,
      paused: false,
      stopped: false,
      recreated: false
    },
    rehearsal: {
      operationId: OLD_REHEARSAL_OPERATION_ID,
      planId: OLD_REHEARSAL_PLAN_ID,
      verifiedAt: oldRehearsal.operation.completedAt,
      snapshotAt: oldRehearsal.operation.completedAt,
      sourceEnvironmentFingerprint: environmentFingerprint,
      sourceHealthFingerprint: healthFingerprint
    },
    environment: {
      revision: environment.revision,
      managedVariableCount: 2,
      excludedProviderVariableCount: 1,
      valuesIncluded: false
    },
    runtimeLimits: limits,
    shadow: {
      ...oldNames,
      containerId: OLD_SHADOW_CONTAINER_ID,
      internalNetworkVerified: true,
      volumesRestored: [
        {
          sourceName: DATA_VOLUME,
          destination: '/beszel_data',
          policy: 'persistent',
          restored: true,
          contentDigest: oldRehearsal.operation.backups[0].contentDigest
        },
        {
          sourceName: SOCKET_VOLUME,
          destination: '/beszel_socket',
          policy: 'empty-ephemeral',
          restored: true,
          recreatedEmpty: true
        }
      ],
      health: {
        verified: true,
        mode: 'docker-healthcheck',
        privatePort: 8090,
        hostPortPublished: false,
        internalAddressObserved: true,
        verifiedAt: '2026-08-05T10:10:00.000Z'
      },
      hostPortPublished: false,
      externalNetwork: false,
      routeCreated: false,
      ownerOperationId: OLD_SHADOW_OPERATION_ID,
      created: {
        container: true,
        network: true,
        volumes: oldNames.volumes.map((volume) => volume.shadowName)
      }
    },
    cleanup: { attempted: false, completed: false, errors: [] },
    guarantees: {
      sourceMutationIncluded: false,
      sourcePauseIncluded: false,
      sourceStopIncluded: false,
      sourceRecreationIncluded: false,
      sourceIdentityClaimed: false,
      separateFoxOSIdentity: true,
      internalNetworkOnly: true,
      hostPortPublished: false,
      externalNetworkIncluded: false,
      routeCreated: false,
      trafficCutover: false,
      providerMutationIncluded: false,
      providerDetachIncluded: false,
      localEncryptedSnapshotUsed: true,
      offHostRecoveryProven: false,
      environmentValuesIncluded: false,
      secretValuesIncluded: false
    }
  };
  fs.mkdirSync(manager.paths.plansRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(manager.paths.currentRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(manager.paths.plansRoot, OLD_SHADOW_PLAN_ID + '.json'), JSON.stringify(oldPlan), { mode: 0o600 });
  fs.writeFileSync(path.join(manager.paths.currentRoot, SOURCE_RESOURCE_ID + '.json'), JSON.stringify(oldRecord), { mode: 0o600 });

  return {
    calls,
    events,
    manager,
    oldNames,
    root,
    state: () => ({
      containerIds: [...containerById.keys()],
      containerNames: [...containerNameToId.keys()],
      networkNames: [...networksByName.keys()],
      volumeNames: [...dockerVolumes.keys()]
    })
  };
}

test('refresh promotes a separately restored newer generation only after registry proof', async () => {
  const harness = createHarness();
  const plan = await harness.manager.createRefreshPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION
  });
  assert.equal(plan.action, 'refresh');
  assert.equal(plan.rehearsal.operationId, NEW_REHEARSAL_OPERATION_ID);
  assert.equal(plan.guarantees.previousShadowPreservedUntilCandidateRegistryProof, true);
  assert.equal(plan.guarantees.inPlaceVolumeMutation, false);
  assert.equal(plan.guarantees.finalSynchronizationProven, false);
  assert.notEqual(plan.shadow.containerName, harness.oldNames.containerName);

  const operation = await harness.manager.runRefreshPlan(
    plan.planId,
    refreshConfirmation(plan.planId)
  );
  assert.equal(operation.status, 'active');
  assert.equal(operation.registryProof.verified, true);
  assert.equal(operation.refresh.newerSnapshotVerified, true);
  assert.equal(operation.refresh.finalSynchronizationProven, false);
  assert.equal(operation.promotion.currentWritten, true);
  assert.equal(operation.promotion.previousCleanupCompleted, true);
  assert.equal(JSON.stringify(operation).includes(SECRET_VALUE), false);
  assert.equal(JSON.stringify(plan).includes(SECRET_VALUE), false);

  const status = harness.manager.status();
  assert.equal(status.summary.active, 1);
  assert.equal(status.summary.refreshPlans, 1);
  assert.equal(status.summary.refreshOperations, 1);
  assert.equal(status.current[0].operationId, operation.operationId);
  assert.equal(status.current[0].shadow.containerId, NEW_SHADOW_CONTAINER_ID);
  assert.equal(harness.state().containerIds.includes(OLD_SHADOW_CONTAINER_ID), false);
  assert.equal(harness.state().containerIds.includes(NEW_SHADOW_CONTAINER_ID), true);

  const proofScan = harness.events.findIndex((event) => event.startsWith('scan:') && event.includes(harness.oldNames.containerName));
  const oldDelete = harness.events.findIndex((event) => event === 'delete-container:' + harness.oldNames.containerName);
  assert.equal(proofScan >= 0, true);
  assert.equal(oldDelete > proofScan, true);
  const sourceMethods = [...new Set(harness.calls
    .filter((call) => call.requestPath.includes(SOURCE_CONTAINER_ID))
    .map((call) => call.method))];
  assert.deepEqual(sourceMethods, ['GET']);
});

test('failed refreshed candidate leaves the current healthy shadow and pointer untouched', async () => {
  const harness = createHarness({ failCandidateHealth: true });
  const plan = await harness.manager.createRefreshPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION
  });
  await assert.rejects(
    harness.manager.runRefreshPlan(plan.planId, refreshConfirmation(plan.planId)),
    (error) => error.code === 'shadow-health-failed'
  );
  const status = harness.manager.status();
  assert.equal(status.current[0].operationId, OLD_SHADOW_OPERATION_ID);
  assert.equal(status.current[0].shadow.containerId, OLD_SHADOW_CONTAINER_ID);
  assert.equal(harness.state().containerIds.includes(OLD_SHADOW_CONTAINER_ID), true);
  assert.equal(harness.state().containerIds.includes(NEW_SHADOW_CONTAINER_ID), false);
  const operation = status.operations.find((entry) => entry.action === 'refresh');
  assert.equal(operation.status, 'failed-and-cleaned');
  assert.equal(operation.promotion.currentWritten, false);
});

test('post-promotion cleanup failure is reflected in both the operation and current pointer', async () => {
  const harness = createHarness({ failPreviousCleanup: true });
  const plan = await harness.manager.createRefreshPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION
  });
  const operation = await harness.manager.runRefreshPlan(plan.planId, refreshConfirmation(plan.planId));
  assert.equal(operation.status, 'active-cleanup-required');
  assert.equal(operation.promotion.currentWritten, true);
  assert.equal(operation.promotion.previousCleanupCompleted, false);
  assert.equal(operation.cleanup.errors.some((error) => error.startsWith('container:')), true);
  const current = harness.manager.status().current[0];
  assert.equal(current.operationId, operation.operationId);
  assert.equal(current.status, 'active-cleanup-required');
  assert.equal(current.shadow.containerId, NEW_SHADOW_CONTAINER_ID);

  const recovered = await harness.manager.recoverInterruptedOperations({ clearStaleLock: true });
  assert.deepEqual(recovered.recovered, [{ operationId: operation.operationId, status: 'active' }]);
  assert.equal(harness.manager.status().current[0].status, 'active');
  assert.equal(harness.state().containerIds.includes(OLD_SHADOW_CONTAINER_ID), false);
});

test('refresh planning rejects the snapshot already used by the current shadow', async () => {
  const harness = createHarness({ newerRehearsal: false });
  await assert.rejects(
    harness.manager.createRefreshPlan({
      resourceId: SOURCE_RESOURCE_ID,
      confirmation: PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION
    }),
    (error) => error.code === 'newer-stateful-rehearsal-required'
  );
  assert.equal(harness.manager.status().summary.refreshPlans, 0);
});

test('startup recovery keeps a promoted refreshed generation instead of deleting it', async () => {
  const harness = createHarness();
  const plan = await harness.manager.createRefreshPlan({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION
  });
  const applied = await harness.manager.runRefreshPlan(plan.planId, refreshConfirmation(plan.planId));
  const operationFile = path.join(harness.manager.paths.operationsRoot, applied.operationId + '.json');
  fs.writeFileSync(operationFile, JSON.stringify({ ...applied, status: 'running' }), { mode: 0o600 });

  const recovered = await harness.manager.recoverInterruptedOperations({ clearStaleLock: true });
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.recovered[0].status, 'active');
  assert.equal(harness.state().containerIds.includes(NEW_SHADOW_CONTAINER_ID), true);
  assert.equal(harness.manager.status().current[0].shadow.containerId, NEW_SHADOW_CONTAINER_ID);
});
