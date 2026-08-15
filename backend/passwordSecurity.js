const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const PASSWORD_SCHEMA_VERSION = 1;
const PASSWORD_MIN_LENGTH = 15;
const PASSWORD_MAX_LENGTH = 256;
const PASSWORD_MAX_BYTES = 1024;
const SCRYPT_PARAMS = Object.freeze({
  N: 2 ** 15,
  r: 8,
  p: 3,
  keyLength: 64,
  maxmem: 160 * 1024 * 1024
});

const COMMON_PASSWORDS = new Set([
  '123456789012345',
  '1234567890123456',
  'adminadminadmin',
  'administrator',
  'correcthorsebatterystaple',
  'foxosfoxosfoxos',
  'letmeinletmein',
  'passwordpassword',
  'qwertyqwertyqwerty',
  'welcome123456789'
]);

function passwordLength(password) {
  return [...password].length;
}

function validateNewPassword(password, { username = '' } = {}) {
  if (typeof password !== 'string') {
    return { ok: false, code: 'password-required' };
  }
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    return { ok: false, code: 'password-too-short' };
  }
  if (length > PASSWORD_MAX_LENGTH || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return { ok: false, code: 'password-too-long' };
  }
  if (/\0/.test(password)) {
    return { ok: false, code: 'password-invalid' };
  }

  const comparable = password.trim().toLocaleLowerCase('en-US');
  const comparableUsername = String(username || '').trim().toLocaleLowerCase('en-US');
  if (
    COMMON_PASSWORDS.has(comparable) ||
    comparable === 'foxos' ||
    (comparableUsername.length >= 3 && comparable.includes(comparableUsername))
  ) {
    return { ok: false, code: 'password-common' };
  }
  return { ok: true, code: null };
}

async function deriveScrypt(password, salt, params = SCRYPT_PARAMS) {
  const result = await scrypt(password, salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem
  });
  return Buffer.from(result);
}

async function createPasswordCredential(password, { now = new Date().toISOString() } = {}) {
  const salt = crypto.randomBytes(24).toString('base64url');
  const hash = await deriveScrypt(password, salt);
  return {
    schemaVersion: PASSWORD_SCHEMA_VERSION,
    algorithm: 'scrypt',
    salt,
    hash: hash.toString('base64url'),
    params: { ...SCRYPT_PARAMS },
    updatedAt: now
  };
}

function safeEqual(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function supportedPasswordCredential(credential) {
  return Boolean(
    credential && credential.schemaVersion === PASSWORD_SCHEMA_VERSION &&
    credential.algorithm === 'scrypt' &&
    typeof credential.salt === 'string' && credential.salt.length >= 16 &&
    typeof credential.hash === 'string' && credential.hash.length >= 64 &&
    credential.params &&
    Number.isSafeInteger(credential.params.N) && credential.params.N >= 2 ** 14 && credential.params.N <= 2 ** 20 &&
    Number.isSafeInteger(credential.params.r) && credential.params.r >= 1 && credential.params.r <= 32 &&
    Number.isSafeInteger(credential.params.p) && credential.params.p >= 1 && credential.params.p <= 16 &&
    credential.params.keyLength === 64 &&
    Number.isSafeInteger(credential.params.maxmem) && credential.params.maxmem >= 32 * 1024 * 1024 &&
    credential.params.maxmem <= 512 * 1024 * 1024
  );
}

function needsPasswordUpgrade(credential) {
  if (!supportedPasswordCredential(credential)) return true;
  return Object.entries(SCRYPT_PARAMS).some(([key, value]) => credential.params[key] !== value);
}

async function verifyPassword(password, authRecord) {
  if (typeof password !== 'string' || !authRecord || typeof authRecord !== 'object') {
    return { matched: false, needsUpgrade: false };
  }

  if (supportedPasswordCredential(authRecord.password)) {
    try {
      const actual = await deriveScrypt(password, authRecord.password.salt, authRecord.password.params);
      const expected = Buffer.from(authRecord.password.hash, 'base64url');
      return {
        matched: safeEqual(actual, expected),
        needsUpgrade: needsPasswordUpgrade(authRecord.password)
      };
    } catch {
      return { matched: false, needsUpgrade: false };
    }
  }

  if (typeof authRecord.salt !== 'string' || typeof authRecord.passwordHash !== 'string') {
    return { matched: false, needsUpgrade: false };
  }
  try {
    const actual = await new Promise((resolve, reject) => {
      crypto.scrypt(password, authRecord.salt, 64, (error, result) => {
        if (error) reject(error);
        else resolve(Buffer.from(result));
      });
    });
    const expected = Buffer.from(authRecord.passwordHash, 'hex');
    return { matched: safeEqual(actual, expected), needsUpgrade: true };
  } catch {
    return { matched: false, needsUpgrade: false };
  }
}

function applyPasswordCredential(authRecord, credential) {
  const next = { ...authRecord, version: Math.max(4, Number(authRecord.version) || 0), password: credential };
  delete next.salt;
  delete next.passwordHash;
  return next;
}

module.exports = {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SCRYPT_PARAMS,
  applyPasswordCredential,
  createPasswordCredential,
  needsPasswordUpgrade,
  supportedPasswordCredential,
  validateNewPassword,
  verifyPassword
};
