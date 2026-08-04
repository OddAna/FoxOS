const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseDocument } = require('yaml');
const { atomicWriteJson } = require('./resourceRegistry');
const {
  SourceDeploymentError,
  canonicalJson,
  createGitSourceAdapter,
  defaultHostProbe,
  ensureDirectory,
  hash,
  parseBuildOutput,
  readJson,
  validateExpectedBody,
  validateGitRef,
  validateHealthPath,
  validateRelativePath,
  validateRepositoryUrl
} = require('./sourceDeploymentManager');

const COMPOSE_SCHEMA_VERSION = 1;
const COMPOSE_DEPLOYMENT_NAME = 'foxos-compose-lab';
const COMPOSE_RESOURCE_ID = 'res_' + hash(COMPOSE_DEPLOYMENT_NAME, 32);
const COMPOSE_DISPOSABLE_LABEL = 'com.foxos.compose-deployment.disposable';
const PLAN_COMPOSE_CONFIRMATION = 'PLAN DISPOSABLE COMPOSE';
const MAX_COMPOSE_BYTES = 64 * 1024;
const MAX_SERVICES = 3;
const MAX_RECORDS = 50;
const RECORD_ID_PATTERN = /^(cplan|cop|crev|cjob)_[a-f0-9]{24,64}$/;
const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

class ComposeDeploymentError extends SourceDeploymentError {
  constructor(message, statusCode = 400, code = 'compose-deployment-error') {
    super(message, statusCode, code);
    this.name = 'ComposeDeploymentError';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function allowedKeys(value, keys, location) {
  if (!isPlainObject(value)) {
    throw new ComposeDeploymentError(location + ' must be a mapping', 409, 'invalid-compose-manifest');
  }
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length) {
    throw new ComposeDeploymentError(
      location + ' contains unsupported fields: ' + unexpected.sort().join(', '),
      409,
      'unsupported-compose-field'
    );
  }
}

function normalizeExpose(value, serviceName) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new ComposeDeploymentError(
      `Service ${serviceName} must expose exactly one private TCP port`,
      409,
      'invalid-compose-expose'
    );
  }
  const match = String(value[0]).match(/^(\d{1,5})(?:\/tcp)?$/);
  const port = match ? Number.parseInt(match[1], 10) : 0;
  if (port < 1024 || port > 65535) {
    throw new ComposeDeploymentError(
      `Service ${serviceName} exposes an invalid or privileged port`,
      409,
      'invalid-compose-expose'
    );
  }
  return port;
}

function normalizeBuild(value, serviceName) {
  if (typeof value === 'string') {
    return { contextPath: validateRelativePath(value), dockerfile: 'Dockerfile' };
  }
  allowedKeys(value, ['context', 'dockerfile'], `Service ${serviceName} build`);
  return {
    contextPath: validateRelativePath(value.context, '.'),
    dockerfile: validateRelativePath(value.dockerfile, 'Dockerfile')
  };
}

function composeStartOrder(services) {
  const byName = new Map(services.map((service) => [service.name, service]));
  const visiting = new Set();
  const visited = new Set();
  const order = [];

  function visit(name) {
    if (visiting.has(name)) {
      throw new ComposeDeploymentError('Compose dependency graph contains a cycle', 409, 'compose-cycle');
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of byName.get(name).dependsOn) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  }

  for (const service of services) visit(service.name);
  return order;
}

