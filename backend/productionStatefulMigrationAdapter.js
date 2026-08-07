const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const PRODUCTION_STATEFUL_ADAPTER_SCHEMA_VERSION = 1;
const OPERATION_ID_PATTERN = /^stmop_[a-f0-9]{32}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_HEALTH_ATTEMPTS = 60;
const DEFAULT_HEALTH_INTERVAL_MS = 500;
const MAX_DIRECT_STATEFUL_TRANSACTION_BYTES = 256 * 1024 * 1024;

class ProductionStatefulMigrationError extends Error {
  constructor(message, statusCode = 409, code = 'production-stateful-migration-error') {
    super(message);
    this.name = 'ProductionStatefulMigrationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function localImageReference(applicationId) {
  return 'local/' + String(applicationId).replace(/[^a-z0-9-]/g, '').slice(0, 63) + ':current';
}

function isNotFound(error) {
  return /no such (?:container|volume)|not found/i.test(String(error && error.message || ''));
}

function routeForHealth(routes, health) {
  return (routes || []).find((route) => route.upstreamPrivatePort === health.privatePort) || routes[0];
}

function createProductionStatefulMigrationAdapter({
  dataRoot,
  dockerRequest,
  dockerExec,
  resourceRegistry,
  secretManager,
  volumeSnapshots,
  certificateImporter,
  ingressAuthority,
  routingNetwork = 'foxos-routing',
  egressNetwork = 'foxos-egress',
  clock = () => new Date(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerExec !== 'function' ||
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    !secretManager || typeof secretManager.resolveEnvironment !== 'function' ||
    !volumeSnapshots || typeof volumeSnapshots.create !== 'function' ||
    typeof volumeSnapshots.inspectCapacity !== 'function' || typeof volumeSnapshots.restore !== 'function' ||
    !certificateImporter || typeof certificateImporter.importDomain !== 'function' ||
    !ingressAuthority || typeof ingressAuthority.stageRoutes !== 'function' ||
    typeof ingressAuthority.verifyLegacyDomain !== 'function' ||
    typeof ingressAuthority.verifyLegacyBackend !== 'function'
  ) throw new Error('Production stateful adapter requires Docker, registry, encrypted snapshots, certificate and ingress adapters');

  const root = path.join(dataRoot, 'production-stateful-adapter');
  const operationsRoot = path.join(root, 'operations');

  function now() {
    return new Date(clock()).toISOString();
  }

  function operationFile(operationId) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) {
      throw new ProductionStatefulMigrationError('Invalid stateful operation ID', 400, 'invalid-operation-id');
    }
    return path.join(operationsRoot, operationId + '.json');
  }

  function getState(operationId) {
    const record = readJson(operationFile(operationId));
    if (!record) throw new ProductionStatefulMigrationError('Stateful adapter state was not found', 404, 'adapter-state-not-found');
    return record;
  }

  function persist(record) {
    record.updatedAt = now();
    atomicWriteJson(operationFile(record.operationId), record);
    return record;
  }

  function currentResource(plan) {
    const snapshot = resourceRegistry.getLatest();
    if (!snapshot || snapshot.snapshotId !== plan.sourceSnapshotId) {
      throw new ProductionStatefulMigrationError('Registry snapshot changed after stateful planning', 409, 'registry-snapshot-stale');
    }
    const resource = (snapshot.resources || []).find((entry) => entry.id === plan.resource.resourceId);
    if (!resource) throw new ProductionStatefulMigrationError('Selected resource disappeared', 404, 'source-resource-not-found');
    return { snapshot, resource };
  }

