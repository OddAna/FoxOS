const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DISCONNECT_CONFIRMATION,
  FULL_SERVER_CONFIRMATION,
  INSTALL_CONFIRMATION,
  createAntigravityConnectionManager,
  profileSettings
} = require('./antigravityConnectionManager');

const LOGIN = {
  loginId: 'agylogin_' + 'a'.repeat(32),
  verificationUrl: 'https://accounts.google.com/o/oauth2/auth?state=x&code_challenge=y&code_challenge_method=S256',
  expiresAt: '2026-08-09T18:01:00.000Z'
};

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-antigravity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, 'host-state', '.gemini', 'antigravity-cli', 'settings.json');
  let installed = options.installed === true;
  let connected = options.connected === true;
  let version = options.version || '1.1.11';
  let clockValue = Date.parse('2026-08-09T18:00:00.000Z');
  const calls = { cancel: [], complete: [], install: 0, inspectAccount: 0, logout: 0, start: 0 };
  const manager = createAntigravityConnectionManager({
    dataRoot: root,
    settingsFile,
    inspectCli: async () => ({ installed, version: installed ? version : null }),
    installCli: async () => {
      calls.install += 1;
      installed = true;
    },
    inspectAccount: async () => {
      calls.inspectAccount += 1;
      if (options.inspectAccountError) throw options.inspectAccountError;
      return { connected, authMode: connected ? 'google-oauth' : null };
    },
    loginController: {
      start: async () => {
        calls.start += 1;
        return LOGIN;
      },
      complete: async (loginId, authorizationCode) => {
        calls.complete.push({ loginId, authorizationCode });
        connected = true;
        return { connected: true };
      },
      cancel: async (loginId = null) => {
        calls.cancel.push(loginId);
        return { cancelled: true };
      }
    },
    logoutAccount: async () => {
      calls.logout += 1;
      connected = false;
    },
    clock: () => new Date(clockValue)
  });
  return {
    calls,
    manager,
    root,
    settingsFile,
    advanceClock(milliseconds = 1000) { clockValue += milliseconds; },
    setConnected(value) { connected = value; },
    setInstalled(value, nextVersion = version) { installed = value; version = nextVersion; }
  };
}

test('Antigravity is optional, disconnected and secret-free by default', async (t) => {
  const { manager } = fixture(t);
  const status = await manager.status();
  assert.equal(status.id, 'antigravity-cli');
  assert.equal(status.name, 'Antigravity CLI');
  assert.equal(status.optional, true);
  assert.equal(status.installed, false);
  assert.equal(status.connected, false);
  assert.equal(status.ready, false);
  assert.equal(status.accessProfile, 'read-only');
  assert.equal(status.fullServer, false);
  assert.equal(status.rootEquivalent, false);
  assert.equal(status.approvalPolicy, 'strict');
  assert.equal(status.profileApplied, false);
  assert.equal(status.credentialIncluded, false);
  assert.equal(status.oauthAuthorizationUrlIncluded, false);
  assert.equal(status.accountVerificationConsumesQuota, false);
});

test('Antigravity install requires exact confirmation and applies protected defaults', async (t) => {
  const { calls, manager, settingsFile } = fixture(t);
  await assert.rejects(() => manager.install('yes'), {
    code: 'antigravity-install-confirmation-required',
    statusCode: 400
  });
  const result = await manager.install(INSTALL_CONFIRMATION);
  assert.equal(calls.install, 1);
  assert.equal(result.version, '1.1.11');
  assert.equal(result.connection.installed, true);
  assert.equal(result.connection.connected, false);
  assert.equal(result.connection.profileApplied, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), profileSettings('read-only'));
  assert.equal(fs.statSync(path.dirname(settingsFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
});

test('Antigravity login URL and code are never persisted in FoxOS connection data', async (t) => {
  const { calls, manager, root } = fixture(t, { installed: true });
  const login = await manager.startLogin();
  assert.deepEqual(login, LOGIN);
  const connection = await manager.completeLogin(LOGIN.loginId, '4/0AbCdEf_secret-code');
  assert.equal(connection.connected, true);
  assert.equal(connection.authMethod, 'google-oauth');
  assert.deepEqual(calls.complete, [{
    loginId: LOGIN.loginId,
    authorizationCode: '4/0AbCdEf_secret-code'
  }]);
  const persisted = fs.readFileSync(
    path.join(root, 'connections', 'antigravity-cli', 'config.json'),
    'utf8'
  );
  assert.equal(persisted.includes(LOGIN.verificationUrl), false);
  assert.equal(persisted.includes('4/0AbCdEf_secret-code'), false);
  assert.equal(JSON.stringify(connection).includes(LOGIN.verificationUrl), false);
  assert.equal(JSON.stringify(connection).includes('secret-code'), false);
});

test('Antigravity Full Server requires one exact confirmation and then disables every approval', async (t) => {
  const { manager, settingsFile } = fixture(t, { installed: true, connected: true });
  await manager.verify();
  await assert.rejects(() => manager.setAccessProfile('full-server', 'yes'), {
    code: 'antigravity-full-server-confirmation-required',
    statusCode: 400
  });
  const connection = await manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  assert.equal(connection.fullServer, true);
  assert.equal(connection.rootEquivalent, true);
  assert.equal(connection.workingDirectory, '/');
  assert.equal(connection.approvalPolicy, 'never');
  assert.equal(connection.agentMode, 'accept-edits');
  assert.equal(connection.artifactReviewPolicy, 'always-proceed');
  assert.equal(connection.terminalSandbox, false);
  assert.equal(connection.allowNonWorkspaceAccess, true);
  assert.equal(connection.profileApplied, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), profileSettings('full-server'));
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).permissions, {
    allow: [
      'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)',
      'command(*)', 'unsandboxed(*)', 'mcp(*)'
    ],
    ask: [],
    deny: []
  });
});

