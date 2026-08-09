const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const WebSocket = require('ws');

const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;

function codexDaemonSocket(configHome) {
  const source = String(configHome || '');
  const normalized = path.posix.resolve('/', source);
  if (
    !source.startsWith('/') || normalized === '/' || normalized.length > 512 ||
    /[\r\n\0]/.test(source)
  ) {
    throw new Error('Codex config home must be a safe absolute host path');
  }
  return path.posix.join(normalized, 'app-server-control', 'app-server-control.sock');
}

function codexDaemonEnsureScript() {
  return [
    'set -eu',
    'codex_binary="$CODEX_INSTALL_DIR/codex"',
    'codex_socket="$CODEX_HOME/app-server-control/app-server-control.sock"',
    'if ! "$codex_binary" app-server daemon version >/dev/null 2>&1; then',
    '  if ! "$codex_binary" app-server daemon start >/dev/null 2>&1; then',
    '    "$codex_binary" app-server daemon bootstrap >/dev/null',
    '  fi',
    'fi',
    'test -S "$codex_socket"'
  ].join('\n');
}

function createCodexDaemonTransport({
  socketPath,
  WebSocketImpl = WebSocket,
  createConnection = () => net.createConnection(socketPath)
}) {
  if (!path.isAbsolute(socketPath) || socketPath === '/' || /[\r\n\0]/.test(socketPath)) {
    throw new Error('Codex daemon socket must be a safe absolute path');
  }

  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let inputBuffer = '';
  let queuedBytes = 0;
  let exited = false;
  const queuedMessages = [];
  const websocket = new WebSocketImpl('ws://localhost/', {
    createConnection,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false
  });

  const finish = (code, signal = null) => {
    if (exited) return;
    exited = true;
    child.emit('exit', code, signal);
  };

  const send = (message) => {
    if (websocket.readyState === WebSocketImpl.OPEN) {
      websocket.send(message);
      return;
    }
    const bytes = Buffer.byteLength(message);
    if (queuedBytes + bytes > MAX_QUEUED_INPUT_BYTES) {
      throw new Error('Codex daemon input queue exceeded its safe limit');
    }
    queuedMessages.push(message);
    queuedBytes += bytes;
  };

  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      try {
        inputBuffer += chunk.toString('utf8');
        let newline;
        while ((newline = inputBuffer.indexOf('\n')) !== -1) {
          const message = inputBuffer.slice(0, newline).trim();
          inputBuffer = inputBuffer.slice(newline + 1);
          if (message) send(message);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    }
  });

  websocket.on('open', () => {
    for (const message of queuedMessages.splice(0)) websocket.send(message);
    queuedBytes = 0;
  });
  websocket.on('message', (data) => {
    child.stdout.write(data.toString('utf8') + '\n');
  });
  websocket.on('error', (error) => {
    child.stderr.write(String(error && error.message || 'Codex daemon socket error').slice(0, 1000));
    child.emit('error', error);
    try {
      if (typeof websocket.terminate === 'function') websocket.terminate();
    } catch {}
    queueMicrotask(() => finish(1));
  });
  websocket.on('close', () => finish(child.killed ? 0 : 1, child.killed ? 'SIGTERM' : null));

  child.kill = (signal = 'SIGTERM') => {
    if (child.killed) return true;
    child.killed = true;
    if (websocket.readyState === WebSocketImpl.OPEN) websocket.close(1000);
    else if (typeof websocket.terminate === 'function') websocket.terminate();
    queueMicrotask(() => finish(0, signal));
    return true;
  };

  return child;
}

module.exports = {
  codexDaemonEnsureScript,
  codexDaemonSocket,
  createCodexDaemonTransport
};