  function routeProxy(snapshot, resource) {
    const relationship = (snapshot.relationships || []).find((entry) => (
      entry.type === 'route-through-proxy' && entry.sourceResourceId === resource.id && entry.targetResourceId
    ));
    const proxy = relationship && (snapshot.resources || []).find((entry) => entry.id === relationship.targetResourceId);
    if (!proxy || proxy.role !== 'proxy' || !proxy.runtime || !CONTAINER_ID_PATTERN.test(String(proxy.runtime.containerId || ''))) {
      throw new ProductionStatefulMigrationError('The current public route proxy could not be verified', 409, 'legacy-route-proxy-unavailable');
    }
    const sourceNetworks = new Set((resource.networks || []).map((network) => network.name));
    const legacyNetwork = (proxy.networks || []).map((network) => network.name)
      .filter((name) => sourceNetworks.has(name) && name !== routingNetwork).sort()[0];
    if (!legacyNetwork) {
      throw new ProductionStatefulMigrationError('The source and legacy proxy have no verified shared network', 409, 'legacy-route-network-unavailable');
    }
    return { proxy, legacyNetwork };
  }

  function environmentFor(plan) {
    const revision = secretManager.getEnvironmentRevision(plan.resource.resourceId);
    const expected = plan.executionContract.candidate.environment.revision;
    if (!revision || revision.revision !== expected) {
      throw new ProductionStatefulMigrationError('The encrypted environment revision is missing or stale', 409, 'environment-revision-stale');
    }
    const resolved = secretManager.resolveEnvironment(revision);
    const excluded = (revision.excluded || []).map((entry) => entry.name + '=');
    return { revision: revision.revision, resolved: [...resolved, ...excluded].sort() };
  }

  async function inspectSource(resource) {
    const details = await dockerRequest('GET', '/containers/' + resource.runtime.containerId + '/json');
    if (
      !details || details.Id !== resource.runtime.containerId || details.Image !== resource.runtime.imageId ||
      !details.State || details.State.Running !== true || details.State.Paused === true
    ) throw new ProductionStatefulMigrationError('Source identity or running state changed', 409, 'source-runtime-stale');
    const image = await dockerRequest('GET', '/images/' + encodeURIComponent(details.Image) + '/json');
    if (!image || image.Id !== details.Image || !IMAGE_ID_PATTERN.test(String(details.Image || ''))) {
      throw new ProductionStatefulMigrationError('The immutable source image is unavailable', 409, 'source-image-unavailable');
    }
    const config = details.Config || {};
    const imageConfig = image.Config || {};
    const host = details.HostConfig || {};
    const same = (left, right) => JSON.stringify(left === undefined ? null : left) === JSON.stringify(right === undefined ? null : right);
    if (
      !same(config.Cmd, imageConfig.Cmd) || !same(config.Entrypoint, imageConfig.Entrypoint) ||
      String(config.User || '') !== String(imageConfig.User || '') ||
      String(config.WorkingDir || '') !== String(imageConfig.WorkingDir || '')
    ) throw new ProductionStatefulMigrationError('Custom startup overrides require a dedicated migration adapter', 409, 'custom-runtime-overrides-unsupported');
    if (
      host.Privileged || host.NetworkMode === 'host' || host.PidMode === 'host' || host.IpcMode === 'host' ||
      host.UTSMode === 'host' || (host.Devices || []).length || (host.CapAdd || []).length
    ) throw new ProductionStatefulMigrationError('Host-level or privileged runtime access is unsupported', 409, 'unsafe-runtime-access');
    if (details.State.Health && details.State.Health.Status === 'unhealthy') {
      throw new ProductionStatefulMigrationError('Source health is unhealthy', 409, 'source-not-healthy');
    }
    return { details, image };
  }

