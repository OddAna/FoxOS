const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENVELOPE_SCHEMA_VERSION = 1;
const ENVELOPE_MAGIC = Buffer.from('FOXOSENC1', 'ascii');
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

class EncryptionError extends Error {
  constructor(message, code = 'encryption-error') {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function atomicWriteBuffer(target, value) {
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createEncryptionStore({
  dataRoot,
  randomBytes = crypto.randomBytes
}) {
  if (!dataRoot) throw new Error('Encryption store requires a data root');

  const securityRoot = path.join(dataRoot, 'security');
  const keyFile = path.join(securityRoot, 'master-key');

  function readKey() {
    let key;
    try {
      key = fs.readFileSync(keyFile);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (key.length !== MASTER_KEY_BYTES) {
      throw new EncryptionError('FoxOS master key has an invalid length', 'invalid-master-key');
    }
    fs.chmodSync(keyFile, 0o600);
    return key;
  }

  function ensureKey() {
    const existing = readKey();
    if (existing) return existing;
    ensureDirectory(securityRoot);
    const generated = randomBytes(MASTER_KEY_BYTES);
    try {
      fs.writeFileSync(keyFile, generated, { flag: 'wx', mode: 0o600 });
      return generated;
    } catch (error) {
      if (error.code === 'EEXIST') return readKey();
      throw error;
    }
  }

  function keyId(key = ensureKey()) {
    return 'key_' + sha256(key).slice(0, 24);
  }

  function encryptBuffer(value, context) {
    if (!Buffer.isBuffer(value)) {
      throw new EncryptionError('Encrypted value must be binary', 'invalid-encryption-input');
    }
    const key = ensureKey();
    const iv = randomBytes(IV_BYTES);
    const aad = Buffer.from(canonicalJson(context), 'utf8');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    const header = Buffer.from(JSON.stringify({
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      algorithm: 'aes-256-gcm',
      keyId: keyId(key),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      aad: aad.toString('base64')
    }), 'utf8');
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(header.length);
    return Buffer.concat([ENVELOPE_MAGIC, headerLength, header, ciphertext]);
  }

  function decryptBuffer(envelope, expectedContext = null) {
    if (!Buffer.isBuffer(envelope) || envelope.length < ENVELOPE_MAGIC.length + 5) {
      throw new EncryptionError('Encrypted envelope is invalid', 'invalid-encrypted-envelope');
    }
    if (!envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
      throw new EncryptionError('Encrypted envelope format is unsupported', 'unsupported-encrypted-envelope');
    }
    const headerLength = envelope.readUInt32BE(ENVELOPE_MAGIC.length);
    const headerStart = ENVELOPE_MAGIC.length + 4;
    const headerEnd = headerStart + headerLength;
    if (headerLength < 2 || headerEnd > envelope.length) {
      throw new EncryptionError('Encrypted envelope header is invalid', 'invalid-encrypted-envelope');
    }

    let header;
    try {
      header = JSON.parse(envelope.subarray(headerStart, headerEnd).toString('utf8'));
    } catch {
      throw new EncryptionError('Encrypted envelope header is invalid', 'invalid-encrypted-envelope');
    }
    if (header.schemaVersion !== ENVELOPE_SCHEMA_VERSION || header.algorithm !== 'aes-256-gcm') {
      throw new EncryptionError('Encrypted envelope format is unsupported', 'unsupported-encrypted-envelope');
    }

    const key = readKey();
    if (!key) throw new EncryptionError('FoxOS master key is unavailable', 'master-key-unavailable');
    if (header.keyId !== keyId(key)) {
      throw new EncryptionError('Encrypted envelope belongs to a different FoxOS key', 'master-key-mismatch');
    }
    const aad = Buffer.from(header.aad || '', 'base64');
    if (expectedContext !== null && aad.toString('utf8') !== canonicalJson(expectedContext)) {
      throw new EncryptionError('Encrypted envelope context does not match', 'encryption-context-mismatch');
    }

    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(header.iv || '', 'base64'),
        { authTagLength: AUTH_TAG_BYTES }
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(header.authTag || '', 'base64'));
      return Buffer.concat([decipher.update(envelope.subarray(headerEnd)), decipher.final()]);
    } catch {
      throw new EncryptionError('Encrypted envelope authentication failed', 'encrypted-envelope-authentication-failed');
    }
  }

  function fingerprint(value) {
    const key = ensureKey();
    return 'hmac-sha256:' + crypto.createHmac('sha256', key).update(value).digest('hex');
  }

  function status() {
    const key = readKey();
    return {
      schemaVersion: 1,
      algorithm: 'aes-256-gcm',
      initialized: Boolean(key),
      keyId: key ? keyId(key) : null,
      keyFile: path.relative(dataRoot, keyFile),
      recoveryKeyExported: false
    };
  }

  return {
    atomicWriteBuffer,
    decryptBuffer,
    encryptBuffer,
    ensureKey,
    fingerprint,
    keyId,
    paths: { keyFile, securityRoot },
    status
  };
}

module.exports = {
  EncryptionError,
  createEncryptionStore
};
