const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_SESSIONS = 64;

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function createSessionStore({
  filePath,
  ttlMs,
  renewalWindowMs = Math.floor(ttlMs / 2),
  maxSessions = DEFAULT_MAX_SESSIONS,
  clock = () => Date.now(),
  randomBytes = crypto.randomBytes,
  onError = () => {}
}) {
  if (
    typeof filePath !== 'string' || !path.isAbsolute(filePath) ||
    !Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
    !Number.isSafeInteger(renewalWindowMs) || renewalWindowMs < 0 || renewalWindowMs >= ttlMs ||
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

  function pruneExpired(now = clock(), write = true) {
    let changed = false;
    for (const [hash, session] of sessions.entries()) {
      if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= now) {
        sessions.delete(hash);
        changed = true;
      }
    }
    if (changed && write) persist();
    return changed;
  }

  function load() {
    if (!fs.existsSync(filePath)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (payload.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.sessions)) {
        throw new Error('Unsupported session store schema');
      }
      const now = clock();
      const valid = payload.sessions.filter((session) => (
        session && typeof session === 'object' &&
        typeof session.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(session.tokenHash) &&
        typeof session.username === 'string' && session.username.length > 0 && session.username.length <= 256 &&
        Number.isSafeInteger(session.expiresAt) && session.expiresAt > now
      )).sort((left, right) => right.expiresAt - left.expiresAt).slice(0, maxSessions);
      for (const session of valid) {
        sessions.set(session.tokenHash, {
          username: session.username,
          expiresAt: session.expiresAt
        });
      }
      if (valid.length !== payload.sessions.length) persist();
    } catch (error) {
      sessions.clear();
      onError(error);
    }
  }

  function create(username) {
    if (typeof username !== 'string' || !username || username.length > 256) {
      throw new TypeError('Invalid session username');
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
    sessions.set(hash, { username, expiresAt: now + ttlMs });
    while (sessions.size > maxSessions) {
      const oldest = [...sessions.entries()].sort((left, right) => (
        left[1].expiresAt - right[1].expiresAt
      ))[0];
      sessions.delete(oldest[0]);
    }
    persist();
    return token;
  }

  function get(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const hash = tokenHash(token);
    const session = sessions.get(hash);
    if (!session) return null;
    const now = clock();
    if (session.expiresAt <= now) {
      sessions.delete(hash);
      persist();
      return null;
    }
    let renewed = false;
    if (session.expiresAt - now <= renewalWindowMs) {
      session.expiresAt = now + ttlMs;
      renewed = true;
      persist();
    }
    return { ...session, renewed };
  }

  function remove(token) {
    if (typeof token !== 'string') return false;
    const removed = sessions.delete(tokenHash(token));
    if (removed) persist();
    return removed;
  }

  load();

  return {
    create,
    get,
    prune: () => pruneExpired(),
    remove,
    size: () => sessions.size
  };
}

module.exports = { createSessionStore, tokenHash };
