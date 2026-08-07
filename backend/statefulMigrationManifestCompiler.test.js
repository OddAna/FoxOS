const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createStatefulMigrationManifestCompiler
} = require('./statefulMigrationManifestCompiler');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const SNAPSHOT_ID = 'snap_' + '2'.repeat(32);
const MANIFEST_ID = 'arev_' + '3'.repeat(32);

function fixture(overrides = {}) {
  const resource = {
    id: RESOURCE_ID,
    kind: 'container',
    name: 'nocodb-provider-uuid',
    role: 'application',
    provider: 'coolify',
    ownership: 'observed',
    protected: false,
    provenance: { safeLabels: {}, service: 'nocodb' },
    runtime: {
      containerId: '4'.repeat(64),
      image: 'nocodb/nocodb:latest',
      imageId: 'sha256:' + '5'.repeat(64),
      state: 'running',
      inspection: 'complete',
      health: {
        configured: true,
        status: 'healthy',
        httpTarget: { protocol: 'http', privatePort: 8080, path: '/api/v1/health', source: 'docker-http-healthcheck' }
      }
    },
    classification: {
      status: 'classified',
      workloadRole: 'application',
      stateClass: 'stateful',
      authorityClass: 'provider-owned'
    },
    routes: [
      { domain: 'db.example.com', path: '/', tls: false },
      { domain: 'db.example.com', path: '/', tls: true }
    ],
    ports: [{ privatePort: 8080, protocol: 'tcp', hostPort: null }],
    mounts: [{ type: 'volume', name: 'provider_nocodb-data', destination: '/usr/app/data', readOnly: false }],
    ...overrides
  };
  const manifest = {
    resourceId: RESOURCE_ID,
    revisionId: MANIFEST_ID,
    evidence: { registrySnapshotId: SNAPSHOT_ID },
    desired: {
      environment: {
        revision: 'env_rev_' + '6'.repeat(32),
        ordinaryNames: ['NC_PUBLIC_URL'],
        secretRefs: [],
        excluded: [{ name: 'COOLIFY_FQDN', reason: 'provider-runtime-metadata' }],
        valuesIncluded: false
      },
      runtime: { constraints: {} }
    },
    gates: {
      status: 'blocked',
      blockers: [
        { code: 'external-provider-authority', section: 'ownership' },
        { code: 'recovery-target-unavailable', section: 'recovery' },
        { code: 'restore-proof-missing', section: 'recovery' },
        { code: 'foxos-route-missing', section: 'routes' }
      ]
    }
  };
  const plannedResource = {
    resourceId: RESOURCE_ID,
    strategy: 'shadow-refresh-bounded-quiesce',
    evidence: { registrySnapshotId: SNAPSHOT_ID, manifestRevisionId: MANIFEST_ID },
    dependencies: [],
    migrationGroup: null
  };
  const serverPlan = { planId: 'mplan_' + '7'.repeat(32), sourceSnapshotId: SNAPSHOT_ID };
  const compiler = createStatefulMigrationManifestCompiler({
    resourceRegistry: { getLatest: () => ({ snapshotId: SNAPSHOT_ID, resources: [resource] }) },
    compileApplicationManifest: () => manifest
  });
  return { compiler, manifest, plannedResource, resource, serverPlan };
}

test('single named-volume application compiles into a controller-neutral executable stateful contract', () => {
  const context = fixture();
  const contract = context.compiler.compile({
    serverPlan: context.serverPlan,
    resource: context.plannedResource
  });
  assert.equal(contract.readiness.status, 'backend-ready');
  assert.equal(contract.readiness.blockers.length, 0);
  assert.equal(contract.routes.length, 1);
  assert.equal(contract.application.name, 'db-example-com');
  assert.equal(contract.candidate.volumes[0].targetName, 'db-example-com-data');
  assert.equal(contract.candidate.volumes[0].sourceName, 'provider_nocodb-data');
  assert.equal(contract.candidate.health.path, '/api/v1/health');
  assert.equal(contract.availability.sourcePauseBudgetMs, 120000);
  assert.equal(contract.guarantees.providerDetached, false);
  assert.equal(JSON.stringify(contract).includes('provider_nocodb-data'), true);
  assert.equal(JSON.stringify(contract).includes('COOLIFY_FQDN='), false);
});

test('companion groups, bind mounts and privileged private ports remain blocked', () => {
  const context = fixture({
    routes: [{ domain: 'app.example.com', path: '/', tls: true, privatePort: 80 }],
    ports: [{ privatePort: 80, protocol: 'tcp', hostPort: null }],
    mounts: [{ type: 'bind', source: '/provider/data', destination: '/data', readOnly: false }]
  });
  context.plannedResource.migrationGroup = {
    parentResourceId: RESOURCE_ID,
    memberResourceIds: [RESOURCE_ID, 'res_' + '8'.repeat(32)]
  };
  const contract = context.compiler.compile({ serverPlan: context.serverPlan, resource: context.plannedResource });
  const codes = contract.readiness.blockers.map((entry) => entry.code);
  assert.equal(contract.readiness.status, 'blocked');
  assert.equal(codes.includes('stateful-group-transaction-required'), true);
  assert.equal(codes.includes('unsupported-mount-policy'), true);
  assert.equal(codes.includes('privileged-private-port-unsupported'), true);
});

test('unrelated manifest blockers cannot be hidden by the stateful transaction', () => {
  const context = fixture();
  context.manifest.gates.blockers.push({
    code: 'database-lifecycle-unsupported',
    section: 'classification',
    message: 'Dedicated database lifecycle is required.'
  });
  const contract = context.compiler.compile({ serverPlan: context.serverPlan, resource: context.plannedResource });
  assert.equal(
    contract.readiness.blockers.some((entry) => entry.code === 'manifest-blocker:database-lifecycle-unsupported'),
    true
  );
});
