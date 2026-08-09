const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeAuthorizationUrl } = require('./antigravityLoginController');

const CONFIG_SCHEMA_VERSION = 1;
const PROVIDER = 'antigravity-cli';
const READ_ONLY_PROFILE = 'read-only';
const FULL_SERVER_PROFILE = 'full-server';
const INSTALL_CONFIRMATION = 'INSTALL ANTIGRAVITY CLI ON SERVER';
const FULL_SERVER_CONFIRMATION = 'ENABLE ANTIGRAVITY FULL SERVER';
const DISCONNECT_CONFIRMATION = 'DISCONNECT ANTIGRAVITY CLI';
const MAX_SETTINGS_BYTES = 256 * 1024;

const PROFILE_SETTINGS = Object.freeze({
  [READ_ONLY_PROFILE]: Object.freeze({
    agentMode: 'plan',
    toolPermission: 'strict',
    artifactReviewPolicy: 'asks-for-review',
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    permissions: Object.freeze({ allow: Object.freeze([]), ask: Object.freeze([]), deny: Object.freeze([]) })
  }),
  [FULL_SERVER_PROFILE]: Object.freeze({
    agentMode: 'accept-edits',
    toolPermission: 'always-proceed',
    artifactReviewPolicy: 'always-proceed',
    allowNonWorkspaceAccess: true,
    enableTerminalSandbox: false,
    permissions: Object.freeze({
      allow: Object.freeze([
        'read_file(*)',
        'write_file(*)',
        'read_url(*)',
        'execute_url(*)',
        'command(*)',
        'unsandboxed(*)',
        'mcp(*)'
      ]),
      ask: Object.freeze([]),
      deny: Object.freeze([])
    })
  })
});

class AntigravityConnectionError extends Error {
  constructor(message, statusCode = 409, code = 'antigravity-connection-error') {
    super(message);
    this.name = 'AntigravityConnectionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function atomicWriteBuffer(target, value) {
  ensureDirectory(path.dirname(target));
  const temporary = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* The temporary file may not exist. */ }
    throw error;
  }
}

function atomicWriteJson(target, value) {
  atomicWriteBuffer(target, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
}

function snapshotFile(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AntigravityConnectionError(
        'Antigravity ayar dosyası güvenli bir normal dosya değil.',
        409,
        'antigravity-settings-file-unsafe'
      );
    }
    if (stat.size > MAX_SETTINGS_BYTES) {
      throw new AntigravityConnectionError(
        'Antigravity ayar dosyası beklenenden büyük.',
        409,
        'antigravity-settings-file-too-large'
      );
    }
    return { exists: true, value: fs.readFileSync(target) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, value: null };
    throw error;
  }
}

