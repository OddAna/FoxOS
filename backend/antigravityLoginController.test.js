const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  createAntigravityLoginController,
  extractAuthorizationUrl,
  normalizeAuthorizationCode,
  normalizeAuthorizationUrl
} = require('./antigravityLoginController');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/auth?state=state-123&code_challenge=challenge-123&code_challenge_method=S256&client_id=client';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    this.emit('close', null, signal);
    return true;
  }
}

test('Antigravity authorization URL accepts only the official PKCE endpoint', () => {
  assert.equal(normalizeAuthorizationUrl(AUTH_URL), AUTH_URL);
  assert.equal(extractAuthorizationUrl('Open this URL:\n' + AUTH_URL + '\nCode:'), AUTH_URL);
  for (const value of [
    'http://accounts.google.com/o/oauth2/auth?state=x&code_challenge=y&code_challenge_method=S256',
    'https://accounts.google.com.evil.test/o/oauth2/auth?state=x&code_challenge=y&code_challenge_method=S256',
    'https://accounts.google.com/o/oauth2/auth?state=x&code_challenge=y',
    'https://accounts.google.com/o/oauth2/auth?code_challenge=y&code_challenge_method=S256'
  ]) assert.equal(normalizeAuthorizationUrl(value), null);
});

test('Antigravity authorization code validation rejects whitespace and shell syntax', () => {
  assert.equal(normalizeAuthorizationCode('4/0AbCdEf_123-xyz'), '4/0AbCdEf_123-xyz');
  for (const value of ['', 'short', 'code with spaces', '4/abc;id', '4/abc\nnext']) {
    assert.throws(() => normalizeAuthorizationCode(value), {
      code: 'antigravity-authorization-code-invalid',
      statusCode: 400
    });
  }
});

test('Antigravity login controller returns the official URL and accepts one code', async () => {
  const child = new FakeChild();
  const controller = createAntigravityLoginController({
    spawnLogin: () => child,
    clock: () => new Date('2026-08-09T18:00:00.000Z'),
    discoveryTimeoutMs: 500,
    completionTimeoutMs: 500,
    sessionTtlMs: 1000
  });
  const startPromise = controller.start();
  child.stdout.write('Authenticate at ' + AUTH_URL + '\n');
  const login = await startPromise;
  assert.match(login.loginId, /^agylogin_[a-f0-9]{32}$/);
  assert.equal(login.verificationUrl, AUTH_URL);
  assert.equal(login.expiresAt, '2026-08-09T18:00:01.000Z');

  const written = new Promise((resolve) => child.stdin.once('data', (chunk) => resolve(String(chunk))));
  const completion = controller.complete(login.loginId, '4/0AbCdEf_123-xyz');
  assert.equal(await written, '4/0AbCdEf_123-xyz\n');
  child.stdout.write('{"status":"SUCCESS","response":"usage"}\n');
  child.emit('close', 0, null);
  assert.deepEqual(await completion, { connected: true, authMode: 'google-oauth' });
  assert.equal(controller.inProgress(), false);
});

test('Antigravity login controller cancels and does not expose process output', async () => {
  const child = new FakeChild();
  const controller = createAntigravityLoginController({
    spawnLogin: () => child,
    discoveryTimeoutMs: 500,
    completionTimeoutMs: 500,
    sessionTtlMs: 1000
  });
  const startPromise = controller.start();
  child.stderr.write('private preface ' + AUTH_URL + '\n');
  const login = await startPromise;
  assert.deepEqual(await controller.cancel(login.loginId), { cancelled: true });
  assert.equal(child.killedWith, 'SIGTERM');
  assert.deepEqual(await controller.cancel(), { cancelled: false });
  assert.equal(JSON.stringify(login).includes('private preface'), false);
});

test('Antigravity TUI login submits the code with carriage return for external verification', async () => {
  const child = new FakeChild();
  const controller = createAntigravityLoginController({
    spawnLogin: () => child,
    authorizationCodeTerminator: '\r',
    postSubmissionWaitMs: 100,
    discoveryTimeoutMs: 500,
    completionTimeoutMs: 500,
    sessionTtlMs: 1000
  });
  const startPromise = controller.start();
  child.stdout.write('TUI authorization ' + AUTH_URL + '\n');
  const login = await startPromise;
  const written = new Promise((resolve) => child.stdin.once('data', (chunk) => resolve(String(chunk))));
  const completion = controller.complete(login.loginId, '4/0AbCdEf_123-xyz');
  assert.equal(await written, '4/0AbCdEf_123-xyz\r');
  assert.deepEqual(await completion, { submitted: true, authMode: 'google-oauth' });
  assert.equal(child.killedWith, 'SIGTERM');
  assert.equal(controller.inProgress(), false);
});

test('Antigravity login controller fails closed when the URL is unavailable', async () => {
  const child = new FakeChild();
  const controller = createAntigravityLoginController({
    spawnLogin: () => child,
    discoveryTimeoutMs: 100,
    completionTimeoutMs: 100,
    sessionTtlMs: 200
  });
  const startPromise = controller.start();
  setImmediate(() => {
    child.stdout.write('no authorization link\n');
    child.emit('close', 1, null);
  });
  await assert.rejects(startPromise, { code: 'antigravity-login-url-unavailable', statusCode: 502 });
});
