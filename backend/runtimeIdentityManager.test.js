const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  clonedContainerPayload,
  createRuntimeIdentityManager,
  networkAttachments
} = require('./runtimeIdentityManager');

test('container cloning keeps runtime constraints while replacing only the visible image reference', () => {
  const details = {
    Config: {
      Image: 'sha256:' + '1'.repeat(64),
      Entrypoint: ['node'],
      Cmd: ['server.js'],
      Env: ['PORT=3000'],
      Labels: { 'com.foxos.managed': 'true' },
      ExposedPorts: { '3000/tcp': {} },
      WorkingDir: '/app'
    },
    HostConfig: {
      NetworkMode: 'foxos-routing',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      Memory: 536870912,
      NanoCpus: 1000000000,
      PidsLimit: 256
    }
  };
  const payload = clonedContainerPayload(
    details,
    'local/app-example-com:current',
    'foxos-routing',
    ['app-route', 'proof-route']
  );
  assert.equal(payload.Image, 'local/app-example-com:current');
  assert.equal(payload.Labels['com.foxos.image.reference'], 'local/app-example-com:current');
  assert.deepEqual(payload.Entrypoint, ['node']);
  assert.deepEqual(payload.Cmd, ['server.js']);
  assert.equal(payload.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(payload.HostConfig.CapDrop, ['ALL']);
  assert.equal(payload.HostConfig.Memory, 536870912);
  assert.deepEqual(payload.NetworkingConfig.EndpointsConfig['foxos-routing'].Aliases, ['app-route', 'proof-route']);
});

test('network attachments retain exact aliases for every existing network', () => {
  assert.deepEqual(networkAttachments({
    NetworkSettings: {
      Networks: {
        zeta: { Aliases: ['app', null, 'app'] },
        alpha: { Aliases: ['route'] }
      }
    }
  }), [
    { name: 'alpha', aliases: ['route'] },
    { name: 'zeta', aliases: ['app'] }
  ]);
});

test('completed candidate reconciliation preserves the immutable image and commits the new runtime identity', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-runtime-identity-'));
  const operationId = 'smop_' + '1'.repeat(32);
  const oldId = '2'.repeat(64);
  const newId = '3'.repeat(64);
  const gatewayId = '4'.repeat(64);
  const imageId = 'sha256:' + '5'.repeat(64);
  const operationRoot = path.join(dataRoot, 'stateless-migrations', 'operations');
  const adapterRoot = path.join(dataRoot, 'production-stateless-adapter', 'operations');
  fs.mkdirSync(operationRoot, { recursive: true });
  fs.mkdirSync(adapterRoot, { recursive: true });
  fs.writeFileSync(path.join(operationRoot, operationId + '.json'), JSON.stringify({
    operationId,
    status: 'traffic-on-foxos-source-preserved',
    candidate: { containerId: oldId, imageId, privatePort: 3000 },
    route: { path: '/healthz' }
  }));
  fs.writeFileSync(path.join(adapterRoot, operationId + '.json'), JSON.stringify({
    operationId,
    candidate: { containerId: oldId, imageId, privatePort: 3000 },
    dependencies: [],
    routes: [{ routeId: 'route-1', domain: 'app.example.com', path: '/', privatePort: 3000 }]
  }));

  const containers = new Map([[oldId, {
    Id: oldId,
    Name: '/app-example-com',
    Image: imageId,
    Config: {
      Image: imageId,
      Entrypoint: ['node'],
      Cmd: ['server.js'],
      WorkingDir: '/app',
      Env: ['PORT=3000'],
      Labels: {
        'com.foxos.managed': 'true',
        'com.foxos.temporary': 'stateless-migration-candidate',
        'com.foxos.stateless-migration.id': operationId
      },
      ExposedPorts: { '3000/tcp': {} }
    },
    HostConfig: {
      NetworkMode: 'foxos-routing',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      ReadonlyRootfs: true,
      CapDrop: ['ALL']
    },
    NetworkSettings: {
      Networks: {
        'foxos-routing': { Aliases: ['app-route'] },
        'foxos-egress': { Aliases: [] }
      }
    },
    Mounts: [],
    State: { Running: true, Status: 'running' }
  }]]);
  let createPayload = null;
  const refreshedRuntimeIds = [];
  const dockerRequest = async (method, requestPath, payload) => {
    const inspectMatch = requestPath.match(/^\/containers\/([a-f0-9]{64})\/json$/);
    if (method === 'GET' && inspectMatch) {
      const value = containers.get(inspectMatch[1]);
      if (!value) throw new Error('No such container');
      return value;
    }
    if (method === 'POST' && requestPath.startsWith('/images/')) return {};
    const renameMatch = requestPath.match(/^\/containers\/([a-f0-9]{64})\/rename\?name=(.+)$/);
    if (method === 'POST' && renameMatch) {
      containers.get(renameMatch[1]).Name = '/' + decodeURIComponent(renameMatch[2]);
      return null;
    }
    if (method === 'POST' && requestPath === '/containers/create?name=app-example-com') {
      createPayload = payload;
      containers.set(newId, {
        Id: newId,
        Name: '/app-example-com',
        Image: imageId,
        Config: { ...payload, Image: payload.Image },
        HostConfig: payload.HostConfig,
        NetworkSettings: {
          Networks: {
            'foxos-routing': {
              Aliases: payload.NetworkingConfig.EndpointsConfig['foxos-routing'].Aliases,
              IPAddress: '10.0.10.43'
            }
          }
        },
        Mounts: [],
        State: { Running: false, Status: 'created' }
      });
      return { Id: newId };
    }
    if (method === 'POST' && requestPath === '/networks/foxos-egress/connect') {
      containers.get(newId).NetworkSettings.Networks['foxos-egress'] = { Aliases: payload.EndpointConfig.Aliases };
      return null;
    }
    if (method === 'POST' && requestPath === '/networks/foxos-routing/disconnect') {
      delete containers.get(newId).NetworkSettings.Networks['foxos-routing'];
      return null;
    }
    if (method === 'POST' && requestPath === '/networks/foxos-routing/connect') {
      containers.get(newId).NetworkSettings.Networks['foxos-routing'] = {
        Aliases: payload.EndpointConfig.Aliases,
        IPAddress: '10.0.10.43'
      };
      return null;
    }
    const actionMatch = requestPath.match(/^\/containers\/([a-f0-9]{64})\/(start|stop)\??/);
    if (method === 'POST' && actionMatch) {
      const value = containers.get(actionMatch[1]);
      value.State = actionMatch[2] === 'start'
        ? { Running: true, Status: 'running' }
        : { Running: false, Status: 'exited' };
      return null;
    }
    const deleteMatch = requestPath.match(/^\/containers\/([a-f0-9]{64})\?/);
    if (method === 'DELETE' && deleteMatch) {
      containers.delete(deleteMatch[1]);
      return null;
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  };
  const manager = createRuntimeIdentityManager({
    dataRoot,
    dockerRequest,
    dockerExec: async (containerId, command) => {
      assert.equal(command.at(-1), 'http://10.0.10.43:3000/healthz');
      return { exitCode: 0, output: '' };
    },
    ingressAuthority: {
      inspectOwnedInfrastructure: async () => ({ gateway: { Id: gatewayId } }),
      hostIngressAddress: async () => '127.0.0.1',
      httpsProbe: async () => ({
        tlsValid: true,
        expectedRoute: true,
        statusCode: 200,
        candidateIdentity: operationId
      }),
      refreshOperationRuntime: async (receivedOperationId, containerId) => {
        assert.equal(receivedOperationId, operationId);
        refreshedRuntimeIds.push(containerId);
      }
    },
    wait: async () => {},
    readinessAttempts: 2
  });

  const result = await manager.reconcileOperation(operationId);
  assert.equal(result.results[0].changed, true);
  assert.equal(result.results[0].imageReference, 'local/app-example-com:current');
  assert.equal(createPayload.Image, 'local/app-example-com:current');
  assert.equal(createPayload.Labels['com.foxos.image.reference'], 'local/app-example-com:current');
  const stagedAliases = createPayload.NetworkingConfig.EndpointsConfig['foxos-routing'].Aliases;
  assert.equal(stagedAliases.includes('app-route'), false);
  assert.match(stagedAliases[0], /-proof-/);
  assert.equal(containers.has(oldId), false);
  assert.equal(containers.get(newId).Image, imageId);
  assert.equal(containers.get(newId).Config.Image, 'local/app-example-com:current');
  assert.equal(containers.get(newId).NetworkSettings.Networks['foxos-routing'].Aliases.includes('app-route'), true);
  assert.deepEqual(refreshedRuntimeIds, [newId]);
  const operation = JSON.parse(fs.readFileSync(path.join(operationRoot, operationId + '.json'), 'utf8'));
  const adapter = JSON.parse(fs.readFileSync(path.join(adapterRoot, operationId + '.json'), 'utf8'));
  assert.equal(operation.candidate.containerId, newId);
  assert.equal(operation.candidate.imageReference, 'local/app-example-com:current');
  assert.equal(adapter.candidate.containerId, newId);
  assert.equal(adapter.candidate.imageReference, 'local/app-example-com:current');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
