const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const { AdoptionError, createAdoptionManager } = require('./adoptionManager');
const {
  ApplicationManifestError,
  createApplicationManifestManager
} = require('./applicationManifestManager');
const {
  IndependenceAuditError,
  createIndependenceAuditManager
} = require('./independenceAuditManager');
const {
  MigrationOrchestratorError,
  createMigrationOrchestrator
} = require('./migrationOrchestrator');
const {
  MigrationSelectionError,
  createMigrationSelectionManager
} = require('./migrationSelectionManager');
const {
  StatelessMigrationError,
  createStatelessMigrationManager
} = require('./statelessMigrationManager');
const {
  createStatelessMigrationManifestCompiler
} = require('./statelessMigrationManifestCompiler');
const { createBackupManager } = require('./backupManager');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createRouteManager } = require('./routeManager');
const { createSecretManager } = require('./secretManager');
const {
  WorkloadEvidenceError,
  createWorkloadEvidenceManager
} = require('./workloadEvidenceManager');
const {
  StatefulRehearsalError,
  createStatefulRehearsalManager
} = require('./statefulRehearsalManager');
const {
  StatefulShadowError,
  createStatefulShadowManager
} = require('./statefulShadowManager');
const {
  SourceDeploymentError,
  createSourceDeploymentManager
} = require('./sourceDeploymentManager');
const {
  ComposeDeploymentError,
  createComposeDeploymentManager
} = require('./composeDeploymentManager');
const {
  ImageUpdateError,
  createImageUpdateManager
} = require('./imageUpdateManager');
const { APP_CATALOG, getCatalogApp } = require('./appCatalog');
const { resolveAppIcon } = require('./appIcon');
const { SCHEMA_VERSION: RESOURCE_SCHEMA_VERSION, createResourceRegistry } = require('./resourceRegistry');
const {
  catalogContainerForApp,
  containerName,
  createContainerPayload,
  discoveredAppStates,
  imagePullPath,
  managedContainerForApp,
  stateForCatalogApp,
  validateInstallOptions
} = require('./appManager');

const app = express();

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', '.foxos-data'));
const DISK_ROOT = path.resolve(process.env.DISK_ROOT || path.join(DATA_ROOT, 'files'));
const HOST_ROOT = path.resolve(process.env.HOST_ROOT || path.parse(process.cwd()).root);
const HOST_EXECUTION = process.env.HOST_EXECUTION || 'local';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const AUTH_FILE = path.join(DATA_ROOT, 'auth.json');
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.COMMAND_TIMEOUT_MS || '120000', 10);
const COMMAND_MAX_BUFFER = 2 * 1024 * 1024;

const sessions = new Map();
const loginAttempts = new Map();
const appInstallOperations = new Set();
const containerPortCache = new Map();

if (process.env.FOXOS_TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function initializeDataDirectory() {
  ensureDirectory(DATA_ROOT);
  ensureDirectory(DISK_ROOT);
  ensureDirectory(path.join(DISK_ROOT, 'Masaüstü'));
  ensureDirectory(path.join(DISK_ROOT, 'İndirilenler'));
  ensureDirectory(path.join(DISK_ROOT, 'Belgeler'));
  ensureDirectory(path.join(DISK_ROOT, 'Resimler'));
  ensureDirectory(path.join(DISK_ROOT, 'Çöp Kutusu'));

  const serverLink = path.join(DISK_ROOT, 'Sunucu');
  if (!fs.existsSync(serverLink)) {
    try {
      fs.symlinkSync(HOST_ROOT, serverLink, 'dir');
    } catch (error) {
      console.warn('Could not create the host filesystem shortcut:', error.message);
    }
  }
}

initializeDataDirectory();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src http: https:; frame-ancestors 'none'"
  );
  next();
});

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const origin = req.get('origin');
  if (!origin) {
    return next();
  }

  try {
    if (new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
  } catch {
    return res.status(403).json({ error: 'Invalid request origin' });
  }

  next();
});

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, entry) => {
    const separator = entry.indexOf('=');
    if (separator === -1) {
      return cookies;
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
    return cookies;
  }, {});
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getSession(req) {
  pruneSessions();
  const token = parseCookies(req.headers.cookie).foxos_session;
  if (!token) {
    return null;
  }
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function setSessionCookie(res, token) {
  const secure = process.env.FOXOS_SECURE_COOKIE === 'true' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    'foxos_session=' + encodeURIComponent(token) +
      '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + secure
  );
}

function createSession(res, username) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(res, token);
}

function clearSession(req, res) {
  const session = getSession(req);
  if (session) {
    sessions.delete(session.token);
  }
  const secure = process.env.FOXOS_SECURE_COOKIE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'foxos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure);
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.session = session;
  next();
}

