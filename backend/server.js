const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
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
  PLAN_SERVER_MIGRATION_CONFIRMATION,
  createMigrationOrchestrator
} = require('./migrationOrchestrator');
const {
  MigrationSelectionError,
  createMigrationSelectionManager
} = require('./migrationSelectionManager');
const {
  MigrationRunError,
  createMigrationRunManager
} = require('./migrationRunManager');
const {
  MaintenanceSessionError,
  createMaintenanceSessionManager
} = require('./maintenanceSessionManager');
const {
  StatelessMigrationError,
  createStatelessMigrationManager
} = require('./statelessMigrationManager');
const {
  createStatelessMigrationManifestCompiler
} = require('./statelessMigrationManifestCompiler');
const {
  StatefulMigrationError,
  PREPARE_STATEFUL_MIGRATION_CONFIRMATION,
  createStatefulMigrationManager
} = require('./statefulMigrationManager');
const {
  createStatefulMigrationManifestCompiler
} = require('./statefulMigrationManifestCompiler');
const {
  SAVE_STATELESS_MIGRATION_REVIEW_CONFIRMATION,
  StatelessMigrationReviewError,
  createStatelessMigrationReviewManager
} = require('./statelessMigrationReviewManager');
const { createIngressAuthorityManager } = require('./ingressAuthorityManager');
const { createProductionStatelessMigrationAdapter } = require('./productionStatelessMigrationAdapter');
const {
  MAX_DIRECT_STATEFUL_TRANSACTION_BYTES,
  createProductionStatefulMigrationAdapter
} = require('./productionStatefulMigrationAdapter');
const {
  PREPARE_RUNTIME_TRANSFER_CONFIRMATION,
  RuntimeTransferError,
  createRuntimeTransferManager
} = require('./runtimeTransferManager');
const { createTraefikCertificateImporter } = require('./traefikCertificateImporter');
const { createInactiveDefinitionIngressReconciler } = require('./inactiveDefinitionIngressReconciler');
const {
  InactiveDefinitionRuntimeError,
  createInactiveDefinitionRuntimeManager
} = require('./inactiveDefinitionRuntimeManager');
const { createUiApprovalManager } = require('./uiApprovalManager');
const { createBackupManager } = require('./backupManager');
const {
  CloudflareConnectionError,
  createCloudflareConnectionManager
} = require('./cloudflareConnectionManager');
const {
  CodexConnectionError,
  createCodexConnectionManager
} = require('./codexConnectionManager');
const {
  GeminiConnectionError,
  createGeminiConnectionManager
} = require('./geminiConnectionManager');
const {
  AntigravityConnectionError,
  createAntigravityConnectionManager
} = require('./antigravityConnectionManager');
const {
  createAntigravityLoginController,
  finalJsonPayload
} = require('./antigravityLoginController');
const {
  codexDaemonEnsureScript,
  codexDaemonSocket,
  createCodexDaemonTransport
} = require('./codexHostRuntime');
const {
  createCliUsageManager,
  normalizeAntigravityUsage,
  normalizeCodexRateLimits
} = require('./cliUsageManager');
const { createCoolifyMigrationReader } = require('./coolifyMigrationReader');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createHostServiceDiscovery } = require('./hostServiceDiscovery');
const { HostServiceError, createHostServiceManager } = require('./hostServiceManager');
const { createRouteManager } = require('./routeManager');
const { createSecretManager } = require('./secretManager');
const { createSessionStore } = require('./sessionStore');
const {
  createLocalePreferencesRecord,
  publicLocalePreferences,
  validateLocalePreferences
} = require('./localePreferences');
const {
  PASSWORD_MIN_LENGTH,
  createPasswordCredential,
  validateNewPassword
} = require('./passwordSecurity');
const { SecurityError, createSecurityManager } = require('./securityManager');
const { createHostTerminalPtyFactory } = require('./hostTerminalPty');
const { createTerminalSessionManager } = require('./terminalSessionManager');
const {
  MediaThumbnailError,
  createMediaThumbnailManager
} = require('./mediaThumbnailManager');
const { FileSearchError, createFileSearchManager } = require('./fileSearchManager');
const { CalendarError, createCalendarManager } = require('./calendarManager');
const { createCalendarConnectionManager } = require('./calendarConnectionManager');
const { WeatherError, createWeatherManager } = require('./weatherManager');
const { NotificationError, createNotificationManager } = require('./notificationManager');
const { ObservabilityError, createObservabilityManager } = require('./observabilityManager');
const { createWebPushManager } = require('./webPushManager');
const { createTelegramNotificationManager } = require('./telegramNotificationManager');
const { TaskError, createTaskManager } = require('./taskManager');
const {
  CodexChecklistReviewError,
  createCodexChecklistReviewManager
} = require('./codexChecklistReviewManager');
const { createCodexReviewSources } = require('./codexReviewSources');
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
const {
  APPLICATION_INVENTORY_SCHEMA_VERSION,
  buildApplicationInventory
} = require('./applicationInventory');
const {
  ApplicationDomainError,
  createApplicationDomainManager
} = require('./applicationDomainManager');
const {
  ApplicationComposeError,
  createApplicationComposeManager
} = require('./applicationComposeManager');
const {
  ApplicationUpdateError,
  createApplicationUpdateChecker
} = require('./applicationUpdateChecker');
const {
  createApplicationUpdateManager,
  createEncryptedVolumeSnapshotAdapter
} = require('./applicationUpdateManager');
const {
  ApplicationRemovalError,
  createApplicationRemovalManager
} = require('./applicationRemovalManager');
const {
  DESKTOP_ROOT,
  DesktopShortcutError,
  createDesktopShortcutManager
} = require('./desktopShortcutManager');
const {
  SCHEMA_VERSION: RESOURCE_SCHEMA_VERSION,
  ResourceRegistryError,
  createResourceRegistry
} = require('./resourceRegistry');
const {
  catalogContainerForApp,
  containerName,
  createContainerPayload,
  discoveredAppStates,
  imagePullPath,
  isManagedMigrationCandidate,
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
const SESSIONS_FILE = path.join(DATA_ROOT, 'sessions.json');
const SECURITY_EVENTS_FILE = path.join(DATA_ROOT, 'security-events.jsonl');
const THUMBNAIL_CACHE_ROOT = path.join(DATA_ROOT, 'thumbnail-cache');
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const INITIAL_SETUP_SCHEMA_VERSION = 1;
const COMPLETE_INITIAL_SETUP_CONFIRMATION = 'COMPLETE INITIAL SETUP';
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.COMMAND_TIMEOUT_MS || '120000', 10);
const COMMAND_MAX_BUFFER = 2 * 1024 * 1024;
const CODEX_HOST_STATE_ROOT = process.env.FOXOS_CODEX_HOST_STATE_ROOT || '/var/lib/foxos/codex';
const CODEX_HOST_HOME = CODEX_HOST_STATE_ROOT;
const CODEX_HOST_CONFIG_HOME = path.posix.join(CODEX_HOST_STATE_ROOT, '.codex');
const CODEX_HOST_BINARY = path.posix.join(CODEX_HOST_STATE_ROOT, '.local', 'bin', 'codex');
const CODEX_HOST_DAEMON_SOCKET = codexDaemonSocket(CODEX_HOST_CONFIG_HOME);
const CODEX_MEMORY_VAULT = path.posix.join(CODEX_HOST_STATE_ROOT, 'ana-memory', 'vault');
const CODEX_REVIEW_CONNECTORS_FILE = path.join(DATA_ROOT, 'tasks', 'codex-review', 'connectors.json');
const GEMINI_HOST_STATE_ROOT = process.env.FOXOS_GEMINI_HOST_STATE_ROOT || '/var/lib/foxos/gemini';
const GEMINI_HOST_HOME = GEMINI_HOST_STATE_ROOT;
const GEMINI_INSTALL_PREFIX = path.posix.join(GEMINI_HOST_STATE_ROOT, '.local');
const GEMINI_HOST_BINARY = path.posix.join(GEMINI_INSTALL_PREFIX, 'bin', 'gemini');
const ANTIGRAVITY_HOST_STATE_ROOT = process.env.FOXOS_ANTIGRAVITY_HOST_STATE_ROOT || '/var/lib/foxos/antigravity';
const ANTIGRAVITY_HOST_HOME = ANTIGRAVITY_HOST_STATE_ROOT;
const ANTIGRAVITY_INSTALL_DIR = path.posix.join(ANTIGRAVITY_HOST_STATE_ROOT, '.local', 'bin');
const ANTIGRAVITY_HOST_BINARY = path.posix.join(ANTIGRAVITY_INSTALL_DIR, 'agy');
const ANTIGRAVITY_SETTINGS_FILE = path.posix.join(
  ANTIGRAVITY_HOST_STATE_ROOT,
  '.gemini',
  'antigravity-cli',
  'settings.json'
);

const loginAttempts = new Map();
const appInstallOperations = new Set();
const containerPortCache = new Map();
const activeTerminalManagers = new Set();

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

const mediaThumbnailManager = createMediaThumbnailManager({
  cacheRoot: THUMBNAIL_CACHE_ROOT
});

const sessionStore = createSessionStore({
  filePath: SESSIONS_FILE,
  ttlMs: SESSION_TTL_MS,
  idleTtlMs: SESSION_IDLE_TTL_MS,
  onError: (error) => console.error('Could not read authentication sessions:', error.message)
});

const securityManager = createSecurityManager({
  authFilePath: AUTH_FILE,
  eventFilePath: SECURITY_EVENTS_FILE,
  onError: (error) => console.error('Could not read security state:', error.message)
});

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

function maskNetworkAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '');
  if (['127.0.0.1', '::1'].includes(address)) return 'local';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) {
    const parts = address.split('.');
    return parts.slice(0, 3).join('.') + '.0/24';
  }
  if (address.includes(':')) {
    return address.split(':').slice(0, 4).join(':') + '::/64';
  }
  return null;
}

function summarizeAuthClient(req) {
  const userAgent = String(req.get('user-agent') || '');
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Firefox\//.test(userAgent) ? 'Firefox'
      : /CriOS\//.test(userAgent) ? 'Chrome iOS'
        : /Chrome\//.test(userAgent) ? 'Chrome'
          : /Safari\//.test(userAgent) ? 'Safari'
            : 'Unknown browser';
  const osName = /iPhone|iPad/.test(userAgent) ? 'iOS/iPadOS'
    : /Mac OS X/.test(userAgent) ? 'macOS'
      : /Android/.test(userAgent) ? 'Android'
        : /Windows NT/.test(userAgent) ? 'Windows'
          : /Linux/.test(userAgent) ? 'Linux'
            : 'Unknown OS';
  const device = /iPad|Tablet/.test(userAgent) ? 'tablet'
    : /Mobile|iPhone|Android/.test(userAgent) ? 'mobile'
      : 'desktop';
  return {
    browser,
    os: osName,
    device,
    network: maskNetworkAddress(req.ip || req.socket.remoteAddress)
  };
}

function secureSessionCookies() {
  return process.env.FOXOS_SECURE_COOKIE === 'true';
}

function primarySessionCookieName() {
  return secureSessionCookies() ? '__Host-foxos_session' : 'foxos_session';
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const primaryName = primarySessionCookieName();
  const token = cookies[primaryName] || cookies.foxos_session;
  if (!token) {
    return null;
  }
  const session = sessionStore.get(token);
  if (!session) return null;
  return {
    token,
    cookieName: cookies[primaryName] ? primaryName : 'foxos_session',
    ...session
  };
}

function setSessionCookie(res, token) {
  const secure = secureSessionCookies() ? '; Secure' : '';
  const value = primarySessionCookieName() + '=' + encodeURIComponent(token) +
    '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + secure;
  res.setHeader('Set-Cookie', value);
}

function migrateLegacySessionCookie(res, session) {
  if (!secureSessionCookies() || session.cookieName !== 'foxos_session') return;
  const secureCookie = primarySessionCookieName() + '=' + encodeURIComponent(session.token) +
    '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + '; Secure';
  const clearLegacy = 'foxos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure';
  res.setHeader('Set-Cookie', [secureCookie, clearLegacy]);
}

function createSession(req, res, username, authMethod = 'password') {
  const token = sessionStore.create(username, {
    authMethod,
    client: summarizeAuthClient(req)
  });
  setSessionCookie(res, token);
  return { token, ...sessionStore.get(token, { touch: false }) };
}

function clearSession(req, res) {
  const session = getSession(req);
  if (session) {
    const ownerId = crypto.createHash('sha256').update(session.token).digest('hex');
    for (const terminalManager of activeTerminalManagers) {
      terminalManager.closeOwnerSessions(ownerId);
    }
    sessionStore.remove(session.token);
  }
  const secure = secureSessionCookies() ? '; Secure' : '';
  const clears = [primarySessionCookieName() + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure];
  if (primarySessionCookieName() !== 'foxos_session') {
    clears.push('foxos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure);
  }
  res.setHeader('Set-Cookie', clears);
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  migrateLegacySessionCookie(res, session);
  req.session = session;
  next();
}

function terminalUpgradeOwner(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '');
  if (!origin || !host) return null;
  try {
    if (new URL(origin).host !== host) return null;
  } catch {
    return null;
  }

  const session = getSession(req);
  if (!session) return null;
  return {
    ownerId: crypto.createHash('sha256').update(session.token).digest('hex'),
    expiresAt: session.expiresAt
  };
}

function createFoxOSHttpServer({ spawnTerminalPty } = {}) {
  const spawnPty = spawnTerminalPty || createHostTerminalPtyFactory({
    hostRoot: HOST_ROOT,
    hostExecution: HOST_EXECUTION
  });
  const terminalManager = createTerminalSessionManager({
    authenticate: terminalUpgradeOwner,
    spawnPty
  });
  const server = http.createServer(app);
  terminalManager.attach(server);
  activeTerminalManagers.add(terminalManager);
  server.once('close', () => {
    terminalManager.shutdown();
    activeTerminalManagers.delete(terminalManager);
  });
  return server;
}

function isLoopbackRequest(req) {
  const address = String(req.socket && req.socket.remoteAddress || '');
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function readAuthRecord() {
  return securityManager.readRecord();
}

function writeAuthRecord(record) {
  securityManager.writeRecord(record);
}

function initialSetupRequired(authRecord) {
  return Boolean(
    authRecord && authRecord.initialSetup &&
    authRecord.initialSetup.schemaVersion === INITIAL_SETUP_SCHEMA_VERSION &&
    authRecord.initialSetup.status === 'pending'
  );
}

function localePreferencesForSession(authRecord, session) {
  return session ? publicLocalePreferences(authRecord) : null;
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

function mountedHostPath(hostPath) {
  const normalized = path.posix.resolve('/', String(hostPath || ''));
  const mounted = path.resolve(HOST_ROOT, '.' + normalized);
  if (mounted !== HOST_ROOT && !mounted.startsWith(HOST_ROOT + path.sep)) {
    throw new Error('Host path escapes the mounted server root');
  }
  return mounted;
}

function installBundledCodexSkill(skillName, executableScripts = []) {
  const source = [
    path.join(__dirname, 'skills', skillName),
    path.join(__dirname, '..', 'skills', skillName)
  ].find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')));
  if (!source) return { installed: false, reason: 'bundle-unavailable' };
  const skillsRoot = mountedHostPath(path.posix.join(CODEX_HOST_CONFIG_HOME, 'skills'));
  const destination = path.join(skillsRoot, skillName);
  if (fs.existsSync(destination)) return { installed: false, reason: 'already-present', destination };
  fs.mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(skillsRoot, 0o700);
  const temporary = destination + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false });
    fs.chmodSync(temporary, 0o700);
    for (const script of executableScripts) {
      fs.chmodSync(path.join(temporary, 'scripts', script), 0o755);
    }
    fs.renameSync(temporary, destination);
    return { installed: true, reason: null, destination };
  } catch (error) {
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch {
      // The temporary path may not exist when the copy fails early.
    }
    throw error;
  }
}

function installBundledCodexSkills() {
  return [
    installBundledCodexSkill('foxos-notifications', ['notify.py']),
    installBundledCodexSkill('foxos-checklist', ['task.py'])
  ];
}

function codexHostEnvironment() {
  return {
    HOME: CODEX_HOST_HOME,
    CODEX_HOME: CODEX_HOST_CONFIG_HOME,
    CODEX_INSTALL_DIR: path.posix.dirname(CODEX_HOST_BINARY),
    CODEX_NON_INTERACTIVE: '1',
    PATH: path.posix.dirname(CODEX_HOST_BINARY) + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LOGNAME: 'root',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    USER: 'root'
  };
}

function geminiHostEnvironment(apiKey = null) {
  return {
    HOME: GEMINI_HOST_HOME,
    GEMINI_INSTALL_PREFIX,
    PATH: GEMINI_INSTALL_PREFIX + '/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LOGNAME: 'root',
    NO_COLOR: '1',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    USER: 'root',
    ...(apiKey ? { GEMINI_API_KEY: apiKey } : {})
  };
}