  async function requireAbsent(requestPath, code) {
    try {
      await dockerRequest('GET', requestPath);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    throw new ProductionStatefulMigrationError('A planned server-owned runtime name already exists', 409, code);
  }

  async function findLocalDependencies(source, environment) {
    const sourceNetworks = Object.keys(source.NetworkSettings && source.NetworkSettings.Networks || {}).sort();
    const hosts = new Set();
    for (const entry of environment.resolved) {
      const value = entry.slice(entry.indexOf('=') + 1);
      try {
        const parsed = new URL(value);
        if (parsed.hostname && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) hosts.add(parsed.hostname);
      } catch { /* not a URL */ }
    }
    const local = [];
    for (const networkName of sourceNetworks) {
      const network = await dockerRequest('GET', '/networks/' + encodeURIComponent(networkName));
      for (const [containerId, attachment] of Object.entries(network.Containers || {})) {
        if (containerId === source.Id) continue;
        if (hosts.has(String(attachment.Name || ''))) local.push({ containerId, networkName, name: attachment.Name });
      }
    }
    return local;
  }

  async function preflight({ plan, operationId }) {
    const { snapshot, resource } = currentResource(plan);
    if (plan.executionContract.contractId !== plan.resource.executionContractId) {
      throw new ProductionStatefulMigrationError('Stateful execution contract identity changed', 409, 'execution-contract-stale');
    }
    const source = await inspectSource(resource);
    const environment = environmentFor(plan);
    const dependencies = await findLocalDependencies(source.details, environment);
    if (dependencies.length) {
      throw new ProductionStatefulMigrationError('A local companion service requires an atomic group migration', 409, 'stateful-dependency-transaction-required');
    }
    const contract = plan.executionContract;
    let capacity;
    try {
      capacity = await volumeSnapshots.inspectCapacity({
        volumes: contract.candidate.volumes.map((volume) => ({ name: volume.sourceName })),
        maximumTransactionBytes: MAX_DIRECT_STATEFUL_TRANSACTION_BYTES
      });
    } catch {
      throw new ProductionStatefulMigrationError(
        'The source volume size and available storage could not be verified',
        503,
        'stateful-capacity-inspection-failed'
      );
    }
    if (!capacity || capacity.supported !== true) {
      throw new ProductionStatefulMigrationError(
        'The source volume storage layout requires a dedicated migration adapter',
        409,
        'stateful-storage-layout-unsupported'
      );
    }
    if (capacity.withinTransactionLimit !== true) {
      throw new ProductionStatefulMigrationError(
        'The source data is too large for a bounded-pause direct copy and requires pre-synchronization',
        409,
        'stateful-presync-required'
      );
    }
    if (capacity.capacitySufficient !== true) {
      throw new ProductionStatefulMigrationError(
        'The host does not have enough free storage for the encrypted snapshot and restored candidate',
        507,
        'stateful-storage-capacity-insufficient'
      );
    }
    const proxy = routeProxy(snapshot, resource);
    const application = contract.application;
    await requireAbsent('/containers/' + encodeURIComponent(application.name) + '/json', 'candidate-name-conflict');
    for (const volume of contract.candidate.volumes) {
      await requireAbsent('/volumes/' + encodeURIComponent(volume.targetName), 'candidate-volume-conflict');
    }
    await ingressAuthority.inspectOwnedInfrastructure();
    const egress = await dockerRequest('GET', '/networks/' + encodeURIComponent(egressNetwork));
    if (
      !egress || !egress.Labels || egress.Labels['com.foxos.core'] !== 'true' ||
      egress.Labels['com.foxos.egress'] !== 'true' || egress.Internal === true
    ) throw new ProductionStatefulMigrationError('The server-owned egress network is unavailable', 503, 'foxos-egress-unavailable');
    await ingressAuthority.ensureLegacyBridge({
      proxyContainerId: proxy.proxy.runtime.containerId,
      legacyNetwork: proxy.legacyNetwork
    });
    for (const route of contract.routes) {
      await ingressAuthority.verifyLegacyDomain({ hostname: route.domain, requestPath: route.path });
      await certificateImporter.importDomain({ domain: route.domain, proxyContainerId: proxy.proxy.runtime.containerId });
    }
    const healthRoute = routeForHealth(contract.routes, contract.candidate.health);
    const sourcePublic = await ingressAuthority.httpsProbe({
      hostname: healthRoute.domain,
      requestPath: contract.candidate.health.path
    });
    const routeCollision = (snapshot.conflicts || []).some((entry) => (
      entry.severity === 'blocking' && entry.type === 'domain-route' && (entry.resourceIds || []).includes(resource.id)
    ));
    const state = {
      schemaVersion: PRODUCTION_STATEFUL_ADAPTER_SCHEMA_VERSION,
      operationId,
      planId: plan.planId,
      resourceId: resource.id,
      source: {
        containerId: source.details.Id,
        imageId: source.details.Image,
        paused: false,
        stopped: false,
        pauseStartedAtMs: null,
        pauseStartedAt: null
      },
      proxy: { containerId: proxy.proxy.runtime.containerId, legacyNetwork: proxy.legacyNetwork },
      environmentRevision: environment.revision,
      capacity: {
        totalBytes: capacity.totalBytes,
        maximumTransactionBytes: capacity.maximumTransactionBytes,
        capacitySufficient: capacity.capacitySufficient,
        sharedFilesystem: capacity.sharedFilesystem,
        snapshotAvailableBytes: capacity.snapshotAvailableBytes,
        volumeAvailableBytes: capacity.volumeAvailableBytes,
        requiredFreeBytes: capacity.requiredFreeBytes,
        reserveBytes: capacity.reserveBytes
      },
      application,
      snapshots: [],
      targetVolumes: [],
      candidate: null,
      routes: [],
      switchedDomains: [],
      createdAt: now()
    };
    persist(state);
    return {
      evidenceFingerprint: plan.resource.evidenceFingerprint,
      sourceHealthy: sourcePublic.statusCode >= 200 && sourcePublic.statusCode < 400,
      routeCollisionFree: !routeCollision,
      providerStateMutated: false
    };
  }

  async function quiesceAndSnapshot({ plan, operationId }) {
    const state = getState(operationId);
    const source = await dockerRequest('GET', '/containers/' + state.source.containerId + '/json');
    if (!source.State || source.State.Running !== true || source.State.Paused === true || source.Image !== state.source.imageId) {
      throw new ProductionStatefulMigrationError('Source changed before final snapshot', 409, 'source-runtime-stale');
    }
    state.source.pauseStartedAtMs = Date.now();
    state.source.pauseStartedAt = now();
    state.source.pauseIntentPersisted = true;
    persist(state);
    await dockerRequest('POST', '/containers/' + state.source.containerId + '/pause');
    state.source.paused = true;
    state.source.pausedAt = now();
    persist(state);
    for (const volume of plan.executionContract.candidate.volumes) {
      const snapshot = await volumeSnapshots.create({
        operationId,
        volume: { name: volume.sourceName }
      });
      state.snapshots.push({ ...snapshot, destination: volume.destination, targetVolumeName: volume.targetName });
      persist(state);
    }
    return {
      sourcePaused: true,
      snapshotCount: state.snapshots.length,
      pauseStartedAtMs: state.source.pauseStartedAtMs,
      encrypted: true,
      plaintextStored: false
    };
  }

  async function createCandidate({ plan, operationId }) {
    const state = getState(operationId);
    const contract = plan.executionContract;
    const labels = {
      'com.foxos.managed': 'true',
      'com.foxos.app.id': contract.application.appId,
      'com.foxos.app.name': contract.application.displayName,
      'com.foxos.migration.source-resource-id': plan.resource.resourceId,
      'com.foxos.stateful-migration.id': operationId
    };
    const imageReference = localImageReference(contract.application.appId);
    await dockerRequest(
      'POST',
      '/images/' + encodeURIComponent(contract.source.imageId) + '/tag?repo=' +
        encodeURIComponent('local/' + contract.application.appId) + '&tag=current'
    );
    for (const volume of contract.candidate.volumes) {
      await dockerRequest('POST', '/volumes/create', { Name: volume.targetName, Labels: labels });
      const details = await dockerRequest('GET', '/volumes/' + encodeURIComponent(volume.targetName));
      if (!details.Labels || details.Labels['com.foxos.stateful-migration.id'] !== operationId) {
        throw new ProductionStatefulMigrationError('Candidate volume ownership proof failed', 500, 'candidate-volume-ownership-failed');
      }
      state.targetVolumes.push(volume.targetName);
      persist(state);
      const snapshot = state.snapshots.find((entry) => entry.volumeName === volume.sourceName);
      if (!snapshot) throw new ProductionStatefulMigrationError('Final encrypted snapshot is missing', 500, 'stateful-snapshot-missing');
      const restore = await volumeSnapshots.restore({
        snapshot,
        sourceVolumeName: volume.sourceName,
        volume: { name: volume.targetName }
      });
      if (!restore || restore.restored !== true || restore.plaintextSha256 !== snapshot.plaintextSha256) {
        throw new ProductionStatefulMigrationError('Candidate volume restore proof failed', 500, 'stateful-restore-proof-failed');
      }
    }
    const environment = environmentFor(plan);
    const source = await dockerRequest('GET', '/containers/' + state.source.containerId + '/json');
    const healthcheck = source.Config && source.Config.Healthcheck;
    const exposedPorts = Object.fromEntries(contract.candidate.ingressPorts.map((port) => [port + '/tcp', {}]));
    const created = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(contract.application.name), {
      Image: imageReference,
      Env: environment.resolved,
      Labels: { ...labels, 'com.foxos.image.reference': imageReference },
      ExposedPorts: exposedPorts,
      ...(healthcheck ? { Healthcheck: healthcheck } : {}),
      HostConfig: {
        Mounts: contract.candidate.volumes.map((volume) => ({
          Type: 'volume', Source: volume.targetName, Target: volume.destination,
          ReadOnly: false, VolumeOptions: { NoCopy: true }
        })),
        NetworkMode: routingNetwork,
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: contract.candidate.runtime.memoryBytes,
        NanoCpus: contract.candidate.runtime.nanoCpus,
        PidsLimit: contract.candidate.runtime.pidsLimit
      },
      NetworkingConfig: {
        EndpointsConfig: { [routingNetwork]: { Aliases: [contract.application.alias] } }
      }
    });
    state.candidate = {
      containerId: created.Id,
      containerName: contract.application.name,
      alias: contract.application.alias,
      imageId: contract.source.imageId,
      imageReference,
      privatePort: contract.candidate.health.privatePort,
      createdAt: now()
    };
    persist(state);
    await dockerRequest('POST', '/networks/' + encodeURIComponent(egressNetwork) + '/connect', {
      Container: created.Id,
      EndpointConfig: {}
    });
    await dockerRequest('POST', '/containers/' + created.Id + '/start');
    const candidate = await dockerRequest('GET', '/containers/' + created.Id + '/json');
    if (!candidate.State || candidate.State.Running !== true || candidate.Image !== contract.source.imageId) {
      throw new ProductionStatefulMigrationError('Candidate did not start from the exact image', 503, 'candidate-runtime-proof-failed');
    }
    return {
      containerId: candidate.Id,
      containerName: contract.application.name,
      applicationName: contract.application.displayName,
      imageId: candidate.Image,
      privatePort: contract.candidate.health.privatePort,
      owned: true,
      separateFromSource: candidate.Id !== state.source.containerId,
      restoredVolumes: state.targetVolumes.length
    };
  }