function readAuthRecord() {
  if (!fs.existsSync(AUTH_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (error) {
    console.error('Could not read authentication data:', error.message);
    return null;
  }
}

function writeAuthRecord(record) {
  const temporaryFile = AUTH_FILE + '.tmp';
  fs.writeFileSync(temporaryFile, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temporaryFile, AUTH_FILE);
  fs.chmodSync(AUTH_FILE, 0o600);
}

function derivePassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function passwordMatches(password, authRecord) {
  if (!authRecord || !authRecord.salt || !authRecord.passwordHash) {
    return false;
  }
  const actual = Buffer.from(derivePassword(password, authRecord.salt), 'hex');
  const expected = Buffer.from(authRecord.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function loginKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function checkLoginRateLimit(req) {
  const key = loginKey(req);
  const attempt = loginAttempts.get(key);
  if (!attempt) {
    return 0;
  }
  if (attempt.blockedUntil > Date.now()) {
    return Math.ceil((attempt.blockedUntil - Date.now()) / 1000);
  }
  if (attempt.blockedUntil) {
    loginAttempts.delete(key);
  }
  return 0;
}

function recordFailedLogin(req) {
  const key = loginKey(req);
  const current = loginAttempts.get(key) || { count: 0, blockedUntil: 0 };
  current.count += 1;
  if (current.count >= 5) {
    current.count = 0;
    current.blockedUntil = Date.now() + 5 * 60 * 1000;
  }
  loginAttempts.set(key, current);
}

function resolveWorkspacePath(userPath = '/') {
  if (typeof userPath !== 'string' || userPath.includes('\0')) {
    throw new Error('Invalid path');
  }
  const relativePath = userPath.replace(/^[/\\]+/, '');
  const candidate = path.resolve(DISK_ROOT, relativePath);
  if (candidate !== DISK_ROOT && !candidate.startsWith(DISK_ROOT + path.sep)) {
    throw new Error('Path escapes the FoxOS workspace');
  }
  return candidate;
}

function validateEntryName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error('Invalid file name');
  }
  return name.trim();
}

function movePath(source, target) {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
    fs.cpSync(source, target, { recursive: true, errorOnExist: true });
    fs.rmSync(source, { recursive: true, force: false });
  }
}

function isProtectedWorkspaceEntry(target) {
  return [
    path.join(DISK_ROOT, 'Masaüstü'),
    path.join(DISK_ROOT, 'İndirilenler'),
    path.join(DISK_ROOT, 'Belgeler'),
    path.join(DISK_ROOT, 'Resimler'),
    path.join(DISK_ROOT, 'Çöp Kutusu'),
    path.join(DISK_ROOT, 'Sunucu')
  ].includes(target);
}

function normalizeHostCwd(requestedCwd) {
  const cwd = typeof requestedCwd === 'string' && requestedCwd.trim() ? requestedCwd.trim() : '/';
  const absolute = path.posix.resolve('/', cwd.replace(/\\/g, '/'));
  const mountedPath = path.resolve(HOST_ROOT, '.' + absolute);
  if (mountedPath !== HOST_ROOT && !mountedPath.startsWith(HOST_ROOT + path.sep)) {
    throw new Error('Invalid working directory');
  }
  if (!fs.existsSync(mountedPath) || !fs.statSync(mountedPath).isDirectory()) {
    throw new Error('Working directory does not exist');
  }
  return absolute;
}

function hostCommandArgs(command, cwd) {
  if (HOST_EXECUTION === 'nsenter') {
    return {
      executable: 'nsenter',
      args: [
        '--target', '1',
        '--mount', '--uts', '--ipc', '--net', '--pid',
        '--',
        '/bin/sh', '-lc',
        'cd "$1" && exec /bin/sh -lc "$2"',
        'foxos',
        cwd,
        command
      ]
    };
  }

  return {
    executable: '/bin/sh',
    args: ['-lc', command]
  };
}

function runHostCommand(command, cwd = '/') {
  return new Promise((resolve) => {
    let normalizedCwd;
    try {
      normalizedCwd = normalizeHostCwd(cwd);
    } catch (error) {
      return resolve({ success: false, exitCode: 1, output: error.message + '\n', cwd });
    }

    const invocation = hostCommandArgs(command, normalizedCwd);
    const options = {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      windowsHide: true
    };
    if (HOST_EXECUTION !== 'nsenter') {
      options.cwd = path.resolve(HOST_ROOT, '.' + normalizedCwd);
    }

    execFile(invocation.executable, invocation.args, options, (error, stdout, stderr) => {
      let output = stdout || '';
      if (stderr) {
        output += stderr;
      }
      if (error && !output) {
        output = error.killed ? 'Command timed out.\n' : error.message + '\n';
      }
      resolve({
        success: !error,
        exitCode: error && Number.isInteger(error.code) ? error.code : error ? 1 : 0,
        output,
        cwd: normalizedCwd
      });
    });
  });
}

const dockerClient = createDockerClient(DOCKER_SOCKET);
const dockerRequest = dockerClient.request;

const resourceRegistry = createResourceRegistry({
  dataRoot: DATA_ROOT,
  dockerRequest
});
const routeManager = createRouteManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  publicBaseUrl: process.env.FOXOS_ROUTE_BASE_URL,
  networkName: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
  gatewayHost: process.env.FOXOS_ROUTE_GATEWAY_HOST || 'foxos-gateway'
});
const encryptionStore = createEncryptionStore({ dataRoot: DATA_ROOT });
const secretManager = createSecretManager({
  dataRoot: DATA_ROOT,
  encryptionStore
});
const backupManager = createBackupManager({
  dataRoot: DATA_ROOT,
  encryptionStore
});
const adoptionManager = createAdoptionManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerArchiveRequest: dockerClient.requestBuffer,
  resourceRegistry,
  routeManager,
  secretManager,
  backupManager
});
const sourceDeploymentManager = createSourceDeploymentManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerBuildRequest: dockerClient.requestBuild
});
const workloadEvidenceManager = createWorkloadEvidenceManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  resourceRegistry,
  encryptionStore,
  secretManager
});
const statefulRehearsalManager = createStatefulRehearsalManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerArchiveRequest: dockerClient.requestBuffer,
  resourceRegistry,
  encryptionStore,
  secretManager,
  routeManager
});
const statefulShadowManager = createStatefulShadowManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerArchiveRequest: dockerClient.requestBuffer,
  resourceRegistry,
  encryptionStore,
  secretManager,
  statefulRehearsalStatus: () => statefulRehearsalManager.status()
});
const composeDeploymentManager = createComposeDeploymentManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerBuildRequest: dockerClient.requestBuild
});
const imageUpdateManager = createImageUpdateManager({
  dataRoot: DATA_ROOT,
  dockerRequest
});
const applicationManifestManager = createApplicationManifestManager({
  dataRoot: DATA_ROOT,
  resourceRegistry,
  getEnvironmentRevision: (resourceId) => secretManager.getEnvironmentRevision(resourceId),
  routeStatus: () => routeManager.status(),
  backupStatus: () => backupManager.status(),
  sourceDeploymentStatus: () => sourceDeploymentManager.status(),
  composeDeploymentStatus: () => composeDeploymentManager.status(),
  imageUpdateStatus: () => imageUpdateManager.status(),
  workloadEvidenceStatus: () => workloadEvidenceManager.status(),
  statefulRehearsalStatus: () => statefulRehearsalManager.status(),
  statefulShadowStatus: () => statefulShadowManager.status()
});
const independenceAuditManager = createIndependenceAuditManager({
  dataRoot: DATA_ROOT,
  resourceRegistry,
  compileApplicationManifest: (resourceId) => applicationManifestManager.compile(resourceId)
});
const migrationOrchestrator = createMigrationOrchestrator({
  dataRoot: DATA_ROOT,
  resourceRegistry,
  compileApplicationManifest: (resourceId) => applicationManifestManager.compile(resourceId)
});
const migrationSelectionManager = createMigrationSelectionManager({
  dataRoot: DATA_ROOT,
  getServerMigrationPlan: (planId) => migrationOrchestrator.getPlan(planId),
  getLatestRegistrySnapshot: () => resourceRegistry.getLatest()
});
const statelessMigrationManifestCompiler = createStatelessMigrationManifestCompiler({
  resourceRegistry,
  compileApplicationManifest: (resourceId) => applicationManifestManager.compile(resourceId)
});
const statelessMigrationManager = createStatelessMigrationManager({
  dataRoot: DATA_ROOT,
  getServerMigrationPlan: (planId) => migrationOrchestrator.getPlan(planId),
  compileExecutionContract: (input) => statelessMigrationManifestCompiler.compile(input)
});

