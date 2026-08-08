const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform, Writable } = require('node:stream');
const YAML = require('yaml');
const { atomicWriteJson } = require('./resourceRegistry');
const {
  composeRevision,
  isApplicationUpdateRollbackOverride,
  mountedPathForHostPath,
  parseComposeDocument,
  resolveComposeProject
} = require('./composeSource');
const { ApplicationUpdateError } = require('./applicationUpdateChecker');
const { imagePullPath } = require('./inactiveDefinitionRuntimeManager');
const { clonedContainerPayload, networkAttachments } = require('./runtimeIdentityManager');

const APPLICATION_UPDATE_OPERATION_SCHEMA_VERSION = 1;
const APPLY_APPLICATION_UPDATE_CONFIRMATION = 'UYGULAMA GÜNCELLEMESİNİ UYGULA';
const ROLLBACK_APPLICATION_UPDATE_CONFIRMATION = 'UYGULAMA GÜNCELLEMESİNİ GERİ AL';
const APPLICATION_ID_PATTERN = /^(?:app|res)_[a-f0-9]{24,64}$/;
const PLAN_ID_PATTERN = /^auplan_[a-f0-9]{32}$/;
const OPERATION_ID_PATTERN = /^auop_[a-f0-9]{32}$/;
const COMPOSE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const STATEFUL_MIGRATION_ID_PATTERN = /^stmop_[a-f0-9]{32}$/;
const STATELESS_MIGRATION_ID_PATTERN = /^smop_[a-f0-9]{32}$/;
const MAX_UPDATE_SERVICES = 16;
const MAX_UPDATE_VOLUMES = 16;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024 * 1024;

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

function recordPath(directory, id) {
  return path.join(directory, id + '.json');
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function managedRuntimeFingerprint(details) {
  const material = {
    id: details && details.Id || null,
    image: details && details.Image || null,
    name: details && details.Name || null,
    config: details && details.Config || null,
    hostConfig: details && details.HostConfig || null,
    mounts: details && details.Mounts || [],
    networks: networkAttachments(details)
  };
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonicalize(material))).digest('hex');
}

function managedBindingDescriptor(dataRoot, details) {
  const labels = details && details.Config && details.Config.Labels || {};
  const statefulId = String(labels['com.foxos.stateful-migration.id'] || '').trim();
  const statelessId = String(labels['com.foxos.stateless-migration.id'] || '').trim();
  if (STATEFUL_MIGRATION_ID_PATTERN.test(statefulId)) {
    return {
      kind: 'stateful',
      expectedStatus: 'traffic-on-server-source-preserved',
      operationId: statefulId,
      operationFile: path.join(dataRoot, 'stateful-migrations', 'operations', statefulId + '.json'),
      adapterFile: path.join(dataRoot, 'production-stateful-adapter', 'operations', statefulId + '.json')
    };
  }
  if (STATELESS_MIGRATION_ID_PATTERN.test(statelessId)) {
    return {
      kind: 'stateless',
      expectedStatus: 'traffic-on-foxos-source-preserved',
      operationId: statelessId,
      operationFile: path.join(dataRoot, 'stateless-migrations', 'operations', statelessId + '.json'),
      adapterFile: path.join(dataRoot, 'production-stateless-adapter', 'operations', statelessId + '.json')
    };
  }
  return null;
}

function verifyManagedBinding(dataRoot, details) {
  const descriptor = managedBindingDescriptor(dataRoot, details);
  if (!descriptor) return null;
  const operation = readJson(descriptor.operationFile);
  const adapter = readJson(descriptor.adapterFile);
  if (
    !operation || operation.operationId !== descriptor.operationId || operation.status !== descriptor.expectedStatus ||
    !adapter || adapter.operationId !== descriptor.operationId ||
    !operation.candidate || operation.candidate.containerId !== details.Id ||
    !adapter.candidate || adapter.candidate.containerId !== details.Id
  ) return null;
  return descriptor;
}

function persistManagedBinding(dataRoot, previousDetails, replacementDetails, imageReference) {
  const descriptor = verifyManagedBinding(dataRoot, previousDetails);
  if (!descriptor) {
    throw new ApplicationUpdateError(
      'Sunucu çalışma kaydı güncel container kimliğine bağlı değil.',
      409,
      'application-update-managed-binding-stale'
    );
  }
  const operation = readJson(descriptor.operationFile);
  const adapter = readJson(descriptor.adapterFile);
  const originalAdapter = JSON.parse(JSON.stringify(adapter));
  operation.candidate = {
    ...operation.candidate,
    containerId: replacementDetails.Id,
    imageId: replacementDetails.Image,
    imageDigest: replacementDetails.Image,
    imageReference
  };
  adapter.candidate = {
    ...adapter.candidate,
    containerId: replacementDetails.Id,
    imageId: replacementDetails.Image,
    imageReference
  };
  adapter.updatedAt = new Date().toISOString();
  atomicWriteJson(descriptor.adapterFile, adapter);
  try {
    atomicWriteJson(descriptor.operationFile, operation);
  } catch (error) {
    atomicWriteJson(descriptor.adapterFile, originalAdapter);
    throw error;
  }
  return descriptor;
}

function repositoryDigestMatches(imageDetails, digest) {
  return IMAGE_DIGEST_PATTERN.test(String(digest || '')) &&
    (imageDetails && imageDetails.RepoDigests || []).some((value) => String(value).endsWith('@' + digest));
}

function replacementContainerName(name, operationId) {
  const suffix = '-previous-' + operationId.slice(-8);
  return String(name || '').slice(0, Math.max(1, 63 - suffix.length)).replace(/-+$/g, '') + suffix;
}

function dependsOnNames(service) {
  if (!service || !service.depends_on) return [];
  if (Array.isArray(service.depends_on)) return service.depends_on.map(String);
  if (typeof service.depends_on === 'object') return Object.keys(service.depends_on);
  return [];
}

function mergeComposeServices(files) {
  const services = {};
  for (const file of files) {
    const parsed = parseComposeDocument(file.content, { requireServices: true });
    for (const [name, value] of Object.entries(parsed.services || {})) {
      services[name] = { ...(services[name] || {}), ...(value || {}) };
    }
  }
  return services;
}

function reverseDependentServices(services, rootService) {
  const selected = new Set([rootService]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, service] of Object.entries(services)) {
      if (selected.has(name)) continue;
      if (dependsOnNames(service).some((dependency) => selected.has(dependency))) {
        selected.add(name);
        changed = true;
      }
    }
  }
  return [...selected];
}

function containerFilters(projectName) {
  return encodeURIComponent(JSON.stringify({
    label: ['com.docker.compose.project=' + projectName]
  }));
}

function safeContainerName(value) {
  return String(value || '').replace(/^\//, '') || null;
}

function publicPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    applicationId: plan.applicationId,
    applicationName: plan.applicationName,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    status: plan.status,
    current: plan.update.current,
    latest: plan.update.latest,
    source: plan.update.source,
    projectName: plan.project.projectName,
    services: plan.services.map((service) => ({
      name: service.name,
      action: service.action,
      containerName: service.containerName,
      running: service.running
    })),
    statefulVolumes: plan.volumes.map((volume) => volume.name),
    publicUrl: plan.publicUrl,
    providerMayOverwrite: plan.providerMayOverwrite,
    confirmation: APPLY_APPLICATION_UPDATE_CONFIRMATION,
    message: plan.volumes.length
      ? 'Güncellemeden önce kalıcı veriler şifreli olarak yedeklenecek; bağlı servisler birlikte doğrulanacak.'
      : 'Bağlı servisler birlikte güncellenecek ve sağlık kontrolü tamamlanmadan işlem başarılı sayılmayacak.'
  };
}

function publicOperation(operation) {
  if (!operation) return null;
  return {
    schemaVersion: operation.schemaVersion,
    operationId: operation.operationId,
    planId: operation.planId,
    applicationId: operation.applicationId,
    status: operation.status,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt || null,
    rollbackAvailable: operation.rollbackAvailable === true,
    rolledBackAt: operation.rolledBackAt || null,
    current: operation.current,
    latest: operation.latest,
    services: operation.services,
    message: operation.message,
    error: operation.error || null
  };
}

