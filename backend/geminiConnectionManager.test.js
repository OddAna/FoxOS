const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptionStore } = require('./encryptionStore');
const {
  DISCONNECT_CONFIRMATION,
  INSTALL_CONFIRMATION,
  createGeminiConnectionManager,
  validateApiKey
} = require('./geminiConnectionManager');

const API_KEY = 'AIza' + 'a'.repeat(35);
const NEXT_API_KEY = 'AIza' + 'b'.repeat(35);

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-gemini-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let installed = options.installed === true;
  let version = options.version || '0.54.4';
  let verifyResult = options.verifyResult || { verified: true };
  const calls = { install: 0, verify: [] };
  let clockValue = Date.parse('2026-08-09T18:00:00.000Z');
  const manager = createGeminiConnectionManager({
    dataRoot: root,
    encryptionStore: createEncryptionStore({ dataRoot: root }),
    inspectCli: async () => ({ installed, version: installed ? version : null }),
    installCli: async () => {
      calls.install += 1;
      installed = true;
    },
    verifyCredential: async (apiKey) => {
      calls.verify.push(apiKey);
      if (verifyResult instanceof Error) throw verifyResult;
      return verifyResult;
    },
    clock: () => new Date(clockValue)
  });
  return {
    calls,
    manager,
    root,
    advanceClock(milliseconds = 1000) {
      clockValue += milliseconds;
    },
    setInstalled(value, nextVersion = version) {
      installed = value;
      version = nextVersion;
    },
    setVerifyResult(value) {
      verifyResult = value;
    }
  };
}

test('Gemini status is optional, disconnected and credential-free by default', async (t) => {
  const { manager } = fixture(t);
  assert.deepEqual(await manager.status(), {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    optional: true,
    installed: false,
    runtimeReady: false,
    version: null,
    connected: false,
    ready: false,
    authMethod: null,
    configuredAt: null,
    lastVerifiedAt: null,
    apiKeyStoredEncrypted: false,
    credentialIncluded: false,
    consumerGoogleLoginSupported: false,
    executionAccess: 'not-enabled'
  });
});

test('Gemini install requires exact confirmation and verifies the host binary', async (t) => {
  const { calls, manager } = fixture(t);
  await assert.rejects(
    () => manager.install('yes'),
    { code: 'gemini-install-confirmation-required', statusCode: 400 }
  );
  const result = await manager.install(INSTALL_CONFIRMATION);
  assert.equal(calls.install, 1);
  assert.equal(result.version, '0.54.4');
  assert.equal(result.connection.installed, true);
  assert.equal(result.connection.connected, false);
});

test('Gemini API key is verified, encrypted and never returned', async (t) => {
  const { calls, manager, root } = fixture(t, { installed: true });
  const connection = await manager.configure({ apiKey: API_KEY });
  assert.deepEqual(calls.verify, [API_KEY]);
  assert.equal(connection.connected, true);
  assert.equal(connection.ready, true);
  assert.equal(connection.authMethod, 'api-key');
  assert.equal(connection.apiKeyStoredEncrypted, true);
  assert.equal(connection.credentialIncluded, false);
  assert.equal(JSON.stringify(connection).includes(API_KEY), false);

  const connectionRoot = path.join(root, 'connections', 'gemini-cli');
  const encrypted = fs.readFileSync(path.join(connectionRoot, 'api-key.foxosenc'));
  const config = fs.readFileSync(path.join(connectionRoot, 'config.json'), 'utf8');
  assert.equal(encrypted.includes(Buffer.from(API_KEY)), false);
  assert.equal(config.includes(API_KEY), false);
  assert.equal(fs.statSync(connectionRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(connectionRoot, 'api-key.foxosenc')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(connectionRoot, 'config.json')).mode & 0o777, 0o600);
});

test('Gemini stored verification decrypts only in memory and refreshes timestamp', async (t) => {
  const { advanceClock, calls, manager } = fixture(t, { installed: true });
  const configured = await manager.configure({ apiKey: API_KEY });
  advanceClock(60_000);
  const verified = await manager.verifyStored();
  assert.equal(calls.verify.length, 2);
  assert.equal(calls.verify[1], API_KEY);
  assert.notEqual(verified.lastVerifiedAt, configured.lastVerifiedAt);
  assert.equal(JSON.stringify(verified).includes(API_KEY), false);
});

test('failed replacement verification preserves the existing encrypted connection', async (t) => {
  const { manager, root, setVerifyResult } = fixture(t, { installed: true });
  await manager.configure({ apiKey: API_KEY });
  const connectionRoot = path.join(root, 'connections', 'gemini-cli');
  const credentialsFile = path.join(connectionRoot, 'api-key.foxosenc');
  const configFile = path.join(connectionRoot, 'config.json');
  const beforeCredentials = fs.readFileSync(credentialsFile);
  const beforeConfig = fs.readFileSync(configFile);

  setVerifyResult({ verified: false });
  await assert.rejects(
    () => manager.configure({ apiKey: NEXT_API_KEY }),
    { code: 'gemini-api-key-verification-failed' }
  );
  assert.deepEqual(fs.readFileSync(credentialsFile), beforeCredentials);
  assert.deepEqual(fs.readFileSync(configFile), beforeConfig);
});

test('Gemini disconnect requires confirmation, removes only local credentials and keeps CLI', async (t) => {
  const { manager } = fixture(t, { installed: true });
  await manager.configure({ apiKey: API_KEY });
  await assert.rejects(
    () => manager.disconnect('yes'),
    { code: 'gemini-disconnect-confirmation-invalid', statusCode: 400 }
  );
  const result = await manager.disconnect(DISCONNECT_CONFIRMATION);
  assert.equal(result.credentialRemoved, true);
  assert.equal(result.configRemoved, true);
  assert.equal(result.cliPreserved, true);
  assert.equal(result.connection.installed, true);
  assert.equal(result.connection.connected, false);
});

test('Gemini configuration fails closed for absent CLI and mismatched records', async (t) => {
  const { manager, root } = fixture(t);
  await assert.rejects(
    () => manager.configure({ apiKey: API_KEY }),
    { code: 'gemini-cli-not-installed' }
  );
  const connectionRoot = path.join(root, 'connections', 'gemini-cli');
  fs.mkdirSync(connectionRoot, { recursive: true });
  fs.writeFileSync(path.join(connectionRoot, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    provider: 'gemini-cli',
    revision: 'gmrev_test',
    authMethod: 'api-key',
    apiKeyFingerprint: 'hmac-sha256:test',
    configuredAt: '2026-08-09T18:00:00.000Z',
    lastVerifiedAt: '2026-08-09T18:00:00.000Z'
  }), { mode: 0o600 });
  await assert.rejects(
    () => manager.status(),
    { code: 'gemini-credential-record-mismatch' }
  );
});

test('Gemini status fails closed when the encrypted credential is corrupted', async (t) => {
  const { manager, root } = fixture(t, { installed: true });
  await manager.configure({ apiKey: API_KEY });
  fs.writeFileSync(
    path.join(root, 'connections', 'gemini-cli', 'api-key.foxosenc'),
    'corrupted encrypted record',
    { mode: 0o600 }
  );
  await assert.rejects(
    () => manager.status(),
    { code: 'gemini-credential-unavailable' }
  );
});

test('Gemini API key validation rejects whitespace, shell syntax and short values', () => {
  assert.equal(validateApiKey(API_KEY), API_KEY);
  for (const value of ['', 'short', 'AIza invalid key', 'AIza$(id)' + 'a'.repeat(20)]) {
    assert.throws(() => validateApiKey(value), { code: 'gemini-api-key-invalid' });
  }
});
