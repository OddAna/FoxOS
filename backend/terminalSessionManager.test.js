const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const WebSocket = require('ws');
const { createTerminalSessionManager } = require('./terminalSessionManager');

function createFakePty() {
  const dataListeners = new Set();
  const exitListeners = new Set();
  return {
    writes: [],
    resizes: [],
    killedWith: null,
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    write(data) { this.writes.push(data); },
    resize(cols, rows) { this.resizes.push([cols, rows]); },
    kill(signal) { this.killedWith = signal; },
    emitData(data) { for (const listener of dataListeners) listener(data); },
    emitExit(event) { for (const listener of exitListeners) listener(event); }
  };
}

function waitForWebSocketMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, 2000);
    const onMessage = (payload) => {
      const message = JSON.parse(payload.toString('utf8'));
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}

function expectUpgradeStatus(url, options, expectedStatus) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('open', () => reject(new Error('Unexpected WebSocket connection')));
    socket.once('error', () => {});
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      try {
        assert.equal(response.statusCode, expectedStatus);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('terminal WebSocket requires owner auth and transports PTY input, output and resize', async () => {
  const spawned = [];
  const manager = createTerminalSessionManager({
    authenticate(request) {
      if (request.headers.origin !== 'http://127.0.0.1' || request.headers.cookie !== 'foxos_session=valid') {
        return null;
      }
      return { ownerId: 'owner-hash', expiresAt: Date.now() + 60_000 };
    },
    spawnPty(size) {
      const terminal = createFakePty();
      spawned.push({ size, terminal });
      return terminal;
    }
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  manager.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `ws://127.0.0.1:${address.port}/api/terminal/socket`;

  await expectUpgradeStatus(url, { headers: { Origin: 'http://127.0.0.1' } }, 401);

  const socket = new WebSocket(url, {
    headers: { Origin: 'http://127.0.0.1', Cookie: 'foxos_session=valid' }
  });
  const readyMessage = waitForWebSocketMessage(socket, (message) => message.type === 'ready');
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  assert.deepEqual(await readyMessage, { type: 'ready' });
  assert.deepEqual(spawned[0].size, { cols: 80, rows: 24 });
  assert.equal(manager.sessionCount(), 1);

  socket.send(JSON.stringify({ type: 'resize', cols: 132, rows: 42 }));
  socket.send(JSON.stringify({ type: 'input', data: 'printf foxos-pty\r' }));
  await waitFor(
    () => spawned[0].terminal.resizes.length === 1 && spawned[0].terminal.writes.length === 1,
    'Timed out waiting for PTY input and resize'
  );
  assert.deepEqual(spawned[0].terminal.resizes, [[132, 42]]);
  assert.deepEqual(spawned[0].terminal.writes, ['printf foxos-pty\r']);

  const outputMessage = waitForWebSocketMessage(socket, (message) => message.type === 'output');
  spawned[0].terminal.emitData('\u001b[32mfoxos-pty\u001b[0m\r\n');
  assert.deepEqual(await outputMessage, {
    type: 'output',
    data: '\u001b[32mfoxos-pty\u001b[0m\r\n'
  });

  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.close(1000, 'test complete');
  await closed;
  assert.equal(spawned[0].terminal.killedWith, 'SIGHUP');
  assert.equal(manager.sessionCount(), 0);

  manager.shutdown();
  await new Promise((resolve) => server.close(resolve));
});

test('closing an owner session revokes its active root terminal', async () => {
  const terminal = createFakePty();
  const manager = createTerminalSessionManager({
    authenticate: () => ({ ownerId: 'owner-hash', expiresAt: Date.now() + 60_000 }),
    spawnPty: () => terminal
  });
  const server = http.createServer();
  manager.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/terminal/socket`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const closed = new Promise((resolve) => socket.once('close', resolve));
  manager.closeOwnerSessions('owner-hash');
  await closed;
  assert.equal(terminal.killedWith, 'SIGHUP');
  assert.equal(manager.sessionCount(), 0);

  manager.shutdown();
  await new Promise((resolve) => server.close(resolve));
});