function parseComposeManifest(content, ingressService) {
  if (!Buffer.isBuffer(content) || content.length < 1 || content.length > MAX_COMPOSE_BYTES) {
    throw new ComposeDeploymentError('Compose manifest is empty or exceeds 64 KiB', 409, 'invalid-compose-manifest');
  }
  if (content.includes(0)) {
    throw new ComposeDeploymentError('Compose manifest contains invalid bytes', 409, 'invalid-compose-manifest');
  }

  let document;
  try {
    document = parseDocument(content.toString('utf8'), {
      strict: true,
      uniqueKeys: true,
      maxAliasCount: 0,
      version: '1.2',
      schema: 'core'
    });
  } catch {
    throw new ComposeDeploymentError('Compose manifest is not valid strict YAML', 409, 'invalid-compose-manifest');
  }
  if (document.errors.length || document.warnings.length) {
    throw new ComposeDeploymentError('Compose manifest contains YAML errors or unsupported constructs', 409, 'invalid-compose-manifest');
  }

  let manifest;
  try {
    manifest = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch {
    throw new ComposeDeploymentError('Compose aliases and recursive values are not allowed', 409, 'compose-alias-blocked');
  }
  allowedKeys(manifest, ['name', 'services'], 'Compose manifest');
  if (manifest.name !== undefined && manifest.name !== COMPOSE_DEPLOYMENT_NAME) {
    throw new ComposeDeploymentError(
      `Compose name must be ${COMPOSE_DEPLOYMENT_NAME}`,
      409,
      'invalid-compose-name'
    );
  }
  if (!isPlainObject(manifest.services)) {
    throw new ComposeDeploymentError('Compose services must be a mapping', 409, 'invalid-compose-services');
  }
  const names = Object.keys(manifest.services).sort();
  if (names.length < 2 || names.length > MAX_SERVICES) {
    throw new ComposeDeploymentError('Disposable Compose requires two or three services', 409, 'invalid-compose-service-count');
  }
  if (!SERVICE_NAME_PATTERN.test(ingressService) || !names.includes(ingressService)) {
    throw new ComposeDeploymentError('Ingress service is invalid or missing', 409, 'invalid-ingress-service');
  }

  const services = names.map((name) => {
    if (!SERVICE_NAME_PATTERN.test(name)) {
      throw new ComposeDeploymentError('Compose service name is invalid', 409, 'invalid-compose-service-name');
    }
    const value = manifest.services[name];
    allowedKeys(value, ['build', 'depends_on', 'expose'], `Service ${name}`);
    if (!value.build) {
      throw new ComposeDeploymentError(`Service ${name} must use a reviewed source build`, 409, 'compose-build-required');
    }
    if (value.depends_on !== undefined && !Array.isArray(value.depends_on)) {
      throw new ComposeDeploymentError(
        `Service ${name} depends_on must be a simple list`,
        409,
        'invalid-compose-dependencies'
      );
    }
    const dependsOn = Array.from(new Set((value.depends_on || []).map(String))).sort();
    if (dependsOn.includes(name) || dependsOn.some((dependency) => !names.includes(dependency))) {
      throw new ComposeDeploymentError(
        `Service ${name} has an invalid dependency`,
        409,
        'invalid-compose-dependencies'
      );
    }
    return {
      name,
      build: normalizeBuild(value.build, name),
      dependsOn,
      privatePort: normalizeExpose(value.expose, name)
    };
  });

  if (services.find((service) => service.name === ingressService).privatePort !== 8080) {
    throw new ComposeDeploymentError('Ingress service must expose private port 8080', 409, 'invalid-ingress-port');
  }
  if (!services.some((service) => service.dependsOn.length)) {
    throw new ComposeDeploymentError('Compose pilot requires at least one dependency edge', 409, 'compose-graph-required');
  }
  const byName = new Map(services.map((service) => [service.name, service]));
  const reachable = new Set();
  const walk = (name) => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const dependency of byName.get(name).dependsOn) walk(dependency);
  };
  walk(ingressService);
  if (reachable.size !== services.length) {
    throw new ComposeDeploymentError(
      'Every service must be a dependency of the ingress graph',
      409,
      'compose-unreachable-service'
    );
  }
  return {
    name: COMPOSE_DEPLOYMENT_NAME,
    ingressService,
    services,
    startOrder: composeStartOrder(services)
  };
}

function resolveGraphContexts(graph, manifestPath) {
  const manifestDirectory = path.posix.dirname(manifestPath);
  return {
    ...graph,
    services: graph.services.map((service) => ({
      ...service,
      build: {
        ...service.build,
        contextPath: validateRelativePath(path.posix.join(manifestDirectory, service.build.contextPath))
      }
    }))
  };
}

function composeDeploymentConfirmation(planId) {
  return 'DEPLOY COMPOSE ' + planId;
}

function composeRollbackConfirmation(operationId) {
  return 'ROLLBACK COMPOSE ' + operationId;
}

function composeCancelConfirmation(jobId) {
  return 'CANCEL COMPOSE ' + jobId;
}

