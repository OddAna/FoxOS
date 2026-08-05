const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const PRODUCTION_STATELESS_ADAPTER_SCHEMA_VERSION = 1;
const OPERATION_ID_PATTERN = /^smop_[a-f0-9]{32}$/;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HOSTNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/;
const SUPPORTED_DEPENDENCY_PROTOCOLS = new Map([
  ['postgres:', 5432],
  ['postgresql:', 5432],
  ['mysql:', 3306],
  ['mariadb:', 3306],
  ['redis:', 6379],
  ['mongodb:', 27017],
  ['http:', 80],
  ['https:', 443]
]);

class ProductionStatelessMigrationError extends Error {
  constructor(message, statusCode = 409, code = 'production-stateless-migration-error') {
    super(message);
    this.name = 'ProductionStatelessMigrationError';
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

function dependencyFromValue(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!SUPPORTED_DEPENDENCY_PROTOCOLS.has(parsed.protocol) || !HOSTNAME_PATTERN.test(parsed.hostname)) return null;
    const dependencyPort = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : SUPPORTED_DEPENDENCY_PROTOCOLS.get(parsed.protocol);
    if (!Number.isInteger(dependencyPort) || dependencyPort < 1 || dependencyPort > 65535) return null;
    return { hostname: parsed.hostname, port: dependencyPort, protocol: parsed.protocol };
  } catch {
    return null;
  }
}

function rewriteEnvironmentDependencies(entries, dependencies) {
  const aliases = new Map((dependencies || []).map((dependency) => [
    dependency.hostname + ':' + dependency.port,
    dependency.bridgeAlias
  ]));
  return (entries || []).map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) return entry;
    const rawValue = entry.slice(separator + 1);
    const dependency = dependencyFromValue(rawValue);
    if (!dependency) return entry;
    const alias = aliases.get(dependency.hostname + ':' + dependency.port);
    if (!alias || !HOSTNAME_PATTERN.test(alias)) return entry;
    const parsed = new URL(rawValue);
    parsed.hostname = alias;
    return entry.slice(0, separator + 1) + parsed.toString();
  });
}