function normalizeMountpoint(hostRoot, mountpoint) {
  const normalized = path.posix.normalize(String(mountpoint || ''));
  if (!normalized.startsWith('/var/lib/docker/volumes/') || !normalized.endsWith('/_data')) {
    throw new ApplicationUpdateError(
      'Docker volume veri yolu güvenli sınırın dışında.',
      409,
      'application-update-volume-path-blocked'
    );
  }
  const mounted = mountedPathForHostPath(hostRoot, normalized);
  const volumeRoot = path.resolve(hostRoot, './var/lib/docker/volumes');
  const resolved = path.resolve(mounted);
  if (!resolved.startsWith(volumeRoot + path.sep)) {
    throw new ApplicationUpdateError(
      'Docker volume veri yolu doğrulanamadı.',
      409,
      'application-update-volume-path-blocked'
    );
  }
  return resolved;
}

function childResult(child, label) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(label + ' failed' + (signal ? ' (' + signal + ')' : '') + (stderr ? ': ' + stderr.trim() : '')));
    });
  });
}

function filesystemAvailableBytes(target) {
  const stats = fs.statfsSync(target, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  return Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes);
}

function nearestExistingDirectory(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No existing filesystem root is available for capacity inspection');
    current = parent;
  }
  if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  return current;
}

async function directoryArchiveBytes(root, maximumEntries = 1000000) {
  const stack = [root];
  let bytes = 20n * 1024n;
  let entries = 0;
  while (stack.length) {
    const directory = stack.pop();
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > maximumEntries) throw new Error('Volume contains too many entries for bounded capacity inspection');
      const target = path.join(directory, child.name);
      const stats = await fs.promises.lstat(target, { bigint: true });
      bytes += stats.size + 1024n;
      if (child.isDirectory()) stack.push(target);
      if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Volume size exceeds the safe numeric range');
    }
  }
  return Number(bytes);
}

