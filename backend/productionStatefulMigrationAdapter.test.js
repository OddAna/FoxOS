const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createProductionStatefulMigrationAdapter
} = require('./productionStatefulMigrationAdapter');

const SOURCE_ID = 'a'.repeat(64);
const CANDIDATE_ID = 'b'.repeat(64);
const PROXY_ID = 'c'.repeat(64);
const GATEWAY_ID = 'd'.repeat(64);
const IMAGE_ID = 'sha256:' + 'e'.repeat(64);
const RESOURCE_ID = 'res_' + '1'.repeat(32);
const OPERATION_ID = 'stmop_' + '2'.repeat(32);
const ROUTE_ID = 'smroute_' + '3'.repeat(24);

function harness({ localDependency = false } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-stateful-'));
  const calls = [];
  const volumes = new Map();
  let candidate = null;
  const source = {
    Id: SOURCE_ID,
    Image: IMAGE_ID,
    Name: '/provider-runtime',
    State: { Running: true, Paused: false, Health: { Status: 'healthy' } },
    Config: {
      Image: 'nocodb/nocodb:latest',
      Cmd: null,
      Entrypoint: null,
      User: '',
      WorkingDir: '',
      Env: [localDependency ? 'DATABASE_URL=postgres://db:5432/app' : 'NC_PUBLIC_URL=https://db.example.com'],
      Healthcheck: { Test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8080/api/v1/health'] }
    },
    HostConfig: {
      Privileged: false,
      NetworkMode: 'provider-network',
      PidMode: '', IpcMode: '', UTSMode: '', Devices: [], CapAdd: []
    },
    NetworkSettings: { Networks: { 'provider-network': {} } }
  };
  const resource = {
    id: RESOURCE_ID,
    role: 'application',
    runtime: { containerId: SOURCE_ID, imageId: IMAGE_ID },
    networks: [{ name: 'provider-network' }]
  };
  const proxy = {
    id: 'res_' + '4'.repeat(32),
    role: 'proxy',
    runtime: { containerId: PROXY_ID },
    networks: [{ name: 'provider-network' }]
  };
  const snapshot = {
    snapshotId: 'snap_' + '5'.repeat(32),
    resources: [resource, proxy],
    relationships: [{
      type: 'route-through-proxy',
      sourceResourceId: RESOURCE_ID,
      targetResourceId: proxy.id
    }],
    conflicts: []
  };
  async function dockerRequest(method, requestPath, payload) {
    calls.push([method, requestPath, payload]);
    if (method === 'GET' && requestPath === '/containers/' + SOURCE_ID + '/json') return source;
    if (method === 'GET' && requestPath === '/images/' + encodeURIComponent(IMAGE_ID) + '/json') {
      return { Id: IMAGE_ID, Config: { Cmd: null, Entrypoint: null, User: '', WorkingDir: '' } };
    }
    if (method === 'GET' && requestPath === '/networks/provider-network') {
      return { Containers: {
        [SOURCE_ID]: { Name: 'provider-runtime' },
        ...(localDependency ? { ['f'.repeat(64)]: { Name: 'db' } } : {})
      } };
    }
    if (method === 'GET' && requestPath === '/networks/foxos-egress') {
      return { Internal: false, Labels: { 'com.foxos.core': 'true', 'com.foxos.egress': 'true' } };
    }
    if (method === 'GET' && requestPath === '/containers/db-example-com/json') {
      const error = new Error('No such container');
      error.statusCode = 404;
      throw error;
    }
    if (method === 'GET' && requestPath.startsWith('/volumes/')) {
      const name = decodeURIComponent(requestPath.slice('/volumes/'.length));
      if (!volumes.has(name)) throw new Error('No such volume');
      return volumes.get(name);
    }
    if (method === 'POST' && requestPath === '/containers/' + SOURCE_ID + '/pause') {
      source.State.Paused = true;
      return {};
    }
    if (method === 'POST' && requestPath === '/containers/' + SOURCE_ID + '/unpause') {
      source.State.Paused = false;
      return {};
    }
    if (method === 'POST' && requestPath === '/containers/' + SOURCE_ID + '/stop?t=10') {
      source.State.Running = false;
      return {};
    }
    if (method === 'POST' && requestPath === '/containers/' + SOURCE_ID + '/start') {
      source.State.Running = true;
      return {};
    }
    if (method === 'POST' && requestPath.startsWith('/images/')) return {};
    if (method === 'POST' && requestPath === '/volumes/create') {
      volumes.set(payload.Name, { Name: payload.Name, Labels: payload.Labels });
      return { Name: payload.Name };
    }
    if (method === 'POST' && requestPath === '/containers/create?name=db-example-com') {
      candidate = {
        Id: CANDIDATE_ID,
        Image: IMAGE_ID,
        State: { Running: false, Paused: false },
        Config: { Image: payload.Image, Labels: payload.Labels }
      };
      return { Id: CANDIDATE_ID };
    }
    if (method === 'POST' && requestPath === '/containers/' + CANDIDATE_ID + '/start') {
      candidate.State.Running = true;
      return {};
    }
    if (method === 'POST' && requestPath === '/containers/' + CANDIDATE_ID + '/stop?t=10') {
      candidate.State.Running = false;
      return {};
    }
    if (method === 'GET' && requestPath === '/containers/' + CANDIDATE_ID + '/json') return candidate;
    if (method === 'POST' && requestPath === '/networks/foxos-egress/connect') return {};
    if (method === 'DELETE' && requestPath.startsWith('/containers/' + CANDIDATE_ID)) {
      candidate = null;
      return {};
    }
    if (method === 'DELETE' && requestPath.startsWith('/volumes/')) {
      volumes.delete(decodeURIComponent(requestPath.slice('/volumes/'.length)));
      return {};
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  }
  const ingressCalls = [];
  const ingressAuthority = {
    inspectOwnedInfrastructure: async () => ({ gateway: { Id: GATEWAY_ID } }),
    ensureLegacyBridge: async (input) => { ingressCalls.push(['legacy-bridge', input]); },
    verifyLegacyDomain: async (input) => { ingressCalls.push(['legacy-domain', input]); return { legacyReady: true }; },
    verifyLegacyBackend: async (input) => { ingressCalls.push(['legacy-backend', input]); return { legacyReady: true }; },
    httpsProbe: async (input) => ({
      statusCode: 200,
      tlsValid: true,
      expectedRoute: input.expectedRouteId ? true : null,
      candidateIdentity: input.expectedRouteId ? OPERATION_ID : null
    }),
    stageRoutes: async (routes) => routes.map((route) => ({ ...route, status: 'staged' })),
    switchDomain: async (domain, target) => { ingressCalls.push(['switch', domain, target]); },
    hostIngressAddress: async () => '203.0.113.10',
    removeRoutes: async (routeIds) => { ingressCalls.push(['remove-routes', routeIds]); }
  };
  const snapshots = [];
  const adapter = createProductionStatefulMigrationAdapter({
    dataRoot,
    dockerRequest,
    dockerExec: async () => ({ exitCode: 0, output: '  HTTP/1.1 200 OK\n' }),
    resourceRegistry: { getLatest: () => snapshot },
    secretManager: {
      getEnvironmentRevision: () => ({
        revision: 'env_rev_' + '6'.repeat(32),
        ordinary: [{ name: 'NC_PUBLIC_URL', value: 'https://db.example.com' }],
        secretRefs: [],
        excluded: [{ name: 'COOLIFY_FQDN' }]
      }),
      resolveEnvironment: () => [
        localDependency ? 'DATABASE_URL=postgres://db:5432/app' : 'NC_PUBLIC_URL=https://db.example.com'
      ]
    },
    volumeSnapshots: {
      create: async ({ operationId, volume }) => {
        const record = {
          operationId,
          volumeName: volume.name,
          plaintextSha256: '7'.repeat(64),
          plaintextBytes: 128
        };
        snapshots.push(record);
        return record;
      },
      restore: async ({ snapshot, sourceVolumeName, volume }) => ({
        restored: true,
        plaintextSha256: snapshot.plaintextSha256,
        sourceVolumeName,
        targetVolumeName: volume.name
      })
    },
    certificateImporter: { importDomain: async (input) => { ingressCalls.push(['certificate', input]); } },
    ingressAuthority,
    clock: () => new Date('2026-08-07T12:00:00.000Z'),
    wait: async () => {}
  });
  const plan = {
    planId: 'stmplan_' + '8'.repeat(32),
    sourceSnapshotId: snapshot.snapshotId,
    resource: {
      resourceId: RESOURCE_ID,
      evidenceFingerprint: '9'.repeat(64),
      executionContractId: 'stmcontract_' + 'a'.repeat(32)
    },
    executionContract: {
      contractId: 'stmcontract_' + 'a'.repeat(32),
      source: { containerId: SOURCE_ID, imageId: IMAGE_ID },
      application: {
        appId: 'db-example-com',
        displayName: 'db.example.com',
        name: 'db-example-com',
        alias: 'db-example-com'
      },
      candidate: {
        environment: { revision: 'env_rev_' + '6'.repeat(32) },
        volumes: [{
          sourceName: 'provider_nocodb-data',
          targetName: 'db-example-com-data',
          destination: '/usr/app/data'
        }],
        ingressPorts: [8080],
        health: {
          privatePort: 8080,
          path: '/api/v1/health',
          acceptedStatusMinimum: 200,
          acceptedStatusMaximum: 399
        },
        runtime: { memoryBytes: 536870912, nanoCpus: 1000000000, pidsLimit: 256 }
      },
      routes: [{
        routeId: ROUTE_ID,
        domain: 'db.example.com',
        path: '/',
        upstreamPrivatePort: 8080
      }]
    }
  };
  return { adapter, calls, dataRoot, ingressCalls, plan, snapshots, source, volumes };
}

test('production stateful adapter performs final snapshot, controller-neutral restore and reversible traffic handoff', async () => {
  const context = harness();
  try {
    const preflight = await context.adapter.preflight({ plan: context.plan, operationId: OPERATION_ID });
    assert.equal(preflight.sourceHealthy, true);
    const snapshot = await context.adapter.quiesceAndSnapshot({ plan: context.plan, operationId: OPERATION_ID });
    assert.equal(snapshot.sourcePaused, true);
    assert.equal(context.source.State.Paused, true);
    const candidate = await context.adapter.createCandidate({ plan: context.plan, operationId: OPERATION_ID });
    assert.equal(candidate.containerName, 'db-example-com');
    assert.equal(candidate.restoredVolumes, 1);
    assert.equal(context.volumes.has('db-example-com-data'), true);
    assert.equal([...context.volumes.keys()].some((name) => name.includes('foxos')), false);
    assert.equal((await context.adapter.verifyCandidateHealth({ plan: context.plan, operationId: OPERATION_ID })).healthy, true);
    const route = await context.adapter.stageRoute({ plan: context.plan, operationId: OPERATION_ID });
    assert.equal(route.tlsReady, true);
    assert.equal((await context.adapter.switchTraffic({ operationId: OPERATION_ID })).switched, true);
    assert.equal((await context.adapter.verifyTraffic({ plan: context.plan, operationId: OPERATION_ID })).healthy, true);
    const parked = await context.adapter.parkSourceForRollback({ plan: context.plan, operationId: OPERATION_ID });
    assert.equal(parked.sourceStopped, true);
    assert.equal(context.source.State.Running, false);

    await context.adapter.rollbackTraffic({ plan: context.plan, operationId: OPERATION_ID });
    assert.equal((await context.adapter.verifyRollback({ plan: context.plan, operationId: OPERATION_ID })).trafficRestored, true);
    await context.adapter.cleanupStagedRoute({ operationId: OPERATION_ID });
    await context.adapter.cleanupCandidate({ operationId: OPERATION_ID });
    assert.equal(context.source.State.Running, true);
    assert.equal(context.volumes.size, 0);
    assert.equal(context.snapshots.length, 1);
    assert.equal(context.ingressCalls.some((entry) => entry[0] === 'switch' && entry[2] === 'foxos'), true);
    assert.equal(context.ingressCalls.some((entry) => entry[0] === 'switch' && entry[2] === 'legacy'), true);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});

test('preflight rejects a local companion dependency before pausing or creating a candidate', async () => {
  const context = harness({ localDependency: true });
  try {
    await assert.rejects(
      context.adapter.preflight({ plan: context.plan, operationId: OPERATION_ID }),
      (error) => error.code === 'stateful-dependency-transaction-required'
    );
    assert.equal(context.source.State.Paused, false);
    assert.equal(context.volumes.size, 0);
    assert.equal(context.calls.some((entry) => entry[1] && entry[1].includes('/containers/create')), false);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});