function createProductionStatelessMigrationAdapter({
  dataRoot,
  dockerRequest,
  dockerExec,
  resourceRegistry,
  secretManager,
  certificateImporter,
  ingressAuthority,
  routingNetwork = 'foxos-routing',
  egressNetwork = 'foxos-egress',
  gatewayContainer = 'foxos-gateway',
  agentContainer = 'foxos',
  clock = () => new Date()
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerExec !== 'function' ||
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    !secretManager || typeof secretManager.resolveEnvironment !== 'function' ||
    !certificateImporter || typeof certificateImporter.importDomain !== 'function' ||
    !ingressAuthority || typeof ingressAuthority.stageRoutes !== 'function' ||
    typeof ingressAuthority.verifyLegacyDomain !== 'function'
  ) {
    throw new Error('Production stateless adapter requires Docker, registry, secrets, certificate and ingress adapters');
  }

  const root = path.join(dataRoot, 'production-stateless-adapter');
  const operationsRoot = path.join(root, 'operations');

  function now() {
    return new Date(clock()).toISOString();
  }

  function operationFile(operationId) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) {
      throw new ProductionStatelessMigrationError('Invalid production migration operation ID', 400, 'invalid-operation-id');
    }
    return path.join(operationsRoot, operationId + '.json');
  }

  function getState(operationId) {
    const value = readJson(operationFile(operationId));
    if (!value) throw new ProductionStatelessMigrationError('Production adapter state was not found', 404, 'adapter-state-not-found');
    return value;
  }

  function persist(value) {
    value.updatedAt = now();
    atomicWriteJson(operationFile(value.operationId), value);
    return value;
  }

  function currentResource(plan) {
    const snapshot = resourceRegistry.getLatest();
    if (!snapshot || snapshot.snapshotId !== plan.sourceSnapshotId) {
      throw new ProductionStatelessMigrationError('Registry snapshot changed after migration planning', 409, 'registry-snapshot-stale');
    }
    const resource = (snapshot.resources || []).find((entry) => entry.id === plan.resource.resourceId);
    if (!resource) throw new ProductionStatelessMigrationError('Selected source resource disappeared', 404, 'source-resource-not-found');
    return { snapshot, resource };
  }

  function routeProxy(snapshot, resource) {
    const relationship = (snapshot.relationships || []).find((entry) => (
      entry.type === 'route-through-proxy' && entry.sourceResourceId === resource.id && entry.targetResourceId
    ));
    const proxy = relationship && (snapshot.resources || []).find((entry) => entry.id === relationship.targetResourceId);
    if (!proxy || proxy.role !== 'proxy' || !proxy.runtime || !CONTAINER_ID_PATTERN.test(String(proxy.runtime.containerId || ''))) {
      throw new ProductionStatelessMigrationError(
        'The current public route proxy could not be identified safely',
        409,
        'legacy-route-proxy-unavailable'
      );
    }
    const sourceNetworks = new Set((resource.networks || []).map((network) => network.name));
    const sharedNetworks = (proxy.networks || []).map((network) => network.name)
      .filter((name) => sourceNetworks.has(name) && name !== routingNetwork).sort();
    if (!sharedNetworks.length) {
      throw new ProductionStatelessMigrationError(
        'The source and its legacy route proxy have no observed shared network',
        409,
        'legacy-route-network-unavailable'
      );
    }
    return { proxy, legacyNetwork: sharedNetworks[0] };
  }

  function environmentFor(plan) {
    const revision = secretManager.getEnvironmentRevision(plan.resource.resourceId);
    const expected = plan.executionContract && plan.executionContract.candidate &&
      plan.executionContract.candidate.environment && plan.executionContract.candidate.environment.revision;
    if (!revision || revision.revision !== expected) {
      throw new ProductionStatelessMigrationError('The encrypted environment revision is missing or stale', 409, 'environment-revision-stale');
    }
    const resolved = secretManager.resolveEnvironment(revision);
    const excluded = (revision.excluded || []).map((entry) => entry.name + '=');
    return { revision, resolved: [...resolved, ...excluded].sort() };
  }

  async function sourceProof(resource) {
    const source = await dockerRequest('GET', '/containers/' + resource.runtime.containerId + '/json');
    if (
      source.Id !== resource.runtime.containerId || source.Image !== resource.runtime.imageId ||
      !source.State || source.State.Running !== true
    ) {
      throw new ProductionStatelessMigrationError('Source identity or running state changed', 409, 'source-runtime-stale');
    }
    return source;
  }

  async function discoverDependencyTargets(source, environment) {
    const sourceNetworks = Object.keys(source.NetworkSettings && source.NetworkSettings.Networks || {}).sort();
    const observed = new Map();
    for (const entry of environment.resolved) {
      const separator = entry.indexOf('=');
      const dependency = dependencyFromValue(separator >= 0 ? entry.slice(separator + 1) : '');
      if (!dependency) continue;
      const key = dependency.hostname + ':' + dependency.port;
      observed.set(key, dependency);
    }
    const targets = [];
    for (const dependency of observed.values()) {
      let match = null;
      for (const networkName of sourceNetworks) {
        const network = await dockerRequest('GET', '/networks/' + encodeURIComponent(networkName));
        for (const [containerId, attachment] of Object.entries(network.Containers || {})) {
          const names = [attachment.Name, containerId, containerId.slice(0, 12)].filter(Boolean);
          if (names.includes(dependency.hostname)) {
            match = { ...dependency, containerId, targetName: attachment.Name, legacyNetwork: networkName };
            break;
          }
        }
        if (match) break;
      }
      if (match) targets.push(match);
    }
    const hostCounts = new Map();
    for (const target of targets) hostCounts.set(target.hostname, (hostCounts.get(target.hostname) || 0) + 1);
    if ([...hostCounts.values()].some((count) => count > 1)) {
      throw new ProductionStatelessMigrationError(
        'A single dependency hostname exposes multiple required ports; group migration support is required',
        409,
        'multi-port-dependency-bridge-unsupported'
      );
    }
    return targets.sort((left, right) => left.hostname.localeCompare(right.hostname));
  }

  async function preflight({ plan, operationId }) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) {
      throw new ProductionStatelessMigrationError('Invalid operation identity', 400, 'invalid-operation-id');
    }
    const { snapshot, resource } = currentResource(plan);
    if (
      !RESOURCE_ID_PATTERN.test(resource.id) || !IMAGE_ID_PATTERN.test(String(resource.runtime.imageId || '')) ||
      !plan.executionContract || plan.executionContract.source.imageId !== resource.runtime.imageId
    ) {
      throw new ProductionStatelessMigrationError('The local image execution contract is invalid', 409, 'local-image-contract-invalid');
    }
    const source = await sourceProof(resource);
    const environment = environmentFor(plan);
    const proxy = routeProxy(snapshot, resource);
    await ingressAuthority.inspectOwnedInfrastructure();
    const egress = await dockerRequest('GET', '/networks/' + encodeURIComponent(egressNetwork));
    if (
      !egress || !egress.Labels || egress.Labels['com.foxos.core'] !== 'true' ||
      egress.Labels['com.foxos.egress'] !== 'true' || egress.Internal === true
    ) {
      throw new ProductionStatelessMigrationError(
        'FoxOS candidate egress network is unavailable or not owned',
        503,
        'foxos-egress-unavailable'
      );
    }
    const sourcePublic = await ingressAuthority.httpsProbe({
      hostname: plan.executionContract.routes[0].domain,
      requestPath: plan.executionContract.routes[0].path
    });
    const routeCollision = (snapshot.conflicts || []).some((entry) => (
      entry.severity === 'blocking' && entry.type === 'domain-route' && (entry.resourceIds || []).includes(resource.id)
    ));
    const dependencies = await discoverDependencyTargets(source, environment);
    const adapterState = {
      schemaVersion: PRODUCTION_STATELESS_ADAPTER_SCHEMA_VERSION,
      operationId,
      planId: plan.planId,
      resourceId: resource.id,
      source: {
        containerId: source.Id,
        imageId: source.Image,
        continuouslyRunning: true,
        stopped: false,
        recreated: false
      },
      environmentRevision: environment.revision.revision,
      proxy: {
        containerId: proxy.proxy.runtime.containerId,
        legacyNetwork: proxy.legacyNetwork
      },
      dependencies: dependencies.map((entry) => ({
        hostname: entry.hostname,
        port: entry.port,
        protocol: entry.protocol,
        containerId: entry.containerId,
        targetName: entry.targetName,
        legacyNetwork: entry.legacyNetwork,
        bridgeContainerId: null
      })),
      candidate: null,
      routes: [],
      createdAt: now()
    };
    persist(adapterState);
    return {
      evidenceFingerprint: plan.resource.evidenceFingerprint,
      sourceHealthy: sourcePublic.tlsValid === true && sourcePublic.statusCode >= 200 && sourcePublic.statusCode < 400,
      sourceContinuouslyRunning: true,
      routeCollisionFree: !routeCollision,
      dependencyBridgesPlanned: dependencies.length,
      providerStateMutated: false
    };
  }

  async function removeOwnedContainer(containerId, operationId, temporaryKind) {
    if (!CONTAINER_ID_PATTERN.test(String(containerId || ''))) return;
    let details;
    try {
      details = await dockerRequest('GET', '/containers/' + containerId + '/json');
    } catch (error) {
      if (/No such container/i.test(String(error.message || ''))) return;
      throw error;
    }
    const labels = details.Config && details.Config.Labels || {};
    if (
      labels['com.foxos.stateless-migration.id'] !== operationId ||
      labels['com.foxos.temporary'] !== temporaryKind
    ) {
      throw new ProductionStatelessMigrationError('Cleanup target ownership proof failed', 409, 'cleanup-target-mismatch');
    }
    if (details.State && details.State.Running) {
      await dockerRequest('POST', '/containers/' + containerId + '/stop?t=10');
    }
    await dockerRequest('DELETE', '/containers/' + containerId + '?v=1&force=0');
  }

  async function createDependencyBridge(operationId, dependency, agentImageId) {
    const bridgeAlias = 'foxos-dep-' + operationId.slice(-12) + '-' + crypto.createHash('sha256')
      .update(dependency.hostname + ':' + dependency.port).digest('hex').slice(0, 8);
    const name = 'foxos-dependency-' + operationId.slice(-12) + '-' + crypto.createHash('sha256')
      .update(dependency.hostname + ':' + dependency.port).digest('hex').slice(0, 8);
    const created = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(name), {
      Image: agentImageId,
      Entrypoint: ['node', '/app/tcpBridge.js'],
      Cmd: [],
      Env: [
        'TARGET_HOST=' + dependency.targetName,
        'TARGET_PORT=' + dependency.port,
        'LISTEN_PORT=' + dependency.port
      ],
      Labels: {
        'com.foxos.managed': 'true',
        'com.foxos.temporary': 'stateless-dependency-bridge',
        'com.foxos.stateless-migration.id': operationId
      },
      ExposedPorts: { [dependency.port + '/tcp']: {} },
      HostConfig: {
        NetworkMode: dependency.legacyNetwork,
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 64 * 1024 * 1024,
        NanoCpus: 250000000,
        PidsLimit: 64
      }
    });
    await dockerRequest('POST', '/networks/' + encodeURIComponent(routingNetwork) + '/connect', {
      Container: created.Id,
      EndpointConfig: { Aliases: [bridgeAlias] }
    });
    await dockerRequest('POST', '/containers/' + created.Id + '/start');
    const details = await dockerRequest('GET', '/containers/' + created.Id + '/json');
    if (!details.State || details.State.Running !== true) {
      throw new ProductionStatelessMigrationError('Dependency bridge did not start', 503, 'dependency-bridge-start-failed');
    }
    return { containerId: created.Id, bridgeAlias };
  }

  async function observedProcessArgv(containerId) {
    try {
      const result = await dockerExec(containerId, ['cat', '/proc/1/cmdline'], {
        timeoutMs: 5000,
        maxResponseBytes: 128 * 1024
      });
      if (result.exitCode !== 0) return null;
      const argv = String(result.output || '').split('\0').filter(Boolean);
      if (
        argv.length < 1 || argv.length > 32 ||
        argv.some((entry) => !entry || entry.length > 4096 || /[\r\n]/.test(entry))
      ) return null;
      return argv;
    } catch {
      return null;
    }
  }

  async function createCandidate({ plan, operationId }) {
    const adapterState = getState(operationId);
    const { resource } = currentResource(plan);
    await sourceProof(resource);
    const environment = environmentFor(plan);
    const agent = await dockerRequest('GET', '/containers/' + encodeURIComponent(agentContainer) + '/json');
    if (!IMAGE_ID_PATTERN.test(String(agent.Image || ''))) {
      throw new ProductionStatelessMigrationError('FoxOS agent image identity is unavailable', 503, 'agent-image-unavailable');
    }
    const createdBridges = [];
    let candidateId = null;
    try {
      for (const dependency of adapterState.dependencies) {
        const bridge = await createDependencyBridge(operationId, dependency, agent.Image);
        dependency.bridgeContainerId = bridge.containerId;
        dependency.bridgeAlias = bridge.bridgeAlias;
        createdBridges.push(dependency.bridgeContainerId);
        persist(adapterState);
      }
      const localTag = 'foxos.local/' + resource.id;
      await dockerRequest(
        'POST',
        '/images/' + encodeURIComponent(resource.runtime.imageId) + '/tag?repo=' +
          encodeURIComponent(localTag) + '&tag=' + resource.runtime.imageId.slice(7, 19)
      );
      const contract = plan.executionContract.candidate;
      const runningArgv = await observedProcessArgv(resource.runtime.containerId);
      const alias = 'foxos-sm-' + operationId.slice(-24);
      const name = 'foxos-stateless-' + operationId.slice(-20);
      const exposedPorts = Object.fromEntries(contract.ingressPorts.map((port) => [port + '/tcp', {}]));
      const candidateEnvironment = rewriteEnvironmentDependencies(environment.resolved, adapterState.dependencies);
      const created = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(name), {
        Image: resource.runtime.imageId,
        ...(runningArgv ? { Entrypoint: runningArgv, Cmd: [] } : {}),
        ...(contract.runtime.user ? { User: contract.runtime.user } : {}),
        Env: candidateEnvironment,
        Labels: {
          'com.foxos.managed': 'true',
          'com.foxos.temporary': 'stateless-migration-candidate',
          'com.foxos.migration.source-resource-id': resource.id,
          'com.foxos.stateless-migration.id': operationId,
          'com.foxos.source.container': resource.runtime.containerId
        },
        ExposedPorts: exposedPorts,
        HostConfig: {
          NetworkMode: routingNetwork,
          RestartPolicy: { Name: contract.runtime.restartPolicy, MaximumRetryCount: 0 },
          ReadonlyRootfs: contract.runtime.readOnlyRootFilesystem === true,
          Privileged: false,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Memory: contract.runtime.memoryBytes,
          NanoCpus: contract.runtime.nanoCpus,
          PidsLimit: contract.runtime.pidsLimit
        },
        NetworkingConfig: {
          EndpointsConfig: { [routingNetwork]: { Aliases: [alias] } }
        }
      });
      candidateId = created.Id;
      await dockerRequest('POST', '/networks/' + encodeURIComponent(egressNetwork) + '/connect', {
        Container: created.Id,
        EndpointConfig: {}
      });
      await dockerRequest('POST', '/containers/' + created.Id + '/start');
      const candidate = await dockerRequest('GET', '/containers/' + created.Id + '/json');
      if (!candidate.State || candidate.State.Running !== true || candidate.Image !== resource.runtime.imageId) {
        throw new ProductionStatelessMigrationError('Candidate runtime identity proof failed', 503, 'candidate-runtime-proof-failed');
      }
      adapterState.candidate = {
        containerId: candidate.Id,
        alias,
        imageId: candidate.Image,
        privatePort: contract.health.privatePort,
        createdAt: now()
      };
      persist(adapterState);
      return {
        candidateId: operationId,
        containerId: candidate.Id,
        networkId: routingNetwork,
        networkName: routingNetwork,
        revisionId: plan.executionContract.contractId,
        imageId: candidate.Image,
        imageDigest: resource.runtime.imageId,
        privatePort: contract.health.privatePort,
        owned: true,
        separateFromSource: candidate.Id !== resource.runtime.containerId,
        sourceTouched: false
      };
    } catch (error) {
      if (candidateId) {
        try { await removeOwnedContainer(candidateId, operationId, 'stateless-migration-candidate'); } catch { /* retain original error */ }
      }
      for (const bridgeId of createdBridges.reverse()) {
        try { await removeOwnedContainer(bridgeId, operationId, 'stateless-dependency-bridge'); } catch { /* retain original error */ }
      }
      throw error;
    }
  }

  async function probeCandidate(plan, adapterState) {
    const health = plan.executionContract.candidate.health;
    const url = 'http://' + adapterState.candidate.alias + ':' + health.privatePort + health.path;
    const result = await dockerExec(gatewayContainer, [
      'wget', '--quiet', '--server-response', '--output-document=/dev/null', '--timeout=10', url
    ], { timeoutMs: 15000, maxResponseBytes: 64 * 1024 });
    const candidate = await dockerRequest('GET', '/containers/' + adapterState.candidate.containerId + '/json');
    return {
      healthy: result.exitCode === 0 && candidate.State && candidate.State.Running === true,
      status: result.exitCode === 0 ? 'http-accepted' : 'http-rejected',
      identity: adapterState.operationId,
      checkedAt: now()
    };
  }

  async function verifyCandidateHealth({ plan, operationId }) {
    const adapterState = getState(operationId);
    if (!adapterState.candidate) {
      throw new ProductionStatelessMigrationError('Candidate state is missing', 409, 'candidate-state-missing');
    }
    const proof = await probeCandidate(plan, adapterState);
    if (!proof.healthy) {
      throw new ProductionStatelessMigrationError('Candidate HTTP health check failed', 503, 'candidate-http-health-failed');
    }
    return proof;
  }

  async function stageRoute({ plan, operationId }) {
    const adapterState = getState(operationId);
    const source = await dockerRequest('GET', '/containers/' + adapterState.source.containerId + '/json');
    await ingressAuthority.ensureLegacyBridge({
      proxyContainerId: adapterState.proxy.containerId,
      legacyNetwork: adapterState.proxy.legacyNetwork
    });
    for (const route of plan.executionContract.routes) {
      await ingressAuthority.verifyLegacyDomain({
        hostname: route.domain,
        requestPath: route.path
      });
    }
    for (const route of plan.executionContract.routes) {
      await certificateImporter.importDomain({
        domain: route.domain,
        proxyContainerId: adapterState.proxy.containerId
      });
    }
    const staged = await ingressAuthority.stageRoutes(plan.executionContract.routes.map((route) => ({
      routeId: route.routeId,
      operationId,
      domain: route.domain,
      path: route.path,
      alias: adapterState.candidate.alias,
      privatePort: route.upstreamPrivatePort
    })));
    adapterState.routes = staged.map((route) => ({
      routeId: route.routeId,
      domain: route.domain,
      path: route.path,
      alias: route.alias,
      privatePort: route.privatePort
    }));
    persist(adapterState);
    const primary = staged[0];
    const stagedProbe = await ingressAuthority.httpsProbe({
      hostname: primary.domain,
      connectHost: 'foxos-gateway',
      port: 443,
      requestPath: primary.path,
      expectedRouteId: primary.routeId
    });
    return {
      routeId: primary.routeId,
      routeRevision: plan.executionContract.contractId,
      domain: primary.domain,
      path: primary.path,
      alias: primary.alias,
      staged: stagedProbe.expectedRoute === true,
      active: false,
      collisionFree: true,
      tlsReady: stagedProbe.tlsValid === true,
      sourceStillServing: Boolean(source.State && source.State.Running)
    };
  }

  async function switchTraffic({ operationId }) {
    const adapterState = getState(operationId);
    for (const domain of new Set(adapterState.routes.map((route) => route.domain))) {
      await ingressAuthority.switchDomain(domain, 'foxos');
    }
    const source = await dockerRequest('GET', '/containers/' + adapterState.source.containerId + '/json');
    return {
      switched: true,
      sourceStopped: !(source.State && source.State.Running),
      sourceRecreated: source.Id !== adapterState.source.containerId,
      providerDetached: false
    };
  }

  async function verifyTraffic({ operationId }) {
    const adapterState = getState(operationId);
    const primary = adapterState.routes[0];
    const probes = [];
    for (let index = 0; index < 8; index += 1) {
      try {
        probes.push(await ingressAuthority.httpsProbe({
          hostname: primary.domain,
          requestPath: primary.path,
          expectedRouteId: primary.routeId
        }));
      } catch (error) {
        probes.push({ error: error.code || 'probe-failed', tlsValid: false, expectedRoute: false });
      }
    }
    const source = await dockerRequest('GET', '/containers/' + adapterState.source.containerId + '/json');
    const unavailableSamples = probes.filter((probe) => (
      !probe.tlsValid || !probe.expectedRoute || probe.statusCode < 200 || probe.statusCode >= 400 ||
      probe.candidateIdentity !== operationId
    )).length;
    return {
      healthy: unavailableSamples === 0,
      tlsValid: probes.every((probe) => probe.tlsValid === true),
      candidateServing: probes.every((probe) => (
        probe.expectedRoute === true && probe.candidateIdentity === operationId
      )),
      sourceContinuouslyRunning: Boolean(source.State && source.State.Running),
      unavailableSamples,
      probes: probes.length,
      checkedAt: now(),
      candidateIdentity: operationId
    };
  }

  async function rollbackTraffic({ operationId }) {
    const adapterState = getState(operationId);
    for (const domain of new Set(adapterState.routes.map((route) => route.domain))) {
      await ingressAuthority.switchDomain(domain, 'legacy');
    }
    return { restored: true, sourceContainerId: adapterState.source.containerId };
  }

  async function verifyRollback({ operationId }) {
    const adapterState = getState(operationId);
    const primary = adapterState.routes[0];
    const probes = [];
    for (let index = 0; index < 5; index += 1) {
      try {
        probes.push(await ingressAuthority.httpsProbe({ hostname: primary.domain, requestPath: primary.path }));
      } catch (error) {
        probes.push({ error: error.code || 'probe-failed', tlsValid: false, statusCode: 0 });
      }
    }
    const source = await dockerRequest('GET', '/containers/' + adapterState.source.containerId + '/json');
    const unavailableSamples = probes.filter((probe) => (
      !probe.tlsValid || probe.statusCode < 200 || probe.statusCode >= 400 || probe.candidateIdentity === operationId
    )).length;
    return {
      sourceServing: Boolean(source.State && source.State.Running) && unavailableSamples === 0,
      trafficRestored: unavailableSamples === 0,
      candidateServing: false,
      unavailableSamples,
      probes: probes.length,
      checkedAt: now()
    };
  }

  async function cleanupCandidate({ operationId }) {
    const adapterState = getState(operationId);
    if (adapterState.candidate) {
      await removeOwnedContainer(adapterState.candidate.containerId, operationId, 'stateless-migration-candidate');
      adapterState.candidate.cleaned = true;
    }
    for (const dependency of [...adapterState.dependencies].reverse()) {
      if (dependency.bridgeContainerId) {
        await removeOwnedContainer(dependency.bridgeContainerId, operationId, 'stateless-dependency-bridge');
        dependency.cleaned = true;
      }
    }
    persist(adapterState);
    return { cleaned: true };
  }

  async function cleanupStagedRoute({ operationId }) {
    const adapterState = getState(operationId);
    await ingressAuthority.removeRoutes(adapterState.routes.map((route) => route.routeId));
    adapterState.routesCleaned = true;
    persist(adapterState);
    return { cleaned: true };
  }

  ensureDirectory(operationsRoot);
  return {
    capabilities: {
      candidateRuntime: true,
      healthProof: true,
      stagedRouteTls: true,
      atomicTrafficSwitch: true,
      trafficProbe: true,
      rollback: true,
      sourcePreserved: true,
      providerDetach: false,
      sourceStop: false,
      sourceRecreation: false
    },
    cleanupCandidate,
    cleanupStagedRoute,
    createCandidate,
    paths: { root, operationsRoot },
    preflight,
    rollbackTraffic,
    stageRoute,
    switchTraffic,
    verifyCandidateHealth,
    verifyRollback,
    verifyTraffic
  };
}

module.exports = {
  PRODUCTION_STATELESS_ADAPTER_SCHEMA_VERSION,
  ProductionStatelessMigrationError,
  createProductionStatelessMigrationAdapter,
  dependencyFromValue,
  rewriteEnvironmentDependencies
};
