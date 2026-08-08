const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('stateless CLI reports the lazy compiler while every execution surface stays sealed', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateless-cli-'));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'statelessMigrationCli.js'),
    'status'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_ROOT: dataRoot,
      DOCKER_SOCKET: path.join(dataRoot, 'absent-docker.sock')
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.executionGate.status, 'sealed');
  assert.equal(status.executionGate.manifestCompilerConfigured, true);
  assert.equal(status.executionGate.runtimeAdapterConfigured, false);
  assert.equal(status.executionGate.uiApprovalConfigured, false);
  assert.equal(status.executionGate.runEndpointExposed, false);
  assert.equal(status.executionGate.approveEndpointExposed, false);
  assert.equal(status.guarantees.sourceStopAllowed, false);
  assert.equal(status.guarantees.providerDetachIncluded, false);
  assert.equal(status.summary.plans, 0);
  assert.equal(status.summary.operations, 0);
  assert.equal(fs.existsSync(path.join(dataRoot, 'security', 'master-key')), false);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});
