const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const COOLIFY_READER_SCHEMA_VERSION = 1;
const PROVIDER = 'coolify';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const TOKEN_PATTERN = /^\S{20,2048}$/;

class CoolifyMigrationReaderError extends Error {
  constructor(message, statusCode = 409, code = 'coolify-reader-error') {
    super(message);
    this.name = 'CoolifyMigrationReaderError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new CoolifyMigrationReaderError('Coolify API address is invalid', 400, 'coolify-url-invalid');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) {
    throw new CoolifyMigrationReaderError('Coolify API address is invalid', 400, 'coolify-url-invalid');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (parsed.pathname.endsWith('/api/v1')) parsed.pathname = parsed.pathname.slice(0, -7);
  return parsed.toString().replace(/\/$/, '');
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new CoolifyMigrationReaderError('Coolify API token is invalid', 400, 'coolify-token-invalid');
  }
  return token;
}

function safeText(value, maximum = 256) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maximum) : null;
}

function safeFqdns(value) {
  return Array.from(new Set(String(value || '').split(',').map((entry) => entry.trim()).filter((entry) => {
    try {
      const parsed = new URL(entry);
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }).map((entry) => {
    const parsed = new URL(entry);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  }))).sort();
}

function normalizeStatus(value) {
  return safeText(value, 96) || 'unknown';
}

function projectApplication(row) {
  return {
    sourceKind: 'provider-definition',
    provider: PROVIDER,
    externalId: safeText(row.uuid, 128),
    name: safeText(row.name) || safeText(row.git_repository) || 'Coolify application',
    providerKind: 'application',
    status: normalizeStatus(row.status),
    serviceType: safeText(row.build_pack, 96),
    image: safeText(row.docker_registry_image_name, 512),
    source: {
      type: row.git_repository ? 'git' : row.docker_registry_image_name ? 'image' : 'provider-definition',
      repository: safeText(row.git_repository, 512),
      branch: safeText(row.git_branch, 256),
      commit: /^[a-f0-9]{7,64}$/i.test(String(row.git_commit_sha || '')) ? String(row.git_commit_sha) : null,
      buildPack: safeText(row.build_pack, 96),
      composeParsingVersion: safeText(row.compose_parsing_version, 96)
    },
    routes: safeFqdns(row.fqdn),
    observedUpdatedAt: safeText(row.updated_at, 64)
  };
}

function projectService(row) {
  return {
    sourceKind: 'provider-definition',
    provider: PROVIDER,
    externalId: safeText(row.uuid, 128),
    name: safeText(row.name) || safeText(row.service_type) || 'Coolify service',
    providerKind: 'service',
    status: normalizeStatus(row.status),
    serviceType: safeText(row.service_type, 128),
    source: {
      type: 'compose-service',
      composeParsingVersion: safeText(row.compose_parsing_version, 96)
    },
    routes: [],
    observedUpdatedAt: safeText(row.updated_at, 64)
  };
}

function projectDatabase(row) {
  return {
    sourceKind: 'provider-definition',
    provider: PROVIDER,
    externalId: safeText(row.uuid, 128),
    name: safeText(row.name) || safeText(row.database_type) || 'Coolify database',
    providerKind: 'database',
    status: normalizeStatus(row.status),
    serviceType: safeText(row.database_type, 128),
    image: safeText(row.image, 512),
    source: { type: 'database-image' },
    routes: [],
    observedUpdatedAt: safeText(row.updated_at, 64)
  };
}

async function defaultApiRequest({ baseUrl, token, endpoint }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/${endpoint}`, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal
    });
  } catch (error) {
    throw new CoolifyMigrationReaderError(
      error.name === 'AbortError' ? 'Coolify inventory request timed out' : 'Coolify inventory is unavailable',
      503,
      'coolify-reader-unavailable'
    );
  } finally {
    clearTimeout(timeout);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new CoolifyMigrationReaderError('Coolify inventory response is too large', 502, 'coolify-response-too-large');
  }
  if (!response.ok) {
    throw new CoolifyMigrationReaderError(
      [401, 403].includes(response.status) ? 'Coolify read access was rejected' : 'Coolify inventory request failed',
      [401, 403].includes(response.status) ? 409 : 502,
      [401, 403].includes(response.status) ? 'coolify-read-permission-required' : 'coolify-api-error'
    );
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new CoolifyMigrationReaderError('Coolify inventory response is too large', 502, 'coolify-response-too-large');
  }
  try {
    const payload = JSON.parse(body);
    return Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [];
  } catch {
    throw new CoolifyMigrationReaderError('Coolify inventory response is invalid', 502, 'coolify-response-invalid');
  }
}

function createCoolifyMigrationReader({
  dataRoot,
  encryptionStore,
  apiRequest = defaultApiRequest,
  clock = () => new Date()
}) {
  if (!dataRoot || !encryptionStore || typeof apiRequest !== 'function') {
    throw new Error('Coolify migration reader requires data, encryption and API adapters');
  }
  const root = path.join(dataRoot, 'connections', 'coolify-reader');
  const configFile = path.join(root, 'config.json');
  const tokenFile = path.join(root, 'token.foxosenc');
  const encryptionContext = {
    purpose: 'foxos-optional-migration-reader',
    provider: PROVIDER,
    schemaVersion: COOLIFY_READER_SCHEMA_VERSION
  };

  function readConfig() {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (
        config.schemaVersion !== COOLIFY_READER_SCHEMA_VERSION || config.provider !== PROVIDER ||
        normalizeBaseUrl(config.baseUrl) !== config.baseUrl || typeof config.tokenFingerprint !== 'string'
      ) throw new Error('invalid');
      return config;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new CoolifyMigrationReaderError('Coolify reader configuration is invalid', 409, 'coolify-reader-config-invalid');
    }
  }

  function loadToken(config) {
    try {
      const token = validateToken(encryptionStore.decryptBuffer(
        fs.readFileSync(tokenFile), encryptionContext
      ).toString('utf8'));
      if (encryptionStore.fingerprint(token) !== config.tokenFingerprint) throw new Error('fingerprint');
      return token;
    } catch (error) {
      if (error instanceof CoolifyMigrationReaderError) throw error;
      throw new CoolifyMigrationReaderError('Coolify reader credential is unavailable', 409, 'coolify-reader-token-unavailable');
    }
  }

  async function readWithToken(baseUrl, token) {
    const [applications, services, databases] = await Promise.all([
      apiRequest({ baseUrl, token, endpoint: 'applications' }),
      apiRequest({ baseUrl, token, endpoint: 'services' }),
      apiRequest({ baseUrl, token, endpoint: 'databases' })
    ]);
    const resources = [
      ...applications.map(projectApplication),
      ...services.map(projectService),
      ...databases.map(projectDatabase)
    ].filter((resource) => resource.externalId);
    return resources.sort((left, right) => (
      left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId)
    ));
  }

  async function configure({ baseUrl, token }) {
    const normalizedUrl = normalizeBaseUrl(baseUrl);
    const normalizedToken = validateToken(token);
    const resources = await readWithToken(normalizedUrl, normalizedToken);
    const configuredAt = new Date(clock()).toISOString();
    const config = {
      schemaVersion: COOLIFY_READER_SCHEMA_VERSION,
      provider: PROVIDER,
      baseUrl: normalizedUrl,
      configuredAt,
      lastVerifiedAt: configuredAt,
      tokenFingerprint: encryptionStore.fingerprint(normalizedToken),
      revision: 'coolify-reader-' + crypto.createHash('sha256')
        .update(`${normalizedUrl}:${resources.length}`).digest('hex').slice(0, 24)
    };
    encryptionStore.atomicWriteBuffer(
      tokenFile,
      encryptionStore.encryptBuffer(Buffer.from(normalizedToken, 'utf8'), encryptionContext)
    );
    atomicWriteJson(configFile, config);
    return { ...status(config), discoveredResources: resources.length };
  }

  function status(config = readConfig()) {
    const connected = Boolean(config && fs.existsSync(tokenFile));
    return {
      provider: PROVIDER,
      configured: connected,
      optional: true,
      runtimeDependency: false,
      readOnly: true,
      tokenStoredEncrypted: connected,
      tokenIncluded: false,
      baseUrl: config ? config.baseUrl : null,
      configuredAt: config ? config.configuredAt : null,
      lastVerifiedAt: config ? config.lastVerifiedAt : null
    };
  }

  async function scan() {
    const config = readConfig();
    if (!config) return { ...status(null), resources: [] };
    const token = loadToken(config);
    const resources = await readWithToken(config.baseUrl, token);
    return { ...status(config), resources };
  }

  return {
    configure,
    paths: { configFile, root, tokenFile },
    scan,
    status
  };
}

module.exports = {
  COOLIFY_READER_SCHEMA_VERSION,
  CoolifyMigrationReaderError,
  createCoolifyMigrationReader,
  normalizeBaseUrl,
  projectApplication,
  projectDatabase,
  projectService
};
