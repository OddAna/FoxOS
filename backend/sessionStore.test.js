const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSessionStore, tokenHash } = require('./sessionStore');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'sessions.json');
}

function deterministicBytes() {
  let seed = 1;
  return (size) => Buffer.alloc(size, seed++);
}

test('sessions survive process recreation without storing bearer tokens', (t) => {
  const filePath = fixture(t);
  const now = 1000;
  const first = createSessionStore({
    filePath,
    ttlMs: 12000,
    idleTtlMs: 6000,
    touchIntervalMs: 1000,
    clock: () => now,
    randomBytes: deterministicBytes()
  });
  const token = first.create('owner', {
    authMethod: 'passkey',
    client: { browser: 'Safari', os: 'macOS', device: 'desktop', network: 'local' }
  });
  const stored = fs.readFileSync(filePath, 'utf8');
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(tokenHash(token)), true);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const replacement = createSessionStore({
    filePath,
    ttlMs: 12000,
    idleTtlMs: 6000,
    touchIntervalMs: 1000,
    clock: () => now
  });
  const session = replacement.get(token);
  assert.equal(session.id, 'ses_' + Buffer.alloc(16, 2).toString('hex'));
  assert.equal(session.username, 'owner');
  assert.equal(session.authMethod, 'passkey');
  assert.equal(session.expiresAt, 13000);
  assert.equal(session.idleExpiresAt, 7000);
  assert.equal(session.touched, false);
  assert.equal(replacement.list(token)[0].current, true);
});

test('idle activity is touched sparsely without extending the absolute lifetime', (t) => {
  const filePath = fixture(t);
  let now = 1000;
  const store = createSessionStore({
    filePath,
    ttlMs: 12000,
    idleTtlMs: 4000,
    touchIntervalMs: 1000,
    clock: () => now
  });
  const token = store.create('owner');

  now = 1500;
  assert.equal(store.get(token).touched, false);
  now = 2000;
  assert.equal(store.get(token).touched, true);
  assert.equal(store.get(token).idleExpiresAt, 6000);
  now = 5500;
  const active = store.get(token);
  assert.equal(active.touched, true);
  assert.equal(active.idleExpiresAt, 9500);
  assert.equal(active.expiresAt, 13000);
  now = 9400;
  assert.equal(store.get(token).expiresAt, 13000);
  now = 13000;
  assert.equal(store.get(token), null);
});

test('sessions can be listed and revoked without exposing token hashes', (t) => {
  const filePath = fixture(t);
  let now = 1000;
  const store = createSessionStore({ filePath, ttlMs: 12000, idleTtlMs: 6000, clock: () => now });
  const current = store.create('owner', { authMethod: 'password' });
  now = 1100;
  const other = store.create('owner', { authMethod: 'passkey' });
  const sessions = store.list(current);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].current, true);
  assert.equal(JSON.stringify(sessions).includes('tokenHash'), false);

  const removed = store.removeById(store.list(other)[0].id);
  assert.equal(removed.removed, true);
  assert.match(removed.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(store.size(), 1);

  store.create('owner');
  assert.equal(store.removeOthers(current).length, 1);
  assert.equal(store.size(), 1);
});

test('legacy session stores migrate in place and corrupt stores fail closed', (t) => {
  const filePath = fixture(t);
  const token = Buffer.alloc(32, 9).toString('base64url');
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    sessions: [{ tokenHash: tokenHash(token), username: 'owner', expiresAt: 13000 }]
  }), { mode: 0o600 });
  const store = createSessionStore({
    filePath,
    ttlMs: 12000,
    idleTtlMs: 6000,
    clock: () => 1000,
    randomBytes: deterministicBytes()
  });
  assert.equal(store.get(token).username, 'owner');
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).schemaVersion, 2);
  assert.equal(store.remove(token), true);

  fs.writeFileSync(filePath, '{broken', { mode: 0o600 });
  const errors = [];
  const corrupt = createSessionStore({
    filePath,
    ttlMs: 12000,
    clock: () => 1000,
    onError: (error) => errors.push(error.message)
  });
  assert.equal(corrupt.size(), 0);
  assert.equal(errors.length, 1);
});