  async function verifyCandidateHealth({ plan, operationId }) {
    const state = getState(operationId);
    const health = plan.executionContract.candidate.health;
    const infrastructure = await ingressAuthority.inspectOwnedInfrastructure();
    const gatewayId = infrastructure && infrastructure.gateway && infrastructure.gateway.Id;
    if (!CONTAINER_ID_PATTERN.test(String(gatewayId || ''))) {
      throw new ProductionStatefulMigrationError('Routing gateway identity is unavailable', 503, 'foxos-gateway-identity-invalid');
    }
    const url = 'http://' + state.candidate.alias + ':' + health.privatePort + health.path;
    let last = null;
    for (let attempt = 1; attempt <= DEFAULT_HEALTH_ATTEMPTS; attempt += 1) {
      let result = null;
      try {
        result = await dockerExec(gatewayId, [
          'wget', '--server-response', '--output-document=/dev/null', '--timeout=2', url
        ], { timeoutMs: 5000, maxResponseBytes: 64 * 1024 });
      } catch { /* bounded retry */ }
      const candidate = await dockerRequest('GET', '/containers/' + state.candidate.containerId + '/json');
      const match = result && String(result.output || '').match(/HTTP\/1\.[01]\s+([0-9]{3})/i);
      const statusCode = match ? Number.parseInt(match[1], 10) : null;
      last = {
        healthy: Boolean(candidate.State && candidate.State.Running) &&
          Number.isInteger(statusCode) && statusCode >= health.acceptedStatusMinimum && statusCode <= health.acceptedStatusMaximum,
        statusCode,
        attempts: attempt,
        checkedAt: now()
      };
      if (last.healthy) return last;
      if (!candidate.State || candidate.State.Running !== true) break;
      await wait(DEFAULT_HEALTH_INTERVAL_MS);
    }
    throw new ProductionStatefulMigrationError('Candidate health check failed', 503, 'candidate-http-health-failed');
  }

