const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');
const {
  COMPOSE_FILE_ID_PATTERN,
  MAX_COMPOSE_FILE_BYTES,
  ComposeSourceError,
  composeRevision,
  parseComposeDocument,
  resolveComposeProject
} = require('./composeSource');

const APPLICATION_COMPOSE_SCHEMA_VERSION = 1;
const SAVE_COMPOSE_CONFIRMATION = 'COMPOSE DOSYASINI KAYDET';
const APPLICATION_ID_PATTERN = /^(?:app|res)_[a-f0-9]{24,64}$/;

class ApplicationComposeError extends Error {
  constructor(message, statusCode = 400, code = 'application-compose-error') {
    super(message);
    this.name = 'ApplicationComposeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function createApplicationComposeManager({
  dataRoot,
  hostRoot,
  dockerRequest,
  encryptionStore,
  getApplicationInventory,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (
    !dataRoot || !hostRoot || typeof dockerRequest !== 'function' ||
    !encryptionStore || typeof getApplicationInventory !== 'function'
  ) {
    throw new Error('Application Compose manager requires data, host, Docker, encryption and inventory adapters');
  }

  const root = path.join(dataRoot, 'application-compose');
  const backupsRoot = path.join(root, 'backups');
  const operationsRoot = path.join(root, 'operations');
  const inFlight = new Set();

  function now() {
    return new Date(clock()).toISOString();
  }

  async function resolveApplication(applicationId) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) {
      throw new ApplicationComposeError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    const inventory = await getApplicationInventory();
    const application = (inventory.applications || []).find((candidate) => candidate.id === applicationId);
    if (!application || !application.runtime || !application.runtime.containerId) {
      throw new ApplicationComposeError('Uygulama artık sunucuda bulunamıyor.', 404, 'application-not-found');
    }
    const details = await dockerRequest('GET', '/containers/' + application.runtime.containerId + '/json');
    const labels = details && details.Config && details.Config.Labels || {};
    if (labels['com.foxos.core'] === 'true') {
      throw new ApplicationComposeError('FoxOS çekirdek Compose dosyası bu alandan düzenlenemez.', 409, 'core-compose-protected');
    }
    return { application, details, labels };
  }

  function publicFile(file) {
    return {
      content: file.content,
      fileId: file.fileId,
      name: file.name,
      path: file.hostPath,
      revision: file.revision,
      size: Buffer.byteLength(file.content)
    };
  }

  async function describe(applicationId) {
    const { application, details, labels } = await resolveApplication(applicationId);
    let project;
    try {
      project = resolveComposeProject(details, hostRoot);
    } catch (error) {
      if (error instanceof ComposeSourceError) {
        throw new ApplicationComposeError(error.message, error.statusCode, error.code);
      }
      throw error;
    }
    if (!project) {
      return {
        schemaVersion: APPLICATION_COMPOSE_SCHEMA_VERSION,
        applicationId,
        editable: false,
        reason: 'Bu uygulamanın Docker metadata’sında gerçek bir Compose kaynak dosyası bulunamadı.',
        files: []
      };
    }
    if (project.files.some((file) => file.hostPath === '/opt/foxos' || file.hostPath.startsWith('/opt/foxos/'))) {
      throw new ApplicationComposeError('FoxOS kurulum dosyaları uygulama editöründen değiştirilemez.', 409, 'core-compose-path-protected');
    }
    return {
      schemaVersion: APPLICATION_COMPOSE_SCHEMA_VERSION,
      applicationId,
      containerId: application.runtime.containerId,
      editable: true,
      files: project.files.map(publicFile),
      projectName: project.projectName,
      providerMayOverwrite: Object.keys(labels).some((key) => key.startsWith('coolify.')),
      serviceName: project.serviceName,
      workingDirectory: project.workingDirectory
    };
  }

  function writeComposeFileAtomic(file, content) {
    const parent = path.dirname(file.mountedPath);
    const temporary = path.join(parent, '.' + path.basename(file.mountedPath) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
    const mode = file.stats.mode & 0o777;
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporary, 'wx', mode);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.fchownSync(descriptor, file.stats.uid, file.stats.gid);
      fs.fchmodSync(descriptor, mode);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, file.mountedPath);
      const parentDescriptor = fs.openSync(parent, 'r');
      try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  async function save(applicationId, fileId, input = {}) {
    if (!COMPOSE_FILE_ID_PATTERN.test(String(fileId || ''))) {
      throw new ApplicationComposeError('Compose dosya kimliği geçersiz.', 400, 'invalid-compose-file-id');
    }
    if (input.confirmation !== SAVE_COMPOSE_CONFIRMATION) {
      throw new ApplicationComposeError('Compose kaydı açık onay gerektiriyor.', 400, 'compose-confirmation-required');
    }
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_COMPOSE_FILE_BYTES) {
      throw new ApplicationComposeError('Compose içeriği geçersiz veya çok büyük.', 413, 'compose-content-invalid');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(String(input.revision || ''))) {
      throw new ApplicationComposeError('Compose revision bilgisi geçersiz.', 400, 'compose-revision-invalid');
    }