function antigravityHostEnvironment(remoteLogin = false) {
  return {
    HOME: ANTIGRAVITY_HOST_HOME,
    ANTIGRAVITY_INSTALL_DIR,
    PATH: ANTIGRAVITY_INSTALL_DIR + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LOGNAME: 'root',
    NO_COLOR: '1',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    USER: 'root',
    ...(remoteLogin ? {
      COLUMNS: '4096',
      LINES: '60',
      SSH_CLIENT: '127.0.0.1 1 22',
      SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22',
      SSH_TTY: '/dev/pts/0'
    } : {})
  };
}

function validateCodexHostPaths() {
  const paths = [
    CODEX_HOST_STATE_ROOT,
    CODEX_HOST_HOME,
    CODEX_HOST_CONFIG_HOME,
    CODEX_HOST_BINARY,
    CODEX_MEMORY_VAULT
  ];
  if (paths.some((entry) => (
    !entry.startsWith('/') || entry === '/' || entry.length > 512 || /[\r\n\0]/.test(entry)
  ))) {
    throw new Error('FOXOS_CODEX_HOST_STATE_ROOT must be a safe absolute host path');
  }
}

validateCodexHostPaths();

function validateGeminiHostPaths() {
  const paths = [GEMINI_HOST_STATE_ROOT, GEMINI_HOST_HOME, GEMINI_INSTALL_PREFIX, GEMINI_HOST_BINARY];
  if (paths.some((entry) => (
    !entry.startsWith('/') || entry === '/' || entry.length > 512 || /[\r\n\0]/.test(entry)
  ))) {
    throw new Error('FOXOS_GEMINI_HOST_STATE_ROOT must be a safe absolute host path');
  }
}

validateGeminiHostPaths();

function validateAntigravityHostPaths() {
  const paths = [
    ANTIGRAVITY_HOST_STATE_ROOT,
    ANTIGRAVITY_HOST_HOME,
    ANTIGRAVITY_INSTALL_DIR,
    ANTIGRAVITY_HOST_BINARY,
    ANTIGRAVITY_SETTINGS_FILE
  ];
  if (paths.some((entry) => (
    !entry.startsWith('/') || entry === '/' || entry.length > 512 || /[\r\n\0]/.test(entry)
  ))) {
    throw new Error('FOXOS_ANTIGRAVITY_HOST_STATE_ROOT must be a safe absolute host path');
  }
}

validateAntigravityHostPaths();

function exactHostExecutableInvocation(hostExecutable, args) {
  if (HOST_EXECUTION === 'nsenter') {
    return {
      executable: 'nsenter',
      args: [
        '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid',
        // nsenter opens --wd before applying --root. Point both at the host
        // root so getcwd() remains valid after chroot; --wd=/ leaves the
        // process in the agent container's now-unreachable root directory.
        '--root=/proc/1/root', '--wd=/proc/1/root', '--', hostExecutable, ...args
      ],
      cwd: '/'
    };
  }
  return {
    executable: mountedHostPath(hostExecutable),
    args,
    cwd: mountedHostPath('/')
  };
}

function readCodexReviewConnectorPaths() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(CODEX_REVIEW_CONNECTORS_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.error('Codex review connector configuration is invalid.');
    return {};
  }
  const allowed = ['python', 'gmail', 'chat', 'telegram', 'whatsapp'];
  if (
    !payload || payload.schemaVersion !== 1 ||
    Object.keys(payload).some((key) => key !== 'schemaVersion' && !allowed.includes(key))
  ) {
    console.error('Codex review connector configuration is invalid.');
    return {};
  }
  const paths = {};
  for (const key of allowed) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') continue;
    if (
      typeof value !== 'string' || !path.posix.isAbsolute(value) || value === '/' ||
      value.length > 512 || /[\r\n\0]/.test(value)
    ) {
      console.error('Codex review connector configuration is invalid.');
      return {};
    }
    paths[key] = value;
  }
  return paths;
}

function runCodexReviewHostJson(hostExecutable, args, { timeoutMs = 120_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (
    typeof hostExecutable !== 'string' || !path.posix.isAbsolute(hostExecutable) ||
    !Array.isArray(args) || args.some((entry) => (
      typeof entry !== 'string' || entry.length > 8_192 || /[\r\n\0]/.test(entry)
    )) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 8 * 1024 * 1024
  ) {
    const error = new Error('Codex review host request is invalid');
    error.code = 'codex-review-source-invalid';
    return Promise.reject(error);
  }
  const invocation = exactHostExecutableInvocation(hostExecutable, args);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      timeout: timeoutMs,
      maxBuffer: maxBytes,
      windowsHide: true
    }, (error, stdout) => {
      if (error) {
        const failure = new Error('Codex review source command failed');
        failure.code = error.killed
          ? 'codex-review-source-timeout'
          : 'codex-review-source-unavailable';
        return reject(failure);
      }
      let payload;
      try {
        payload = JSON.parse(String(stdout || ''));
      } catch {
        const failure = new Error('Codex review source returned invalid JSON');
        failure.code = 'codex-review-source-invalid';
        return reject(failure);
      }
      resolve(payload);
    });
  });
}

function hostRootShellInvocation(command) {
  if (HOST_EXECUTION === 'nsenter') {
    return {
      executable: 'nsenter',
      args: [
        '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid',
        '--root=/proc/1/root', '--wd=/proc/1/root', '--', '/bin/sh', '-lc', command
      ],
      cwd: '/'
    };
  }
  return {
    executable: '/bin/sh',
    args: ['-lc', command],
    cwd: mountedHostPath('/')
  };
}

async function inspectHostCodexCli() {
  // The official installer creates an absolute host symlink. Checking that
  // symlink through /host makes Node resolve its target inside the agent
  // container, which incorrectly reports a successful host install as absent.
  // Execute the binary in the host namespace; its exit status is the source of
  // truth for both existence and executability.
  const invocation = exactHostExecutableInvocation(CODEX_HOST_BINARY, ['--version']);
  return new Promise((resolve) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: codexHostEnvironment(),
      timeout: 15000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      resolve({
        installed: !error,
        version: !error ? String(stdout || '').trim().slice(0, 120) || null : null
      });
    });
  });
}

async function inspectHostCodexAccount() {
  const invocation = exactHostExecutableInvocation(CODEX_HOST_BINARY, ['login', 'status']);
  return new Promise((resolve) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: codexHostEnvironment(),
      timeout: 15000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const output = String(stdout || '') + String(stderr || '');
      resolve({
        connected: !error,
        authMode: !error && /chatgpt/i.test(output) ? 'chatgpt' : null
      });
    });
  });
}

async function inspectHostGeminiCli() {
  const invocation = exactHostExecutableInvocation(GEMINI_HOST_BINARY, ['--version']);
  return new Promise((resolve) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: geminiHostEnvironment(),
      timeout: 15000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      resolve({
        installed: !error,
        version: !error ? String(stdout || '').trim().slice(0, 120) || null : null
      });
    });
  });
}

async function inspectHostAntigravityCli() {
  const invocation = exactHostExecutableInvocation(ANTIGRAVITY_HOST_BINARY, ['--version']);
  return new Promise((resolve) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: antigravityHostEnvironment(),
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      resolve({
        installed: !error,
        version: !error ? String(stdout || '').trim().slice(0, 120) || null : null
      });
    });
  });
}

function installHostAntigravityCli() {
  const script = [
    'set -eu',
    'umask 077',
    'install -d -m 700 "$HOME" "$ANTIGRAVITY_INSTALL_DIR"',
    'if test -x "$ANTIGRAVITY_INSTALL_DIR/agy"; then',
    '  "$ANTIGRAVITY_INSTALL_DIR/agy" update',
    'else',
    '  antigravity_tmp="$(mktemp -d /tmp/foxos-antigravity-install.XXXXXX)"',
    '  trap \'rm -f -- "$antigravity_tmp/install.sh"; rmdir -- "$antigravity_tmp" 2>/dev/null || true\' EXIT HUP INT TERM',
    '  curl --fail --silent --show-error --location --proto \'=https\' --tlsv1.2 \\',
    '    --output "$antigravity_tmp/install.sh" "https://antigravity.google/cli/install.sh"',
    '  test -s "$antigravity_tmp/install.sh"',
    '  /bin/bash "$antigravity_tmp/install.sh" --dir "$ANTIGRAVITY_INSTALL_DIR"',
    'fi',
    'test -x "$ANTIGRAVITY_INSTALL_DIR/agy"',
    '"$ANTIGRAVITY_INSTALL_DIR/agy" --version >/dev/null'
  ].join('\n');
  const invocation = hostRootShellInvocation(script);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: antigravityHostEnvironment(),
      timeout: 5 * 60 * 1000,
      maxBuffer: 512 * 1024,
      windowsHide: true
    }, (error) => {
      if (error) {
        return reject(new AntigravityConnectionError(
          'Antigravity CLI sunucuya kurulamadı. Sunucu ağını ve resmi Google kurulum hizmetini kontrol edin.',
          503,
          'antigravity-cli-install-failed'
        ));
      }
      resolve();
    });
  });
}

function antigravityUsageInvocation() {
  return exactHostExecutableInvocation(ANTIGRAVITY_HOST_BINARY, [
    '--output-format', 'json',
    '--print-timeout', '20s',
    '--print', '/usage'
  ]);
}

function spawnHostAntigravityLogin() {
  const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const command = 'stty cols 4096 rows 60; exec ' + shellQuote(ANTIGRAVITY_HOST_BINARY);
  const invocation = exactHostExecutableInvocation('/usr/bin/script', [
    '-qefc',
    command,
    '/dev/null'
  ]);
  const child = spawn(invocation.executable, invocation.args, {
    cwd: invocation.cwd,
    detached: true,
    env: antigravityHostEnvironment(true),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const killDirectChild = child.kill.bind(child);
  child.kill = (signal = 'SIGTERM') => {
    let groupSignalled = false;
    if (Number.isInteger(child.pid) && child.pid > 1) {
      try {
        process.kill(-child.pid, signal);
        groupSignalled = true;
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    let directSignalled = false;
    try { directSignalled = killDirectChild(signal); } catch { /* The group signal may have won the race. */ }
    return groupSignalled || directSignalled;
  };
  let selectedGoogleOauth = false;
  let menuOutput = '';
  const selectGoogleOauth = (chunk) => {
    if (selectedGoogleOauth) return;
    menuOutput = (menuOutput + String(chunk || '')).slice(-16 * 1024)
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
    if (!/>\s*1\.\s*Google OAuth/i.test(menuOutput)) return;
    selectedGoogleOauth = true;
    setTimeout(() => {
      try { child.stdin.write('\r'); } catch { /* The TUI may already have exited. */ }
    }, 100).unref?.();
  };
  child.stdout.on('data', selectGoogleOauth);
  child.stderr.on('data', selectGoogleOauth);
  return child;
}

function inspectHostAntigravityAccount() {
  const invocation = antigravityUsageInvocation();
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: antigravityHostEnvironment(true),
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const output = String(stdout || '') + '\n' + String(stderr || '');
      const payload = finalJsonPayload(output);
      if (!error && payload && payload.status !== 'ERROR' && !payload.error) {
        return resolve({ connected: true, authMode: 'google-oauth' });
      }
      if (
        /Authentication required|authentication failed|accounts\.google\.com\/o\/oauth2\/auth/i.test(output)
      ) {
        return resolve({ connected: false, authMode: null });
      }
      reject(new AntigravityConnectionError(
        error && error.killed
          ? 'Antigravity hesap kontrolü zaman aşımına uğradı.'
          : 'Antigravity hesap durumu okunamadı.',
        error && error.killed ? 504 : 502,
        error && error.killed
          ? 'antigravity-account-verification-timeout'
          : 'antigravity-account-verification-failed'
      ));
    });
  });
}

function readHostAntigravityUsage() {
  const invocation = antigravityUsageInvocation();
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: antigravityHostEnvironment(true),
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const output = String(stdout || '') + '\n' + String(stderr || '');
      const payload = finalJsonPayload(output);
      if (!error && payload && payload.status !== 'ERROR' && !payload.error) return resolve(payload);
      if (/Authentication required|authentication failed|accounts\.google\.com\/o\/oauth2\/auth/i.test(output)) {
        return reject(new AntigravityConnectionError(
          'Antigravity hesabı bağlı değil.',
          409,
          'antigravity-account-required'
        ));
      }
      reject(new AntigravityConnectionError(
        error && error.killed
          ? 'Antigravity kullanım bilgisi zaman aşımına uğradı.'
          : 'Antigravity kullanım bilgisi okunamadı.',
        error && error.killed ? 504 : 502,
        error && error.killed
          ? 'antigravity-usage-timeout'
          : 'antigravity-usage-unavailable'
      ));
    });
  });
}

function logoutHostAntigravityAccount() {
  const invocation = exactHostExecutableInvocation(ANTIGRAVITY_HOST_BINARY, [
    '--output-format', 'json',
    '--print-timeout', '20s',
    '--print', '/logout'
  ]);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: antigravityHostEnvironment(),
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    }, (error) => {
      if (error && error.killed) {
        return reject(new AntigravityConnectionError(
          'Antigravity hesabından çıkış zaman aşımına uğradı.',
          504,
          'antigravity-logout-timeout'
        ));
      }
      // The following account inspection is authoritative. Some releases exit
      // non-zero after deleting the active session, so no output is trusted here.
      resolve();
    });
  });
}

function installHostGeminiCli() {
  const script = [
    'set -eu',
    'umask 077',
    'install -d -m 700 "$HOME" "$GEMINI_INSTALL_PREFIX"',
    'command -v node >/dev/null',
    'command -v npm >/dev/null',
    'node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)\'',
    'gemini_version="$(npm view --silent @google/gemini-cli@latest version)"',
    'printf "%s" "$gemini_version" | grep -Eq \'^[0-9]+\\.[0-9]+\\.[0-9]+([-.][0-9A-Za-z.-]+)?$\'',
    'npm install --global --prefix "$GEMINI_INSTALL_PREFIX" --no-audit --no-fund --loglevel=error "@google/gemini-cli@$gemini_version"',
    'test -x "$GEMINI_INSTALL_PREFIX/bin/gemini"',
    '"$GEMINI_INSTALL_PREFIX/bin/gemini" --version >/dev/null'
  ].join('\n');
  const invocation = hostRootShellInvocation(script);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: geminiHostEnvironment(),
      timeout: 5 * 60 * 1000,
      maxBuffer: 512 * 1024,
      windowsHide: true
    }, (error) => {
      if (error) {
        return reject(new GeminiConnectionError(
          'Gemini CLI sunucuya kurulamadı. Node.js 20+, npm ve sunucu ağını kontrol edin.',
          503,
          'gemini-cli-install-failed'
        ));
      }
      resolve();
    });
  });
}

function verifyHostGeminiCredential(apiKey) {
  const script = [
    'set -eu',
    'cd "$HOME"',
    'exec "$GEMINI_INSTALL_PREFIX/bin/gemini" \\',
    '  --skip-trust \\',
    '  --approval-mode plan \\',
    '  --extensions none \\',
    '  --output-format json \\',
    '  --prompt "Reply with exactly FOXOS_GEMINI_CONNECTED. Do not use tools."'
  ].join('\n');
  const invocation = hostRootShellInvocation(script);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: geminiHostEnvironment(apiKey),
      timeout: 90_000,
      maxBuffer: 512 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      if (error) {
        return reject(new GeminiConnectionError(
          error.killed
            ? 'Gemini CLI doğrulaması zaman aşımına uğradı.'
            : 'Gemini API anahtarı veya hesabın erişim türü doğrulanamadı.',
          error.killed ? 504 : 409,
          error.killed ? 'gemini-verification-timeout' : 'gemini-api-key-verification-failed'
        ));
      }
      let payload;
      try {
        payload = JSON.parse(String(stdout || '').trim());
      } catch {
        return reject(new GeminiConnectionError(
          'Gemini CLI doğrulama yanıtı geçersiz.',
          502,
          'gemini-verification-response-invalid'
        ));
      }
      if (payload.error || typeof payload.response !== 'string' || !payload.response.trim()) {
        return reject(new GeminiConnectionError(
          'Gemini API anahtarı CLI tarafından doğrulanamadı.',
          409,
          'gemini-api-key-verification-failed'
        ));
      }
      resolve({ verified: true });
    });
  });
}

function installHostCodexCli() {
  const script = [
    'set -eu',
    'umask 077',
    'install -d -m 700 "$HOME" "$CODEX_HOME" "$CODEX_INSTALL_DIR"',
    'installer="$(mktemp)"',
    'trap \'rm -f "$installer"\' EXIT HUP INT TERM',
    'curl --proto "=https" --tlsv1.2 --fail --silent --show-error --location https://chatgpt.com/codex/install.sh -o "$installer"',
    'sh "$installer"',
    'test -x "$CODEX_INSTALL_DIR/codex"',
    '"$CODEX_INSTALL_DIR/codex" app-server daemon bootstrap >/dev/null',
    'test -S "$CODEX_HOME/app-server-control/app-server-control.sock"'
  ].join('\n');
  const invocation = hostRootShellInvocation(script);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: codexHostEnvironment(),
      timeout: 5 * 60 * 1000,
      maxBuffer: 512 * 1024,
      windowsHide: true
    }, (error) => {
      if (error) {
        return reject(new CodexConnectionError(
          'Codex CLI sunucuya kurulamadı. Sunucu ağını ve Linux araçlarını kontrol edin.',
          503,
          'codex-cli-install-failed'
        ));
      }
      resolve();
    });
  });
}

