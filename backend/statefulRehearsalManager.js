const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tarContentDigest } = require('./adoptionManager');
const {
  relatedRelationships,
  resourceFingerprint,
  statefulRehearsalResourceFingerprint
} = require('./applicationManifestManager');
const { atomicWriteJson } = require('./resourceRegistry');
const { defaultHostProbe, validateHealthPath } = require('./sourceDeploymentManager');

const STATEFUL_REHEARSAL_SCHEMA_VERSION = 1;
const PLAN_STATEFUL_REHEARSAL_CONFIRMATION = 'PLAN STATEFUL REHEARSAL';
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const RECORD_ID_PATTERN = /^(srp|sro)_[a-f0-9]{24,64}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RECORDS = 100;
const MAX_WRITABLE_VOLUMES = 4;
const MAX_REHEARSAL_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
const DEFAULT_NANO_CPUS = 500000000;
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_HEALTH_TIMEOUT_SECONDS = 90;

class StatefulRehearsalError extends Error {
  constructor(message, statusCode = 400, code = 'stateful-rehearsal-error') {
    super(message);
    this.name = 'StatefulRehearsalError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hash(value, length = 64) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
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

function listJson(directory) {
  try {
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
      .map((file) => readJson(path.join(directory, file))).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function pruneJson(directory, maximum = MAX_RECORDS) {
  const records = listJson(directory).sort((left, right) => (
    String(left.createdAt || left.startedAt || '').localeCompare(String(right.createdAt || right.startedAt || '')) ||
    String(left.planId || left.operationId || '').localeCompare(String(right.planId || right.operationId || ''))
  ));
  for (const record of records.slice(0, Math.max(0, records.length - maximum))) {
    const id = record.planId || record.operationId;
    if (id && RECORD_ID_PATTERN.test(id)) fs.unlinkSync(path.join(directory, id + '.json'));
  }
}

function runConfirmation(planId) {
  return 'RUN STATEFUL REHEARSAL ' + planId;
}

function validateHttpHealthPath(value) {
  if (typeof value !== 'string' || !value.length) {
    throw new StatefulRehearsalError(
      'HTTP health path must be a bounded absolute path without query, fragment or traversal',
      400,
      'invalid-http-health-path'
    );
  }
  try {
    return validateHealthPath(value);
  } catch {
    throw new StatefulRehearsalError(
      'HTTP health path must be a bounded absolute path without query, fragment or traversal',
      400,
      'invalid-http-health-path'
    );
  }
}

function processStartToken(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const closingParenthesis = stat.lastIndexOf(')');
    if (closingParenthesis === -1) return null;
    const fieldsAfterCommand = stat.slice(closingParenthesis + 2).trim().split(/\s+/);
    return fieldsAfterCommand[19] || null;
  } catch {
    return null;
  }
}

function tarString(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function tarOctal(block, start, length) {
  const raw = tarString(block, start, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function validateArchiveName(name) {
  const normalized = String(name).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.') return '.';
  if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new StatefulRehearsalError('Volume archive contains an unsafe path', 500, 'unsafe-volume-archive');
  }
  return normalized;
}

function tarHasMaterialEntries(archive) {
  if (!Buffer.isBuffer(archive)) {
    throw new StatefulRehearsalError('Volume archive must be binary', 500, 'invalid-volume-archive');
  }
  let offset = 0;
  let pendingLongName = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = tarString(header, 345, 155);
    const basicName = tarString(header, 0, 100);
    const headerName = prefix ? prefix + '/' + basicName : basicName;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > archive.length) {
      throw new StatefulRehearsalError('Volume archive is truncated', 500, 'truncated-volume-archive');
    }
    const data = archive.subarray(dataStart, dataEnd);
    if (type === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
    } else if (!['x', 'g', 'K'].includes(type)) {
      const name = validateArchiveName(pendingLongName || headerName);
      pendingLongName = null;
      if (name !== '.' && type !== '5') return true;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return false;
}

function normalizedMounts(details) {
  return (details.Mounts || []).map((mount) => ({
    type: String(mount.Type || ''),
    name: mount.Name || null,
    destination: mount.Destination || null,
    readOnly: mount.RW === false
  })).sort((left, right) => (
    String(left.destination).localeCompare(String(right.destination)) ||
    String(left.name).localeCompare(String(right.name))
  ));
}

function safeHealthSummary(healthcheck, fingerprint) {
  const test = healthcheck && healthcheck.Test;
  return {
    configured: Array.isArray(test) && test.length > 1 && test[0] !== 'NONE',
    type: Array.isArray(test) && test.length ? test[0] : null,
    fingerprint,
    commandIncluded: false
  };
}

function validateResourceCandidate(resource) {
  const classification = resource && resource.classification || {};
  const eligible = Boolean(
    resource && resource.role === 'application' && !resource.protected &&
    resource.runtime && resource.runtime.state === 'running' &&
    resource.runtime.inspection === 'complete' &&
    classification.status === 'classified' &&
    classification.workloadRole === 'application' &&
    classification.stateClass === 'stateful' &&
    classification.authorityClass === 'provider-owned'
  );
  if (!eligible) {
    throw new StatefulRehearsalError(
      'Only a running, fully inspected provider-owned stateful application can use this rehearsal',
      409,
      'not-a-stateful-rehearsal-candidate'
    );
  }
}

function createStatefulRehearsalManager({
  dataRoot,
  dockerRequest,
  dockerArchiveRequest,
  resourceRegistry,
  encryptionStore,
  secretManager,
  httpProbe = defaultHostProbe,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerArchiveRequest !== 'function' ||
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    !encryptionStore || !secretManager || typeof httpProbe !== 'function'
  ) {
    throw new Error('Stateful rehearsal manager requires registry, Docker, encryption and secret adapters');
  }

  const root = path.join(dataRoot, 'stateful-rehearsals');
  const plansRoot = path.join(root, 'plans');
  const operationsRoot = path.join(root, 'operations');
  const archivesRoot = path.join(root, 'archives');
  const currentRoot = path.join(root, 'current');
  const operationLockFile = path.join(root, 'operation.lock');
  let activeOperationId = null;

  function now() {
    return new Date(clock()).toISOString();
  }

  function recordPath(directory, id) {
    if (!RECORD_ID_PATTERN.test(String(id))) {
      throw new StatefulRehearsalError('Stateful rehearsal record ID is invalid', 400, 'invalid-rehearsal-record-id');
    }
    return path.join(directory, id + '.json');
  }

  function getRecord(directory, id, label) {
    const record = readJson(recordPath(directory, id));
    if (!record) throw new StatefulRehearsalError(label + ' was not found', 404, 'rehearsal-record-not-found');
    return record;
  }

  function writeOperation(operation) {
    atomicWriteJson(recordPath(operationsRoot, operation.operationId), operation);
  }

  function lockOwnerActive(owner) {
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return true;
    const currentStart = processStartToken(owner.pid);
    if (currentStart !== null) return currentStart === owner.processStartToken;
    return owner.pid === process.pid && owner.processStartToken === processStartToken(process.pid);
  }

  function acquireOperationLock(purpose, clearStaleLock = false) {
    const owner = {
      schemaVersion: 1,
      token: crypto.randomBytes(24).toString('hex'),
      pid: process.pid,
      processStartToken: processStartToken(process.pid),
      purpose,
      acquiredAt: now()
    };
    try {
      const descriptor = fs.openSync(operationLockFile, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(owner));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readJson(operationLockFile, null);
      if (!clearStaleLock || lockOwnerActive(existing)) {
        throw new StatefulRehearsalError(
          'Another stateful rehearsal or recovery operation owns the process lock',
          409,
          'rehearsal-busy'
        );
      }
      fs.unlinkSync(operationLockFile);
      return acquireOperationLock(purpose, false);
    }
  }

  function releaseOperationLock(owner) {
    try {
      const existing = readJson(operationLockFile, null);
      if (!existing || existing.token !== owner.token) return 'operation-lock-owner-mismatch';
      fs.unlinkSync(operationLockFile);
      return null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return 'operation-lock-release:' + error.message;
    }
  }

  function latestResource(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId))) {
      throw new StatefulRehearsalError('FoxOS resource ID is invalid', 400, 'invalid-resource-id');
    }
    const snapshot = resourceRegistry.getLatest();
    if (!snapshot) throw new StatefulRehearsalError('Run a resource scan first', 409, 'registry-not-scanned');
    const resource = (snapshot.resources || []).find((candidate) => candidate.id === resourceId);
    if (!resource) throw new StatefulRehearsalError('Resource was not found', 404, 'resource-not-found');
    return { snapshot, resource };
  }

  function currentResourceFingerprint(snapshot, resource) {
    return resourceFingerprint(resource, relatedRelationships(snapshot, resource.id));
  }

  function validateRuntimeSafety(details, imageDetails) {
    const config = details.Config || {};
    const imageConfig = imageDetails.Config || {};
    const host = details.HostConfig || {};
    const same = (left, right) => canonicalJson(left === undefined ? null : left) ===
      canonicalJson(right === undefined ? null : right);
    if (
      !same(config.Cmd, imageConfig.Cmd) ||
      !same(config.Entrypoint, imageConfig.Entrypoint) ||
      String(config.User || '') !== String(imageConfig.User || '') ||
      String(config.WorkingDir || '') !== String(imageConfig.WorkingDir || '')
    ) {
      throw new StatefulRehearsalError(
        'Custom command, entrypoint, user or working-directory overrides are not supported',
        409,
        'custom-runtime-overrides-unsupported'
      );
    }
    if (
      host.Privileged || host.NetworkMode === 'host' || host.PidMode === 'host' ||
      host.IpcMode === 'host' || host.UTSMode === 'host' ||
      (host.Devices || []).length || (host.CapAdd || []).length
    ) {
      throw new StatefulRehearsalError(
        'Privileged, host-namespace, device, capability or bind access is outside the rehearsal policy',
        409,
        'unsafe-runtime-access'
      );
    }
  }

  function validateAndClassifyMounts(details, input) {
    const mounts = normalizedMounts(details);
    if (!mounts.length || mounts.length > MAX_WRITABLE_VOLUMES) {
      throw new StatefulRehearsalError(
        `Stateful rehearsal requires between one and ${MAX_WRITABLE_VOLUMES} named writable volumes`,
        409,
        'unsupported-volume-count'
      );
    }
    if (mounts.some((mount) => mount.type !== 'volume' || !mount.name || !mount.destination || mount.readOnly)) {
      throw new StatefulRehearsalError(
        'Every mounted path must be a writable named volume in the first stateful rehearsal contract',
        409,
        'unsupported-mount-policy'
      );
    }
    const persistent = new Set((input.persistentVolumes || []).map(String));
    const empty = new Set((input.emptyVolumes || []).map(String));
    if ([...persistent].some((name) => empty.has(name))) {
      throw new StatefulRehearsalError('A volume cannot be both persistent and empty-ephemeral', 400, 'duplicate-volume-classification');
    }
    const observedNames = new Set(mounts.map((mount) => mount.name));
    const classifiedNames = new Set([...persistent, ...empty]);
    if (
      persistent.size < 1 ||
      [...classifiedNames].some((name) => !observedNames.has(name)) ||
      [...observedNames].some((name) => !classifiedNames.has(name))
    ) {
      throw new StatefulRehearsalError(
        'Every observed volume must be classified exactly as persistent or empty-ephemeral',
        400,
        'incomplete-volume-classification'
      );
    }
    return mounts.map((mount) => ({
      name: mount.name,
      destination: mount.destination,
      policy: persistent.has(mount.name) ? 'persistent' : 'empty-ephemeral'
    }));
  }

  function validatePrivatePort(resource, requestedPort) {
    const privatePort = Number(requestedPort);
    if (
      !Number.isSafeInteger(privatePort) || privatePort < 1 || privatePort > 65535 ||
      !(resource.ports || []).some((port) => port.privatePort === privatePort && port.protocol === 'tcp')
    ) {
      throw new StatefulRehearsalError('Candidate private TCP port must match an observed application port', 400, 'invalid-private-port');
    }
    return privatePort;
  }

  function environmentSummary(resource) {
    const environment = secretManager.getEnvironmentRevision(resource.id);
    if (!environment) {
      throw new StatefulRehearsalError('A current FoxOS environment revision is required', 409, 'environment-revision-missing');
    }
    const managedCount = (environment.ordinary || []).length + (environment.secretRefs || []).length;
    const excludedCount = (environment.excluded || []).length;
    if (managedCount + excludedCount !== resource.runtime.environmentVariableCount) {
      throw new StatefulRehearsalError('Environment revision does not cover the observed workload', 409, 'environment-revision-mismatch');
    }
    return {
      revision: environment.revision,
      managedVariableCount: managedCount,
      excludedProviderVariableCount: excludedCount,
      ordinaryNames: (environment.ordinary || []).map((entry) => entry.name).sort(),
      secretRefs: (environment.secretRefs || []).map((entry) => ({
        name: entry.name,
        secretId: entry.secretId,
        revision: entry.revision,
        keyId: entry.keyId
      })).sort((left, right) => left.name.localeCompare(right.name)),
      valuesIncluded: false
    };
  }

  function healthPlan(source, input = {}) {
    const healthcheck = source.details.Config && source.details.Config.Healthcheck;
    const dockerHealth = safeHealthSummary(healthcheck, source.healthFingerprint);
    if (dockerHealth.configured) {
      const fingerprint = encryptionStore.fingerprint(Buffer.from(canonicalJson({
        mode: 'docker-healthcheck',
        sourceFingerprint: source.healthFingerprint
      }), 'utf8'));
      return {
        ...dockerHealth,
        mode: 'docker-healthcheck',
        sourceFingerprint: source.healthFingerprint,
        fingerprint
      };
    }
    const healthPath = validateHttpHealthPath(input.httpHealthPath);
    const fingerprint = encryptionStore.fingerprint(Buffer.from(canonicalJson({
      mode: 'loopback-http',
      healthPath,
      expectedStatus: 200,
      sourceFingerprint: source.healthFingerprint
    }), 'utf8'));
    return {
      configured: false,
      mode: 'loopback-http',
      healthPath,
      expectedStatus: 200,
      sourceFingerprint: source.healthFingerprint,
      fingerprint,
      commandIncluded: false
    };
  }

  function sourceRuntimeFingerprint(details, imageDetails, environmentFingerprint, healthFingerprint) {
    return encryptionStore.fingerprint(Buffer.from(canonicalJson({
      containerId: details.Id,
      imageId: details.Image,
      imageDefaults: {
        cmd: imageDetails.Config && imageDetails.Config.Cmd || null,
        entrypoint: imageDetails.Config && imageDetails.Config.Entrypoint || null,
        user: imageDetails.Config && imageDetails.Config.User || '',
        workingDir: imageDetails.Config && imageDetails.Config.WorkingDir || ''
      },
      mounts: normalizedMounts(details),
      environmentFingerprint,
      healthFingerprint
    }), 'utf8'));
  }

  async function inspectSource(resource) {
    const details = await dockerRequest('GET', '/containers/' + resource.runtime.containerId + '/json');
    if (!details || details.Id !== resource.runtime.containerId || details.Image !== resource.runtime.imageId) {
      throw new StatefulRehearsalError('Docker source identity differs from the registry', 409, 'source-identity-mismatch');
    }
    if (!details.State || details.State.Status !== 'running' || details.State.Paused) {
      throw new StatefulRehearsalError('Stateful source must be running and unpaused', 409, 'source-not-running');
    }
    const imageDetails = await dockerRequest('GET', '/images/' + encodeURIComponent(details.Image) + '/json');
    if (!imageDetails || imageDetails.Id !== details.Image || !SHA256_PATTERN.test(String(details.Image))) {
      throw new StatefulRehearsalError('Immutable source image inspection failed', 409, 'source-image-unavailable');
    }
    validateRuntimeSafety(details, imageDetails);
    const healthcheck = details.Config && details.Config.Healthcheck;
    const dockerHealthConfigured = Boolean(
      healthcheck && Array.isArray(healthcheck.Test) &&
      healthcheck.Test.length > 1 && healthcheck.Test[0] !== 'NONE'
    );
    if (dockerHealthConfigured && (!details.State.Health || details.State.Health.Status !== 'healthy')) {
      throw new StatefulRehearsalError('Stateful source must be healthy before rehearsal', 409, 'source-not-healthy');
    }
    const environment = details.Config && details.Config.Env;
    if (!Array.isArray(environment)) {
      throw new StatefulRehearsalError('Docker environment inspection is incomplete', 409, 'environment-inspection-incomplete');
    }
    const environmentFingerprint = secretManager.fingerprintEnvironment(environment);
    const healthFingerprint = encryptionStore.fingerprint(Buffer.from(canonicalJson(healthcheck || null), 'utf8'));
    return {
      details,
      imageDetails,
      environmentFingerprint,
      healthFingerprint,
      runtimeFingerprint: sourceRuntimeFingerprint(details, imageDetails, environmentFingerprint, healthFingerprint)
    };
  }

  async function createPlan(input = {}) {
    if (input.confirmation !== PLAN_STATEFUL_REHEARSAL_CONFIRMATION) {
      throw new StatefulRehearsalError('Exact stateful rehearsal planning confirmation is required', 400, 'confirmation-required');
    }
    const { snapshot, resource } = latestResource(input.resourceId);
    validateResourceCandidate(resource);
    const source = await inspectSource(resource);
    const volumes = validateAndClassifyMounts(source.details, input);
    const privatePort = validatePrivatePort(resource, input.privatePort);
    const environment = environmentSummary(resource);
    const health = healthPlan(source, input);
    const planId = 'srp_' + randomUUID().replace(/-/g, '');
    const plan = {
      schemaVersion: STATEFUL_REHEARSAL_SCHEMA_VERSION,
      planId,
      resourceId: resource.id,
      resourceName: resource.name,
      provider: resource.provider,
      registrySnapshotId: snapshot.snapshotId,
      resourceFingerprint: currentResourceFingerprint(snapshot, resource),
      rehearsalResourceFingerprint: statefulRehearsalResourceFingerprint(resource),
      sourceContainerId: resource.runtime.containerId,
      sourceImageId: resource.runtime.imageId,
      sourceRuntimeFingerprint: source.runtimeFingerprint,
      environmentFingerprint: source.environmentFingerprint,
      environment,
      volumes,
      privatePort,
      health,
      candidateResources: {
        memoryBytes: DEFAULT_MEMORY_BYTES,
        nanoCpus: DEFAULT_NANO_CPUS,
        pidsLimit: DEFAULT_PIDS_LIMIT
      },
      confirmation: runConfirmation(planId),
      createdAt: now(),
      guarantees: {
        dockerRequestMethods: ['GET'],
        sourcePauseRequiredAtRun: true,
        sourceStopIncluded: false,
        sourceRecreationIncluded: false,
        routeMutationIncluded: false,
        trafficCutoverIncluded: false,
        providerMutationIncluded: false,
        providerDetachIncluded: false,
        candidateExternalNetworkIncluded: false,
        offHostRecoveryProven: false,
        environmentValuesIncluded: false,
        secretValuesIncluded: false
      }
    };
    atomicWriteJson(recordPath(plansRoot, planId), plan);
    pruneJson(plansRoot);
    return plan;
  }

  async function waitForHealth(containerId, plannedHealth, privatePort) {
    const deadline = Date.now() + DEFAULT_HEALTH_TIMEOUT_SECONDS * 1000;
    let last = null;
    while (Date.now() < deadline) {
      last = await dockerRequest('GET', '/containers/' + containerId + '/json');
      const status = last.State && last.State.Status;
      const health = last.State && last.State.Health && last.State.Health.Status;
      if (plannedHealth.mode === 'docker-healthcheck' && status === 'running' && health === 'healthy') {
        return last;
      }
      if (plannedHealth.mode === 'loopback-http' && status === 'running') {
        const bindings = last.NetworkSettings && last.NetworkSettings.Ports &&
          last.NetworkSettings.Ports[privatePort + '/tcp'] || [];
        const loopback = bindings.length === 1 && bindings[0].HostIp === '127.0.0.1'
          ? Number(bindings[0].HostPort)
          : 0;
        if (Number.isSafeInteger(loopback) && loopback > 0 && loopback <= 65535) {
          try {
            const result = await httpProbe({
              port: loopback,
              healthPath: plannedHealth.healthPath,
              timeoutMs: 3000
            });
            if (result && result.statusCode === plannedHealth.expectedStatus) return last;
          } catch {
            // The bounded loopback endpoint may still be starting.
          }
        }
      }
      if (status === 'exited' || status === 'dead' || health === 'unhealthy') break;
      await wait(500);
    }
    const status = last && last.State && last.State.Status || 'unknown';
    const health = last && last.State && last.State.Health && last.State.Health.Status || 'none';
    throw new StatefulRehearsalError(
      `Candidate health verification failed (state=${status}, health=${health})`,
      503,
      'candidate-health-failed'
    );
  }

  async function sourceHealthProof(containerId, requireHealthy) {
    const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
    const status = details.State && details.State.Status;
    const paused = Boolean(details.State && details.State.Paused);
    const health = details.State && details.State.Health && details.State.Health.Status || null;
    if (status !== 'running' || paused || (requireHealthy && health !== 'healthy')) {
      throw new StatefulRehearsalError('Source did not return to its original healthy running state', 503, 'source-recovery-failed');
    }
    return { status, paused, health, verifiedAt: now() };
  }

  function temporaryNames(operationId, volumes) {
    const suffix = hash(operationId, 12);
    return {
      candidateName: 'foxos-stateful-rehearsal-' + suffix,
      networkName: 'foxos-stateful-rehearsal-' + suffix,
      volumes: volumes.map((volume, index) => ({
        sourceName: volume.name,
        destination: volume.destination,
        policy: volume.policy,
        temporaryName: `foxos-stateful-rehearsal-${suffix}-v${index + 1}`
      }))
    };
  }

  async function removeExactTemporaryResources(operation) {
    const errors = [];
    const temporary = operation.temporary || {};
    if (temporary.candidateName) {
      try {
        await dockerRequest('DELETE', '/containers/' + encodeURIComponent(temporary.candidateName) + '?force=1&v=0');
      } catch (error) {
        if (!/No such container/i.test(error.message)) errors.push('candidate:' + error.message);
      }
    }
    for (const volume of [...(temporary.volumes || [])].reverse()) {
      try {
        await dockerRequest('DELETE', '/volumes/' + encodeURIComponent(volume.temporaryName));
      } catch (error) {
        if (!/no such volume/i.test(error.message)) errors.push('volume:' + error.message);
      }
    }
    if (temporary.networkName) {
      try {
        await dockerRequest('DELETE', '/networks/' + encodeURIComponent(temporary.networkName));
      } catch (error) {
        if (!/not found|no such network/i.test(error.message)) errors.push('network:' + error.message);
      }
    }
    return errors;
  }

  async function unpauseIfRequired(operation) {
    if (!operation.source || !operation.source.pauseRequested || operation.source.pauseState === 'unpaused') return [];
    const errors = [];
    try {
      const details = await dockerRequest('GET', '/containers/' + operation.source.containerId + '/json');
      if (details.State && details.State.Paused) {
        await dockerRequest('POST', '/containers/' + operation.source.containerId + '/unpause');
      }
      operation.source.pauseState = 'unpaused';
      operation.source.unpausedAt = now();
    } catch (error) {
      errors.push('source-unpause:' + error.message);
    }
    return errors;
  }

  async function recoverInterruptedOperations({ clearStaleLock = false } = {}) {
    const lockOwner = acquireOperationLock('startup-recovery', clearStaleLock);
    try {
      const recovered = [];
      for (let operation of listJson(operationsRoot).filter((entry) => entry.status === 'running')) {
        const errors = [];
        errors.push(...await unpauseIfRequired(operation));
        errors.push(...await removeExactTemporaryResources(operation));
        operation = {
          ...operation,
          status: errors.length ? 'interrupted-cleanup-required' : 'interrupted-cleaned',
          completedAt: now(),
          cleanup: {
            completed: errors.length === 0,
            errors,
            replayed: false
          }
        };
        writeOperation(operation);
        recovered.push({ operationId: operation.operationId, status: operation.status });
      }
      return { recovered, replayed: false };
    } finally {
      const releaseError = releaseOperationLock(lockOwner);
      if (releaseError) {
        throw new StatefulRehearsalError('Stateful rehearsal recovery lock cleanup failed', 500, releaseError);
      }
    }
  }

  async function revalidatePlan(plan) {
    const { snapshot, resource } = latestResource(plan.resourceId);
    validateResourceCandidate(resource);
    if (
      currentResourceFingerprint(snapshot, resource) !== plan.resourceFingerprint ||
      resource.runtime.containerId !== plan.sourceContainerId ||
      resource.runtime.imageId !== plan.sourceImageId
    ) {
      throw new StatefulRehearsalError('Workload changed after rehearsal planning', 409, 'rehearsal-plan-stale');
    }
    const source = await inspectSource(resource);
    const currentHealthPlan = healthPlan(source, { httpHealthPath: plan.health.healthPath });
    if (
      source.runtimeFingerprint !== plan.sourceRuntimeFingerprint ||
      source.environmentFingerprint !== plan.environmentFingerprint ||
      source.healthFingerprint !== plan.health.sourceFingerprint ||
      currentHealthPlan.fingerprint !== plan.health.fingerprint
    ) {
      throw new StatefulRehearsalError('Workload runtime changed after rehearsal planning', 409, 'rehearsal-plan-stale');
    }
    const environment = secretManager.getEnvironmentRevision(resource.id);
    if (!environment || environment.revision !== plan.environment.revision) {
      throw new StatefulRehearsalError('Environment revision changed after rehearsal planning', 409, 'rehearsal-plan-stale');
    }
    return { snapshot, resource, source, environment };
  }

  function archiveContext(operation, volume, contentDigest) {
    return {
      purpose: 'foxos-stateful-rehearsal-volume',
      schemaVersion: STATEFUL_REHEARSAL_SCHEMA_VERSION,
      operationId: operation.operationId,
      resourceId: operation.resourceId,
      volumeName: volume.name,
      destination: volume.destination,
      contentDigest
    };
  }

  async function runPlan(planId, confirmation) {
    const plan = getRecord(plansRoot, planId, 'Stateful rehearsal plan');
    if (plan.schemaVersion !== STATEFUL_REHEARSAL_SCHEMA_VERSION) {
      throw new StatefulRehearsalError('Stateful rehearsal plan schema is unsupported', 409, 'unsupported-rehearsal-plan');
    }
    if (confirmation !== plan.confirmation) {
      throw new StatefulRehearsalError('Exact stateful rehearsal run confirmation is required', 400, 'confirmation-required');
    }
    if (activeOperationId) {
      throw new StatefulRehearsalError('Another stateful rehearsal is already running', 409, 'rehearsal-busy');
    }
    if (listJson(operationsRoot).some((operation) => operation.status === 'running')) {
      throw new StatefulRehearsalError(
        'Interrupted stateful rehearsal recovery must complete before a new run',
        409,
        'rehearsal-recovery-required'
      );
    }
    const operationId = 'sro_' + randomUUID().replace(/-/g, '');
    const lockOwner = acquireOperationLock(operationId);
    activeOperationId = operationId;
    let operation = {
      schemaVersion: STATEFUL_REHEARSAL_SCHEMA_VERSION,
      operationId,
      planId: plan.planId,
      resourceId: plan.resourceId,
      resourceFingerprint: plan.resourceFingerprint,
      rehearsalResourceFingerprint: plan.rehearsalResourceFingerprint,
      status: 'running',
      startedAt: now(),
      source: {
        containerId: plan.sourceContainerId,
        imageId: plan.sourceImageId,
        pauseRequested: false,
        pauseState: 'not-requested',
        pauseDurationMs: null,
        stopped: false,
        recreated: false
      },
      environment: {
        revision: plan.environment.revision,
        managedVariableCount: plan.environment.managedVariableCount,
        excludedProviderVariableCount: plan.environment.excludedProviderVariableCount,
        valuesIncluded: false
      },
      temporary: temporaryNames(operationId, plan.volumes),
      backups: [],
      restore: { verified: false, volumes: [] },
      candidate: {
        containerId: null,
        internalNetwork: true,
        hostBinding: '127.0.0.1:dynamic',
        privatePort: plan.privatePort,
        healthMode: plan.health.mode,
        health: null,
        removedAfterProof: false
      },
      cleanup: { completed: false, errors: [], replayed: false },
      guarantees: {
        sourceContainerStopped: false,
        sourceContainerRecreated: false,
        sourcePauseWasTemporary: false,
        routeMutated: false,
        trafficCutover: false,
        providerMetadataMutated: false,
        providerDetached: false,
        candidateHadExternalNetwork: false,
        environmentValuesIncluded: false,
        secretValuesIncluded: false,
        plaintextArchiveStored: false,
        offHostRecoveryProven: false
      }
    };
    try {
      writeOperation(operation);
    } catch (error) {
      releaseOperationLock(lockOwner);
      activeOperationId = null;
      throw error;
    }

    let primaryError = null;
    let sourceWasHealthy = false;
    let pauseStartedAt = 0;
    const plaintextArchives = new Map();
    try {
      const { resource, source, environment } = await revalidatePlan(plan);
      sourceWasHealthy = source.details.State && source.details.State.Health &&
        source.details.State.Health.Status === 'healthy';
      const resolvedEnvironment = secretManager.resolveEnvironment(environment);
      if (resolvedEnvironment.length !== plan.environment.managedVariableCount) {
        throw new StatefulRehearsalError('Resolved environment count does not match the plan', 409, 'environment-resolution-mismatch');
      }

      operation.source.pauseRequested = true;
      operation.source.pauseState = 'requested';
      writeOperation(operation);
      pauseStartedAt = Date.now();
      await dockerRequest('POST', '/containers/' + resource.runtime.containerId + '/pause');
      operation.source.pauseState = 'paused';
      operation.source.pausedAt = now();
      writeOperation(operation);

      try {
        for (const volume of plan.volumes) {
          const archive = await dockerArchiveRequest(
            'GET',
            '/containers/' + resource.runtime.containerId + '/archive?path=' + encodeURIComponent(volume.destination + '/.'),
            null
          );
          if (!Buffer.isBuffer(archive) || archive.length < 1 || archive.length > MAX_REHEARSAL_ARCHIVE_BYTES) {
            throw new StatefulRehearsalError('Volume archive exceeds the rehearsal safety limit', 413, 'volume-archive-size-unsupported');
          }
          if (volume.policy === 'empty-ephemeral') {
            if (tarHasMaterialEntries(archive)) {
              throw new StatefulRehearsalError(
                'A volume classified empty-ephemeral contains material data',
                409,
                'ephemeral-volume-not-empty'
              );
            }
          } else {
            plaintextArchives.set(volume.name, archive);
          }
        }
      } finally {
        await dockerRequest('POST', '/containers/' + resource.runtime.containerId + '/unpause');
        operation.source.pauseState = 'unpaused';
        operation.source.unpausedAt = now();
        operation.source.pauseDurationMs = Math.max(0, Date.now() - pauseStartedAt);
        operation.guarantees.sourcePauseWasTemporary = true;
        writeOperation(operation);
      }

      for (const volume of plan.volumes.filter((entry) => entry.policy === 'persistent')) {
        const archive = plaintextArchives.get(volume.name);
        const contentDigest = tarContentDigest(archive);
        const context = archiveContext(operation, volume, contentDigest);
        const encrypted = encryptionStore.encryptBuffer(archive, context);
        const encryptedDigest = 'sha256:' + hash(encrypted);
        const archiveDirectory = path.join(archivesRoot, operation.operationId);
        const archiveFile = path.join(archiveDirectory, 'volume-' + hash(volume.name, 24) + '.foxosenc');
        encryptionStore.atomicWriteBuffer(archiveFile, encrypted);
        const authenticated = encryptionStore.decryptBuffer(fs.readFileSync(archiveFile), context);
        if (tarContentDigest(authenticated) !== contentDigest) {
          throw new StatefulRehearsalError('Encrypted archive authentication failed', 500, 'archive-authentication-failed');
        }
        operation.backups.push({
          volumeName: volume.name,
          destination: volume.destination,
          archiveFile: path.relative(dataRoot, archiveFile),
          archiveBytes: archive.length,
          encryptedBytes: encrypted.length,
          contentDigest,
          encryptedDigest,
          algorithm: 'aes-256-gcm',
          keyId: encryptionStore.keyId(),
          authenticated: true,
          plaintextStored: false,
          offHost: false
        });
        plaintextArchives.delete(volume.name);
        writeOperation(operation);
      }

      const labels = {
        'com.foxos.temporary': 'stateful-rehearsal',
        'com.foxos.stateful-rehearsal.id': operation.operationId,
        'com.foxos.resource.id': plan.resourceId
      };
      const network = await dockerRequest('POST', '/networks/create', {
        Name: operation.temporary.networkName,
        CheckDuplicate: true,
        Driver: 'bridge',
        Internal: true,
        Attachable: false,
        Labels: labels
      });
      operation.temporary.networkId = network.Id;
      for (const volume of operation.temporary.volumes) {
        await dockerRequest('POST', '/volumes/create', { Name: volume.temporaryName, Labels: labels });
      }

      const sourceDetails = await dockerRequest('GET', '/containers/' + plan.sourceContainerId + '/json');
      const healthcheck = sourceDetails.Config && sourceDetails.Config.Healthcheck;
      const currentHealthFingerprint = encryptionStore.fingerprint(Buffer.from(canonicalJson(healthcheck || null), 'utf8'));
      if (currentHealthFingerprint !== plan.health.sourceFingerprint) {
        throw new StatefulRehearsalError('Health check changed after source unpause', 409, 'rehearsal-plan-stale');
      }
      const portKey = `${plan.privatePort}/tcp`;
      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(operation.temporary.candidateName),
        {
          Image: plan.sourceImageId,
          Env: resolvedEnvironment,
          Labels: labels,
          ExposedPorts: { [portKey]: {} },
          ...(plan.health.mode === 'docker-healthcheck' ? { Healthcheck: healthcheck } : {}),
          HostConfig: {
            Mounts: operation.temporary.volumes.map((volume) => ({
              Type: 'volume',
              Source: volume.temporaryName,
              Target: volume.destination,
              ReadOnly: false,
              VolumeOptions: { NoCopy: true }
            })),
            PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '0' }] },
            RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
            NetworkMode: operation.temporary.networkName,
            SecurityOpt: ['no-new-privileges:true'],
            Memory: plan.candidateResources.memoryBytes,
            NanoCpus: plan.candidateResources.nanoCpus,
            PidsLimit: plan.candidateResources.pidsLimit
          },
          NetworkingConfig: {
            EndpointsConfig: { [operation.temporary.networkName]: {} }
          }
        }
      );
      operation.candidate.containerId = created.Id;
      writeOperation(operation);

