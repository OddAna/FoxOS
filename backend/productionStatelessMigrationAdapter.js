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
const EXECUTABLE_PATTERN = /^(?:\/[a-zA-Z0-9._+/@-]+|[a-zA-Z0-9._+-]+)$/;
const DEFAULT_CANDIDATE_HEALTH_ATTEMPTS = 60;
const DEFAULT_CANDIDATE_HEALTH_INTERVAL_MS = 500;
const DEFAULT_CANDIDATE_HEALTH_TIMEOUT_MS = 30000;
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

function safeContainerPath(value) {
  const candidate = String(value || '');
  return candidate.startsWith('/') && candidate.length <= 4096 &&
    !candidate.includes('\0') && !/[\r\n]/.test(candidate) &&
    !candidate.split('/').includes('..');
}

function startupContractFromObservation({
  argv,
  argvExecutable = false,
  executablePath,
  workingDirectory,
  nextStandaloneServer = false
} = {}) {
  const normalizedArgv = Array.isArray(argv) ? argv.map(String) : [];
  if (
    argvExecutable === true && normalizedArgv.length >= 1 && normalizedArgv.length <= 32 &&
    EXECUTABLE_PATTERN.test(normalizedArgv[0]) &&
    normalizedArgv.every((entry) => entry && entry.length <= 4096 && !/[\r\n\0]/.test(entry)) &&
    safeContainerPath(workingDirectory)
  ) {
    return {
      kind: 'observed-process-argv',
      entrypoint: normalizedArgv,
      cmd: [],
      workingDirectory
    };
  }
  if (
    normalizedArgv.length === 1 && /^next-server \(v[^)]+\)$/.test(normalizedArgv[0]) &&
    nextStandaloneServer === true && safeContainerPath(executablePath) &&
    safeContainerPath(workingDirectory)
  ) {
    return {
      kind: 'next-standalone-runtime',
      entrypoint: [executablePath, 'server.js'],
      cmd: [],
      workingDirectory
    };
  }
  return null;
}

function boundedArgumentList(value, { executableFirst = false } = {}) {
  if (!Array.isArray(value) || value.length > 32) return null;
  const normalized = value.map(String);
  if (
    normalized.some((entry) => !entry || entry.length > 4096 || /[\r\n\0]/.test(entry)) ||
    (executableFirst && normalized.length > 0 && !EXECUTABLE_PATTERN.test(normalized[0]))
  ) {
    return null;
  }
  return normalized;
}