  async function stageRoute({ plan, operationId }) {
    const state = getState(operationId);
    const staged = await ingressAuthority.stageRoutes(plan.executionContract.routes.map((route) => ({
      routeId: route.routeId,
      operationId,
      domain: route.domain,
      path: route.path,
      alias: state.candidate.alias,
      privatePort: route.upstreamPrivatePort
    })));
    state.routes = staged.map((route) => ({
      routeId: route.routeId, domain: route.domain, path: route.path,
      alias: route.alias, privatePort: route.privatePort
    }));
    persist(state);
    const primary = routeForHealth(staged, plan.executionContract.candidate.health);
    const probe = await ingressAuthority.httpsProbe({
      hostname: primary.domain,
      connectHost: 'foxos-gateway',
      port: 443,
      requestPath: plan.executionContract.candidate.health.path,
      expectedRouteId: primary.routeId
    });
    return {
      routeId: primary.routeId,
      domain: primary.domain,
      path: primary.path,
      staged: probe.expectedRoute === true,
      active: false,
      collisionFree: true,
      tlsReady: probe.tlsValid === true,
      routes: state.routes
    };
  }

  async function switchTraffic({ operationId }) {
    const state = getState(operationId);
    for (const domain of new Set(state.routes.map((route) => route.domain))) {
      await ingressAuthority.switchDomain(domain, 'foxos');
      if (!state.switchedDomains.includes(domain)) state.switchedDomains.push(domain);
      persist(state);
    }
    state.trafficSwitched = true;
    state.trafficSwitchedAt = now();
    persist(state);
    return { switched: true, providerDetached: false };
  }