      for (const backup of operation.backups) {
        const volume = plan.volumes.find((entry) => entry.name === backup.volumeName);
        const encrypted = fs.readFileSync(path.join(dataRoot, backup.archiveFile));
        const context = archiveContext(operation, volume, backup.contentDigest);
        const archive = encryptionStore.decryptBuffer(encrypted, context);
        await dockerArchiveRequest(
          'PUT',
          '/containers/' + created.Id + '/archive?path=' + encodeURIComponent(volume.destination),
          archive
        );
        const restored = await dockerArchiveRequest(
          'GET',
          '/containers/' + created.Id + '/archive?path=' + encodeURIComponent(volume.destination + '/.'),
          null
        );
        const restoredDigest = tarContentDigest(restored);
        if (restoredDigest !== backup.contentDigest) {
          throw new StatefulRehearsalError('Restored volume digest does not match', 500, 'restore-digest-mismatch');
        }
        operation.restore.volumes.push({
          volumeName: backup.volumeName,
          destination: backup.destination,
          verified: true,
          restoredDigest
        });
      }
      operation.restore.verified = operation.restore.volumes.length === operation.backups.length;
      operation.restore.emptyVolumesRecreated = plan.volumes
        .filter((volume) => volume.policy === 'empty-ephemeral')
        .map((volume) => ({ volumeName: volume.name, destination: volume.destination, recreatedEmpty: true }));
      writeOperation(operation);

