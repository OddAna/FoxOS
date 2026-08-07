const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const COOLIFY_READER_SCHEMA_VERSION = 1;
const PROVIDER_DEFINITION_RECOVERY_SCHEMA_VERSION = 1;
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function selectedFields(row, fields) {
  return Object.fromEntries(fields
    .filter((field) => row && row[field] !== undefined)
    .map((field) => [field, row[field]]));
}

function recoveryEnvironment(rows = []) {
  return rows.map((row) => ({
    key: safeText(row.key, 128),
    value: String(row.real_value !== undefined && row.real_value !== null ? row.real_value : row.value || ''),
    isBuildtime: row.is_buildtime === true,
    isRuntime: row.is_runtime !== false,
    isLiteral: row.is_literal === true,
    isMultiline: row.is_multiline === true,
    isRequired: row.is_required === true || row.is_really_required === true,
    isCoolifyMetadata: row.is_coolify === true
  })).filter((entry) => entry.key);
}

function recoveryDefinition(kind, row, environment = []) {
  const fields = kind === 'application' ? [
    'name', 'description', 'build_pack', 'git_repository', 'git_branch', 'git_commit_sha',
    'docker_registry_image_name', 'docker_registry_image_tag', 'dockerfile', 'dockerfile_location',
    'dockerfile_target_build', 'docker_compose', 'docker_compose_raw', 'docker_compose_location',
    'base_directory', 'publish_directory', 'install_command', 'build_command', 'start_command',
    'pre_deployment_command', 'post_deployment_command', 'ports_exposes', 'ports_mappings',
    'fqdn', 'redirect', 'health_check_enabled', 'health_check_method', 'health_check_scheme',
    'health_check_host', 'health_check_port', 'health_check_path', 'health_check_return_code',
    'health_check_interval', 'health_check_timeout', 'health_check_retries',
    'health_check_start_period', 'custom_docker_run_options', 'custom_labels',
    'is_http_basic_auth_enabled', 'http_basic_auth_username', 'http_basic_auth_password',
    'limits_cpus', 'limits_cpu_shares', 'limits_cpuset', 'limits_memory',
    'limits_memory_reservation', 'limits_memory_swap', 'limits_memory_swappiness',
    'compose_parsing_version'
  ] : kind === 'service' ? [
    'name', 'description', 'service_type', 'docker_compose', 'docker_compose_raw',
    'connect_to_docker_network', 'compose_parsing_version'
  ] : [
    'name', 'description', 'database_type', 'image', 'postgres_user', 'postgres_password',
    'postgres_db', 'postgres_host_auth_method', 'postgres_initdb_args', 'postgres_conf',
    'init_scripts', 'internal_db_url', 'external_db_url', 'is_public', 'public_port',
    'ports_mappings', 'enable_ssl', 'ssl_mode', 'custom_docker_run_options',
    'limits_cpus', 'limits_cpu_shares', 'limits_cpuset', 'limits_memory',
    'limits_memory_reservation', 'limits_memory_swap', 'limits_memory_swappiness'
  ];
  return {
    schemaVersion: PROVIDER_DEFINITION_RECOVERY_SCHEMA_VERSION,
    provider: PROVIDER,
    providerKind: kind,
    externalId: safeText(row.uuid, 128),
    definition: selectedFields(row, fields),
    environment: recoveryEnvironment(environment),
    encryptedSecretValuesPresent: true
  };
}