  async function publicCandidateProof(plan, state, samples) {
    const primary = routeForHealth(state.routes, plan.executionContract.candidate.health);
    const connectHost = await ingressAuthority.hostIngressAddress();
    const probes = [];
    for (let index = 0; index < samples; index += 1) {
      try {
        probes.push(await ingressAuthority.httpsProbe({
          hostname: primary.domain,
          connectHost,
          requestPath: plan.executionContract.candidate.health.path,
          expectedRouteId: primary.routeId
        }));
      } catch (error) {
        probes.push({ error: error.code || 'probe-failed', tlsValid: false, expectedRoute: false });
      }
    }
    const unavailableSamples = probes.filter((probe) => (
      probe.tlsValid !== true || probe.expectedRoute !== true ||
      probe.statusCode < 200 || probe.statusCode >= 400 || probe.candidateIdentity !== state.operationId
    )).length;
    return {
      healthy: unavailableSamples === 0,
      tlsValid: probes.every((probe) => probe.tlsValid === true),
      candidateServing: probes.every((probe) => probe.expectedRoute === true && probe.candidateIdentity === state.operationId),
      unavailableSamples,
      probes: probes.length,
      checkedAt: now()
    };
  }

  async function verifyTraffic({ plan, operationId }) {
    return publicCandidateProof(plan, getState(operationId), 8);
  }

