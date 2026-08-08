const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { tarContentDigest } = require('./adoptionManager');
const {
  statefulRehearsalResourceFingerprint,
  statefulRestoreProofDescriptor
} = require('./applicationManifestManager');
const { atomicWriteJson } = require('./resourceRegistry');
const { defaultHostProbe } = require('./sourceDeploymentManager');

const STATEFUL_SHADOW_SCHEMA_VERSION = 1;
const PLAN_STATEFUL_SHADOW_CONFIRMATION = 'PLAN STATEFUL SHADOW';
const PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION = 'PLAN STATEFUL SHADOW REFRESH';
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const RECORD_ID_PATTERN = /^(ssp|sso|ssrp|ssro)_[a-f0-9]{24,64}$/;
const MAX_RECORDS = 100;
const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
const DEFAULT_NANO_CPUS = 500000000;
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_HEALTH_TIMEOUT_SECONDS = 90;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

class StatefulShadowError extends Error {
  constructor(message, statusCode = 400, code = 'stateful-shadow-error') {
    super(message);
    this.name = 'StatefulShadowError';
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
  return 'RUN STATEFUL SHADOW ' + planId;
}

function refreshConfirmation(planId) {
  return 'REFRESH STATEFUL SHADOW ' + planId;
}

function isNotFound(error) {
  return /not found|no such (?:container|network|volume)/i.test(String(error && error.message || ''));
}

function isPrivateDockerIPv4(value) {
  if (net.isIP(value) !== 4) return false;
  const octets = value.split('.').map(Number);
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
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

function archiveContext(operation, volume, contentDigest) {
  return {
    purpose: 'foxos-stateful-rehearsal-volume',
    schemaVersion: operation.schemaVersion,
    operationId: operation.operationId,
    resourceId: operation.resourceId,
    volumeName: volume.name,
    destination: volume.destination,
    contentDigest
  };
}

function shadowNames(resourceId, volumes) {
  const suffix = hash(resourceId, 12);
  return {
    shadowResourceId: 'res_' + hash('stateful-shadow:' + resourceId, 32),
    containerName: 'foxos-stateful-shadow-' + suffix,
    networkName: 'foxos-stateful-shadow-' + suffix,
    volumes: volumes.map((volume, index) => ({
      sourceName: volume.name,
      destination: volume.destination,
      policy: volume.policy,
      shadowName: `foxos-stateful-shadow-${suffix}-v${index + 1}`
    }))
  };
}

function refreshedShadowNames(resourceId, planId, volumes) {
  const sourceSuffix = hash(resourceId, 12);
  const generationSuffix = hash(planId, 10);
  const prefix = `foxos-stateful-shadow-${sourceSuffix}-r${generationSuffix}`;
  return {
    shadowResourceId: 'res_' + hash('stateful-shadow:' + resourceId, 32),
    containerName: prefix,
    networkName: prefix,
    volumes: volumes.map((volume, index) => ({
      sourceName: volume.name,
      destination: volume.destination,
      policy: volume.policy,
      shadowName: `${prefix}-v${index + 1}`
    }))
  };
}

function createStatefulShadowManager({
  dataRoot,
  dockerRequest,
  dockerArchiveRequest,
  resourceRegistry,
  encryptionStore,
  secretManager,
  statefulRehearsalStatus,
  httpProbe = defaultHostProbe,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerArchiveRequest !== 'function' ||
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    typeof resourceRegistry.scan !== 'function' || !encryptionStore || !secretManager ||
    typeof statefulRehearsalStatus !== 'function' || typeof httpProbe !== 'function'
  ) {
    throw new Error('Stateful shadow manager requires registry, Docker, rehearsal, encryption and secret adapters');
  }

  const root = path.join(dataRoot, 'stateful-shadows');
  const plansRoot = path.join(root, 'plans');
  const operationsRoot = path.join(root, 'operations');
  const currentRoot = path.join(root, 'current');
  const operationLockFile = path.join(root, 'operation.lock');
  let activeOperationId = null;

  function now() {
    return new Date(clock()).toISOString();
  }

  function recordPath(directory, id) {
    if (!RECORD_ID_PATTERN.test(String(id))) {
      throw new StatefulShadowError('Stateful shadow record ID is invalid', 400, 'invalid-shadow-record-id');
    }
    return path.join(directory, id + '.json');
  }

  function getRecord(directory, id, label) {
    const record = readJson(recordPath(directory, id));
    if (!record) throw new StatefulShadowError(label + ' was not found', 404, 'shadow-record-not-found');
    return record;
  }

  function prunePlans() {
    const protectedPlanIds = new Set(listJson(currentRoot).map((current) => current.planId).filter(Boolean));
    const records = listJson(plansRoot).sort((left, right) => (
      String(left.createdAt || '').localeCompare(String(right.createdAt || '')) ||
      String(left.planId || '').localeCompare(String(right.planId || ''))
    ));
    let excess = Math.max(0, records.length - MAX_RECORDS);
    for (const record of records) {
      if (excess === 0) break;
      if (!record.planId || protectedPlanIds.has(record.planId) || !RECORD_ID_PATTERN.test(record.planId)) continue;
      fs.unlinkSync(path.join(plansRoot, record.planId + '.json'));
      excess -= 1;
    }
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
        throw new StatefulShadowError('Another stateful shadow operation owns the process lock', 409, 'stateful-shadow-busy');
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
      throw new StatefulShadowError('FoxOS resource ID is invalid', 400, 'invalid-resource-id');
    }
    const snapshot = resourceRegistry.getLatest();
    if (!snapshot) throw new StatefulShadowError('Run a resource scan first', 409, 'registry-not-scanned');
    const resource = (snapshot.resources || []).find((candidate) => candidate.id === resourceId);
    if (!resource) throw new StatefulShadowError('Resource was not found', 404, 'resource-not-found');
    return { snapshot, resource };
  }

  function rehearsalFor(resource) {
    const rehearsalState = statefulRehearsalStatus();
    const operation = (rehearsalState.current || []).find((candidate) => candidate.resourceId === resource.id);
    const proof = statefulRestoreProofDescriptor(
      operation,
      statefulRehearsalResourceFingerprint(resource),
      resource
    );
    const plan = operation && (rehearsalState.plans || []).find((candidate) => candidate.planId === operation.planId);
    if (!proof || !plan || !Array.isArray(plan.volumes) || !plan.volumes.length) {
      throw new StatefulShadowError(
        'A current verified FoxOS stateful restore rehearsal is required',
        409,
        'stateful-rehearsal-proof-missing'
      );
    }
    return { operation, plan, proof };
  }

  function environmentFor(resource, rehearsalOperation) {
    const environment = secretManager.getEnvironmentRevision(resource.id);
    if (!environment || environment.revision !== rehearsalOperation.environment.revision) {
      throw new StatefulShadowError('The FoxOS environment revision differs from the rehearsal', 409, 'environment-revision-mismatch');
    }
    const managedCount = (environment.ordinary || []).length + (environment.secretRefs || []).length;
    if (managedCount !== rehearsalOperation.environment.managedVariableCount) {
      throw new StatefulShadowError('The managed environment count differs from the rehearsal', 409, 'environment-revision-mismatch');
    }
    return environment;
  }

  function backupForVolume(operation, volume) {
    if (volume.policy === 'empty-ephemeral') return null;
    const backup = (operation.backups || []).find((candidate) => (
      candidate.volumeName === volume.name && candidate.destination === volume.destination
    ));
    if (
      !backup || backup.authenticated !== true || backup.plaintextStored !== false ||
      !backup.archiveFile || !backup.contentDigest || !backup.encryptedDigest
    ) {
      throw new StatefulShadowError('A persistent volume has no authenticated rehearsal archive', 409, 'volume-backup-missing');
    }
    const archiveFile = path.resolve(dataRoot, backup.archiveFile);
    if (!archiveFile.startsWith(dataRoot + path.sep)) {
      throw new StatefulShadowError('Rehearsal archive path escapes the FoxOS data root', 409, 'unsafe-archive-path');
    }
    let stat;
    try {
      stat = fs.statSync(archiveFile);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new StatefulShadowError('Rehearsal archive is missing', 409, 'volume-backup-missing');
      }
      throw error;
    }
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES + 1024 * 1024) {
      throw new StatefulShadowError('Rehearsal archive size is outside the shadow policy', 409, 'unsupported-archive-size');
    }
    return { ...backup, archiveFile };
  }

  function verifyCurrentRecord(record, snapshot = resourceRegistry.getLatest()) {
    const resource = snapshot && (snapshot.resources || []).find((candidate) => (
      candidate.id === record.shadowResourceId && candidate.runtime &&
      candidate.runtime.containerId === record.shadow.containerId
    ));
    const constraints = resource && resource.runtime && resource.runtime.constraints || {};
    const expectedMounts = (record.shadow.volumes || []).map((volume) => (
      `${volume.shadowName}:${volume.destination}:false`
    )).sort();
    const actualMounts = resource ? (resource.mounts || []).map((mount) => (
      `${mount.name}:${mount.destination}:${Boolean(mount.readOnly)}`
    )).sort() : [];
    const verified = Boolean(
      resource && resource.provider === 'foxos' && resource.ownership === 'foxos-managed' &&
      resource.runtime.state === 'running' && resource.runtime.restartPolicy === 'unless-stopped' &&
      constraints.memoryBytes === record.runtimeLimits.memoryBytes &&
      constraints.nanoCpus === record.runtimeLimits.nanoCpus &&
      constraints.pidsLimit === record.runtimeLimits.pidsLimit &&
      constraints.privileged === false && constraints.noNewPrivileges === true &&
      (resource.ports || []).every((port) => !port.hostPort) && !(resource.routes || []).length &&
      (resource.networks || []).length === 1 && resource.networks[0].name === record.shadow.networkName &&
      canonicalJson(actualMounts) === canonicalJson(expectedMounts)
    );
    return {
      verified,
      snapshotId: snapshot && snapshot.snapshotId || null,
      observedAt: snapshot && (snapshot.generatedAt || snapshot.observedAt) || null,
      resourceId: resource && resource.id || null,
      containerId: resource && resource.runtime.containerId || null
    };
  }

  function currentRecords() {
    return listJson(currentRoot).map((record) => ({
      ...record,
      registryProof: verifyCurrentRecord(record)
    }));
  }

  function shadowRecordFingerprint(record) {
    return 'sha256:' + hash(canonicalJson({
      operationId: record.operationId,
      sourceResourceId: record.sourceResourceId,
      sourceResourceFingerprint: record.sourceResourceFingerprint,
      shadowResourceId: record.shadowResourceId,
      rehearsalOperationId: record.rehearsal && record.rehearsal.operationId,
      environmentRevision: record.environment && record.environment.revision,
      runtimeLimits: record.runtimeLimits,
      shadow: record.shadow && {
        containerId: record.shadow.containerId,
        containerName: record.shadow.containerName,
        networkName: record.shadow.networkName,
        volumes: record.shadow.volumes,
        volumesRestored: record.shadow.volumesRestored,
        health: record.shadow.health
      }
    }));
  }

  function verifiedCurrentFor(resourceId) {
    const current = currentRecords().find((candidate) => candidate.sourceResourceId === resourceId);
    if (!current) {
      throw new StatefulShadowError('A current FoxOS stateful shadow is required', 409, 'stateful-shadow-current-missing');
    }
    if (current.status !== 'active' || !current.registryProof.verified) {
      throw new StatefulShadowError(
        'The current FoxOS stateful shadow must be healthy before refresh',
        409,
        'stateful-shadow-current-stale'
      );
    }
    return current;
  }

  async function createPlan(input = {}) {
    if (input.confirmation !== PLAN_STATEFUL_SHADOW_CONFIRMATION) {
      throw new StatefulShadowError('Exact stateful shadow planning confirmation is required', 400, 'confirmation-required');
    }
    const { snapshot, resource } = latestResource(input.resourceId);
    const existing = currentRecords().find((candidate) => candidate.sourceResourceId === resource.id);
    if (existing) {
      throw new StatefulShadowError(
        existing.registryProof.verified
          ? 'A current FoxOS stateful shadow already exists for this resource'
          : 'The recorded stateful shadow needs recovery before it can be replaced',
        409,
        existing.registryProof.verified ? 'stateful-shadow-already-active' : 'stateful-shadow-recovery-required'
      );
    }
    const rehearsal = rehearsalFor(resource);
    const environment = environmentFor(resource, rehearsal.operation);
    const names = shadowNames(resource.id, rehearsal.plan.volumes);
    const volumes = rehearsal.plan.volumes.map((volume) => ({
      name: volume.name,
      destination: volume.destination,
      policy: volume.policy,
      backup: backupForVolume(rehearsal.operation, volume)
    }));
    const planId = 'ssp_' + randomUUID().replace(/-/g, '');
    const plan = {
      schemaVersion: STATEFUL_SHADOW_SCHEMA_VERSION,
      action: 'create',
      planId,
      sourceResourceId: resource.id,
      sourceResourceName: resource.name,
      sourceProvider: resource.provider,
      sourceContainerId: resource.runtime.containerId,
      sourceImageId: resource.runtime.imageId,
      sourceResourceFingerprint: statefulRehearsalResourceFingerprint(resource),
      registrySnapshotId: snapshot.snapshotId,
      rehearsal: {
        operationId: rehearsal.operation.operationId,
        planId: rehearsal.plan.planId,
        verifiedAt: rehearsal.proof.verifiedAt,
        snapshotAt: rehearsal.operation.completedAt,
        sourceEnvironmentFingerprint: rehearsal.plan.environmentFingerprint,
        sourceHealthFingerprint: rehearsal.plan.health.sourceFingerprint
      },
      environment: {
        revision: environment.revision,
        managedVariableCount: rehearsal.operation.environment.managedVariableCount,
        excludedProviderVariableCount: rehearsal.operation.environment.excludedProviderVariableCount,
        valuesIncluded: false
      },
      volumes: volumes.map((volume) => ({
        name: volume.name,
        destination: volume.destination,
        policy: volume.policy,
        backup: volume.backup ? {
          archiveFile: path.relative(dataRoot, volume.backup.archiveFile),
          contentDigest: volume.backup.contentDigest,
          encryptedDigest: volume.backup.encryptedDigest,
          keyId: volume.backup.keyId,
          authenticated: true,
          plaintextStored: false
        } : null
      })),
      health: rehearsal.plan.health,
      privatePort: rehearsal.plan.privatePort,
      shadow: names,
      runtimeLimits: {
        memoryBytes: DEFAULT_MEMORY_BYTES,
        nanoCpus: DEFAULT_NANO_CPUS,
        pidsLimit: DEFAULT_PIDS_LIMIT
      },
      confirmation: runConfirmation(planId),
      createdAt: now(),
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
    atomicWriteJson(recordPath(plansRoot, planId), plan);
    prunePlans();
    return plan;
  }

  async function createRefreshPlan(input = {}) {
    if (input.confirmation !== PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION) {
      throw new StatefulShadowError(
        'Exact stateful shadow refresh planning confirmation is required',
        400,
        'confirmation-required'
      );
    }
    const { snapshot, resource } = latestResource(input.resourceId);
    const current = verifiedCurrentFor(resource.id);
    const rehearsal = rehearsalFor(resource);
    const currentSnapshotAt = Date.parse(String(current.rehearsal && current.rehearsal.snapshotAt || ''));
    const rehearsalSnapshotAt = Date.parse(String(rehearsal.operation.completedAt || ''));
    if (
      rehearsal.operation.operationId === (current.rehearsal && current.rehearsal.operationId) ||
      !Number.isFinite(currentSnapshotAt) || !Number.isFinite(rehearsalSnapshotAt) ||
      rehearsalSnapshotAt <= currentSnapshotAt
    ) {
      throw new StatefulShadowError(
        'A newer verified stateful rehearsal is required before shadow refresh',
        409,
        'newer-stateful-rehearsal-required'
      );
    }
    if (
      current.sourceResourceFingerprint !== statefulRehearsalResourceFingerprint(resource) ||
      !current.source || current.source.containerId !== resource.runtime.containerId ||
      current.source.imageId !== resource.runtime.imageId
    ) {
      throw new StatefulShadowError(
        'Source identity changed after the current shadow generation',
        409,
        'stateful-shadow-refresh-source-drift'
      );
    }
    const environment = environmentFor(resource, rehearsal.operation);
    if (!current.environment || current.environment.revision !== environment.revision) {
      throw new StatefulShadowError(
        'Environment revision changed after the current shadow generation',
        409,
        'stateful-shadow-refresh-environment-drift'
      );
    }
    const currentVolumes = (current.shadow.volumes || []).map((volume) => ({
      name: volume.sourceName,
      destination: volume.destination,
      policy: volume.policy
    }));
    const rehearsalVolumes = rehearsal.plan.volumes.map((volume) => ({
      name: volume.name,
      destination: volume.destination,
      policy: volume.policy
    }));
    if (canonicalJson(currentVolumes) !== canonicalJson(rehearsalVolumes)) {
      throw new StatefulShadowError(
        'Volume classification changed after the current shadow generation',
        409,
        'stateful-shadow-refresh-volume-drift'
      );
    }
    const planId = 'ssrp_' + randomUUID().replace(/-/g, '');
    const names = refreshedShadowNames(resource.id, planId, rehearsal.plan.volumes);
    if (names.shadowResourceId !== current.shadowResourceId) {
      throw new StatefulShadowError('Stable shadow resource identity changed', 500, 'stateful-shadow-identity-drift');
    }
    const volumes = rehearsal.plan.volumes.map((volume) => ({
      name: volume.name,
      destination: volume.destination,
      policy: volume.policy,
      backup: backupForVolume(rehearsal.operation, volume)
    }));
    const plan = {
      schemaVersion: STATEFUL_SHADOW_SCHEMA_VERSION,
      action: 'refresh',
      planId,
      sourceResourceId: resource.id,
      sourceResourceName: resource.name,
      sourceProvider: resource.provider,
      sourceContainerId: resource.runtime.containerId,
      sourceImageId: resource.runtime.imageId,
      sourceResourceFingerprint: statefulRehearsalResourceFingerprint(resource),
      registrySnapshotId: snapshot.snapshotId,
      previous: {
        operationId: current.operationId,
        shadowResourceId: current.shadowResourceId,
        shadowContainerId: current.shadow.containerId,
        shadowContainerName: current.shadow.containerName,
        shadowNetworkName: current.shadow.networkName,
        rehearsalOperationId: current.rehearsal.operationId,
        snapshotAt: current.rehearsal.snapshotAt,
        fingerprint: shadowRecordFingerprint(current)
      },
      rehearsal: {
        operationId: rehearsal.operation.operationId,
        planId: rehearsal.plan.planId,
        verifiedAt: rehearsal.proof.verifiedAt,
        snapshotAt: rehearsal.operation.completedAt,
        sourceEnvironmentFingerprint: rehearsal.plan.environmentFingerprint,
        sourceHealthFingerprint: rehearsal.plan.health.sourceFingerprint
      },
      environment: {
        revision: environment.revision,
        managedVariableCount: rehearsal.operation.environment.managedVariableCount,
        excludedProviderVariableCount: rehearsal.operation.environment.excludedProviderVariableCount,
        valuesIncluded: false
      },
      volumes: volumes.map((volume) => ({
        name: volume.name,
        destination: volume.destination,
        policy: volume.policy,
        backup: volume.backup ? {
          archiveFile: path.relative(dataRoot, volume.backup.archiveFile),
          contentDigest: volume.backup.contentDigest,
          encryptedDigest: volume.backup.encryptedDigest,
          keyId: volume.backup.keyId,
          authenticated: true,
          plaintextStored: false
        } : null
      })),
      health: rehearsal.plan.health,
      privatePort: rehearsal.plan.privatePort,
      shadow: names,
      runtimeLimits: { ...current.runtimeLimits },
      confirmation: refreshConfirmation(planId),
      createdAt: now(),
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
        previousShadowPreservedUntilCandidateRegistryProof: true,
        inPlaceVolumeMutation: false,
        newerRehearsalRequired: true,
        finalSynchronizationProven: false,
        sourceWritesMayContinueAfterSnapshot: true,
        offHostRecoveryProven: false,
        environmentValuesIncluded: false,
        secretValuesIncluded: false
      }
    };
    atomicWriteJson(recordPath(plansRoot, planId), plan);
    prunePlans();
    return plan;
  }

  async function inspectSource(plan) {
    const details = await dockerRequest('GET', '/containers/' + plan.sourceContainerId + '/json');
    if (
      !details || details.Id !== plan.sourceContainerId || details.Image !== plan.sourceImageId ||
      !details.State || details.State.Status !== 'running' || details.State.Paused
    ) {
      throw new StatefulShadowError('Source runtime changed or is not running', 409, 'shadow-plan-stale');
    }
    const environment = details.Config && details.Config.Env;
    if (!Array.isArray(environment) || secretManager.fingerprintEnvironment(environment) !== plan.rehearsal.sourceEnvironmentFingerprint) {
      throw new StatefulShadowError('Source environment changed after the rehearsal', 409, 'shadow-plan-stale');
    }
    const healthcheck = details.Config && details.Config.Healthcheck || null;
    const healthFingerprint = encryptionStore.fingerprint(Buffer.from(canonicalJson(healthcheck), 'utf8'));
    if (healthFingerprint !== plan.rehearsal.sourceHealthFingerprint) {
      throw new StatefulShadowError('Source health contract changed after the rehearsal', 409, 'shadow-plan-stale');
    }
    return { details, healthcheck };
  }

  async function revalidatePlan(plan) {
    const { resource } = latestResource(plan.sourceResourceId);
    if (
      resource.runtime.containerId !== plan.sourceContainerId ||
      resource.runtime.imageId !== plan.sourceImageId ||
      statefulRehearsalResourceFingerprint(resource) !== plan.sourceResourceFingerprint
    ) {
      throw new StatefulShadowError('Source workload changed after shadow planning', 409, 'shadow-plan-stale');
    }
    const rehearsal = rehearsalFor(resource);
    if (rehearsal.operation.operationId !== plan.rehearsal.operationId) {
      throw new StatefulShadowError('The current restore rehearsal changed after shadow planning', 409, 'shadow-plan-stale');
    }
    const environment = environmentFor(resource, rehearsal.operation);
    if (environment.revision !== plan.environment.revision) {
      throw new StatefulShadowError('Environment revision changed after shadow planning', 409, 'shadow-plan-stale');
    }
    const source = await inspectSource(plan);
    return { resource, rehearsal, environment, source };
  }

  async function inspectCurrentShadow(current) {
    const currentPlan = getRecord(plansRoot, current.planId, 'Current stateful shadow plan');
    const details = await waitForHealth(
      current.shadow.containerId,
      currentPlan.health,
      currentPlan.privatePort,
      current.shadow.networkName
    );
    const labels = details.Config && details.Config.Labels || {};
    const networks = Object.keys(details.NetworkSettings && details.NetworkSettings.Networks || {});
    const bindings = details.NetworkSettings && details.NetworkSettings.Ports &&
      details.NetworkSettings.Ports[currentPlan.privatePort + '/tcp'] || [];
    if (
      details.Id !== current.shadow.containerId || details.State && details.State.Status !== 'running' ||
      labels['com.foxos.stateful-shadow.operation'] !== current.shadow.ownerOperationId ||
      labels['com.foxos.resource.id'] !== current.shadowResourceId ||
      networks.length !== 1 || networks[0] !== current.shadow.networkName || bindings.length !== 0
    ) {
      throw new StatefulShadowError(
        'The current stateful shadow runtime changed before refresh',
        409,
        'stateful-shadow-current-drift'
      );
    }
    return details;
  }

  async function revalidateRefreshPlan(plan) {
    const { resource } = latestResource(plan.sourceResourceId);
    if (
      plan.action !== 'refresh' || resource.runtime.containerId !== plan.sourceContainerId ||
      resource.runtime.imageId !== plan.sourceImageId ||
      statefulRehearsalResourceFingerprint(resource) !== plan.sourceResourceFingerprint
    ) {
      throw new StatefulShadowError('Source workload changed after refresh planning', 409, 'shadow-refresh-plan-stale');
    }
    const current = verifiedCurrentFor(resource.id);
    if (
      current.operationId !== plan.previous.operationId ||
      current.shadow.containerId !== plan.previous.shadowContainerId ||
      current.shadowResourceId !== plan.previous.shadowResourceId ||
      shadowRecordFingerprint(current) !== plan.previous.fingerprint
    ) {
      throw new StatefulShadowError('Current shadow changed after refresh planning', 409, 'shadow-refresh-plan-stale');
    }
    const rehearsal = rehearsalFor(resource);
    if (rehearsal.operation.operationId !== plan.rehearsal.operationId) {
      throw new StatefulShadowError('The current restore rehearsal changed after refresh planning', 409, 'shadow-refresh-plan-stale');
    }
    const environment = environmentFor(resource, rehearsal.operation);
    if (environment.revision !== plan.environment.revision) {
      throw new StatefulShadowError('Environment revision changed after refresh planning', 409, 'shadow-refresh-plan-stale');
    }
    const source = await inspectSource(plan);
    await inspectCurrentShadow(current);
    if (
      plan.shadow.containerName === current.shadow.containerName ||
      plan.shadow.networkName === current.shadow.networkName ||
      plan.shadow.volumes.some((volume) => (
        (current.shadow.volumes || []).some((previous) => previous.shadowName === volume.shadowName)
      ))
    ) {
      throw new StatefulShadowError('Refresh candidate must use separate Docker objects', 500, 'shadow-refresh-name-collision');
    }
    return { resource, current, rehearsal, environment, source };
  }

  async function ensureResourceAbsent(type, name, requestPath) {
    try {
      await dockerRequest('GET', requestPath);
      throw new StatefulShadowError(`Stateful shadow ${type} already exists: ${name}`, 409, 'shadow-resource-already-exists');
    } catch (error) {
      if (error instanceof StatefulShadowError) throw error;
      if (!isNotFound(error)) throw error;
    }
  }

  async function ensureShadowResourcesAbsent(plan) {
    await ensureResourceAbsent('container', plan.shadow.containerName, '/containers/' + encodeURIComponent(plan.shadow.containerName) + '/json');
    await ensureResourceAbsent('network', plan.shadow.networkName, '/networks/' + encodeURIComponent(plan.shadow.networkName));
    for (const volume of plan.shadow.volumes) {
      await ensureResourceAbsent('volume', volume.shadowName, '/volumes/' + encodeURIComponent(volume.shadowName));
    }
  }

  async function removeExactResources(shadow) {
    const errors = [];
    const created = shadow.created || { container: false, network: false, volumes: [] };
    const ownerOperationId = shadow.ownerOperationId;
    async function owned(requestPath, type) {
      try {
        const details = await dockerRequest('GET', requestPath);
        const labels = type === 'container'
          ? details && details.Config && details.Config.Labels || {}
          : details && details.Labels || {};
        if (labels['com.foxos.stateful-shadow.operation'] !== ownerOperationId) {
          errors.push(type + ':ownership-mismatch');
          return false;
        }
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        errors.push(type + '-inspection:' + error.message);
        return false;
      }
    }
    if (created.container) {
      const containerPath = '/containers/' + encodeURIComponent(shadow.containerName);
      if (await owned(containerPath + '/json', 'container')) {
        try {
          await dockerRequest('DELETE', containerPath + '?force=1&v=0');
        } catch (error) {
          if (!isNotFound(error)) errors.push('container:' + error.message);
        }
      }
    }
    const createdVolumes = new Set(created.volumes || []);
    for (const volume of [...(shadow.volumes || [])].reverse().filter((candidate) => createdVolumes.has(candidate.shadowName))) {
      const volumePath = '/volumes/' + encodeURIComponent(volume.shadowName);
      if (await owned(volumePath, 'volume')) {
        try {
          await dockerRequest('DELETE', volumePath);
        } catch (error) {
          if (!isNotFound(error)) errors.push('volume:' + error.message);
        }
      }
    }
    if (created.network) {
      const networkPath = '/networks/' + encodeURIComponent(shadow.networkName);
      if (await owned(networkPath, 'network')) {
        try {
          await dockerRequest('DELETE', networkPath);
        } catch (error) {
          if (!isNotFound(error)) errors.push('network:' + error.message);
        }
      }
    }
    return errors;
  }

  async function waitForHealth(containerId, plannedHealth, privatePort, networkName) {
    const deadline = Date.now() + DEFAULT_HEALTH_TIMEOUT_SECONDS * 1000;
    let last = null;
    while (Date.now() < deadline) {
      last = await dockerRequest('GET', '/containers/' + containerId + '/json');
      const status = last.State && last.State.Status;
      const health = last.State && last.State.Health && last.State.Health.Status;
      if (plannedHealth.mode === 'docker-healthcheck' && status === 'running' && health === 'healthy') return last;
      if (plannedHealth.mode === 'internal-http' && status === 'running') {
        const bindings = last.NetworkSettings && last.NetworkSettings.Ports &&
          last.NetworkSettings.Ports[privatePort + '/tcp'] || [];
        const endpoint = last.NetworkSettings && last.NetworkSettings.Networks &&
          last.NetworkSettings.Networks[networkName];
        const address = endpoint && endpoint.IPAddress || '';
        if (isPrivateDockerIPv4(address) && bindings.length === 0) {
          try {
            const result = await httpProbe({
              host: address,
              port: privatePort,
              healthPath: plannedHealth.healthPath,
              timeoutMs: 3000
            });
            if (result && result.statusCode === plannedHealth.expectedStatus) return last;
          } catch {
            // Keep the probe bounded until the health deadline.
          }
        }
      }
      if (status === 'exited' || status === 'dead' || health === 'unhealthy') break;
      await wait(500);
    }
    const status = last && last.State && last.State.Status || 'unknown';
    const health = last && last.State && last.State.Health && last.State.Health.Status || 'none';
    throw new StatefulShadowError(
      `Stateful shadow health verification failed (state=${status}, health=${health})`,
      503,
      'shadow-health-failed'
    );
  }

  function decryptArchive(plan, rehearsalOperation, volume) {
    if (!volume.backup) return null;
    const archiveFile = path.resolve(dataRoot, volume.backup.archiveFile);
    const encrypted = fs.readFileSync(archiveFile);
    if ('sha256:' + hash(encrypted) !== volume.backup.encryptedDigest) {
      throw new StatefulShadowError('Encrypted rehearsal archive digest differs from the plan', 409, 'archive-digest-mismatch');
    }
    const sourceVolume = { name: volume.name, destination: volume.destination };
    const context = archiveContext(rehearsalOperation, sourceVolume, volume.backup.contentDigest);
    const archive = encryptionStore.decryptBuffer(encrypted, context);
    if (archive.length < 1 || archive.length > MAX_ARCHIVE_BYTES || tarContentDigest(archive) !== volume.backup.contentDigest) {
      throw new StatefulShadowError('Authenticated rehearsal archive content differs from the plan', 409, 'archive-content-mismatch');
    }
    return archive;
  }

  async function materializeShadowCandidate(plan, operation, rehearsal, environment, source) {
    await ensureShadowResourcesAbsent(plan);
    const resolvedEnvironment = secretManager.resolveEnvironment(environment);
    if (resolvedEnvironment.length !== plan.environment.managedVariableCount) {
      throw new StatefulShadowError('Resolved environment count differs from the plan', 409, 'environment-resolution-mismatch');
    }

    const labels = {
      'com.foxos.managed': 'true',
      'com.foxos.stateful-shadow': 'true',
      'com.foxos.stateful-shadow.source-resource-id': plan.sourceResourceId,
      'com.foxos.stateful-shadow.operation': operation.operationId,
      'com.foxos.resource.id': plan.shadow.shadowResourceId
    };
    operation.shadow.created.network = true;
    writeOperation(operation);
    const network = await dockerRequest('POST', '/networks/create', {
      Name: plan.shadow.networkName,
      CheckDuplicate: true,
      Driver: 'bridge',
      Internal: true,
      Attachable: false,
      Labels: labels
    });
    operation.shadow.networkId = network.Id;
    writeOperation(operation);
    const networkDetails = await dockerRequest('GET', '/networks/' + encodeURIComponent(network.Id));
    if (
      !networkDetails || networkDetails.Id !== network.Id ||
      networkDetails.Name !== plan.shadow.networkName || networkDetails.Internal !== true ||
      !networkDetails.Labels ||
      networkDetails.Labels['com.foxos.stateful-shadow.operation'] !== operation.operationId
    ) {
      throw new StatefulShadowError('Stateful shadow network is not internal', 500, 'shadow-network-not-internal');
    }
    operation.shadow.internalNetworkVerified = true;
    writeOperation(operation);

    for (const volume of plan.shadow.volumes) {
      operation.shadow.created.volumes.push(volume.shadowName);
      writeOperation(operation);
      await dockerRequest('POST', '/volumes/create', { Name: volume.shadowName, Labels: labels });
      const volumeDetails = await dockerRequest('GET', '/volumes/' + encodeURIComponent(volume.shadowName));
      if (
        !volumeDetails || volumeDetails.Name !== volume.shadowName || !volumeDetails.Labels ||
        volumeDetails.Labels['com.foxos.stateful-shadow.operation'] !== operation.operationId
      ) {
        throw new StatefulShadowError('Stateful shadow volume ownership verification failed', 500, 'shadow-volume-ownership-failed');
      }
    }

    const portKey = `${plan.privatePort}/tcp`;
    operation.shadow.created.container = true;
    writeOperation(operation);
    const created = await dockerRequest(
      'POST',
      '/containers/create?name=' + encodeURIComponent(plan.shadow.containerName),
      {
        Image: plan.sourceImageId,
        Env: resolvedEnvironment,
        Labels: labels,
        ExposedPorts: { [portKey]: {} },
        ...(plan.health.mode === 'docker-healthcheck' ? { Healthcheck: source.healthcheck } : {}),
        HostConfig: {
          Mounts: plan.shadow.volumes.map((volume) => ({
            Type: 'volume',
            Source: volume.shadowName,
            Target: volume.destination,
            ReadOnly: false,
            VolumeOptions: { NoCopy: true }
          })),
          RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
          NetworkMode: plan.shadow.networkName,
          SecurityOpt: ['no-new-privileges:true'],
          Memory: plan.runtimeLimits.memoryBytes,
          NanoCpus: plan.runtimeLimits.nanoCpus,
          PidsLimit: plan.runtimeLimits.pidsLimit
        },
        NetworkingConfig: { EndpointsConfig: { [plan.shadow.networkName]: {} } }
      }
    );
    operation.shadow.containerId = created.Id;
    writeOperation(operation);

    for (const volume of plan.volumes) {
      if (volume.policy === 'empty-ephemeral') {
        operation.shadow.volumesRestored.push({
          sourceName: volume.name,
          destination: volume.destination,
          policy: volume.policy,
          restored: true,
          recreatedEmpty: true
        });
        continue;
      }
      const archive = decryptArchive(plan, rehearsal.operation, volume);
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
      if (restoredDigest !== volume.backup.contentDigest) {
        throw new StatefulShadowError('Stateful shadow restored data digest does not match', 500, 'shadow-restore-digest-mismatch');
      }
      operation.shadow.volumesRestored.push({
        sourceName: volume.name,
        destination: volume.destination,
        policy: volume.policy,
        restored: true,
        contentDigest: restoredDigest
      });
    }
    writeOperation(operation);

    await dockerRequest('POST', '/containers/' + created.Id + '/start');
    const details = await waitForHealth(created.Id, plan.health, plan.privatePort, plan.shadow.networkName);
    const networks = Object.keys(details.NetworkSettings && details.NetworkSettings.Networks || {});
    const bindings = details.NetworkSettings && details.NetworkSettings.Ports &&
      details.NetworkSettings.Ports[portKey] || [];
    const endpoint = details.NetworkSettings && details.NetworkSettings.Networks &&
      details.NetworkSettings.Networks[plan.shadow.networkName];
    const host = details.HostConfig || {};
    const observedLabels = details.Config && details.Config.Labels || {};
    if (
      networks.length !== 1 || networks[0] !== plan.shadow.networkName ||
      bindings.length !== 0 || !endpoint || !isPrivateDockerIPv4(endpoint.IPAddress) ||
      !host.RestartPolicy || host.RestartPolicy.Name !== 'unless-stopped' ||
      host.Memory !== plan.runtimeLimits.memoryBytes || host.NanoCpus !== plan.runtimeLimits.nanoCpus ||
      host.PidsLimit !== plan.runtimeLimits.pidsLimit || host.Privileged ||
      !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges:true') ||
      observedLabels['com.foxos.managed'] !== 'true' ||
      observedLabels['com.foxos.stateful-shadow'] !== 'true' ||
      observedLabels['com.foxos.resource.id'] !== plan.shadow.shadowResourceId ||
      observedLabels['com.foxos.stateful-shadow.source-resource-id'] !== plan.sourceResourceId ||
      observedLabels['com.foxos.stateful-shadow.operation'] !== operation.operationId
    ) {
      throw new StatefulShadowError('Stateful shadow isolation or runtime verification failed', 500, 'shadow-runtime-verification-failed');
    }
    operation.shadow.health = {
      verified: true,
      mode: plan.health.mode,
      privatePort: plan.privatePort,
      hostPortPublished: false,
      internalAddressObserved: true,
      verifiedAt: now()
    };
    operation.shadow.hostPortPublished = false;
    operation.shadow.externalNetwork = false;
    operation.shadow.routeCreated = false;
    writeOperation(operation);
    return details;
  }

  async function runPlan(planId, confirmation) {
    const plan = getRecord(plansRoot, planId, 'Stateful shadow plan');
    if (plan.schemaVersion !== STATEFUL_SHADOW_SCHEMA_VERSION || plan.action === 'refresh') {
      throw new StatefulShadowError('Stateful shadow plan schema is unsupported', 409, 'unsupported-shadow-plan');
    }
    if (confirmation !== plan.confirmation) {
      throw new StatefulShadowError('Exact stateful shadow run confirmation is required', 400, 'confirmation-required');
    }
    if (activeOperationId || listJson(operationsRoot).some((operation) => operation.status === 'running')) {
      throw new StatefulShadowError('Another stateful shadow operation is already running', 409, 'stateful-shadow-busy');
    }
    if (currentRecords().some((candidate) => candidate.sourceResourceId === plan.sourceResourceId)) {
      throw new StatefulShadowError('A recorded stateful shadow already exists for this resource', 409, 'stateful-shadow-already-active');
    }

    const operationId = 'sso_' + randomUUID().replace(/-/g, '');
    const lockOwner = acquireOperationLock(operationId);
    let lockReleased = false;
    activeOperationId = operationId;
    let operation = {
      schemaVersion: STATEFUL_SHADOW_SCHEMA_VERSION,
      operationId,
      planId: plan.planId,
      sourceResourceId: plan.sourceResourceId,
      sourceResourceFingerprint: plan.sourceResourceFingerprint,
      shadowResourceId: plan.shadow.shadowResourceId,
      status: 'running',
      startedAt: now(),
      source: {
        containerId: plan.sourceContainerId,
        imageId: plan.sourceImageId,
        mutated: false,
        paused: false,
        stopped: false,
        recreated: false
      },
      rehearsal: plan.rehearsal,
      environment: plan.environment,
      runtimeLimits: plan.runtimeLimits,
      shadow: {
        ...plan.shadow,
        containerId: null,
        internalNetworkVerified: false,
        volumesRestored: [],
        health: null,
        hostPortPublished: false,
        externalNetwork: false,
        routeCreated: false,
        ownerOperationId: operationId,
        created: { container: false, network: false, volumes: [] }
      },
      cleanup: { attempted: false, completed: false, errors: [] },
      guarantees: { ...plan.guarantees }
    };
    try {
      writeOperation(operation);
    } catch (error) {
      releaseOperationLock(lockOwner);
      activeOperationId = null;
      throw error;
    }

    let primaryError = null;
    try {
      const { rehearsal, environment, source } = await revalidatePlan(plan);
      await ensureShadowResourcesAbsent(plan);
      const resolvedEnvironment = secretManager.resolveEnvironment(environment);
      if (resolvedEnvironment.length !== plan.environment.managedVariableCount) {
        throw new StatefulShadowError('Resolved environment count differs from the plan', 409, 'environment-resolution-mismatch');
      }

      const labels = {
        'com.foxos.managed': 'true',
        'com.foxos.stateful-shadow': 'true',
        'com.foxos.stateful-shadow.source-resource-id': plan.sourceResourceId,
        'com.foxos.stateful-shadow.operation': operation.operationId,
        'com.foxos.resource.id': plan.shadow.shadowResourceId
      };
      operation.shadow.created.network = true;
      writeOperation(operation);
      const network = await dockerRequest('POST', '/networks/create', {
        Name: plan.shadow.networkName,
        CheckDuplicate: true,
        Driver: 'bridge',
        Internal: true,
        Attachable: false,
        Labels: labels
      });
      operation.shadow.networkId = network.Id;
      writeOperation(operation);
      const networkDetails = await dockerRequest('GET', '/networks/' + encodeURIComponent(network.Id));
      if (
        !networkDetails || networkDetails.Id !== network.Id ||
        networkDetails.Name !== plan.shadow.networkName || networkDetails.Internal !== true ||
        !networkDetails.Labels ||
        networkDetails.Labels['com.foxos.stateful-shadow.operation'] !== operation.operationId
      ) {
        throw new StatefulShadowError('Stateful shadow network is not internal', 500, 'shadow-network-not-internal');
      }
      operation.shadow.internalNetworkVerified = true;
      writeOperation(operation);

      for (const volume of plan.shadow.volumes) {
        operation.shadow.created.volumes.push(volume.shadowName);
        writeOperation(operation);
        await dockerRequest('POST', '/volumes/create', { Name: volume.shadowName, Labels: labels });
        const volumeDetails = await dockerRequest('GET', '/volumes/' + encodeURIComponent(volume.shadowName));
        if (
          !volumeDetails || volumeDetails.Name !== volume.shadowName || !volumeDetails.Labels ||
          volumeDetails.Labels['com.foxos.stateful-shadow.operation'] !== operation.operationId
        ) {
          throw new StatefulShadowError('Stateful shadow volume ownership verification failed', 500, 'shadow-volume-ownership-failed');
        }
      }

      const portKey = `${plan.privatePort}/tcp`;
      operation.shadow.created.container = true;
      writeOperation(operation);
      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(plan.shadow.containerName),
        {
          Image: plan.sourceImageId,
          Env: resolvedEnvironment,
          Labels: labels,
          ExposedPorts: { [portKey]: {} },
          ...(plan.health.mode === 'docker-healthcheck' ? { Healthcheck: source.healthcheck } : {}),
          HostConfig: {
            Mounts: plan.shadow.volumes.map((volume) => ({
              Type: 'volume',
              Source: volume.shadowName,
              Target: volume.destination,
              ReadOnly: false,
              VolumeOptions: { NoCopy: true }
            })),
            RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
            NetworkMode: plan.shadow.networkName,
            SecurityOpt: ['no-new-privileges:true'],
            Memory: plan.runtimeLimits.memoryBytes,
            NanoCpus: plan.runtimeLimits.nanoCpus,
            PidsLimit: plan.runtimeLimits.pidsLimit
          },
          NetworkingConfig: { EndpointsConfig: { [plan.shadow.networkName]: {} } }
        }
      );
      operation.shadow.containerId = created.Id;
      writeOperation(operation);

      for (const volume of plan.volumes) {
        if (volume.policy === 'empty-ephemeral') {
          operation.shadow.volumesRestored.push({
            sourceName: volume.name,
            destination: volume.destination,
            policy: volume.policy,
            restored: true,
            recreatedEmpty: true
          });
          continue;
        }
        const archive = decryptArchive(plan, rehearsal.operation, volume);
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
        if (restoredDigest !== volume.backup.contentDigest) {
          throw new StatefulShadowError('Stateful shadow restored data digest does not match', 500, 'shadow-restore-digest-mismatch');
        }
        operation.shadow.volumesRestored.push({
          sourceName: volume.name,
          destination: volume.destination,
          policy: volume.policy,
          restored: true,
          contentDigest: restoredDigest
        });
      }
      writeOperation(operation);

      await dockerRequest('POST', '/containers/' + created.Id + '/start');
      const details = await waitForHealth(created.Id, plan.health, plan.privatePort, plan.shadow.networkName);
      const networks = Object.keys(details.NetworkSettings && details.NetworkSettings.Networks || {});
      const bindings = details.NetworkSettings && details.NetworkSettings.Ports &&
        details.NetworkSettings.Ports[portKey] || [];
      const endpoint = details.NetworkSettings && details.NetworkSettings.Networks &&
        details.NetworkSettings.Networks[plan.shadow.networkName];
      const host = details.HostConfig || {};
      const observedLabels = details.Config && details.Config.Labels || {};
      if (
        networks.length !== 1 || networks[0] !== plan.shadow.networkName ||
        bindings.length !== 0 || !endpoint || !isPrivateDockerIPv4(endpoint.IPAddress) ||
        !host.RestartPolicy || host.RestartPolicy.Name !== 'unless-stopped' ||
        host.Memory !== plan.runtimeLimits.memoryBytes || host.NanoCpus !== plan.runtimeLimits.nanoCpus ||
        host.PidsLimit !== plan.runtimeLimits.pidsLimit || host.Privileged ||
        !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges:true') ||
        observedLabels['com.foxos.managed'] !== 'true' ||
        observedLabels['com.foxos.stateful-shadow'] !== 'true' ||
        observedLabels['com.foxos.resource.id'] !== plan.shadow.shadowResourceId ||
        observedLabels['com.foxos.stateful-shadow.source-resource-id'] !== plan.sourceResourceId ||
        observedLabels['com.foxos.stateful-shadow.operation'] !== operation.operationId
      ) {
        throw new StatefulShadowError('Stateful shadow isolation or runtime verification failed', 500, 'shadow-runtime-verification-failed');
      }
      operation.shadow.health = {
        verified: true,
        mode: plan.health.mode,
        privatePort: plan.privatePort,
        hostPortPublished: false,
        internalAddressObserved: true,
        verifiedAt: now()
      };
      operation.shadow.hostPortPublished = false;
      operation.shadow.externalNetwork = false;
      operation.shadow.routeCreated = false;
      writeOperation(operation);

      const registrySnapshot = await resourceRegistry.scan();
      const preliminary = {
        ...operation,
        status: 'active',
        completedAt: now(),
        cleanup: { attempted: false, completed: false, errors: [] }
      };
      const registryProof = verifyCurrentRecord(preliminary, registrySnapshot);
      if (!registryProof.verified) {
        throw new StatefulShadowError('Resource Registry did not verify the FoxOS-owned shadow', 500, 'shadow-registry-verification-failed');
      }
      const lockError = releaseOperationLock(lockOwner);
      if (lockError) throw new StatefulShadowError('Stateful shadow process lock cleanup failed', 500, lockError);
      lockReleased = true;
      operation = { ...preliminary, registryProof };
      writeOperation(operation);
      atomicWriteJson(path.join(currentRoot, plan.sourceResourceId + '.json'), operation);
      pruneJson(operationsRoot);
    } catch (error) {
      primaryError = error;
      const cleanupErrors = await removeExactResources(operation.shadow);
      if (!lockReleased) {
        const lockError = releaseOperationLock(lockOwner);
        if (lockError) cleanupErrors.push(lockError);
        else lockReleased = true;
      }
      operation = {
        ...operation,
        status: cleanupErrors.length ? 'failed-cleanup-required' : 'failed-and-cleaned',
        completedAt: now(),
        cleanup: { attempted: true, completed: cleanupErrors.length === 0, errors: cleanupErrors },
        failure: {
          code: error.code || 'stateful-shadow-error',
          message: error instanceof StatefulShadowError ? error.message : 'Stateful shadow operation failed'
        }
      };
      writeOperation(operation);
      pruneJson(operationsRoot);
    } finally {
      activeOperationId = null;
    }

    if (primaryError) throw primaryError;
    return operation;
  }

  async function runRefreshPlan(planId, confirmation) {
    const plan = getRecord(plansRoot, planId, 'Stateful shadow refresh plan');
    if (plan.schemaVersion !== STATEFUL_SHADOW_SCHEMA_VERSION || plan.action !== 'refresh') {
      throw new StatefulShadowError('Stateful shadow refresh plan is unsupported', 409, 'unsupported-shadow-refresh-plan');
    }
    if (confirmation !== plan.confirmation) {
      throw new StatefulShadowError('Exact stateful shadow refresh confirmation is required', 400, 'confirmation-required');
    }
    if (activeOperationId || listJson(operationsRoot).some((operation) => operation.status === 'running')) {
      throw new StatefulShadowError('Another stateful shadow operation is already running', 409, 'stateful-shadow-busy');
    }

    const operationId = 'ssro_' + randomUUID().replace(/-/g, '');
    const lockOwner = acquireOperationLock(operationId);
    const currentFile = path.join(currentRoot, plan.sourceResourceId + '.json');
    let lockReleased = false;
    activeOperationId = operationId;
    let operation = {
      schemaVersion: STATEFUL_SHADOW_SCHEMA_VERSION,
      action: 'refresh',
      operationId,
      planId: plan.planId,
      sourceResourceId: plan.sourceResourceId,
      sourceResourceFingerprint: plan.sourceResourceFingerprint,
      shadowResourceId: plan.shadow.shadowResourceId,
      status: 'running',
      startedAt: now(),
      source: {
        containerId: plan.sourceContainerId,
        imageId: plan.sourceImageId,
        mutated: false,
        paused: false,
        stopped: false,
        recreated: false
      },
      previous: {
        operationId: plan.previous.operationId,
        shadowResourceId: plan.previous.shadowResourceId,
        shadowContainerId: plan.previous.shadowContainerId,
        fingerprint: plan.previous.fingerprint,
        preservedUntilCandidateRegistryProof: true,
        shadow: null
      },
      rehearsal: plan.rehearsal,
      environment: plan.environment,
      runtimeLimits: plan.runtimeLimits,
      shadow: {
        ...plan.shadow,
        containerId: null,
        internalNetworkVerified: false,
        volumesRestored: [],
        health: null,
        hostPortPublished: false,
        externalNetwork: false,
        routeCreated: false,
        ownerOperationId: operationId,
        created: { container: false, network: false, volumes: [] }
      },
      refresh: {
        previousRehearsalOperationId: plan.previous.rehearsalOperationId,
        rehearsalOperationId: plan.rehearsal.operationId,
        previousSnapshotAt: plan.previous.snapshotAt,
        snapshotAt: plan.rehearsal.snapshotAt,
        newerSnapshotVerified: true,
        inPlaceVolumeMutation: false,
        finalSynchronizationProven: false,
        sourceWritesMayContinueAfterSnapshot: true
      },
      promotion: {
        candidateRegistryVerified: false,
        currentWritten: false,
        previousCleanupAttempted: false,
        previousCleanupCompleted: false
      },
      cleanup: { attempted: false, completed: false, errors: [] },
      guarantees: { ...plan.guarantees }
    };
    try {
      writeOperation(operation);
    } catch (error) {
      releaseOperationLock(lockOwner);
      activeOperationId = null;
      throw error;
    }

    let primaryError = null;
    try {
      const { current, rehearsal, environment, source } = await revalidateRefreshPlan(plan);
      operation.previous.shadow = current.shadow;
      writeOperation(operation);

      await materializeShadowCandidate(plan, operation, rehearsal, environment, source);
      const candidateSnapshot = await resourceRegistry.scan();
      const activeRecord = {
        ...operation,
        status: 'active',
        completedAt: now(),
        cleanup: { attempted: false, completed: false, errors: [] }
      };
      const candidateProof = verifyCurrentRecord(activeRecord, candidateSnapshot);
      if (!candidateProof.verified) {
        throw new StatefulShadowError(
          'Resource Registry did not verify the refreshed FoxOS-owned shadow',
          500,
          'shadow-refresh-registry-verification-failed'
        );
      }
      operation.promotion.candidateRegistryVerified = true;
      operation.registryProof = candidateProof;
      writeOperation(operation);

      operation.promotion.currentWritten = true;
      atomicWriteJson(currentFile, {
        ...activeRecord,
        promotion: { ...operation.promotion },
        registryProof: candidateProof
      });
      writeOperation(operation);

      operation.promotion.previousCleanupAttempted = true;
      const cleanupErrors = await removeExactResources(current.shadow);
      operation.cleanup = {
        attempted: true,
        completed: cleanupErrors.length === 0,
        errors: cleanupErrors
      };
      operation.promotion.previousCleanupCompleted = cleanupErrors.length === 0;

      try {
        const finalSnapshot = await resourceRegistry.scan();
        const finalProof = verifyCurrentRecord(activeRecord, finalSnapshot);
        if (!finalProof.verified) cleanupErrors.push('registry:post-promotion-verification-failed');
        else operation.registryProof = finalProof;
      } catch (error) {
        cleanupErrors.push('registry:post-promotion-scan-failed');
      }
      operation.cleanup.completed = cleanupErrors.length === 0;
      operation.cleanup.errors = cleanupErrors;
      operation.status = cleanupErrors.length ? 'active-cleanup-required' : 'active';
      operation.completedAt = now();
      writeOperation(operation);
      atomicWriteJson(currentFile, operation);
      pruneJson(operationsRoot);
    } catch (error) {
      primaryError = error;
      const current = readJson(path.join(currentRoot, plan.sourceResourceId + '.json'), null);
      const promoted = Boolean(current && current.operationId === operation.operationId);
      const cleanupErrors = promoted
        ? await removeExactResources(operation.previous.shadow || {})
        : await removeExactResources(operation.shadow);
      operation = {
        ...operation,
        status: promoted
          ? 'active-recovery-required'
          : cleanupErrors.length ? 'failed-cleanup-required' : 'failed-and-cleaned',
        completedAt: now(),
        cleanup: { attempted: true, completed: cleanupErrors.length === 0, errors: cleanupErrors },
        failure: {
          code: error.code || 'stateful-shadow-refresh-error',
          message: error instanceof StatefulShadowError
            ? error.message
            : 'Stateful shadow refresh operation failed'
        }
      };
      writeOperation(operation);
      if (promoted) atomicWriteJson(currentFile, operation);
      pruneJson(operationsRoot);
    } finally {
      if (!lockReleased) {
        const lockError = releaseOperationLock(lockOwner);
        if (!lockError) lockReleased = true;
        else {
          operation.cleanup = operation.cleanup || { attempted: false, completed: false, errors: [] };
          operation.cleanup.completed = false;
          operation.cleanup.errors = [...(operation.cleanup.errors || []), lockError];
          if (operation.status === 'active') operation.status = 'active-cleanup-required';
          writeOperation(operation);
          const current = readJson(currentFile, null);
          if (current && current.operationId === operation.operationId) atomicWriteJson(currentFile, operation);
        }
      }
      activeOperationId = null;
    }

    if (primaryError) throw primaryError;
    return operation;
  }

  async function recoverInterruptedOperations({ clearStaleLock = false } = {}) {
    const lockOwner = acquireOperationLock('startup-recovery', clearStaleLock);
    try {
      const recovered = [];
      for (let operation of listJson(operationsRoot).filter((candidate) => (
        candidate.status === 'running' ||
        (candidate.action === 'refresh' && candidate.status === 'active-cleanup-required')
      ))) {
        if (operation.action === 'refresh') {
          const currentFile = path.join(currentRoot, operation.sourceResourceId + '.json');
          const current = readJson(currentFile, null);
          const promoted = Boolean(current && current.operationId === operation.operationId);
          const errors = promoted
            ? await removeExactResources(operation.previous && operation.previous.shadow || {})
            : await removeExactResources(operation.shadow);
          if (promoted) {
            try {
              const snapshot = await resourceRegistry.scan();
              const proof = verifyCurrentRecord(current, snapshot);
              if (!proof.verified) errors.push('registry:startup-recovery-verification-failed');
              else {
                operation.registryProof = proof;
                atomicWriteJson(currentFile, {
                  ...current,
                  registryProof: proof,
                  cleanup: { attempted: true, completed: errors.length === 0, errors }
                });
              }
            } catch {
              errors.push('registry:startup-recovery-scan-failed');
            }
          }
          operation = {
            ...operation,
            status: promoted
              ? errors.length ? 'active-cleanup-required' : 'active'
              : errors.length ? 'interrupted-cleanup-required' : 'interrupted-cleaned',
            completedAt: now(),
            cleanup: { attempted: true, completed: errors.length === 0, errors },
            promotion: {
              ...(operation.promotion || {}),
              currentWritten: promoted,
              previousCleanupAttempted: promoted,
              previousCleanupCompleted: promoted && errors.length === 0
            }
          };
          if (promoted) atomicWriteJson(currentFile, operation);
        } else {
          const errors = await removeExactResources(operation.shadow);
          operation = {
            ...operation,
            status: errors.length ? 'interrupted-cleanup-required' : 'interrupted-cleaned',
            completedAt: now(),
            cleanup: { attempted: true, completed: errors.length === 0, errors }
          };
        }
        writeOperation(operation);
        recovered.push({ operationId: operation.operationId, status: operation.status });
      }
      return { recovered };
    } finally {
      const releaseError = releaseOperationLock(lockOwner);
      if (releaseError) {
        throw new StatefulShadowError('Stateful shadow recovery lock cleanup failed', 500, releaseError);
      }
    }
  }

  function status() {
    const plans = listJson(plansRoot);
    const operations = listJson(operationsRoot);
    const current = currentRecords();
    return {
      schemaVersion: STATEFUL_SHADOW_SCHEMA_VERSION,
      scope: 'foxos-owned-persistent-stateful-shadow',
      plans,
      operations,
      current,
      summary: {
        plans: plans.length,
        operations: operations.length,
        refreshPlans: plans.filter((plan) => plan.action === 'refresh').length,
        refreshOperations: operations.filter((operation) => operation.action === 'refresh').length,
        active: current.filter((record) => record.registryProof.verified).length,
        stale: current.filter((record) => !record.registryProof.verified).length,
        running: operations.filter((operation) => operation.status === 'running').length
      },
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
        controlledRefreshSupported: true,
        inPlaceVolumeMutation: false,
        finalSynchronizationProven: false,
        sourceWritesMayContinueAfterSnapshot: true,
        offHostRecoveryProven: false,
        environmentValuesIncluded: false,
        secretValuesIncluded: false,
        restartPolicy: 'unless-stopped'
      }
    };
  }

  ensureDirectory(root);
  return {
    createPlan,
    createRefreshPlan,
    getOperation: (operationId) => getRecord(operationsRoot, operationId, 'Stateful shadow operation'),
    getPlan: (planId) => getRecord(plansRoot, planId, 'Stateful shadow plan'),
    paths: { currentRoot, operationLockFile, operationsRoot, plansRoot, root },
    recoverInterruptedOperations,
    runRefreshPlan,
    runPlan,
    status
  };
}

module.exports = {
  PLAN_STATEFUL_SHADOW_CONFIRMATION,
  PLAN_STATEFUL_SHADOW_REFRESH_CONFIRMATION,
  STATEFUL_SHADOW_SCHEMA_VERSION,
  StatefulShadowError,
  createStatefulShadowManager,
  refreshConfirmation,
  refreshedShadowNames,
  runConfirmation,
  shadowNames
};
