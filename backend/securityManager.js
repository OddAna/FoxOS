const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} = require('@simplewebauthn/server');
const {
  applyPasswordCredential,
  createPasswordCredential,
  validateNewPassword,
  verifyPassword
} = require('./passwordSecurity');

const SECURITY_SCHEMA_VERSION = 1;
const AUTH_RECORD_VERSION = 4;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 64;
const MAX_EVENTS = 1000;
const MAX_EVENT_BYTES = 512 * 1024;
const PASSKEY_ID_PATTERN = /^[A-Za-z0-9_-]{16,1024}$/;
const SESSION_ID_PATTERN = /^ses_[a-f0-9]{32}$/;
const SAFE_EVENT_TYPES = new Set([
  'owner-created',
  'login-succeeded',
  'login-failed',
  'logout',
  'password-changed',
  'password-recovered',
  'password-upgraded',
  'passkey-added',
  'passkey-used',
  'passkey-renamed',
  'passkey-removed',
  'recovery-codes-created',
  'session-revoked',
  'sessions-revoked'
]);
const BASE32_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class SecurityError extends Error {
  constructor(message, statusCode = 400, code = 'security-error') {
    super(message);
    this.name = 'SecurityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function boundedText(value, maxLength = 128) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function normalizePasskeyName(value) {
  const name = boundedText(value, 64);
  if (!name) throw new SecurityError('Passkey name is required', 400, 'passkey-name-required');
  return name;
}

function normalizeContext(context) {
  const rpID = boundedText(context && context.rpID, 253);
  const origin = boundedText(context && context.origin, 512);
  if (!rpID || !origin) throw new SecurityError('Passkey origin is not configured', 503, 'passkey-origin-unavailable');
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new SecurityError('Passkey origin is invalid', 503, 'passkey-origin-invalid');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new SecurityError('Passkey origin is invalid', 503, 'passkey-origin-invalid');
  }
  if (parsed.hostname !== rpID && !parsed.hostname.endsWith('.' + rpID)) {
    throw new SecurityError('Passkey relying party is invalid', 503, 'passkey-rp-invalid');
  }
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new SecurityError('Passkeys require HTTPS', 503, 'passkey-https-required');
  }
  return { rpID, origin: parsed.origin };
}

function normalizeClient(client) {
  const source = client && typeof client === 'object' ? client : {};
  return {
    browser: boundedText(source.browser),
    os: boundedText(source.os),
    device: boundedText(source.device),
    network: boundedText(source.network)
  };
}

function safePasskey(passkey) {
  return {
    id: passkey.id,
    name: passkey.name,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt || null,
    deviceType: passkey.deviceType || 'unknown',
    backedUp: passkey.backedUp === true,
    transports: Array.isArray(passkey.transports) ? [...passkey.transports] : []
  };
}

function securityFields(record, randomBytes) {
  const passkeys = Array.isArray(record.passkeys) ? record.passkeys.filter((passkey) => (
    passkey && typeof passkey.id === 'string' && PASSKEY_ID_PATTERN.test(passkey.id) &&
    typeof passkey.publicKey === 'string' && Number.isSafeInteger(passkey.counter)
  )) : [];
  const recovery = record.recovery && typeof record.recovery === 'object'
    ? record.recovery
    : { salt: null, generatedAt: null, needsRotation: false, codes: [] };
  return {
    ...record,
    version: Math.max(AUTH_RECORD_VERSION, Number(record.version) || 0),
    securitySchemaVersion: SECURITY_SCHEMA_VERSION,
    webauthnUserId: typeof record.webauthnUserId === 'string' && record.webauthnUserId.length >= 32
      ? record.webauthnUserId
      : randomBytes(32).toString('base64url'),
    passkeys,
    recovery: {
      salt: typeof recovery.salt === 'string' ? recovery.salt : null,
      generatedAt: typeof recovery.generatedAt === 'string' ? recovery.generatedAt : null,
      needsRotation: recovery.needsRotation === true,
      codes: Array.isArray(recovery.codes) ? recovery.codes.filter((code) => (
        code && typeof code.id === 'string' && typeof code.digest === 'string' &&
        (code.usedAt === null || typeof code.usedAt === 'string')
      )) : []
    }
  };
}

function recoveryCodeDigest(salt, code) {
  return crypto.createHash('sha256').update(salt + ':' + normalizeRecoveryCode(code), 'utf8').digest('hex');
}

function normalizeRecoveryCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= bits > 0 ? (1 << bits) - 1 : 0;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function displayRecoveryCode(buffer) {
  const encoded = base32(buffer).slice(0, 16);
  return 'FOXOS-' + encoded.match(/.{1,4}/g).join('-');
}

function createSecurityManager({
  authFilePath,
  eventFilePath,
  clock = () => Date.now(),
  randomBytes = crypto.randomBytes,
  webauthn = {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse
  },
  onError = () => {}
}) {
  if (!path.isAbsolute(authFilePath) || !path.isAbsolute(eventFilePath)) {
    throw new TypeError('Security manager paths must be absolute');
  }
  const challenges = new Map();
  let mutationQueue = Promise.resolve();

  function readRecord() {
    if (!fs.existsSync(authFilePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(authFilePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      onError(error);
      return null;
    }
  }

  function writeRecord(record) {
    fs.mkdirSync(path.dirname(authFilePath), { recursive: true, mode: 0o700 });
    const temporaryFile = authFilePath + '.tmp-' + process.pid;
    fs.writeFileSync(temporaryFile, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporaryFile, authFilePath);
    fs.chmodSync(authFilePath, 0o600);
  }

  function queueMutation(operation) {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.catch(() => {});
    return run;
  }

  function pruneChallenges() {
    const now = clock();
    for (const [id, challenge] of challenges.entries()) {
      if (challenge.expiresAt <= now) challenges.delete(id);
    }
    while (challenges.size >= MAX_CHALLENGES) {
      const oldest = [...challenges.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      challenges.delete(oldest[0]);
    }
  }

  function rememberChallenge(type, challenge, context, payload = {}) {
    pruneChallenges();
    const id = 'cer_' + randomBytes(16).toString('hex');
    challenges.set(id, {
      type,
      challenge,
      context,
      payload,
      expiresAt: clock() + CHALLENGE_TTL_MS
    });
    return id;
  }

  function consumeChallenge(id, type, context) {
    const challenge = challenges.get(String(id || ''));
    challenges.delete(String(id || ''));
    if (!challenge || challenge.type !== type || challenge.expiresAt <= clock()) {
      throw new SecurityError('Passkey request expired', 400, 'passkey-ceremony-expired');
    }
    if (challenge.context.rpID !== context.rpID || challenge.context.origin !== context.origin) {
      throw new SecurityError('Passkey origin changed', 400, 'passkey-origin-mismatch');
    }
    return challenge;
  }

  function readEventLines() {
    if (!fs.existsSync(eventFilePath)) return [];
    try {
      return fs.readFileSync(eventFilePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      onError(error);
      return [];
    }
  }

  function writeEventLines(events) {
    fs.mkdirSync(path.dirname(eventFilePath), { recursive: true, mode: 0o700 });
    const temporaryFile = eventFilePath + '.tmp-' + process.pid;
    const content = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
    fs.writeFileSync(temporaryFile, content, { mode: 0o600 });
    fs.renameSync(temporaryFile, eventFilePath);
    fs.chmodSync(eventFilePath, 0o600);
  }

  function recordEvent({ type, success = true, method = null, sessionId = null, client = null, detail = null }) {
    if (!SAFE_EVENT_TYPES.has(type)) return null;
    const event = {
      id: 'sev_' + randomBytes(16).toString('hex'),
      type,
      success: success === true,
      method: ['password', 'passkey', 'recovery', 'maintenance'].includes(method) ? method : null,
      sessionId: SESSION_ID_PATTERN.test(String(sessionId || '')) ? sessionId : null,
      client: normalizeClient(client),
      detail: boundedText(detail, 96),
      createdAt: new Date(clock()).toISOString()
    };
    const events = readEventLines();
    events.push(event);
    while (events.length > MAX_EVENTS) events.shift();
    while (events.length > 1 && Buffer.byteLength(events.map((item) => JSON.stringify(item)).join('\n')) > MAX_EVENT_BYTES) {
      events.shift();
    }
    writeEventLines(events);
    return event;
  }

  async function verifyOwnerPassword(password, { upgrade = true, client = null, sessionId = null } = {}) {
    const record = readRecord();
    if (!record) return { matched: false, record: null };
    const verification = await verifyPassword(password, record);
    if (!verification.matched) return { matched: false, record };
    if (upgrade && verification.needsUpgrade) {
      const credential = await createPasswordCredential(password, { now: new Date(clock()).toISOString() });
      const upgraded = await queueMutation(async () => {
        const latest = readRecord();
        const latestVerification = await verifyPassword(password, latest);
        if (!latestVerification.matched) throw new SecurityError('Password changed during verification', 409, 'password-changed');
        const next = securityFields(applyPasswordCredential(latest, credential), randomBytes);
        writeRecord(next);
        return next;
      });
      recordEvent({ type: 'password-upgraded', method: 'password', client, sessionId });
      return { matched: true, record: upgraded, upgraded: true };
    }
    return { matched: true, record, upgraded: false };
  }

  function status() {
    const record = readRecord();
    if (!record) return null;
    const modern = securityFields(record, randomBytes);
    const availableCodes = modern.recovery.codes.filter((code) => !code.usedAt).length;
    return {
      schemaVersion: SECURITY_SCHEMA_VERSION,
      username: modern.username,
      password: {
        configured: Boolean(modern.password || modern.passwordHash),
        modern: Boolean(modern.password),
        updatedAt: modern.password && modern.password.updatedAt || modern.createdAt || null
      },
      passkeys: modern.passkeys.map(safePasskey),
      recovery: {
        configured: availableCodes > 0,
        availableCodes,
        generatedAt: modern.recovery.generatedAt,
        needsRotation: modern.recovery.needsRotation
      }
    };
  }

  async function changePassword(currentPassword, newPassword, metadata = {}) {
    const record = readRecord();
    if (!record) throw new SecurityError('FoxOS is not configured', 409, 'auth-not-configured');
    const validation = validateNewPassword(newPassword, { username: record.username });
    if (!validation.ok) throw new SecurityError('New password does not meet the security policy', 400, validation.code);
    const current = await verifyPassword(currentPassword, record);
    if (!current.matched) throw new SecurityError('Current password is invalid', 401, 'current-password-invalid');
    const credential = await createPasswordCredential(newPassword, { now: new Date(clock()).toISOString() });
    await queueMutation(async () => {
      const latest = readRecord();
      const stillCurrent = await verifyPassword(currentPassword, latest);
      if (!stillCurrent.matched) throw new SecurityError('Password changed during verification', 409, 'password-changed');
      writeRecord(securityFields(applyPasswordCredential(latest, credential), randomBytes));
    });
    recordEvent({ type: 'password-changed', method: 'password', ...metadata });
  }

  async function beginPasskeyRegistration({ sessionToken, name, preferredAuthenticatorType, context }) {
    const normalizedContext = normalizeContext(context);
    const record = readRecord();
    if (!record) throw new SecurityError('FoxOS is not configured', 409, 'auth-not-configured');
    const modern = await queueMutation(async () => {
      const latest = securityFields(readRecord(), randomBytes);
      writeRecord(latest);
      return latest;
    });
    const passkeyName = normalizePasskeyName(name);
    const options = await webauthn.generateRegistrationOptions({
      rpName: 'FoxOS',
      rpID: normalizedContext.rpID,
      userID: Buffer.from(modern.webauthnUserId, 'base64url'),
      userName: modern.username,
      userDisplayName: modern.username,
      attestationType: 'none',
      excludeCredentials: modern.passkeys.map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      preferredAuthenticatorType: ['securityKey', 'localDevice', 'remoteDevice'].includes(preferredAuthenticatorType)
        ? preferredAuthenticatorType
        : undefined
    });
    const ceremonyId = rememberChallenge('registration', options.challenge, normalizedContext, {
      sessionHash: crypto.createHash('sha256').update(sessionToken).digest('hex'),
      name: passkeyName,
      webauthnUserId: modern.webauthnUserId
    });
    return { ceremonyId, options };
  }

  async function finishPasskeyRegistration({ sessionToken, ceremonyId, response, context, metadata = {} }) {
    const normalizedContext = normalizeContext(context);
    const challenge = consumeChallenge(ceremonyId, 'registration', normalizedContext);
    const suppliedSessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    if (challenge.payload.sessionHash !== suppliedSessionHash) {
      throw new SecurityError('Passkey request belongs to another session', 403, 'passkey-session-mismatch');
    }
    let verification;
    try {
      verification = await webauthn.verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: normalizedContext.origin,
        expectedRPID: normalizedContext.rpID,
        requireUserVerification: true
      });
    } catch (error) {
      throw new SecurityError('Passkey could not be verified', 400, 'passkey-verification-failed');
    }
    if (!verification.verified || !verification.registrationInfo || !verification.registrationInfo.credential) {
      throw new SecurityError('Passkey could not be verified', 400, 'passkey-verification-failed');
    }
    const info = verification.registrationInfo;
    const credential = info.credential;
    const now = new Date(clock()).toISOString();
    const storedPasskey = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: Array.isArray(response && response.response && response.response.transports)
        ? response.response.transports.slice(0, 8)
        : Array.isArray(credential.transports) ? credential.transports.slice(0, 8) : [],
      name: challenge.payload.name,
      createdAt: now,
      lastUsedAt: null,
      deviceType: info.credentialDeviceType || 'unknown',
      backedUp: info.credentialBackedUp === true
    };
    await queueMutation(async () => {
      const latest = securityFields(readRecord(), randomBytes);
      if (latest.webauthnUserId !== challenge.payload.webauthnUserId) {
        throw new SecurityError('Owner identity changed', 409, 'passkey-owner-changed');
      }
      if (latest.passkeys.some((passkey) => passkey.id === storedPasskey.id)) {
        throw new SecurityError('Passkey is already registered', 409, 'passkey-already-registered');
      }
      latest.passkeys.push(storedPasskey);
      writeRecord(latest);
    });
    recordEvent({ type: 'passkey-added', method: 'passkey', detail: storedPasskey.name, ...metadata });
    return safePasskey(storedPasskey);
  }

  async function beginPasskeyAuthentication(context) {
    const normalizedContext = normalizeContext(context);
    const record = readRecord();
    if (!record) throw new SecurityError('FoxOS is not configured', 409, 'auth-not-configured');
    const modern = securityFields(record, randomBytes);
    if (!modern.passkeys.length) throw new SecurityError('No passkey is registered', 404, 'passkey-not-configured');
    const options = await webauthn.generateAuthenticationOptions({
      rpID: normalizedContext.rpID,
      allowCredentials: modern.passkeys.map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
      userVerification: 'required'
    });
    const ceremonyId = rememberChallenge('authentication', options.challenge, normalizedContext, {
      webauthnUserId: modern.webauthnUserId
    });
    return { ceremonyId, options };
  }

  async function finishPasskeyAuthentication({ ceremonyId, response, context, metadata = {} }) {
    const normalizedContext = normalizeContext(context);
    const challenge = consumeChallenge(ceremonyId, 'authentication', normalizedContext);
    const rawRecord = readRecord();
    if (!rawRecord) throw new SecurityError('FoxOS is not configured', 409, 'auth-not-configured');
    const record = securityFields(rawRecord, randomBytes);
    if (record.webauthnUserId !== challenge.payload.webauthnUserId) {
      throw new SecurityError('Owner identity changed', 409, 'passkey-owner-changed');
    }
    const passkey = record.passkeys.find((candidate) => candidate.id === String(response && response.id || ''));
    if (!passkey) throw new SecurityError('Passkey is not registered', 401, 'passkey-not-found');
    let verification;
    try {
      verification = await webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: normalizedContext.origin,
        expectedRPID: normalizedContext.rpID,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
          counter: passkey.counter,
          transports: passkey.transports
        },
        requireUserVerification: true
      });
    } catch {
      throw new SecurityError('Passkey could not be verified', 401, 'passkey-verification-failed');
    }
    if (!verification.verified || !verification.authenticationInfo) {
      throw new SecurityError('Passkey could not be verified', 401, 'passkey-verification-failed');
    }
    const now = new Date(clock()).toISOString();
    await queueMutation(async () => {
      const latest = securityFields(readRecord(), randomBytes);
      const target = latest.passkeys.find((candidate) => candidate.id === passkey.id);
      if (!target) throw new SecurityError('Passkey was removed', 409, 'passkey-removed');
      target.counter = verification.authenticationInfo.newCounter;
      target.lastUsedAt = now;
      writeRecord(latest);
    });
    recordEvent({ type: 'passkey-used', method: 'passkey', detail: passkey.name, ...metadata });
    return { username: record.username, passkey: safePasskey({ ...passkey, lastUsedAt: now }) };
  }

  async function renamePasskey(id, name, metadata = {}) {
    if (!PASSKEY_ID_PATTERN.test(String(id || ''))) throw new SecurityError('Passkey was not found', 404, 'passkey-not-found');
    const normalizedName = normalizePasskeyName(name);
    await queueMutation(async () => {
      const record = securityFields(readRecord(), randomBytes);
      const passkey = record.passkeys.find((candidate) => candidate.id === id);
      if (!passkey) throw new SecurityError('Passkey was not found', 404, 'passkey-not-found');
      passkey.name = normalizedName;
      writeRecord(record);
    });
    recordEvent({ type: 'passkey-renamed', method: metadata.method || 'password', detail: normalizedName, ...metadata });
  }

  async function removePasskey(id, metadata = {}) {
    let removed;
    await queueMutation(async () => {
      const record = securityFields(readRecord(), randomBytes);
      const index = record.passkeys.findIndex((candidate) => candidate.id === id);
      if (index === -1) throw new SecurityError('Passkey was not found', 404, 'passkey-not-found');
      [removed] = record.passkeys.splice(index, 1);
      writeRecord(record);
    });
    recordEvent({ type: 'passkey-removed', method: metadata.method || 'password', detail: removed.name, ...metadata });
  }

  async function rotateRecoveryCodes(metadata = {}) {
    if (!readRecord()) throw new SecurityError('FoxOS is not configured', 409, 'auth-not-configured');
    const plainCodes = Array.from({ length: 10 }, () => displayRecoveryCode(randomBytes(10)));
    const salt = randomBytes(24).toString('base64url');
    const now = new Date(clock()).toISOString();
    await queueMutation(async () => {
      const record = securityFields(readRecord(), randomBytes);
      record.recovery = {
        salt,
        generatedAt: now,
        needsRotation: false,
        codes: plainCodes.map((code) => ({
          id: 'rcv_' + randomBytes(8).toString('hex'),
          digest: recoveryCodeDigest(salt, code),
          createdAt: now,
          usedAt: null
        }))
      };
      writeRecord(record);
    });
    recordEvent({ type: 'recovery-codes-created', method: metadata.method || 'password', ...metadata });
    return plainCodes;
  }

  async function resetPasswordWithRecovery(code, newPassword, metadata = {}) {
    const rawRecord = readRecord();
    if (!rawRecord) throw new SecurityError('FoxOS is not configured', 409, 'auth-not-configured');
    const record = securityFields(rawRecord, randomBytes);
    const validation = validateNewPassword(newPassword, { username: record.username });
    if (!validation.ok) throw new SecurityError('New password does not meet the security policy', 400, validation.code);
    if (!record.recovery.salt || !record.recovery.codes.length) {
      throw new SecurityError('Recovery is not configured', 409, 'recovery-not-configured');
    }
    const supplied = Buffer.from(recoveryCodeDigest(record.recovery.salt, code), 'hex');
    const match = record.recovery.codes.find((candidate) => {
      if (candidate.usedAt) return false;
      const expected = Buffer.from(candidate.digest, 'hex');
      return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    });
    if (!match) throw new SecurityError('Recovery code is invalid', 401, 'recovery-code-invalid');
    const credential = await createPasswordCredential(newPassword, { now: new Date(clock()).toISOString() });
    await queueMutation(async () => {
      const latest = securityFields(readRecord(), randomBytes);
      const latestMatch = latest.recovery.codes.find((candidate) => candidate.id === match.id && !candidate.usedAt);
      if (!latestMatch) throw new SecurityError('Recovery code was already used', 409, 'recovery-code-used');
      const currentDigest = Buffer.from(recoveryCodeDigest(latest.recovery.salt, code), 'hex');
      const expected = Buffer.from(latestMatch.digest, 'hex');
      if (currentDigest.length !== expected.length || !crypto.timingSafeEqual(currentDigest, expected)) {
        throw new SecurityError('Recovery code is invalid', 401, 'recovery-code-invalid');
      }
      latestMatch.usedAt = new Date(clock()).toISOString();
      latest.recovery.needsRotation = true;
      writeRecord(applyPasswordCredential(latest, credential));
    });
    recordEvent({ type: 'password-recovered', method: 'recovery', ...metadata });
    return { username: record.username };
  }

  function listEvents(limit = 100) {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
    return readEventLines().slice(-boundedLimit).reverse();
  }

  return {
    beginPasskeyAuthentication,
    beginPasskeyRegistration,
    changePassword,
    finishPasskeyAuthentication,
    finishPasskeyRegistration,
    listEvents,
    readRecord,
    recordEvent,
    removePasskey,
    renamePasskey,
    resetPasswordWithRecovery,
    rotateRecoveryCodes,
    status,
    verifyOwnerPassword,
    writeRecord
  };
}

module.exports = {
  SecurityError,
  createSecurityManager,
  normalizeClient,
  normalizeContext,
  normalizeRecoveryCode,
  safePasskey
};