test('Antigravity protected profile restores strict plan mode and sandbox', async (t) => {
  const { manager } = fixture(t, { installed: true, connected: true });
  await manager.verify();
  await manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  const connection = await manager.setAccessProfile('read-only');
  assert.equal(connection.fullServer, false);
  assert.equal(connection.approvalPolicy, 'strict');
  assert.equal(connection.agentMode, 'plan');
  assert.equal(connection.artifactReviewPolicy, 'asks-for-review');
  assert.equal(connection.terminalSandbox, true);
  assert.equal(connection.allowNonWorkspaceAccess, false);
});

test('Antigravity Full Server can always be revoked when the CLI is unavailable', async (t) => {
  const { manager, setInstalled } = fixture(t, { installed: true, connected: true });
  await manager.verify();
  await manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  setInstalled(false);
  const protectedConnection = await manager.setAccessProfile('read-only');
  assert.equal(protectedConnection.installed, false);
  assert.equal(protectedConnection.connected, true);
  assert.equal(protectedConnection.accessProfile, 'read-only');
  assert.equal(protectedConnection.profileApplied, true);
});

test('Antigravity Full Server refuses an unconnected account', async (t) => {
  const { manager } = fixture(t, { installed: true });
  await assert.rejects(
    () => manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION),
    { code: 'antigravity-account-not-connected' }
  );
});

test('Antigravity verification refreshes state without model quota and fails closed to protected mode', async (t) => {
  const { advanceClock, manager, setConnected } = fixture(t, { installed: true, connected: true });
  const connected = await manager.verify();
  assert.equal(connected.connected, true);
  assert.equal(connected.accountVerificationConsumesQuota, false);
  await manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  advanceClock(60_000);
  setConnected(false);
  const disconnected = await manager.verify();
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.accessProfile, 'read-only');
  assert.equal(disconnected.profileApplied, true);
  assert.notEqual(disconnected.lastVerifiedAt, connected.lastVerifiedAt);
});

test('Antigravity disconnect logs out, resets protection and preserves the CLI', async (t) => {
  const { calls, manager } = fixture(t, { installed: true, connected: true });
  await manager.verify();
  await manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  await assert.rejects(() => manager.disconnect('yes'), {
    code: 'antigravity-disconnect-confirmation-required',
    statusCode: 400
  });
  const result = await manager.disconnect(DISCONNECT_CONFIRMATION);
  assert.equal(calls.logout, 1);
  assert.equal(result.accountDisconnected, true);
  assert.equal(result.cliPreserved, true);
  assert.equal(result.connection.installed, true);
  assert.equal(result.connection.connected, false);
  assert.equal(result.connection.accessProfile, 'read-only');
});

test('Antigravity disconnect revokes Full Server before failing on an unavailable CLI', async (t) => {
  const { manager, setInstalled } = fixture(t, { installed: true, connected: true });
  await manager.verify();
  await manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  setInstalled(false);
  await assert.rejects(() => manager.disconnect(DISCONNECT_CONFIRMATION), {
    code: 'antigravity-cli-required-for-disconnect'
  });
  const connection = await manager.status();
  assert.equal(connection.connected, true);
  assert.equal(connection.accessProfile, 'read-only');
  assert.equal(connection.profileApplied, true);
});

test('Antigravity preserves unrelated settings and rejects corrupt or unsafe files', async (t) => {
  const first = fixture(t);
  fs.mkdirSync(path.dirname(first.settingsFile), { recursive: true });
  fs.writeFileSync(first.settingsFile, JSON.stringify({ theme: 'dark', telemetry: false }), { mode: 0o600 });
  await first.manager.install(INSTALL_CONFIRMATION);
  const settings = JSON.parse(fs.readFileSync(first.settingsFile, 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.telemetry, false);

  const second = fixture(t);
  fs.mkdirSync(path.dirname(second.settingsFile), { recursive: true });
  fs.writeFileSync(second.settingsFile, '{broken', { mode: 0o600 });
  await assert.rejects(() => second.manager.status(), { code: 'antigravity-settings-invalid' });

  const third = fixture(t);
  fs.mkdirSync(path.dirname(third.settingsFile), { recursive: true });
  const linked = path.join(third.root, 'linked-settings.json');
  fs.writeFileSync(linked, '{}', { mode: 0o600 });
  fs.symlinkSync(linked, third.settingsFile);
  await assert.rejects(() => third.manager.status(), { code: 'antigravity-settings-file-unsafe' });

  const fourth = fixture(t);
  const configRoot = path.join(fourth.root, 'connections', 'antigravity-cli');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, 'config.json'), '{broken', { mode: 0o600 });
  await assert.rejects(() => fourth.manager.status(), { code: 'antigravity-config-invalid' });
});
