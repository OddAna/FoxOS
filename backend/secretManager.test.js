const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptionStore } = require('./encryptionStore');
const { createSecretManager } = require('./secretManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);

test('secret and environment revisions persist references without plaintext secret values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-secret-test-'));
  try {
    const encryptionStore = createEncryptionStore({ dataRoot: root });
    const manager = createSecretManager({
      dataRoot: root,
      encryptionStore,
      clock: () => new Date('2026-08-04T15:00:00.000Z'),
      randomUUID: () => '00000000-0000-4000-8000-000000000123'
    });
    const secret = manager.putSecret('pilot-token', 'highly-sensitive-value');
    const environment = manager.createEnvironmentRevision(RESOURCE_ID, {
      ordinary: { FOXOS_PILOT_MODE: 'disposable' },
      secretRefs: { FOXOS_PILOT_TOKEN: 'pilot-token' }
    });

    assert.equal(secret.valueIncluded, false);
    assert.equal(environment.secretValuesIncluded, false);
    assert.deepEqual(manager.resolveEnvironment(environment), [
      'FOXOS_PILOT_MODE=disposable',
      'FOXOS_PILOT_TOKEN=highly-sensitive-value'
    ]);
    assert.equal(manager.listSecrets()[0].encryptedValue, undefined);
    const persisted = fs.readFileSync(
      path.join(manager.paths.recordsRoot, secret.secretId, 'latest.json'),
      'utf8'
    ) + fs.readFileSync(
      path.join(manager.paths.environmentsRoot, RESOURCE_ID, 'latest.json'),
      'utf8'
    );
    assert.equal(persisted.includes('highly-sensitive-value'), false);
    assert.equal(fs.statSync(manager.paths.secretsRoot).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sensitive-looking names cannot be stored as ordinary environment values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-secret-test-'));
  try {
    const manager = createSecretManager({
      dataRoot: root,
      encryptionStore: createEncryptionStore({ dataRoot: root })
    });
    assert.throws(
      () => manager.createEnvironmentRevision(RESOURCE_ID, {
        ordinary: { DATABASE_URL: 'postgres://user:password@example/db' }
      }),
      (error) => error.code === 'sensitive-environment-must-be-secret'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
