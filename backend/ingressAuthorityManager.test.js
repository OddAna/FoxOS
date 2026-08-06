const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createIngressAuthorityManager } = require('./ingressAuthorityManager');

function adminConnection(commands) {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.setTimeout = () => {};
  socket.destroy = (error) => {
    if (error) socket.emit('error', error);
  };
  socket.end = (command) => {
    commands.push(command.trim());
    setImmediate(() => socket.emit('end'));
  };
  setImmediate(() => socket.emit('connect'));
  return socket;
}

test('staged routes switch through owned ingress and remove host authority on rollback', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-ingress-authority-'));
  const adminCommands = [];
  const firewallRules = new Set();
  const hostCalls = [];
  const gatewayId = 'a'.repeat(64);
  const ingressId = 'b'.repeat(64);
  const execContainerIds = [];
  const manager = createIngressAuthorityManager({
    dataRoot,
    dockerRequest: async (method, requestPath) => {
      assert.equal(method, 'GET');
      if (requestPath === '/networks/foxos-routing') {
        return { Internal: true, Labels: { 'com.foxos.routing': 'true', 'com.foxos.core': 'true' } };
      }
      if (requestPath === '/containers/foxos-gateway/json') {
        return { Id: gatewayId, State: { Running: true }, Config: { Labels: { 'com.foxos.gateway': 'true' } } };
      }
      if (requestPath === '/containers/foxos-ingress/json') {
        return { Id: ingressId, State: { Running: true }, Config: { Labels: { 'com.foxos.ingress': 'true' } } };
      }
      throw new Error('Unexpected Docker request: ' + requestPath);
    },
    dockerExec: async (containerId) => {
      execContainerIds.push(containerId);
      return { exitCode: 0, output: '' };
    },
    hostCommand: async (binary, args) => {
      hostCalls.push([binary, ...args]);
      const action = args.includes('-C') ? 'check' : args.includes('-I') ? 'insert' : args.includes('-D') ? 'delete' : 'other';
      const key = binary + ':public';
      if (action === 'check') return { success: firewallRules.has(key), output: '' };
      if (action === 'insert') firewallRules.add(key);
      if (action === 'delete') firewallRules.delete(key);
      return { success: true, output: '' };
    },
    connectAdmin: () => adminConnection(adminCommands),
    clock: () => new Date('2026-08-06T12:00:00.000Z')
  });

  const route = {
    routeId: 'smroute_' + 'a'.repeat(24),
    operationId: 'smop_' + 'b'.repeat(32),
    domain: 'app.example.com',
    path: '/',
    alias: 'foxos-sm-candidate',
    privatePort: 3000
  };
  const staged = await manager.stageRoutes([route]);
  assert.equal(staged[0].status, 'staged');
  assert.match(fs.readFileSync(manager.paths.caddyRoutesFile, 'utf8'), /reverse_proxy foxos-sm-candidate:3000/);

  await manager.switchDomain(route.domain, 'foxos');
  assert.equal(manager.state().publicAuthorityActive, true);
  assert.equal(manager.state().domains[route.domain], 'foxos');
  assert.deepEqual([...firewallRules].sort(), ['ip6tables:public', 'iptables:public']);

  await manager.switchDomain(route.domain, 'legacy');
  assert.equal(manager.state().publicAuthorityActive, false);
  assert.equal(manager.state().domains[route.domain], 'legacy');
  assert.deepEqual([...firewallRules], []);
  assert.equal(adminCommands.includes('set map /runtime/routes.map app.example.com foxos'), true);
  assert.equal(adminCommands.includes('set map /runtime/routes.map app.example.com legacy'), true);
  assert.equal(hostCalls.some((call) => call.includes('--to-ports') && call.includes('9443')), true);
  assert.deepEqual(execContainerIds, [gatewayId, gatewayId]);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('legacy readiness waits for a browser-trusted response before traffic authority', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-ingress-legacy-'));
  let requests = 0;
  const manager = createIngressAuthorityManager({
    dataRoot,
    dockerRequest: async () => ({}),
    dockerExec: async () => ({ exitCode: 0 }),
    hostCommand: async () => ({ success: false }),
    delay: async () => {},
    httpsRequest: (options, callback) => {
      requests += 1;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = (error) => request.emit('error', error);
      request.end = () => {
        if (requests === 1) return setImmediate(() => request.emit('error', new Error('backend resolving')));
        const response = new EventEmitter();
        response.statusCode = 307;
        response.headers = {};
        response.socket = { authorized: true };
        response.resume = () => setImmediate(() => response.emit('end'));
        callback(response);
      };
      assert.equal(options.hostname, 'foxos-ingress');
      assert.equal(options.servername, 'app.example.com');
      return request;
    }
  });
  const proof = await manager.verifyLegacyDomain({ hostname: 'app.example.com', attempts: 2 });
  assert.equal(proof.legacyReady, true);
  assert.equal(proof.attempts, 2);
  assert.equal(requests, 2);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
