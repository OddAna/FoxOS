const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { adapterStatus } = require('./statelessMigrationManager');
const {
  createProductionStatelessMigrationAdapter,
  dependencyFromValue,
  environmentForStartup,
  startupContractFromObservation,
  rewriteEnvironmentDependencies
} = require('./productionStatelessMigrationAdapter');

test('dependency discovery accepts known URL transports without retaining credentials', () => {
  assert.deepEqual(dependencyFromValue('postgres://user:secret@database:5432/app'), {
    hostname: 'database',
    port: 5432,
    protocol: 'postgres:'
  });
  assert.equal(dependencyFromValue('not-a-url'), null);
  assert.equal(dependencyFromValue('file:///tmp/data'), null);
});

test('dependency URLs are rewritten in memory to operation-scoped bridge aliases', () => {
  const value = 'postgres://user:secret@database:5432/app?sslmode=disable';
  const rewritten = rewriteEnvironmentDependencies(['DATABASE_URL=' + value, 'PUBLIC_URL=https://example.com'], [{
    hostname: 'database',
    port: 5432,
    bridgeAlias: 'foxos-dep-123456789012-abcdef12'
  }]);
  assert.deepEqual(rewritten, [
    'DATABASE_URL=postgres://user:secret@foxos-dep-123456789012-abcdef12:5432/app?sslmode=disable',
    'PUBLIC_URL=https://example.com'
  ]);
});

test('Next process titles become an executable standalone runtime contract', () => {
  const startup = startupContractFromObservation({
    argv: ['next-server (v15.5.12)'],
    argvExecutable: false,
    executablePath: '/nix/store/example-node/bin/node',
    workingDirectory: '/app/.next/standalone',
    nextStandaloneServer: true
  });
  assert.deepEqual(startup, {
    kind: 'next-standalone-runtime',
    entrypoint: ['/nix/store/example-node/bin/node', 'server.js'],
    cmd: [],
    workingDirectory: '/app/.next/standalone'
  });
  assert.deepEqual(environmentForStartup([
    'PORT=3000',
    'HOSTNAME=source-container'
  ], startup), [
    'PORT=3000',
    'HOSTNAME=0.0.0.0'
  ]);
});

test('unresolvable process titles fail closed instead of becoming Docker entrypoints', () => {
  assert.equal(startupContractFromObservation({
    argv: ['custom process title'],
    argvExecutable: false,
    executablePath: '/usr/bin/node',
    workingDirectory: '/app',
    nextStandaloneServer: false
  }), null);
  assert.deepEqual(startupContractFromObservation({
    argv: ['node', 'server.js'],
    argvExecutable: true,
    executablePath: '/usr/bin/node',
    workingDirectory: '/app',
    nextStandaloneServer: false
  }), {
    kind: 'observed-process-argv',
    entrypoint: ['node', 'server.js'],
    cmd: [],
    workingDirectory: '/app'
  });
});

test('candidate creation applies the reconstructed Next standalone contract', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-next-startup-'));
  const operationId = 'smop_' + '1'.repeat(32);
  const resourceId = 'res_' + '2'.repeat(32);
  const sourceId = '3'.repeat(64);
  const candidateId = '4'.repeat(64);
  const imageId = 'sha256:' + '5'.repeat(64);
  const agentImageId = 'sha256:' + '6'.repeat(64);
  const snapshotId = 'snap_' + '7'.repeat(32);
  const environmentRevision = 'env_rev_' + '8'.repeat(32);
  let createPayload = null;
  const source = {
    Id: sourceId,
    Image: imageId,
    State: { Running: true },
    NetworkSettings: { Networks: { legacy: {} } }
  };
  const dockerRequest = async (method, requestPath, payload) => {
    if (method === 'GET' && requestPath === '/containers/' + sourceId + '/json') return source;
    if (method === 'GET' && requestPath === '/containers/foxos/json') return { Image: agentImageId };
    if (method === 'POST' && requestPath.startsWith('/images/')) return {};
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      createPayload = payload;
      return { Id: candidateId };
    }
    if (method === 'POST' && requestPath === '/networks/foxos-egress/connect') return {};
    if (method === 'POST' && requestPath === '/containers/' + candidateId + '/start') return {};
    if (method === 'GET' && requestPath === '/containers/' + candidateId + '/json') {
      return { Id: candidateId, Image: imageId, State: { Running: true, ExitCode: 0, OOMKilled: false } };
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  };
  const dockerExec = async (_containerId, command) => {
    if (command[0] === 'cat') return { exitCode: 0, output: 'next-server (v15.5.12)\0' };
    if (command[0] === 'readlink' && command[1] === '/proc/1/exe') {
      return { exitCode: 0, output: '/nix/store/example-node/bin/node\n' };
    }
    if (command[0] === 'readlink' && command[1] === '/proc/1/cwd') {
      return { exitCode: 0, output: '/app/.next/standalone\n' };
    }
    if (command[0] === 'test') return { exitCode: 0, output: '' };
    throw new Error('Unexpected Docker exec: ' + command.join(' '));
  };
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest,
    dockerExec,
    resourceRegistry: {
      getLatest: () => ({
        snapshotId,
        resources: [{ id: resourceId, runtime: { containerId: sourceId, imageId } }]
      })
    },
    secretManager: {
      getEnvironmentRevision: () => ({ revision: environmentRevision }),
      resolveEnvironment: () => ['PORT=3000', 'HOSTNAME=source-container']
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    }
  });
  fs.writeFileSync(path.join(adapter.paths.operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    planId: 'smplan_' + '9'.repeat(32),
    resourceId,
    source: { containerId: sourceId, imageId },
    dependencies: [],
    candidate: null,
    routes: []
  }));
  const candidate = await adapter.createCandidate({
    operationId,
    plan: {
      sourceSnapshotId: snapshotId,
      resource: { resourceId },
      executionContract: {
        contractId: 'smcontract_' + 'a'.repeat(32),
        candidate: {
          environment: { revision: environmentRevision },
          runtime: {
            user: null,
            restartPolicy: 'unless-stopped',
            readOnlyRootFilesystem: false,
            memoryBytes: 536870912,
            nanoCpus: 1000000000,
            pidsLimit: 256
          },
          ingressPorts: [3000],
          health: { privatePort: 3000 }
        }
      }
    }
  });
  assert.equal(candidate.owned, true);
  assert.deepEqual(createPayload.Entrypoint, ['/nix/store/example-node/bin/node', 'server.js']);
  assert.deepEqual(createPayload.Cmd, []);
  assert.equal(createPayload.WorkingDir, '/app/.next/standalone');
  assert.equal(createPayload.Env.includes('HOSTNAME=0.0.0.0'), true);
  assert.equal(createPayload.Env.includes('HOSTNAME=source-container'), false);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('production adapter exposes every safe transaction capability and no destructive methods', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-adapter-'));
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest: async () => ({}),
    dockerExec: async () => ({ exitCode: 0 }),
    resourceRegistry: { getLatest: () => null },
    secretManager: {
      getEnvironmentRevision: () => null,
      resolveEnvironment: () => []
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      inspectOwnedInfrastructure: async () => ({}),
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    }
  });
  const status = adapterStatus(adapter, async () => ({ approved: true }));
  assert.equal(status.ready, true);
  assert.deepEqual(status.unsafeCapabilities, []);
  assert.equal(typeof adapter.stopSource, 'undefined');
  assert.equal(typeof adapter.detachProvider, 'undefined');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
