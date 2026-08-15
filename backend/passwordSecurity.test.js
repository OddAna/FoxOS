const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  PASSWORD_MIN_LENGTH,
  applyPasswordCredential,
  createPasswordCredential,
  validateNewPassword,
  verifyPassword
} = require('./passwordSecurity');

test('new passwords use a long passphrase policy without composition rules', () => {
  assert.equal(PASSWORD_MIN_LENGTH, 15);
  assert.equal(validateNewPassword('short').code, 'password-too-short');
  assert.equal(validateNewPassword('passwordpassword').code, 'password-common');
  assert.equal(validateNewPassword('burak için benzersiz uzun parola', { username: 'burak' }).code, 'password-common');
  assert.equal(validateNewPassword('iki sözcük ve 2026 için uzun bir ifade').ok, true);
});

test('modern password credentials verify safely and remove legacy fields', async () => {
  const credential = await createPasswordCredential('iki sözcük ve 2026 için uzun bir ifade');
  const record = applyPasswordCredential({ version: 3, username: 'owner', salt: 'old', passwordHash: 'old' }, credential);
  assert.equal(record.version, 4);
  assert.equal('salt' in record, false);
  assert.equal('passwordHash' in record, false);
  assert.deepEqual(await verifyPassword('yanlış parola değeri', record), { matched: false, needsUpgrade: false });
  assert.deepEqual(await verifyPassword('iki sözcük ve 2026 için uzun bir ifade', record), {
    matched: true,
    needsUpgrade: false
  });
});

test('legacy scrypt records remain readable and are marked for upgrade', async () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync('correct-horse-battery', salt, 64).toString('hex');
  assert.deepEqual(await verifyPassword('correct-horse-battery', { salt, passwordHash }), {
    matched: true,
    needsUpgrade: true
  });
  assert.equal((await verifyPassword('wrong-password-value', { salt, passwordHash })).matched, false);
});