      await dockerRequest('POST', '/containers/' + created.Id + '/start');
      const candidateDetails = await waitForHealth(created.Id, plan.health, plan.privatePort);
      const candidateNetworks = Object.keys(candidateDetails.NetworkSettings && candidateDetails.NetworkSettings.Networks || {});
      const bindings = candidateDetails.NetworkSettings && candidateDetails.NetworkSettings.Ports &&
        candidateDetails.NetworkSettings.Ports[portKey] || [];
      if (
        candidateNetworks.length !== 1 || candidateNetworks[0] !== operation.temporary.networkName ||
        bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || !bindings[0].HostPort
      ) {
        throw new StatefulRehearsalError('Candidate isolation proof failed', 500, 'candidate-isolation-failed');
      }
      operation.candidate.health = 'healthy';
      operation.candidate.healthVerifiedAt = now();
      operation.candidate.externalNetwork = false;
      operation.candidate.routeCreated = false;
      operation.source.healthAfterProof = await sourceHealthProof(
        plan.sourceContainerId,
        plan.health.mode === 'docker-healthcheck' && sourceWasHealthy
      );
      writeOperation(operation);
    } catch (error) {
      primaryError = error;
    } finally {
      const unpauseErrors = await unpauseIfRequired(operation);
      const cleanupErrors = await removeExactTemporaryResources(operation);
      const lockError = releaseOperationLock(lockOwner);
      if (lockError) cleanupErrors.push(lockError);
      operation.cleanup = {
        completed: unpauseErrors.length === 0 && cleanupErrors.length === 0,
        errors: [...unpauseErrors, ...cleanupErrors],
        replayed: false
      };
      operation.candidate.removedAfterProof = cleanupErrors.every((entry) => !entry.startsWith('candidate:'));
      operation.completedAt = now();
      if (primaryError) {
        operation.status = operation.cleanup.completed ? 'failed-and-cleaned' : 'failed-cleanup-required';
        operation.failure = {
          code: primaryError.code || 'stateful-rehearsal-error',
          message: primaryError instanceof StatefulRehearsalError
            ? primaryError.message
            : 'Stateful rehearsal operation failed'
        };
      } else if (!operation.cleanup.completed) {
        operation.status = 'verified-cleanup-required';
      } else {
        operation.status = 'verified-and-cleaned';
      }
      writeOperation(operation);
      if (operation.status === 'verified-and-cleaned') {
        atomicWriteJson(path.join(currentRoot, operation.resourceId + '.json'), operation);
      }
      pruneJson(operationsRoot);
      activeOperationId = null;
    }

    if (primaryError) throw primaryError;
    if (!operation.cleanup.completed) {
      throw new StatefulRehearsalError('Stateful rehearsal proof passed but cleanup is incomplete', 500, 'rehearsal-cleanup-incomplete');
    }
    return operation;
  }

  function status() {
    const plans = listJson(plansRoot);
    const operations = listJson(operationsRoot);
    const current = listJson(currentRoot);
    return {
      schemaVersion: STATEFUL_REHEARSAL_SCHEMA_VERSION,
      scope: 'provider-owned-stateful-application-restore-rehearsal',
      plans,
      operations,
      current,
      summary: {
        plans: plans.length,
        operations: operations.length,
        verified: current.length,
        running: operations.filter((operation) => operation.status === 'running').length
      },
      guarantees: {
        sourcePauseIsTemporary: true,
        sourceStopIncluded: false,
        sourceRecreationIncluded: false,
        candidateInternalNetworkOnly: true,
        candidateLoopbackOnly: true,
        routeMutationIncluded: false,
        trafficCutoverIncluded: false,
        providerMutationIncluded: false,
        providerDetachIncluded: false,
        archivesEncryptedLocally: true,
        plaintextArchiveStored: false,
        offHostRecoveryProven: false,
        environmentValuesIncluded: false,
        secretValuesIncluded: false,
        interruptedOperationsReplayed: false
      }
    };
  }

  ensureDirectory(root);
  return {
    createPlan,
    getOperation: (operationId) => getRecord(operationsRoot, operationId, 'Stateful rehearsal operation'),
    getPlan: (planId) => getRecord(plansRoot, planId, 'Stateful rehearsal plan'),
    paths: { archivesRoot, currentRoot, operationLockFile, operationsRoot, plansRoot, root },
    recoverInterruptedOperations,
    runPlan,
    status
  };
}

module.exports = {
  MAX_REHEARSAL_ARCHIVE_BYTES,
  PLAN_STATEFUL_REHEARSAL_CONFIRMATION,
  STATEFUL_REHEARSAL_SCHEMA_VERSION,
  StatefulRehearsalError,
  createStatefulRehearsalManager,
  runConfirmation,
  tarHasMaterialEntries
};
