const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('recovery CLI accepts container-safe credential JSON on stdin without echoing values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-recovery-cli-test-'));
  const input = JSON.stringify({
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key'
  });
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'recoveryCli.js'),
      'configure-s3',
      '--endpoint', 'https://objects.example.test',
      '--bucket', 'foxos-backups',
      '--credentials-stdin'
    ], {
      cwd: __dirname,
      encoding: 'utf8',
      env: { ...process.env, DATA_ROOT: root },
      input
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('test-access-key'), false);
    assert.equal(result.stdout.includes('test-secret-key'), false);
    const status = JSON.parse(result.stdout);
    assert.equal(status.ready, true);
    assert.equal(status.credentialsIncluded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
