const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { adapterStatus } = require('./statelessMigrationManager');
const {
  LAB_RESOURCE_ID,
  LAB_RESOURCE_NAME,
  createStatelessMigrationLabAdapter
} = require('./statelessMigrationLabAdapter');

function labSpec() {
  return {
    resourceId: LAB_RESOURCE_ID,
    resourceName: LAB_RESOURCE_NAME,
    runId: 'slab_' + 'a'.repeat(24),
    sourceContainerId: 'b'.repeat(64),
    sourceImageId: 'sha256:' + 'c'.repeat(64),
    gatewayImageId: 'sha256:' + 'd'.repeat(64),
    networkId: 'e'.repeat(64),
    networkName: 'foxos-stateless-lab-123456789abc',
    sourceIdentity: 'foxos-stateless-lab-source-123456789abc',
    candidateIdentity: 'foxos-stateless-lab-candidate-123456789abc',
    routeName: 'foxos-stateless-lab-123456789abc',
    domain: 'lab-123456789abc.foxos.invalid',
    path: '/_foxos/migrations/stateless-lab/123456789abc/',
    planEvidence: { source: { type: 'immutable-oci' } }
  };
}

test('real disposable adapter advertises the complete transaction contract without unsafe source/provider methods', () => {
  const adapter = createStatelessMigrationLabAdapter({
    dockerRequest: async () => null,
    dockerExec: async () => null,
    probeHttp: async () => null,
    labSpec: labSpec()
  });
  const status = adapterStatus(adapter, async () => ({ approved: false }));
  assert.equal(status.ready, true);
  assert.deepEqual(status.missingMethods, []);
  assert.deepEqual(status.missingCapabilities, []);
  assert.deepEqual(status.unsafeCapabilities, []);
  assert.equal(Object.hasOwn(adapter, 'stopSource'), false);
  assert.equal(Object.hasOwn(adapter, 'recreateSource'), false);
  assert.equal(Object.hasOwn(adapter, 'detachProvider'), false);
  assert.equal(Object.hasOwn(adapter, 'deleteSource'), false);
});

test('disposable adapter rejects a production-looking domain or unscoped run identity before Docker access', () => {
  const domain = labSpec();
  domain.domain = 'example.com';
  assert.throws(() => createStatelessMigrationLabAdapter({
    dockerRequest: async () => null,
    dockerExec: async () => null,
    probeHttp: async () => null,
    labSpec: domain
  }), (error) => error.code === 'invalid-lab-spec');

  const run = labSpec();
  run.runId = 'production';
  assert.throws(() => createStatelessMigrationLabAdapter({
    dockerRequest: async () => null,
    dockerExec: async () => null,
    probeHttp: async () => null,
    labSpec: run
  }), (error) => error.code === 'invalid-lab-spec');
});

test('disposable adapter rejects a source restart between preflight and candidate creation', async () => {
  const spec = labSpec();
  let startedAt = '2026-08-05T00:00:00.000000000Z';
  let mutationRequested = false;
  const sourceDetails = () => ({
    Id: spec.sourceContainerId,
    Image: spec.sourceImageId,
    RestartCount: 0,
    State: { Status: 'running', StartedAt: startedAt },
    Config: {
      User: '65532:65532',
      Hostname: spec.sourceIdentity,
      Labels: {
        'com.foxos.stateless-migration.disposable': 'true',
        'com.foxos.stateless-migration.run': spec.runId,
        'com.foxos.resource.id': LAB_RESOURCE_ID,
        'com.foxos.source': 'true'
      }
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 128 * 1024 * 1024,
      NanoCpus: 500000000,
      PidsLimit: 128,
      NetworkMode: spec.networkName
    },
    Mounts: [],
    NetworkSettings: {
      Ports: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] },
      Networks: { [spec.networkName]: {} }
    }
  });
  const adapter = createStatelessMigrationLabAdapter({
    dockerRequest: async (method, endpoint) => {
      if (method === 'GET' && endpoint === '/networks/' + spec.networkId) {
        return {
          Id: spec.networkId,
          Name: spec.networkName,
          Internal: false,
          Labels: {
            'com.foxos.stateless-migration.disposable': 'true',
            'com.foxos.stateless-migration.run': spec.runId,
            'com.foxos.resource.id': LAB_RESOURCE_ID,
            'com.foxos.managed': 'true'
          }
        };
      }
      if (method === 'GET' && endpoint === '/containers/' + spec.sourceContainerId + '/json') {
        return sourceDetails();
      }
      if (method === 'GET' && endpoint.startsWith('/containers/json?')) return [];
      mutationRequested = true;
      throw new Error('unexpected Docker mutation');
    },
    dockerExec: async () => null,
    probeHttp: async () => ({ statusCode: 200, body: 'Hostname: ' + spec.sourceIdentity }),
    labSpec: spec
  });
  const plan = {
    resource: {
      resourceId: LAB_RESOURCE_ID,
      name: LAB_RESOURCE_NAME,
      evidence: spec.planEvidence,
      evidenceFingerprint: 'evidence_' + '1'.repeat(24)
    }
  };
  const operationId = 'smop_' + '2'.repeat(32);
  await adapter.preflight({ plan, operationId });
  startedAt = '2026-08-05T00:01:00.000000000Z';
  await assert.rejects(
    adapter.createCandidate({ plan, operationId }),
    (error) => error.code === 'lab-source-continuity-failed'
  );
  assert.equal(mutationRequested, false);
});

test('lab CLI requires the exact disposable confirmation before opening Docker', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'statelessMigrationLabCli.js'), 'proof'], {
    encoding: 'utf8',
    timeout: 5000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RUN DISPOSABLE STATELESS LAB/);
});

test('lab TLS gateway rejects an unsafe domain before binding a route', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'statelessMigrationLabGateway.js'), 'serve'], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      FOXOS_STATELESS_LAB_DOMAIN: 'production.example.com',
      FOXOS_STATELESS_LAB_PATH: '/_foxos/migrations/stateless-lab/123456789abc/',
      FOXOS_STATELESS_LAB_ROUTE: 'foxos-stateless-lab-123456789abc',
      FOXOS_STATELESS_LAB_SOURCE_HOST: 'foxos-stateless-lab-source-123456789abc',
      FOXOS_STATELESS_LAB_CANDIDATE_HOST: 'foxos-stateless-lab-candidate-123456789abc',
      FOXOS_STATELESS_LAB_SOURCE_IDENTITY: 'foxos-stateless-lab-source-123456789abc',
      FOXOS_STATELESS_LAB_CANDIDATE_IDENTITY: 'foxos-stateless-lab-candidate-123456789abc'
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TLS domain is invalid/);
});