    const lockKey = applicationId + ':' + fileId;
    if (inFlight.has(lockKey)) {
      throw new ApplicationComposeError('Bu Compose dosyasında başka bir kayıt sürüyor.', 409, 'compose-save-in-progress');
    }
    inFlight.add(lockKey);
    try {
      const { application, details, labels } = await resolveApplication(applicationId);
      let project;
      try {
        project = resolveComposeProject(details, hostRoot);
      } catch (error) {
        if (error instanceof ComposeSourceError) {
          throw new ApplicationComposeError(error.message, error.statusCode, error.code);
        }
        throw error;
      }
      if (!project) {
        throw new ApplicationComposeError('Uygulamanın Compose kaynağı artık bulunamıyor.', 409, 'compose-source-drift');
      }
      const file = project.files.find((candidate) => candidate.fileId === fileId);
      if (!file) {
        throw new ApplicationComposeError('Compose dosya kaynağı değişti; sayfayı yenileyin.', 409, 'compose-source-drift');
      }
      if (file.hostPath === '/opt/foxos' || file.hostPath.startsWith('/opt/foxos/')) {
        throw new ApplicationComposeError('FoxOS kurulum dosyaları uygulama editöründen değiştirilemez.', 409, 'core-compose-path-protected');
      }
      if (file.revision !== input.revision) {
        throw new ApplicationComposeError('Compose dosyası sunucuda değişti; son halini yeniden açın.', 409, 'compose-revision-drift');
      }

      let proposed;
      try {
        proposed = parseComposeDocument(input.content, { requireServices: true });
      } catch (error) {
        if (error instanceof ComposeSourceError) {
          throw new ApplicationComposeError(error.message, error.statusCode, error.code);
        }
        throw error;
      }
      const serviceStillExists = project.files.some((candidate) => {
        const parsed = candidate.fileId === fileId
          ? proposed
          : parseComposeDocument(candidate.content);
        return Boolean(parsed.services && parsed.services[project.serviceName]);
      });
      if (!serviceStillExists) {
        throw new ApplicationComposeError(
          `Seçili ${project.serviceName} servisi Compose projesinden kaldırılamaz.`,
          409,
          'compose-service-removed'
        );
      }
      if (file.content === input.content) {
        return {
          schemaVersion: APPLICATION_COMPOSE_SCHEMA_VERSION,
          applicationId,
          changed: false,
          file: publicFile(file),
          message: 'Compose dosyasında değişiklik yok; çalışan servis değiştirilmedi.'
        };
      }

      const operationId = 'composeop_' + randomUUID().replaceAll('-', '');
      const operationFile = path.join(operationsRoot, operationId + '.json');
      const backupContext = {
        purpose: 'application-compose-backup',
        applicationId,
        fileId,
        revision: file.revision
      };
      const backupFile = path.join(backupsRoot, applicationId, operationId + '.enc');
      const prepared = {
        schemaVersion: APPLICATION_COMPOSE_SCHEMA_VERSION,
        operationId,
        applicationId,
        containerId: application.runtime.containerId,
        fileId,
        path: file.hostPath,
        projectName: project.projectName,
        serviceName: project.serviceName,
        providerMayOverwrite: Object.keys(labels).some((key) => key.startsWith('coolify.')),
        previousRevision: file.revision,
        nextRevision: composeRevision(input.content),
        status: 'prepared',
        createdAt: now()
      };
      atomicWriteJson(operationFile, prepared);
      encryptionStore.atomicWriteBuffer(
        backupFile,
        encryptionStore.encryptBuffer(Buffer.from(file.content, 'utf8'), backupContext)
      );
      writeComposeFileAtomic(file, input.content);
      const completed = { ...prepared, status: 'completed', completedAt: now() };
      atomicWriteJson(operationFile, completed);
      const updatedFile = { ...file, content: input.content, revision: prepared.nextRevision };
      return {
        schemaVersion: APPLICATION_COMPOSE_SCHEMA_VERSION,
        applicationId,
        changed: true,
        file: publicFile(updatedFile),
        operation: completed,
        message: 'Compose dosyası kaydedildi ve önceki revision şifreli yedeklendi. Çalışan servis otomatik yeniden oluşturulmadı.'
      };
    } finally {
      inFlight.delete(lockKey);
    }
  }

  return {
    describe,
    paths: { backupsRoot, operationsRoot, root },
    save
  };
}

module.exports = {
  APPLICATION_COMPOSE_SCHEMA_VERSION,
  ApplicationComposeError,
  SAVE_COMPOSE_CONFIRMATION,
  createApplicationComposeManager
};
