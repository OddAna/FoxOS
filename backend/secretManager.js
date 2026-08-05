const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const SECRET_SCHEMA_VERSION = 1;
const ENVIRONMENT_SCHEMA_VERSION = 2;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const SECRET_ID_PATTERN = /^secret_[a-f0-9]{32}$/;
const SECRET_REVISION_PATTERN = /^secret_rev_[a-f0-9]{32}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SENSITIVE_ENV_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASS|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH|COOKIE|SESSION|DATABASE_URL|DB_URL|DSN)(_|$)/i;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_ORDINARY_VALUE_BYTES = 64 * 1024;

class SecretError extends Error {
  constructor(message, statusCode = 400, code = 'secret-error') {
    super(message);
    this.name = 'SecretError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
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

function validateEnvironmentName(name) {
  if (!ENV_NAME_PATTERN.test(String(name))) {
    throw new SecretError('Environment variable name is invalid', 400, 'invalid-environment-name');
  }
  return String(name);
}

function isSensitiveEnvironmentName(name) {
  return SENSITIVE_ENV_NAME.test(validateEnvironmentName(name));
}

function createSecretManager({
  dataRoot,
  encryptionStore,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (!dataRoot || !encryptionStore) {
    throw new Error('Secret manager requires a data root and encryption store');
  }

  const secretsRoot = path.join(dataRoot, 'secrets');
  const recordsRoot = path.join(secretsRoot, 'records');
  const environmentsRoot = path.join(secretsRoot, 'environments');

  function secretIdForName(name) {
    const normalized = String(name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(normalized)) {
      throw new SecretError('Secret name is invalid', 400, 'invalid-secret-name');
    }
    return 'secret_' + hash(normalized, 32);
  }

  function secretRevisionPath(secretId, revision) {
    if (!SECRET_ID_PATTERN.test(String(secretId)) || !SECRET_REVISION_PATTERN.test(String(revision))) {
      throw new SecretError('Secret reference is invalid', 400, 'invalid-secret-reference');
    }
    return path.join(recordsRoot, secretId, 'revisions', revision + '.json');
  }

  function secretLatestPath(secretId) {
    if (!SECRET_ID_PATTERN.test(String(secretId))) {
      throw new SecretError('Secret reference is invalid', 400, 'invalid-secret-reference');
    }
    return path.join(recordsRoot, secretId, 'latest.json');
  }

  function publicSecret(record) {
    return {
      schemaVersion: record.schemaVersion,
      secretId: record.secretId,
      name: record.name,
      revision: record.revision,
      algorithm: record.algorithm,
      keyId: record.keyId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      valueIncluded: false
    };
  }

  function putSecret(name, value) {
    const secretId = secretIdForName(name);
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
      throw new SecretError('Secret value must be between 1 byte and 64 KiB', 400, 'invalid-secret-value');
    }
    const existing = readJson(secretLatestPath(secretId), null);
    const timestamp = new Date(clock()).toISOString();
    const revision = 'secret_rev_' + randomUUID().replace(/-/g, '').slice(0, 32);
    const context = {
      purpose: 'foxos-secret',
      schemaVersion: SECRET_SCHEMA_VERSION,
      secretId,
      revision
    };
    const encrypted = encryptionStore.encryptBuffer(Buffer.from(value, 'utf8'), context);
    const record = {
      schemaVersion: SECRET_SCHEMA_VERSION,
      secretId,
      name: String(name).trim(),
      revision,
      algorithm: 'aes-256-gcm',
      keyId: encryptionStore.keyId(),
      createdAt: existing ? existing.createdAt : timestamp,
      updatedAt: timestamp,
      encryptedValue: encrypted.toString('base64'),
      valueIncluded: false
    };
    atomicWriteJson(secretRevisionPath(secretId, revision), record);
    atomicWriteJson(secretLatestPath(secretId), record);
    return publicSecret(record);
  }

  function getSecretRecord(secretId, revision = null) {
    const record = revision
      ? readJson(secretRevisionPath(secretId, revision), null)
      : readJson(secretLatestPath(secretId), null);
    if (!record) throw new SecretError('Secret was not found', 404, 'secret-not-found');
    if (record.schemaVersion !== SECRET_SCHEMA_VERSION || !record.encryptedValue) {
      throw new SecretError('Secret record schema is unsupported', 409, 'unsupported-secret-schema');
    }
    return record;
  }

  function getSecretByName(name) {
    return getSecretRecord(secretIdForName(name));
  }

  function resolveSecret(secretId, revision) {
    const record = getSecretRecord(secretId, revision);
    const context = {
      purpose: 'foxos-secret',
      schemaVersion: SECRET_SCHEMA_VERSION,
      secretId: record.secretId,
      revision: record.revision
    };
    return encryptionStore.decryptBuffer(Buffer.from(record.encryptedValue, 'base64'), context).toString('utf8');
  }

  function listSecrets() {
    try {
      return fs.readdirSync(recordsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SECRET_ID_PATTERN.test(entry.name))
        .map((entry) => readJson(path.join(recordsRoot, entry.name, 'latest.json'), null))
        .filter(Boolean)
        .map(publicSecret)
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function environmentLatestPath(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId))) {
      throw new SecretError('FoxOS resource ID is invalid', 400, 'invalid-resource-id');
    }
    return path.join(environmentsRoot, resourceId, 'latest.json');
  }

  function createEnvironmentRevision(resourceId, input = {}) {
    const ordinaryInput = input.ordinary && typeof input.ordinary === 'object' && !Array.isArray(input.ordinary)
      ? input.ordinary
      : {};
    const secretInput = input.secretRefs && typeof input.secretRefs === 'object' && !Array.isArray(input.secretRefs)
      ? input.secretRefs
      : {};
    const excludedInput = input.excluded && typeof input.excluded === 'object' && !Array.isArray(input.excluded)
      ? input.excluded
      : {};
    const ordinary = Object.entries(ordinaryInput).map(([rawName, rawValue]) => {
      const name = validateEnvironmentName(rawName);
      if (SENSITIVE_ENV_NAME.test(name)) {
        throw new SecretError('Sensitive environment names must use an encrypted secret reference', 400, 'sensitive-environment-must-be-secret');
      }
      if (typeof rawValue !== 'string' || Buffer.byteLength(rawValue) > MAX_ORDINARY_VALUE_BYTES) {
        throw new SecretError('Ordinary environment value is invalid', 400, 'invalid-environment-value');
      }
      return { name, value: rawValue };
    }).sort((left, right) => left.name.localeCompare(right.name));

    const secretRefs = Object.entries(secretInput).map(([rawName, rawReference]) => {
      const name = validateEnvironmentName(rawName);
      const requested = typeof rawReference === 'string'
        ? getSecretByName(rawReference)
        : getSecretRecord(rawReference && rawReference.secretId, rawReference && rawReference.revision || null);
      return {
        name,
        secretId: requested.secretId,
        revision: requested.revision,
        keyId: requested.keyId
      };
    }).sort((left, right) => left.name.localeCompare(right.name));

    const excluded = Object.entries(excludedInput).map(([rawName, rawReason]) => {
      const name = validateEnvironmentName(rawName);
      const reason = String(rawReason || '');
      if (reason !== 'provider-runtime-metadata') {
        throw new SecretError('Environment exclusion reason is unsupported', 400, 'unsupported-environment-exclusion');
      }
      return { name, reason };
    }).sort((left, right) => left.name.localeCompare(right.name));

    const ordinaryNames = new Set(ordinary.map((entry) => entry.name));
    const secretNames = new Set(secretRefs.map((entry) => entry.name));
    if (secretRefs.some((entry) => ordinaryNames.has(entry.name))) {
      throw new SecretError('An environment name cannot be both ordinary and secret', 400, 'duplicate-environment-name');
    }
    if (excluded.some((entry) => ordinaryNames.has(entry.name) || secretNames.has(entry.name))) {
      throw new SecretError('An environment name cannot be managed and excluded', 400, 'duplicate-environment-name');
    }
    if (!ordinary.length && !secretRefs.length && !excluded.length) {
      throw new SecretError('Environment revision must classify at least one value', 400, 'empty-environment-revision');
    }

    const core = {
      schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
      resourceId,
      ordinary,
      secretRefs,
      excluded,
      secretValuesIncluded: false
    };
    const revision = 'env_rev_' + hash(canonicalJson(core), 32);
    const existing = readJson(environmentLatestPath(resourceId), null);
    const record = {
      ...core,
      revision,
      createdAt: existing && existing.revision === revision
        ? existing.createdAt
        : new Date(clock()).toISOString()
    };
    const revisionFile = path.join(environmentsRoot, resourceId, 'revisions', revision + '.json');
    atomicWriteJson(revisionFile, record);
    atomicWriteJson(environmentLatestPath(resourceId), record);
    return record;
  }

  function getEnvironmentRevision(resourceId) {
    const record = readJson(environmentLatestPath(resourceId), null);
    if (!record) return null;
    if (![1, ENVIRONMENT_SCHEMA_VERSION].includes(record.schemaVersion) || record.resourceId !== resourceId) {
      throw new SecretError('Environment revision schema is unsupported', 409, 'unsupported-environment-schema');
    }
    return { ...record, excluded: record.excluded || [] };
  }

  function resolveEnvironment(environment) {
    const ordinary = (environment.ordinary || []).map((entry) => `${entry.name}=${entry.value}`);
    const secret = (environment.secretRefs || []).map((entry) => (
      `${entry.name}=${resolveSecret(entry.secretId, entry.revision)}`
    ));
    return [...ordinary, ...secret].sort();
  }

  function fingerprintEnvironment(entries) {
    const normalized = (entries || []).map(String).sort().join('\0');
    return encryptionStore.fingerprint(Buffer.from(normalized, 'utf8'));
  }

  function status() {
    return {
      schemaVersion: 1,
      encryption: encryptionStore.status(),
      secretCount: listSecrets().length,
      secretValuesIncluded: false
    };
  }

  ensureDirectory(secretsRoot);
  return {
    createEnvironmentRevision,
    fingerprintEnvironment,
    getEnvironmentRevision,
    getSecretByName: (name) => publicSecret(getSecretByName(name)),
    listSecrets,
    paths: { environmentsRoot, recordsRoot, secretsRoot },
    putSecret,
    resolveEnvironment,
    resolveSecret,
    status
  };
}

module.exports = {
  SecretError,
  createSecretManager,
  isSensitiveEnvironmentName,
  validateEnvironmentName
};