function prepareHostCodexAppServer() {
  const invocation = hostRootShellInvocation(codexDaemonEnsureScript());
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: codexHostEnvironment(),
      timeout: 30000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    }, (error) => {
      if (error) {
        return reject(new CodexConnectionError(
          'Codex host daemon başlatılamadı.',
          503,
          'codex-app-server-unavailable'
        ));
      }
      resolve();
    });
  });
}

function spawnHostCodexAppServer() {
  return createCodexDaemonTransport({
    socketPath: mountedHostPath(CODEX_HOST_DAEMON_SOCKET)
  });
}

function stopHostCodexAppServer() {
  const invocation = exactHostExecutableInvocation(CODEX_HOST_BINARY, [
    'app-server', 'daemon', 'stop'
  ]);
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: codexHostEnvironment(),
      timeout: 30000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    }, (error) => {
      if (error) {
        return reject(new CodexConnectionError(
          'Codex host daemon durdurulamadı.',
          503,
          'codex-app-server-stop-failed'
        ));
      }
      resolve();
    });
  });
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

function runExactHostFile(file, args) {
  if (![
    'iptables', 'iptables-legacy', 'iptables-nft',
    'ip6tables', 'ip6tables-legacy', 'ip6tables-nft'
  ].includes(file) || !Array.isArray(args) || args.some((entry) => (
    typeof entry !== 'string' || entry.length > 128 || /[\r\n\0]/.test(entry)
  ))) {
    return Promise.resolve({ success: false, exitCode: 1, output: 'Host command is outside FoxOS ingress policy.\n' });
  }
  const hostExecutable = [
    '/usr/sbin/' + file,
    '/usr/bin/' + file,
    '/sbin/' + file,
    '/bin/' + file
  ].find((candidate) => fs.existsSync(path.resolve(HOST_ROOT, '.' + candidate)));
  if (HOST_EXECUTION === 'nsenter' && !hostExecutable) {
    return Promise.resolve({ success: false, exitCode: 127, output: 'Host firewall command is unavailable.\n' });
  }
  return new Promise((resolve) => {
    const executable = HOST_EXECUTION === 'nsenter' ? hostExecutable : file;
    const invocation = HOST_EXECUTION === 'nsenter' ? {
      executable: 'nsenter',
      args: ['--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--', executable, ...args]
    } : { executable, args };
    execFile(invocation.executable, invocation.args, {
      timeout: 15000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        exitCode: error && Number.isInteger(error.code) ? error.code : error ? 1 : 0,
        output: String(stdout || '') + String(stderr || '')
      });
    });
  });
}

function runExactHostObservation(operation) {
  const definitions = {
    'systemd-unit-files': {
      candidates: ['/usr/bin/systemctl', '/bin/systemctl'],
      args: ['list-unit-files', '--type=service', '--all', '--no-legend', '--no-pager', '--plain']
    },
    'systemd-units': {
      candidates: ['/usr/bin/systemctl', '/bin/systemctl'],
      args: ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain']
    },
    'wireguard-interfaces': {
      candidates: ['/usr/bin/wg', '/bin/wg'],
      args: ['show', 'interfaces']
    },
    'wireguard-version': {
      candidates: ['/usr/bin/wg', '/bin/wg'],
      args: ['--version']
    }
  };
  const definition = definitions[operation];
  if (!definition) {
    return Promise.resolve({ success: false, exitCode: 1, output: 'Host observation is outside the fixed read policy.\n' });
  }
  const hostExecutable = definition.candidates.find((candidate) => (
    fs.existsSync(path.resolve(HOST_ROOT, '.' + candidate))
  ));
  if (!hostExecutable) {
    return Promise.resolve({ success: false, exitCode: 127, output: '' });
  }
  const invocation = HOST_EXECUTION === 'nsenter' ? {
    executable: 'nsenter',
    args: [
      '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--',
      hostExecutable, ...definition.args
    ]
  } : {
    executable: hostExecutable,
    args: definition.args
  };
  return new Promise((resolve) => {
    execFile(invocation.executable, invocation.args, {
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      resolve({
        success: !error,
        exitCode: error && Number.isInteger(error.code) ? error.code : error ? 1 : 0,
        output: String(stdout || '')
      });
    });
  });
}

function runExactHostServiceCommand(action, unit) {
  const allowedActions = new Set(['start', 'stop', 'restart', 'enable', 'disable']);
  if (
    !allowedActions.has(action) ||
    !/^[A-Za-z0-9_.@-]+\.service$/.test(String(unit || ''))
  ) {
    return Promise.resolve({ success: false, exitCode: 1, output: '' });
  }
  const hostExecutable = ['/usr/bin/systemctl', '/bin/systemctl'].find((candidate) => (
    fs.existsSync(path.resolve(HOST_ROOT, '.' + candidate))
  ));
  if (!hostExecutable) {
    return Promise.resolve({ success: false, exitCode: 127, output: '' });
  }
  const invocation = HOST_EXECUTION === 'nsenter' ? {
    executable: 'nsenter',
    args: [
      '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--',
      hostExecutable, action, unit, '--no-ask-password', '--no-pager'
    ]
  } : {
    executable: hostExecutable,
    args: [action, unit, '--no-ask-password', '--no-pager']
  };
  return new Promise((resolve) => {
    execFile(invocation.executable, invocation.args, {
      timeout: 120000,
      maxBuffer: 256 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        exitCode: error && Number.isInteger(error.code) ? error.code : error ? 1 : 0,
        output: String(stdout || '') + String(stderr || '')
      });
    });
  });
}

function runExactApplicationCompose({ operation, project, services, overrideFile = null }) {
  const allowedOperations = new Set(['build', 'pull', 'stop', 'up', 'rollback']);
  const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
  const invalid = (
    !allowedOperations.has(operation) || !project ||
    !namePattern.test(String(project.projectName || '')) ||
    !Array.isArray(project.files) || !project.files.length || project.files.length > 8 ||
    !Array.isArray(services) || !services.length || services.length > 16 ||
    services.some((service) => !namePattern.test(String(service || '')))
  );
  if (invalid) {
    return Promise.reject(new ApplicationUpdateError(
      'Compose güncelleme komutu güvenli çalışma sınırının dışında.',
      409,
      'application-update-compose-command-blocked'
    ));
  }

  const hostPaths = project.files.map((file) => String(file.hostPath || ''));
  if (overrideFile) hostPaths.push(String(overrideFile));
  const workingDirectory = path.posix.normalize(String(project.workingDirectory || ''));
  if (
    !workingDirectory.startsWith('/') || workingDirectory === '/opt/foxos' || workingDirectory.startsWith('/opt/foxos/') ||
    hostPaths.some((hostPath) => (
      !hostPath.startsWith('/') || !/\.ya?ml$/i.test(hostPath) ||
      hostPath === '/opt/foxos' || hostPath.startsWith('/opt/foxos/') ||
      /[\r\n\0]/.test(hostPath)
    ))
  ) {
    return Promise.reject(new ApplicationUpdateError(
      'Compose güncelleme yolu güvenli çalışma sınırının dışında.',
      409,
      'application-update-compose-path-blocked'
    ));
  }
  for (const hostPath of hostPaths) {
    const mounted = path.resolve(HOST_ROOT, '.' + path.posix.normalize(hostPath));
    if (mounted !== path.resolve(HOST_ROOT) && !mounted.startsWith(path.resolve(HOST_ROOT) + path.sep)) {
      return Promise.reject(new ApplicationUpdateError('Compose yolu doğrulanamadı.', 409, 'application-update-compose-path-blocked'));
    }
    let stats;
    try { stats = fs.lstatSync(mounted); } catch {
      return Promise.reject(new ApplicationUpdateError('Compose kaynağı bulunamadı.', 409, 'application-update-compose-path-blocked'));
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return Promise.reject(new ApplicationUpdateError('Compose kaynağı normal bir dosya değil.', 409, 'application-update-compose-path-blocked'));
    }
  }
  const mountedWorkingDirectory = path.resolve(HOST_ROOT, '.' + workingDirectory);
  let workingDirectoryValid = false;
  try {
    workingDirectoryValid = (
      mountedWorkingDirectory !== path.resolve(HOST_ROOT) &&
      mountedWorkingDirectory.startsWith(path.resolve(HOST_ROOT) + path.sep) &&
      fs.statSync(mountedWorkingDirectory).isDirectory()
    );
  } catch {}
  if (!workingDirectoryValid) {
    return Promise.reject(new ApplicationUpdateError('Compose çalışma dizini doğrulanamadı.', 409, 'application-update-compose-path-blocked'));
  }

  const hostExecutable = ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'].find((candidate) => (
    fs.existsSync(path.resolve(HOST_ROOT, '.' + candidate))
  ));
  if (!hostExecutable) {
    return Promise.reject(new ApplicationUpdateError('Sunucuda Docker Compose bulunamadı.', 503, 'application-update-compose-unavailable'));
  }
  const args = ['compose', '--project-name', project.projectName, '--project-directory', workingDirectory];
  for (const file of project.files) args.push('-f', file.hostPath);
  if (overrideFile) args.push('-f', overrideFile);
  if (operation === 'build') args.push('build', '--pull', ...services);
  if (operation === 'pull') args.push('pull', ...services);
  if (operation === 'stop') args.push('stop', '--timeout', '60', ...services);
  if (operation === 'up') args.push('up', '-d', '--no-deps', '--wait', '--wait-timeout', '300', ...services);
  if (operation === 'rollback') args.push('up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '300', ...services);

  const invocation = HOST_EXECUTION === 'nsenter' ? {
    executable: 'nsenter',
    args: ['--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--', hostExecutable, ...args]
  } : { executable: hostExecutable, args };
  return new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      timeout: 15 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const output = String(stdout || '') + String(stderr || '');
      if (error) {
        return reject(new ApplicationUpdateError(
          'Docker Compose ' + operation + ' işlemi başarısız oldu' + (output.trim() ? ': ' + output.trim().slice(-4000) : '.'),
          409,
          'application-update-compose-' + operation + '-failed'
        ));
      }
      resolve({ success: true, output });
    });
  });
}

const dockerClient = createDockerClient(DOCKER_SOCKET);
const dockerRequest = dockerClient.request;
const encryptionStore = createEncryptionStore({ dataRoot: DATA_ROOT });
const maintenanceSessionManager = createMaintenanceSessionManager({ dataRoot: DATA_ROOT });
const desktopShortcutManager = createDesktopShortcutManager({ dataRoot: DATA_ROOT });
const fileSearchManager = createFileSearchManager({
  diskRoot: DISK_ROOT,
  followedSymlinkRootNames: ['Masaüstü'],
  allowedSymlinkTargetRoots: [HOST_ROOT]
});
const calendarManager = createCalendarManager({ dataRoot: DATA_ROOT });
const calendarConnectionManager = createCalendarConnectionManager({
  dataRoot: DATA_ROOT,
  encryptionStore
});
const weatherManager = createWeatherManager({ dataRoot: DATA_ROOT });
const notificationManager = createNotificationManager({ dataRoot: DATA_ROOT });
const codexConnectionManager = createCodexConnectionManager({
  dataRoot: DATA_ROOT,
  inspectAccount: inspectHostCodexAccount,
  inspectCli: inspectHostCodexCli,
  installCli: installHostCodexCli,
  prepareAppServer: prepareHostCodexAppServer,
  spawnAppServer: spawnHostCodexAppServer,
  stopAppServer: stopHostCodexAppServer,
  memoryVaultPath: CODEX_MEMORY_VAULT
});
const taskManager = createTaskManager({
  dataRoot: DATA_ROOT,
  notificationManager,
  onError: (error) => console.error('Checklist reminder pass failed:', error.message)
});
const codexReviewSources = createCodexReviewSources({
  runHostJson: runCodexReviewHostJson,
  paths: readCodexReviewConnectorPaths()
});
const codexChecklistReviewManager = createCodexChecklistReviewManager({
  dataRoot: DATA_ROOT,
  taskManager,
  notificationManager,
  sourceAdapter: codexReviewSources,
  codexConnectionManager,
  onError: (error) => console.error('Codex checklist review failed:', error.code || error.message)
});
const webPushManager = createWebPushManager({
  dataRoot: DATA_ROOT,
  notificationManager
});
const telegramNotificationManager = createTelegramNotificationManager({
  dataRoot: DATA_ROOT,
  encryptionStore,
  notificationManager,
  taskManager
});
notificationManager.ensureIngestToken();
notificationManager.onNotification((notification) => {
  webPushManager.deliver(notification).catch((error) => {
    console.error('Web Push delivery failed:', error.message);
  });
  telegramNotificationManager.deliver(notification).catch((error) => {
    console.error('Telegram notification delivery failed:', error.message);
  });
});
notificationManager.onStatus((notification) => {
  telegramNotificationManager.syncStatus(notification).catch((error) => {
    console.error('Telegram notification status sync failed:', error.code || 'telegram-message-sync-failed');
  });
});
telegramNotificationManager.start();
telegramNotificationManager.reconcileCommands().catch((error) => {
  console.error('Telegram command reconciliation failed:', error.code || 'telegram-command-reconciliation-failed');
});
taskManager.start();
codexChecklistReviewManager.start();

const observabilityManager = createObservabilityManager({
  dataRoot: DATA_ROOT,
  hostRoot: HOST_ROOT,
  dockerInspect: dockerClient.containerInspect,
  dockerStats: dockerClient.containerStats,
  dockerLogs: dockerClient.containerLogs,
  getApplicationInventory,
  notificationManager,
  onError: (error) => console.error('Observability operation failed:', error.code || 'observability-operation-failed')
});

