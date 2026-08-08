const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const MAINTENANCE_SESSION_SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

class MaintenanceSessionError extends Error {
  constructor(message, statusCode = 403, code = 'maintenance-session-error') {
    super(message);
    this.name = 'MaintenanceSessionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createMaintenanceSessionManager({
  dataRoot,
  clock = () => new Date(),
  randomBytes = (size) => crypto.randomBytes(size),
  ttlMs = DEFAULT_TTL_MS
}) {
  if (!dataRoot || !Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > DEFAULT_TTL_MS) {
    throw new Error('Maintenance session manager requires a bounded data root and TTL');
  }
  const root = path.join(dataRoot, 'maintenance-session');
  const grantFile = path.join(root, 'grant.json');

  function nowMs() {
    return new Date(clock()).getTime();
  }

  function issue() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const token = randomBytes(32).toString('base64url');
    if (!TOKEN_PATTERN.test(token)) throw new Error('Maintenance session token generation failed');
    const issuedAtMs = nowMs();
    const issuedAt = new Date(issuedAtMs).toISOString();
    const expiresAt = new Date(issuedAtMs + ttlMs).toISOString();
    atomicWriteJson(grantFile, {
      schemaVersion: MAINTENANCE_SESSION_SCHEMA_VERSION,
      tokenDigest: digest(token),
      issuedAt,
      expiresAt,
      consumed: false
    });
    return { token, issuedAt, expiresAt };
  }

  function consume(token) {
    if (!TOKEN_PATTERN.test(String(token || ''))) {
      throw new MaintenanceSessionError('Maintenance grant is invalid', 403, 'maintenance-grant-invalid');
    }
    let grant;
    try {
      grant = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
    } catch (error) {
      throw new MaintenanceSessionError(
        'Maintenance grant is unavailable',
        403,
        error.code === 'ENOENT' ? 'maintenance-grant-unavailable' : 'maintenance-grant-invalid'
      );
    }
    const expiresAt = Date.parse(grant.expiresAt);
    if (
      grant.schemaVersion !== MAINTENANCE_SESSION_SCHEMA_VERSION || grant.consumed !== false ||
      !Number.isFinite(expiresAt) || expiresAt <= nowMs() ||
      !/^[a-f0-9]{64}$/.test(String(grant.tokenDigest || ''))
    ) {
      try { fs.unlinkSync(grantFile); } catch { /* already absent */ }
      throw new MaintenanceSessionError('Maintenance grant expired or is invalid', 403, 'maintenance-grant-invalid');
    }
    const expected = Buffer.from(grant.tokenDigest, 'hex');
    const supplied = Buffer.from(digest(token), 'hex');
    if (!crypto.timingSafeEqual(expected, supplied)) {
      throw new MaintenanceSessionError('Maintenance grant is invalid', 403, 'maintenance-grant-invalid');
    }
    fs.unlinkSync(grantFile);
    return { consumed: true, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt };
  }

  return { consume, issue, paths: { grantFile, root } };
}

module.exports = {
  MAINTENANCE_SESSION_SCHEMA_VERSION,
  MaintenanceSessionError,
  createMaintenanceSessionManager
};
