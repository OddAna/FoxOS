const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplicationComposeManager, SAVE_COMPOSE_CONFIRMATION } = require('./applicationComposeManager');
const { createEncryptionStore } = require('./encryptionStore');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-app-compose-'));
  const dataRoot = path.join(root, 'data');
  const hostRoot = path.join(root, 'host');
  const hostPath = '/srv/example/compose.yaml';
  const mountedPath = path.join(hostRoot, 'srv/example/compose.yaml');
  fs.mkdirSync(path.dirname(mountedPath), { recursive: true });
  fs.writeFileSync(mountedPath, 'services:\n  web:\n    image: nginx:1.27\n', { mode: 0o640 });
  const applicationId = 'res_' + 'a'.repeat(32);
  const containerId = 'b'.repeat(64);
  const details = {
    Config: {
      Labels: {
        'com.docker.compose.project': 'example',
        'com.docker.compose.service': 'web',
        'com.docker.compose.project.working_dir': '/srv/example',
        'com.docker.compose.project.config_files': hostPath,
        'coolify.type': 'application'
      }
    }
  };
  const manager = createApplicationComposeManager({
    dataRoot,
    hostRoot,
    dockerRequest: async (method, requestPath) => {
      assert.equal(method, 'GET');
      assert.equal(requestPath, '/containers/' + containerId + '/json');
      return details;
    },
    encryptionStore: createEncryptionStore({ dataRoot }),
    getApplicationInventory: async () => ({
      applications: [{ id: applicationId, runtime: { containerId } }]
    }),
    clock: () => new Date('2026-08-07T10:00:00.000Z'),
    randomUUID: () => '11111111-2222-3333-4444-555555555555'
  });
  return { applicationId, dataRoot, hostPath, manager, mountedPath };
}

test('application Compose manager reads exact Docker-labelled files and saves atomically with encrypted backup', async () => {
  const { applicationId, manager, mountedPath } = fixture();
  const source = await manager.describe(applicationId);
  assert.equal(source.editable, true);
  assert.equal(source.providerMayOverwrite, true);
  assert.equal(source.serviceName, 'web');
  assert.equal(source.files.length, 1);

  const content = 'services:\n  web:\n    image: nginx:1.28\n';
  const saved = await manager.save(applicationId, source.files[0].fileId, {
    confirmation: SAVE_COMPOSE_CONFIRMATION,
    content,
    revision: source.files[0].revision
  });
  assert.equal(saved.changed, true);
  assert.equal(fs.readFileSync(mountedPath, 'utf8'), content);
  assert.equal(fs.statSync(mountedPath).mode & 0o777, 0o640);

  const backupFile = path.join(
    manager.paths.backupsRoot,
    applicationId,
    'composeop_11111111222233334444555555555555.enc'
  );
  assert.equal(fs.readFileSync(backupFile).subarray(0, 9).toString('ascii'), 'FOXOSENC1');
  const operation = JSON.parse(fs.readFileSync(path.join(
    manager.paths.operationsRoot,
    'composeop_11111111222233334444555555555555.json'
  ), 'utf8'));
  assert.equal(operation.status, 'completed');
  assert.equal(JSON.stringify(operation).includes('nginx:1.27'), false);
});

test('application Compose manager rejects stale revisions, invalid YAML and removed selected service', async () => {
  const { applicationId, manager } = fixture();
  const source = await manager.describe(applicationId);
  const file = source.files[0];
  await assert.rejects(() => manager.save(applicationId, file.fileId, {
    confirmation: SAVE_COMPOSE_CONFIRMATION,
    content: file.content,
    revision: 'sha256:' + '0'.repeat(64)
  }), /sunucuda değişti/);
  await assert.rejects(() => manager.save(applicationId, file.fileId, {
    confirmation: SAVE_COMPOSE_CONFIRMATION,
    content: 'services: [',
    revision: file.revision
  }), /Compose YAML geçersiz/);
  await assert.rejects(() => manager.save(applicationId, file.fileId, {
    confirmation: SAVE_COMPOSE_CONFIRMATION,
    content: 'services:\n  api:\n    image: nginx\n',
    revision: file.revision
  }), /web servisi/);
});

test('application Compose manager returns a clear unsupported state when labels are absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-app-compose-'));
  const applicationId = 'app_' + 'c'.repeat(32);
  const containerId = 'd'.repeat(64);
  const dataRoot = path.join(root, 'data');
  const manager = createApplicationComposeManager({
    dataRoot,
    hostRoot: path.join(root, 'host'),
    dockerRequest: async () => ({ Config: { Labels: {} } }),
    encryptionStore: createEncryptionStore({ dataRoot }),
    getApplicationInventory: async () => ({ applications: [{ id: applicationId, runtime: { containerId } }] })
  });
  const source = await manager.describe(applicationId);
  assert.equal(source.editable, false);
  assert.match(source.reason, /metadata/);
});
