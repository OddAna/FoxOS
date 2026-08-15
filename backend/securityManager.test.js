const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPasswordCredential } = require('./passwordSecurity');
const { SecurityError, createSecurityManager } = require('./securityManager');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-security-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const password = 'iki sözcük ve 2026 için uzun bir ifade';
  const credential = await createPasswordCredential(password, { now: '2026-08-14T00:00:00.000Z' });
  const authFilePath = path.join(root, 'auth.json');
  fs.writeFileSync(authFilePath, JSON.stringify({
    version: 4,
    username: 'owner',
    password: credential,
    createdAt: '2026-08-14T00:00:00.000Z',
    webauthnUserId: Buffer.alloc(32, 7).toString('base64url'),
    passkeys: [],
    recovery: { salt: null, generatedAt: null, needsRotation: false, codes: [] }
  }), { mode: 0o600 });
  let seed = 10;
  return {
    password,
    authFilePath,
    eventFilePath: path.join(root, 'security-events.jsonl'),
    randomBytes: (size) => Buffer.alloc(size, seed++)
  };
}

test('recovery codes are one-time, private and rotate after use', async (t) => {
  const files = await fixture(t);
  const manager = createSecurityManager({ ...files, clock: () => Date.parse('2026-08-14T01:00:00.000Z') });
  assert.equal(manager.status().recovery.configured, false);
  const codes = await manager.rotateRecoveryCodes({ method: 'password' });
  assert.equal(codes.length, 10);
  assert.match(codes[0], /^FOXOS-(?:[A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
  assert.equal(fs.readFileSync(files.authFilePath, 'utf8').includes(codes[0]), false);
  assert.equal(manager.status().recovery.availableCodes, 10);

  await assert.rejects(
    () => manager.resetPasswordWithRecovery('FOXOS-WRONG-CODE', 'başka bir benzersiz uzun parola'),
    (error) => error instanceof SecurityError && error.code === 'recovery-code-invalid'
  );
  await manager.resetPasswordWithRecovery(codes[0], 'başka bir benzersiz uzun parola');
  assert.equal(manager.status().recovery.availableCodes, 9);
  assert.equal(manager.status().recovery.needsRotation, true);
  assert.equal((await manager.verifyOwnerPassword('başka bir benzersiz uzun parola')).matched, true);
  await assert.rejects(
    () => manager.resetPasswordWithRecovery(codes[0], 'üçüncü benzersiz ve uzun parola'),
    (error) => error instanceof SecurityError && error.code === 'recovery-code-invalid'
  );
});

test('passkey ceremonies are origin- and session-bound and persist public credentials', async (t) => {
  const files = await fixture(t);
  const calls = [];
  const passkeyId = 'credential_1234567890';
  const manager = createSecurityManager({
    ...files,
    clock: () => Date.parse('2026-08-14T02:00:00.000Z'),
    webauthn: {
      async generateRegistrationOptions(options) {
        calls.push(['registration-options', options]);
        return { challenge: 'register-challenge', rp: { id: options.rpID } };
      },
      async verifyRegistrationResponse(options) {
        calls.push(['registration-verify', options]);
        return {
          verified: true,
          registrationInfo: {
            credential: { id: passkeyId, publicKey: Uint8Array.from([1, 2, 3]), counter: 0 },
            credentialDeviceType: 'multiDevice',
            credentialBackedUp: true
          }
        };
      },
      async generateAuthenticationOptions(options) {
        calls.push(['authentication-options', options]);
        return { challenge: 'authentication-challenge', rpId: options.rpID };
      },
      async verifyAuthenticationResponse(options) {
        calls.push(['authentication-verify', options]);
        return { verified: true, authenticationInfo: { newCounter: 1 } };
      }
    }
  });
  const context = { rpID: 'foxos.example.test', origin: 'https://foxos.example.test' };
  const sessionToken = Buffer.alloc(32, 5).toString('base64url');
  const registration = await manager.beginPasskeyRegistration({
    sessionToken,
    name: 'MacBook Touch ID',
    preferredAuthenticatorType: 'localDevice',
    context
  });
  await assert.rejects(
    () => manager.finishPasskeyRegistration({
      sessionToken: Buffer.alloc(32, 6).toString('base64url'),
      ceremonyId: registration.ceremonyId,
      response: { id: passkeyId, response: { transports: ['internal'] } },
      context
    }),
    (error) => error.code === 'passkey-session-mismatch'
  );

  const retry = await manager.beginPasskeyRegistration({
    sessionToken,
    name: 'MacBook Touch ID',
    context
  });
  const passkey = await manager.finishPasskeyRegistration({
    sessionToken,
    ceremonyId: retry.ceremonyId,
    response: { id: passkeyId, response: { transports: ['internal'] } },
    context
  });
  assert.equal(passkey.name, 'MacBook Touch ID');
  assert.equal(passkey.backedUp, true);
  assert.equal(manager.status().passkeys.length, 1);

  const authentication = await manager.beginPasskeyAuthentication(context);
  const login = await manager.finishPasskeyAuthentication({
    ceremonyId: authentication.ceremonyId,
    response: { id: passkeyId, response: {} },
    context
  });
  assert.equal(login.username, 'owner');
  assert.equal(manager.status().passkeys[0].lastUsedAt, '2026-08-14T02:00:00.000Z');
  assert.equal(calls.some(([name]) => name === 'authentication-verify'), true);
});

test('security event history is bounded and never stores client secrets', async (t) => {
  const files = await fixture(t);
  const manager = createSecurityManager(files);
  manager.recordEvent({
    type: 'login-succeeded',
    method: 'password',
    sessionId: 'ses_' + '1'.repeat(32),
    client: { browser: 'Safari', network: 'local' },
    detail: 'owner'
  });
  manager.recordEvent({ type: 'unknown-event', detail: 'must-not-persist' });
  const events = manager.listEvents(10);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'login-succeeded');
  assert.equal(fs.statSync(files.eventFilePath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(files.eventFilePath, 'utf8').includes('must-not-persist'), false);
});
