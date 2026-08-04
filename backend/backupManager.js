const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');
const { atomicWriteJson } = require('./resourceRegistry');

const CONFIG_SCHEMA_VERSION = 1;
const MAX_PILOT_ARCHIVE_BYTES = 512 * 1024 * 1024;

class BackupError extends Error {
  constructor(message, statusCode = 500, code = 'backup-error') {
    super(message);
    this.name = 'BackupError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 64) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
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

function atomicWriteSecret(target, value) {
  ensureDirectory(path.dirname(target));
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not exist if creation itself failed.
    }
    throw error;
  }
}

function endpointIsOffHost(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return url.protocol === 'https:' && ![
    'localhost',
    '127.0.0.1',
    '::1',
    'foxos',
    'foxos-gateway'
  ].includes(hostname);
}

function validateConfig(input) {
  let endpoint;
  try {
    endpoint = new URL(String(input.endpoint || ''));
  } catch {
    throw new BackupError('S3 endpoint is invalid', 400, 'invalid-backup-endpoint');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new BackupError('S3 endpoint must not contain credentials or query data', 400, 'unsafe-backup-endpoint');
  }
  if (!endpointIsOffHost(endpoint.toString())) {
    throw new BackupError('Backup endpoint must be an off-host HTTPS service', 400, 'off-host-backup-required');
  }
  const bucket = String(input.bucket || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new BackupError('S3 bucket name is invalid', 400, 'invalid-backup-bucket');
  }
  const prefix = String(input.prefix || 'foxos').replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.length > 160 || !/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.split('/').includes('..')) {
    throw new BackupError('S3 object prefix is invalid', 400, 'invalid-backup-prefix');
  }
  const region = String(input.region || 'auto').trim();
  if (!/^[A-Za-z0-9-]{1,40}$/.test(region)) {
    throw new BackupError('S3 region is invalid', 400, 'invalid-backup-region');
  }
  return {
    endpoint: endpoint.toString().replace(/\/$/, ''),
    bucket,
    prefix,
    region
  };
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createS3ObjectStore(config, credentials) {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials
  });
  return {
    async putObject({ key, body, metadata }) {
      const result = await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/vnd.foxos.encrypted-backup',
        Metadata: metadata
      }));
      return { etag: result.ETag || null, versionId: result.VersionId || null };
    },
    async headObject({ key }) {
      const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return {
        bytes: Number(result.ContentLength),
        etag: result.ETag || null,
        metadata: result.Metadata || {}
      };
    },
    async getObject({ key }) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return bodyToBuffer(result.Body);
    }
  };
}