function restoreFile(target, snapshot) {
  if (snapshot.exists) {
    atomicWriteBuffer(target, snapshot.value);
    return;
  }
  try { fs.unlinkSync(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function parseJsonObject(buffer, message, code) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new AntigravityConnectionError(message, 409, code);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AntigravityConnectionError(message, 409, code);
  }
  return parsed;
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeProfile(value) {
  if (value !== READ_ONLY_PROFILE && value !== FULL_SERVER_PROFILE) {
    throw new AntigravityConnectionError(
      'Antigravity erişim profili geçersiz.',
      400,
      'antigravity-access-profile-invalid'
    );
  }
  return value;
}

function profileSettings(profile) {
  const source = PROFILE_SETTINGS[normalizeProfile(profile)];
  return {
    agentMode: source.agentMode,
    toolPermission: source.toolPermission,
    artifactReviewPolicy: source.artifactReviewPolicy,
    allowNonWorkspaceAccess: source.allowNonWorkspaceAccess,
    enableTerminalSandbox: source.enableTerminalSandbox,
    permissions: {
      allow: [...source.permissions.allow],
      ask: [...source.permissions.ask],
      deny: [...source.permissions.deny]
    }
  };
}

function profileMatches(settings, profile) {
  const expected = profileSettings(profile);
  return settings.agentMode === expected.agentMode &&
    settings.toolPermission === expected.toolPermission &&
    settings.artifactReviewPolicy === expected.artifactReviewPolicy &&
    settings.allowNonWorkspaceAccess === expected.allowNonWorkspaceAccess &&
    settings.enableTerminalSandbox === expected.enableTerminalSandbox &&
    JSON.stringify(settings.permissions) === JSON.stringify(expected.permissions);
}

function createAntigravityConnectionManager({
  dataRoot,
  settingsFile,
  inspectCli,
  installCli,
  inspectAccount,
  loginController,
  logoutAccount,
  clock = () => new Date()
}) {
  if (
    !dataRoot || !settingsFile || typeof inspectCli !== 'function' ||
    typeof installCli !== 'function' || typeof inspectAccount !== 'function' ||
    !loginController || typeof loginController.start !== 'function' ||
    typeof loginController.complete !== 'function' || typeof loginController.cancel !== 'function' ||
    typeof logoutAccount !== 'function'
  ) {
    throw new Error('Antigravity connection manager requires data, settings and host runtime adapters');
  }

  const root = path.join(dataRoot, 'connections', PROVIDER);
  const configFile = path.join(root, 'config.json');
  let mutation = Promise.resolve();

  function serialize(operation) {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => {});
    return next;
  }

  function now() {
    return new Date(clock()).toISOString();
  }

  function loadConfig() {
    let buffer;
    try {
      const snapshot = snapshotFile(configFile);
      if (!snapshot.exists) return null;
      buffer = snapshot.value;
    } catch (error) {
      if (error instanceof AntigravityConnectionError) {
        throw new AntigravityConnectionError(
          'Antigravity bağlantı kaydı güvenli bir normal dosya değil.',
          409,
          'antigravity-config-file-unsafe'
        );
      }
      throw error;
    }
    const config = parseJsonObject(
      buffer,
      'Antigravity bağlantı kaydı desteklenmiyor.',
      'antigravity-config-invalid'
    );
    if (
      config.schemaVersion !== CONFIG_SCHEMA_VERSION || config.provider !== PROVIDER ||
      !/^agyrev_[a-f0-9]{32}$/.test(String(config.revision || '')) ||
      !Object.hasOwn(PROFILE_SETTINGS, config.accessProfile) ||
      typeof config.accountConnected !== 'boolean' ||
      (config.authMethod !== null && config.authMethod !== 'google-oauth') ||
      config.authMethod !== (config.accountConnected ? 'google-oauth' : null) ||
      !validIsoTimestamp(config.configuredAt) || !validIsoTimestamp(config.updatedAt) ||
      (config.lastVerifiedAt !== null && !validIsoTimestamp(config.lastVerifiedAt))
    ) {
      throw new AntigravityConnectionError(
        'Antigravity bağlantı kaydı desteklenmiyor.',
        409,
        'antigravity-config-invalid'
      );
    }
    return config;
  }

  function readSettings() {
    const snapshot = snapshotFile(settingsFile);
    if (!snapshot.exists) return {};
    return parseJsonObject(
      snapshot.value,
      'Antigravity ayar dosyası geçersiz JSON içeriyor.',
      'antigravity-settings-invalid'
    );
  }

  function configFor(previous, { accessProfile, accountConnected, verified = false }) {
    const timestamp = now();
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      provider: PROVIDER,
      revision: 'agyrev_' + crypto.randomBytes(16).toString('hex'),
      accessProfile,
      accountConnected,
      authMethod: accountConnected ? 'google-oauth' : null,
      configuredAt: previous ? previous.configuredAt : timestamp,
      updatedAt: timestamp,
      lastVerifiedAt: verified ? timestamp : previous ? previous.lastVerifiedAt : null
    };
  }

  function writeProfileAndConfig(profile, config) {
    const settingsSnapshot = snapshotFile(settingsFile);
    const configSnapshot = snapshotFile(configFile);
    const existing = settingsSnapshot.exists
      ? parseJsonObject(
        settingsSnapshot.value,
        'Antigravity ayar dosyası geçersiz JSON içeriyor.',
        'antigravity-settings-invalid'
      )
      : {};
    const nextSettings = { ...existing, ...profileSettings(profile) };
    try {
      atomicWriteJson(settingsFile, nextSettings);
      atomicWriteJson(configFile, config);
    } catch (error) {
      try { restoreFile(settingsFile, settingsSnapshot); } catch { /* Preserve the primary failure. */ }
      try { restoreFile(configFile, configSnapshot); } catch { /* Preserve the primary failure. */ }
      if (error instanceof AntigravityConnectionError) throw error;
      throw new AntigravityConnectionError(
        'Antigravity erişim profili güvenli biçimde kaydedilemedi.',
        500,
        'antigravity-profile-write-failed'
      );
    }
  }

  async function inspectCliSafe() {
    try {
      const cli = await inspectCli();
      return cli && cli.installed === true
        ? { installed: true, version: cli.version || null }
        : { installed: false, version: null };
    } catch {
      return { installed: false, version: null };
    }
  }

  async function requireCli() {
    const cli = await inspectCliSafe();
    if (!cli.installed) {
      throw new AntigravityConnectionError(
        'Önce Antigravity CLI kurulmalı.',
        409,
        'antigravity-cli-not-installed'
      );
    }
    return cli;
  }

  async function inspectAccountChecked(message, code) {
    try {
      return await inspectAccount();
    } catch (error) {
      if (error instanceof AntigravityConnectionError) throw error;
      throw new AntigravityConnectionError(message, 502, code);
    }
  }

  function publicStatus(config, cli, settings) {
    const profile = config ? config.accessProfile : READ_ONLY_PROFILE;
    const connected = Boolean(config && config.accountConnected);
    const applied = profileMatches(settings, profile);
    const fullServer = profile === FULL_SERVER_PROFILE;
    const expected = profileSettings(profile);
    return {
      id: PROVIDER,
      name: 'Antigravity CLI',
      optional: true,
      installed: cli.installed,
      runtimeReady: cli.installed,
      version: cli.installed ? cli.version : null,
      connected,
      ready: cli.installed && connected && applied,
      authMethod: connected ? 'google-oauth' : null,
      configuredAt: config ? config.configuredAt : null,
      lastVerifiedAt: config ? config.lastVerifiedAt : null,
      accessProfile: profile,
      fullServer,
      rootEquivalent: fullServer,
      workingDirectory: '/',
      approvalPolicy: fullServer ? 'never' : 'strict',
      agentMode: expected.agentMode,
      artifactReviewPolicy: expected.artifactReviewPolicy,
      terminalSandbox: expected.enableTerminalSandbox,
      allowNonWorkspaceAccess: expected.allowNonWorkspaceAccess,
      profileApplied: applied,
      credentialsManagedByAntigravity: true,
      credentialIncluded: false,
      oauthAuthorizationUrlIncluded: false,
      accountVerificationConsumesQuota: false,
      executionSurface: 'cli-only'
    };
  }

  async function currentStatus(config = loadConfig(), cli = null) {
    const inspectedCli = cli || await inspectCliSafe();
    return publicStatus(config, inspectedCli, readSettings());
  }

  async function status() {
    return currentStatus();
  }

  async function install(confirmation) {
    return serialize(async () => {
      if (confirmation !== INSTALL_CONFIRMATION) {
        throw new AntigravityConnectionError(
          'Antigravity CLI kurulumu için tam onay gerekli.',
          400,
          'antigravity-install-confirmation-required'
        );
      }
      try {
        await installCli();
      } catch (error) {
        if (error instanceof AntigravityConnectionError) throw error;
        throw new AntigravityConnectionError(
          'Antigravity CLI sunucuya kurulamadı. Sunucu ağını ve resmi kurulum hizmetini kontrol edin.',
          503,
          'antigravity-cli-install-failed'
        );
      }
      const cli = await inspectCliSafe();
      if (!cli.installed) {
        throw new AntigravityConnectionError(
          'Antigravity CLI kurulumu tamamlandı ancak çalıştırılabilir dosya doğrulanamadı.',
          503,
          'antigravity-cli-install-unverified'
        );
      }
      const previous = loadConfig();
      const profile = previous ? previous.accessProfile : READ_ONLY_PROFILE;
      const config = configFor(previous, {
        accessProfile: profile,
        accountConnected: previous ? previous.accountConnected : false
      });
      writeProfileAndConfig(profile, config);
      return { connection: await currentStatus(config, cli), version: cli.version };
    });
  }

  async function startLogin() {
    return serialize(async () => {
      await requireCli();
      let login;
      try {
        login = await loginController.start();
      } catch (error) {
        if (error && Number.isInteger(error.statusCode)) throw error;
        throw new AntigravityConnectionError(
          'Antigravity Google giriş işlemi başlatılamadı.',
          502,
          'antigravity-login-start-failed'
        );
      }
      if (
        !login || !/^agylogin_[a-f0-9]{32}$/.test(String(login.loginId || '')) ||
        typeof login.verificationUrl !== 'string' ||
        !normalizeAuthorizationUrl(login.verificationUrl) ||
        !validIsoTimestamp(login.expiresAt)
      ) {
        await loginController.cancel(login && login.loginId || null).catch(() => {});
        throw new AntigravityConnectionError(
          'Antigravity Google giriş yanıtı güvenli biçimde doğrulanamadı.',
          502,
          'antigravity-login-response-invalid'
        );
      }
      return login;
    });
  }

  async function completeLogin(loginId, authorizationCode) {
    return serialize(async () => {
      const cli = await requireCli();
      try {
        await loginController.complete(loginId, authorizationCode);
      } catch (error) {
        if (error && Number.isInteger(error.statusCode)) throw error;
        throw new AntigravityConnectionError(
          'Antigravity Google hesabı doğrulanamadı.',
          409,
          'antigravity-login-failed'
        );
      }
      const account = await inspectAccountChecked(
        'Antigravity oturumu yeni bir işlemde doğrulanamadı.',
        'antigravity-account-persistence-check-failed'
      );
      if (!account || account.connected !== true) {
        throw new AntigravityConnectionError(
          'Google girişi tamamlandı ancak Antigravity oturumu yeni bir işlemde doğrulanamadı.',
          409,
          'antigravity-account-persistence-unverified'
        );
      }
      const previous = loadConfig();
      const profile = previous ? previous.accessProfile : READ_ONLY_PROFILE;
      const config = configFor(previous, { accessProfile: profile, accountConnected: true, verified: true });
      writeProfileAndConfig(profile, config);
      return currentStatus(config, cli);
    });
  }

  async function cancelLogin(loginId = null) {
    return loginController.cancel(loginId);
  }

  async function verify() {
    return serialize(async () => {
      const cli = await requireCli();
      const account = await inspectAccountChecked(
        'Antigravity hesabı doğrulanamadı.',
        'antigravity-account-verification-failed'
      );
      const previous = loadConfig();
      const profile = previous ? previous.accessProfile : READ_ONLY_PROFILE;
      const connected = Boolean(account && account.connected === true);
      const nextProfile = connected ? profile : READ_ONLY_PROFILE;
      const config = configFor(previous, {
        accessProfile: nextProfile,
        accountConnected: connected,
        verified: true
      });
      writeProfileAndConfig(nextProfile, config);
      return currentStatus(config, cli);
    });
  }

  async function setAccessProfile(accessProfile, confirmation = null) {
    return serialize(async () => {
      const profile = normalizeProfile(accessProfile);
      if (profile === READ_ONLY_PROFILE) {
        const previous = loadConfig();
        const config = configFor(previous, {
          accessProfile: READ_ONLY_PROFILE,
          accountConnected: previous ? previous.accountConnected : false
        });
        writeProfileAndConfig(READ_ONLY_PROFILE, config);
        return currentStatus(config);
      }
      const cli = await requireCli();
      if (confirmation !== FULL_SERVER_CONFIRMATION) {
        throw new AntigravityConnectionError(
          'Antigravity Full Server için tam onay gerekli.',
          400,
          'antigravity-full-server-confirmation-required'
        );
      }
      const account = await inspectAccountChecked(
        'Antigravity hesabı Full Server öncesinde doğrulanamadı.',
        'antigravity-account-verification-failed'
      );
      if (!account || account.connected !== true) {
        throw new AntigravityConnectionError(
          'Antigravity erişim profilini değiştirmeden önce Google hesabını bağlayın.',
          409,
          'antigravity-account-not-connected'
        );
      }
      const previous = loadConfig();
      const config = configFor(previous, { accessProfile: profile, accountConnected: true, verified: true });
      writeProfileAndConfig(profile, config);
      return currentStatus(config, cli);
    });
  }

  async function disconnect(confirmation) {
    return serialize(async () => {
      if (confirmation !== DISCONNECT_CONFIRMATION) {
        throw new AntigravityConnectionError(
          'Antigravity bağlantısını kesmek için tam onay gerekli.',
          400,
          'antigravity-disconnect-confirmation-required'
        );
      }
      await loginController.cancel().catch(() => {});
      const previous = loadConfig();
      const cli = await inspectCliSafe();
      const protectedConfig = configFor(previous, {
        accessProfile: READ_ONLY_PROFILE,
        accountConnected: previous ? previous.accountConnected : false
      });
      writeProfileAndConfig(READ_ONLY_PROFILE, protectedConfig);
      if (!cli.installed && previous && previous.accountConnected) {
        throw new AntigravityConnectionError(
          'Full Server kapatıldı ancak Antigravity CLI çalıştırılamadığı için bağlı Google oturumundan çıkılamadı.',
          409,
          'antigravity-cli-required-for-disconnect'
        );
      }
      if (cli.installed) {
        try {
          await logoutAccount();
        } catch (error) {
          if (error instanceof AntigravityConnectionError) throw error;
          throw new AntigravityConnectionError(
            'Antigravity hesabından çıkış tamamlanamadı.',
            409,
            'antigravity-logout-failed'
          );
        }
        const account = await inspectAccountChecked(
          'Antigravity çıkış sonucu doğrulanamadı; bağlantı kaydı korunuyor.',
          'antigravity-logout-verification-failed'
        );
        if (account && account.connected === true) {
          throw new AntigravityConnectionError(
            'Antigravity hesabı hâlâ bağlı görünüyor; bağlantı kaydı korunuyor.',
            409,
            'antigravity-logout-unverified'
          );
        }
      }
      const config = configFor(previous, {
        accessProfile: READ_ONLY_PROFILE,
        accountConnected: false,
        verified: cli.installed
      });
      writeProfileAndConfig(READ_ONLY_PROFILE, config);
      return {
        accountDisconnected: true,
        cliPreserved: true,
        connection: await currentStatus(config, cli)
      };
    });
  }

  return {
    cancelLogin,
    completeLogin,
    disconnect,
    install,
    setAccessProfile,
    startLogin,
    status,
    verify
  };
}

module.exports = {
  AntigravityConnectionError,
  DISCONNECT_CONFIRMATION,
  FULL_SERVER_CONFIRMATION,
  FULL_SERVER_PROFILE,
  INSTALL_CONFIRMATION,
  READ_ONLY_PROFILE,
  createAntigravityConnectionManager,
  profileSettings
};