function repositoryName(value) {
  const repository = String(value || '').trim().replace(/\.git$/i, '');
  if (!repository) return null;
  const normalized = repository.replace(/^git@[^:]+:/, '').replace(/^https?:\/\/[^/]+\//, '');
  return safeText(normalized.split('/').filter(Boolean).pop(), 256);
}

function generatedProviderName(value) {
  return /:[A-Za-z0-9._-]+-[a-z0-9]{20,}$/i.test(String(value || '')) ||
    /-[a-z0-9]{20,}$/i.test(String(value || ''));
}

function applicationName(row) {
  const name = safeText(row.name);
  if (name && !generatedProviderName(name)) return name;
  return repositoryName(row.git_repository) || 'Unnamed application';
}

function serviceName(row) {
  const name = safeText(row.name);
  if (name && !generatedProviderName(name)) return name;
  return safeText(row.service_type, 128) || 'Unnamed service';
}

function projectApplication(row, recoveryArtifact = null) {
  return {
    sourceKind: 'provider-definition',
    provider: PROVIDER,
    externalId: safeText(row.uuid, 128),
    name: applicationName(row),
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
    observedUpdatedAt: safeText(row.updated_at, 64),
    recoveryArtifact
  };
}

function projectService(row, recoveryArtifact = null) {
  return {
    sourceKind: 'provider-definition',
    provider: PROVIDER,
    externalId: safeText(row.uuid, 128),
    name: serviceName(row),
    providerKind: 'service',
    status: normalizeStatus(row.status),
    serviceType: safeText(row.service_type, 128),
    source: {
      type: 'compose-service',
      composeParsingVersion: safeText(row.compose_parsing_version, 96)
    },
    routes: [],
    observedUpdatedAt: safeText(row.updated_at, 64),
    recoveryArtifact
  };
}

function projectDatabase(row, recoveryArtifact = null) {
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
    observedUpdatedAt: safeText(row.updated_at, 64),
    recoveryArtifact
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
  const recoveryRoot = path.join(dataRoot, 'provider-definitions', 'recovery');
  const configFile = path.join(root, 'config.json');
  const tokenFile = path.join(root, 'token.foxosenc');
  const encryptionContext = {
    purpose: 'foxos-optional-migration-reader',
    provider: PROVIDER,
    schemaVersion: COOLIFY_READER_SCHEMA_VERSION
  };

  function recoveryContext(artifactId, revision) {
    return {
      purpose: 'foxos-provider-definition-recovery',
      schemaVersion: PROVIDER_DEFINITION_RECOVERY_SCHEMA_VERSION,
      provider: PROVIDER,
      artifactId,
      revision
    };
  }

  function writeRecoveryArtifact(kind, row, environment = []) {
    const payload = recoveryDefinition(kind, row, environment);
    const artifactId = 'pdef_' + hash(PROVIDER + '\0' + payload.externalId, 32);
    const revision = 'pdef_rev_' + hash(canonicalJson(payload), 32);
    const file = path.join(recoveryRoot, artifactId + '-' + revision + '.foxosenc');
    encryptionStore.atomicWriteBuffer(
      file,
      encryptionStore.encryptBuffer(
        Buffer.from(canonicalJson(payload), 'utf8'),
        recoveryContext(artifactId, revision)
      )
    );
    return {
      schemaVersion: PROVIDER_DEFINITION_RECOVERY_SCHEMA_VERSION,
      artifactId,
      revision,
      file: path.relative(dataRoot, file),
      encrypted: true,
      authenticated: true,
      keyId: encryptionStore.keyId(),
      plaintextSecretValuesIncluded: false
    };
  }

  function readRecoveryArtifact(artifact) {
    if (
      !artifact || artifact.schemaVersion !== PROVIDER_DEFINITION_RECOVERY_SCHEMA_VERSION ||
      !/^pdef_[a-f0-9]{32}$/.test(String(artifact.artifactId || '')) ||
      !/^pdef_rev_[a-f0-9]{32}$/.test(String(artifact.revision || '')) ||
      artifact.file !== path.join('provider-definitions', 'recovery',
        artifact.artifactId + '-' + artifact.revision + '.foxosenc')
    ) throw new CoolifyMigrationReaderError('Provider recovery artifact is invalid', 409, 'recovery-artifact-invalid');
    const payload = JSON.parse(encryptionStore.decryptBuffer(
      fs.readFileSync(path.join(dataRoot, artifact.file)),
      recoveryContext(artifact.artifactId, artifact.revision)
    ).toString('utf8'));
    if (
      !payload || payload.schemaVersion !== PROVIDER_DEFINITION_RECOVERY_SCHEMA_VERSION ||
      payload.provider !== PROVIDER || !payload.externalId ||
      artifact.artifactId !== 'pdef_' + hash(PROVIDER + '\0' + payload.externalId, 32) ||
      artifact.revision !== 'pdef_rev_' + hash(canonicalJson(payload), 32)
    ) throw new CoolifyMigrationReaderError('Provider recovery artifact is stale', 409, 'recovery-artifact-stale');
    return payload;
  }

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
    const applicationResources = await Promise.all(applications.map(async (row) => {
      const environment = await apiRequest({ baseUrl, token, endpoint: `applications/${row.uuid}/envs` });
      return projectApplication(row, writeRecoveryArtifact('application', row, environment));
    }));
    const serviceResources = await Promise.all(services.map(async (row) => {
      const environment = await apiRequest({ baseUrl, token, endpoint: `services/${row.uuid}/envs` });
      return projectService(row, writeRecoveryArtifact('service', row, environment));
    }));
    const resources = [
      ...applicationResources,
      ...serviceResources,
      ...databases.map((row) => projectDatabase(row, writeRecoveryArtifact('database', row)))
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
    paths: { configFile, recoveryRoot, root, tokenFile },
    readRecoveryArtifact,
    scan,
    status
  };
}

module.exports = {
  COOLIFY_READER_SCHEMA_VERSION,
  CoolifyMigrationReaderError,
  createCoolifyMigrationReader,
  applicationName,
  generatedProviderName,
  normalizeBaseUrl,
  projectApplication,
  projectDatabase,
  projectService,
  repositoryName,
  serviceName
};