function createBackupManager({
  dataRoot,
  encryptionStore,
  objectStore = null,
  objectStoreConfig = null,
  clock = () => new Date()
}) {
  if (!dataRoot || !encryptionStore) {
    throw new Error('Backup manager requires a data root and encryption store');
  }

  const recoveryRoot = path.join(dataRoot, 'recovery');
  const configFile = path.join(recoveryRoot, 's3.json');
  const credentialsRoot = path.join(recoveryRoot, 'credentials');
  const accessKeyFile = path.join(credentialsRoot, 's3-access-key-id');
  const secretKeyFile = path.join(credentialsRoot, 's3-secret-access-key');
  const archivesRoot = path.join(recoveryRoot, 'archives');

  function loadConfig() {
    if (objectStore && objectStoreConfig) return { ...objectStoreConfig, injected: true };
    const config = readJson(configFile, null);
    if (!config) return null;
    if (config.schemaVersion !== CONFIG_SCHEMA_VERSION || config.adapter !== 's3-compatible') {
      throw new BackupError('Backup configuration schema is unsupported', 409, 'unsupported-backup-config');
    }
    return { ...validateConfig(config), schemaVersion: config.schemaVersion, adapter: config.adapter };
  }

  function credentialsAvailable() {
    if (objectStore) return true;
    try {
      return fs.statSync(accessKeyFile).isFile() && fs.statSync(secretKeyFile).isFile();
    } catch {
      return false;
    }
  }

  function loadObjectStore() {
    if (objectStore) return objectStore;
    const config = loadConfig();
    if (!config || !credentialsAvailable()) {
      throw new BackupError('Off-host backup is not configured', 409, 'off-host-backup-unconfigured');
    }
    const accessKeyId = fs.readFileSync(accessKeyFile, 'utf8').trim();
    const secretAccessKey = fs.readFileSync(secretKeyFile, 'utf8').trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new BackupError('Off-host backup credentials are empty', 409, 'off-host-backup-unconfigured');
    }
    return createS3ObjectStore(config, { accessKeyId, secretAccessKey });
  }

  function configureS3(input) {
    const validated = validateConfig(input);
    if (typeof input.accessKeyId !== 'string' || !input.accessKeyId.trim()) {
      throw new BackupError('S3 access key ID is required', 400, 'backup-credential-required');
    }
    if (typeof input.secretAccessKey !== 'string' || !input.secretAccessKey.trim()) {
      throw new BackupError('S3 secret access key is required', 400, 'backup-credential-required');
    }
    ensureDirectory(recoveryRoot);
    ensureDirectory(credentialsRoot);
    atomicWriteSecret(accessKeyFile, input.accessKeyId.trim() + '\n');
    atomicWriteSecret(secretKeyFile, input.secretAccessKey.trim() + '\n');
    atomicWriteJson(configFile, {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      adapter: 's3-compatible',
      ...validated,
      configuredAt: new Date(clock()).toISOString(),
      credentialsIncluded: false
    });
    return status();
  }

  function status() {
    const config = loadConfig();
    const configured = Boolean(config && credentialsAvailable());
    return {
      schemaVersion: 1,
      adapter: config ? 's3-compatible' : null,
      configured,
      ready: configured && endpointIsOffHost(config.endpoint),
      offHost: Boolean(config && endpointIsOffHost(config.endpoint)),
      endpointHost: config ? new URL(config.endpoint).host : null,
      bucket: config ? config.bucket : null,
      prefix: config ? config.prefix : null,
      credentialsIncluded: false,
      encryptedBeforeUpload: true,
      restoreVerificationRequired: true
    };
  }

  async function protectArchive({ operationId, resourceId, volumeName, archive, contentDigest }) {
    const config = loadConfig();
    const currentStatus = status();
    if (!currentStatus.ready || !config) {
      throw new BackupError('Off-host backup and restore verification are required before adoption', 409, 'off-host-backup-unconfigured');
    }
    if (!Buffer.isBuffer(archive) || archive.length < 1 || archive.length > MAX_PILOT_ARCHIVE_BYTES) {
      throw new BackupError('Pilot backup archive size is unsupported', 413, 'backup-archive-size-unsupported');
    }
    const context = {
      purpose: 'foxos-volume-backup',
      schemaVersion: 1,
      operationId,
      resourceId,
      volumeName,
      contentDigest
    };
    const encrypted = encryptionStore.encryptBuffer(archive, context);
    const ciphertextDigest = 'sha256:' + hash(encrypted, 64);
    const archiveName = 'volume-' + hash(volumeName, 24) + '.foxosenc';
    const localFile = path.join(archivesRoot, operationId, archiveName);
    encryptionStore.atomicWriteBuffer(localFile, encrypted);
    const objectKey = [
      config.prefix,
      'resources',
      resourceId,
      'operations',
      operationId,
      archiveName
    ].join('/');
    const metadata = {
      'ciphertext-sha256': ciphertextDigest.replace('sha256:', ''),
      'content-digest': contentDigest.replace('sha256:', ''),
      'key-id': encryptionStore.keyId(),
      'foxos-schema': '1'
    };

    let upload;
    let head;
    let downloaded;
    try {
      const store = loadObjectStore();
      upload = await store.putObject({ key: objectKey, body: encrypted, metadata });
      head = await store.headObject({ key: objectKey });
      if (
        head.bytes !== encrypted.length ||
        head.metadata['ciphertext-sha256'] !== metadata['ciphertext-sha256'] ||
        head.metadata['content-digest'] !== metadata['content-digest'] ||
        head.metadata['key-id'] !== metadata['key-id']
      ) {
        throw new BackupError('Off-host backup metadata verification failed', 502, 'off-host-backup-metadata-mismatch');
      }
      downloaded = await store.getObject({ key: objectKey });
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError('Off-host backup transfer failed', 502, 'off-host-backup-transfer-failed');
    }
    const downloadedDigest = 'sha256:' + hash(downloaded, 64);
    if (downloadedDigest !== ciphertextDigest) {
      throw new BackupError('Downloaded backup ciphertext digest does not match', 502, 'off-host-backup-digest-mismatch');
    }
    const restoredArchive = encryptionStore.decryptBuffer(downloaded, context);
    return {
      archive: restoredArchive,
      record: {
        schemaVersion: 1,
        volumeName,
        encryptedArchiveFile: path.relative(dataRoot, localFile),
        plaintextArchiveStored: false,
        archiveBytes: archive.length,
        encryptedBytes: encrypted.length,
        contentDigest,
        encryption: {
          algorithm: 'aes-256-gcm',
          keyId: encryptionStore.keyId(),
          ciphertextDigest
        },
        remote: {
          adapter: 's3-compatible',
          endpointHost: currentStatus.endpointHost,
          bucket: config.bucket,
          objectKey,
          etag: head.etag || upload && upload.etag || null,
          uploaded: true,
          downloaded: true,
          verifiedAt: new Date(clock()).toISOString()
        },
        credentialsIncluded: false
      }
    };
  }

  ensureDirectory(recoveryRoot);
  return {
    configureS3,
    paths: { accessKeyFile, archivesRoot, configFile, credentialsRoot, recoveryRoot, secretKeyFile },
    protectArchive,
    status
  };
}

module.exports = {
  BackupError,
  createBackupManager,
  createS3ObjectStore,
  endpointIsOffHost
};