function sendAdoptionError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof AdoptionError) ? 'Adoption operation failed' : error.message,
    code: error.code || 'adoption-error'
  });
}

function sendSourceDeploymentError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof SourceDeploymentError)
      ? 'Source deployment operation failed'
      : error.message,
    code: error.code || 'source-deployment-error'
  });
}

function sendWorkloadEvidenceError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof WorkloadEvidenceError)
      ? 'Workload evidence operation failed'
      : error.message,
    code: error.code || 'workload-evidence-error'
  });
}

function sendStatefulRehearsalError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof StatefulRehearsalError)
      ? 'Stateful rehearsal operation failed'
      : error.message,
    code: error.code || 'stateful-rehearsal-error'
  });
}

function sendStatefulShadowError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof StatefulShadowError)
      ? 'Stateful shadow operation failed'
      : error.message,
    code: error.code || 'stateful-shadow-error'
  });
}

function sendComposeDeploymentError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof ComposeDeploymentError) ? 'Compose deployment operation failed' : error.message,
    code: error.code || 'compose-deployment-error'
  });
}

function sendImageUpdateError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof ImageUpdateError) ? 'Image-update operation failed' : error.message,
    code: error.code || 'image-update-error'
  });
}

function sendApplicationManifestError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof ApplicationManifestError)
      ? 'Application manifest operation failed'
      : error.message,
    code: error.code || 'application-manifest-error'
  });
}

function sendIndependenceAuditError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof IndependenceAuditError)
      ? 'Independence audit operation failed'
      : error.message,
    code: error.code || 'independence-audit-error'
  });
}

function sendMigrationOrchestratorError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof MigrationOrchestratorError)
      ? 'Server migration planning failed'
      : error.message,
    code: error.code || 'migration-orchestrator-error'
  });
}

function sendMigrationSelectionError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof MigrationSelectionError)
      ? 'Migration selection operation failed'
      : error.message,
    code: error.code || 'migration-selection-error'
  });
}

function sendStatelessMigrationError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof StatelessMigrationError)
      ? 'Stateless migration planning failed'
      : error.message,
    code: error.code || 'stateless-migration-error'
  });
}

function containerSettingsFromDetails(details) {
  const hostConfig = details.HostConfig || {};
  const restartPolicy = hostConfig.RestartPolicy || {};
  const portBindings = hostConfig.PortBindings || {};

  return {
    restartPolicy: restartPolicy.Name || 'no',
    ports: Object.entries(portBindings).flatMap(([privatePort, bindings]) => (
      (bindings || []).map((binding) => ({
        privatePort,
        hostIp: binding.HostIp || '0.0.0.0',
        hostPort: binding.HostPort || null
      }))
    )),
    mounts: (details.Mounts || []).map((mount) => ({
      type: mount.Type,
      name: mount.Name || null,
      source: mount.Source || null,
      destination: mount.Destination,
      readOnly: mount.RW === false
    })),
    created: details.Created || null
  };
}

function publishedPortsFromBindings(portBindings = {}) {
  return Object.entries(portBindings).flatMap(([privatePort, bindings]) => {
    const [privatePortNumber, type = 'tcp'] = privatePort.split('/');
    return (bindings || []).map((binding) => ({
      PrivatePort: Number(privatePortNumber),
      PublicPort: Number(binding.HostPort),
      Type: type,
      IP: binding.HostIp || '0.0.0.0'
    })).filter((port) => Number.isInteger(port.PrivatePort) && Number.isInteger(port.PublicPort));
  });
}

async function containersWithConfiguredPorts(containers) {
  const currentIds = new Set(containers.map((container) => container.Id));
  for (const cachedId of containerPortCache.keys()) {
    if (!currentIds.has(cachedId)) containerPortCache.delete(cachedId);
  }

  return Promise.all(containers.map(async (container) => {
    const publishedPorts = (container.Ports || []).filter((port) => port.PublicPort);
    if (publishedPorts.length) {
      containerPortCache.set(container.Id, publishedPorts);
      return container;
    }

    const cachedPorts = containerPortCache.get(container.Id);
    if (cachedPorts) return { ...container, Ports: cachedPorts };
    if (container.State === 'running') return container;

    try {
      const details = await dockerRequest('GET', '/containers/' + container.Id + '/json');
      const configuredPorts = publishedPortsFromBindings(
        details.HostConfig && details.HostConfig.PortBindings
      );
      if (!configuredPorts.length) return container;
      containerPortCache.set(container.Id, configuredPorts);
      return { ...container, Ports: configuredPorts };
    } catch {
      return container;
    }
  }));
}

async function hostPortIsListening(port) {
  const command =
    "if command -v ss >/dev/null 2>&1; then " +
    "if ss -H -ltn | awk '{print $4}' | grep -Eq '(^|:)" + port + "$'; then printf used; else printf free; fi; " +
    "elif command -v netstat >/dev/null 2>&1; then " +
    "if netstat -ltn 2>/dev/null | awk 'NR>2 {print $4}' | grep -Eq '(^|:)" + port + "$'; then printf used; else printf free; fi; " +
    "else printf unknown; fi";
  const result = await runHostCommand(command);
  return result.success && result.output.trim() === 'used';
}

async function getCatalogState() {
  const listedContainers = await dockerRequest('GET', '/containers/json?all=1');
  const containers = await containersWithConfiguredPorts(listedContainers);
  return [
    ...APP_CATALOG.map((catalogApp) => stateForCatalogApp(catalogApp, containers)),
    ...discoveredAppStates(containers, APP_CATALOG)
  ];
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/auth/status', (req, res) => {
  const authRecord = readAuthRecord();
  const session = getSession(req);
  res.json({
    isSetup: Boolean(authRecord),
    authenticated: Boolean(session),
    username: session ? session.username : authRecord ? authRecord.username : null
  });
});

