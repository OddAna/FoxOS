const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptionStore } = require('./encryptionStore');

test('AES-GCM envelopes round-trip, bind context and reject tampering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-encryption-test-'));
  try {
    const store = createEncryptionStore({ dataRoot: root });
    const context = { purpose: 'test', revision: 'rev_1' };
    const plaintext = Buffer.from('never persist this value');
    const encrypted = store.encryptBuffer(plaintext, context);

    assert.notEqual(encrypted.includes(plaintext), true);
    assert.deepEqual(store.decryptBuffer(encrypted, context), plaintext);
    assert.equal(fs.statSync(store.paths.securityRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.paths.keyFile).mode & 0o777, 0o600);
    assert.throws(
      () => store.decryptBuffer(encrypted, { purpose: 'different', revision: 'rev_1' }),
      (error) => error.code === 'encryption-context-mismatch'
    );

    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(
      () => store.decryptBuffer(tampered, context),
      (error) => error.code === 'encrypted-envelope-authentication-failed'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
