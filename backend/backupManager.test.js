const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBackupManager, endpointIsOffHost } = require('./backupManager');
const { createEncryptionStore } = require('./encryptionStore');

test('encrypted backup is uploaded, downloaded, authenticated and never persisted as plaintext', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-backup-test-'));
  const objects = new Map();
  try {
    const objectStore = {
      putObject: async ({ key, body, metadata }) => {
        objects.set(key, { body: Buffer.from(body), metadata: { ...metadata } });
        return { etag: 'test-etag' };
      },
      headObject: async ({ key }) => {
        const object = objects.get(key);
        return { bytes: object.body.length, etag: 'test-etag', metadata: object.metadata };
      },
      getObject: async ({ key }) => Buffer.from(objects.get(key).body)
    };
    const manager = createBackupManager({
      dataRoot: root,
      encryptionStore: createEncryptionStore({ dataRoot: root }),
      objectStore,
      objectStoreConfig: {
        schemaVersion: 1,
        adapter: 's3-compatible',
        endpoint: 'https://objects.example.test',
        bucket: 'foxos-backups',
        prefix: 'foxos'
      },
      clock: () => new Date('2026-08-04T15:00:00.000Z')
    });
    const archive = Buffer.from('plain archive data that must not be stored');
    const result = await manager.protectArchive({
      operationId: 'op_' + '2'.repeat(32),
      resourceId: 'res_' + '1'.repeat(32),
      volumeName: 'pilot-data',
      archive,
      contentDigest: 'sha256:' + '3'.repeat(64)
    });

    assert.deepEqual(result.archive, archive);
    assert.equal(result.record.remote.uploaded, true);
    assert.equal(result.record.remote.downloaded, true);
    assert.equal(result.record.plaintextArchiveStored, false);
    const localEncrypted = fs.readFileSync(path.join(root, result.record.encryptedArchiveFile));
    assert.equal(localEncrypted.includes(archive), false);
    assert.equal(fs.statSync(path.join(root, result.record.encryptedArchiveFile)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('off-host gate rejects loopback and non-TLS endpoints', () => {
  assert.equal(endpointIsOffHost('https://objects.example.test'), true);
  assert.equal(endpointIsOffHost('http://objects.example.test'), false);
  assert.equal(endpointIsOffHost('https://127.0.0.1:9000'), false);
});

test('downloaded ciphertext tampering fails before restore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-backup-test-'));
  let stored;
  try {
    const manager = createBackupManager({
      dataRoot: root,
      encryptionStore: createEncryptionStore({ dataRoot: root }),
      objectStore: {
        putObject: async ({ body, metadata }) => {
          stored = { body: Buffer.from(body), metadata: { ...metadata } };
          return { etag: 'test-etag' };
        },
        headObject: async () => ({
          bytes: stored.body.length,
          etag: 'test-etag',
          metadata: stored.metadata
        }),
        getObject: async () => {
          const tampered = Buffer.from(stored.body);
          tampered[tampered.length - 1] ^= 1;
          return tampered;
        }
      },
      objectStoreConfig: {
        schemaVersion: 1,
        adapter: 's3-compatible',
        endpoint: 'https://objects.example.test',
        bucket: 'foxos-backups',
        prefix: 'foxos'
      }
    });

    await assert.rejects(
      manager.protectArchive({
        operationId: 'op_' + '2'.repeat(32),
        resourceId: 'res_' + '1'.repeat(32),
        volumeName: 'pilot-data',
        archive: Buffer.from('archive'),
        contentDigest: 'sha256:' + '3'.repeat(64)
      }),
      (error) => error.code === 'off-host-backup-digest-mismatch'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S3 configuration encrypts credentials separately with owner-only permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-backup-test-'));
  try {
    const manager = createBackupManager({
      dataRoot: root,
      encryptionStore: createEncryptionStore({ dataRoot: root }),
      clock: () => new Date('2026-08-04T15:00:00.000Z')
    });
    const status = manager.configureS3({
      endpoint: 'https://objects.example.test',
      bucket: 'foxos-backups',
      prefix: 'foxos',
      region: 'auto',
      accessKeyId: 'scoped-access-key',
      secretAccessKey: 'scoped-secret-key'
    });

    assert.equal(status.ready, true);
    assert.equal(fs.statSync(manager.paths.credentialsFile).mode & 0o777, 0o600);
    const encryptedCredentials = fs.readFileSync(manager.paths.credentialsFile);
    assert.equal(encryptedCredentials.includes('scoped-access-key'), false);
    assert.equal(encryptedCredentials.includes('scoped-secret-key'), false);
    const config = fs.readFileSync(manager.paths.configFile, 'utf8');
    assert.equal(config.includes('scoped-access-key'), false);
    assert.equal(config.includes('scoped-secret-key'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