app.post('/api/auth/setup', (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || password.length < 10) {
    return res.status(400).json({ error: 'Use a username and a password of at least 10 characters' });
  }
  if (readAuthRecord()) {
    return res.status(409).json({ error: 'FoxOS is already configured' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  writeAuthRecord({
    version: 2,
    username,
    salt,
    passwordHash: derivePassword(password, salt),
    createdAt: new Date().toISOString()
  });
  createSession(res, username);
  res.status(201).json({ success: true, username });
});

app.post('/api/auth/login', (req, res) => {
  const retryAfter = checkLoginRateLimit(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  const authRecord = readAuthRecord();
  if (!authRecord) {
    return res.status(400).json({ error: 'FoxOS has not been configured' });
  }

  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!passwordMatches(password, authRecord)) {
    recordFailedLogin(req);
    return res.status(401).json({ error: 'Invalid password' });
  }

  loginAttempts.delete(loginKey(req));
  createSession(res, authRecord.username);
  res.json({ success: true, username: authRecord.username });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  clearSession(req, res);
  res.status(204).end();
});

app.use('/api', requireAuth);

app.use('/api/static', express.static(DISK_ROOT, { dotfiles: 'deny', fallthrough: false }));

app.get('/api/files', (req, res) => {
  try {
    const requestedPath = req.query.path || '/';
    const targetDirectory = resolveWorkspacePath(requestedPath);
    if (!fs.existsSync(targetDirectory) || !fs.statSync(targetDirectory).isDirectory()) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const items = fs.readdirSync(targetDirectory, { withFileTypes: true }).map((item) => {
      const itemPath = path.join(targetDirectory, item.name);
      let stats = null;
      try {
        stats = fs.statSync(itemPath);
      } catch {
        // Broken or inaccessible entries remain visible with minimal metadata.
      }
      return {
        id: crypto.createHash('sha1').update(String(requestedPath) + '/' + item.name).digest('hex').slice(0, 16),
        name: item.name,
        type: stats ? (stats.isDirectory() ? 'folder' : 'file') : item.isDirectory() ? 'folder' : 'file',
        ext: stats && stats.isDirectory() ? null : path.extname(item.name).toLowerCase(),
        size: stats ? stats.size : 0,
        mtime: stats ? stats.mtime : null,
        symlink: item.isSymbolicLink()
      };
    });

    items.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      return a.type === 'folder' ? -1 : 1;
    });

    res.json({ path: requestedPath, items });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/save', (req, res) => {
  try {
    const targetFile = resolveWorkspacePath(req.body.filePath);
    if (fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()) {
      return res.status(400).json({ error: 'Target is a directory' });
    }
    fs.writeFileSync(targetFile, typeof req.body.content === 'string' ? req.body.content : '', 'utf8');
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/delete', (req, res) => {
  try {
    const target = resolveWorkspacePath(req.body.filePath);
    if (!fs.existsSync(target)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const trashRoot = path.join(DISK_ROOT, 'Çöp Kutusu');
    if (isProtectedWorkspaceEntry(target)) {
      return res.status(400).json({ error: 'This FoxOS system entry cannot be deleted' });
    }

    if (target.startsWith(trashRoot + path.sep)) {
      fs.rmSync(target, { recursive: true, force: false });
    } else {
      const destination = path.join(trashRoot, Date.now() + '_' + path.basename(target));
      movePath(target, destination);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/rename', (req, res) => {
  try {
    const target = resolveWorkspacePath(req.body.filePath);
    const name = validateEntryName(req.body.newName);
    if (!fs.existsSync(target)) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (isProtectedWorkspaceEntry(target)) {
      return res.status(400).json({ error: 'This FoxOS system entry cannot be renamed' });
    }
    const destination = path.join(path.dirname(target), name);
    if (fs.existsSync(destination)) {
      return res.status(409).json({ error: 'A file with that name already exists' });
    }
    fs.renameSync(target, destination);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/move', (req, res) => {
  try {
    const source = resolveWorkspacePath(req.body.sourcePath);
    const target = resolveWorkspacePath(req.body.targetPath);
    if (!fs.existsSync(source)) {
      return res.status(404).json({ error: 'Source file not found' });
    }
    if (isProtectedWorkspaceEntry(source)) {
      return res.status(400).json({ error: 'This FoxOS system entry cannot be moved' });
    }

    const destination = fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? path.join(target, path.basename(source))
      : target;
    if (fs.existsSync(destination)) {
      return res.status(409).json({ error: 'Destination already exists' });
    }
    movePath(source, destination);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/mkdir', (req, res) => {
  try {
    const parent = resolveWorkspacePath(req.body.path);
    const name = validateEntryName(req.body.name);
    const target = path.join(parent, name);
    if (fs.existsSync(target)) {
      return res.status(409).json({ error: 'Directory already exists' });
    }
    fs.mkdirSync(target);
    res.status(201).json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/terminal', async (req, res) => {
  const command = typeof req.body.command === 'string' ? req.body.command.trim() : '';
  if (!command) {
    return res.status(400).json({ error: 'No command provided' });
  }
  if (command.length > 32768) {
    return res.status(413).json({ error: 'Command is too long' });
  }

  const currentCwd = req.body.cwd || '/';
  if (/^cd(?:\s+|$)/.test(command)) {
    const requested = command.replace(/^cd\s*/, '').trim() || '/';
    const nextCwd = requested.startsWith('/')
      ? requested
      : path.posix.join(currentCwd || '/', requested);
    try {
      const normalized = normalizeHostCwd(nextCwd);
      return res.json({ success: true, exitCode: 0, cwd: normalized, output: '' });
    } catch (error) {
      return res.json({ success: false, exitCode: 1, cwd: currentCwd, output: 'cd: ' + error.message + '\n' });
    }
  }

  const result = await runHostCommand(command, currentCwd);
  res.json(result);
});

app.get('/api/system', async (req, res) => {
  const commands = [
    'hostname',
    'if [ -r /etc/os-release ]; then . /etc/os-release; if [ -n "$PRETTY_NAME" ]; then printf "%s" "$PRETTY_NAME"; else printf "%s" "$NAME"; fi; else uname -s; fi',
    'uname -srmo',
    "awk '{print int($1)}' /proc/uptime",
    "awk '/MemTotal:/ {total=$2*1024} /MemAvailable:/ {available=$2*1024} END {printf \"%.0f %.0f\", total, total-available}' /proc/meminfo",
    "df -Pk / | awk 'NR==2 {printf \"%.0f %.0f %.0f\", $2*1024, $3*1024, $4*1024}'",
    "awk '{print $1 \" \" $2 \" \" $3}' /proc/loadavg"
  ];

  const results = await Promise.all(commands.map((command) => runHostCommand(command)));
  if (results.some((result) => !result.success)) {
    return res.status(502).json({ error: 'Could not read host system information' });
  }

  const memory = results[4].output.trim().split(/\s+/).map(Number);
  const disk = results[5].output.trim().split(/\s+/).map(Number);
  const load = results[6].output.trim().split(/\s+/).map(Number);
  res.json({
    hostname: results[0].output.trim(),
    os: results[1].output.trim(),
    kernel: results[2].output.trim(),
    architecture: os.arch(),
    uptimeSeconds: Number(results[3].output.trim()) || 0,
    memory: { total: memory[0] || 0, used: memory[1] || 0 },
    disk: { total: disk[0] || 0, used: disk[1] || 0, available: disk[2] || 0 },
    loadAverage: load,
    executionMode: HOST_EXECUTION,
    dockerAvailable: fs.existsSync(DOCKER_SOCKET)
  });
});

app.get('/api/containers', async (req, res) => {
  try {
    const containers = await dockerRequest('GET', '/containers/json?all=1');
    res.json(
      containers.map((container) => ({
        id: container.Id,
        shortId: container.Id.slice(0, 12),
        name: (container.Names && container.Names[0] ? container.Names[0] : container.Id.slice(0, 12)).replace(/^\//, ''),
        image: container.Image,
        state: container.State,
        status: container.Status,
        ports: (container.Ports || []).map((port) => ({
          private: port.PrivatePort,
          public: port.PublicPort || null,
          type: port.Type,
          ip: port.IP || null
        })),
        protected: container.Labels && container.Labels['com.foxos.core'] === 'true'
      }))
    );
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.get('/api/resources', (req, res) => {
  try {
    const snapshot = resourceRegistry.getLatest();
    res.json({
      registry: {
        schemaVersion: RESOURCE_SCHEMA_VERSION,
        status: snapshot ? 'ready' : 'not-scanned'
      },
      snapshot
    });
  } catch (error) {
    console.error('Could not read the resource registry:', error.message);
    res.status(500).json({ error: 'Could not read the resource registry' });
  }
});

app.post('/api/resources/scan', async (req, res) => {
  try {
    const snapshot = await resourceRegistry.scan();
    res.status(201).json({ snapshot });
  } catch (error) {
    console.error('Could not scan server resources:', error.message);
    res.status(503).json({ error: 'Could not scan server resources' });
  }
});

app.get('/api/resources/export', (req, res) => {
  try {
    const migrationPlan = resourceRegistry.exportLatest();
    if (!migrationPlan) {
      return res.status(404).json({ error: 'Run a resource scan before exporting a migration plan' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="foxos-resource-plan-${migrationPlan.snapshotId}.json"`);
    res.send(JSON.stringify(migrationPlan, null, 2) + '\n');
  } catch (error) {
    console.error('Could not export the resource migration plan:', error.message);
    res.status(500).json({ error: 'Could not export the resource migration plan' });
  }
});

app.post('/api/resources/:resourceId/adoption-plan', async (req, res) => {
  try {
    const plan = await adoptionManager.createPlan(req.params.resourceId, req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not create adoption plan');
  }
});

app.get('/api/secrets', (req, res) => {
  try {
    res.json({ ...secretManager.status(), secrets: secretManager.listSecrets() });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not read encrypted secret metadata');
  }
});

app.post('/api/secrets', (req, res) => {
  try {
    const secret = secretManager.putSecret(req.body && req.body.name, req.body && req.body.value);
    res.status(201).json({ secret });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not store encrypted secret');
  }
});

app.get('/api/resources/:resourceId/environment-revision', (req, res) => {
  try {
    const environment = secretManager.getEnvironmentRevision(req.params.resourceId);
    if (!environment) return res.status(404).json({ error: 'Environment revision was not found' });
    res.json({ environment });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not read environment revision');
  }
});

app.post('/api/resources/:resourceId/environment-revisions', (req, res) => {
  try {
    const environment = secretManager.createEnvironmentRevision(req.params.resourceId, req.body || {});
    res.status(201).json({ environment });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not store environment revision');
  }
});

app.get('/api/workload-evidence', (req, res) => {
  try {
    res.json(workloadEvidenceManager.status());
  } catch (error) {
    sendWorkloadEvidenceError(res, error, 'Could not read workload evidence');
  }
});

app.post('/api/workload-evidence/source-plans', async (req, res) => {
  try {
    const plan = await workloadEvidenceManager.planSource(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendWorkloadEvidenceError(res, error, 'Could not plan workload source evidence');
  }
});

app.get('/api/workload-evidence/source-plans/:planId', (req, res) => {
  try {
    res.json({ plan: workloadEvidenceManager.getSourcePlan(req.params.planId) });
  } catch (error) {
    sendWorkloadEvidenceError(res, error, 'Could not read workload source plan');
  }
});

app.post('/api/workload-evidence/source-plans/:planId/capture', async (req, res) => {
  try {
    const revision = await workloadEvidenceManager.captureSource(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ revision });
  } catch (error) {
    sendWorkloadEvidenceError(res, error, 'Could not capture workload source evidence');
  }
});

app.post('/api/workload-evidence/environment-plans', async (req, res) => {
  try {
    const plan = await workloadEvidenceManager.planEnvironment(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendWorkloadEvidenceError(res, error, 'Could not plan workload environment evidence');
  }
});

app.get('/api/workload-evidence/environment-plans/:planId', (req, res) => {
  try {
    res.json({ plan: workloadEvidenceManager.getEnvironmentPlan(req.params.planId) });
  } catch (error) {
    sendWorkloadEvidenceError(res, error, 'Could not read workload environment plan');
  }
});

app.post('/api/workload-evidence/environment-plans/:planId/capture', async (req, res) => {
  try {
    const capture = await workloadEvidenceManager.captureEnvironment(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ capture });
  } catch (error) {
    sendWorkloadEvidenceError(res, error, 'Could not capture workload environment evidence');
  }
});

app.get('/api/stateful-rehearsals', (req, res) => {
  try {
    res.json(statefulRehearsalManager.status());
  } catch (error) {
    sendStatefulRehearsalError(res, error, 'Could not read stateful rehearsals');
  }
});

app.post('/api/stateful-rehearsals/plans', async (req, res) => {
  try {
    const plan = await statefulRehearsalManager.createPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendStatefulRehearsalError(res, error, 'Could not plan stateful rehearsal');
  }
});

app.post('/api/stateful-rehearsals/cutover-plans', async (req, res) => {
  try {
    const plan = await statefulRehearsalManager.createCutoverPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendStatefulRehearsalError(res, error, 'Could not plan stateful cutover rehearsal');
  }
});

app.get('/api/stateful-rehearsals/plans/:planId', (req, res) => {
  try {
    res.json({ plan: statefulRehearsalManager.getPlan(req.params.planId) });
  } catch (error) {
    sendStatefulRehearsalError(res, error, 'Could not read stateful rehearsal plan');
  }
});

app.post('/api/stateful-rehearsals/plans/:planId/run', async (req, res) => {
  try {
    const operation = await statefulRehearsalManager.runPlan(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ operation });
  } catch (error) {
    sendStatefulRehearsalError(res, error, 'Could not run stateful rehearsal');
  }
});

app.post('/api/stateful-rehearsals/cutover-plans/:planId/run', async (req, res) => {
  try {
    const operation = await statefulRehearsalManager.runPlan(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ operation });
  } catch (error) {
    sendStatefulRehearsalError(res, error, 'Could not run stateful cutover rehearsal');
  }
});

app.get('/api/stateful-rehearsals/operations/:operationId', (req, res) => {
  try {
    res.json({ operation: statefulRehearsalManager.getOperation(req.params.operationId) });
  } catch (error) {
    sendStatefulRehearsalError(res, error, 'Could not read stateful rehearsal operation');
  }
});

app.get('/api/stateful-shadows', (req, res) => {
  try {
    res.json(statefulShadowManager.status());
  } catch (error) {
    sendStatefulShadowError(res, error, 'Could not read stateful shadows');
  }
});

app.post('/api/stateful-shadows/plans', async (req, res) => {
  try {
    const plan = await statefulShadowManager.createPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendStatefulShadowError(res, error, 'Could not plan stateful shadow');
  }
});

app.post('/api/stateful-shadows/refresh-plans', async (req, res) => {
  try {
    const plan = await statefulShadowManager.createRefreshPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendStatefulShadowError(res, error, 'Could not plan stateful shadow refresh');
  }
});

app.get('/api/stateful-shadows/plans/:planId', (req, res) => {
  try {
    res.json({ plan: statefulShadowManager.getPlan(req.params.planId) });
  } catch (error) {
    sendStatefulShadowError(res, error, 'Could not read stateful shadow plan');
  }
});

app.post('/api/stateful-shadows/plans/:planId/run', async (req, res) => {
  try {
    const operation = await statefulShadowManager.runPlan(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ operation });
  } catch (error) {
    sendStatefulShadowError(res, error, 'Could not run stateful shadow');
  }
});

app.post('/api/stateful-shadows/refresh-plans/:planId/run', async (req, res) => {
  try {
    const operation = await statefulShadowManager.runRefreshPlan(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ operation });
  } catch (error) {
    sendStatefulShadowError(res, error, 'Could not run stateful shadow refresh');
  }
});

app.get('/api/stateful-shadows/operations/:operationId', (req, res) => {
  try {
    res.json({ operation: statefulShadowManager.getOperation(req.params.operationId) });
  } catch (error) {
    sendStatefulShadowError(res, error, 'Could not read stateful shadow operation');
  }
});

app.get('/api/recovery/status', (req, res) => {
  try {
    res.json({ encryption: encryptionStore.status(), backup: backupManager.status() });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not read recovery status');
  }
});

app.get('/api/deployments', (req, res) => {
  try {
    res.json(sourceDeploymentManager.status());
  } catch (error) {
    sendSourceDeploymentError(res, error, 'Could not read source deployment state');
  }
});

app.post('/api/deployments/plans', async (req, res) => {
  try {
    const plan = await sourceDeploymentManager.createPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendSourceDeploymentError(res, error, 'Could not create source deployment plan');
  }
});

app.get('/api/deployments/plans/:planId', (req, res) => {
  try {
    res.json({ plan: sourceDeploymentManager.getPlan(req.params.planId) });
  } catch (error) {
    sendSourceDeploymentError(res, error, 'Could not read source deployment plan');
  }
});

app.post('/api/deployments/plans/:planId/apply', async (req, res) => {
  try {
    const operation = await sourceDeploymentManager.applyPlan(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ operation });
  } catch (error) {
    sendSourceDeploymentError(res, error, 'Could not apply source deployment plan');
  }
});

app.post('/api/deployments/:operationId/rollback', async (req, res) => {
  try {
    const operation = await sourceDeploymentManager.rollbackOperation(
      req.params.operationId,
      req.body && req.body.confirmation
    );
    res.json({ operation });
  } catch (error) {
    sendSourceDeploymentError(res, error, 'Could not roll back source deployment');
  }
});

app.get('/api/compose-deployments', (req, res) => {
  try {
    res.json(composeDeploymentManager.status());
  } catch (error) {
    sendComposeDeploymentError(res, error, 'Could not read Compose deployment state');
  }
});

app.post('/api/compose-deployments/plans', async (req, res) => {
  try {
    const plan = await composeDeploymentManager.createPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendComposeDeploymentError(res, error, 'Could not create Compose deployment plan');
  }
});

app.get('/api/compose-deployments/plans/:planId', (req, res) => {
  try {
    res.json({ plan: composeDeploymentManager.getPlan(req.params.planId) });
  } catch (error) {
    sendComposeDeploymentError(res, error, 'Could not read Compose deployment plan');
  }
});

app.post('/api/compose-deployments/plans/:planId/enqueue', (req, res) => {
  try {
    const job = composeDeploymentManager.enqueuePlan(req.params.planId, req.body && req.body.confirmation);
    res.status(202).json({ job });
  } catch (error) {
    sendComposeDeploymentError(res, error, 'Could not queue Compose deployment');
  }
});

app.get('/api/compose-deployments/jobs/:jobId', (req, res) => {
  try {
    res.json({ job: composeDeploymentManager.getJob(req.params.jobId) });
  } catch (error) {
    sendComposeDeploymentError(res, error, 'Could not read Compose deployment job');
  }
});

app.post('/api/compose-deployments/jobs/:jobId/cancel', (req, res) => {
  try {
    const job = composeDeploymentManager.cancelJob(req.params.jobId, req.body && req.body.confirmation);
    res.json({ job });
  } catch (error) {
    sendComposeDeploymentError(res, error, 'Could not cancel Compose deployment job');
  }
});

app.post('/api/compose-deployments/:operationId/rollback', async (req, res) => {
  try {
    const operation = await composeDeploymentManager.rollbackOperation(
      req.params.operationId,
      req.body && req.body.confirmation
    );
    res.json({ operation });
  } catch (error) {
    sendComposeDeploymentError(res, error, 'Could not roll back Compose deployment');
  }
});

app.get('/api/image-updates', (req, res) => {
  try {
    res.json(imageUpdateManager.status());
  } catch (error) {
    sendImageUpdateError(res, error, 'Could not read image-update state');
  }
});

app.post('/api/image-updates/plans', async (req, res) => {
  try {
    const plan = await imageUpdateManager.createPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendImageUpdateError(res, error, 'Could not create image-update plan');
  }
});

app.get('/api/image-updates/plans/:planId', (req, res) => {
  try {
    res.json({ plan: imageUpdateManager.getPlan(req.params.planId) });
  } catch (error) {
    sendImageUpdateError(res, error, 'Could not read image-update plan');
  }
});

app.post('/api/image-updates/plans/:planId/apply', async (req, res) => {
  try {
    const operation = await imageUpdateManager.applyPlan(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ operation });
  } catch (error) {
    sendImageUpdateError(res, error, 'Could not apply image update');
  }
});

app.post('/api/image-updates/:operationId/rollback', async (req, res) => {
  try {
    const operation = await imageUpdateManager.rollbackOperation(
      req.params.operationId,
      req.body && req.body.confirmation
    );
    res.json({ operation });
  } catch (error) {
    sendImageUpdateError(res, error, 'Could not roll back image update');
  }
});

app.get('/api/application-manifests', (req, res) => {
  try {
    res.json(applicationManifestManager.status());
  } catch (error) {
    sendApplicationManifestError(res, error, 'Could not read application manifests');
  }
});

app.post('/api/application-manifests/drafts', (req, res) => {
  try {
    const draft = applicationManifestManager.createDraft(req.body || {});
    res.status(201).json({ draft });
  } catch (error) {
    sendApplicationManifestError(res, error, 'Could not create application manifest draft');
  }
});

app.get('/api/application-manifests/drafts/:draftId', (req, res) => {
  try {
    res.json({ draft: applicationManifestManager.getDraft(req.params.draftId) });
  } catch (error) {
    sendApplicationManifestError(res, error, 'Could not read application manifest draft');
  }
});

app.post('/api/application-manifests/drafts/:draftId/finalize', (req, res) => {
  try {
    const manifest = applicationManifestManager.finalizeDraft(
      req.params.draftId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ manifest });
  } catch (error) {
    sendApplicationManifestError(res, error, 'Could not finalize application manifest');
  }
});

app.get('/api/application-manifests/resources/:resourceId/current', (req, res) => {
  try {
    const manifest = applicationManifestManager.getCurrent(req.params.resourceId);
    if (!manifest) return res.status(404).json({ error: 'Application manifest was not found' });
    res.json({ manifest });
  } catch (error) {
    sendApplicationManifestError(res, error, 'Could not read current application manifest');
  }
});

app.get('/api/independence-audits', (req, res) => {
  try {
    res.json(independenceAuditManager.status());
  } catch (error) {
    sendIndependenceAuditError(res, error, 'Could not read independence audits');
  }
});

app.post('/api/independence-audits', (req, res) => {
  try {
    const audit = independenceAuditManager.createAudit(req.body || {});
    res.status(201).json({ audit });
  } catch (error) {
    sendIndependenceAuditError(res, error, 'Could not create independence audit');
  }
});

app.get('/api/independence-audits/:auditId', (req, res) => {
  try {
    res.json({ audit: independenceAuditManager.getAudit(req.params.auditId) });
  } catch (error) {
    sendIndependenceAuditError(res, error, 'Could not read independence audit');
  }
});

app.get('/api/migration-orchestrator', (req, res) => {
  try {
    res.json(migrationOrchestrator.status());
  } catch (error) {
    sendMigrationOrchestratorError(res, error, 'Could not read server migration plans');
  }
});

app.post('/api/migration-orchestrator/plans', (req, res) => {
  try {
    const plan = migrationOrchestrator.createPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendMigrationOrchestratorError(res, error, 'Could not create server migration plan');
  }
});

app.get('/api/migration-orchestrator/plans/:planId', (req, res) => {
  try {
    res.json({ plan: migrationOrchestrator.getPlan(req.params.planId) });
  } catch (error) {
    sendMigrationOrchestratorError(res, error, 'Could not read server migration plan');
  }
});

app.get('/api/migration-selections/current', (req, res) => {
  try {
    res.json(migrationSelectionManager.status());
  } catch (error) {
    sendMigrationSelectionError(res, error, 'Could not read the current migration selection');
  }
});

app.put('/api/migration-selections/current', (req, res) => {
  try {
    const selection = migrationSelectionManager.save(req.body || {});
    res.json({ selection, status: migrationSelectionManager.status() });
  } catch (error) {
    sendMigrationSelectionError(res, error, 'Could not save the migration selection');
  }
});

app.get('/api/stateless-migrations', (req, res) => {
  try {
    res.json(statelessMigrationManager.status());
  } catch (error) {
    sendStatelessMigrationError(res, error, 'Could not read stateless migration reviews');
  }
});

app.post('/api/stateless-migrations/plans', (req, res) => {
  try {
    const plan = statelessMigrationManager.createPlan(req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendStatelessMigrationError(res, error, 'Could not create stateless migration review');
  }
});

app.get('/api/stateless-migrations/plans/:planId', (req, res) => {
  try {
    res.json({ plan: statelessMigrationManager.getPlan(req.params.planId) });
  } catch (error) {
    sendStatelessMigrationError(res, error, 'Could not read stateless migration review');
  }
});

app.get('/api/adoptions', (req, res) => {
  try {
    res.json(adoptionManager.status());
  } catch (error) {
    sendAdoptionError(res, error, 'Could not read adoption state');
  }
});

app.get('/api/routes', (req, res) => {
  try {
    res.json(routeManager.status());
  } catch (error) {
    sendAdoptionError(res, error, 'Could not read FoxOS routes');
  }
});

app.get('/api/adoptions/plans/:planId', (req, res) => {
  try {
    res.json({ plan: adoptionManager.getPlan(req.params.planId) });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not read adoption plan');
  }
});

app.post('/api/adoptions/plans/:planId/apply', async (req, res) => {
  try {
    const operation = await adoptionManager.applyPlan(req.params.planId, req.body && req.body.confirmation);
    res.status(201).json({ operation });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not apply adoption plan');
  }
});

app.post('/api/adoptions/:operationId/rollback', async (req, res) => {
  try {
    const operation = await adoptionManager.rollbackOperation(
      req.params.operationId,
      req.body && req.body.confirmation
    );
    res.json({ operation });
  } catch (error) {
    sendAdoptionError(res, error, 'Could not roll back adoption operation');
  }
});

app.get('/api/apps', async (req, res) => {
  try {
    res.json({ apps: await getCatalogState() });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.get('/api/apps/:appId/icon', async (req, res) => {
  try {
    const appState = (await getCatalogState()).find((candidate) => candidate.id === req.params.appId);
    if (!appState || !appState.installed || !appState.externalUrl) {
      return res.status(404).json({ error: 'Application icon source is not available' });
    }

    const icon = await resolveAppIcon(appState);
    if (!icon) {
      return res.status(404).json({ error: 'Application icon was not found' });
    }

    res.setHeader('Content-Type', icon.contentType);
    res.setHeader('Content-Length', icon.buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(icon.buffer);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/apps/:appId/install', async (req, res) => {
  const catalogApp = getCatalogApp(req.params.appId);
  if (!catalogApp) {
    return res.status(404).json({ error: 'Application not found in the FoxOS catalog' });
  }
  if (appInstallOperations.has(catalogApp.id)) {
    return res.status(409).json({ error: 'An install operation is already running for this application' });
  }

  let options;
  try {
    options = validateInstallOptions(catalogApp, req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  appInstallOperations.add(catalogApp.id);
  let createdContainerId = null;
  try {
    const containers = await dockerRequest('GET', '/containers/json?all=1');
    if (catalogContainerForApp(containers, catalogApp)) {
      return res.status(409).json({ error: 'This application is already installed' });
    }
    if (await hostPortIsListening(options.hostPort)) {
      return res.status(409).json({ error: 'Port ' + options.hostPort + ' is already in use on the server' });
    }

    await dockerRequest('POST', imagePullPath(catalogApp.image));
    const created = await dockerRequest(
      'POST',
      '/containers/create?name=' + encodeURIComponent(containerName(catalogApp.id)),
      createContainerPayload(catalogApp, options)
    );
    createdContainerId = created.Id;
    await dockerRequest('POST', '/containers/' + createdContainerId + '/start');

    const state = (await getCatalogState()).find((appState) => appState.id === catalogApp.id);
    res.status(201).json({ success: true, app: state });
  } catch (error) {
    if (createdContainerId) {
      try {
        await dockerRequest('DELETE', '/containers/' + createdContainerId + '?force=1&v=0');
      } catch (cleanupError) {
        console.error('Could not clean up failed app installation:', cleanupError.message);
      }
    }
    res.status(502).json({ error: error.message });
  } finally {
    appInstallOperations.delete(catalogApp.id);
  }
});

app.post('/api/apps/:appId/:action', async (req, res) => {
  const catalogApp = getCatalogApp(req.params.appId);
  const allowedActions = new Set(['start', 'stop', 'restart']);
  if (!catalogApp || !allowedActions.has(req.params.action)) {
    return res.status(400).json({ error: 'Invalid application action' });
  }
  if (appInstallOperations.has(catalogApp.id)) {
    return res.status(409).json({ error: 'Wait for the current install operation to finish' });
  }

  try {
    const containers = await dockerRequest('GET', '/containers/json?all=1');
    const container = managedContainerForApp(containers, catalogApp.id);
    if (!container) {
      return res.status(404).json({ error: 'Application is not installed' });
    }
    await dockerRequest('POST', '/containers/' + container.Id + '/' + req.params.action + '?t=10');
    const state = (await getCatalogState()).find((appState) => appState.id === catalogApp.id);
    res.json({ success: true, app: state });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.delete('/api/apps/:appId', async (req, res) => {
  const catalogApp = getCatalogApp(req.params.appId);
  if (!catalogApp) {
    return res.status(404).json({ error: 'Application not found in the FoxOS catalog' });
  }
  if (appInstallOperations.has(catalogApp.id)) {
    return res.status(409).json({ error: 'Wait for the current install operation to finish' });
  }

  try {
    const containers = await dockerRequest('GET', '/containers/json?all=1');
    const container = managedContainerForApp(containers, catalogApp.id);
    if (!container) {
      return res.status(404).json({ error: 'Application is not installed' });
    }

    await dockerRequest('DELETE', '/containers/' + container.Id + '?force=1&v=0');
    if (req.query.removeData === 'true') {
      for (const volume of catalogApp.volumes || []) {
        await dockerRequest('DELETE', '/volumes/' + encodeURIComponent(volume.name));
      }
    }
    res.json({ success: true, dataRemoved: req.query.removeData === 'true' });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/containers/:id/settings', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{12,64}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid container ID' });
  }

  try {
    const details = await dockerRequest('GET', '/containers/' + id + '/json');
    res.json({ settings: containerSettingsFromDetails(details) });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.patch('/api/containers/:id/settings', async (req, res) => {
  const { id } = req.params;
  const restartPolicy = req.body && req.body.restartPolicy;
  const allowedRestartPolicies = new Set(['no', 'unless-stopped', 'always']);
  if (!/^[a-f0-9]{12,64}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid container ID' });
  }
  if (!allowedRestartPolicies.has(restartPolicy)) {
    return res.status(400).json({ error: 'Invalid restart policy' });
  }

  try {
    const details = await dockerRequest('GET', '/containers/' + id + '/json');
    if (details.Config && details.Config.Labels && details.Config.Labels['com.foxos.core'] === 'true') {
      return res.status(409).json({ error: 'FoxOS cannot change its own core settings' });
    }

    await dockerRequest('POST', '/containers/' + id + '/update', {
      RestartPolicy: { Name: restartPolicy, MaximumRetryCount: 0 }
    });
    const updatedDetails = await dockerRequest('GET', '/containers/' + id + '/json');
    res.json({ success: true, settings: containerSettingsFromDetails(updatedDetails) });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/containers/:id/:action', async (req, res) => {
  const allowedActions = new Set(['start', 'stop', 'restart']);
  const { id, action } = req.params;
  if (!/^[a-f0-9]{12,64}$/.test(id) || !allowedActions.has(action)) {
    return res.status(400).json({ error: 'Invalid container action' });
  }

  try {
    const details = await dockerRequest('GET', '/containers/' + id + '/json');
    if (details.Config && details.Config.Labels && details.Config.Labels['com.foxos.core'] === 'true') {
      return res.status(409).json({ error: 'FoxOS cannot manage its own core container' });
    }
    await dockerRequest('POST', '/containers/' + id + '/' + action + '?t=10');
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ error: status === 404 ? 'Not found' : status < 500 ? error.message : 'Internal server error' });
});

if (require.main === module) {
  statefulRehearsalManager.recoverInterruptedOperations({ clearStaleLock: true })
    .then((recovery) => {
      if (recovery.recovered.length) {
        console.warn('Recovered interrupted stateful rehearsals:', recovery.recovered.length);
      }
    })
    .catch((error) => {
      console.error('Initial stateful rehearsal recovery failed:', error.message);
    })
    .then(() => statefulShadowManager.recoverInterruptedOperations({ clearStaleLock: true }))
    .then((recovery) => {
      if (recovery.recovered.length) {
        console.warn('Recovered interrupted stateful shadows:', recovery.recovered.length);
      }
    })
    .catch((error) => {
      console.error('Initial stateful shadow recovery failed:', error.message);
    })
    .finally(() => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log('FoxOS is listening on port ' + PORT);
        console.log('Host execution mode: ' + HOST_EXECUTION);
        console.log('Host filesystem mount: ' + HOST_ROOT);

        if (process.env.FOXOS_RESOURCE_SCAN_ON_STARTUP === 'false') return;
        resourceRegistry.scan()
          .then((snapshot) => {
            console.log(
              'Resource Registry snapshot ' + snapshot.snapshotId +
              ' recorded ' + snapshot.summary.resources + ' resources using Docker GET requests only'
            );
          })
          .catch((error) => {
            console.error('Initial Resource Registry scan failed:', error.message);
          });
      });
    });
}

module.exports = app;
