const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-test-'));
process.env.DATA_ROOT = path.join(testRoot, 'data');
process.env.HOST_ROOT = testRoot;
process.env.HOST_EXECUTION = 'local';

const app = require('./server');
const server = app.listen(0, '127.0.0.1');

const baseUrl = () => {
  const address = server.address();
  return 'http://127.0.0.1:' + address.port;
};

test.after(() => {
  server.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('health is public while management APIs require a session', async () => {
  const healthResponse = await fetch(baseUrl() + '/api/health');
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok' });

  const filesResponse = await fetch(baseUrl() + '/api/files');
  assert.equal(filesResponse.status, 401);
});

test('setup creates an authenticated session and unlocks the workspace', async () => {
  const weakPasswordResponse = await fetch(baseUrl() + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'short' })
  });
  assert.equal(weakPasswordResponse.status, 400);

  const setupResponse = await fetch(baseUrl() + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'correct-horse-battery' })
  });
  assert.equal(setupResponse.status, 201);
  const cookie = setupResponse.headers.get('set-cookie').split(';')[0];

  const statusResponse = await fetch(baseUrl() + '/api/auth/status', {
    headers: { Cookie: cookie }
  });
  assert.deepEqual(await statusResponse.json(), {
    isSetup: true,
    authenticated: true,
    username: 'tester'
  });

  const filesResponse = await fetch(baseUrl() + '/api/files?path=%2F', {
    headers: { Cookie: cookie }
  });
  assert.equal(filesResponse.status, 200);
  const workspace = await filesResponse.json();
  assert.ok(workspace.items.some((entry) => entry.name === 'Sunucu' && entry.symlink));

  const terminalResponse = await fetch(baseUrl() + '/api/terminal', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'printf foxos-ok', cwd: '/' })
  });
  assert.equal(terminalResponse.status, 200);
  assert.equal((await terminalResponse.json()).output, 'foxos-ok');
});
