const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const MAX_COMPOSE_FILE_BYTES = 1024 * 1024;
const COMPOSE_FILE_ID_PATTERN = /^compose_[a-f0-9]{32}$/;
const APPLICATION_UPDATE_ROLLBACK_OVERRIDE_PATTERN = /(?:^|\/)\.server-update-[a-f0-9]{12}-rollback\.ya?ml$/i;

class ComposeSourceError extends Error {
  constructor(message, statusCode = 400, code = 'compose-source-error') {
    super(message);
    this.name = 'ComposeSourceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function composeFileId(hostPath) {
  return 'compose_' + crypto.createHash('sha256').update(hostPath).digest('hex').slice(0, 32);
}

function composeRevision(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

function parseComposeDocument(content, { requireServices = false } = {}) {
  let document;
  try {
    document = YAML.parseDocument(content, {
      maxAliasCount: 100,
      prettyErrors: false,
      uniqueKeys: true
    });
  } catch (error) {
    throw new ComposeSourceError('Compose YAML ayrıştırılamadı: ' + error.message, 400, 'compose-yaml-invalid');
  }
  if (document.errors.length) {
    throw new ComposeSourceError(
      'Compose YAML geçersiz: ' + document.errors[0].message,
      400,
      'compose-yaml-invalid'
    );
  }
  let value;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new ComposeSourceError('Compose YAML güvenle okunamadı: ' + error.message, 400, 'compose-yaml-invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ComposeSourceError('Compose dosyasının kökü bir nesne olmalıdır.', 400, 'compose-root-invalid');
  }
  if (requireServices && (!value.services || typeof value.services !== 'object' || Array.isArray(value.services))) {
    throw new ComposeSourceError('Compose dosyasında services bölümü bulunmalıdır.', 400, 'compose-services-missing');
  }
  return value;
}

function splitConfigFiles(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function isApplicationUpdateRollbackOverride(hostPath) {
  return APPLICATION_UPDATE_ROLLBACK_OVERRIDE_PATTERN.test(String(hostPath || '').replace(/\\/g, '/'));
}

function mountedPathForHostPath(hostRoot, hostPath) {
  const normalizedHostRoot = path.resolve(hostRoot);
  if (!path.isAbsolute(hostPath) || hostPath.includes('\0')) {
    throw new ComposeSourceError('Compose dosya yolu mutlak değil.', 409, 'compose-path-invalid');
  }
  const mountedPath = path.resolve(normalizedHostRoot, '.' + path.normalize(hostPath));
  if (mountedPath !== normalizedHostRoot && !mountedPath.startsWith(normalizedHostRoot + path.sep)) {
    throw new ComposeSourceError('Compose dosyası sunucu kökünün dışında.', 409, 'compose-path-outside-host');
  }
  return mountedPath;
}

function readComposeFile(hostRoot, hostPath) {
  if (!/\.ya?ml$/i.test(hostPath)) {
    throw new ComposeSourceError('Yalnız .yml veya .yaml Compose dosyaları düzenlenebilir.', 409, 'compose-extension-blocked');
  }
  const mountedPath = mountedPathForHostPath(hostRoot, hostPath);
  let stats;
  try {
    stats = fs.lstatSync(mountedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ComposeSourceError('Compose dosyası sunucuda bulunamadı.', 404, 'compose-file-not-found');
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ComposeSourceError('Compose kaynağı normal bir dosya değil.', 409, 'compose-file-type-blocked');
  }
  if (stats.size > MAX_COMPOSE_FILE_BYTES) {
    throw new ComposeSourceError('Compose dosyası güvenli düzenleme boyutunu aşıyor.', 413, 'compose-file-too-large');
  }
  const realHostRoot = fs.realpathSync(path.resolve(hostRoot));
  const realPath = fs.realpathSync(mountedPath);
  if (realPath !== realHostRoot && !realPath.startsWith(realHostRoot + path.sep)) {
    throw new ComposeSourceError('Compose dosyası sunucu kökünün dışında.', 409, 'compose-path-outside-host');
  }
  const content = fs.readFileSync(mountedPath, 'utf8');
  if (Buffer.byteLength(content) > MAX_COMPOSE_FILE_BYTES) {
    throw new ComposeSourceError('Compose dosyası güvenli düzenleme boyutunu aşıyor.', 413, 'compose-file-too-large');
  }
  return {
    content,
    fileId: composeFileId(hostPath),
    hostPath,
    mountedPath,
    name: path.basename(hostPath),
    revision: composeRevision(content),
    stats
  };
}

function resolveComposeProject(details, hostRoot) {
  const labels = details && details.Config && details.Config.Labels || {};
  const projectName = String(labels['com.docker.compose.project'] || '').trim();
  const serviceName = String(labels['com.docker.compose.service'] || '').trim();
  const workingDirectory = String(labels['com.docker.compose.project.working_dir'] || '').trim();
  const configPaths = splitConfigFiles(labels['com.docker.compose.project.config_files']);
  if (!projectName || !serviceName || !configPaths.length) return null;

  const absoluteConfigPaths = configPaths.map((configPath) => (
    path.isAbsolute(configPath)
      ? path.normalize(configPath)
      : path.resolve(workingDirectory || '/', configPath)
  ));
  const ignoredConfigPaths = absoluteConfigPaths.filter(isApplicationUpdateRollbackOverride);
  const sourceConfigPaths = absoluteConfigPaths.filter((hostPath) => !isApplicationUpdateRollbackOverride(hostPath));
  if (!sourceConfigPaths.length) return null;
  const files = sourceConfigPaths.map((hostPath) => readComposeFile(hostRoot, hostPath));
  let service = null;
  for (const file of files) {
    const parsed = parseComposeDocument(file.content);
    if (parsed.services && parsed.services[serviceName] && typeof parsed.services[serviceName] === 'object') {
      service = { ...(service || {}), ...parsed.services[serviceName] };
    }
  }

  return {
    files,
    hostRoot: path.resolve(hostRoot),
    ignoredConfigPaths,
    projectName,
    service,
    serviceName,
    workingDirectory: workingDirectory || path.dirname(absoluteConfigPaths[0])
  };
}

function finalDockerfileBaseReference(service, project) {
  if (!service || !service.build) return null;
  const build = service.build;
  let dockerfileContent = '';
  if (typeof build === 'object' && typeof build.dockerfile_inline === 'string') {
    dockerfileContent = build.dockerfile_inline;
  } else {
    const contextValue = typeof build === 'string' ? build : build.context || '.';
    const dockerfileValue = typeof build === 'object' && build.dockerfile ? build.dockerfile : 'Dockerfile';
    if (/^https?:\/\//i.test(contextValue) || path.isAbsolute(dockerfileValue)) return null;
    const contextPath = path.resolve(project.workingDirectory, contextValue);
    const hostPath = path.resolve(contextPath, dockerfileValue);
    try {
      dockerfileContent = readComposeFileLike(project, hostPath);
    } catch {
      return null;
    }
  }
  const externalStages = [];
  const stageNames = new Set();
  for (const line of dockerfileContent.split(/\r?\n/)) {
    const match = line.match(/^\s*FROM(?:\s+--platform=\S+)?\s+([^\s]+)(?:\s+AS\s+([^\s]+))?/i);
    if (!match) continue;
    const reference = match[1];
    if (!stageNames.has(reference.toLowerCase()) && reference.toLowerCase() !== 'scratch') {
      externalStages.push(reference);
    }
    if (match[2]) stageNames.add(match[2].toLowerCase());
  }
  return externalStages.length ? externalStages[externalStages.length - 1] : null;
}

function readComposeFileLike(project, hostPath) {
  if (!project.hostRoot) throw new Error('Compose project has no host root');
  const mountedPath = mountedPathForHostPath(project.hostRoot, hostPath);
  const stats = fs.lstatSync(mountedPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_COMPOSE_FILE_BYTES) {
    throw new Error('Dockerfile source is not readable');
  }
  return fs.readFileSync(mountedPath, 'utf8');
}

module.exports = {
  COMPOSE_FILE_ID_PATTERN,
  MAX_COMPOSE_FILE_BYTES,
  ComposeSourceError,
  composeFileId,
  composeRevision,
  finalDockerfileBaseReference,
  isApplicationUpdateRollbackOverride,
  mountedPathForHostPath,
  parseComposeDocument,
  readComposeFile,
  resolveComposeProject,
  splitConfigFiles
};
