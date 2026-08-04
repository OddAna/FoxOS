const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const MANIFEST_SCHEMA_VERSION = 2;
const PLAN_SCHEMA_VERSION = 2;
const OPERATION_SCHEMA_VERSION = 2;
const PILOT_LABEL = 'com.foxos.adoption.disposable';
const PILOT_NAME_PATTERN = /^foxos-adoption-lab(?:-[a-z0-9-]+)?$/;
const ID_PATTERN = /^(plan|op)_[a-f0-9]{24,64}$/;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const MAX_OPERATIONS = 100;

class AdoptionError extends Error {
  constructor(message, statusCode = 400, code = 'adoption-error') {
    super(message);
    this.name = 'AdoptionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
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

function atomicWriteBuffer(target, value) {
  ensureDirectory(path.dirname(target));
  const temporary = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not exist if creation itself failed.
    }
    throw error;
  }
}

function envMap(entries = []) {
  return new Map(entries.map((entry) => {
    const separator = String(entry).indexOf('=');
    return separator === -1
      ? [String(entry), '']
      : [String(entry).slice(0, separator), String(entry).slice(separator + 1)];
  }));
}

function unresolvedEnvironmentNames(containerEnv = [], imageEnv = []) {
  const imageValues = envMap(imageEnv);
  return Array.from(envMap(containerEnv).entries())
    .filter(([name, value]) => !imageValues.has(name) || imageValues.get(name) !== value)
    .map(([name]) => name)
    .sort();
}

function arraysEqual(left, right) {
  return canonicalJson(left || null) === canonicalJson(right || null);
}

function validateResourceId(resourceId) {
  if (!RESOURCE_ID_PATTERN.test(String(resourceId))) {
    throw new AdoptionError('Invalid FoxOS resource ID', 400, 'invalid-resource-id');
  }
}

function validateSafePath(value) {
  const candidate = String(value || '/');
  if (
    candidate.length > 160 ||
    !candidate.startsWith('/') ||
    candidate.includes('..') ||
    !/^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*$/.test(candidate)
  ) {
    throw new AdoptionError('Health path is invalid', 400, 'invalid-health-path');
  }
  if (candidate.split('/').some((segment) => segment.length >= 24 && /^[a-zA-Z0-9_-]+$/.test(segment))) {
    throw new AdoptionError('Health path may not contain token-like segments', 400, 'unsafe-health-path');
  }
  return candidate;
}

function tarString(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function tarOctal(block, start, length) {
  const raw = tarString(block, start, length).replace(/^\s+|\s+$/g, '');
  return raw ? Number.parseInt(raw, 8) : 0;
}

function validateArchiveEntryName(name) {
  const normalized = String(name).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.') return '.';
  if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new AdoptionError('Backup archive contains an unsafe path', 500, 'unsafe-backup-archive');
  }
  return normalized;
}

function tarContentDigest(archive) {
  if (!Buffer.isBuffer(archive)) {
    throw new AdoptionError('Backup archive must be binary', 500, 'invalid-backup-archive');
  }

  const entries = [];
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
      throw new AdoptionError('Backup archive is truncated', 500, 'truncated-backup-archive');
    }
    const data = archive.subarray(dataStart, dataEnd);

    if (type === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
    } else if (!['x', 'g', 'K'].includes(type)) {
      const name = validateArchiveEntryName(pendingLongName || headerName);
      pendingLongName = null;
      entries.push({
        name,
        type,
        mode: tarOctal(header, 100, 8),
        link: type === '2' ? tarString(header, 157, 100) : null,
        size,
        digest: type === '0' || type === '\0' ? hash(data, 64) : null
      });
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  if (!entries.length) {
    throw new AdoptionError('Backup archive contains no verifiable entries', 500, 'empty-backup-archive');
  }
  return 'sha256:' + hash(canonicalJson(entries.sort((left, right) => left.name.localeCompare(right.name))), 64);
}