function calendarPublicBaseUrl(req) {
  const configured = String(process.env.FOXOS_ROUTE_BASE_URL || '').trim();
  const candidate = configured || `${req.protocol}://${req.get('host')}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new CalendarError('Takvim OAuth genel adresi geçersiz.', 503, 'calendar-oauth-base-url-invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CalendarError('Takvim OAuth genel adresi geçersiz.', 503, 'calendar-oauth-base-url-invalid');
  }
  return url.origin;
}

function calendarRedirectUri(req, providerId) {
  return new URL(`/oauth/calendar/${encodeURIComponent(providerId)}/callback`, calendarPublicBaseUrl(req)).toString();
}

function calendarRedirectUris(req) {
  return {
    google: calendarRedirectUri(req, 'google'),
    microsoft: calendarRedirectUri(req, 'microsoft')
  };
}

function sendCalendarError(res, error) {
  const status = error instanceof CalendarError ? error.statusCode : 500;
  if (status >= 500 && !(error instanceof CalendarError)) {
    console.error('Calendar operation failed:', error.message);
  }
  return res.status(status).json({
    error: status >= 500 && !(error instanceof CalendarError)
      ? 'Takvim işlemi tamamlanamadı.'
      : error.message,
    code: error.code || 'calendar-operation-failed'
  });
}

function sendWeatherError(res, error) {
  const status = error instanceof WeatherError ? error.statusCode : 500;
  if (status >= 500 && !(error instanceof WeatherError)) {
    console.error('Weather operation failed:', error.message);
  }
  return res.status(status).json({
    error: status >= 500 && !(error instanceof WeatherError)
      ? 'Hava durumu işlemi tamamlanamadı.'
      : error.message,
    code: error.code || 'weather-operation-failed'
  });
}

function sendNotificationError(res, error) {
  const status = error instanceof NotificationError ? error.statusCode : 500;
  if (status >= 500 && !(error instanceof NotificationError)) {
    console.error('Notification operation failed:', error.message);
  }
  return res.status(status).json({
    error: status >= 500 && !(error instanceof NotificationError)
      ? 'Bildirim işlemi tamamlanamadı.'
      : error.message,
    code: error.code || 'notification-operation-failed'
  });
}

function sendObservabilityError(res, error) {
  const status = error instanceof ObservabilityError ? error.statusCode : 500;
  if (status >= 500 && !(error instanceof ObservabilityError)) {
    console.error('Observability operation failed:', error.code || 'observability-operation-failed');
  }
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(status).json({
    error: status >= 500 && !(error instanceof ObservabilityError)
      ? 'Gözlem verisi şu anda okunamadı.'
      : error.message,
    code: error.code || 'observability-operation-failed'
  });
}

function sendTaskError(res, error) {
  const status = error instanceof TaskError ? error.statusCode : 500;
  if (status >= 500 && !(error instanceof TaskError)) {
    console.error('Checklist operation failed:', error.message);
  }
  return res.status(status).json({
    error: status >= 500 && !(error instanceof TaskError)
      ? 'Görev işlemi tamamlanamadı.'
      : error.message,
    code: error.code || 'task-operation-failed'
  });
}

function sendCodexChecklistReviewError(res, error) {
  const status = error instanceof CodexChecklistReviewError ? error.statusCode : 500;
  if (status >= 500 && !(error instanceof CodexChecklistReviewError)) {
    console.error('Codex checklist review operation failed:', error.message);
  }
  return res.status(status).json({
    error: status >= 500 && !(error instanceof CodexChecklistReviewError)
      ? 'Codex iş kontrolü tamamlanamadı.'
      : error.message,
    code: error.code || 'codex-review-operation-failed'
  });
}

async function codexChecklistReviewStatus() {
  const [review, connection] = await Promise.all([
    Promise.resolve(codexChecklistReviewManager.status()),
    codexConnectionManager.status()
  ]);
  return {
    ...review,
    codex: {
      ready: connection.ready === true && connection.fullServer === true,
      connected: connection.connected === true,
      fullServer: connection.fullServer === true
    }
  };
}

function desktopShortcutPathForWorkspaceTarget(target) {
  const desktopDirectory = path.join(DISK_ROOT, DESKTOP_ROOT.slice(1));
  const relative = path.relative(desktopDirectory, target);
  if (relative === '') return DESKTOP_ROOT;
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
  return DESKTOP_ROOT + '/' + relative.split(path.sep).join('/');
}

function validatedDesktopShortcutFolder(requestedPath) {
  const shortcutPath = desktopShortcutManager.normalizeLocation(requestedPath);
  const target = resolveWorkspacePath(shortcutPath);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new DesktopShortcutError('Hedef masaüstü klasörü bulunamadı.', 404, 'shortcut-folder-not-found');
  }
  const desktopDirectory = path.join(DISK_ROOT, DESKTOP_ROOT.slice(1));
  const realDesktop = fs.realpathSync(desktopDirectory);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(realDesktop, realTarget);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new DesktopShortcutError(
      'Uygulama kısayolu yalnız gerçek bir Masaüstü klasöründe tutulabilir.',
      400,
      'shortcut-folder-outside-desktop'
    );
  }
  return shortcutPath;
}

function projectedDesktopShortcutLocation(applicationId) {
  const configured = desktopShortcutManager.location(applicationId);
  try {
    return validatedDesktopShortcutFolder(configured);
  } catch {
    if (configured !== DESKTOP_ROOT) {
      try {
        desktopShortcutManager.setLocation(applicationId, DESKTOP_ROOT);
      } catch {
        // Keep inventory available even if stale shortcut state cannot be repaired.
      }
    }
    return DESKTOP_ROOT;
  }
}
const coolifyMigrationReader = createCoolifyMigrationReader({
  dataRoot: DATA_ROOT,
  encryptionStore
});
const statefulMigrationVolumeSnapshots = createEncryptedVolumeSnapshotAdapter({
  dataRoot: DATA_ROOT,
  hostRoot: HOST_ROOT,
  dockerRequest,
  encryptionStore,
  snapshotsDirectory: path.join('stateful-migrations', 'snapshots'),
  snapshotPurpose: 'stateful-final-volume'
});

const resourceRegistry = createResourceRegistry({
  dataRoot: DATA_ROOT,
  dockerRequest,
  hostResourceReader: () => createHostServiceDiscovery({
    hostRoot: HOST_ROOT,
    hostRead: runExactHostObservation
  }),
  providerResourceReader: () => coolifyMigrationReader.scan(),
  providerDefinitionMetadataReader: (artifact) => coolifyMigrationReader.recoveryMetadata(artifact),
  volumeCapacityReader: ({ volumes }) => statefulMigrationVolumeSnapshots.inspectCapacity({
    volumes,
    maximumTransactionBytes: MAX_DIRECT_STATEFUL_TRANSACTION_BYTES
  })
});
const hostServiceManager = createHostServiceManager({
  resourceRegistry,
  hostCommand: runExactHostServiceCommand
});
const routeManager = createRouteManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  publicBaseUrl: process.env.FOXOS_ROUTE_BASE_URL,
  networkName: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
  gatewayHost: process.env.FOXOS_ROUTE_GATEWAY_HOST || 'foxos-gateway'
});
const secretManager = createSecretManager({
  dataRoot: DATA_ROOT,
  encryptionStore
});
const backupManager = createBackupManager({
  dataRoot: DATA_ROOT,
  encryptionStore
});
const cloudflareConnectionManager = createCloudflareConnectionManager({
  dataRoot: DATA_ROOT,
  encryptionStore
});
const geminiConnectionManager = createGeminiConnectionManager({
  dataRoot: DATA_ROOT,
  encryptionStore,
  inspectCli: inspectHostGeminiCli,
  installCli: installHostGeminiCli,
  verifyCredential: verifyHostGeminiCredential
});
const antigravityLoginController = createAntigravityLoginController({
  spawnLogin: spawnHostAntigravityLogin,
  authorizationCodeTerminator: '\r',
  postSubmissionWaitMs: 12_000,
  postTerminationWaitMs: 1500
});
const antigravityConnectionManager = createAntigravityConnectionManager({
  dataRoot: DATA_ROOT,
  settingsFile: mountedHostPath(ANTIGRAVITY_SETTINGS_FILE),
  inspectCli: inspectHostAntigravityCli,
  installCli: installHostAntigravityCli,
  inspectAccount: inspectHostAntigravityAccount,
  loginController: antigravityLoginController,
  logoutAccount: logoutHostAntigravityAccount
});
const cliUsageManager = createCliUsageManager({
  providers: [
    {
      id: 'codex',
      name: 'Codex',
      connection: () => codexConnectionManager.status(),
      read: () => codexConnectionManager.readRateLimits(),
      normalize: normalizeCodexRateLimits
    },
    {
      id: 'antigravity-cli',
      name: 'Antigravity',
      connection: () => antigravityConnectionManager.status(),
      read: readHostAntigravityUsage,
      normalize: normalizeAntigravityUsage
    }
  ],
  onError: (provider, error) => {
    console.error('CLI usage refresh failed:', provider, error && error.code || 'cli-usage-unavailable');
  }
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
const certificateImporter = createTraefikCertificateImporter({
  dataRoot: DATA_ROOT,
  dockerRequest,
  hostRoot: HOST_ROOT
});
const ingressAuthorityManager = createIngressAuthorityManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerExec: dockerClient.exec,
  hostCommand: runExactHostFile,
  routingNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
  gatewayContainer: process.env.FOXOS_ROUTE_GATEWAY_HOST || 'foxos-gateway',
  ingressHttpPort: Number.parseInt(process.env.FOXOS_INGRESS_HTTP_PORT || '9080', 10),
  ingressHttpsPort: Number.parseInt(process.env.FOXOS_INGRESS_HTTPS_PORT || '9443', 10),
  panelBaseUrl: process.env.FOXOS_ROUTE_BASE_URL || null
});
const inactiveDefinitionIngressReconciler = createInactiveDefinitionIngressReconciler({
  certificateImporter,
  ingressAuthority: ingressAuthorityManager
});
const applicationDomainManager = createApplicationDomainManager({
  dataRoot: DATA_ROOT,
  ingressAuthority: ingressAuthorityManager,
  resourceRegistry,
  getApplicationInventory,
  dockerRequest,
  routingNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
  panelBaseUrl: process.env.FOXOS_ROUTE_BASE_URL || null,
  dnsAutomation: cloudflareConnectionManager
});
const applicationRemovalManager = createApplicationRemovalManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  getApplicationInventory,
  resourceRegistry,
  ingressAuthority: ingressAuthorityManager,
  desktopShortcutManager,
  applicationDomainManager
});
const applicationComposeManager = createApplicationComposeManager({
  dataRoot: DATA_ROOT,
  hostRoot: HOST_ROOT,
  dockerRequest,
  encryptionStore,
  getApplicationInventory
});
const applicationUpdateChecker = createApplicationUpdateChecker({
  dataRoot: DATA_ROOT,
  hostRoot: HOST_ROOT,
  dockerRequest,
  getApplicationInventory
});
const applicationUpdateVolumeSnapshots = createEncryptedVolumeSnapshotAdapter({
  dataRoot: DATA_ROOT,
  hostRoot: HOST_ROOT,
  dockerRequest,
  encryptionStore
});
const applicationUpdateManager = createApplicationUpdateManager({
  dataRoot: DATA_ROOT,
  hostRoot: HOST_ROOT,
  dockerRequest,
  getApplicationInventory,
  checkApplicationUpdate: (applicationId) => applicationUpdateChecker.check(applicationId),
  composeRunner: runExactApplicationCompose,
  volumeSnapshots: applicationUpdateVolumeSnapshots,
  routeRuntime: ingressAuthorityManager
});
const productionStatelessMigrationAdapter = createProductionStatelessMigrationAdapter({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerExec: dockerClient.exec,
  resourceRegistry,
  secretManager,
  certificateImporter,
  ingressAuthority: ingressAuthorityManager,
  routingNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
  egressNetwork: process.env.FOXOS_EGRESS_NETWORK || 'foxos-egress',
  gatewayContainer: process.env.FOXOS_ROUTE_GATEWAY_HOST || 'foxos-gateway'
});
const productionStatefulMigrationAdapter = createProductionStatefulMigrationAdapter({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerExec: dockerClient.exec,
  resourceRegistry,
  secretManager,
  volumeSnapshots: statefulMigrationVolumeSnapshots,
  certificateImporter,
  ingressAuthority: ingressAuthorityManager,
  routingNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
  egressNetwork: process.env.FOXOS_EGRESS_NETWORK || 'foxos-egress'
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
const statefulMigrationManifestCompiler = createStatefulMigrationManifestCompiler({
  resourceRegistry,
  compileApplicationManifest: (resourceId) => applicationManifestManager.compile(resourceId)
});
const uiApprovalManager = createUiApprovalManager();
const runtimeTransferManager = createRuntimeTransferManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  dockerExec: dockerClient.exec,
  resourceRegistry,
  secretManager,
  certificateImporter,
  ingressAuthority: ingressAuthorityManager,
  approvalVerifier: (input) => uiApprovalManager.verify(input),
  readProviderRecoveryArtifact: (artifact) => coolifyMigrationReader.readRecoveryArtifact(artifact),
  routingNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing'
});
const inactiveDefinitionRuntimeManager = createInactiveDefinitionRuntimeManager({
  dataRoot: DATA_ROOT,
  dockerRequest,
  resourceRegistry,
  readRecoveryArtifact: (artifact) => coolifyMigrationReader.readRecoveryArtifact(artifact),
  certificateImporter,
  ingressAuthority: ingressAuthorityManager,
  internalHttpProbe: async ({ alias, privatePort, requestPath }) => {
    const infrastructure = await ingressAuthorityManager.inspectOwnedInfrastructure();
    const gatewayId = infrastructure && infrastructure.gateway && infrastructure.gateway.Id;
    const result = await dockerClient.exec(gatewayId, [
      'wget', '--server-response', '--output-document=/dev/null', '--timeout=2',
      `http://${alias}:${privatePort}${requestPath}`
    ], { timeoutMs: 5000, maxResponseBytes: 64 * 1024 });
    const match = String(result.output || '').match(/HTTP\/1\.[01]\s+([0-9]{3})/i);
    return { statusCode: match ? Number.parseInt(match[1], 10) : null };
  },
  routingNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing'
});
const statelessMigrationManager = createStatelessMigrationManager({
  dataRoot: DATA_ROOT,
  getServerMigrationPlan: (planId) => migrationOrchestrator.getPlan(planId),
  compileExecutionContract: (input) => statelessMigrationManifestCompiler.compile(input),
  executionAdapter: productionStatelessMigrationAdapter,
  approvalVerifier: (input) => uiApprovalManager.verify(input)
});
const statelessMigrationReviewManager = createStatelessMigrationReviewManager({
  dataRoot: DATA_ROOT,
  getStatelessMigrationPlan: (planId) => statelessMigrationManager.getPlan(planId),
  getLatestRegistrySnapshot: () => resourceRegistry.getLatest()
});
const statefulMigrationManager = createStatefulMigrationManager({
  dataRoot: DATA_ROOT,
  getServerMigrationPlan: (planId) => migrationOrchestrator.getPlan(planId),
  compileExecutionContract: (input) => statefulMigrationManifestCompiler.compile(input),
  executionAdapter: productionStatefulMigrationAdapter,
  approvalVerifier: (input) => uiApprovalManager.verify(input)
});
const migrationRunManager = createMigrationRunManager({
  dataRoot: DATA_ROOT,
  getServerMigrationPlan: (planId) => migrationOrchestrator.getPlan(planId),
  getLatestRegistrySnapshot: () => resourceRegistry.getLatest(),
  getMigrationManagement: (resourceId) => resourceRegistry.getMigrationManagement(resourceId),
  saveSelection: (input) => migrationSelectionManager.save(input),
  prepareStatelessPlan: (input) => statelessMigrationManager.createPlan(input),
  getStatelessReviewStatus: (planId) => statelessMigrationReviewManager.status(planId),
  prepareResourceEvidence: async (resourceIds) => {
    const snapshot = resourceRegistry.getLatest();
    const captureIds = new Set();
    for (const resourceId of resourceIds) {
      const resource = snapshot && (snapshot.resources || []).find((entry) => entry.id === resourceId);
      if (!resource) throw new MigrationRunError('Selected resource disappeared before evidence capture', 409, 'resource-not-found');
      if (resource.kind !== 'container') continue;
      captureIds.add(resource.id);
      const labels = resource.provenance && resource.provenance.safeLabels || {};
      const providerResourceName = String(labels['coolify.resourceName'] || '');
      if (!providerResourceName) continue;
      for (const member of snapshot.resources || []) {
        const memberLabels = member.provenance && member.provenance.safeLabels || {};
        if (
          member.kind === 'container' &&
          String(memberLabels['coolify.resourceName'] || '') === providerResourceName
        ) captureIds.add(member.id);
      }
    }
    for (const resourceId of [...captureIds].sort()) {
      await workloadEvidenceManager.captureEnvironmentForMigration(resourceId);
    }
  },
  refreshServerMigrationPlan: () => migrationOrchestrator.createPlan({
    confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION
  }),
  reconcileCompletedMigrations: async () => {
    const snapshot = await resourceRegistry.scan();
    const plan = migrationOrchestrator.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION });
    return {
      status: 'reconciled',
      snapshotId: snapshot.snapshotId,
      serverPlanId: plan.planId
    };
  },
  prepareStatelessReview: (plan) => {
    const routes = plan.executionContract.routes || [];
    if (!routes.length) throw new MigrationRunError('No production route is available for review', 409, 'production-route-missing');
    const healthPort = plan.executionContract.candidate && plan.executionContract.candidate.health &&
      plan.executionContract.candidate.health.privatePort;
    const healthRoute = routes.find((route) => route.upstreamPrivatePort === healthPort);
    if (!healthRoute) throw new MigrationRunError('No production route exposes the reviewed health port', 409, 'production-health-route-missing');
    return statelessMigrationReviewManager.save({
      statelessPlanId: plan.planId,
      serverPlanId: plan.serverPlanId,
      resourceId: plan.resource.resourceId,
      executionContractId: plan.executionContract.contractId,
      healthRouteId: healthRoute.routeId,
      runtimeConfirmed: true,
      routes: routes.map((route) => ({
        routeId: route.routeId,
        confirmed: true,
        certificateAdapter: 'imported-certificate'
      })),
      confirmation: SAVE_STATELESS_MIGRATION_REVIEW_CONFIRMATION
    });
  },
  executeStatelessMigration: (planId, approval) => statelessMigrationManager.execute(planId, approval),
  prepareStatefulPlan: (input) => statefulMigrationManager.createPlan(input),
  prepareStatefulConfirmation: PREPARE_STATEFUL_MIGRATION_CONFIRMATION,
  executeStatefulMigration: (planId, approval) => statefulMigrationManager.execute(planId, approval),
  prepareRuntimeTransferPlan: ({ serverPlanId, resourceId, confirmation }) => (
    runtimeTransferManager.createPlan({
      serverPlan: migrationOrchestrator.getPlan(serverPlanId),
      resourceId,
      confirmation
    })
  ),
  prepareRuntimeTransferConfirmation: PREPARE_RUNTIME_TRANSFER_CONFIRMATION,
  executeRuntimeTransfer: (planId, approval) => runtimeTransferManager.execute(planId, approval),
  issueApproval: (input) => uiApprovalManager.issue(input)
});

function sendAdoptionError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof AdoptionError) ? 'Adoption operation failed' : error.message,
    code: error.code || 'adoption-error'
  });
}

function sendApplicationDomainError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof ApplicationDomainError)
      ? 'Alan adı işlemi tamamlanamadı'
      : error.message,
    code: error.code || 'application-domain-error'
  });
}

function sendApplicationComposeError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof ApplicationComposeError)
      ? 'Compose dosyası işlemi tamamlanamadı'
      : error.message,
    code: error.code || 'application-compose-error'
  });
}

function sendApplicationUpdateError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof ApplicationUpdateError)
      ? 'Güncelleme denetimi tamamlanamadı'
      : error.message,
    code: error.code || 'application-update-error'
  });
}

function sendApplicationRemovalError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof ApplicationRemovalError)
      ? 'Uygulama kaldırma işlemi tamamlanamadı'
      : error.message,
    code: error.code || 'application-removal-error'
  });
}

function sendDesktopShortcutError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof DesktopShortcutError)
      ? 'Masaüstü kısayolu kaydedilemedi'
      : error.message,
    code: error.code || 'desktop-shortcut-error'
  });
}

function sendResourceRegistryError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof ResourceRegistryError)
      ? 'Sunucu envanteri güncellenemedi.'
      : error.message,
    code: error.code || 'resource-registry-error'
  });
}

