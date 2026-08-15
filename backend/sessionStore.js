const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;
const DEFAULT_MAX_SESSIONS = 64;
const AUTH_METHODS = new Set(['password', 'passkey', 'recovery', 'maintenance']);

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function boundedText(value, maxLength = 128) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
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

function createSessionStore({
  filePath,
  ttlMs,
  idleTtlMs = Math.min(ttlMs, 30 * 60 * 1000),
  touchIntervalMs = Math.min(5 * 60 * 1000, Math.max(1, Math.floor(idleTtlMs / 4))),
  maxSessions = DEFAULT_MAX_SESSIONS,
  clock = () => Date.now(),
  randomBytes = crypto.randomBytes,
  onError = () => {}
}) {
  if (
    typeof filePath !== 'string' || !path.isAbsolute(filePath) ||
    !Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
    !Number.isSafeInteger(idleTtlMs) || idleTtlMs <= 0 || idleTtlMs > ttlMs ||
    !Number.isSafeInteger(touchIntervalMs) || touchIntervalMs <= 0 || touchIntervalMs > idleTtlMs ||
    !Number.isSafeInteger(maxSessions) || maxSessions <= 0 || maxSessions > 1024
  ) {
    throw new TypeError('Invalid session store configuration');
  }

  const sessions = new Map();

  function persist() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryFile = filePath + '.tmp-' + process.pid;
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      sessions: [...sessions.entries()]
        .map(([hash, session]) => ({ tokenHash: hash, ...session }))
        .sort((left, right) => left.expiresAt - right.expiresAt)
    };
    fs.writeFileSync(temporaryFile, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(temporaryFile, filePath);
    fs.chmodSync(filePath, 0o600);
  }

  function expired(session, now) {
    return !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= now ||
      !Number.isSafeInteger(session.idleExpiresAt) || session.idleExpiresAt <= now;
  }

  function pruneExpired(now = clock(), write = true) {
    let changed = false;
    for (const [hash, session] of sessions.entries()) {
      if (expired(session, now)) {
        sessions.delete(hash);
        changed = true;
      }
    }
    if (changed && write) persist();
    return changed;
  }

  function validStoredSession(session, now) {
    return Boolean(
      session && typeof session === 'object' &&
      typeof session.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(session.tokenHash) &&
      typeof session.username === 'string' && session.username.length > 0 && session.username.length <= 256 &&
      typeof session.id === 'string' && /^ses_[a-f0-9]{32}$/.test(session.id) &&
      Number.isSafeInteger(session.createdAt) && session.createdAt > 0 && session.createdAt <= now &&
      Number.isSafeInteger(session.lastSeenAt) && session.lastSeenAt >= session.createdAt &&
      Number.isSafeInteger(session.authenticatedAt) && session.authenticatedAt >= session.createdAt &&
      Number.isSafeInteger(session.expiresAt) && session.expiresAt > now &&
      Number.isSafeInteger(session.idleExpiresAt) && session.idleExpiresAt > now &&
      session.idleExpiresAt <= session.expiresAt && AUTH_METHODS.has(session.authMethod)
    );
  }

  function migrateLegacySession(session, now) {
    if (
      !session || typeof session !== 'object' ||
      typeof session.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(session.tokenHash) ||
      typeof session.username !== 'string' || !session.username || session.username.length > 256 ||
      !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= now
    ) return null;
    return {
      tokenHash: session.tokenHash,
      id: 'ses_' + randomBytes(16).toString('hex'),
      username: session.username,
      createdAt: now,
      authenticatedAt: now,
      lastSeenAt: now,
      expiresAt: session.expiresAt,
      idleExpiresAt: Math.min(session.expiresAt, now + idleTtlMs),
      authMethod: 'password',
      client: normalizeClient(null)
    };
  }

  function load() {
    if (!fs.existsSync(filePath)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (![1, SCHEMA_VERSION].includes(payload.schemaVersion) || !Array.isArray(payload.sessions)) {
        throw new Error('Unsupported session store schema');
      }
      const now = clock();
      const source = payload.schemaVersion === 1
        ? payload.sessions.map((session) => migrateLegacySession(session, now)).filter(Boolean)
        : payload.sessions;
      const valid = source.filter((session) => validStoredSession(session, now))
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, maxSessions);
      for (const session of valid) {
        sessions.set(session.tokenHash, {
          id: session.id,
          username: session.username,
          createdAt: session.createdAt,
          authenticatedAt: session.authenticatedAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          idleExpiresAt: session.idleExpiresAt,
          authMethod: session.authMethod,
          client: normalizeClient(session.client)
        });
      }
      if (payload.schemaVersion !== SCHEMA_VERSION || valid.length !== payload.sessions.length) persist();
    } catch (error) {
      sessions.clear();
      onError(error);
    }
  }

  function create(username, { authMethod = 'password', client = null } = {}) {
    if (typeof username !== 'string' || !username || username.length > 256 || !AUTH_METHODS.has(authMethod)) {
      throw new TypeError('Invalid session identity');
    }
    const now = clock();
    pruneExpired(now, false);
    let token;
    let hash;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      token = randomBytes(32).toString('base64url');
      hash = tokenHash(token);
      if (!sessions.has(hash)) break;
      token = null;
    }
    if (!token) throw new Error('Could not allocate a session token');
    sessions.set(hash, {
      id: 'ses_' + randomBytes(16).toString('hex'),
      username,
      createdAt: now,
      authenticatedAt: now,
      lastSeenAt: now,
      expiresAt: now + ttlMs,
      idleExpiresAt: now + idleTtlMs,
      authMethod,
      client: normalizeClient(client)
    });
    while (sessions.size > maxSessions) {
      const oldest = [...sessions.entries()].sort((left, right) => (
        left[1].lastSeenAt - right[1].lastSeenAt
      ))[0];
      sessions.delete(oldest[0]);
    }
    persist();
    return token;
  }

  function get(token, { touch = true } = {}) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const hash = tokenHash(token);
    const session = sessions.get(hash);
    if (!session) return null;
    const now = clock();
    if (expired(session, now)) {
      sessions.delete(hash);
      persist();
      return null;
    }
    let touched = false;
    if (touch && now - session.lastSeenAt >= touchIntervalMs) {
      session.lastSeenAt = now;
      session.idleExpiresAt = Math.min(session.expiresAt, now + idleTtlMs);
      touched = true;
      persist();
    }
    return { ...session, client: { ...session.client }, touched };
  }

  function remove(token) {
    if (typeof token !== 'string') return false;
    const removed = sessions.delete(tokenHash(token));
    if (removed) persist();
    return removed;
  }

  function removeById(id) {
    for (const [hash, session] of sessions.entries()) {
      if (session.id !== id) continue;
      sessions.delete(hash);
      persist();
      return { removed: true, tokenHash: hash, session: { ...session, client: { ...session.client } } };
    }
    return { removed: false, tokenHash: null, session: null };
  }

  function removeOthers(token) {
    const currentHash = tokenHash(token);
    const removed = [];
    for (const [hash, session] of sessions.entries()) {
      if (hash === currentHash) continue;
      removed.push({ tokenHash: hash, session: { ...session, client: { ...session.client } } });
      sessions.delete(hash);
    }
    if (removed.length) persist();
    return removed;
  }

  function removeAll() {
    const removed = [...sessions.entries()].map(([hash, session]) => ({
      tokenHash: hash,
      session: { ...session, client: { ...session.client } }
    }));
    sessions.clear();
    if (removed.length) persist();
    return removed;
  }

  function list(currentToken) {
    const now = clock();
    pruneExpired(now);
    const currentHash = typeof currentToken === 'string' ? tokenHash(currentToken) : null;
    return [...sessions.entries()].map(([hash, session]) => ({
      id: session.id,
      current: hash === currentHash,
      createdAt: new Date(session.createdAt).toISOString(),
      authenticatedAt: new Date(session.authenticatedAt).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      idleExpiresAt: new Date(session.idleExpiresAt).toISOString(),
      authMethod: session.authMethod,
      client: { ...session.client }
    })).sort((left, right) => Number(right.current) - Number(left.current) ||
      Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
  }

  load();

  return {
    create,
    get,
    list,
    prune: () => pruneExpired(),
    remove,
    removeAll,
    removeById,
    removeOthers,
    size: () => sessions.size
  };
}

module.exports = { createSessionStore, tokenHash };
