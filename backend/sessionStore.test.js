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

test('sessions survive process recreation without storing bearer tokens', (t) => {
  const filePath = fixture(t);
  const now = 1000;
  const tokenBytes = Buffer.alloc(32, 7);
  const first = createSessionStore({
    filePath,
    ttlMs: 12000,
    renewalWindowMs: 6000,
    clock: () => now,
    randomBytes: () => tokenBytes
  });
  const token = first.create('owner');
  const stored = fs.readFileSync(filePath, 'utf8');
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(tokenHash(token)), true);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const replacement = createSessionStore({
    filePath,
    ttlMs: 12000,
    renewalWindowMs: 6000,
    clock: () => now
  });
  assert.deepEqual(replacement.get(token), {
    username: 'owner',
    expiresAt: 13000,
    renewed: false
  });
});

test('active sessions renew sparsely and the renewed expiry persists', (t) => {
  const filePath = fixture(t);
  let now = 1000;
  const store = createSessionStore({
    filePath,
    ttlMs: 12000,
    renewalWindowMs: 6000,
    clock: () => now
  });
  const token = store.create('owner');

  now = 6500;
  assert.equal(store.get(token).renewed, false);
  now = 7000;
  assert.deepEqual(store.get(token), {
    username: 'owner',
    expiresAt: 19000,
    renewed: true
  });

  const replacement = createSessionStore({
    filePath,
    ttlMs: 12000,
    renewalWindowMs: 6000,
    clock: () => now
  });
  assert.equal(replacement.get(token).expiresAt, 19000);
  now = 19000;
  assert.equal(replacement.get(token), null);
});

test('logout persists removal and corrupt stores fail closed', (t) => {
  const filePath = fixture(t);
  const errors = [];
  const store = createSessionStore({ filePath, ttlMs: 12000, clock: () => 1000 });
  const token = store.create('owner');
  assert.equal(store.remove(token), true);
  assert.equal(createSessionStore({ filePath, ttlMs: 12000, clock: () => 1000 }).get(token), null);

  fs.writeFileSync(filePath, '{broken', { mode: 0o600 });
  const corrupt = createSessionStore({
    filePath,
    ttlMs: 12000,
    clock: () => 1000,
    onError: (error) => errors.push(error.message)
  });
  assert.equal(corrupt.size(), 0);
  assert.equal(errors.length, 1);
});