function resourceFingerprint(resource) {
  return 'sha256:' + hash(canonicalJson({
    id: resource.id,
    name: resource.name,
    provider: resource.provider,
    role: resource.role,
    runtime: {
      containerId: resource.runtime.containerId,
      image: resource.runtime.image,
      imageId: resource.runtime.imageId,
      inspection: resource.runtime.inspection
    },
    ports: resource.ports,
    mounts: resource.mounts,
    routes: resource.routes,
    networks: resource.networks,
    safeLabels: resource.provenance.safeLabels
  }), 64);
}

function planConfirmation(resourceId) {
  return 'ADOPT DISPOSABLE ' + resourceId;
}

function planDraftConfirmation(resourceId) {
  return 'PLAN DISPOSABLE ' + resourceId;
}

function rollbackConfirmation(operationId) {
  return 'ROLLBACK ' + operationId;
}

function createAdoptionManager({
  dataRoot,
  dockerRequest,
  dockerArchiveRequest,
  resourceRegistry,
  routeManager,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerArchiveRequest !== 'function' ||
    !resourceRegistry || !routeManager
  ) {
    throw new Error('Adoption manager requires data root, Docker clients, Resource Registry and Route Manager');
  }

  const adoptionRoot = path.join(dataRoot, 'adoption');
  const manifestsRoot = path.join(adoptionRoot, 'manifests');
  const plansRoot = path.join(adoptionRoot, 'plans');
  const operationsRoot = path.join(adoptionRoot, 'operations');
  const backupsRoot = path.join(adoptionRoot, 'backups');
  const inFlight = new Set();

  function planPath(planId) {
    if (!ID_PATTERN.test(String(planId)) || !String(planId).startsWith('plan_')) {
      throw new AdoptionError('Invalid adoption plan ID', 400, 'invalid-plan-id');
    }
    return path.join(plansRoot, planId + '.json');
  }

  function operationPath(operationId) {
    if (!ID_PATTERN.test(String(operationId)) || !String(operationId).startsWith('op_')) {
      throw new AdoptionError('Invalid adoption operation ID', 400, 'invalid-operation-id');
    }
    return path.join(operationsRoot, operationId + '.json');
  }

  function getPlan(planId) {
    const plan = readJson(planPath(planId), null);
    if (!plan) throw new AdoptionError('Adoption plan was not found', 404, 'plan-not-found');
    if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
      throw new AdoptionError('Unsupported adoption plan schema', 409, 'unsupported-plan-schema');
    }
    return plan;
  }

  function getOperation(operationId) {
    const operation = readJson(operationPath(operationId), null);
    if (!operation) throw new AdoptionError('Adoption operation was not found', 404, 'operation-not-found');
    if (![1, OPERATION_SCHEMA_VERSION].includes(operation.schemaVersion)) {
      throw new AdoptionError('Unsupported adoption operation schema', 409, 'unsupported-operation-schema');
    }
    return operation;
  }

  function listJsonFiles(directory) {
    try {
      return fs.readdirSync(directory)
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => readJson(path.join(directory, file)))
        .filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function pruneOperations() {
    const files = (() => {
      try {
        return fs.readdirSync(operationsRoot).filter((file) => file.endsWith('.json')).sort();
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    })();
    for (const file of files.slice(0, Math.max(0, files.length - MAX_OPERATIONS))) {
      fs.unlinkSync(path.join(operationsRoot, file));
    }
  }

  async function createPlan(resourceId, input = {}) {
    validateResourceId(resourceId);
    if (input.confirmation !== planDraftConfirmation(resourceId)) {
      throw new AdoptionError('Exact disposable planning confirmation is required', 400, 'confirmation-required');
    }

    const snapshot = await resourceRegistry.scan();
    const resource = snapshot.resources.find((candidate) => candidate.id === resourceId);
    if (!resource) throw new AdoptionError('Resource was not found in the latest scan', 404, 'resource-not-found');
    if (resource.protected) throw new AdoptionError('Protected FoxOS resources cannot be adopted', 403, 'resource-protected');
    if (!PILOT_NAME_PATTERN.test(resource.name)) {
      throw new AdoptionError('This pilot accepts only foxos-adoption-lab resources', 403, 'pilot-resource-only');
    }
    if (resource.provenance.safeLabels[PILOT_LABEL] !== 'true') {
      throw new AdoptionError('Disposable adoption label is required', 403, 'disposable-label-required');
    }
    if (!['docker', 'docker-compose'].includes(resource.provider)) {
      throw new AdoptionError('The first pilot cannot plan Coolify or other provider-managed resources', 403, 'pilot-provider-blocked');
    }
    if (resource.role !== 'application') {
      throw new AdoptionError('The first pilot accepts only a disposable application', 409, 'pilot-role-blocked');
    }
    if (resource.runtime.inspection !== 'complete' || !resource.runtime.containerId) {
      throw new AdoptionError('Complete Docker inspection is required', 409, 'inspection-incomplete');
    }

    const details = await dockerRequest('GET', '/containers/' + resource.runtime.containerId + '/json');
    const imageDetails = await dockerRequest('GET', '/images/' + encodeURIComponent(details.Image) + '/json');
    const imageDigests = (imageDetails.RepoDigests || []).filter((entry) => /@sha256:[a-f0-9]{64}$/i.test(entry)).sort();
    const unresolvedEnv = unresolvedEnvironmentNames(
      details.Config && details.Config.Env || [],
      imageDetails.Config && imageDetails.Config.Env || []
    );

    const blockers = [];
    const warnings = [];
    const addBlocker = (code, message) => blockers.push({ code, severity: 'blocking', message });
    const addWarning = (code, message) => warnings.push({ code, severity: 'warning', message });
    const mounts = resource.mounts;
    const publishedPorts = resource.ports.filter((port) => port.hostPort);
    const hostConfig = details.HostConfig || {};

    if (!imageDigests.length) addBlocker('image-digest-missing', 'The local image has no immutable repository digest.');
    if (unresolvedEnv.length) addBlocker('environment-unresolved', 'Container environment overrides require secret classification.');
    if (!arraysEqual(details.Config && details.Config.Cmd, imageDetails.Config && imageDetails.Config.Cmd)) {
      addBlocker('command-override-unresolved', 'Container command override requires explicit review.');
    }
    if (!arraysEqual(details.Config && details.Config.Entrypoint, imageDetails.Config && imageDetails.Config.Entrypoint)) {
      addBlocker('entrypoint-override-unresolved', 'Container entrypoint override requires explicit review.');
    }
    if ((details.Config && details.Config.User || '') !== (imageDetails.Config && imageDetails.Config.User || '')) {
      addBlocker('user-override-unresolved', 'Container user override requires explicit review.');
    }
    if ((details.Config && details.Config.WorkingDir || '') !== (imageDetails.Config && imageDetails.Config.WorkingDir || '')) {
      addBlocker('working-directory-override-unresolved', 'Working directory override requires explicit review.');
    }
    if (mounts.length !== 1 || mounts[0].type !== 'volume' || !mounts[0].name || !mounts[0].destination) {
      addBlocker('pilot-volume-policy', 'The first pilot requires exactly one named volume.');
    } else if (!mounts[0].readOnly) {
      addBlocker('pilot-volume-readonly', 'The disposable pilot volume must be mounted read-only.');
    }
    if (publishedPorts.length !== 1 || publishedPorts[0].protocol !== 'tcp') {
      addBlocker('pilot-port-policy', 'The first pilot requires exactly one published TCP port.');
    } else if (publishedPorts[0].hostIp !== '127.0.0.1') {
      addBlocker('pilot-loopback-required', 'The disposable pilot must use a loopback-only host port.');
    }
    if (resource.routes.length) addBlocker('pilot-route-present', 'The disposable adoption pilot may not use an existing provider route.');
    if (hostConfig.Privileged || hostConfig.PidMode || hostConfig.IpcMode === 'host' || hostConfig.UTSMode === 'host') {
      addBlocker('dangerous-host-access', 'Privileged or host-namespace containers are outside this pilot.');
    }
    if ((hostConfig.Devices || []).length || (hostConfig.CapAdd || []).length) {
      addBlocker('dangerous-runtime-capability', 'Devices or added capabilities are outside this pilot.');
    }
    const related = snapshot.relationships.filter((relationship) => (
      (relationship.resourceIds || []).includes(resourceId) ||
      relationship.sourceResourceId === resourceId ||
      relationship.targetResourceId === resourceId
    ));
    if (related.length) addBlocker('resource-relationships-present', 'The disposable pilot must have no resource dependencies.');
    if (snapshot.conflicts.some((conflict) => conflict.resourceIds.includes(resourceId))) {
      addBlocker('resource-conflict-present', 'Resolve current port, domain or storage conflicts before adoption.');
    }

    const healthPrivatePort = Number(input.healthPrivatePort || publishedPorts[0] && publishedPorts[0].privatePort);
    const healthPath = validateSafePath(input.healthPath || '/');
    if (!Number.isSafeInteger(healthPrivatePort) || !resource.ports.some((port) => port.privatePort === healthPrivatePort)) {
      addBlocker('health-port-invalid', 'Health proof must target an observed private port.');
    }
    if (details.Config && details.Config.Healthcheck) {
      addWarning('health-policy-replaced', 'The imported health command is not copied; FoxOS will use its reviewed HTTP proof.');
    }
    addWarning('network-provider-detached', 'The FoxOS-managed target will use the Docker bridge instead of the provider network.');

    const desiredRoute = Number.isSafeInteger(healthPrivatePort) && healthPrivatePort > 0
      ? routeManager.planRoute(resourceId, resource.name, healthPrivatePort)
      : null;

    const desiredPort = publishedPorts[0] || null;
    const desiredMount = mounts[0] || null;
    const manifestCore = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      resourceId,
      kind: 'application',
      name: resource.name,
      ownership: 'import-draft',
      desired: {
        runtime: {
          engine: 'docker',
          image: {
            reference: imageDigests[0] || null,
            contentId: details.Image || null
          },
          state: 'running',
          restartPolicy: 'unless-stopped',
          networkMode: 'bridge',
          security: {
            privileged: false,
            noNewPrivileges: true
          }
        },
        ports: desiredPort ? [{
          privatePort: desiredPort.privatePort,
          protocol: desiredPort.protocol,
          hostIp: desiredPort.hostIp,
          hostPort: desiredPort.hostPort
        }] : [],
        health: {
          type: 'http',
          privatePort: healthPrivatePort,
          path: healthPath,
          expectedStatus: 200,
          timeoutSeconds: 30
        },
        environment: {
          ordinary: [],
          secretRefs: [],
          unresolvedNames: unresolvedEnv
        },
        persistence: {
          consistency: 'filesystem-static',
          volumes: desiredMount ? [{
            name: desiredMount.name,
            destination: desiredMount.destination,
            readOnly: true,
            backupRequired: true,
            restoreVerificationRequired: true
          }] : []
        },
        routes: desiredRoute ? [desiredRoute] : [],
        dependencies: [],
        resources: {
          memoryBytes: hostConfig.Memory || null,
          nanoCpus: hostConfig.NanoCpus || null
        }
      },
      provenance: {
        importedFrom: resource.provider,
        observedProject: resource.provenance.project || null,
        observedService: resource.provenance.service || null,
        observedImageReference: resource.runtime.image,
        sourceSnapshotId: snapshot.snapshotId
      },
      safety: {
        scope: 'disposable-pilot-only',
        secretValuesIncluded: false,
        providerDetachIncluded: false
      }
    };
    const manifestRevision = 'rev_' + hash(canonicalJson(manifestCore), 32);
    const manifest = { ...manifestCore, revision: manifestRevision };
    const sourceFingerprint = resourceFingerprint(resource);
    const checks = [...blockers, ...warnings].sort((left, right) => left.code.localeCompare(right.code));
    const planCore = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      operation: 'reversible-disposable-adoption',
      resourceId,
      sourceSnapshotId: snapshot.snapshotId,
      sourceFingerprint,
      sourceContainerId: resource.runtime.containerId,
      manifestRevision,
      status: blockers.length ? 'blocked' : 'ready',
      checks,
      actions: blockers.length ? [] : [
        'archive-named-volume',
        'verify-archive-restore-in-temporary-volume',
        'stop-source-container',
        'preserve-source-as-rollback-container',
        'create-foxos-managed-container-from-manifest',
        'verify-docker-health',
        'activate-foxos-caddy-route',
        'verify-https-route'
      ],
      rollbackActions: blockers.length ? [] : [
        'deactivate-foxos-caddy-route',
        'verify-https-route-unavailable',
        'remove-foxos-managed-container',
        'restore-source-container-name',
        'restart-source-container',
        'verify-source-runtime'
      ],
      confirmation: planConfirmation(resourceId),
      guarantees: {
        runtimeMutated: false,
        secretValuesIncluded: false,
        existingNonDisposableResourcesMutable: false,
        coolifyResourcesMutable: false
      }
    };
    const planId = 'plan_' + hash(canonicalJson(planCore), 32);
    const existing = readJson(path.join(plansRoot, planId + '.json'), null);
    const generatedAt = existing && existing.generatedAt || new Date(clock()).toISOString();
    const plan = { ...planCore, planId, generatedAt, manifest };

    const manifestResourceRoot = path.join(manifestsRoot, resourceId);
    atomicWriteJson(path.join(manifestResourceRoot, 'revisions', manifestRevision + '.json'), manifest);
    atomicWriteJson(path.join(manifestResourceRoot, 'latest.json'), manifest);
    atomicWriteJson(path.join(plansRoot, planId + '.json'), plan);
    return plan;
  }

  function managedContainerPayload(plan) {
    const manifest = plan.manifest;
    const desired = manifest.desired;
    const exposedPorts = Object.fromEntries(
      desired.ports.map((port) => [`${port.privatePort}/${port.protocol}`, {}])
    );
    const portBindings = Object.fromEntries(desired.ports.map((port) => [
      `${port.privatePort}/${port.protocol}`,
      [{ HostIp: port.hostIp, HostPort: String(port.hostPort) }]
    ]));
    const healthUrl = `http://127.0.0.1:${desired.health.privatePort}${desired.health.path}`;
    return {
      Image: desired.runtime.image.reference,
      Labels: {
        'com.foxos.managed': 'true',
        'com.foxos.app.id': manifest.resourceId,
        'com.foxos.app.name': manifest.name,
        'com.foxos.resource.id': manifest.resourceId
      },
      ExposedPorts: exposedPorts,
      Healthcheck: {
        Test: ['CMD-SHELL', `wget --quiet --spider ${healthUrl} || exit 1`],
        Interval: 2000000000,
        Timeout: 1000000000,
        Retries: 10,
        StartPeriod: 3000000000
      },
      HostConfig: {
        Mounts: desired.persistence.volumes.map((volume) => ({
          Type: 'volume',
          Source: volume.name,
          Target: volume.destination,
          ReadOnly: volume.readOnly,
          VolumeOptions: { NoCopy: true }
        })),
        PortBindings: portBindings,
        RestartPolicy: { Name: desired.runtime.restartPolicy, MaximumRetryCount: 0 },
        NetworkMode: desired.runtime.networkMode,
        SecurityOpt: ['no-new-privileges:true'],
        Memory: desired.resources.memoryBytes || 0,
        NanoCpus: desired.resources.nanoCpus || 0
      }
    };
  }

  async function waitForContainer(containerId, { requireHealthy, timeoutSeconds = 30 }) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastState = null;
    while (Date.now() < deadline) {
      lastState = await dockerRequest('GET', '/containers/' + containerId + '/json');
      const status = lastState.State && lastState.State.Status;
      const health = lastState.State && lastState.State.Health && lastState.State.Health.Status;
      if (status === 'running' && (!requireHealthy || health === 'healthy')) {
        return { status, health: health || null, verifiedAt: new Date(clock()).toISOString() };
      }
      if (status === 'exited' || status === 'dead' || health === 'unhealthy') break;
      await wait(500);
    }
    const status = lastState && lastState.State && lastState.State.Status || 'unknown';
    const health = lastState && lastState.State && lastState.State.Health && lastState.State.Health.Status || null;
    throw new AdoptionError(`Container verification failed (state=${status}, health=${health || 'none'})`, 503, 'health-verification-failed');
  }

  async function verifyBackupRestore(plan, operationId, volume, archive, expectedDigest) {
    const suffix = hash(operationId + ':' + volume.name, 12);
    const verificationVolume = 'foxos-adoption-verify-' + suffix;
    const verificationContainerName = 'foxos-adoption-verify-' + suffix;
    let verificationContainerId = null;
    try {
      await dockerRequest('POST', '/volumes/create', {
        Name: verificationVolume,
        Labels: { 'com.foxos.temporary': 'adoption-restore-verification' }
      });
      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(verificationContainerName),
        {
          Image: plan.manifest.desired.runtime.image.reference,
          Labels: { 'com.foxos.temporary': 'adoption-restore-verification' },
          HostConfig: {
            Mounts: [{
              Type: 'volume',
              Source: verificationVolume,
              Target: volume.destination,
              ReadOnly: false,
              VolumeOptions: { NoCopy: true }
            }]
          }
        }
      );
      verificationContainerId = created.Id;
      await dockerArchiveRequest(
        'PUT',
        '/containers/' + verificationContainerId + '/archive?path=' + encodeURIComponent(volume.destination),
        archive
      );
      const restored = await dockerArchiveRequest(
        'GET',
        '/containers/' + verificationContainerId + '/archive?path=' + encodeURIComponent(volume.destination + '/.'),
        null
      );
      const restoredDigest = tarContentDigest(restored);
      if (restoredDigest !== expectedDigest) {
        throw new AdoptionError('Restored backup content digest does not match', 500, 'restore-verification-mismatch');
      }
      return { verified: true, restoredDigest, verifiedAt: new Date(clock()).toISOString() };
    } finally {
      if (verificationContainerId) {
        try {
          await dockerRequest('DELETE', '/containers/' + verificationContainerId + '?force=1&v=0');
        } catch {
          // Preserve the primary verification error; temporary artifacts are still labeled.
        }
      }
      try {
        await dockerRequest('DELETE', '/volumes/' + encodeURIComponent(verificationVolume));
      } catch {
        // Preserve the primary verification error; temporary artifacts are still labeled.
      }
    }
  }

  async function backupVolumes(plan, operationId) {
    const operationBackupRoot = path.join(backupsRoot, operationId);
    const backups = [];
    for (const volume of plan.manifest.desired.persistence.volumes) {
      const archive = await dockerArchiveRequest(
        'GET',
        '/containers/' + plan.sourceContainerId + '/archive?path=' + encodeURIComponent(volume.destination + '/.'),
        null
      );
      const contentDigest = tarContentDigest(archive);
      const archiveName = 'volume-' + hash(volume.name, 24) + '.tar';
      const archiveFile = path.join(operationBackupRoot, archiveName);
      atomicWriteBuffer(archiveFile, archive);
      const restoreProof = await verifyBackupRestore(plan, operationId, volume, archive, contentDigest);
      backups.push({
        volumeName: volume.name,
        destination: volume.destination,
        archiveFile: path.relative(adoptionRoot, archiveFile),
        archiveBytes: archive.length,
        contentDigest,
        restoreProof
      });
    }
    return backups;
  }

  async function restoreSourceAfterFailure({ sourceId, sourceName, rollbackName, sourceWasRunning, targetId }) {
    if (targetId) {
      try {
        await dockerRequest('DELETE', '/containers/' + targetId + '?force=1&v=0');
      } catch {
        // The target may not have reached the created state.
      }
    }
    if (rollbackName) {
      try {
        await dockerRequest('POST', '/containers/' + sourceId + '/rename?name=' + encodeURIComponent(sourceName));
      } catch {
        // The source may already have its original name.
      }
    }
    if (sourceWasRunning) {
      try {
        await dockerRequest('POST', '/containers/' + sourceId + '/start');
      } catch {
        // The operation record will show that automatic rollback needs attention.
      }
    }
  }

  async function applyPlan(planId, confirmation) {
    const plan = getPlan(planId);
    if (plan.status !== 'ready') throw new AdoptionError('Blocked plans cannot be applied', 409, 'plan-blocked');
    if (confirmation !== plan.confirmation) {
      throw new AdoptionError('Exact adoption confirmation is required', 400, 'confirmation-required');
    }
    if (inFlight.has(plan.resourceId)) throw new AdoptionError('An adoption operation is already running', 409, 'operation-in-progress');
    inFlight.add(plan.resourceId);

    const operationId = 'op_' + randomUUID().replace(/-/g, '');
    const startedAt = new Date(clock()).toISOString();
    let operation = {
      schemaVersion: OPERATION_SCHEMA_VERSION,
      operationId,
      planId,
      resourceId: plan.resourceId,
      manifestRevision: plan.manifestRevision,
      status: 'running',
      startedAt,
      source: null,
      target: null,
      backups: [],
      healthProof: null,
      route: plan.manifest.desired.routes[0] || null,
      routeProof: null,
      rollback: { available: false, confirmation: rollbackConfirmation(operationId) },
      secretValuesIncluded: false
    };
    atomicWriteJson(operationPath(operationId), operation);

    let sourceId = null;
    let sourceName = null;
    let rollbackName = null;
    let sourceWasRunning = false;
    let targetId = null;
    let routeActivated = false;
    try {
      const snapshot = await resourceRegistry.scan();
      const resource = snapshot.resources.find((candidate) => candidate.id === plan.resourceId);
      if (!resource || resourceFingerprint(resource) !== plan.sourceFingerprint) {
        throw new AdoptionError('Resource drifted after the plan was generated; create a new plan', 409, 'plan-stale');
      }
      if (resource.runtime.containerId !== plan.sourceContainerId) {
        throw new AdoptionError('Source container changed after planning', 409, 'source-changed');
      }

      const sourceDetails = await dockerRequest('GET', '/containers/' + resource.runtime.containerId + '/json');
      sourceId = resource.runtime.containerId;
      sourceName = resource.name;
      sourceWasRunning = sourceDetails.State && sourceDetails.State.Status === 'running';
      if (!sourceWasRunning) throw new AdoptionError('Disposable source must be running before adoption', 409, 'source-not-running');
      operation.source = {
        containerId: sourceId,
        originalName: sourceName,
        provider: resource.provider,
        originalState: 'running'
      };
      operation.backups = await backupVolumes(plan, operationId);
      atomicWriteJson(operationPath(operationId), operation);

      await dockerRequest('POST', '/containers/' + sourceId + '/stop?t=10');
      rollbackName = sourceName + '-foxos-rollback-' + hash(operationId, 12);
      await dockerRequest('POST', '/containers/' + sourceId + '/rename?name=' + encodeURIComponent(rollbackName));

      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(sourceName),
        managedContainerPayload(plan)
      );
      targetId = created.Id;
      await dockerRequest('POST', '/containers/' + targetId + '/start');
      operation.healthProof = await waitForContainer(targetId, {
        requireHealthy: true,
        timeoutSeconds: plan.manifest.desired.health.timeoutSeconds
      });
      operation.target = {
        containerId: targetId,
        name: sourceName,
        image: plan.manifest.desired.runtime.image.reference,
        ownership: 'foxos-managed'
      };
      const routeRecord = await routeManager.activate(operation.route, targetId);
      routeActivated = true;
      operation.routeProof = routeRecord.proof;
      operation.source.rollbackName = rollbackName;
      operation.status = 'applied';
      operation.completedAt = new Date(clock()).toISOString();
      operation.rollback.available = true;
      atomicWriteJson(operationPath(operationId), operation);
      pruneOperations();
      await resourceRegistry.scan();
      return operation;
    } catch (error) {
      if (routeActivated && operation.route && targetId) {
        try {
          await routeManager.deactivate(operation.route, targetId);
        } catch {
          // Preserve the primary apply failure; the operation remains visibly failed.
        }
      }
      await restoreSourceAfterFailure({ sourceId, sourceName, rollbackName, sourceWasRunning, targetId });
      operation = {
        ...operation,
        status: rollbackName || targetId ? 'failed-automatic-rollback-attempted' : 'failed-before-runtime-mutation',
        completedAt: new Date(clock()).toISOString(),
        error: {
          code: error.code || 'apply-failed',
          message: error instanceof AdoptionError ? error.message : 'Adoption apply failed'
        }
      };
      atomicWriteJson(operationPath(operationId), operation);
      try {
        await resourceRegistry.scan();
      } catch {
        // Preserve the original error.
      }
      throw error;
    } finally {
      inFlight.delete(plan.resourceId);
    }
  }

  async function rollbackOperation(operationId, confirmation) {
    const operation = getOperation(operationId);
    if (operation.status !== 'applied' || !operation.rollback.available) {
      throw new AdoptionError('This operation has no available rollback', 409, 'rollback-unavailable');
    }
    if (confirmation !== operation.rollback.confirmation) {
      throw new AdoptionError('Exact rollback confirmation is required', 400, 'confirmation-required');
    }
    if (inFlight.has(operation.resourceId)) throw new AdoptionError('An adoption operation is already running', 409, 'operation-in-progress');
    inFlight.add(operation.resourceId);

    try {
      const target = await dockerRequest('GET', '/containers/' + operation.target.containerId + '/json');
      const labels = target.Config && target.Config.Labels || {};
      if (labels['com.foxos.resource.id'] !== operation.resourceId || labels['com.foxos.managed'] !== 'true') {
        throw new AdoptionError('Rollback target identity does not match the operation', 409, 'rollback-target-mismatch');
      }
      let routeProof = null;
      if (operation.schemaVersion >= 2 && operation.route) {
        const routeRecord = await routeManager.deactivate(operation.route, operation.target.containerId);
        routeProof = routeRecord.proof;
      }
      await dockerRequest('DELETE', '/containers/' + operation.target.containerId + '?force=1&v=0');
      await dockerRequest(
        'POST',
        '/containers/' + operation.source.containerId + '/rename?name=' + encodeURIComponent(operation.source.originalName)
      );
      if (operation.source.originalState === 'running') {
        await dockerRequest('POST', '/containers/' + operation.source.containerId + '/start');
      }
      const source = await dockerRequest('GET', '/containers/' + operation.source.containerId + '/json');
      const sourceProof = await waitForContainer(operation.source.containerId, {
        requireHealthy: Boolean(source.Config && source.Config.Healthcheck),
        timeoutSeconds: 30
      });
      const updated = {
        ...operation,
        status: 'rolled-back',
        rolledBackAt: new Date(clock()).toISOString(),
        rollback: {
          ...operation.rollback,
          available: false,
          proof: sourceProof,
          routeProof
        }
      };
      atomicWriteJson(operationPath(operationId), updated);
      await resourceRegistry.scan();
      return updated;
    } finally {
      inFlight.delete(operation.resourceId);
    }
  }

  function status() {
    return {
      schemaVersion: OPERATION_SCHEMA_VERSION,
      scope: 'disposable-pilot-only',
      plans: listJsonFiles(plansRoot),
      operations: listJsonFiles(operationsRoot),
      routes: routeManager.status()
    };
  }

  return {
    applyPlan,
    createPlan,
    getOperation,
    getPlan,
    paths: { adoptionRoot, backupsRoot, manifestsRoot, operationsRoot, plansRoot },
    rollbackOperation,
    status
  };
}

module.exports = {
  AdoptionError,
  MANIFEST_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION,
  PILOT_LABEL,
  PLAN_SCHEMA_VERSION,
  createAdoptionManager,
  planConfirmation,
  planDraftConfirmation,
  resourceFingerprint,
  rollbackConfirmation,
  tarContentDigest,
  unresolvedEnvironmentNames
};
