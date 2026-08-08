const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const {
  DISCONNECT_CONFIRMATION,
  FULL_SERVER_CONFIRMATION,
  INSTALL_CONFIRMATION,
  createCodexConnectionManager
} = require('./codexConnectionManager');

function fakeAppServer() {
  let account = null;
  let nextThread = 1;
  const received = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;

  const respond = (message) => {
    child.stdout.write(JSON.stringify(message) + '\n');
  };

  const handle = (message) => {
    received.push(message);
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') {
      return respond({ id: message.id, result: { userAgent: 'codex-test' } });
    }
    if (message.method === 'account/read') {
      return respond({ id: message.id, result: { account, requiresOpenaiAuth: true } });
    }
    if (message.method === 'account/login/start') {
      account = { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' };
      return respond({
        id: message.id,
        result: {
          type: 'chatgptDeviceCode',
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234'
        }
      });
    }
    if (message.method === 'account/logout') {
      account = null;
      return respond({ id: message.id, result: {} });
    }
    if (message.method === 'thread/start') {
      return respond({
        id: message.id,
        result: { thread: { id: 'thr_' + nextThread++, sessionId: 'thr_1' } }
      });
    }
    if (message.method === 'turn/start') {
      respond({ id: message.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
      respond({
        method: 'item/agentMessage/delta',
        params: { threadId: message.params.threadId, itemId: 'msg_1', delta: 'Hazırım.' }
      });
      return;
    }
    if (message.method === 'turn/interrupt' || message.method === 'account/login/cancel') {
      return respond({ id: message.id, result: {} });
    }
  };

  let input = '';
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      input += chunk.toString('utf8');
      let newline;
      while ((newline = input.indexOf('\n')) !== -1) {
        const line = input.slice(0, newline).trim();
        input = input.slice(newline + 1);
        if (line) handle(JSON.parse(line));
      }
      callback();
    }
  });
  child.kill = (signal = 'SIGTERM') => {
    if (child.killed) return true;
    child.killed = true;
    queueMicrotask(() => child.emit('exit', 0, signal));
    return true;
  };
  child.emitServerRequest = (message) => respond(message);
  child.received = received;
  return child;
}

function createFixture({ installed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-codex-'));
  let cliInstalled = installed;
  const children = [];
  const manager = createCodexConnectionManager({
    dataRoot: root,
    inspectCli: async () => ({ installed: cliInstalled, version: cliInstalled ? 'codex-cli 1.2.3' : null }),
    installCli: async () => { cliInstalled = true; },
    spawnAppServer: () => {
      const child = fakeAppServer();
      children.push(child);
      return child;
    },
    clock: () => new Date('2026-08-08T12:00:00.000Z')
  });
  return { children, manager, root };
}

test('Codex connection is optional and reports an absent CLI without starting a runtime', async () => {
  const fixture = createFixture();
  const status = await fixture.manager.status();
  assert.equal(status.id, 'codex');
  assert.equal(status.installed, false);
  assert.equal(status.connected, false);
  assert.equal(status.accessProfile, 'read-only');
  assert.equal(fixture.children.length, 0);
});

test('Codex installation requires exact confirmation and keeps the initial profile read-only', async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.manager.install('yes'),
    (error) => error.code === 'codex-install-confirmation-required'
  );

  const result = await fixture.manager.install(INSTALL_CONFIRMATION);
  assert.equal(result.installed, true);
  assert.equal(result.connection.installed, true);
  assert.equal(result.connection.accessProfile, 'read-only');
  assert.equal(result.connection.rootEquivalent, false);
  fixture.manager.stop();
});

test('device login and Full Server access remain separate explicit operations', async () => {
  const fixture = createFixture({ installed: true });
  await assert.rejects(
    fixture.manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION),
    (error) => error.code === 'codex-account-required'
  );
  const login = await fixture.manager.startLogin();
  assert.equal(login.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(login.userCode, 'ABCD-1234');

  const connected = await fixture.manager.status();
  assert.equal(connected.connected, true);
  assert.equal(connected.email, 'owner@example.com');
  assert.equal(connected.authMode, 'chatgpt');
  assert.equal(connected.fullServer, false);

  await assert.rejects(
    fixture.manager.setAccessProfile('full-server', 'yes'),
    (error) => error.code === 'codex-full-server-confirmation-required'
  );
  const fullServer = await fixture.manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  assert.equal(fullServer.fullServer, true);
  assert.equal(fullServer.rootEquivalent, true);
  fixture.manager.stop();
});

