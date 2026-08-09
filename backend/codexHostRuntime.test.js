const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  codexDaemonEnsureScript,
  codexDaemonSocket,
  createCodexDaemonTransport
} = require('./codexHostRuntime');

test('Codex host runtime uses the durable daemon control socket', () => {
  assert.equal(
    codexDaemonSocket('/var/lib/foxos/codex/.codex'),
    '/var/lib/foxos/codex/.codex/app-server-control/app-server-control.sock'
  );
  assert.throws(() => codexDaemonSocket('/'), /safe absolute host path/);
  assert.throws(() => codexDaemonSocket('relative'), /safe absolute host path/);
});

test('FoxOS starts or bootstraps only the host daemon', () => {
  const script = codexDaemonEnsureScript();
  assert.match(script, /app-server daemon version/);
  assert.match(script, /app-server daemon start/);
  assert.match(script, /app-server daemon bootstrap/);
  assert.match(script, /test -S/);
  assert.doesNotMatch(script, /app-server proxy/);
  assert.doesNotMatch(script, /app-server --listen stdio/);
});

test('Unix WebSocket transport exposes child-like stdio without owning the daemon', async () => {
  class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static last = null;

    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      FakeWebSocket.last = this;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open');
      });
    }

    send(message) {
      this.sent.push(message);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      queueMicrotask(() => this.emit('close'));
    }

    terminate() {
      this.close();
    }
  }

  const child = createCodexDaemonTransport({
    socketPath: '/host/var/lib/foxos/codex/.codex/app-server-control/app-server-control.sock',
    WebSocketImpl: FakeWebSocket,
    createConnection: () => null
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stdin.write('{"id":1,"method":"initialize"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeWebSocket.last.url, 'ws://localhost/');
  assert.equal(FakeWebSocket.last.options.perMessageDeflate, false);
  assert.equal(FakeWebSocket.last.options.maxPayload, 8 * 1024 * 1024);
  assert.deepEqual(FakeWebSocket.last.sent, ['{"id":1,"method":"initialize"}']);

  FakeWebSocket.last.emit('message', Buffer.from('{"id":1,"result":{}}'));
  assert.deepEqual(output, ['{"id":1,"result":{}}\n']);

  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(child.killed, true);
});