function hashPassThrough(hash, counter, maximumBytes = MAX_SNAPSHOT_BYTES) {
  return new Transform({
    transform(chunk, encoding, callback) {
      counter.bytes += chunk.length;
      if (counter.bytes > maximumBytes) {
        return callback(new Error('Encrypted volume snapshot exceeded the safety limit'));
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
}

function createEncryptedVolumeSnapshotAdapter({
  dataRoot,
  hostRoot,
  dockerRequest,
  encryptionStore,
  snapshotsDirectory = path.join('application-updates', 'volume-snapshots'),
  snapshotPurpose = 'application-update-volume',
  maximumSnapshotBytes = MAX_SNAPSHOT_BYTES
}) {
  if (!dataRoot || !hostRoot || typeof dockerRequest !== 'function' || !encryptionStore) {
    throw new Error('Encrypted volume snapshots require data, host, Docker and encryption adapters');
  }
  if (
    path.isAbsolute(snapshotsDirectory) || path.normalize(snapshotsDirectory).startsWith('..') ||
    !Number.isSafeInteger(maximumSnapshotBytes) || maximumSnapshotBytes < 1 ||
    typeof snapshotPurpose !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(snapshotPurpose)
  ) throw new Error('Encrypted volume snapshot policy is invalid');
  const snapshotsRoot = path.join(dataRoot, snapshotsDirectory);

  async function volumeMountpoint(name) {
    if (!VOLUME_NAME_PATTERN.test(String(name || ''))) {
      throw new ApplicationUpdateError('Docker volume adı geçersiz.', 409, 'application-update-volume-invalid');
    }
    const details = await dockerRequest('GET', '/volumes/' + encodeURIComponent(name));
    return normalizeMountpoint(hostRoot, details && details.Mountpoint);
  }

  async function inspectCapacity({ volumes, maximumTransactionBytes = maximumSnapshotBytes }) {
    if (
      !Array.isArray(volumes) || volumes.length < 1 ||
      !Number.isSafeInteger(maximumTransactionBytes) || maximumTransactionBytes < 1
    ) throw new Error('Volume capacity inspection policy is invalid');
    const capacityRoot = nearestExistingDirectory(fs.existsSync(snapshotsRoot) ? snapshotsRoot : dataRoot);
    const mountpoints = [];
    let totalBytes = 0;
    for (const volume of volumes) {
      const mountpoint = await volumeMountpoint(volume.name);
      const bytes = await directoryArchiveBytes(mountpoint);
      mountpoints.push(mountpoint);
      totalBytes += bytes;
      if (!Number.isSafeInteger(totalBytes)) throw new Error('Combined volume size exceeds the safe numeric range');
    }
    const volumeDevices = new Set(mountpoints.map((mountpoint) => String(fs.statSync(mountpoint, { bigint: true }).dev)));
    if (volumeDevices.size !== 1) {
      return {
        supported: false,
        reason: 'multiple-volume-filesystems',
        totalBytes,
        maximumTransactionBytes,
        withinTransactionLimit: false,
        capacitySufficient: false
      };
    }
    const snapshotDevice = String(fs.statSync(capacityRoot, { bigint: true }).dev);
    const volumeDevice = [...volumeDevices][0];
    const snapshotAvailableBytes = filesystemAvailableBytes(capacityRoot);
    const volumeAvailableBytes = filesystemAvailableBytes(mountpoints[0]);
    const reserveBytes = Math.max(256 * 1024 * 1024, Math.ceil(totalBytes * 0.05));
    const sharedFilesystem = snapshotDevice === volumeDevice;
    const requiredSnapshotBytes = totalBytes + reserveBytes;
    const requiredTargetBytes = totalBytes + reserveBytes;
    const capacitySufficient = sharedFilesystem
      ? snapshotAvailableBytes >= requiredSnapshotBytes + requiredTargetBytes
      : snapshotAvailableBytes >= requiredSnapshotBytes && volumeAvailableBytes >= requiredTargetBytes;
    return {
      supported: true,
      totalBytes,
      maximumTransactionBytes,
      withinTransactionLimit: totalBytes <= maximumTransactionBytes,
      capacitySufficient,
      sharedFilesystem,
      snapshotAvailableBytes,
      volumeAvailableBytes,
      requiredFreeBytes: sharedFilesystem
        ? requiredSnapshotBytes + requiredTargetBytes
        : Math.max(requiredSnapshotBytes, requiredTargetBytes),
      reserveBytes
    };
  }

  async function createOnce({ operationId, volume }) {
    const mountpoint = await volumeMountpoint(volume.name);
    ensureDirectory(snapshotsRoot);
    const target = path.join(snapshotsRoot, operationId + '-' + crypto.createHash('sha256').update(volume.name).digest('hex').slice(0, 16) + '.enc');
    const temporary = target + '.' + process.pid + '.tmp';
    const key = encryptionStore.ensureKey();
    const context = JSON.stringify({ operationId, purpose: snapshotPurpose, volumeName: volume.name });
    const aad = Buffer.from(context, 'utf8');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const tar = spawn('tar', ['-C', mountpoint, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tarFinished = childResult(tar, 'Volume snapshot');
    const ciphertextDigest = crypto.createHash('sha256');
    const plaintextDigest = crypto.createHash('sha256');
    const ciphertextCounter = { bytes: 0 };
    const plaintextCounter = { bytes: 0 };
    try {
      await Promise.all([
        pipeline(
          tar.stdout,
          hashPassThrough(plaintextDigest, plaintextCounter, maximumSnapshotBytes),
          cipher,
          hashPassThrough(ciphertextDigest, ciphertextCounter, maximumSnapshotBytes + 1024 * 1024),
          fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
        ),
        tarFinished
      ]);
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
      return {
        algorithm: 'aes-256-gcm',
        authTag: cipher.getAuthTag().toString('base64'),
        bytes: ciphertextCounter.bytes,
        ciphertextSha256: ciphertextDigest.digest('hex'),
        file: path.relative(dataRoot, target),
        iv: iv.toString('base64'),
        keyId: encryptionStore.keyId(key),
        context,
        plaintextBytes: plaintextCounter.bytes,
        plaintextSha256: plaintextDigest.digest('hex'),
        volumeName: volume.name
      };
    } catch (error) {
      tar.kill('SIGKILL');
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  async function create(input) {
    try {
      return await createOnce(input);
    } catch (error) {
      if (!/file changed as we read it/i.test(String(error && error.message || ''))) throw error;
      return createOnce(input);
    }
  }

  async function sha256File(target) {
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    await pipeline(fs.createReadStream(target), new Writable({
      write(chunk, encoding, callback) {
        bytes += chunk.length;
        digest.update(chunk);
        callback();
      }
    }));
    return { bytes, digest: digest.digest('hex') };
  }

  async function restore({ snapshot, volume, sourceVolumeName = snapshot && snapshot.volumeName }) {
    if (!snapshot || snapshot.volumeName !== sourceVolumeName || snapshot.algorithm !== 'aes-256-gcm') {
      throw new Error('Volume snapshot metadata does not match the requested volume');
    }
    const target = path.resolve(dataRoot, snapshot.file);
    if (target !== path.resolve(dataRoot) && !target.startsWith(path.resolve(dataRoot) + path.sep)) {
      throw new Error('Volume snapshot path escapes the data root');
    }
    const integrity = await sha256File(target);
    if (integrity.bytes !== snapshot.bytes || integrity.digest !== snapshot.ciphertextSha256) {
      throw new Error('Encrypted volume snapshot integrity check failed');
    }
    const key = encryptionStore.ensureKey();
    if (encryptionStore.keyId(key) !== snapshot.keyId) throw new Error('Volume snapshot key does not match');
    const createDecipher = () => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(snapshot.iv, 'base64'));
      decipher.setAAD(Buffer.from(snapshot.context, 'utf8'));
      decipher.setAuthTag(Buffer.from(snapshot.authTag, 'base64'));
      return decipher;
    };
    const authenticationDigest = crypto.createHash('sha256');
    const authenticationCounter = { bytes: 0 };
    await pipeline(
      fs.createReadStream(target),
      createDecipher(),
      new Writable({
        write(chunk, encoding, callback) {
          authenticationCounter.bytes += chunk.length;
          authenticationDigest.update(chunk);
          callback();
        }
      })
    );
    const authenticatedSha256 = authenticationDigest.digest('hex');
    if (
      snapshot.plaintextSha256 && (
        snapshot.plaintextSha256 !== authenticatedSha256 ||
        snapshot.plaintextBytes !== authenticationCounter.bytes
      )
    ) throw new Error('Decrypted volume snapshot content differs from its authenticated metadata');
    const mountpoint = await volumeMountpoint(volume.name);
    for (const entry of fs.readdirSync(mountpoint)) {
      fs.rmSync(path.join(mountpoint, entry), { force: false, recursive: true });
    }
    const tar = spawn('tar', ['--numeric-owner', '-C', mountpoint, '-xf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    const tarFinished = childResult(tar, 'Volume restore');
    try {
      await Promise.all([
        pipeline(fs.createReadStream(target), createDecipher(), tar.stdin),
        tarFinished
      ]);
    } catch (error) {
      tar.kill('SIGKILL');
      throw error;
    }
    return {
      restored: true,
      plaintextBytes: authenticationCounter.bytes,
      plaintextSha256: authenticatedSha256,
      sourceVolumeName,
      targetVolumeName: volume.name
    };
  }

  return { create, inspectCapacity, restore, paths: { snapshotsRoot } };
}

function createApplicationUpdateManager({
  dataRoot,
  hostRoot,
  dockerRequest,
  getApplicationInventory,
  checkApplicationUpdate,
  composeRunner,
  volumeSnapshots,
  routeRuntime = null,
  publicHealthProbe = async (url) => {
    if (!url) return { skipped: true };
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (response.status < 200 || response.status >= 400) throw new Error('Public endpoint returned HTTP ' + response.status);
    return { skipped: false, status: response.status };
  },
  quiesce = () => new Promise((resolve) => setTimeout(resolve, 1000)),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  readinessAttempts = 60,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (
    !dataRoot || !hostRoot || typeof dockerRequest !== 'function' ||
    typeof getApplicationInventory !== 'function' || typeof checkApplicationUpdate !== 'function' ||
    typeof composeRunner !== 'function' || !volumeSnapshots
  ) {
    throw new Error('Application update manager requires data, host, Docker, inventory, checker, Compose and snapshot adapters');
  }
  if (routeRuntime && (
    typeof routeRuntime.operationRuntimeBinding !== 'function' ||
    typeof routeRuntime.assertOperationRuntimeBinding !== 'function' ||
    typeof routeRuntime.rebindOperationRuntime !== 'function'
  )) throw new Error('Application update route runtime adapter is invalid');
  if (
    typeof quiesce !== 'function' || typeof wait !== 'function' ||
    !Number.isInteger(readinessAttempts) || readinessAttempts < 1 || readinessAttempts > 300
  ) throw new Error('Application update timing policy is invalid');
  const root = path.join(dataRoot, 'application-updates');
  const plansRoot = path.join(root, 'plans');
  const operationsRoot = path.join(root, 'operations');
  const currentRoot = path.join(root, 'current');
  const operationLockFile = path.join(root, 'operation-lock.json');
  const inFlight = new Set();

  async function exactProjectContainers(projectName, serviceNames) {
    const containers = await dockerRequest('GET', '/containers/json?all=true&filters=' + containerFilters(projectName));
    const byService = new Map();
    for (const container of containers || []) {
      const serviceName = container.Labels && container.Labels['com.docker.compose.service'];
      if (!serviceNames.includes(serviceName)) continue;
      if (byService.has(serviceName)) {
        throw new ApplicationUpdateError(
          'Ölçeklenmiş Compose servisleri bu güvenli güncelleme akışında henüz desteklenmiyor.',
          409,
          'application-update-scaled-service-unsupported'
        );
      }
      byService.set(serviceName, container);
    }
    return byService;
  }

  async function resolveApplication(applicationId) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) {
      throw new ApplicationUpdateError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    const inventory = await getApplicationInventory();
    const application = (inventory.applications || []).find((candidate) => candidate.id === applicationId);
    if (!application || !application.runtime || !application.runtime.containerId) {
      throw new ApplicationUpdateError('Uygulama artık sunucuda bulunamıyor.', 404, 'application-not-found');
    }
    const details = await dockerRequest('GET', '/containers/' + application.runtime.containerId + '/json');
    const labels = details && details.Config && details.Config.Labels || {};
    if (labels['com.foxos.core'] === 'true') {
      throw new ApplicationUpdateError('FoxOS çekirdeği bu alandan güncellenemez.', 409, 'core-image-protected');
    }
    const project = resolveComposeProject(details, hostRoot);
    if (!project || !project.service) {
      const binding = labels['com.foxos.managed'] === 'true' && application.managedByServer !== false
        ? verifyManagedBinding(dataRoot, details)
        : null;
      if (!binding) {
        throw new ApplicationUpdateError(
          'Bu uygulamanın doğrulanmış Compose veya sunucu çalışma kaynağı yok; otomatik güncelleme uygulanamaz.',
          409,
          'application-update-source-required'
        );
      }
      return { application, binding, details, labels, mode: 'server-runtime', project: null };
    }
    if (
      project.files.some((file) => file.hostPath === '/opt/foxos' || file.hostPath.startsWith('/opt/foxos/')) ||
      project.workingDirectory === '/opt/foxos' || project.workingDirectory.startsWith('/opt/foxos/')
    ) {
      throw new ApplicationUpdateError('FoxOS kurulum dosyaları bu işlemden korunuyor.', 409, 'core-compose-path-protected');
    }
    return { application, binding: null, details, labels, mode: 'compose', project };
  }

  function writableNamedVolumes(details) {
    const volumes = new Map();
    for (const mount of details && details.Mounts || []) {
      if (mount.RW === false) continue;
      if (mount.Type !== 'volume' || !mount.Name) {
        throw new ApplicationUpdateError(
          'Uygulama yazılabilir bir bind/özel mount kullanıyor; geri alma garantisi olmadan güncelleme engellendi.',
          409,
          'application-update-writable-mount-unsupported'
        );
      }
      if (!VOLUME_NAME_PATTERN.test(mount.Name)) {
        throw new ApplicationUpdateError('Docker volume adı geçersiz.', 409, 'application-update-volume-invalid');
      }
      volumes.set(mount.Name, { name: mount.Name, destination: mount.Destination });
    }
    if (volumes.size > MAX_UPDATE_VOLUMES) {
      throw new ApplicationUpdateError('Güncellenecek volume sayısı güvenli sınırı aşıyor.', 409, 'application-update-volume-limit');
    }
    return volumes;
  }

  async function assertVolumesExclusive(volumes, targetIds) {
    if (!volumes.size) return;
    const allContainers = await dockerRequest('GET', '/containers/json?all=true');
    for (const container of allContainers || []) {
      if (targetIds.has(container.Id) || container.State !== 'running') continue;
      const shared = (container.Mounts || []).find((mount) => mount.Name && volumes.has(mount.Name));
      if (shared) {
        throw new ApplicationUpdateError(
          shared.Name + ' volume alanı güncelleme grubu dışındaki çalışan bir container tarafından kullanılıyor.',
          409,
          'application-update-shared-volume-blocked'
        );
      }
    }
  }

  async function createManagedRuntimePlan(resolved, update) {
    const details = resolved.details;
    const currentHealth = details.State && details.State.Health && details.State.Health.Status;
    if (!details.State || details.State.Running !== true || (currentHealth && currentHealth !== 'healthy')) {
      throw new ApplicationUpdateError(
        'Sunucu çalışma örneği sağlıklı ve çalışır durumda değil.',
        409,
        'application-update-source-unhealthy'
      );
    }
    if (
      !IMAGE_ID_PATTERN.test(String(details.Image || '')) ||
      !update.source || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/.test(String(update.source.reference || '')) ||
      !update.latest || !IMAGE_DIGEST_PATTERN.test(String(update.latest.digest || ''))
    ) {
      throw new ApplicationUpdateError(
        'Sunucu çalışma örneğinin güncel registry kaynağı değişmez kimlikle kanıtlanamadı.',
        409,
        'application-update-source-unproven'
      );
    }
    const containerName = safeContainerName(details.Name);
    const runtimeReference = String(details.Config && details.Config.Image || '').trim();
    const networks = networkAttachments(details);
    const initialNetwork = String(details.HostConfig && details.HostConfig.NetworkMode || '');
    if (
      !containerName || !COMPOSE_NAME_PATTERN.test(containerName) || !runtimeReference ||
      !networks.length || !networks.some((network) => network.name === initialNetwork)
    ) {
      throw new ApplicationUpdateError(
        'Sunucu çalışma örneğinin container veya ağ kimliği güvenle yeniden üretilemiyor.',
        409,
        'application-update-runtime-contract-unsupported'
      );
    }
    const volumes = writableNamedVolumes(details);
    await assertVolumesExclusive(volumes, new Set([details.Id]));
    const planId = 'auplan_' + randomUUID().replace(/-/g, '');
    const createdAt = nowIso(clock);
    const plan = {
      schemaVersion: APPLICATION_UPDATE_OPERATION_SCHEMA_VERSION,
      planId,
      applicationId: resolved.application.id,
      applicationName: resolved.application.name,
      createdAt,
      expiresAt: new Date(new Date(createdAt).getTime() + 15 * 60 * 1000).toISOString(),
      status: 'ready',
      update,
      project: {
        mode: 'server-runtime',
        projectName: 'server-runtime',
        serviceName: containerName,
        workingDirectory: null,
        files: [],
        rollbackOverrides: [],
        imageReference: update.source.reference,
        runtimeReference,
        runtimeFingerprint: managedRuntimeFingerprint(details),
        bindingKind: resolved.binding.kind,
        bindingOperationId: resolved.binding.operationId
      },
      routeBinding: routeRuntime ? routeRuntime.operationRuntimeBinding(details.Id) : null,
      services: [{
        name: containerName,
        action: 'pull',
        containerId: details.Id,
        containerName,
        imageId: details.Image,
        running: true,
        health: currentHealth || 'running'
      }],
      volumes: [...volumes.values()],
      publicUrl: resolved.application.externalUrl || null,
      providerMayOverwrite: false
    };
    atomicWriteJson(recordPath(plansRoot, planId), plan);
    return publicPlan(plan);
  }

  async function createPlan(applicationId) {
    const resolved = await resolveApplication(applicationId);
    const update = await checkApplicationUpdate(applicationId);
    if (update.updateAvailable !== true || update.status !== 'update-available') {
      throw new ApplicationUpdateError(
        update.message || 'Uygulama için doğrulanmış bir güncelleme bulunamadı.',
        409,
        'application-update-not-available'
      );
    }
    if (resolved.mode === 'server-runtime') return createManagedRuntimePlan(resolved, update);
    const services = mergeComposeServices(resolved.project.files);
    const serviceNames = reverseDependentServices(services, resolved.project.serviceName);
    if (!serviceNames.length || serviceNames.length > MAX_UPDATE_SERVICES || serviceNames.some((name) => !COMPOSE_NAME_PATTERN.test(name))) {
      throw new ApplicationUpdateError('Compose servis grafiği güvenli sınırı aşıyor.', 409, 'application-update-service-graph-blocked');
    }
    const byService = await exactProjectContainers(resolved.project.projectName, serviceNames);
    const serviceRecords = [];
    const volumes = new Map();
    for (const name of serviceNames) {
      const definition = services[name];
      if (!definition || typeof definition !== 'object') {
        throw new ApplicationUpdateError('Compose servis tanımı eksik: ' + name, 409, 'application-update-service-missing');
      }
      const summary = byService.get(name) || null;
      if (!summary) {
        throw new ApplicationUpdateError(
          name + ' servisi çalışır Compose grubunda bulunamadı; güncelleme yeni bir servis oluşturamaz.',
          409,
          'application-update-dependent-service-missing'
        );
      }
      let details = null;
      details = await dockerRequest('GET', '/containers/' + summary.Id + '/json');
      if (!details.State || details.State.Running !== true) {
        throw new ApplicationUpdateError(
          name + ' servisi çalışmıyor; grup durumu değiştirilmeden önce düzeltilmeli.',
          409,
          'application-update-service-not-running'
        );
      }
      const currentHealth = details.State.Health && details.State.Health.Status;
      if (currentHealth && currentHealth !== 'healthy') {
        throw new ApplicationUpdateError(
          name + ' servisi sağlıklı değil; güncelleme önce mevcut sağlığı kanıtlamalı.',
          409,
          'application-update-source-unhealthy'
        );
      }
      for (const mount of details && details.Mounts || []) {
        if (mount.RW === false) continue;
        if (mount.Type !== 'volume' || !mount.Name) {
          throw new ApplicationUpdateError(
            name + ' servisi yazılabilir bir bind/özel mount kullanıyor; geri alma garantisi olmadan güncelleme engellendi.',
            409,
            'application-update-writable-mount-unsupported'
          );
        }
        if (!VOLUME_NAME_PATTERN.test(mount.Name)) {
          throw new ApplicationUpdateError('Docker volume adı geçersiz.', 409, 'application-update-volume-invalid');
        }
        volumes.set(mount.Name, { name: mount.Name, destination: mount.Destination });
      }
      const imageId = details.Image || summary.ImageID || null;
      if (!IMAGE_ID_PATTERN.test(String(imageId || ''))) {
        throw new ApplicationUpdateError('Mevcut servis imajı değişmez kimlikle bağlanamadı.', 409, 'application-update-image-id-missing');
      }
      serviceRecords.push({
        name,
        action: definition.build ? 'build' : typeof definition.image === 'string' ? 'pull' : 'recreate',
        containerId: summary.Id,
        containerName: safeContainerName(summary.Names && summary.Names[0]),
        imageId,
        running: true,
        health: currentHealth || 'running'
      });
    }
    if (volumes.size > MAX_UPDATE_VOLUMES) {
      throw new ApplicationUpdateError('Güncellenecek volume sayısı güvenli sınırı aşıyor.', 409, 'application-update-volume-limit');
    }
    if (volumes.size) {
      const allContainers = await dockerRequest('GET', '/containers/json?all=true');
      const targetIds = new Set(serviceRecords.map((service) => service.containerId));
      for (const container of allContainers || []) {
        if (targetIds.has(container.Id) || container.State !== 'running') continue;
        const shared = (container.Mounts || []).find((mount) => mount.Name && volumes.has(mount.Name));
        if (shared) {
          throw new ApplicationUpdateError(
            shared.Name + ' volume alanı güncelleme grubu dışındaki çalışan bir container tarafından kullanılıyor.',
            409,
            'application-update-shared-volume-blocked'
          );
        }
      }
    }
    const planId = 'auplan_' + randomUUID().replace(/-/g, '');
    const createdAt = nowIso(clock);
    const plan = {
      schemaVersion: APPLICATION_UPDATE_OPERATION_SCHEMA_VERSION,
      planId,
      applicationId,
      applicationName: resolved.application.name,
      createdAt,
      expiresAt: new Date(new Date(createdAt).getTime() + 15 * 60 * 1000).toISOString(),
      status: 'ready',
      update,
      project: {
        projectName: resolved.project.projectName,
        serviceName: resolved.project.serviceName,
        workingDirectory: resolved.project.workingDirectory,
        files: resolved.project.files.map((file) => ({
          hostPath: file.hostPath,
          revision: file.revision
        })),
        rollbackOverrides: [...(resolved.project.ignoredConfigPaths || [])]
      },
      routeBinding: routeRuntime ? routeRuntime.operationRuntimeBinding(resolved.details.Id) : null,
      services: serviceRecords,
      volumes: [...volumes.values()],
      publicUrl: resolved.application.externalUrl || null,
      providerMayOverwrite: Object.keys(resolved.labels).some((key) => key.startsWith('coolify.'))
    };
    atomicWriteJson(recordPath(plansRoot, planId), plan);
    return publicPlan(plan);
  }

  function getPlan(planId) {
    if (!PLAN_ID_PATTERN.test(String(planId || ''))) {
      throw new ApplicationUpdateError('Güncelleme planı kimliği geçersiz.', 400, 'application-update-plan-id-invalid');
    }
    const plan = readJson(recordPath(plansRoot, planId));
    if (!plan) throw new ApplicationUpdateError('Güncelleme planı bulunamadı.', 404, 'application-update-plan-not-found');
    return plan;
  }

  function getOperation(operationId) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) {
      throw new ApplicationUpdateError('Güncelleme işlemi kimliği geçersiz.', 400, 'application-update-operation-id-invalid');
    }
    const operation = readJson(recordPath(operationsRoot, operationId));
    if (!operation) throw new ApplicationUpdateError('Güncelleme işlemi bulunamadı.', 404, 'application-update-operation-not-found');
    return publicOperation(operation);
  }

  function current(applicationId) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) {
      throw new ApplicationUpdateError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    return publicOperation(readJson(recordPath(currentRoot, applicationId)));
  }

  function acquireLock(operation) {
    ensureDirectory(root);
    const existing = readJson(operationLockFile);
    if (existing) {
      throw new ApplicationUpdateError('Sunucuda başka bir uygulama güncellemesi sürüyor.', 409, 'application-update-in-progress');
    }
    atomicWriteJson(operationLockFile, {
      operationId: operation.operationId,
      applicationId: operation.applicationId,
      acquiredAt: nowIso(clock)
    });
  }

  function releaseLock(operationId) {
    const existing = readJson(operationLockFile);
    if (existing && existing.operationId === operationId) {
      try { fs.unlinkSync(operationLockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async function assertNoDrift(plan) {
    if (new Date(plan.expiresAt).getTime() <= new Date(clock()).getTime()) {
      throw new ApplicationUpdateError('Güncelleme planının süresi doldu; yeniden denetleyin.', 409, 'application-update-plan-expired');
    }
    const resolved = await resolveApplication(plan.applicationId);
    if (plan.project.mode === 'server-runtime') {
      const service = plan.services[0];
      if (
        resolved.mode !== 'server-runtime' || resolved.details.Id !== service.containerId ||
        resolved.details.Image !== service.imageId ||
        managedRuntimeFingerprint(resolved.details) !== plan.project.runtimeFingerprint ||
        !resolved.binding || resolved.binding.kind !== plan.project.bindingKind ||
        resolved.binding.operationId !== plan.project.bindingOperationId
      ) {
        throw new ApplicationUpdateError(
          'Sunucu çalışma örneği planlamadan sonra değişti; yeniden denetleyin.',
          409,
          'application-update-runtime-drift'
        );
      }
      await assertVolumesExclusive(new Map(plan.volumes.map((volume) => [volume.name, volume])), new Set([service.containerId]));
      if (plan.routeBinding && routeRuntime) {
        routeRuntime.assertOperationRuntimeBinding(plan.routeBinding, plan.routeBinding.runtimeContainerId);
      }
      const update = await checkApplicationUpdate(plan.applicationId);
      if (
        update.updateAvailable !== true ||
        update.latest && update.latest.digest !== (plan.update.latest && plan.update.latest.digest) ||
        !update.source || update.source.reference !== plan.project.imageReference
      ) {
        throw new ApplicationUpdateError('Registry sonucu değişti; yeniden denetleyin.', 409, 'application-update-registry-drift');
      }
      return;
    }
    if (
      resolved.project.projectName !== plan.project.projectName ||
      resolved.project.serviceName !== plan.project.serviceName ||
      resolved.project.workingDirectory !== plan.project.workingDirectory
    ) {
      throw new ApplicationUpdateError('Compose proje kimliği değişti; yeniden denetleyin.', 409, 'application-update-compose-drift');
    }
    for (const plannedFile of plan.project.files) {
      const currentFile = resolved.project.files.find((file) => file.hostPath === plannedFile.hostPath);
      if (!currentFile || composeRevision(currentFile.content) !== plannedFile.revision) {
        throw new ApplicationUpdateError('Compose dosyası değişti; yeniden denetleyin.', 409, 'application-update-compose-drift');
      }
    }
    const byService = await exactProjectContainers(plan.project.projectName, plan.services.map((service) => service.name));
    for (const service of plan.services) {
      const currentContainer = byService.get(service.name) || null;
      if ((currentContainer && currentContainer.Id || null) !== service.containerId) {
        throw new ApplicationUpdateError('Çalışan servis kimliği değişti; yeniden denetleyin.', 409, 'application-update-runtime-drift');
      }
      if (currentContainer) {
        const details = await dockerRequest('GET', '/containers/' + currentContainer.Id + '/json');
        if (details.Image !== service.imageId) {
          throw new ApplicationUpdateError('Çalışan servis imajı değişti; yeniden denetleyin.', 409, 'application-update-image-drift');
        }
      }
    }
    if (plan.routeBinding && routeRuntime) {
      routeRuntime.assertOperationRuntimeBinding(plan.routeBinding, plan.routeBinding.runtimeContainerId);
    }
    const update = await checkApplicationUpdate(plan.applicationId);
    if (
      update.updateAvailable !== true ||
      update.latest && update.latest.digest !== (plan.update.latest && plan.update.latest.digest)
    ) {
      throw new ApplicationUpdateError('Registry sonucu değişti; yeniden denetleyin.', 409, 'application-update-registry-drift');
    }
  }

  function rollbackTag(operationId, projectName, serviceName) {
    const repository = 'server-recovery/' + (projectName + '-' + serviceName)
      .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 120);
    return { repository, tag: operationId.replace(/^auop_/, '').slice(0, 16) };
  }

  async function tagPreviousImages(operation, plan) {
    for (const service of plan.services) {
      if (!service.imageId) continue;
      const tag = rollbackTag(operation.operationId, plan.project.projectName, service.name);
      await dockerRequest(
        'POST',
        '/images/' + encodeURIComponent(service.imageId) + '/tag?repo=' + encodeURIComponent(tag.repository) + '&tag=' + encodeURIComponent(tag.tag)
      );
      service.rollbackImage = tag.repository + ':' + tag.tag;
    }
  }

  function mutableTagParts(reference) {
    const value = String(reference || '');
    const lastSlash = value.lastIndexOf('/');
    const lastColon = value.lastIndexOf(':');
    if (lastColon <= lastSlash || value.includes('@')) return null;
    const repository = value.slice(0, lastColon);
    const tag = value.slice(lastColon + 1);
    return repository && tag ? { repository, tag } : null;
  }

  async function tagManagedRuntimeImage(imageId, runtimeReference) {
    const runtimeTag = mutableTagParts(runtimeReference);
    if (!runtimeTag || !IMAGE_ID_PATTERN.test(String(imageId || ''))) {
      throw new ApplicationUpdateError(
        'Sunucu çalışma imajı değiştirilebilir yerel bir etikete bağlı değil.',
        409,
        'application-update-runtime-reference-unsupported'
      );
    }
    await dockerRequest(
      'POST',
      '/images/' + encodeURIComponent(imageId) + '/tag?repo=' + encodeURIComponent(runtimeTag.repository) +
        '&tag=' + encodeURIComponent(runtimeTag.tag)
    );
    const tagged = await dockerRequest('GET', '/images/' + encodeURIComponent(runtimeReference) + '/json');
    if (!tagged || tagged.Id !== imageId) {
      throw new ApplicationUpdateError(
        'İmaj sunucu çalışma etiketine bağlanamadı.',
        502,
        'application-update-runtime-tag-failed'
      );
    }
  }

  async function pullManagedRuntimeImage(plan) {
    await dockerRequest('POST', imagePullPath(plan.project.imageReference));
    const pulled = await dockerRequest('GET', '/images/' + encodeURIComponent(plan.project.imageReference) + '/json');
    if (
      !pulled || !IMAGE_ID_PATTERN.test(String(pulled.Id || '')) ||
      !repositoryDigestMatches(pulled, plan.update.latest && plan.update.latest.digest)
    ) {
      throw new ApplicationUpdateError(
        'İndirilen imaj registry güncelleme digest’iyle eşleşmiyor.',
        409,
        'application-update-pulled-image-mismatch'
      );
    }
    await tagManagedRuntimeImage(pulled.Id, plan.project.runtimeReference);
    return pulled;
  }

  async function waitForManagedRuntime(containerId, imageId) {
    let last = null;
    for (let attempt = 1; attempt <= readinessAttempts; attempt += 1) {
      last = await dockerRequest('GET', '/containers/' + containerId + '/json');
      const running = Boolean(last && last.State && last.State.Running);
      const health = last && last.State && last.State.Health && last.State.Health.Status;
      if (running && last.Image === imageId && (!last.Config.Healthcheck || health === 'healthy')) return last;
      if (last && last.State && ['exited', 'dead'].includes(last.State.Status)) break;
      if (attempt < readinessAttempts) await wait(1000);
    }
    throw new ApplicationUpdateError(
      'Yeni sunucu çalışma örneği health kontrolünü geçemedi.',
      503,
      'application-update-runtime-health-failed'
    );
  }

  async function removeContainer(containerId) {
    try {
      const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
      if (details.State && details.State.Running) {
        await dockerRequest('POST', '/containers/' + containerId + '/stop?t=10');
      }
      await dockerRequest('DELETE', '/containers/' + containerId + '?v=1&force=1');
    } catch (error) {
      if (!/No such container/i.test(String(error && error.message || ''))) throw error;
    }
  }

  async function replaceManagedRuntime(plan, operation, targetImageId, targetReference, expectedContainerId) {
    const service = plan.services[0];
    const current = await dockerRequest('GET', '/containers/' + expectedContainerId + '/json');
    if (
      !current || current.Id !== expectedContainerId || !IMAGE_ID_PATTERN.test(String(current.Image || '')) ||
      current.State && current.State.Running === true
    ) {
      throw new ApplicationUpdateError(
        'Sunucu çalışma örneği güvenli değiştirme öncesinde durmuş ve sabit değil.',
        409,
        'application-update-runtime-not-quiesced'
      );
    }
    const name = safeContainerName(current.Name) || service.containerName;
    const networks = networkAttachments(current);
    const initialNetwork = String(current.HostConfig && current.HostConfig.NetworkMode || '');
    const initialAttachment = networks.find((network) => network.name === initialNetwork);
    if (!name || !initialAttachment) {
      throw new ApplicationUpdateError(
        'Sunucu çalışma örneğinin ağ kimliği yeniden üretilemiyor.',
        409,
        'application-update-runtime-contract-unsupported'
      );
    }
    const previousName = replacementContainerName(name, operation.operationId);
    let replacementId = null;
    let currentRenamed = false;
    let routeRebound = false;
    let bindingPersisted = false;
    let routeBinding = operation.routeRuntime || plan.routeBinding || null;
    try {
      await dockerRequest('POST', '/containers/' + current.Id + '/rename?name=' + encodeURIComponent(previousName));
      currentRenamed = true;
      const aliasesFor = (attachment) => attachment.aliases.filter((alias) => (
        alias !== current.Id && alias !== current.Id.slice(0, 12)
      ));
      const payload = clonedContainerPayload(current, targetReference, initialNetwork, aliasesFor(initialAttachment));
      const created = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(name), payload);
      if (!created || !CONTAINER_ID_PATTERN.test(String(created.Id || ''))) {
        throw new Error('Docker did not return a replacement container identity');
      }
      replacementId = created.Id;
      for (const network of networks.filter((entry) => entry.name !== initialNetwork)) {
        await dockerRequest('POST', '/networks/' + encodeURIComponent(network.name) + '/connect', {
          Container: replacementId,
          EndpointConfig: { Aliases: aliasesFor(network) }
        });
      }
      await dockerRequest('POST', '/containers/' + replacementId + '/start');
      const replacement = await waitForManagedRuntime(replacementId, targetImageId);
      if (!replacement.Config || replacement.Config.Image !== targetReference) {
        throw new Error('Replacement runtime image reference differs from the planned server tag');
      }
      if (plan.routeBinding && routeRuntime) {
        routeBinding = await routeRuntime.rebindOperationRuntime(
          plan.routeBinding,
          replacement.Id,
          routeBinding && routeBinding.runtimeContainerId || current.Id
        );
        routeRebound = true;
      }
      await publicHealthProbe(plan.publicUrl);
      persistManagedBinding(dataRoot, current, replacement, targetReference);
      bindingPersisted = true;
      let cleanupError = null;
      try {
        await dockerRequest('DELETE', '/containers/' + current.Id + '?v=1&force=1');
      } catch (error) {
        cleanupError = error.message;
      }
      return {
        cleanupError,
        routeBinding,
        service: {
          name: service.name,
          containerId: replacement.Id,
          containerName: name,
          imageId: replacement.Image,
          previousImageId: service.imageId,
          rollbackImage: service.rollbackImage || null,
          health: replacement.State && replacement.State.Health && replacement.State.Health.Status || 'running'
        }
      };
    } catch (error) {
      if (bindingPersisted) throw error;
      if (replacementId) {
        try { await removeContainer(replacementId); } catch { /* Preserve the primary failure. */ }
      }
      let currentRestarted = false;
      try {
        await dockerRequest('POST', '/containers/' + current.Id + '/start');
        currentRestarted = true;
      } catch { /* Outer rollback records failure. */ }
      if (routeRebound && routeRuntime && replacementId && currentRestarted) {
        try {
          await routeRuntime.rebindOperationRuntime(plan.routeBinding, current.Id, replacementId);
        } catch { /* Preserve the primary failure for the outer rollback record. */ }
      }
      if (currentRenamed) {
        try {
          await dockerRequest('POST', '/containers/' + current.Id + '/rename?name=' + encodeURIComponent(name));
        } catch { /* Preserve the primary failure. */ }
      }
      throw error;
    }
  }

  async function verifyRuntime(plan, operation) {
    const byService = await exactProjectContainers(plan.project.projectName, plan.services.map((service) => service.name));
    const verified = [];
    for (const service of plan.services) {
      const container = byService.get(service.name);
      if (!container) throw new Error(service.name + ' container was not recreated');
      const details = await dockerRequest('GET', '/containers/' + container.Id + '/json');
      if (!details.State || details.State.Running !== true) throw new Error(service.name + ' is not running');
      const health = details.State.Health && details.State.Health.Status;
      if (health && health !== 'healthy') throw new Error(service.name + ' health is ' + health);
      verified.push({
        name: service.name,
        containerId: container.Id,
        containerName: safeContainerName(container.Names && container.Names[0]),
        imageId: details.Image,
        health: health || 'running'
      });
    }
    if (plan.routeBinding && routeRuntime) {
      const primary = verified.find((service) => service.name === plan.project.serviceName);
      if (!primary) throw new Error('Primary application runtime was not recreated');
      const expectedContainerId = operation.routeRuntime && operation.routeRuntime.runtimeContainerId ||
        plan.routeBinding.runtimeContainerId;
      operation.routeRuntime = await routeRuntime.rebindOperationRuntime(
        plan.routeBinding,
        primary.containerId,
        expectedContainerId
      );
      atomicWriteJson(recordPath(operationsRoot, operation.operationId), operation);
    }
    await publicHealthProbe(plan.publicUrl);
    return verified;
  }

  async function assertServicesStopped(plan) {
    if (plan.project.mode === 'server-runtime') {
      const service = plan.services[0];
      const details = await dockerRequest('GET', '/containers/' + service.containerId + '/json');
      if (details.State && details.State.Running === true) {
        throw new ApplicationUpdateError(
          service.name + ' çalışma örneği durmadı; veri yedeği alınmadan işlem iptal edildi.',
          409,
          'application-update-service-stop-unproven'
        );
      }
      return;
    }
    const byService = await exactProjectContainers(plan.project.projectName, plan.services.map((service) => service.name));
    for (const service of plan.services) {
      const container = byService.get(service.name);
      if (!container) continue;
      const details = await dockerRequest('GET', '/containers/' + container.Id + '/json');
      if (details.State && details.State.Running === true) {
        throw new ApplicationUpdateError(
          service.name + ' servisi durmadı; veri yedeği alınmadan işlem iptal edildi.',
          409,
          'application-update-service-stop-unproven'
        );
      }
    }
  }

  function cleanupSupersededRollbackOverrides(plan, retainedHostPath = null) {
    const failures = [];
    for (const hostPath of plan.project.rollbackOverrides || []) {
      if (hostPath === retainedHostPath || !isApplicationUpdateRollbackOverride(hostPath)) continue;
      const mountedPath = mountedPathForHostPath(hostRoot, hostPath);
      try { fs.unlinkSync(mountedPath); } catch (error) {
        if (error.code !== 'ENOENT') failures.push({ hostPath, error: error.message });
      }
    }
    return failures;
  }

  function writeRollbackOverride(plan, operation) {
    const hostPath = path.posix.join(
      path.posix.dirname(plan.project.files[0].hostPath),
      '.server-update-' + operation.operationId.slice(-12) + '-rollback.yml'
    );
    const mountedPath = mountedPathForHostPath(hostRoot, hostPath);
    const services = {};
    for (const service of plan.services) {
      if (service.rollbackImage) services[service.name] = { image: service.rollbackImage };
    }
    if (!Object.keys(services).length) throw new Error('No previous images were retained for rollback');
    const content = YAML.stringify({ services });
    try {
      fs.writeFileSync(mountedPath, content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST' || fs.readFileSync(mountedPath, 'utf8') !== content) throw error;
    }
    return { hostPath, mountedPath };
  }

  async function restoreOperation(plan, operation, { restoreVolumes = true } = {}) {
    if (plan.project.mode === 'server-runtime') {
      const service = operation.services[0] || {};
      const currentId = service.containerId || plan.services[0].containerId;
      let current = await dockerRequest('GET', '/containers/' + currentId + '/json');
      if (current.State && current.State.Running) {
        await dockerRequest('POST', '/containers/' + current.Id + '/stop?t=10');
      }
      current = await dockerRequest('GET', '/containers/' + current.Id + '/json');
      if (current.State && current.State.Running) {
        throw new ApplicationUpdateError(
          'Sunucu çalışma örneği geri alma için durmadı.',
          409,
          'application-update-service-stop-unproven'
        );
      }
      if (restoreVolumes && plan.volumes.length) await quiesce();
      if (restoreVolumes) {
        for (const volume of plan.volumes) {
          const snapshot = operation.volumeSnapshots.find((candidate) => candidate.volumeName === volume.name);
          if (!snapshot) throw new Error('Stateful rollback snapshot is missing for ' + volume.name);
          await volumeSnapshots.restore({ snapshot, volume });
        }
      }
      const previousImageId = service.previousImageId || plan.services[0].imageId;
      await tagManagedRuntimeImage(previousImageId, plan.project.runtimeReference);
      if (current.Image === previousImageId) {
        await dockerRequest('POST', '/containers/' + current.Id + '/start');
        const verified = await waitForManagedRuntime(current.Id, previousImageId);
        await publicHealthProbe(plan.publicUrl);
        return [{
          name: plan.services[0].name,
          containerId: verified.Id,
          containerName: safeContainerName(verified.Name),
          imageId: verified.Image,
          previousImageId,
          rollbackImage: service.rollbackImage || null,
          health: verified.State && verified.State.Health && verified.State.Health.Status || 'running'
        }];
      }
      const replaced = await replaceManagedRuntime(
        plan,
        operation,
        previousImageId,
        plan.project.runtimeReference,
        current.Id
      );
      operation.routeRuntime = replaced.routeBinding;
      operation.directCleanupError = replaced.cleanupError;
      return [replaced.service];
    }
    await composeRunner({ operation: 'stop', project: plan.project, services: plan.services.map((service) => service.name) });
    await assertServicesStopped(plan);
    if (restoreVolumes && plan.volumes.length) await quiesce();
    if (restoreVolumes) {
      for (const volume of plan.volumes) {
        const snapshot = operation.volumeSnapshots.find((candidate) => candidate.volumeName === volume.name);
        if (!snapshot) throw new Error('Stateful rollback snapshot is missing for ' + volume.name);
        await volumeSnapshots.restore({ snapshot, volume });
      }
    }
    const override = writeRollbackOverride(plan, operation);
    operation.rollbackOverrideFile = override.hostPath;
    atomicWriteJson(recordPath(operationsRoot, operation.operationId), operation);
    await composeRunner({
      operation: 'rollback',
      project: plan.project,
      services: plan.services.map((service) => service.name),
      overrideFile: override.hostPath
    });
    const verified = await verifyRuntime(plan, operation);
    operation.rollbackOverrideCleanup = cleanupSupersededRollbackOverrides(plan, override.hostPath);
    return verified;
  }

  async function assertRollbackRuntime(plan, operation) {
    if (plan.project.mode === 'server-runtime') {
      const expected = operation.services[0];
      if (!expected || !CONTAINER_ID_PATTERN.test(String(expected.containerId || ''))) {
        throw new ApplicationUpdateError(
          'Güncellenmiş sunucu çalışma kimliği bulunamadı.',
          409,
          'application-update-rollback-runtime-drift'
        );
      }
      const details = await dockerRequest('GET', '/containers/' + expected.containerId + '/json');
      if (details.Id !== expected.containerId || details.Image !== expected.imageId) {
        throw new ApplicationUpdateError(
          'Güncellemeden sonra sunucu çalışma kimliği değişti; otomatik geri alma engellendi.',
          409,
          'application-update-rollback-runtime-drift'
        );
      }
      return;
    }
    const byService = await exactProjectContainers(plan.project.projectName, plan.services.map((service) => service.name));
    for (const expected of operation.services || []) {
      const container = byService.get(expected.name);
      if (!container || container.Id !== expected.containerId) {
        throw new ApplicationUpdateError(
          'Güncellemeden sonra servis kimliği değişti; eski veriyle otomatik geri alma engellendi.',
          409,
          'application-update-rollback-runtime-drift'
        );
      }
      const details = await dockerRequest('GET', '/containers/' + container.Id + '/json');
      if (details.Image !== expected.imageId) {
        throw new ApplicationUpdateError(
          'Güncellemeden sonra servis imajı değişti; eski veriyle otomatik geri alma engellendi.',
          409,
          'application-update-rollback-runtime-drift'
        );
      }
    }
  }

  async function applyPlan(planId, input = {}) {
    if (input.confirmation !== APPLY_APPLICATION_UPDATE_CONFIRMATION) {
      throw new ApplicationUpdateError('Güncelleme açık onay gerektiriyor.', 400, 'application-update-confirmation-required');
    }
    const plan = getPlan(planId);
    if (plan.status !== 'ready') {
      throw new ApplicationUpdateError('Bu güncelleme planı artık uygulanamaz.', 409, 'application-update-plan-consumed');
    }
    if (inFlight.has(plan.applicationId)) {
      throw new ApplicationUpdateError('Bu uygulamanın güncellemesi zaten sürüyor.', 409, 'application-update-in-progress');
    }
    const operationId = 'auop_' + randomUUID().replace(/-/g, '');
    const operation = {
      schemaVersion: APPLICATION_UPDATE_OPERATION_SCHEMA_VERSION,
      operationId,
      planId,
      applicationId: plan.applicationId,
      status: 'preparing',
      startedAt: nowIso(clock),
      current: plan.update.current,
      latest: plan.update.latest,
      services: plan.services.map((service) => ({ name: service.name })),
      volumeSnapshots: [],
      rollbackAvailable: false,
      message: 'Güncelleme hazırlanıyor.'
    };
    inFlight.add(plan.applicationId);
    try {
      acquireLock(operation);
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
    } catch (error) {
      inFlight.delete(plan.applicationId);
      throw error;
    }
    let servicesStopped = false;
    let updatedRuntimeStarted = false;
    try {
      await assertNoDrift(plan);
      await tagPreviousImages(operation, plan);
      operation.services = plan.services.map((service) => ({
        name: service.name,
        containerId: service.containerId,
        containerName: service.containerName,
        previousImageId: service.imageId,
        rollbackImage: service.rollbackImage || null
      }));
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);

      let managedImage = null;
      if (plan.project.mode === 'server-runtime') {
        managedImage = await pullManagedRuntimeImage(plan);
      } else {
        const buildServices = plan.services.filter((service) => service.action === 'build').map((service) => service.name);
        const pullServices = plan.services.filter((service) => service.action === 'pull').map((service) => service.name);
        if (buildServices.length) await composeRunner({ operation: 'build', project: plan.project, services: buildServices });
        if (pullServices.length) await composeRunner({ operation: 'pull', project: plan.project, services: pullServices });
      }

      operation.status = 'backing-up';
      operation.message = 'Servisler durduruluyor ve kalıcı veriler şifreli yedekleniyor.';
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      if (plan.project.mode === 'server-runtime') {
        await dockerRequest('POST', '/containers/' + plan.services[0].containerId + '/stop?t=10');
      } else {
        await composeRunner({ operation: 'stop', project: plan.project, services: plan.services.map((service) => service.name) });
      }
      servicesStopped = true;
      await assertServicesStopped(plan);
      if (plan.volumes.length) await quiesce();
      for (const volume of plan.volumes) {
        const snapshot = await volumeSnapshots.create({ operationId, volume });
        operation.volumeSnapshots.push(snapshot);
        atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      }

      operation.rollbackAvailable = plan.services.every((service) => service.rollbackImage) &&
        operation.volumeSnapshots.length === plan.volumes.length;
      operation.status = 'applying';
      operation.message = 'Yeni imajlar uygulanıyor ve servis sağlığı doğrulanıyor.';
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      updatedRuntimeStarted = true;
      if (plan.project.mode === 'server-runtime') {
        const replaced = await replaceManagedRuntime(
          plan,
          operation,
          managedImage.Id,
          plan.project.runtimeReference,
          plan.services[0].containerId
        );
        operation.routeRuntime = replaced.routeBinding;
        operation.directCleanupError = replaced.cleanupError;
        operation.services = [replaced.service];
      } else {
        await composeRunner({ operation: 'up', project: plan.project, services: plan.services.map((service) => service.name) });
        operation.services = await verifyRuntime(plan, operation);
        operation.rollbackOverrideCleanup = cleanupSupersededRollbackOverrides(plan);
      }
      operation.status = 'completed';
      operation.completedAt = nowIso(clock);
      operation.message = 'Güncelleme uygulandı; bağlı servisler ve erişim adresi sağlıklı.';
      plan.status = 'applied';
      atomicWriteJson(recordPath(plansRoot, planId), plan);
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      atomicWriteJson(recordPath(currentRoot, plan.applicationId), operation);
      return publicOperation(operation);
    } catch (error) {
      if (!servicesStopped) {
        operation.status = 'failed-before-cutover';
        operation.completedAt = nowIso(clock);
        operation.error = error.message;
        operation.message = 'Güncelleme çalışan servislere dokunulmadan durduruldu: ' + error.message;
        atomicWriteJson(recordPath(operationsRoot, operationId), operation);
        atomicWriteJson(recordPath(currentRoot, plan.applicationId), operation);
        if (error instanceof ApplicationUpdateError) throw error;
        throw new ApplicationUpdateError(operation.message, 409, 'application-update-preparation-failed');
      }
      operation.error = error.message;
      operation.status = 'rolling-back';
      operation.message = 'Güncelleme tamamlanamadı; önceki sürüm geri yükleniyor.';
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      try {
        operation.services = await restoreOperation(plan, operation, { restoreVolumes: updatedRuntimeStarted });
        operation.status = 'rolled-back-after-failure';
        operation.rollbackAvailable = false;
        operation.completedAt = nowIso(clock);
        operation.rolledBackAt = operation.completedAt;
        operation.message = 'Güncelleme tamamlanamadı; önceki sürüm ve kalıcı veriler otomatik geri yüklendi.';
        atomicWriteJson(recordPath(operationsRoot, operationId), operation);
        atomicWriteJson(recordPath(currentRoot, plan.applicationId), operation);
        plan.status = 'rolled-back-after-failure';
        atomicWriteJson(recordPath(plansRoot, planId), plan);
        throw new ApplicationUpdateError(
          operation.message + ' Neden: ' + error.message,
          409,
          'application-update-rolled-back'
        );
      } catch (rollbackError) {
        if (rollbackError instanceof ApplicationUpdateError && rollbackError.code === 'application-update-rolled-back') throw rollbackError;
        operation.status = 'rollback-failed';
        operation.completedAt = nowIso(clock);
        operation.message = 'Güncelleme ve otomatik geri alma tamamlanamadı; elle müdahale gerekiyor.';
        operation.rollbackError = rollbackError.message;
        atomicWriteJson(recordPath(operationsRoot, operationId), operation);
        atomicWriteJson(recordPath(currentRoot, plan.applicationId), operation);
        throw new ApplicationUpdateError(
          operation.message,
          500,
          'application-update-rollback-failed'
        );
      }
    } finally {
      releaseLock(operationId);
      inFlight.delete(plan.applicationId);
    }
  }

  async function rollbackOperation(operationId, input = {}) {
    if (input.confirmation !== ROLLBACK_APPLICATION_UPDATE_CONFIRMATION) {
      throw new ApplicationUpdateError('Geri alma açık onay gerektiriyor.', 400, 'application-update-rollback-confirmation-required');
    }
    const stored = readJson(recordPath(operationsRoot, operationId));
    if (!stored) throw new ApplicationUpdateError('Güncelleme işlemi bulunamadı.', 404, 'application-update-operation-not-found');
    if (stored.status !== 'completed' || stored.rollbackAvailable !== true || stored.rolledBackAt) {
      throw new ApplicationUpdateError('Bu işlem geri alınamaz.', 409, 'application-update-rollback-unavailable');
    }
    const plan = getPlan(stored.planId);
    await assertRollbackRuntime(plan, stored);
    acquireLock(stored);
    inFlight.add(stored.applicationId);
    try {
      stored.status = 'rolling-back';
      stored.message = 'Önceki sürüm ve güncelleme öncesi kalıcı veriler geri yükleniyor.';
      atomicWriteJson(recordPath(operationsRoot, operationId), stored);
      stored.services = await restoreOperation(plan, stored);
      stored.status = 'rolled-back';
      stored.rollbackAvailable = false;
      stored.rolledBackAt = nowIso(clock);
      stored.completedAt = stored.rolledBackAt;
      stored.message = 'Önceki sürüm ve güncelleme öncesi kalıcı veriler geri yüklendi.';
      atomicWriteJson(recordPath(operationsRoot, operationId), stored);
      atomicWriteJson(recordPath(currentRoot, stored.applicationId), stored);
      return publicOperation(stored);
    } finally {
      releaseLock(operationId);
      inFlight.delete(stored.applicationId);
    }
  }

  return {
    applyPlan,
    createPlan,
    current,
    getOperation,
    getPlan: (planId) => publicPlan(getPlan(planId)),
    paths: { currentRoot, operationLockFile, operationsRoot, plansRoot, root },
    rollbackOperation
  };
}

module.exports = {
  APPLICATION_UPDATE_OPERATION_SCHEMA_VERSION,
  APPLY_APPLICATION_UPDATE_CONFIRMATION,
  ROLLBACK_APPLICATION_UPDATE_CONFIRMATION,
  createApplicationUpdateManager,
  createEncryptedVolumeSnapshotAdapter,
  mergeComposeServices,
  reverseDependentServices
};