test('Full Server threads use host root with danger-full-access and stream bounded events', async () => {
  const fixture = createFixture({ installed: true });
  await fixture.manager.startLogin();
  await fixture.manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  const started = await fixture.manager.startThread();
  assert.equal(started.workingDirectory, '/');
  assert.equal(started.accessProfile, 'full-server');

  const child = fixture.children[0];
  const threadStart = child.received.find((message) => message.method === 'thread/start');
  assert.equal(threadStart.params.cwd, '/');
  assert.equal(threadStart.params.sandbox, 'danger-full-access');
  assert.equal(threadStart.params.approvalPolicy, 'untrusted');

  await fixture.manager.startTurn(started.thread.id, 'Sunucunun durumunu incele.');
  const events = fixture.manager.events(0, started.thread.id);
  assert.ok(events.events.some((event) => event.method === 'item/agentMessage/delta'));
  assert.equal(events.events.some((event) => Object.hasOwn(event, 'bufferedBytes')), false);
  fixture.manager.stop();
});

test('Codex approval requests expose an opaque request id and accept only fixed decisions', async () => {
  const fixture = createFixture({ installed: true });
  await fixture.manager.startLogin();
  await fixture.manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  const thread = await fixture.manager.startThread();
  const child = fixture.children[0];
  child.emitServerRequest({
    id: 99,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: thread.thread.id,
      turnId: 'turn_2',
      itemId: 'item_2',
      command: 'systemctl restart nginx',
      cwd: '/',
      availableDecisions: ['accept', 'decline']
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const approvalEvent = fixture.manager.events(0, thread.thread.id).events
    .find((event) => event.method === 'foxos/approvalRequested');
  assert.ok(approvalEvent.params.requestId);
  assert.equal(approvalEvent.params.command, 'systemctl restart nginx');
  assert.match(approvalEvent.params.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(approvalEvent.params.requestId, '99');

  assert.throws(
    () => fixture.manager.resolveApproval(approvalEvent.params.requestId, 'acceptForSession'),
    (error) => error.code === 'codex-approval-decision-unavailable'
  );
  const resolved = fixture.manager.resolveApproval(approvalEvent.params.requestId, 'accept');
  assert.equal(resolved.resolved, true);
  assert.deepEqual(child.received.at(-1), { id: 99, result: { decision: 'accept' } });
  fixture.manager.stop();
});

test('revoking Full Server stops the runtime and blocks turns on an existing thread', async () => {
  const fixture = createFixture({ installed: true });
  await fixture.manager.startLogin();
  await fixture.manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  const started = await fixture.manager.startThread();
  const firstChild = fixture.children[0];

  await fixture.manager.setAccessProfile('read-only');
  assert.equal(firstChild.killed, true);
  await assert.rejects(
    fixture.manager.startTurn(started.thread.id, 'Bu işlem çalışmamalı.'),
    (error) => error.code === 'codex-full-server-required'
  );
});

test('disconnect logs out Codex and revokes Full Server access', async () => {
  const fixture = createFixture({ installed: true });
  await fixture.manager.startLogin();
  await fixture.manager.setAccessProfile('full-server', FULL_SERVER_CONFIRMATION);
  await assert.rejects(
    fixture.manager.disconnect('yes'),
    (error) => error.code === 'codex-disconnect-confirmation-required'
  );

  const result = await fixture.manager.disconnect(DISCONNECT_CONFIRMATION);
  assert.equal(result.connection.connected, false);
  assert.equal(result.connection.accessProfile, 'read-only');
  assert.equal(result.connection.rootEquivalent, false);
  fixture.manager.stop();
});