function sameArgumentList(left, right) {
  const normalizedLeft = Array.isArray(left) ? left.map(String) : [];
  const normalizedRight = Array.isArray(right) ? right.map(String) : [];
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

function startupContractFromImageDefaults({ sourceConfig, imageConfig } = {}) {
  if (!sourceConfig || !imageConfig) return null;
  const sourceEntrypoint = Array.isArray(sourceConfig.Entrypoint) ? sourceConfig.Entrypoint : [];
  const imageEntrypoint = Array.isArray(imageConfig.Entrypoint) ? imageConfig.Entrypoint : [];
  const sourceCmd = Array.isArray(sourceConfig.Cmd) ? sourceConfig.Cmd : [];
  const imageCmd = Array.isArray(imageConfig.Cmd) ? imageConfig.Cmd : [];
  const imageWorkingDirectory = String(imageConfig.WorkingDir || '');
  const workingDirectory = imageWorkingDirectory || '/';
  const sourceUser = String(sourceConfig.User || '');
  const imageUser = String(imageConfig.User || '');
  if (
    !sameArgumentList(sourceEntrypoint, imageEntrypoint) ||
    !sameArgumentList(sourceCmd, imageCmd) ||
    String(sourceConfig.WorkingDir || '') !== imageWorkingDirectory ||
    sourceUser !== imageUser ||
    !safeContainerPath(workingDirectory) ||
    sourceEntrypoint.length + sourceCmd.length < 1 ||
    sourceEntrypoint.length + sourceCmd.length > 32
  ) {
    return null;
  }
  const entrypoint = boundedArgumentList(imageEntrypoint, { executableFirst: imageEntrypoint.length > 0 });
  const cmd = boundedArgumentList(imageCmd, { executableFirst: imageEntrypoint.length === 0 });
  if (!entrypoint || !cmd) return null;
  return {
    kind: 'immutable-image-defaults',
    entrypoint,
    cmd,
    workingDirectory
  };
}

function immutableImageFallbackAllowed({ image, imageId, dependencies, runtime, sourceConfig } = {}) {
  return Boolean(
    image && image.Id === imageId &&
    Array.isArray(dependencies) && dependencies.length === 0 &&
    runtime && runtime.writableMounts === 0 &&
    String(runtime.user || '') === String(sourceConfig && sourceConfig.User || '')
  );
}

function capabilityProfileForStartup({ startup, runtime, privatePort } = {}) {
  if (!startup || startup.kind !== 'immutable-image-defaults' || !runtime) {
    return { name: 'capability-free', capabilities: [] };
  }
  const rootBootstrap = !String(runtime.user || '');
  const lowPort = Number.isInteger(privatePort) && privatePort > 0 && privatePort < 1024;
  const capabilities = rootBootstrap ? ['CHOWN', 'SETGID', 'SETUID'] : [];
  if (lowPort) {
    capabilities.push('NET_BIND_SERVICE');
  }
  return {
    name: rootBootstrap
      ? 'immutable-image-local-bootstrap-v1'
      : lowPort ? 'immutable-image-low-port-v1' : 'capability-free',
    capabilities
  };
}

function environmentForStartup(entries, startup) {
  const environment = [...(entries || [])];
  if (startup && startup.kind === 'next-standalone-runtime') {
    return [
      ...environment.filter((entry) => !String(entry).startsWith('HOSTNAME=')),
      'HOSTNAME=0.0.0.0'
    ];
  }
  return environment;
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
  candidateHealthAttempts = DEFAULT_CANDIDATE_HEALTH_ATTEMPTS,
  candidateHealthIntervalMs = DEFAULT_CANDIDATE_HEALTH_INTERVAL_MS,
  candidateHealthTimeoutMs = DEFAULT_CANDIDATE_HEALTH_TIMEOUT_MS,
  healthClock = () => Date.now(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clock = () => new Date()
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerExec !== 'function' ||
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    !secretManager || typeof secretManager.resolveEnvironment !== 'function' ||
    !certificateImporter || typeof certificateImporter.importDomain !== 'function' ||
    !ingressAuthority || typeof ingressAuthority.stageRoutes !== 'function' ||
    typeof ingressAuthority.hostIngressAddress !== 'function' ||
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

  async function observedProcessContract(containerId) {
    try {
      const options = { timeoutMs: 5000, maxResponseBytes: 128 * 1024 };
      const [cmdline, executable, workingDirectory, nextStandalone] = await Promise.all([
        dockerExec(containerId, ['cat', '/proc/1/cmdline'], options),
        dockerExec(containerId, ['readlink', '/proc/1/exe'], options),
        dockerExec(containerId, ['readlink', '/proc/1/cwd'], options),
        dockerExec(containerId, ['test', '-f', '/proc/1/cwd/server.js'], options)
      ]);
      if (cmdline.exitCode !== 0 || executable.exitCode !== 0 || workingDirectory.exitCode !== 0) return null;
      const argv = String(cmdline.output || '').split('\0').filter(Boolean);
      let argvExecutable = false;
      if (argv.length && EXECUTABLE_PATTERN.test(argv[0])) {
        const executableProbe = await dockerExec(containerId, [
          'sh', '-c', 'command -v "$1" >/dev/null 2>&1 || [ -x "$1" ]',
          'foxos-startup-probe', argv[0]
        ], options);
        argvExecutable = executableProbe.exitCode === 0;
      }
      return startupContractFromObservation({
        argv,
        argvExecutable,
        executablePath: String(executable.output || '').trim(),
        workingDirectory: String(workingDirectory.output || '').trim(),
        nextStandaloneServer: nextStandalone.exitCode === 0
      });
    } catch {
      return null;
    }
  }

  async function createCandidate({ plan, operationId }) {
    const adapterState = getState(operationId);
    const { resource } = currentResource(plan);
    const source = await sourceProof(resource);
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
      let startup = await observedProcessContract(resource.runtime.containerId);
      if (!startup) {
        const image = await dockerRequest(
          'GET',
          '/images/' + encodeURIComponent(resource.runtime.imageId) + '/json'
        );
        const imageDefaultFallbackAllowed = immutableImageFallbackAllowed({
          image,
          imageId: resource.runtime.imageId,
          dependencies: adapterState.dependencies,
          runtime: contract.runtime,
          sourceConfig: source.Config
        });
        startup = imageDefaultFallbackAllowed
          ? startupContractFromImageDefaults({
              sourceConfig: source.Config,
              imageConfig: image.Config
            })
          : null;
      }
      if (!startup) {
        throw new ProductionStatelessMigrationError(
          'A safe provider-neutral candidate startup contract could not be reconstructed',
          409,
          'candidate-startup-contract-unsupported'
        );
      }
      const alias = 'foxos-sm-' + operationId.slice(-24);
      const name = 'foxos-stateless-' + operationId.slice(-20);
      const exposedPorts = Object.fromEntries(contract.ingressPorts.map((port) => [port + '/tcp', {}]));
      const candidateEnvironment = environmentForStartup(
        rewriteEnvironmentDependencies(environment.resolved, adapterState.dependencies),
        startup
      );
      const capabilityProfile = capabilityProfileForStartup({
        startup,
        runtime: contract.runtime,
        privatePort: contract.health.privatePort
      });
      const created = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(name), {
        Image: resource.runtime.imageId,
        Entrypoint: startup.entrypoint,
        Cmd: startup.cmd,
        WorkingDir: startup.workingDirectory,
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
          ...(capabilityProfile.capabilities.length ? { CapAdd: capabilityProfile.capabilities } : {}),
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
        adapterState.candidateAttempt = {
          startupKind: startup.kind,
          exitCode: candidate.State && Number.isInteger(candidate.State.ExitCode) ? candidate.State.ExitCode : null,
          oomKilled: Boolean(candidate.State && candidate.State.OOMKilled),
          running: Boolean(candidate.State && candidate.State.Running)
        };
        persist(adapterState);
        throw new ProductionStatelessMigrationError(
          'Candidate process exited before runtime identity proof completed',
          503,
          'candidate-runtime-proof-failed'
        );
      }
      adapterState.candidate = {
        containerId: candidate.Id,
        alias,
        imageId: candidate.Image,
        privatePort: contract.health.privatePort,
        startupKind: startup.kind,
        capabilityProfile: capabilityProfile.name,
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
      const failure = error instanceof ProductionStatelessMigrationError
        ? error
        : new ProductionStatelessMigrationError(
            'Docker rejected the FoxOS candidate startup transaction',
            503,
            'candidate-docker-start-failed'
          );
      adapterState.failure = {
        phase: 'candidate-create',
        code: failure.code,
        message: failure.message,
        recordedAt: now()
      };
      try { persist(adapterState); } catch { /* preserve the original bounded failure */ }
      if (candidateId) {
        try { await removeOwnedContainer(candidateId, operationId, 'stateless-migration-candidate'); } catch { /* retain original error */ }
      }
      for (const bridgeId of createdBridges.reverse()) {
        try { await removeOwnedContainer(bridgeId, operationId, 'stateless-dependency-bridge'); } catch { /* retain original error */ }
      }
      throw failure;
    }
  }

  async function probeCandidate(plan, adapterState) {
    const health = plan.executionContract.candidate.health;
    const url = 'http://' + adapterState.candidate.alias + ':' + health.privatePort + health.path;
    let gatewayContainerId = null;
    try {
      const infrastructure = await ingressAuthority.inspectOwnedInfrastructure();
      gatewayContainerId = infrastructure && infrastructure.gateway && infrastructure.gateway.Id;
    } catch (error) {
      throw new ProductionStatelessMigrationError(
        'FoxOS routing gateway could not be inspected before candidate health',
        503,
        error && error.code || 'foxos-gateway-inspection-failed'
      );
    }
    if (!CONTAINER_ID_PATTERN.test(String(gatewayContainerId || ''))) {
      throw new ProductionStatelessMigrationError(
        'FoxOS routing gateway did not resolve to an exact container identity',
        503,
        'foxos-gateway-identity-invalid'
      );
    }
    const attempts = Number.isInteger(candidateHealthAttempts) && candidateHealthAttempts > 0
      ? Math.min(candidateHealthAttempts, 120)
      : DEFAULT_CANDIDATE_HEALTH_ATTEMPTS;
    const intervalMs = Number.isInteger(candidateHealthIntervalMs) && candidateHealthIntervalMs >= 0
      ? Math.min(candidateHealthIntervalMs, 5000)
      : DEFAULT_CANDIDATE_HEALTH_INTERVAL_MS;
    const timeoutMs = Number.isInteger(candidateHealthTimeoutMs) && candidateHealthTimeoutMs > 0
      ? Math.min(candidateHealthTimeoutMs, 120000)
      : DEFAULT_CANDIDATE_HEALTH_TIMEOUT_MS;
    const deadline = healthClock() + timeoutMs;
    let proof = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1 && healthClock() >= deadline) return proof;
      const remainingMs = Math.max(1, deadline - healthClock());
      let result = null;
      let probeUnavailable = false;
      try {
        result = await dockerExec(gatewayContainerId, [
          'wget', '--server-response', '--output-document=/dev/null',
          '--timeout=' + Math.max(1, Math.min(2, Math.ceil(remainingMs / 1000))), url
        ], {
          timeoutMs: Math.max(1000, Math.min(5000, remainingMs + 500)),
          maxResponseBytes: 64 * 1024
        });
      } catch {
        probeUnavailable = true;
      }
      const candidate = await dockerRequest(
        'GET',
        '/containers/' + adapterState.candidate.containerId + '/json'
      );
      const state = candidate.State || {};
      const statusMatch = result && String(result.output || '').match(/HTTP\/1\.[01]\s+([0-9]{3})/i);
      const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;
      const accepted = Number.isInteger(statusCode) &&
        statusCode >= health.acceptedStatusMinimum && statusCode <= health.acceptedStatusMaximum;
      proof = {
        healthy: accepted && state.Running === true,
        status: accepted ? 'http-accepted' : probeUnavailable ? 'probe-unavailable' : 'http-rejected',
        statusCode,
        attempts: attempt,
        execExitCode: result && Number.isInteger(result.exitCode) ? result.exitCode : null,
        candidateRunning: state.Running === true,
        candidateExitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
        candidateOomKilled: Boolean(state.OOMKilled),
        identity: adapterState.operationId,
        checkedAt: now()
      };
      if (
        proof.healthy || state.Running !== true || attempt === attempts ||
        healthClock() >= deadline
      ) return proof;
      await wait(Math.min(intervalMs, Math.max(0, deadline - healthClock())));
    }
    return proof;
  }

  async function verifyCandidateHealth({ plan, operationId }) {
    const adapterState = getState(operationId);
    if (!adapterState.candidate) {
      throw new ProductionStatelessMigrationError('Candidate state is missing', 409, 'candidate-state-missing');
    }
    let proof;
    try {
      proof = await probeCandidate(plan, adapterState);
    } catch (error) {
      const failure = error instanceof ProductionStatelessMigrationError
        ? error
        : new ProductionStatelessMigrationError(
          'Candidate HTTP health probe could not be completed',
          503,
          'candidate-health-probe-failed'
        );
      adapterState.failure = {
        phase: 'candidate-health',
        code: failure.code,
        message: failure.message,
        recordedAt: now()
      };
      persist(adapterState);
      throw failure;
    }
    adapterState.candidateAttempt = {
      phase: 'candidate-health',
      attempts: proof && proof.attempts || 0,
      statusCode: proof && proof.statusCode || null,
      execExitCode: proof && proof.execExitCode,
      running: Boolean(proof && proof.candidateRunning),
      exitCode: proof && proof.candidateExitCode,
      oomKilled: Boolean(proof && proof.candidateOomKilled),
      healthy: Boolean(proof && proof.healthy),
      checkedAt: proof && proof.checkedAt || now()
    };
    if (!proof.healthy) {
      const failure = new ProductionStatelessMigrationError(
        'Candidate HTTP health check failed after the bounded readiness window',
        503,
        'candidate-http-health-failed'
      );
      adapterState.failure = {
        phase: 'candidate-health',
        code: failure.code,
        message: failure.message,
        recordedAt: now()
      };
      persist(adapterState);
      throw failure;
    }
    adapterState.candidate.health = {
      statusCode: proof.statusCode,
      attempts: proof.attempts,
      checkedAt: proof.checkedAt
    };
    persist(adapterState);
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
    const connectHost = await ingressAuthority.hostIngressAddress();
    const probes = [];
    for (let index = 0; index < 8; index += 1) {
      try {
        probes.push(await ingressAuthority.httpsProbe({
          hostname: primary.domain,
          connectHost,
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
    const connectHost = await ingressAuthority.hostIngressAddress();
    const probes = [];
    for (let index = 0; index < 5; index += 1) {
      try {
        probes.push(await ingressAuthority.httpsProbe({
          hostname: primary.domain,
          connectHost,
          requestPath: primary.path
        }));
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
  capabilityProfileForStartup,
  dependencyFromValue,
  environmentForStartup,
  immutableImageFallbackAllowed,
  startupContractFromObservation,
  startupContractFromImageDefaults,
  rewriteEnvironmentDependencies
};