function sendConnectionError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof CloudflareConnectionError) &&
      !(error instanceof CodexConnectionError) && !(error instanceof GeminiConnectionError) &&
      !(error instanceof AntigravityConnectionError)
      ? 'Bağlantı işlemi tamamlanamadı'
      : error.message,
    code: error.code || 'connection-error'
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

function sendMigrationRunError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof MigrationRunError)
      ? 'Server migration run failed'
      : error.message,
    code: error.code || 'migration-run-error'
  });
}

function sendRuntimeTransferError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof RuntimeTransferError)
      ? 'Runtime transfer operation failed'
      : error.message,
    code: error.code || 'runtime-transfer-error'
  });
}

function sendInactiveDefinitionRuntimeError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof InactiveDefinitionRuntimeError)
      ? 'Pasif uygulama etkinleştirilemedi'
      : error.message,
    code: error.code || 'inactive-definition-runtime-error'
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

function sendStatefulMigrationError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof StatefulMigrationError)
      ? 'Stateful migration operation failed'
      : error.message,
    code: error.code || 'stateful-migration-error'
  });
}

function sendStatelessMigrationReviewError(res, error, action) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(action + ':', error.message);
  res.status(status).json({
    error: status >= 500 && !(error instanceof StatelessMigrationReviewError)
      ? 'Stateless migration review failed'
      : error.message,
    code: error.code || 'stateless-migration-review-error'
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

async function getCatalogContext() {
  const listedContainers = await dockerRequest('GET', '/containers/json?all=1');
  const containers = await containersWithConfiguredPorts(listedContainers);
  return {
    containers,
    apps: [
      ...APP_CATALOG.map((catalogApp) => stateForCatalogApp(catalogApp, containers)),
      ...discoveredAppStates(containers, APP_CATALOG)
    ]
  };
}

async function getCatalogState() {
  return (await getCatalogContext()).apps;
}

async function getApplicationInventory() {
  const context = await getCatalogContext();
  let snapshot = resourceRegistry.getLatest();
  const resourceContainerIds = new Set((snapshot && snapshot.resources || [])
    .map((resource) => resource && resource.runtime && resource.runtime.containerId)
    .filter(Boolean));
  const installedContainerIds = context.apps
    .filter((application) => application.installed && application.containerId)
    .map((application) => application.containerId);
  const managedCandidateIds = context.containers
    .filter(isManagedMigrationCandidate)
    .map((container) => container.Id);
  const projectedManagedCandidateIds = new Set((snapshot && snapshot.resources || [])
    .map((resource) => resource && resource.management && resource.management.candidateContainerId)
    .filter(Boolean));
  const managedProjectionMissing = managedCandidateIds
    .some((containerId) => !projectedManagedCandidateIds.has(containerId));

  if (
    !snapshot ||
    installedContainerIds.some((containerId) => !resourceContainerIds.has(containerId)) ||
    managedProjectionMissing
  ) {
    snapshot = await resourceRegistry.scan();
  }

  return {
    schemaVersion: APPLICATION_INVENTORY_SCHEMA_VERSION,
    snapshotId: snapshot && snapshot.snapshotId || null,
    generatedAt: snapshot && snapshot.generatedAt || null,
    applications: buildApplicationInventory({
      appStates: context.apps,
      containers: context.containers,
      resources: snapshot && snapshot.resources || [],
      domainPreferences: applicationDomainManager.primaryDomains()
    }).map((application) => {
      const inactiveCapability = application.installation &&
        application.installation.state === 'inactive-definition'
        ? inactiveDefinitionRuntimeManager.capability(application.id)
        : null;
      return {
        ...application,
        capabilities: inactiveCapability && inactiveCapability.available === true
          ? { ...application.capabilities, start: true }
          : application.capabilities,
        activation: inactiveCapability,
        desktopShortcutVisible: desktopShortcutManager.isVisible(
          application.id,
          application.desktopShortcutDefaultVisible !== false
        ),
        desktopShortcutPath: projectedDesktopShortcutLocation(application.id)
      };
    })
  };
}

function requireOwnerIngestToken(req, res, next) {
  const authorization = String(req.get('authorization') || '');
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
  if (!match || !notificationManager.authenticateIngestToken(match[1])) {
    return res.status(401).json({ error: 'Owner ingest authentication required' });
  }
  next();
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/notifications/ingest', requireOwnerIngestToken, (req, res) => {
  try {
    const notification = notificationManager.create(req.body);
    res.status(201).json({ notification });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.post('/api/notifications/ingest/resolve', requireOwnerIngestToken, (req, res) => {
  try {
    const notification = notificationManager.resolveByDedupeKey(req.body);
    res.json({ notification });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.get('/api/tasks/ingest', requireOwnerIngestToken, (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(taskManager.list({
      status: req.query.status || 'open',
      limit: req.query.limit === undefined ? 100 : Number(req.query.limit)
    }));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.post('/api/tasks/ingest', requireOwnerIngestToken, (req, res) => {
  try {
    const result = taskManager.create(req.body);
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.patch('/api/tasks/ingest/:taskId', requireOwnerIngestToken, (req, res) => {
  try {
    res.json(taskManager.update(req.params.taskId, req.body));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.post('/api/tasks/ingest/:taskId/complete', requireOwnerIngestToken, (req, res) => {
  try {
    res.json(taskManager.complete(req.params.taskId));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.post('/api/tasks/ingest/:taskId/reopen', requireOwnerIngestToken, (req, res) => {
  try {
    res.json(taskManager.reopen(req.params.taskId));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.post('/api/tasks/ingest/:taskId/snooze', requireOwnerIngestToken, (req, res) => {
  try {
    res.json(taskManager.snooze(req.params.taskId, req.body));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.get('/api/tasks/codex-review/ingest', requireOwnerIngestToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ codexReview: await codexChecklistReviewStatus() });
  } catch (error) {
    sendCodexChecklistReviewError(res, error);
  }
});

app.put('/api/tasks/codex-review/ingest', requireOwnerIngestToken, async (req, res) => {
  try {
    codexChecklistReviewManager.updateSettings(req.body || {});
    res.json({ codexReview: await codexChecklistReviewStatus() });
  } catch (error) {
    sendCodexChecklistReviewError(res, error);
  }
});

app.post('/api/tasks/codex-review/ingest/run', requireOwnerIngestToken, async (req, res) => {
  try {
    const result = await codexChecklistReviewManager.runNow();
    res.json({ result, codexReview: await codexChecklistReviewStatus() });
  } catch (error) {
    sendCodexChecklistReviewError(res, error);
  }
});

function passkeyContext(req) {
  const configuredRPID = String(process.env.FOXOS_WEBAUTHN_RP_ID || process.env.FOXOS_DOMAIN || '').trim();
  const candidateOrigin = String(req.get('origin') || `${req.protocol}://${req.get('host')}`).trim();
  let origin;
  try {
    origin = new URL(candidateOrigin);
  } catch {
    throw new SecurityError('Passkey origin is invalid', 400, 'passkey-origin-invalid');
  }
  const rpID = configuredRPID || origin.hostname;
  if (origin.hostname !== rpID && !origin.hostname.endsWith('.' + rpID)) {
    throw new SecurityError('Passkey origin is not trusted', 403, 'passkey-origin-untrusted');
  }
  return { rpID, origin: origin.origin };
}

function sendSecurityError(res, error) {
  const status = error instanceof SecurityError ? error.statusCode : 500;
  if (status >= 500 && !(error instanceof SecurityError)) {
    console.error('Security operation failed:', error.message);
  }
  res.status(status).json({
    error: status >= 500 && !(error instanceof SecurityError)
      ? 'Security operation failed'
      : error.message,
    code: error.code || 'security-operation-failed'
  });
}

function closeRevokedTerminalSessions(removed) {
  for (const item of removed || []) {
    if (!item || typeof item.tokenHash !== 'string') continue;
    for (const terminalManager of activeTerminalManagers) {
      terminalManager.closeOwnerSessions(item.tokenHash);
    }
  }
}

app.get('/api/auth/status', (req, res) => {
  const authRecord = readAuthRecord();
  const session = getSession(req);
  if (session) migrateLegacySessionCookie(res, session);
  const security = authRecord ? securityManager.status() : null;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    isSetup: Boolean(authRecord),
    authenticated: Boolean(session),
    username: session ? session.username : authRecord ? authRecord.username : null,
    onboardingRequired: Boolean(session && initialSetupRequired(authRecord)),
    localePreferences: localePreferencesForSession(authRecord, session),
    passkeyAvailable: Boolean(security && security.passkeys.length),
    recoveryAvailable: Boolean(security && security.recovery.configured),
    session: session ? {
      id: session.id,
      authMethod: session.authMethod,
      expiresAt: new Date(session.expiresAt).toISOString(),
      idleExpiresAt: new Date(session.idleExpiresAt).toISOString()
    } : null
  });
});

app.post('/api/auth/setup', async (req, res) => {
  const username = typeof (req.body && req.body.username) === 'string' ? req.body.username.trim() : '';
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const localeValidation = validateLocalePreferences(
    req.body && req.body.localePreferences,
    { defaultWhenMissing: true }
  );
  if (!username || username.length > 128) {
    return res.status(400).json({ error: 'Use a valid owner name', code: 'username-invalid' });
  }
  const validation = validateNewPassword(password, { username });
  if (!validation.ok) {
    return res.status(400).json({
      error: `Use a password of at least ${PASSWORD_MIN_LENGTH} characters`,
      code: validation.code
    });
  }
  if (!localeValidation.ok) {
    return res.status(400).json({
      error: 'Choose supported language and region settings',
      code: localeValidation.code
    });
  }
  if (readAuthRecord()) {
    return res.status(409).json({ error: 'FoxOS is already configured' });
  }

  const createdAt = new Date().toISOString();
  const passwordCredential = await createPasswordCredential(password, { now: createdAt });
  if (readAuthRecord()) {
    return res.status(409).json({ error: 'FoxOS is already configured' });
  }
  writeAuthRecord({
    version: 4,
    securitySchemaVersion: 1,
    username,
    password: passwordCredential,
    webauthnUserId: crypto.randomBytes(32).toString('base64url'),
    passkeys: [],
    recovery: { salt: null, generatedAt: null, needsRotation: false, codes: [] },
    localePreferences: createLocalePreferencesRecord(localeValidation.preferences, { now: createdAt }),
    createdAt,
    initialSetup: {
      schemaVersion: INITIAL_SETUP_SCHEMA_VERSION,
      status: 'pending',
      startedAt: createdAt
    }
  });
  const session = createSession(req, res, username, 'password');
  securityManager.recordEvent({
    type: 'owner-created',
    method: 'password',
    sessionId: session.id,
    client: summarizeAuthClient(req)
  });
  res.status(201).json({
    success: true,
    username,
    onboardingRequired: true,
    localePreferences: localeValidation.preferences
  });
});

app.post('/api/auth/login', async (req, res) => {
  const retryAfter = checkLoginRateLimit(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  const authRecord = readAuthRecord();
  if (!authRecord) {
    return res.status(400).json({ error: 'FoxOS has not been configured' });
  }

  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  const verification = await securityManager.verifyOwnerPassword(password, {
    client: summarizeAuthClient(req)
  });
  if (!verification.matched) {
    recordFailedLogin(req);
    securityManager.recordEvent({
      type: 'login-failed',
      success: false,
      method: 'password',
      client: summarizeAuthClient(req)
    });
    return res.status(401).json({ error: 'Invalid password' });
  }

  loginAttempts.delete(loginKey(req));
  const session = createSession(req, res, authRecord.username, 'password');
  securityManager.recordEvent({
    type: 'login-succeeded',
    method: 'password',
    sessionId: session.id,
    client: summarizeAuthClient(req)
  });
  res.json({
    success: true,
    username: authRecord.username,
    onboardingRequired: initialSetupRequired(authRecord),
    localePreferences: publicLocalePreferences(authRecord)
  });
});

app.post('/api/auth/passkey/options', async (req, res) => {
  const retryAfter = checkLoginRateLimit(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    res.json(await securityManager.beginPasskeyAuthentication(passkeyContext(req)));
  } catch (error) {
    sendSecurityError(res, error);
  }
});

app.post('/api/auth/passkey/verify', async (req, res) => {
  const retryAfter = checkLoginRateLimit(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const result = await securityManager.finishPasskeyAuthentication({
      ceremonyId: req.body && req.body.ceremonyId,
      response: req.body && req.body.response,
      context: passkeyContext(req),
      metadata: { client: summarizeAuthClient(req) }
    });
    loginAttempts.delete(loginKey(req));
    const session = createSession(req, res, result.username, 'passkey');
    securityManager.recordEvent({
      type: 'login-succeeded',
      method: 'passkey',
      sessionId: session.id,
      client: summarizeAuthClient(req)
    });
    const authRecord = readAuthRecord();
    res.json({
      success: true,
      username: result.username,
      onboardingRequired: initialSetupRequired(authRecord),
      localePreferences: publicLocalePreferences(authRecord)
    });
  } catch (error) {
    recordFailedLogin(req);
    securityManager.recordEvent({
      type: 'login-failed',
      success: false,
      method: 'passkey',
      client: summarizeAuthClient(req)
    });
    sendSecurityError(res, error);
  }
});

app.post('/api/auth/recovery/reset-password', async (req, res) => {
  const retryAfter = checkLoginRateLimit(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many recovery attempts. Try again later.' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const result = await securityManager.resetPasswordWithRecovery(
      req.body && req.body.code,
      req.body && req.body.newPassword,
      { client: summarizeAuthClient(req) }
    );
    loginAttempts.delete(loginKey(req));
    const removed = sessionStore.removeAll();
    closeRevokedTerminalSessions(removed);
    const session = createSession(req, res, result.username, 'recovery');
    securityManager.recordEvent({
      type: 'login-succeeded',
      method: 'recovery',
      sessionId: session.id,
      client: summarizeAuthClient(req)
    });
    const authRecord = readAuthRecord();
    res.json({
      success: true,
      username: result.username,
      onboardingRequired: initialSetupRequired(authRecord),
      localePreferences: publicLocalePreferences(authRecord),
      recoveryCodesNeedRotation: true
    });
  } catch (error) {
    recordFailedLogin(req);
    securityManager.recordEvent({
      type: 'login-failed',
      success: false,
      method: 'recovery',
      client: summarizeAuthClient(req)
    });
    sendSecurityError(res, error);
  }
});

app.post('/api/auth/maintenance-session', (req, res) => {
  if (!isLoopbackRequest(req)) return res.status(404).json({ error: 'Not found' });
  try {
    const authRecord = readAuthRecord();
    if (!authRecord) return res.status(409).json({ error: 'FoxOS has not been configured' });
    maintenanceSessionManager.consume(req.body && req.body.token);
    const session = createSession(req, res, authRecord.username, 'maintenance');
    securityManager.recordEvent({
      type: 'login-succeeded',
      method: 'maintenance',
      sessionId: session.id,
      client: summarizeAuthClient(req)
    });
    res.json({
      success: true,
      username: authRecord.username,
      localOnly: true,
      onboardingRequired: initialSetupRequired(authRecord),
      localePreferences: publicLocalePreferences(authRecord)
    });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    res.status(status).json({
      error: status >= 500 && !(error instanceof MaintenanceSessionError)
        ? 'Maintenance session failed'
        : error.message,
      code: error.code || 'maintenance-session-error'
    });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  securityManager.recordEvent({
    type: 'logout',
    method: req.session.authMethod,
    sessionId: req.session.id,
    client: summarizeAuthClient(req)
  });
  clearSession(req, res);
  res.status(204).end();
});

app.get('/oauth/calendar/:provider/callback', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    await calendarConnectionManager.completeAuthorization(req.params.provider, {
      state: req.query.state,
      code: req.query.code,
      error: req.query.error
    });
    res.status(200).type('html').send(`<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Takvim bağlandı</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#111318;color:#f8fafc;font-family:system-ui,sans-serif">
<main style="max-width:420px;padding:32px;text-align:center"><h1 style="font-size:22px">Takvim hesabı bağlandı</h1><p style="color:#a1a1aa;line-height:1.55">FoxOS Takvim artık bu hesabı gösterebilir. Bu pencereyi kapatabilirsiniz.</p></main>
</body></html>`);
  } catch (error) {
    const status = error instanceof CalendarError ? error.statusCode : 500;
    res.status(status).type('html').send(`<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Takvim bağlanamadı</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#111318;color:#f8fafc;font-family:system-ui,sans-serif">
<main style="max-width:440px;padding:32px;text-align:center"><h1 style="font-size:22px">Takvim hesabı bağlanamadı</h1><p style="color:#fca5a5;line-height:1.55">Bağlantı oturumu tamamlanmadı veya süresi doldu. Bu pencereyi kapatıp FoxOS’tan yeniden deneyin.</p></main>
</body></html>`);
  }
});

app.use('/api', requireAuth);

app.get('/api/settings/locale', (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ localePreferences: publicLocalePreferences(readAuthRecord()) });
});

app.put('/api/settings/locale', (req, res) => {
  const validation = validateLocalePreferences(req.body && req.body.localePreferences);
  if (!validation.ok) {
    return res.status(400).json({
      error: 'Choose supported language and region settings',
      code: validation.code
    });
  }
  try {
    const authRecord = readAuthRecord();
    if (!authRecord) {
      return res.status(409).json({ error: 'FoxOS has not been configured', code: 'locale-auth-missing' });
    }
    const localePreferences = createLocalePreferencesRecord(validation.preferences);
    writeAuthRecord({ ...authRecord, localePreferences });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, localePreferences: validation.preferences });
  } catch (error) {
    console.error('Could not save locale preferences:', error.message);
    res.status(500).json({ error: 'Could not save language and region settings', code: 'locale-write-failed' });
  }
});

async function verifySecurityPassword(req, res, password) {
  const retryAfter = checkLoginRateLimit(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'Too many password attempts. Try again later.',
      code: 'security-password-rate-limited'
    });
    return false;
  }
  const verification = await securityManager.verifyOwnerPassword(password, {
    client: summarizeAuthClient(req),
    sessionId: req.session.id
  });
  if (!verification.matched) {
    recordFailedLogin(req);
    securityManager.recordEvent({
      type: 'login-failed',
      success: false,
      method: 'password',
      sessionId: req.session.id,
      client: summarizeAuthClient(req)
    });
    res.status(401).json({ error: 'Current password is invalid', code: 'current-password-invalid' });
    return false;
  }
  loginAttempts.delete(loginKey(req));
  return true;
}

app.get('/api/security/overview', (req, res) => {
  const security = securityManager.status();
  const sessions = sessionStore.list(req.session.token);
  let secureTransport = false;
  try {
    secureTransport = passkeyContext(req).origin.startsWith('https://') && secureSessionCookies();
  } catch {
    // The overview stays available on the loopback maintenance path. Passkey
    // ceremonies themselves still enforce the configured HTTPS origin.
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    security,
    posture: {
      passkeyReady: security.passkeys.length > 0,
      recoveryReady: security.recovery.configured && !security.recovery.needsRotation,
      secureTransport,
      activeSessionCount: sessions.length,
      attentionRequired: !security.passkeys.length || !security.recovery.configured || security.recovery.needsRotation
    },
    passwordPolicy: {
      minimumLength: PASSWORD_MIN_LENGTH,
      maximumLength: 256,
      compositionRules: false
    },
    sessions: sessions.slice(0, 3),
    events: securityManager.listEvents(8)
  });
});

app.get('/api/security/sessions', (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ sessions: sessionStore.list(req.session.token) });
});

app.delete('/api/security/sessions/:sessionId', (req, res) => {
  if (req.params.sessionId === req.session.id) {
    return res.status(409).json({ error: 'Use logout to end the current session', code: 'current-session-revoke' });
  }
  const removed = sessionStore.removeById(req.params.sessionId);
  if (!removed.removed) {
    return res.status(404).json({ error: 'Session was not found', code: 'session-not-found' });
  }
  closeRevokedTerminalSessions([removed]);
  securityManager.recordEvent({
    type: 'session-revoked',
    method: req.session.authMethod,
    sessionId: req.session.id,
    client: summarizeAuthClient(req),
    detail: removed.session.authMethod
  });
  res.status(204).end();
});

app.post('/api/security/sessions/revoke-others', (req, res) => {
  const removed = sessionStore.removeOthers(req.session.token);
  closeRevokedTerminalSessions(removed);
  securityManager.recordEvent({
    type: 'sessions-revoked',
    method: req.session.authMethod,
    sessionId: req.session.id,
    client: summarizeAuthClient(req),
    detail: String(removed.length)
  });
  res.json({ revoked: removed.length, sessions: sessionStore.list(req.session.token) });
});

app.get('/api/security/events', (req, res) => {
  const limit = Number.parseInt(req.query.limit || '100', 10);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ events: securityManager.listEvents(limit) });
});

app.post('/api/security/passkeys/options', async (req, res) => {
  try {
    if (!await verifySecurityPassword(req, res, req.body && req.body.currentPassword)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await securityManager.beginPasskeyRegistration({
      sessionToken: req.session.token,
      name: req.body && req.body.name,
      preferredAuthenticatorType: req.body && req.body.preferredAuthenticatorType,
      context: passkeyContext(req)
    }));
  } catch (error) {
    sendSecurityError(res, error);
  }
});

app.post('/api/security/passkeys/verify', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const passkey = await securityManager.finishPasskeyRegistration({
      sessionToken: req.session.token,
      ceremonyId: req.body && req.body.ceremonyId,
      response: req.body && req.body.response,
      context: passkeyContext(req),
      metadata: {
        sessionId: req.session.id,
        client: summarizeAuthClient(req)
      }
    });
    res.status(201).json({ passkey, security: securityManager.status() });
  } catch (error) {
    sendSecurityError(res, error);
  }
});

app.patch('/api/security/passkeys/:passkeyId', async (req, res) => {
  try {
    if (!await verifySecurityPassword(req, res, req.body && req.body.currentPassword)) return;
    await securityManager.renamePasskey(req.params.passkeyId, req.body && req.body.name, {
      method: 'password',
      sessionId: req.session.id,
      client: summarizeAuthClient(req)
    });
    res.json({ security: securityManager.status() });
  } catch (error) {
    sendSecurityError(res, error);
  }
});

app.delete('/api/security/passkeys/:passkeyId', async (req, res) => {
  try {
    if (!await verifySecurityPassword(req, res, req.body && req.body.currentPassword)) return;
    await securityManager.removePasskey(req.params.passkeyId, {
      method: 'password',
      sessionId: req.session.id,
      client: summarizeAuthClient(req)
    });
    res.json({ security: securityManager.status() });
  } catch (error) {
    sendSecurityError(res, error);
  }
});

app.post('/api/security/recovery-codes', async (req, res) => {
  try {
    if (!await verifySecurityPassword(req, res, req.body && req.body.currentPassword)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    const codes = await securityManager.rotateRecoveryCodes({
      method: 'password',
      sessionId: req.session.id,
      client: summarizeAuthClient(req)
    });
    res.status(201).json({ codes, security: securityManager.status() });
  } catch (error) {
    sendSecurityError(res, error);
  }
});

app.put('/api/security/password', async (req, res) => {
  const retryAfter = checkLoginRateLimit(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many password attempts. Try again later.',
      code: 'security-password-rate-limited'
    });
  }
  try {
    await securityManager.changePassword(
      req.body && req.body.currentPassword,
      req.body && req.body.newPassword,
      {
        method: 'password',
        sessionId: req.session.id,
        client: summarizeAuthClient(req)
      }
    );
    loginAttempts.delete(loginKey(req));
    const removed = sessionStore.removeAll();
    closeRevokedTerminalSessions(removed);
    const session = createSession(req, res, req.session.username, 'password');
    res.json({
      success: true,
      session: sessionStore.list(session.token).find((item) => item.current),
      security: securityManager.status()
    });
  } catch (error) {
    if (error instanceof SecurityError && error.code === 'current-password-invalid') {
      recordFailedLogin(req);
    }
    sendSecurityError(res, error);
  }
});

app.post('/api/setup/onboarding/complete', (req, res) => {
  const resolution = req.body && req.body.resolution;
  if (!['reviewed', 'deferred'].includes(resolution)) {
    return res.status(400).json({
      error: 'Choose whether the initial server review was completed or deferred',
      code: 'initial-setup-resolution-invalid'
    });
  }
  if (!req.body || req.body.confirmation !== COMPLETE_INITIAL_SETUP_CONFIRMATION) {
    return res.status(400).json({
      error: 'Exact initial setup confirmation is required',
      code: 'initial-setup-confirmation-required'
    });
  }

  try {
    const authRecord = readAuthRecord();
    if (!authRecord) {
      return res.status(409).json({
        error: 'FoxOS has not been configured',
        code: 'initial-setup-auth-missing'
      });
    }
    if (!initialSetupRequired(authRecord)) {
      return res.json({ success: true, onboardingRequired: false, alreadyComplete: true });
    }

    let review = null;
    if (resolution === 'reviewed') {
      const snapshot = resourceRegistry.getLatest();
      const latestPlan = migrationOrchestrator.status().latest;
      const startedAtMs = Date.parse(authRecord.initialSetup.startedAt);
      const scannedAtMs = Date.parse(snapshot && snapshot.generatedAt);
      if (
        !snapshot || !latestPlan || latestPlan.sourceSnapshotId !== snapshot.snapshotId ||
        !Number.isFinite(startedAtMs) || !Number.isFinite(scannedAtMs) || scannedAtMs < startedAtMs
      ) {
        return res.status(409).json({
          error: 'Complete a fresh server scan before finishing the initial review',
          code: 'initial-setup-review-incomplete'
        });
      }
      review = {
        sourceSnapshotId: snapshot.snapshotId,
        serverPlanId: latestPlan.planId,
        scannedAt: snapshot.generatedAt
      };
    }

    const completedAt = new Date().toISOString();
    writeAuthRecord({
      ...authRecord,
      initialSetup: {
        ...authRecord.initialSetup,
        status: 'completed',
        resolution,
        completedAt,
        ...(review ? { review } : {})
      }
    });
    res.json({ success: true, onboardingRequired: false, resolution, completedAt });
  } catch (error) {
    console.error('Could not complete initial server setup:', error.message);
    res.status(500).json({
      error: 'Could not complete initial server setup',
      code: 'initial-setup-write-failed'
    });
  }
});

app.get('/api/file-content', (req, res) => {
  try {
    const requestedPath = req.query.path;
    const targetFile = resolveWorkspacePath(requestedPath);
    const stats = fs.statSync(targetFile);
    if (!stats.isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    const resolvedFile = fs.realpathSync(targetFile);
    res.sendFile(resolvedFile, (error) => {
      if (!error || res.headersSent) return;
      res.status(error.statusCode || 404).json({ error: 'File not found' });
    });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/api/file-thumbnail', async (req, res) => {
  try {
    const requestedPath = req.query.path;
    const targetFile = resolveWorkspacePath(requestedPath);
    const stats = fs.statSync(targetFile);
    if (!stats.isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    const resolvedFile = fs.realpathSync(targetFile);
    const thumbnailPath = await mediaThumbnailManager.getThumbnail(resolvedFile);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type('jpg');
    res.sendFile(thumbnailPath, { cacheControl: false }, (error) => {
      if (!error || res.headersSent) return;
      res.status(error.statusCode || 404).json({ error: 'Thumbnail not found' });
    });
  } catch (error) {
    if (error instanceof MediaThumbnailError) {
      if (error.statusCode === 503) res.setHeader('Retry-After', '2');
      return res.status(error.statusCode).json({ error: 'Thumbnail unavailable', code: error.code });
    }
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/api/file-download', (req, res) => {
  try {
    const requestedPath = req.query.path;
    const targetFile = resolveWorkspacePath(requestedPath);
    const stats = fs.statSync(targetFile);
    if (!stats.isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }
    const resolvedFile = fs.realpathSync(targetFile);
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(resolvedFile, path.basename(targetFile), (error) => {
      if (!error) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.status(error.statusCode || 404).json({ error: 'File not found' });
    });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

app.use('/api/static', express.static(DISK_ROOT, { dotfiles: 'deny', fallthrough: false }));

app.get('/api/tasks', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(taskManager.list({
      status: req.query.status || 'all',
      limit: req.query.limit === undefined ? 100 : Number(req.query.limit)
    }));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.post('/api/tasks', (req, res) => {
  try {
    const result = taskManager.create(req.body);
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.patch('/api/tasks/:taskId', (req, res) => {
  try {
    res.json(taskManager.update(req.params.taskId, req.body));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.post('/api/tasks/:taskId/complete', (req, res) => {
  try {
    res.json(taskManager.complete(req.params.taskId));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.post('/api/tasks/:taskId/reopen', (req, res) => {
  try {
    res.json(taskManager.reopen(req.params.taskId));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.post('/api/tasks/:taskId/snooze', (req, res) => {
  try {
    res.json(taskManager.snooze(req.params.taskId, req.body));
  } catch (error) {
    sendTaskError(res, error);
  }
});

app.get('/api/tasks/codex-review', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ codexReview: await codexChecklistReviewStatus() });
  } catch (error) {
    sendCodexChecklistReviewError(res, error);
  }
});

app.get('/api/tasks/codex-review/telegram-chats', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await codexChecklistReviewManager.listTelegramChats());
  } catch (error) {
    sendCodexChecklistReviewError(res, error);
  }
});

app.put('/api/tasks/codex-review', async (req, res) => {
  try {
    codexChecklistReviewManager.updateSettings(req.body || {});
    res.json({ codexReview: await codexChecklistReviewStatus() });
  } catch (error) {
    sendCodexChecklistReviewError(res, error);
  }
});

app.post('/api/tasks/codex-review/run', async (req, res) => {
  try {
    const result = await codexChecklistReviewManager.runNow();
    res.json({ result, codexReview: await codexChecklistReviewStatus() });
  } catch (error) {
    sendCodexChecklistReviewError(res, error);
  }
});

app.get('/api/notifications', (req, res) => {
  try {
    const result = notificationManager.list({
      status: req.query.status || 'all',
      limit: req.query.limit === undefined ? 50 : Number(req.query.limit),
      source: req.query.source || null
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(result);
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.post('/api/notifications', (req, res) => {
  try {
    const notification = notificationManager.create(req.body);
    res.status(201).json({ notification });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.patch('/api/notifications/:notificationId', (req, res) => {
  try {
    const notification = notificationManager.updateStatus(req.params.notificationId, req.body);
    res.json({ notification, stats: notificationManager.stats() });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.post('/api/notifications/read-all', (req, res) => {
  try {
    res.json(notificationManager.readAll());
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.get('/api/notifications/settings', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      settings: notificationManager.settings(),
      sources: notificationManager.sources(),
      push: webPushManager.status(),
      telegram: telegramNotificationManager.status(),
      codexReview: await codexChecklistReviewStatus()
    });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.put('/api/notifications/settings', async (req, res) => {
  try {
    const settings = notificationManager.updateSettings(req.body);
    res.json({
      settings,
      sources: notificationManager.sources(),
      push: webPushManager.status(),
      telegram: telegramNotificationManager.status(),
      codexReview: await codexChecklistReviewStatus()
    });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.get('/api/notifications/push', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(webPushManager.status());
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.post('/api/notifications/push/subscriptions', (req, res) => {
  try {
    const result = webPushManager.subscribe(req.body && req.body.subscription, req.get('user-agent') || '');
    res.status(201).json(result);
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.delete('/api/notifications/push/subscriptions', (req, res) => {
  try {
    res.json(webPushManager.unsubscribe(req.body && req.body.endpoint));
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.get('/api/notifications/telegram', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(telegramNotificationManager.status());
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.post('/api/notifications/telegram/configure', async (req, res) => {
  try {
    const telegram = await telegramNotificationManager.configure(req.body || {});
    res.status(201).json({ telegram });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.post('/api/notifications/telegram/pair', (req, res) => {
  try {
    res.status(201).json({ telegram: telegramNotificationManager.startPairing() });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.put('/api/notifications/telegram', (req, res) => {
  try {
    res.json({ telegram: telegramNotificationManager.setEnabled(req.body && req.body.enabled) });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.post('/api/notifications/telegram/pause', (req, res) => {
  try {
    const hours = req.body && Object.hasOwn(req.body, 'hours') ? req.body.hours : null;
    res.json({ telegram: telegramNotificationManager.pause(hours) });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.delete('/api/notifications/telegram', (req, res) => {
  try {
    res.json({ telegram: telegramNotificationManager.disconnect(req.body && req.body.confirmation) });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.post('/api/notifications/test', (req, res) => {
  try {
    const notification = notificationManager.create({
      source: 'foxos',
      category: 'test',
      severity: 'success',
      title: 'FoxOS bildirimleri hazır',
      body: 'Bu test hem Bildirim Merkezi’ne hem etkin teslimat kanallarına gönderildi.',
      target: { app: 'settings', tab: 'notifications' }
    });
    res.status(201).json({ notification });
  } catch (error) {
    sendNotificationError(res, error);
  }
});

app.get('/api/notifications/stream', (req, res) => {
  let initialStats;
  let initialTaskStats;
  try {
    initialStats = notificationManager.stats();
    initialTaskStats = taskManager.stats();
  } catch (error) {
    if (error instanceof TaskError) return sendTaskError(res, error);
    return sendNotificationError(res, error);
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'private, no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ stats: initialStats, tasks: initialTaskStats })}\n\n`);
  const writeChange = (change) => {
    try {
      res.write(`event: change\ndata: ${JSON.stringify({
        ...change,
        stats: notificationManager.stats(),
        tasks: taskManager.stats()
      })}\n\n`);
    } catch {
      // The next successful state change or reconnect will refresh the client.
    }
  };
  const removeNotificationListener = notificationManager.onChange(writeChange);
  const removeTaskListener = taskManager.onChange(writeChange);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  const close = () => {
    clearInterval(keepAlive);
    removeNotificationListener();
    removeTaskListener();
  };
  req.once('close', close);
  res.once('close', close);
});

app.get('/api/weather/locations', async (req, res) => {
  try {
    const locations = await weatherManager.searchLocations(req.query.q);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ locations });
  } catch (error) {
    sendWeatherError(res, error);
  }
});

app.put('/api/weather/location', (req, res) => {
  try {
    res.json({ location: weatherManager.saveLocation(req.body) });
  } catch (error) {
    sendWeatherError(res, error);
  }
});

app.get('/api/weather', async (req, res) => {
  try {
    const forecast = await weatherManager.forecast({ force: req.query.refresh === '1' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(forecast);
  } catch (error) {
    sendWeatherError(res, error);
  }
});

app.get('/api/calendar/events', async (req, res) => {
  try {
    const localEvents = calendarManager.list({ from: req.query.from, to: req.query.to }).map((event) => ({
      ...event,
      source: 'local',
      sourceId: null,
      provider: 'local',
      providerName: 'FoxOS',
      accountName: 'Bu sunucu',
      calendarId: 'local',
      calendarName: 'FoxOS Takvimi',
      editable: true
    }));
    const remote = await calendarConnectionManager.listEvents({
      from: req.query.from,
      to: req.query.to,
      timeZone: req.query.timeZone || 'UTC'
    });
    const events = [...localEvents, ...remote.events].sort((left, right) => (
      left.date.localeCompare(right.date) ||
      Number(right.allDay) - Number(left.allDay) ||
      String(left.startTime || '').localeCompare(String(right.startTime || '')) ||
      left.title.localeCompare(right.title, 'tr')
    ));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ events, warnings: remote.warnings });
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.post('/api/calendar/events', async (req, res) => {
  try {
    const remote = req.body && req.body.sourceId && req.body.sourceId !== 'local';
    const event = remote
      ? await calendarConnectionManager.createEvent(req.body)
      : calendarManager.create(req.body);
    res.status(201).json({ event });
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.put('/api/calendar/events/:eventId', async (req, res) => {
  try {
    const event = req.params.eventId.startsWith('rem_')
      ? await calendarConnectionManager.updateEvent(req.params.eventId, req.body)
      : calendarManager.update(req.params.eventId, req.body);
    res.json({ event });
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.delete('/api/calendar/events/:eventId', async (req, res) => {
  try {
    const result = req.params.eventId.startsWith('rem_')
      ? await calendarConnectionManager.removeEvent(req.params.eventId)
      : calendarManager.remove(req.params.eventId);
    res.json(result);
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.get('/api/calendar/sources', async (req, res) => {
  try {
    const result = await calendarConnectionManager.listSources({ refresh: req.query.refresh === '1' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(result);
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.get('/api/file-search', async (req, res) => {
  try {
    const result = await fileSearchManager.search(req.query.q, { limit: req.query.limit });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(result);
  } catch (error) {
    const status = error instanceof FileSearchError ? error.statusCode : 500;
    if (status >= 500 && !(error instanceof FileSearchError)) {
      console.error('File search failed:', error.message);
    }
    res.status(status).json({
      error: status >= 500 && !(error instanceof FileSearchError)
        ? 'Dosya araması tamamlanamadı.'
        : error.message,
      code: error.code || 'file-search-failed'
    });
  }
});

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
    fileSearchManager.invalidate();
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

    const releasedShortcutDirectory = fs.statSync(target).isDirectory()
      ? desktopShortcutPathForWorkspaceTarget(target)
      : null;
    if (target.startsWith(trashRoot + path.sep)) {
      fs.rmSync(target, { recursive: true, force: false });
    } else {
      const destination = path.join(trashRoot, Date.now() + '_' + path.basename(target));
      movePath(target, destination);
    }
    if (releasedShortcutDirectory && releasedShortcutDirectory !== DESKTOP_ROOT) {
      desktopShortcutManager.releaseDirectory(releasedShortcutDirectory);
    }
    fileSearchManager.invalidate();
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
    const targetIsDirectory = fs.statSync(target).isDirectory();
    const sourceShortcutDirectory = targetIsDirectory
      ? desktopShortcutPathForWorkspaceTarget(target)
      : null;
    const destination = path.join(path.dirname(target), name);
    if (fs.existsSync(destination)) {
      return res.status(409).json({ error: 'A file with that name already exists' });
    }
    fs.renameSync(target, destination);
    if (sourceShortcutDirectory && sourceShortcutDirectory !== DESKTOP_ROOT) {
      const destinationShortcutDirectory = desktopShortcutPathForWorkspaceTarget(destination);
      if (destinationShortcutDirectory) {
        desktopShortcutManager.relocateDirectory(sourceShortcutDirectory, destinationShortcutDirectory);
      } else {
        desktopShortcutManager.releaseDirectory(sourceShortcutDirectory);
      }
    }
    fileSearchManager.invalidate();
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

    const sourceIsDirectory = fs.statSync(source).isDirectory();
    const sourceShortcutDirectory = sourceIsDirectory
      ? desktopShortcutPathForWorkspaceTarget(source)
      : null;
    const destination = fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? path.join(target, path.basename(source))
      : target;
    if (fs.existsSync(destination)) {
      return res.status(409).json({ error: 'Destination already exists' });
    }
    movePath(source, destination);
    if (sourceShortcutDirectory && sourceShortcutDirectory !== DESKTOP_ROOT) {
      const destinationShortcutDirectory = desktopShortcutPathForWorkspaceTarget(destination);
      if (destinationShortcutDirectory) {
        desktopShortcutManager.relocateDirectory(sourceShortcutDirectory, destinationShortcutDirectory);
      } else {
        desktopShortcutManager.releaseDirectory(sourceShortcutDirectory);
      }
    }
    fileSearchManager.invalidate();
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
    fileSearchManager.invalidate();
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

app.delete('/api/inactive-definitions/:resourceId', async (req, res) => {
  try {
    const retired = resourceRegistry.retireProviderDefinition(
      req.params.resourceId,
      req.body && req.body.confirmation
    );
    desktopShortcutManager.forget(req.params.resourceId);
    let snapshot = await resourceRegistry.scan();
    if (snapshot.resources.some((resource) => resource.id === req.params.resourceId)) {
      snapshot = await resourceRegistry.scan();
    }
    if (snapshot.resources.some((resource) => resource.id === req.params.resourceId)) {
      throw new ResourceRegistryError(
        'Inactive definition retirement could not be verified',
        503,
        'inactive-definition-removal-unverified'
      );
    }
    res.json({ retired, snapshotId: snapshot.snapshotId });
  } catch (error) {
    sendResourceRegistryError(res, error, 'Could not remove inactive definition');
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

app.get('/api/migration-runs', (req, res) => {
  try {
    res.json(migrationRunManager.status());
  } catch (error) {
    sendMigrationRunError(res, error, 'Could not read server migration runs');
  }
});

app.post('/api/migration-runs', async (req, res) => {
  try {
    const run = await migrationRunManager.start(req.body || {}, {
      type: 'foxos-session',
      username: req.session.username,
      sessionToken: req.session.token
    });
    res.status(202).json({ run });
  } catch (error) {
    sendMigrationRunError(res, error, 'Could not start server migration');
  }
});

app.get('/api/migration-runs/:runId', (req, res) => {
  try {
    res.json({ run: migrationRunManager.getRun(req.params.runId) });
  } catch (error) {
    sendMigrationRunError(res, error, 'Could not read server migration run');
  }
});

app.get('/api/runtime-transfers', (req, res) => {
  try {
    res.json(runtimeTransferManager.status());
  } catch (error) {
    sendRuntimeTransferError(res, error, 'Could not read runtime transfers');
  }
});

app.get('/api/runtime-transfers/operations/:operationId', (req, res) => {
  try {
    res.json({ operation: runtimeTransferManager.getOperation(req.params.operationId) });
  } catch (error) {
    sendRuntimeTransferError(res, error, 'Could not read runtime transfer operation');
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

app.get('/api/stateless-migrations/plans/:planId/review', (req, res) => {
  try {
    res.json(statelessMigrationReviewManager.status(req.params.planId));
  } catch (error) {
    sendStatelessMigrationReviewError(res, error, 'Could not read stateless migration reviewed configuration');
  }
});

app.put('/api/stateless-migrations/plans/:planId/review', (req, res) => {
  try {
    const review = statelessMigrationReviewManager.save({
      ...(req.body || {}),
      statelessPlanId: req.params.planId
    });
    res.json({
      review,
      status: statelessMigrationReviewManager.status(req.params.planId)
    });
  } catch (error) {
    sendStatelessMigrationReviewError(res, error, 'Could not save stateless migration reviewed configuration');
  }
});

app.get('/api/stateful-migrations', (req, res) => {
  try {
    res.json(statefulMigrationManager.status());
  } catch (error) {
    sendStatefulMigrationError(res, error, 'Could not read stateful migrations');
  }
});

app.get('/api/stateful-migrations/operations/:operationId', (req, res) => {
  try {
    res.json({ operation: statefulMigrationManager.getOperation(req.params.operationId) });
  } catch (error) {
    sendStatefulMigrationError(res, error, 'Could not read stateful migration operation');
  }
});

app.post('/api/stateful-migrations/operations/:operationId/rollback', async (req, res) => {
  try {
    if (!req.body || req.body.confirmation !== 'ROLLBACK STATEFUL MIGRATION') {
      throw new StatefulMigrationError('Exact stateful rollback confirmation is required', 400, 'confirmation-required');
    }
    const operation = statefulMigrationManager.getOperation(req.params.operationId);
    const plan = statefulMigrationManager.getPlan(operation.planId);
    const approval = uiApprovalManager.issue({
      kind: 'stateful-migration-rollback',
      planId: plan.planId,
      resourceId: plan.resource.resourceId,
      evidenceFingerprint: plan.resource.evidenceFingerprint,
      actor: { type: 'foxos-session', username: req.session.username, sessionToken: req.session.token }
    });
    const rolledBack = await statefulMigrationManager.rollback(req.params.operationId, approval);
    res.json({ operation: rolledBack });
  } catch (error) {
    sendStatefulMigrationError(res, error, 'Could not roll back stateful migration');
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

app.get('/api/connections', async (req, res) => {
  try {
    const [codex, antigravity, gemini] = await Promise.all([
      codexConnectionManager.status(),
      antigravityConnectionManager.status(),
      geminiConnectionManager.status()
    ]);
    const calendar = calendarConnectionManager.status({ redirectUris: calendarRedirectUris(req) });
    res.json({ connections: [calendar, codex, antigravity, gemini, cloudflareConnectionManager.status()] });
  } catch (error) {
    sendConnectionError(res, error, 'Could not read provider connections');
  }
});

app.get('/api/cli-usage', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await cliUsageManager.status());
  } catch (error) {
    console.error('CLI usage status failed:', error.message);
    res.status(500).json({ error: 'CLI kullanım bilgisi alınamadı.', code: 'cli-usage-unavailable' });
  }
});

app.post('/api/cli-usage/refresh', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await cliUsageManager.status({ force: true }));
  } catch (error) {
    console.error('CLI usage refresh failed:', error.message);
    res.status(500).json({ error: 'CLI kullanım bilgisi yenilenemedi.', code: 'cli-usage-refresh-failed' });
  }
});

app.get('/api/connections/calendar', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ connection: calendarConnectionManager.status({ redirectUris: calendarRedirectUris(req) }) });
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.put('/api/connections/calendar/providers/:provider', (req, res) => {
  try {
    calendarConnectionManager.configureProvider(req.params.provider, req.body || {});
    res.json({ connection: calendarConnectionManager.status({ redirectUris: calendarRedirectUris(req) }) });
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.post('/api/connections/calendar/providers/:provider/authorize', (req, res) => {
  try {
    const ownerFingerprint = crypto.createHash('sha256').update(req.session.token).digest('hex');
    const authorization = calendarConnectionManager.startAuthorization(req.params.provider, {
      redirectUri: calendarRedirectUri(req, req.params.provider),
      ownerFingerprint
    });
    res.status(201).json({ authorization });
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.delete('/api/connections/calendar/accounts/:accountId', (req, res) => {
  try {
    calendarConnectionManager.disconnectAccount(
      req.params.accountId,
      req.body && req.body.confirmation
    );
    res.json({ connection: calendarConnectionManager.status({ redirectUris: calendarRedirectUris(req) }) });
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.delete('/api/connections/calendar/providers/:provider', (req, res) => {
  try {
    calendarConnectionManager.disconnectProvider(
      req.params.provider,
      req.body && req.body.confirmation
    );
    res.json({ connection: calendarConnectionManager.status({ redirectUris: calendarRedirectUris(req) }) });
  } catch (error) {
    sendCalendarError(res, error);
  }
});

app.get('/api/connections/codex', async (req, res) => {
  try {
    res.json({ connection: await codexConnectionManager.status() });
  } catch (error) {
    sendConnectionError(res, error, 'Could not read Codex connection');
  }
});

app.post('/api/connections/codex/install', async (req, res) => {
  try {
    const result = await codexConnectionManager.install(req.body && req.body.confirmation);
    try {
      installBundledCodexSkills();
    } catch (error) {
      console.error('Could not install bundled FoxOS skills:', error.message);
    }
    res.status(201).json(result);
  } catch (error) {
    sendConnectionError(res, error, 'Could not install Codex CLI');
  }
});

app.post('/api/connections/codex/login', async (req, res) => {
  try {
    res.status(201).json({ login: await codexConnectionManager.startLogin() });
  } catch (error) {
    sendConnectionError(res, error, 'Could not start Codex login');
  }
});

app.post('/api/connections/codex/login/cancel', async (req, res) => {
  try {
    res.json(await codexConnectionManager.cancelLogin(req.body && req.body.loginId));
  } catch (error) {
    sendConnectionError(res, error, 'Could not cancel Codex login');
  }
});

app.put('/api/connections/codex/access-profile', async (req, res) => {
  try {
    const connection = await codexConnectionManager.setAccessProfile(
      req.body && req.body.accessProfile,
      req.body && req.body.confirmation
    );
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not configure Codex access');
  }
});

app.put('/api/connections/codex/approval-policy', async (req, res) => {
  try {
    const connection = await codexConnectionManager.setApprovalPolicy(
      req.body && req.body.approvalPolicy
    );
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not configure Codex approval policy');
  }
});

app.put('/api/connections/codex/memory', async (req, res) => {
  try {
    const connection = await codexConnectionManager.configureMemory(req.body || {});
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not configure Codex memory');
  }
});

app.delete('/api/connections/codex', async (req, res) => {
  try {
    res.json(await codexConnectionManager.disconnect(req.body && req.body.confirmation));
  } catch (error) {
    sendConnectionError(res, error, 'Could not disconnect Codex');
  }
});

app.get('/api/connections/antigravity', async (req, res) => {
  try {
    res.json({ connection: await antigravityConnectionManager.status() });
  } catch (error) {
    sendConnectionError(res, error, 'Could not read Antigravity CLI connection');
  }
});

app.post('/api/connections/antigravity/install', async (req, res) => {
  try {
    res.status(201).json(await antigravityConnectionManager.install(req.body && req.body.confirmation));
  } catch (error) {
    sendConnectionError(res, error, 'Could not install Antigravity CLI');
  }
});

app.post('/api/connections/antigravity/login', async (req, res) => {
  try {
    res.status(201).json({ login: await antigravityConnectionManager.startLogin() });
  } catch (error) {
    sendConnectionError(res, error, 'Could not start Antigravity login');
  }
});

app.post('/api/connections/antigravity/login/complete', async (req, res) => {
  try {
    const connection = await antigravityConnectionManager.completeLogin(
      req.body && req.body.loginId,
      req.body && req.body.authorizationCode
    );
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not complete Antigravity login');
  }
});

app.post('/api/connections/antigravity/login/cancel', async (req, res) => {
  try {
    res.json(await antigravityConnectionManager.cancelLogin(req.body && req.body.loginId));
  } catch (error) {
    sendConnectionError(res, error, 'Could not cancel Antigravity login');
  }
});

app.put('/api/connections/antigravity/access-profile', async (req, res) => {
  try {
    const connection = await antigravityConnectionManager.setAccessProfile(
      req.body && req.body.accessProfile,
      req.body && req.body.confirmation
    );
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not configure Antigravity access');
  }
});

app.post('/api/connections/antigravity/verify', async (req, res) => {
  try {
    res.json({ connection: await antigravityConnectionManager.verify() });
  } catch (error) {
    sendConnectionError(res, error, 'Could not verify Antigravity connection');
  }
});

app.delete('/api/connections/antigravity', async (req, res) => {
  try {
    res.json(await antigravityConnectionManager.disconnect(req.body && req.body.confirmation));
  } catch (error) {
    sendConnectionError(res, error, 'Could not disconnect Antigravity CLI');
  }
});

app.get('/api/connections/gemini', async (req, res) => {
  try {
    res.json({ connection: await geminiConnectionManager.status() });
  } catch (error) {
    sendConnectionError(res, error, 'Could not read Gemini CLI connection');
  }
});

app.post('/api/connections/gemini/install', async (req, res) => {
  try {
    res.status(201).json(await geminiConnectionManager.install(req.body && req.body.confirmation));
  } catch (error) {
    sendConnectionError(res, error, 'Could not install Gemini CLI');
  }
});

app.put('/api/connections/gemini', async (req, res) => {
  try {
    const connection = await geminiConnectionManager.configure(req.body || {});
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not configure Gemini CLI connection');
  }
});

app.post('/api/connections/gemini/verify', async (req, res) => {
  try {
    const connection = await geminiConnectionManager.verifyStored();
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not verify Gemini CLI connection');
  }
});

app.delete('/api/connections/gemini', async (req, res) => {
  try {
    res.json(await geminiConnectionManager.disconnect(req.body && req.body.confirmation));
  } catch (error) {
    sendConnectionError(res, error, 'Could not disconnect Gemini CLI');
  }
});

app.get('/api/codex/models', async (req, res) => {
  try {
    res.json(await codexConnectionManager.listModels());
  } catch (error) {
    sendConnectionError(res, error, 'Could not read Codex models');
  }
});

app.get('/api/codex/threads', async (req, res) => {
  try {
    res.json(await codexConnectionManager.listThreads(req.query.cursor || null));
  } catch (error) {
    sendConnectionError(res, error, 'Could not read Codex threads');
  }
});

app.post('/api/codex/threads', async (req, res) => {
  try {
    res.status(201).json(await codexConnectionManager.startThread(
      req.body && req.body.model,
      req.body && req.body.reasoningEffort
    ));
  } catch (error) {
    sendConnectionError(res, error, 'Could not start Codex thread');
  }
});

app.post('/api/codex/threads/:threadId/resume', async (req, res) => {
  try {
    res.json(await codexConnectionManager.resumeThread(req.params.threadId));
  } catch (error) {
    sendConnectionError(res, error, 'Could not resume Codex thread');
  }
});

app.post('/api/codex/threads/:threadId/turns', async (req, res) => {
  try {
    res.status(201).json(await codexConnectionManager.startTurn(
      req.params.threadId,
      req.body && req.body.text
    ));
  } catch (error) {
    sendConnectionError(res, error, 'Could not start Codex turn');
  }
});

app.post('/api/codex/threads/:threadId/turns/:turnId/steer', async (req, res) => {
  try {
    res.json(await codexConnectionManager.steerTurn(
      req.params.threadId,
      req.params.turnId,
      req.body && req.body.text
    ));
  } catch (error) {
    sendConnectionError(res, error, 'Could not steer Codex turn');
  }
});

app.post('/api/codex/threads/:threadId/turns/:turnId/interrupt', async (req, res) => {
  try {
    res.json(await codexConnectionManager.interruptTurn(req.params.threadId, req.params.turnId));
  } catch (error) {
    sendConnectionError(res, error, 'Could not interrupt Codex turn');
  }
});

app.get('/api/codex/events', (req, res) => {
  try {
    res.json(codexConnectionManager.events(Number(req.query.after || 0), req.query.threadId || null));
  } catch (error) {
    sendConnectionError(res, error, 'Could not read Codex events');
  }
});

app.post('/api/codex/approvals/:requestId', (req, res) => {
  try {
    res.json(codexConnectionManager.resolveApproval(
      req.params.requestId,
      req.body && req.body.decision
    ));
  } catch (error) {
    sendConnectionError(res, error, 'Could not resolve Codex approval');
  }
});

app.put('/api/connections/cloudflare', async (req, res) => {
  try {
    const connection = await cloudflareConnectionManager.configure(req.body || {});
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not configure Cloudflare connection');
  }
});

app.post('/api/connections/cloudflare/verify', async (req, res) => {
  try {
    const connection = await cloudflareConnectionManager.verifyStored();
    res.json({ connection });
  } catch (error) {
    sendConnectionError(res, error, 'Could not verify Cloudflare connection');
  }
});

app.delete('/api/connections/cloudflare', (req, res) => {
  try {
    res.json(cloudflareConnectionManager.disconnect(req.body && req.body.confirmation));
  } catch (error) {
    sendConnectionError(res, error, 'Could not disconnect Cloudflare');
  }
});

app.get('/api/apps', async (req, res) => {
  try {
    res.json({ apps: await getCatalogState() });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.get('/api/applications', async (req, res) => {
  try {
    res.json(await getApplicationInventory());
  } catch (error) {
    console.error('Could not build the server application inventory:', error.message);
    res.status(503).json({ error: 'Sunucu uygulamaları okunamadı' });
  }
});

app.get('/api/observability/overview', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(observabilityManager.overview());
  } catch (error) {
    sendObservabilityError(res, error);
  }
});

app.post('/api/observability/refresh', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await observabilityManager.refresh());
  } catch (error) {
    sendObservabilityError(res, error);
  }
});

app.get('/api/observability/diagnostics', async (req, res) => {
  try {
    const applicationId = req.query.applicationId === undefined ? null : req.query.applicationId;
    const report = await observabilityManager.diagnostics(applicationId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Cache-Control', 'private, no-store');
    res.attachment(`foxos-redacted-diagnostics-${timestamp}.json`);
    res.type('application/json').send(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    sendObservabilityError(res, error);
  }
});

app.get('/api/applications/:applicationId/observability', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await observabilityManager.application(req.params.applicationId));
  } catch (error) {
    sendObservabilityError(res, error);
  }
});

app.get('/api/applications/:applicationId/logs', async (req, res) => {
  try {
    const tail = req.query.tail === undefined ? 200 : Number(req.query.tail);
    const level = req.query.level === undefined ? 'all' : req.query.level;
    const query = req.query.query === undefined ? '' : req.query.query;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await observabilityManager.applicationLogs(req.params.applicationId, { tail, level, query }));
  } catch (error) {
    sendObservabilityError(res, error);
  }
});

app.post('/api/applications/:applicationId/removal-plans', async (req, res) => {
  try {
    res.status(201).json({
      plan: await applicationRemovalManager.createPlan(req.params.applicationId)
    });
  } catch (error) {
    sendApplicationRemovalError(res, error, 'Could not plan application removal');
  }
});

app.post('/api/application-removal-plans/:planId/apply', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const retryAfter = checkLoginRateLimit(req);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Çok fazla hatalı şifre denemesi yapıldı. Daha sonra tekrar deneyin.',
      code: 'application-removal-password-rate-limited'
    });
  }
  const password = typeof body.password === 'string' ? body.password : '';
  const verification = await securityManager.verifyOwnerPassword(password, {
    client: summarizeAuthClient(req),
    sessionId: req.session.id
  });
  if (!verification.matched) {
    recordFailedLogin(req);
    securityManager.recordEvent({
      type: 'login-failed',
      success: false,
      method: 'password',
      sessionId: req.session.id,
      client: summarizeAuthClient(req),
      detail: 'application-removal'
    });
    return res.status(401).json({
      error: 'Şifre hatalı. Uygulama kaldırılmadı.',
      code: 'application-removal-password-invalid'
    });
  }
  loginAttempts.delete(loginKey(req));
  try {
    res.json({
      operation: await applicationRemovalManager.applyPlan(req.params.planId, {
        includeLinkedServices: body.includeLinkedServices === true,
        removeData: body.removeData === true
      })
    });
  } catch (error) {
    sendApplicationRemovalError(res, error, 'Could not remove application');
  }
});

app.put('/api/applications/:applicationId/desktop-shortcut', async (req, res) => {
  try {
    const inventory = await getApplicationInventory();
    const exists = inventory.applications.some((application) => application.id === req.params.applicationId);
    if (!exists) {
      throw new DesktopShortcutError('Uygulama artık sunucuda bulunamıyor.', 404, 'application-not-found');
    }
    res.json({ shortcut: desktopShortcutManager.setVisible(
      req.params.applicationId,
      req.body && req.body.visible
    ) });
  } catch (error) {
    sendDesktopShortcutError(res, error, 'Could not update desktop shortcut visibility');
  }
});

app.put('/api/applications/:applicationId/desktop-shortcut-location', (req, res) => {
  try {
    const shortcutPath = validatedDesktopShortcutFolder(req.body && req.body.path);
    res.json({ shortcut: desktopShortcutManager.setLocation(req.params.applicationId, shortcutPath) });
  } catch (error) {
    sendDesktopShortcutError(res, error, 'Could not update desktop shortcut location');
  }
});

app.post('/api/inactive-definitions/:resourceId/start', async (req, res) => {
  try {
    res.status(201).json({
      operation: await inactiveDefinitionRuntimeManager.activate(req.params.resourceId)
    });
  } catch (error) {
    sendInactiveDefinitionRuntimeError(res, error, 'Could not activate inactive application definition');
  }
});

app.get('/api/host-services/:resourceId/settings', (req, res) => {
  try {
    res.json({ settings: hostServiceManager.settings(req.params.resourceId) });
  } catch (error) {
    const expected = error instanceof HostServiceError;
    res.status(expected ? error.statusCode : 502).json({
      error: expected ? error.message : 'Sunucu servisi ayarları okunamadı',
      code: expected ? error.code : 'host-service-settings-failed'
    });
  }
});

app.patch('/api/host-services/:resourceId/settings', async (req, res) => {
  try {
    const result = await hostServiceManager.setBootState(
      req.params.resourceId,
      req.body && req.body.bootState
    );
    res.json(result);
  } catch (error) {
    const expected = error instanceof HostServiceError;
    res.status(expected ? error.statusCode : 502).json({
      error: expected ? error.message : 'Otomatik başlatma ayarı değiştirilemedi',
      code: expected ? error.code : 'host-service-boot-state-failed'
    });
  }
});

app.post('/api/host-services/:resourceId/:action', async (req, res) => {
  try {
    res.json(await hostServiceManager.lifecycle(req.params.resourceId, req.params.action));
  } catch (error) {
    const expected = error instanceof HostServiceError;
    res.status(expected ? error.statusCode : 502).json({
      error: expected ? error.message : 'Sunucu servisi işlemi tamamlanamadı',
      code: expected ? error.code : 'host-service-lifecycle-failed'
    });
  }
});

app.get('/api/applications/:applicationId/update-check', async (req, res) => {
  try {
    res.json({ update: await applicationUpdateChecker.check(req.params.applicationId) });
  } catch (error) {
    sendApplicationUpdateError(res, error, 'Could not check application image updates');
  }
});

app.post('/api/applications/:applicationId/update-plans', async (req, res) => {
  try {
    res.json({ plan: await applicationUpdateManager.createPlan(req.params.applicationId) });
  } catch (error) {
    sendApplicationUpdateError(res, error, 'Could not create application update plan');
  }
});

app.get('/api/applications/:applicationId/update-status', (req, res) => {
  try {
    res.json({ operation: applicationUpdateManager.current(req.params.applicationId) });
  } catch (error) {
    sendApplicationUpdateError(res, error, 'Could not read application update status');
  }
});

app.post('/api/application-update-plans/:planId/apply', async (req, res) => {
  try {
    res.json({ operation: await applicationUpdateManager.applyPlan(req.params.planId, {
      confirmation: req.body && req.body.confirmation
    }) });
  } catch (error) {
    sendApplicationUpdateError(res, error, 'Could not apply application update');
  }
});

app.get('/api/application-update-operations/:operationId', (req, res) => {
  try {
    res.json({ operation: applicationUpdateManager.getOperation(req.params.operationId) });
  } catch (error) {
    sendApplicationUpdateError(res, error, 'Could not read application update operation');
  }
});

app.post('/api/application-update-operations/:operationId/rollback', async (req, res) => {
  try {
    res.json({ operation: await applicationUpdateManager.rollbackOperation(req.params.operationId, {
      confirmation: req.body && req.body.confirmation
    }) });
  } catch (error) {
    sendApplicationUpdateError(res, error, 'Could not roll back application update');
  }
});

app.get('/api/applications/:applicationId/compose-files', async (req, res) => {
  try {
    res.json({ compose: await applicationComposeManager.describe(req.params.applicationId) });
  } catch (error) {
    sendApplicationComposeError(res, error, 'Could not read application Compose files');
  }
});

app.put('/api/applications/:applicationId/compose-files/:fileId', async (req, res) => {
  try {
    res.json({ result: await applicationComposeManager.save(
      req.params.applicationId,
      req.params.fileId,
      req.body || {}
    ) });
  } catch (error) {
    sendApplicationComposeError(res, error, 'Could not save application Compose file');
  }
});

app.get('/api/applications/:applicationId/domain', async (req, res) => {
  try {
    res.json(await applicationDomainManager.getStatus(req.params.applicationId));
  } catch (error) {
    sendApplicationDomainError(res, error, 'Could not read application domain status');
  }
});

app.post('/api/applications/:applicationId/domain/plans', async (req, res) => {
  try {
    const plan = await applicationDomainManager.createPlan(req.params.applicationId, req.body || {});
    res.status(201).json({ plan });
  } catch (error) {
    sendApplicationDomainError(res, error, 'Could not plan application domain change');
  }
});

app.post('/api/application-domain-plans/:planId/apply', async (req, res) => {
  try {
    const operation = await applicationDomainManager.applyPlan(
      req.params.planId,
      req.body && req.body.confirmation
    );
    res.status(201).json({ operation });
  } catch (error) {
    sendApplicationDomainError(res, error, 'Could not apply application domain change');
  }
});

app.post('/api/application-domain-operations/:operationId/rollback', async (req, res) => {
  try {
    const operation = await applicationDomainManager.rollbackOperation(
      req.params.operationId,
      req.body && req.body.confirmation
    );
    res.json({ operation });
  } catch (error) {
    sendApplicationDomainError(res, error, 'Could not roll back application domain change');
  }
});

app.get('/api/apps/:appId/icon', async (req, res) => {
  try {
    const inventoryState = (await getApplicationInventory()).applications
      .find((candidate) => candidate.id === req.params.appId);
    const appState = inventoryState || (await getCatalogState())
      .find((candidate) => candidate.id === req.params.appId);
    const runtimePresent = Boolean(
      appState && (appState.installed === true || appState.runtime && appState.runtime.present === true)
    );
    if (!appState || !runtimePresent || !appState.externalUrl) {
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

app.delete('/api/apps/:appId', (req, res) => {
  res.status(409).json({
    error: 'Uygulama kaldırma işlemi şifreli kaldırma planı üzerinden yapılmalıdır.',
    code: 'password-protected-application-removal-required'
  });
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
    const managed = await inactiveDefinitionRuntimeManager.manageContainer(id, action);
    if (!managed.handled) {
      await dockerRequest('POST', '/containers/' + id + '/' + action + '?t=10');
    }
    res.json({ success: true });
  } catch (error) {
    if (error instanceof InactiveDefinitionRuntimeError) {
      return sendInactiveDefinitionRuntimeError(res, error, 'Could not change managed application runtime state');
    }
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
  const shutdownAntigravityLogin = () => {
    observabilityManager.stop();
    telegramNotificationManager.stop();
    codexChecklistReviewManager.stop();
    taskManager.stop();
    for (const terminalManager of activeTerminalManagers) terminalManager.shutdown();
    antigravityLoginController.shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdownAntigravityLogin);
  process.once('SIGINT', shutdownAntigravityLogin);
  statefulMigrationManager.recoverInterruptedOperations({ clearStaleLock: true })
    .then((recovery) => {
      if (recovery.recovered.length) {
        console.warn('Recovered interrupted stateful migrations:', recovery.recovered.length);
      }
    })
    .catch((error) => {
      console.error('Initial stateful migration recovery failed:', error.message);
    })
    .then(() => statefulRehearsalManager.recoverInterruptedOperations({ clearStaleLock: true }))
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
    .then(() => ingressAuthorityManager.reconcilePublicAuthority())
    .then((result) => {
      if (result.reconciled) {
        console.log(
          'Server ingress authority reconciled on ' +
          result.backends.ipv4 + ' and ' + result.backends.ipv6
        );
      }
    })
    .catch((error) => {
      console.error('Initial server ingress reconciliation failed:', error.message);
    })
    .finally(() => {
      createFoxOSHttpServer().listen(PORT, '0.0.0.0', () => {
        console.log('FoxOS is listening on port ' + PORT);
        console.log('Host execution mode: ' + HOST_EXECUTION);
        console.log('Host filesystem mount: ' + HOST_ROOT);
        observabilityManager.start();

        inspectHostCodexCli()
          .then((inspection) => inspection.installed && installBundledCodexSkills())
          .catch((error) => console.error('Could not reconcile bundled FoxOS skills:', error.message));

        if (process.env.FOXOS_RESOURCE_SCAN_ON_STARTUP === 'false') return;
        resourceRegistry.scan()
          .then(async (snapshot) => {
            console.log(
              'Resource Registry snapshot ' + snapshot.snapshotId +
              ' recorded ' + snapshot.summary.resources + ' resources using read-only Docker, host and optional provider observations'
            );
            try {
              const inactiveIngress = await inactiveDefinitionIngressReconciler.reconcile(snapshot);
              if (inactiveIngress.reconciled) {
                console.log(
                  'Server ingress retained trusted stopped responses for ' +
                  inactiveIngress.addedDomains.length + ' inactive application domains'
                );
              }
            } catch (error) {
              console.error('Initial inactive application ingress reconciliation failed:', error.message);
            }
            if (snapshot.summary.foxosMigrated > 0) {
              const plan = migrationOrchestrator.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION });
              console.log('Server migration plan ' + plan.planId + ' reconciled from verified FoxOS migration state');
            }
          })
          .catch((error) => {
            console.error('Initial Resource Registry scan failed:', error.message);
          });
      });
    });
}

app.createHttpServer = createFoxOSHttpServer;
module.exports = app;
