const { WebSocketServer } = require('ws');

const DEFAULT_PATH = '/api/terminal/socket';
const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

function rejectUpgrade(socket, statusCode, reason) {
  if (!socket || socket.destroyed) return;
  const body = reason + '\n';
  const response = [
    `HTTP/1.1 ${statusCode} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n');
  try { socket.end(response); } catch { socket.destroy(); }
}

function requestPath(request) {
  try {
    return new URL(request.url || '/', 'http://foxos.local').pathname;
  } catch {
    return '';
  }
}

function validDimension(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function createTerminalSessionManager({
  authenticate,
  spawnPty,
  path = DEFAULT_PATH,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
  now = () => Date.now()
} = {}) {
  if (typeof authenticate !== 'function' || typeof spawnPty !== 'function') {
    throw new TypeError('Terminal sessions require authentication and a PTY factory');
  }
  if (!path.startsWith('/') || !Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new TypeError('Invalid terminal session configuration');
  }

  const webSockets = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  const sessions = new Map();
  const attachedServers = new Map();

  function send(socket, payload) {
    if (socket.readyState !== 1) return false;
    if (socket.bufferedAmount > maxBufferedBytes) {
      socket.close(1013, 'Terminal output backpressure limit reached');
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }

  function closeState(state, { kill = true } = {}) {
    if (!state || state.closed) return;
    state.closed = true;
    sessions.delete(state.socket);
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    state.dataSubscription?.dispose?.();
    state.exitSubscription?.dispose?.();
    if (kill && !state.exited) {
      try { state.pty.kill('SIGHUP'); } catch { /* The PTY may already be gone. */ }
    }
  }

  function openSession(socket, owner) {
    let terminal;
    try {
      terminal = spawnPty({ cols: 80, rows: 24 });
    } catch {
      send(socket, { type: 'error', code: 'terminal-unavailable', message: 'Host terminal could not be started.' });
      socket.close(1011, 'Host terminal unavailable');
      return;
    }

    const state = {
      socket,
      ownerId: owner.ownerId,
      pty: terminal,
      closed: false,
      exited: false,
      expiryTimer: null,
      dataSubscription: null,
      exitSubscription: null
    };
    sessions.set(socket, state);

    const remainingLifetime = Number.isFinite(owner.expiresAt)
      ? Math.max(1, Math.min(maxLifetimeMs, owner.expiresAt - now()))
      : maxLifetimeMs;
    state.expiryTimer = setTimeout(() => {
      if (socket.readyState === 1) socket.close(1008, 'FoxOS session expired');
      closeState(state);
    }, remainingLifetime);
    state.expiryTimer.unref?.();

    state.dataSubscription = terminal.onData((data) => {
      send(socket, { type: 'output', data: String(data) });
    });
    state.exitSubscription = terminal.onExit(({ exitCode = 0, signal = 0 } = {}) => {
      state.exited = true;
      send(socket, { type: 'exit', exitCode, signal });
      if (socket.readyState === 1) socket.close(1000, 'Terminal exited');
      closeState(state, { kill: false });
    });

    socket.on('message', (payload, isBinary) => {
      if (isBinary || payload.length > maxPayloadBytes) {
        return socket.close(1003, 'Unsupported terminal payload');
      }

      let message;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        return socket.close(1008, 'Invalid terminal message');
      }

      if (message && message.type === 'input' && typeof message.data === 'string') {
        if (Buffer.byteLength(message.data) > maxPayloadBytes) {
          return socket.close(1009, 'Terminal input is too large');
        }
        terminal.write(message.data);
        return;
      }

      if (
        message && message.type === 'resize' &&
        validDimension(message.cols, 20, 400) && validDimension(message.rows, 5, 200)
      ) {
        terminal.resize(message.cols, message.rows);
        return;
      }

      socket.close(1008, 'Invalid terminal message');
    });
    socket.on('close', () => closeState(state));
    socket.on('error', () => closeState(state));

    send(socket, { type: 'ready' });
  }

  function handleUpgrade(request, socket, head) {
    if (requestPath(request) !== path) return;

    let owner;
    try {
      owner = authenticate(request);
    } catch {
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    if (!owner || typeof owner.ownerId !== 'string' || !owner.ownerId) {
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    if (sessions.size >= maxSessions) {
      return rejectUpgrade(socket, 503, 'Terminal capacity reached');
    }

    try {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => openSession(webSocket, owner));
    } catch {
      rejectUpgrade(socket, 400, 'Invalid WebSocket request');
    }
  }

  function attach(server) {
    if (!server || typeof server.on !== 'function') {
      throw new TypeError('An HTTP server is required');
    }
    if (attachedServers.has(server)) return attachedServers.get(server);
    const upgrade = (request, socket, head) => handleUpgrade(request, socket, head);
    const close = () => detach(server);
    server.on('upgrade', upgrade);
    server.once('close', close);
    const detach = () => {
      server.off('upgrade', upgrade);
      server.off('close', close);
      attachedServers.delete(server);
    };
    attachedServers.set(server, detach);
    return detach;
  }

  function closeOwnerSessions(ownerId) {
    for (const state of sessions.values()) {
      if (state.ownerId !== ownerId) continue;
      if (state.socket.readyState === 1) state.socket.close(1008, 'FoxOS session ended');
      closeState(state);
    }
  }

  function shutdown() {
    for (const detach of attachedServers.values()) detach();
    for (const state of [...sessions.values()]) {
      if (state.socket.readyState === 1) state.socket.close(1001, 'FoxOS is restarting');
      closeState(state);
    }
  }

  return {
    attach,
    closeOwnerSessions,
    shutdown,
    sessionCount: () => sessions.size
  };
}

module.exports = {
  createTerminalSessionManager,
  rejectUpgrade,
  requestPath,
  validDimension
};