  async function parkSourceForRollback({ plan, operationId }) {
    const state = getState(operationId);
    const before = await publicCandidateProof(plan, state, 3);
    if (!before.healthy) throw new ProductionStatefulMigrationError('Candidate traffic failed before source parking', 503, 'candidate-not-ready-for-source-parking');
    let source = await dockerRequest('GET', '/containers/' + state.source.containerId + '/json');
    if (source.Image !== state.source.imageId || !source.State || source.State.Paused !== true) {
      throw new ProductionStatefulMigrationError('Paused rollback source identity changed', 409, 'rollback-source-drift');
    }
    await dockerRequest('POST', '/containers/' + state.source.containerId + '/unpause');
    state.source.paused = false;
    state.source.unpausedAt = now();
    persist(state);
    await dockerRequest('POST', '/containers/' + state.source.containerId + '/stop?t=10');
    source = await dockerRequest('GET', '/containers/' + state.source.containerId + '/json');
    if (source.State && source.State.Running === true) {
      throw new ProductionStatefulMigrationError('Rollback source did not stop', 503, 'rollback-source-stop-failed');
    }
    state.source.stopped = true;
    state.source.stoppedAt = now();
    state.source.pauseDurationMs = Math.max(0, Date.now() - state.source.pauseStartedAtMs);
    persist(state);
    const after = await publicCandidateProof(plan, state, 3);
    if (!after.healthy) throw new ProductionStatefulMigrationError('Candidate traffic failed after source parking', 503, 'candidate-failed-after-source-parking');
    return {
      sourceStopped: true,
      sourceContainerId: state.source.containerId,
      candidateServing: true,
      unavailableSamples: 0,
      pauseDurationMs: state.source.pauseDurationMs
    };
  }

  async function resumeSource({ operationId, requirePublicProof = false, plan = null }) {
    const state = getState(operationId);
    let source = await dockerRequest('GET', '/containers/' + state.source.containerId + '/json');
    if (source.Image !== state.source.imageId) throw new ProductionStatefulMigrationError('Rollback source identity changed', 409, 'rollback-source-drift');
    if (source.State && source.State.Paused) {
      await dockerRequest('POST', '/containers/' + state.source.containerId + '/unpause');
      state.source.paused = false;
    }
    source = await dockerRequest('GET', '/containers/' + state.source.containerId + '/json');
    if (!source.State || source.State.Running !== true) {
      await dockerRequest('POST', '/containers/' + state.source.containerId + '/start');
      state.source.stopped = false;
    }
    state.source.resumedAt = now();
    persist(state);
    if (requirePublicProof && plan) {
      for (const domain of new Set(state.routes.map((route) => route.domain))) {
        await ingressAuthority.verifyLegacyBackend({
          hostname: domain,
          requestPath: plan.executionContract.candidate.health.path,
          attempts: 80
        });
      }
    }
    return { sourceRunning: true, sourceContainerId: state.source.containerId };
  }

  async function rollbackTraffic({ plan, operationId }) {
    const state = getState(operationId);
    await resumeSource({ operationId, requirePublicProof: true, plan });
    for (const domain of new Set(state.routes.map((route) => route.domain))) {
      await ingressAuthority.switchDomain(domain, 'legacy');
    }
    state.switchedDomains = [];
    state.trafficSwitched = false;
    state.rolledBackAt = now();
    persist(state);
    return { restored: true, sourceContainerId: state.source.containerId };
  }

