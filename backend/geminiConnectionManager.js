const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const CONFIG_SCHEMA_VERSION = 1;
const PROVIDER = 'gemini-cli';
const INSTALL_CONFIRMATION = 'INSTALL GEMINI CLI ON SERVER';
const DISCONNECT_CONFIRMATION = 'DISCONNECT GEMINI CLI';
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;

class GeminiConnectionError extends Error {
  constructor(message, statusCode = 409, code = 'gemini-connection-error') {
    super(message);
    this.name = 'GeminiConnectionError';
    this.statusCode = statusCode;
    this.code = code;
  }
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

function removeFileIfPresent(target) {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateApiKey(value) {
  const apiKey = String(value || '').trim();
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new GeminiConnectionError(
      'Geçerli bir Gemini API anahtarı girin.',
      400,
      'gemini-api-key-invalid'
    );
  }
  return apiKey;
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function createGeminiConnectionManager({
  dataRoot,
  encryptionStore,
  inspectCli,
  installCli,
  verifyCredential,
  clock = () => new Date()
}) {
  if (
    !dataRoot || !encryptionStore || typeof inspectCli !== 'function' ||
    typeof installCli !== 'function' || typeof verifyCredential !== 'function'
  ) {
    throw new Error('Gemini connection manager requires data, encryption and host runtime adapters');
  }

  const root = path.join(dataRoot, 'connections', PROVIDER);
  const configFile = path.join(root, 'config.json');
  const credentialsFile = path.join(root, 'api-key.foxosenc');
  const credentialsContext = {
    purpose: 'foxos-provider-connection',
    schemaVersion: CONFIG_SCHEMA_VERSION,
    provider: PROVIDER
  };

  function now() {
    return new Date(clock()).toISOString();
  }

  function credentialsAvailable() {
    try {
      const stat = fs.statSync(credentialsFile);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  function loadConfig() {
    const config = readJson(configFile, null);
    if (!config) return null;
    if (
      config.schemaVersion !== CONFIG_SCHEMA_VERSION || config.provider !== PROVIDER ||
      config.authMethod !== 'api-key' || typeof config.revision !== 'string' ||
      typeof config.apiKeyFingerprint !== 'string' || !validIsoTimestamp(config.configuredAt) ||
      !validIsoTimestamp(config.lastVerifiedAt)
    ) {
      throw new GeminiConnectionError(
        'Gemini CLI bağlantı kaydı desteklenmiyor.',
        409,
        'gemini-config-invalid'
      );
    }
    return config;
  }

  function assertRecordPair(config) {
    const available = credentialsAvailable();
    if (Boolean(config) !== available) {
      throw new GeminiConnectionError(
        'Gemini CLI bağlantı kaydı ile şifreli anahtar eşleşmiyor.',
        409,
        'gemini-credential-record-mismatch'
      );
    }
    return available;
  }

  function loadApiKey(config = loadConfig()) {
    if (!config || !assertRecordPair(config)) {
      throw new GeminiConnectionError('Gemini CLI bağlı değil.', 409, 'gemini-not-connected');
    }
    try {
      const apiKey = validateApiKey(encryptionStore.decryptBuffer(
        fs.readFileSync(credentialsFile),
        credentialsContext
      ).toString('utf8'));
      if (encryptionStore.fingerprint(apiKey) !== config.apiKeyFingerprint) {
        throw new GeminiConnectionError(
          'Gemini CLI bağlantı kaydı ile şifreli anahtar eşleşmiyor.',
          409,
          'gemini-credential-revision-mismatch'
        );
      }
      return apiKey;
    } catch (error) {
      if (error instanceof GeminiConnectionError) throw error;
      throw new GeminiConnectionError(
        'Gemini API anahtarının şifresi çözülemedi.',
        409,
        'gemini-credential-unavailable'
      );
    }
  }

  function publicStatus(config, cli) {
    const connected = Boolean(config && credentialsAvailable());
    return {
      id: PROVIDER,
      name: 'Gemini CLI',
      optional: true,
      installed: cli.installed === true,
      runtimeReady: cli.installed === true,
      version: cli.installed ? cli.version || null : null,
      connected,
      ready: connected && cli.installed === true,
      authMethod: connected ? 'api-key' : null,
      configuredAt: config ? config.configuredAt : null,
      lastVerifiedAt: config ? config.lastVerifiedAt : null,
      apiKeyStoredEncrypted: connected,
      credentialIncluded: false,
      consumerGoogleLoginSupported: false,
      executionAccess: 'not-enabled'
    };
  }

  async function inspectStatus(config = loadConfig()) {
    assertRecordPair(config);
    if (config) loadApiKey(config);
    let cli;
    try {
      cli = await inspectCli();
    } catch {
      cli = { installed: false, version: null };
    }
    return publicStatus(config, cli || { installed: false, version: null });
  }

  async function status() {
    return inspectStatus();
  }

  async function install(confirmation) {
    if (confirmation !== INSTALL_CONFIRMATION) {
      throw new GeminiConnectionError(
        'Gemini CLI kurulumu için tam onay gerekli.',
        400,
        'gemini-install-confirmation-required'
      );
    }
    try {
      await installCli();
    } catch (error) {
      if (error instanceof GeminiConnectionError) throw error;
      throw new GeminiConnectionError(
        'Gemini CLI sunucuya kurulamadı. Node.js 20+, npm ve sunucu ağını kontrol edin.',
        503,
        'gemini-cli-install-failed'
      );
    }
    const cli = await inspectCli();
    if (!cli || cli.installed !== true) {
      throw new GeminiConnectionError(
        'Gemini CLI kurulumu tamamlandı ancak çalıştırılabilir dosya doğrulanamadı.',
        503,
        'gemini-cli-install-unverified'
      );
    }
    const config = loadConfig();
    assertRecordPair(config);
    return {
      connection: publicStatus(config, cli),
      version: cli.version || null
    };
  }

  async function verifyApiKey(apiKey) {
    let result;
    try {
      result = await verifyCredential(apiKey);
    } catch (error) {
      if (error instanceof GeminiConnectionError) throw error;
      throw new GeminiConnectionError(
        'Gemini API anahtarı CLI tarafından doğrulanamadı.',
        409,
        'gemini-api-key-verification-failed'
      );
    }
    if (!result || result.verified !== true) {
      throw new GeminiConnectionError(
        'Gemini API anahtarı CLI tarafından doğrulanamadı.',
        409,
        'gemini-api-key-verification-failed'
      );
    }
  }

  async function configure(input = {}) {
    const apiKey = validateApiKey(input.apiKey);
    const cli = await inspectCli();
    if (!cli || cli.installed !== true) {
      throw new GeminiConnectionError(
        'Önce Gemini CLI’yi sunucuya kurun.',
        409,
        'gemini-cli-not-installed'
      );
    }
    await verifyApiKey(apiKey);

    const configuredAt = now();
    const config = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      provider: PROVIDER,
      revision: 'gmrev_' + crypto.randomBytes(16).toString('hex'),
      authMethod: 'api-key',
      apiKeyFingerprint: encryptionStore.fingerprint(apiKey),
      configuredAt,
      lastVerifiedAt: configuredAt,
      credentialIncluded: false,
      apiKeyStoredEncrypted: true
    };
    ensureDirectory(root);
    const previousCredentials = credentialsAvailable() ? fs.readFileSync(credentialsFile) : null;
    const previousConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile) : null;
    try {
      encryptionStore.atomicWriteBuffer(
        credentialsFile,
        encryptionStore.encryptBuffer(Buffer.from(apiKey, 'utf8'), credentialsContext)
      );
      atomicWriteJson(configFile, config);
    } catch (error) {
      try {
        if (previousCredentials) encryptionStore.atomicWriteBuffer(credentialsFile, previousCredentials);
        else removeFileIfPresent(credentialsFile);
        if (previousConfig) encryptionStore.atomicWriteBuffer(configFile, previousConfig);
        else removeFileIfPresent(configFile);
      } catch (restoreError) {
        throw new GeminiConnectionError(
          `Gemini CLI bağlantısı kaydedilemedi ve önceki kayıt geri yüklenemedi: ${restoreError.message}`,
          503,
          'gemini-config-rollback-attention-required'
        );
      }
      throw error;
    }
    return publicStatus(config, cli);
  }

  async function verifyStored() {
    const config = loadConfig();
    const apiKey = loadApiKey(config);
    const cli = await inspectCli();
    if (!cli || cli.installed !== true) {
      throw new GeminiConnectionError(
        'Gemini CLI bu sunucuda kurulu değil.',
        409,
        'gemini-cli-not-installed'
      );
    }
    await verifyApiKey(apiKey);
    const updated = { ...config, lastVerifiedAt: now() };
    atomicWriteJson(configFile, updated);
    return publicStatus(updated, cli);
  }

  async function disconnect(confirmation) {
    if (confirmation !== DISCONNECT_CONFIRMATION) {
      throw new GeminiConnectionError(
        'Gemini CLI bağlantısını kesme onayı geçersiz.',
        400,
        'gemini-disconnect-confirmation-invalid'
      );
    }
    const credentialRemoved = removeFileIfPresent(credentialsFile);
    const configRemoved = removeFileIfPresent(configFile);
    return {
      credentialRemoved,
      configRemoved,
      cliPreserved: true,
      connection: await inspectStatus(null)
    };
  }

  return {
    configure,
    disconnect,
    install,
    status,
    verifyStored
  };
}

module.exports = {
  DISCONNECT_CONFIRMATION,
  GeminiConnectionError,
  INSTALL_CONFIRMATION,
  createGeminiConnectionManager,
  validateApiKey
};