function createComposeDeploymentManager({
  dataRoot,
  dockerRequest,
  dockerBuildRequest,
  sourceAdapter = createGitSourceAdapter(),
  probeHttp = defaultHostProbe,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  defer = (callback) => setImmediate(callback),
  autoStartQueue = true,
  recoverInterruptedJobs = true
}) {
  if (!dataRoot || typeof dockerRequest !== 'function' || typeof dockerBuildRequest !== 'function' || !sourceAdapter.read) {
    throw new Error('Compose deployment manager requires data root, Docker clients and a readable source adapter');
  }

  const root = path.join(dataRoot, 'compose-deployments');
  const plansRoot = path.join(root, 'plans');
  const revisionsRoot = path.join(root, 'revisions');
  const operationsRoot = path.join(root, 'operations');
  const jobsRoot = path.join(root, 'jobs');
  const logsRoot = path.join(root, 'logs');
  const currentFile = path.join(root, 'current.json');
  const queueLockFile = path.join(root, 'queue.lock');
  const inFlight = new Set();
  const pendingJobs = [];
  let queueRunning = false;
  let queueRetryScheduled = false;

  function now() {
    return new Date(clock()).toISOString();
  }

  function liveLockOwner() {
    let lock;
    try {
      lock = readJson(queueLockFile);
    } catch {
      return fs.existsSync(queueLockFile);
    }
    const pid = Number.parseInt(lock && lock.pid, 10);
    const acquiredAt = Date.parse(lock && lock.acquiredAt);
    if (
      !Number.isInteger(pid) || pid < 1 || !Number.isFinite(acquiredAt) ||
      Date.now() - acquiredAt > 6 * 60 * 60 * 1000
    ) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }

  function acquireQueueLock() {
    ensureDirectory(root);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      try {
        fs.writeFileSync(queueLockFile, JSON.stringify({ pid: process.pid, token, acquiredAt: now() }) + '\n', {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600
        });
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (liveLockOwner()) return null;
        try { fs.unlinkSync(queueLockFile); } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
    }
    return null;
  }

  function releaseQueueLock(token) {
    let lock;
    try { lock = readJson(queueLockFile); } catch { return; }
    if (!lock || lock.token !== token || Number(lock.pid) !== process.pid) return;
    try { fs.unlinkSync(queueLockFile); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function recordPath(directory, id) {
    if (!RECORD_ID_PATTERN.test(String(id))) {
      throw new ComposeDeploymentError('Invalid Compose deployment record ID', 400, 'invalid-compose-record-id');
    }
    return path.join(directory, id + '.json');
  }

  function getRecord(directory, id, label) {
    const record = readJson(recordPath(directory, id));
    if (!record) throw new ComposeDeploymentError(label + ' was not found', 404, 'compose-record-not-found');
    return record;
  }

  function listRecords(directory) {
    try {
      return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
        .map((file) => readJson(path.join(directory, file))).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function pruneRecords(directory) {
    let records;
    try {
      records = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).map((file) => ({
        file,
        record: readJson(path.join(directory, file))
      })).filter((entry) => entry.record);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const removable = records.filter(({ record }) => !['queued', 'running', 'cancel-requested'].includes(record.status))
      .sort((left, right) => {
        const leftTime = left.record.completedAt || left.record.createdAt || left.record.startedAt || left.record.queuedAt || '';
        const rightTime = right.record.completedAt || right.record.createdAt || right.record.startedAt || right.record.queuedAt || '';
        return leftTime.localeCompare(rightTime) || left.file.localeCompare(right.file);
      });
    for (const entry of removable.slice(0, Math.max(0, records.length - MAX_RECORDS))) {
      fs.unlinkSync(path.join(directory, entry.file));
    }
  }

  function getPlan(planId) {
    return getRecord(plansRoot, planId, 'Compose deployment plan');
  }

  function getOperation(operationId) {
    return getRecord(operationsRoot, operationId, 'Compose deployment operation');
  }

  function getJob(jobId) {
    return getRecord(jobsRoot, jobId, 'Compose deployment job');
  }

  function status() {
    return {
      schemaVersion: COMPOSE_SCHEMA_VERSION,
      scope: 'disposable-public-git-compose-graph-only',
      resourceId: COMPOSE_RESOURCE_ID,
      name: COMPOSE_DEPLOYMENT_NAME,
      current: readJson(currentFile),
      plans: listRecords(plansRoot),
      operations: listRecords(operationsRoot),
      jobs: listRecords(jobsRoot),
      queue: {
        running: queueRunning,
        pending: pendingJobs.length,
        serial: true,
        queuedCancellation: true,
        runningCancellation: 'cooperative-before-cutover'
      },
      guarantees: {
        publicHttpsGitOnly: true,
        immutableCommitAndManifestRequired: true,
        serviceCountMaximum: MAX_SERVICES,
        volumesSupported: false,
        environmentSupported: false,
        secretsSupported: false,
        hostAccessSupported: false,
        buildNetwork: 'none',
        runtimeNetwork: 'isolated-bridge',
        publicPorts: false,
        candidateHealthBeforeCutover: true,
        providerAuthorityRequired: false,
        coolifyMutable: false
      }
    };
  }

  async function createPlan(input = {}) {
    if (input.confirmation !== PLAN_COMPOSE_CONFIRMATION) {
      throw new ComposeDeploymentError('Exact disposable Compose planning confirmation is required', 400, 'confirmation-required');
    }
    const repository = validateRepositoryUrl(input.repository);
    const ref = validateGitRef(input.ref);
    const manifestPath = validateRelativePath(input.manifest, 'compose.yaml');
    const ingressService = String(input.ingressService || '').trim();
    const healthPath = validateHealthPath(input.healthPath);
    const expectedBody = validateExpectedBody(input.expectedBody);
    const manifestFile = await sourceAdapter.read({ repository, ref, filePath: manifestPath }, MAX_COMPOSE_BYTES);
    const graph = resolveGraphContexts(parseComposeManifest(manifestFile.content, ingressService), manifestPath);
    const services = [];
    for (const service of graph.services) {
      const inspected = await sourceAdapter.inspect({
        repository,
        ref,
        contextPath: service.build.contextPath,
        dockerfile: service.build.dockerfile
      });
      if (inspected.commit !== manifestFile.commit) {
        throw new ComposeDeploymentError('Git ref moved while planning the Compose graph', 409, 'source-plan-stale');
      }
      services.push({
        ...service,
        contextDigest: inspected.contextDigest,
        dockerfileDigest: inspected.dockerfileDigest,
        fileCount: inspected.fileCount,
        totalBytes: inspected.totalBytes
      });
    }
    const normalizedGraph = { ...graph, services };
    const revisionBody = {
      schemaVersion: COMPOSE_SCHEMA_VERSION,
      resourceId: COMPOSE_RESOURCE_ID,
      source: {
        adapter: 'public-git-https',
        repository,
        ref,
        refType: manifestFile.refType,
        commit: manifestFile.commit,
        manifestPath,
        manifestDigest: manifestFile.fileDigest,
        manifestBytes: manifestFile.fileBytes
      },
      workflow: {
        method: 'compose-graph',
        graphDigest: 'sha256:' + hash(canonicalJson(normalizedGraph)),
        graph: normalizedGraph,
        buildNetwork: 'none',
        runtimeNetwork: 'isolated-bridge',
        secretValuesIncluded: false
      },
      health: { path: healthPath, expectedStatus: 200, expectedBody }
    };
    const revisionId = 'crev_' + hash(canonicalJson(revisionBody), 32);
    const planId = 'cplan_' + randomUUID().replace(/-/g, '');
    const revision = { ...revisionBody, revisionId, createdAt: now() };
    const plan = {
      ...revisionBody,
      planId,
      revisionId,
      status: 'ready',
      actions: [
        'reclone-and-verify-compose-source',
        'build-every-service-without-network-or-secrets',
        'create-isolated-candidate-network',
        'start-dependencies-before-ingress',
        'verify-loopback-ingress-status-and-body',
        'preserve-previous-service-group',
        'promote-candidate-group'
      ],
      confirmation: composeDeploymentConfirmation(planId),
      createdAt: revision.createdAt
    };
    atomicWriteJson(recordPath(revisionsRoot, revisionId), revision);
    atomicWriteJson(recordPath(plansRoot, planId), plan);
    return plan;
  }

  function buildPath(imageTag, plan, service) {
    const labels = JSON.stringify({
      [COMPOSE_DISPOSABLE_LABEL]: 'true',
      'com.foxos.deployment.group.id': COMPOSE_RESOURCE_ID,
      'com.foxos.deployment.service': service.name,
      'com.foxos.deployment.revision': plan.revisionId
    });
    const query = new URLSearchParams({
      t: imageTag,
      dockerfile: service.build.dockerfile,
      rm: '1',
      forcerm: '1',
      pull: '1',
      networkmode: 'none',
      memory: String(512 * 1024 * 1024),
      memswap: String(512 * 1024 * 1024),
      cpuquota: '50000',
      labels
    });
    return '/build?' + query.toString();
  }

  function serviceResourceId(name) {
    return 'res_' + hash(COMPOSE_RESOURCE_ID + ':' + name, 32);
  }

  function commonLabels(plan, operationId, serviceName) {
    return {
      'com.foxos.managed': 'true',
      'com.foxos.resource.id': serviceResourceId(serviceName),
      'com.foxos.deployment.group.id': COMPOSE_RESOURCE_ID,
      'com.foxos.deployment.service': serviceName,
      [COMPOSE_DISPOSABLE_LABEL]: 'true',
      'com.foxos.deployment.revision': plan.revisionId,
      'com.foxos.deployment.operation': operationId
    };
  }

  function containerPayload(plan, operationId, service, imageId, networkName) {
    const portKey = service.privatePort + '/tcp';
    const ingress = service.name === plan.workflow.graph.ingressService;
    return {
      Image: imageId,
      Labels: commonLabels(plan, operationId, service.name),
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        NetworkMode: networkName,
        PortBindings: ingress ? { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '0' }] } : {},
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 128 * 1024 * 1024,
        NanoCpus: 500000000,
        PidsLimit: 128,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' }
      },
      NetworkingConfig: {
        EndpointsConfig: { [networkName]: { Aliases: [service.name] } }
      }
    };
  }

  function assertOwnedDetails(details, serviceName, revisionId = null) {
    const labels = details && details.Config && details.Config.Labels || {};
    if (
      labels[COMPOSE_DISPOSABLE_LABEL] !== 'true' ||
      labels['com.foxos.deployment.group.id'] !== COMPOSE_RESOURCE_ID ||
      labels['com.foxos.deployment.service'] !== serviceName ||
      labels['com.foxos.resource.id'] !== serviceResourceId(serviceName) ||
      (revisionId && labels['com.foxos.deployment.revision'] !== revisionId)
    ) {
      throw new ComposeDeploymentError('Compose deployment container identity mismatch', 409, 'compose-identity-mismatch');
    }
  }

  async function currentGroup() {
    const current = readJson(currentFile);
    const listed = await dockerRequest('GET', '/containers/json?all=1');
    if (!current) {
      const occupied = (listed || []).find((container) => (container.Names || []).some((name) => (
        /^\/foxos-compose-lab-[a-z][a-z0-9-]{0,31}$/.test(name)
      )));
      if (occupied) {
        const labels = occupied.Labels || {};
        const ownership = labels[COMPOSE_DISPOSABLE_LABEL] === 'true' &&
          labels['com.foxos.deployment.group.id'] === COMPOSE_RESOURCE_ID ? 'stale FoxOS' : 'non-FoxOS';
        throw new ComposeDeploymentError(
          `Compose lab stable names are occupied by ${ownership} containers while current state is missing`,
          409,
          'compose-name-conflict'
        );
      }
      return null;
    }
    const services = [];
    for (const service of current.services) {
      const details = await dockerRequest('GET', '/containers/' + service.containerId + '/json');
      assertOwnedDetails(details, service.name, current.revisionId);
      if (details.Name !== '/' + COMPOSE_DEPLOYMENT_NAME + '-' + service.name) {
        throw new ComposeDeploymentError('Current Compose service name drifted', 409, 'compose-name-drift');
      }
      services.push({ ...service, details });
    }
    return { ...current, services };
  }

  function publishedPort(details, port) {
    const bindings = details.NetworkSettings && details.NetworkSettings.Ports && details.NetworkSettings.Ports[port + '/tcp'];
    const published = Number.parseInt(bindings && bindings[0] && bindings[0].HostPort || '', 10);
    if (!Number.isInteger(published) || published < 1 || published > 65535) {
      throw new ComposeDeploymentError('Compose ingress did not receive a loopback port', 502, 'compose-port-missing');
    }
    return published;
  }

  async function proveHealth(containerId, plan) {
    const ingress = plan.workflow.graph.services.find((service) => service.name === plan.workflow.graph.ingressService);
    let lastError;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
        if (!details.State || details.State.Status !== 'running') throw new Error('Compose ingress is not running');
        const hostPort = publishedPort(details, ingress.privatePort);
        const response = await probeHttp({ port: hostPort, healthPath: plan.health.path, timeoutMs: 5000 });
        if (response.statusCode === plan.health.expectedStatus && response.body.includes(plan.health.expectedBody)) {
          return {
            verified: true,
            statusCode: response.statusCode,
            bodyDigest: 'sha256:' + hash(response.body),
            expectedBodyMatched: true,
            hostPort,
            verifiedAt: now()
          };
        }
        lastError = new Error('Compose health proof did not match the expected status and marker');
      } catch (error) {
        lastError = error;
      }
      await wait(500);
    }
    throw new ComposeDeploymentError(lastError && lastError.message || 'Compose health proof failed', 502, 'compose-health-failed');
  }

  async function removeGroup(services, networkId) {
    for (const service of [...services].reverse()) {
      try { await dockerRequest('DELETE', '/containers/' + service.containerId + '?force=1&v=0'); } catch { /* best effort */ }
    }
    if (networkId) {
      try { await dockerRequest('DELETE', '/networks/' + networkId); } catch { /* best effort */ }
    }
  }

  async function stopGroup(services, order) {
    const byName = new Map(services.map((service) => [service.name, service]));
    for (const name of [...order].reverse()) {
      const service = byName.get(name);
      const details = service.details || await dockerRequest('GET', '/containers/' + service.containerId + '/json');
      if (details.State && details.State.Status === 'running') {
        await dockerRequest('POST', '/containers/' + service.containerId + '/stop?t=10');
      }
    }
  }

  async function startGroup(services, order) {
    const byName = new Map(services.map((service) => [service.name, service]));
    for (const name of order) {
      const service = byName.get(name);
      const details = await dockerRequest('GET', '/containers/' + service.containerId + '/json');
      if (!details.State || details.State.Status !== 'running') {
        await dockerRequest('POST', '/containers/' + service.containerId + '/start');
      }
    }
  }

  async function renameService(service, targetName) {
    const details = await dockerRequest('GET', '/containers/' + service.containerId + '/json');
    if (details.Name !== '/' + targetName) {
      await dockerRequest('POST', '/containers/' + service.containerId + '/rename?name=' + encodeURIComponent(targetName));
    }
    service.runtimeName = targetName;
  }

  async function applyPlan(planId, confirmation, shouldCancel = () => false) {
    const plan = getPlan(planId);
    if (confirmation !== plan.confirmation) {
      throw new ComposeDeploymentError('Exact disposable Compose deployment confirmation is required', 400, 'confirmation-required');
    }
    if (inFlight.has(COMPOSE_RESOURCE_ID)) {
      throw new ComposeDeploymentError('A Compose deployment is already running', 409, 'compose-deployment-in-progress');
    }
    inFlight.add(COMPOSE_RESOURCE_ID);
    const operationId = 'cop_' + randomUUID().replace(/-/g, '');
    const operationFile = recordPath(operationsRoot, operationId);
    let operation = {
      schemaVersion: COMPOSE_SCHEMA_VERSION,
      operationId,
      planId,
      revisionId: plan.revisionId,
      resourceId: COMPOSE_RESOURCE_ID,
      status: 'running',
      startedAt: now(),
      source: plan.source,
      builds: [],
      candidate: null,
      previous: null,
      healthProof: null,
      rollback: { available: false, confirmation: composeRollbackConfirmation(operationId) }
    };
    atomicWriteJson(operationFile, operation);
    const candidateServices = [];
    let candidateNetwork = null;
    let previous = null;
    let previousTouched = false;
    const throwIfCancelled = () => {
      if (shouldCancel()) throw new ComposeDeploymentError('Compose deployment job was cancelled before cutover', 409, 'compose-job-cancelled');
    };

    try {
      throwIfCancelled();
      const manifestFile = await sourceAdapter.read({
        repository: plan.source.repository,
        ref: plan.source.ref,
        commit: plan.source.commit,
        filePath: plan.source.manifestPath
      }, MAX_COMPOSE_BYTES);
      const graph = resolveGraphContexts(
        parseComposeManifest(manifestFile.content, plan.workflow.graph.ingressService),
        plan.source.manifestPath
      );
      if (manifestFile.fileDigest !== plan.source.manifestDigest) {
        throw new ComposeDeploymentError('Compose manifest changed after planning', 409, 'source-plan-stale');
      }
      const plannedManifestGraph = {
        ...plan.workflow.graph,
        services: plan.workflow.graph.services.map((service) => ({
          name: service.name,
          build: service.build,
          dependsOn: service.dependsOn,
          privatePort: service.privatePort
        }))
      };
      if (canonicalJson(graph) !== canonicalJson(plannedManifestGraph)) {
        throw new ComposeDeploymentError('Compose graph changed after planning', 409, 'source-plan-stale');
      }
      previous = await currentGroup();

      for (const service of plan.workflow.graph.services) {
        throwIfCancelled();
        const archive = await sourceAdapter.archive({
          repository: plan.source.repository,
          ref: plan.source.ref,
          commit: plan.source.commit,
          contextPath: service.build.contextPath,
          dockerfile: service.build.dockerfile,
          contextDigest: service.contextDigest,
          dockerfileDigest: service.dockerfileDigest
        });
        const imageTag = COMPOSE_DEPLOYMENT_NAME + '-' + service.name + ':' + plan.revisionId.slice(-16);
        const buildResult = parseBuildOutput(await dockerBuildRequest(buildPath(imageTag, plan, service), archive));
        const imageDetails = await dockerRequest('GET', '/images/' + encodeURIComponent(imageTag) + '/json');
        const imageId = String(imageDetails.Id || buildResult.imageId || '').toLowerCase();
        if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
          throw new ComposeDeploymentError('Compose build did not produce an immutable image ID', 502, 'compose-image-missing');
        }
        ensureDirectory(logsRoot);
        const logFile = path.join(logsRoot, operationId + '-' + service.name + '.log');
        fs.writeFileSync(logFile, buildResult.log, { mode: 0o600 });
        fs.chmodSync(logFile, 0o600);
        operation.builds.push({
          service: service.name,
          status: 'succeeded',
          imageTag,
          imageId,
          logFile: path.relative(dataRoot, logFile),
          logBytes: Buffer.byteLength(buildResult.log),
          secretValuesIncluded: false
        });
        atomicWriteJson(operationFile, operation);
      }

      throwIfCancelled();
      const suffix = hash(operationId, 12);
      const networkName = COMPOSE_DEPLOYMENT_NAME + '-candidate-' + suffix;
      candidateNetwork = await dockerRequest('POST', '/networks/create', {
        Name: networkName,
        CheckDuplicate: true,
        Internal: false,
        Attachable: false,
        Labels: {
          'com.foxos.managed': 'true',
          [COMPOSE_DISPOSABLE_LABEL]: 'true',
          'com.foxos.deployment.group.id': COMPOSE_RESOURCE_ID,
          'com.foxos.deployment.revision': plan.revisionId,
          'com.foxos.deployment.operation': operationId
        }
      });
      candidateNetwork = { networkId: candidateNetwork.Id, networkName };
      const builds = new Map(operation.builds.map((build) => [build.service, build]));
      for (const service of plan.workflow.graph.services) {
        const name = COMPOSE_DEPLOYMENT_NAME + '-candidate-' + suffix + '-' + service.name;
        const created = await dockerRequest(
          'POST',
          '/containers/create?name=' + encodeURIComponent(name),
          containerPayload(plan, operationId, service, builds.get(service.name).imageId, networkName)
        );
        candidateServices.push({
          name: service.name,
          containerId: created.Id,
          runtimeName: name,
          imageId: builds.get(service.name).imageId
        });
      }
      await startGroup(candidateServices, plan.workflow.graph.startOrder);
      const ingress = candidateServices.find((service) => service.name === plan.workflow.graph.ingressService);
      operation.healthProof = await proveHealth(ingress.containerId, plan);
      operation.candidate = {
        services: candidateServices,
        networkId: candidateNetwork.networkId,
        networkName: candidateNetwork.networkName,
        hostPort: operation.healthProof.hostPort
      };
      atomicWriteJson(operationFile, operation);
      throwIfCancelled();

      if (previous) {
        operation.previous = {
          operationId: previous.operationId,
          revisionId: previous.revisionId,
          services: previous.services.map((service) => ({
            name: service.name,
            containerId: service.containerId,
            imageId: service.imageId,
            rollbackName: COMPOSE_DEPLOYMENT_NAME + '-rollback-' + suffix + '-' + service.name
          })),
          networkId: previous.networkId,
          networkName: previous.networkName,
          startOrder: previous.startOrder,
          ingressService: previous.ingressService
        };
        previousTouched = true;
        await stopGroup(previous.services, previous.startOrder);
        for (const service of operation.previous.services) {
          await renameService(service, service.rollbackName);
        }
      }
      for (const service of candidateServices) {
        const stableName = COMPOSE_DEPLOYMENT_NAME + '-' + service.name;
        await renameService(service, stableName);
      }
      operation.status = 'applied';
      operation.completedAt = now();
      operation.rollback.available = Boolean(previous);
      atomicWriteJson(operationFile, operation);
      atomicWriteJson(currentFile, {
        schemaVersion: COMPOSE_SCHEMA_VERSION,
        resourceId: COMPOSE_RESOURCE_ID,
        operationId,
        revisionId: plan.revisionId,
        services: candidateServices,
        networkId: candidateNetwork.networkId,
        networkName: candidateNetwork.networkName,
        startOrder: plan.workflow.graph.startOrder,
        ingressService: plan.workflow.graph.ingressService,
        hostPort: operation.healthProof.hostPort,
        source: plan.source,
        healthProof: operation.healthProof,
        activatedAt: operation.completedAt
      });
      pruneRecords(operationsRoot);
      return operation;
    } catch (error) {
      await removeGroup(candidateServices, candidateNetwork && candidateNetwork.networkId);
      if (previousTouched && previous) {
        try {
          for (const service of previous.services) {
            const stableName = COMPOSE_DEPLOYMENT_NAME + '-' + service.name;
            await renameService(service, stableName);
          }
          await startGroup(previous.services, previous.startOrder);
          const previousOperation = getOperation(previous.operationId);
          const previousPlan = getPlan(previousOperation.planId);
          const ingress = previous.services.find((service) => service.name === previous.ingressService);
          operation.restorationProof = await proveHealth(ingress.containerId, previousPlan);
        } catch { /* best effort */ }
      }
      operation.status = error.code === 'compose-job-cancelled' ? 'cancelled-before-cutover' :
        previousTouched ? 'failed-previous-restoration-attempted' : 'failed-before-cutover';
      operation.completedAt = now();
      operation.error = {
        code: error.code || 'compose-deployment-failed',
        message: error instanceof SourceDeploymentError ? error.message : 'Compose deployment failed'
      };
      atomicWriteJson(operationFile, operation);
      throw error;
    } finally {
      inFlight.delete(COMPOSE_RESOURCE_ID);
    }
  }

  async function rollbackOperation(operationId, confirmation) {
    const operation = getOperation(operationId);
    if (operation.status !== 'applied' || !operation.rollback.available || !operation.previous) {
      throw new ComposeDeploymentError('This Compose deployment has no available rollback', 409, 'rollback-unavailable');
    }
    if (confirmation !== operation.rollback.confirmation) {
      throw new ComposeDeploymentError('Exact Compose rollback confirmation is required', 400, 'confirmation-required');
    }
    if (inFlight.has(COMPOSE_RESOURCE_ID) || queueRunning || pendingJobs.length) {
      throw new ComposeDeploymentError('Compose queue must be idle before rollback', 409, 'compose-queue-busy');
    }
    const queueLock = acquireQueueLock();
    if (!queueLock) {
      throw new ComposeDeploymentError('Another Compose queue process is active', 409, 'compose-queue-busy');
    }
    inFlight.add(COMPOSE_RESOURCE_ID);
    const suffix = hash(operationId, 12);
    let current = null;
    let currentPlan = null;
    let previousPlan = null;
    let currentTouched = false;
    let previousTouched = false;
    try {
      current = await currentGroup();
      currentPlan = getPlan(operation.planId);
      const previousOperation = getOperation(operation.previous.operationId);
      previousPlan = getPlan(previousOperation.planId);
      if (!current || current.operationId !== operationId) {
        throw new ComposeDeploymentError('Current Compose group does not match the rollback operation', 409, 'rollback-drift');
      }
      for (const service of operation.previous.services) {
        const details = await dockerRequest('GET', '/containers/' + service.containerId + '/json');
        assertOwnedDetails(details, service.name, operation.previous.revisionId);
        if (details.Name !== '/' + service.rollbackName) {
          throw new ComposeDeploymentError('Previous Compose service identity drifted', 409, 'rollback-drift');
        }
      }
      currentTouched = true;
      await stopGroup(current.services, current.startOrder);
      for (const service of current.services) {
        const parkedName = COMPOSE_DEPLOYMENT_NAME + '-rolled-forward-' + suffix + '-' + service.name;
        await renameService(service, parkedName);
      }
      previousTouched = true;
      for (const service of operation.previous.services) {
        const stableName = COMPOSE_DEPLOYMENT_NAME + '-' + service.name;
        await renameService(service, stableName);
      }
      await startGroup(operation.previous.services, operation.previous.startOrder);
      const ingress = operation.previous.services.find((service) => service.name === operation.previous.ingressService);
      const healthProof = await proveHealth(ingress.containerId, previousPlan);
      operation.status = 'rolled-back';
      operation.rolledBackAt = now();
      operation.rollback.available = false;
      operation.rollback.proof = healthProof;
      operation.rollback.currentParkedServices = current.services.map((service) => ({
        name: service.name,
        containerId: service.containerId,
        imageId: service.imageId,
        runtimeName: service.runtimeName
      }));
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      atomicWriteJson(currentFile, {
        schemaVersion: COMPOSE_SCHEMA_VERSION,
        resourceId: COMPOSE_RESOURCE_ID,
        operationId: operation.previous.operationId,
        revisionId: operation.previous.revisionId,
        services: operation.previous.services.map((service) => ({
          name: service.name,
          containerId: service.containerId,
          imageId: service.imageId,
          runtimeName: service.runtimeName
        })),
        networkId: operation.previous.networkId,
        networkName: operation.previous.networkName,
        startOrder: operation.previous.startOrder,
        ingressService: operation.previous.ingressService,
        hostPort: healthProof.hostPort,
        source: previousPlan.source,
        healthProof,
        activatedAt: operation.rolledBackAt,
        restoredBy: operationId
      });
      return operation;
    } catch (error) {
      if (previousTouched) {
        try { await stopGroup(operation.previous.services, operation.previous.startOrder); } catch { /* best effort */ }
        for (const service of operation.previous.services) {
          try {
            await renameService(service, service.rollbackName);
          } catch { /* best effort */ }
        }
      }
      if (currentTouched) {
        for (const service of current.services) {
          try {
            await renameService(service, COMPOSE_DEPLOYMENT_NAME + '-' + service.name);
          } catch { /* best effort */ }
        }
        try {
          await startGroup(current.services, currentPlan.workflow.graph.startOrder);
          const ingress = current.services.find((service) => service.name === current.ingressService);
          await proveHealth(ingress.containerId, currentPlan);
        } catch { /* best effort */ }
      }
      throw error;
    } finally {
      inFlight.delete(COMPOSE_RESOURCE_ID);
      releaseQueueLock(queueLock);
    }
  }

  function scheduleQueue() {
    if (!autoStartQueue || queueRunning || queueRetryScheduled || !pendingJobs.length) return;
    defer(() => { processQueue().catch(() => {}); });
  }

  function retryQueue() {
    if (queueRetryScheduled || !autoStartQueue || !pendingJobs.length) return;
    queueRetryScheduled = true;
    const timer = setTimeout(() => {
      queueRetryScheduled = false;
      scheduleQueue();
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function processQueue() {
    if (queueRunning) return;
    const jobId = pendingJobs[0];
    if (!jobId) return;
    const queueLock = acquireQueueLock();
    if (!queueLock) {
      retryQueue();
      return;
    }
    pendingJobs.shift();
    let job = getJob(jobId);
    if (job.status !== 'queued') {
      releaseQueueLock(queueLock);
      scheduleQueue();
      return;
    }
    queueRunning = true;
    job = { ...job, status: 'running', startedAt: now() };
    atomicWriteJson(recordPath(jobsRoot, jobId), job);
    try {
      const operation = await applyPlan(job.planId, getPlan(job.planId).confirmation, () => {
        const latest = getJob(jobId);
        return Boolean(latest.cancelRequestedAt);
      });
      job = { ...getJob(jobId), status: 'succeeded', operationId: operation.operationId, completedAt: now() };
    } catch (error) {
      const latest = getJob(jobId);
      job = {
        ...latest,
        status: error.code === 'compose-job-cancelled' ? 'cancelled' : 'failed',
        completedAt: now(),
        error: {
          code: error.code || 'compose-job-failed',
          message: error instanceof SourceDeploymentError ? error.message : 'Compose deployment job failed'
        }
      };
    } finally {
      atomicWriteJson(recordPath(jobsRoot, jobId), job);
      pruneRecords(jobsRoot);
      queueRunning = false;
      releaseQueueLock(queueLock);
      scheduleQueue();
    }
  }

  function enqueuePlan(planId, confirmation) {
    const plan = getPlan(planId);
    if (confirmation !== plan.confirmation) {
      throw new ComposeDeploymentError('Exact Compose queue confirmation is required', 400, 'confirmation-required');
    }
    if (listRecords(jobsRoot).some((job) => job.planId === planId && ['queued', 'running', 'cancel-requested'].includes(job.status))) {
      throw new ComposeDeploymentError('This Compose plan is already queued', 409, 'compose-plan-already-queued');
    }
    const jobId = 'cjob_' + randomUUID().replace(/-/g, '');
    const job = {
      schemaVersion: COMPOSE_SCHEMA_VERSION,
      jobId,
      planId,
      revisionId: plan.revisionId,
      resourceId: COMPOSE_RESOURCE_ID,
      status: 'queued',
      queuedAt: now(),
      cancellation: { confirmation: composeCancelConfirmation(jobId) }
    };
    atomicWriteJson(recordPath(jobsRoot, jobId), job);
    pendingJobs.push(jobId);
    scheduleQueue();
    return job;
  }

  function cancelJob(jobId, confirmation) {
    let job = getJob(jobId);
    if (confirmation !== job.cancellation.confirmation) {
      throw new ComposeDeploymentError('Exact Compose cancellation confirmation is required', 400, 'confirmation-required');
    }
    if (job.status === 'queued') {
      const index = pendingJobs.indexOf(jobId);
      if (index !== -1) pendingJobs.splice(index, 1);
      job = { ...job, status: 'cancelled', cancelledAt: now() };
    } else if (job.status === 'running' || job.status === 'cancel-requested') {
      job = { ...job, status: 'cancel-requested', cancelRequestedAt: job.cancelRequestedAt || now() };
    } else {
      throw new ComposeDeploymentError('Completed Compose jobs cannot be cancelled', 409, 'compose-job-terminal');
    }
    atomicWriteJson(recordPath(jobsRoot, jobId), job);
    return job;
  }

  for (const job of listRecords(jobsRoot).sort((left, right) => (
    String(left.queuedAt || '').localeCompare(String(right.queuedAt || '')) || left.jobId.localeCompare(right.jobId)
  ))) {
    if (job.status === 'queued') pendingJobs.push(job.jobId);
    if (
      recoverInterruptedJobs && !liveLockOwner() &&
      (job.status === 'running' || job.status === 'cancel-requested')
    ) {
      atomicWriteJson(recordPath(jobsRoot, job.jobId), {
        ...job,
        status: 'interrupted',
        interruptedAt: now(),
        error: { code: 'agent-restarted', message: 'Agent restarted while this job was running; inspect before retrying.' }
      });
    }
  }
  scheduleQueue();

  return {
    applyPlan,
    cancelJob,
    createPlan,
    enqueuePlan,
    getJob,
    getOperation,
    getPlan,
    processQueue,
    rollbackOperation,
    status
  };
}

module.exports = {
  COMPOSE_DEPLOYMENT_NAME,
  COMPOSE_DISPOSABLE_LABEL,
  COMPOSE_RESOURCE_ID,
  PLAN_COMPOSE_CONFIRMATION,
  ComposeDeploymentError,
  composeCancelConfirmation,
  composeDeploymentConfirmation,
  composeRollbackConfirmation,
  createComposeDeploymentManager,
  parseComposeManifest
};