  async function verifyRollback({ plan, operationId }) {
    const state = getState(operationId);
    const primary = routeForHealth(state.routes, plan.executionContract.candidate.health);
    const connectHost = await ingressAuthority.hostIngressAddress();
    const probes = [];
    for (let index = 0; index < 5; index += 1) {
      try {
        probes.push(await ingressAuthority.httpsProbe({
          hostname: primary.domain,
          connectHost,
          requestPath: plan.executionContract.candidate.health.path
        }));
      } catch (error) {
        probes.push({ error: error.code || 'probe-failed', tlsValid: false, statusCode: 0 });
      }
    }
    const source = await dockerRequest('GET', '/containers/' + state.source.containerId + '/json');
    const unavailableSamples = probes.filter((probe) => (
      probe.tlsValid !== true || probe.statusCode < 200 || probe.statusCode >= 400 || probe.candidateIdentity === operationId
    )).length;
    return {
      sourceServing: Boolean(source.State && source.State.Running) && unavailableSamples === 0,
      trafficRestored: unavailableSamples === 0,
      candidateServing: false,
      unavailableSamples,
      checkedAt: now()
    };
  }

  async function cleanupStagedRoute({ operationId }) {
    const state = getState(operationId);
    if (state.routes.length) await ingressAuthority.removeRoutes(state.routes.map((route) => route.routeId));
    state.routesCleaned = true;
    persist(state);
    return { cleaned: true };
  }

  async function cleanupCandidate({ operationId }) {
    const state = getState(operationId);
    if (state.candidate && state.candidate.containerId) {
      try {
        const details = await dockerRequest('GET', '/containers/' + state.candidate.containerId + '/json');
        const labels = details.Config && details.Config.Labels || {};
        if (labels['com.foxos.stateful-migration.id'] !== operationId) {
          throw new ProductionStatefulMigrationError('Candidate cleanup ownership proof failed', 409, 'cleanup-target-mismatch');
        }
        if (details.State && details.State.Running) {
          await dockerRequest('POST', '/containers/' + state.candidate.containerId + '/stop?t=10');
        }
        await dockerRequest('DELETE', '/containers/' + state.candidate.containerId + '?force=0&v=0');
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    for (const volumeName of [...state.targetVolumes].reverse()) {
      try {
        const details = await dockerRequest('GET', '/volumes/' + encodeURIComponent(volumeName));
        if (!details.Labels || details.Labels['com.foxos.stateful-migration.id'] !== operationId) {
          throw new ProductionStatefulMigrationError('Volume cleanup ownership proof failed', 409, 'cleanup-target-mismatch');
        }
        await dockerRequest('DELETE', '/volumes/' + encodeURIComponent(volumeName));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    state.candidateCleaned = true;
    persist(state);
    return { cleaned: true };
  }

  ensureDirectory(operationsRoot);
  return {
    capabilities: {
      encryptedFinalSnapshot: true,
      namedVolumeRestore: true,
      boundedQuiesce: true,
      productionRouteCutover: true,
      automaticRollback: true,
      exactSourcePreserved: true,
      storageCapacityGate: true,
      providerDetach: false
    },
    cleanupCandidate,
    cleanupStagedRoute,
    createCandidate,
    getState,
    parkSourceForRollback,
    preflight,
    quiesceAndSnapshot,
    resumeSource,
    rollbackTraffic,
    stageRoute,
    switchTraffic,
    verifyCandidateHealth,
    verifyRollback,
    verifyTraffic
  };
}

module.exports = {
  MAX_DIRECT_STATEFUL_TRANSACTION_BYTES,
  PRODUCTION_STATEFUL_ADAPTER_SCHEMA_VERSION,
  ProductionStatefulMigrationError,
  createProductionStatefulMigrationAdapter,
  localImageReference,
  routeForHealth
};
