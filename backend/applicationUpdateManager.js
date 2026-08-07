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
  mountedPathForHostPath,
  parseComposeDocument,
  resolveComposeProject
} = require('./composeSource');
const { ApplicationUpdateError } = require('./applicationUpdateChecker');

const APPLICATION_UPDATE_OPERATION_SCHEMA_VERSION = 1;
const APPLY_APPLICATION_UPDATE_CONFIRMATION = 'UYGULAMA GÜNCELLEMESİNİ UYGULA';
const ROLLBACK_APPLICATION_UPDATE_CONFIRMATION = 'UYGULAMA GÜNCELLEMESİNİ GERİ AL';
const APPLICATION_ID_PATTERN = /^(?:app|res)_[a-f0-9]{24,64}$/;
const PLAN_ID_PATTERN = /^auplan_[a-f0-9]{32}$/;
const OPERATION_ID_PATTERN = /^auop_[a-f0-9]{32}$/;
const COMPOSE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
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

  async function create({ operationId, volume }) {
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

  return { create, restore, paths: { snapshotsRoot } };
}

function createApplicationUpdateManager({
  dataRoot,
  hostRoot,
  dockerRequest,
  getApplicationInventory,
  checkApplicationUpdate,
  composeRunner,
  volumeSnapshots,
  publicHealthProbe = async (url) => {
    if (!url) return { skipped: true };
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (response.status < 200 || response.status >= 400) throw new Error('Public endpoint returned HTTP ' + response.status);
    return { skipped: false, status: response.status };
  },
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
      throw new ApplicationUpdateError(
        'Bu uygulamanın doğrulanmış Compose kaynağı yok; otomatik güncelleme uygulanamaz.',
        409,
        'application-update-compose-required'
      );
    }
    if (
      project.files.some((file) => file.hostPath === '/opt/foxos' || file.hostPath.startsWith('/opt/foxos/')) ||
      project.workingDirectory === '/opt/foxos' || project.workingDirectory.startsWith('/opt/foxos/')
    ) {
      throw new ApplicationUpdateError('FoxOS kurulum dosyaları bu işlemden korunuyor.', 409, 'core-compose-path-protected');
    }
    return { application, details, labels, project };
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
        }))
      },
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

  async function verifyRuntime(plan) {
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
    await publicHealthProbe(plan.publicUrl);
    return verified;
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
    fs.writeFileSync(mountedPath, YAML.stringify({ services }), { flag: 'wx', mode: 0o600 });
    return { hostPath, mountedPath };
  }

  async function restoreOperation(plan, operation, { restoreVolumes = true } = {}) {
    await composeRunner({ operation: 'stop', project: plan.project, services: plan.services.map((service) => service.name) });
    if (restoreVolumes) {
      for (const volume of plan.volumes) {
        const snapshot = operation.volumeSnapshots.find((candidate) => candidate.volumeName === volume.name);
        if (!snapshot) throw new Error('Stateful rollback snapshot is missing for ' + volume.name);
        await volumeSnapshots.restore({ snapshot, volume });
      }
    }
    const override = writeRollbackOverride(plan, operation);
    try {
      await composeRunner({
        operation: 'rollback',
        project: plan.project,
        services: plan.services.map((service) => service.name),
        overrideFile: override.hostPath
      });
    } finally {
      try { fs.unlinkSync(override.mountedPath); } catch {}
    }
    return verifyRuntime(plan);
  }

  async function assertRollbackRuntime(plan, operation) {
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
        previousImageId: service.imageId,
        rollbackImage: service.rollbackImage || null
      }));
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);

      const buildServices = plan.services.filter((service) => service.action === 'build').map((service) => service.name);
      const pullServices = plan.services.filter((service) => service.action === 'pull').map((service) => service.name);
      if (buildServices.length) await composeRunner({ operation: 'build', project: plan.project, services: buildServices });
      if (pullServices.length) await composeRunner({ operation: 'pull', project: plan.project, services: pullServices });

      operation.status = 'backing-up';
      operation.message = 'Servisler durduruluyor ve kalıcı veriler şifreli yedekleniyor.';
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      await composeRunner({ operation: 'stop', project: plan.project, services: plan.services.map((service) => service.name) });
      servicesStopped = true;
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
      await composeRunner({ operation: 'up', project: plan.project, services: plan.services.map((service) => service.name) });
      operation.services = await verifyRuntime(plan);
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
