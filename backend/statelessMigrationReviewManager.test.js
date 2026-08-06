const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SAVE_STATELESS_MIGRATION_REVIEW_CONFIRMATION,
  createStatelessMigrationReviewManager
} = require('./statelessMigrationReviewManager');

const STATELESS_PLAN_ID = 'smplan_' + '1'.repeat(32);
const SERVER_PLAN_ID = 'mplan_' + '2'.repeat(32);
const SNAPSHOT_ID = 'snap_' + '3'.repeat(32);
const RESOURCE_ID = 'res_' + '4'.repeat(32);
const MANIFEST_REVISION_ID = 'arev_' + '5'.repeat(32);
const CONTRACT_ID = 'smcontract_' + '6'.repeat(32);
const ROUTE_A = 'smroute_' + '7'.repeat(24);
const ROUTE_B = 'smroute_' + '8'.repeat(24);

function executionContract(overrides = {}) {
  return {
    contractId: CONTRACT_ID,
    manifestRevisionId: MANIFEST_REVISION_ID,
    candidate: {
      runtime: {
        user: '1000:1000',
        privileged: false,
        readOnlyRootFilesystem: true,
        noNewPrivileges: true,
        allCapabilitiesDropped: true,
        memoryBytes: 536870912,
        nanoCpus: 1000000000,
        pidsLimit: 256,
        restartPolicy: 'unless-stopped',
        hostPortsPublished: false,
        writableMounts: 0
      },
      health: {
        protocol: 'http',
        privatePort: 8080,
        path: '/',
        source: 'observed-route',
        acceptedStatusMinimum: 200,
        acceptedStatusMaximum: 399
      }
    },
    routes: [
      {
        routeId: ROUTE_A,
        domain: 'app.example.com',
        path: '/',
        upstreamPrivatePort: 8080,
        redirectHttpToHttps: true,
        tls: { authority: 'foxos', trust: 'browser-trusted' }
      },
      {
        routeId: ROUTE_B,
        domain: 'app.example.com',
        path: '/admin',
        upstreamPrivatePort: 8081,
        redirectHttpToHttps: true,
        tls: { authority: 'foxos', trust: 'browser-trusted' }
      }
    ],
    uiReview: { runtimeDefaultsApplied: ['memoryBytes', 'pidsLimit'] },
    readiness: { blockers: [] },
    ...overrides
  };
}

function migrationPlan(contract = executionContract()) {
  return {
    planId: STATELESS_PLAN_ID,
    serverPlanId: SERVER_PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    resource: {
      resourceId: RESOURCE_ID,
      evidenceFingerprint: 'a'.repeat(64)
    },
    executionContract: contract
  };
}

function harness(contract = executionContract()) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateless-review-'));
  let snapshot = { snapshotId: SNAPSHOT_ID };
  const plan = migrationPlan(contract);
  const manager = createStatelessMigrationReviewManager({
    dataRoot,
    getStatelessMigrationPlan: (planId) => {
      assert.equal(planId, STATELESS_PLAN_ID);
      return plan;
    },
    getLatestRegistrySnapshot: () => snapshot,
    clock: () => new Date('2026-08-05T12:00:00.000Z')
  });
  return {
    dataRoot,
    manager,
    plan,
    setSnapshot: (value) => { snapshot = value; }
  };
}

function completeInput() {
  return {
    statelessPlanId: STATELESS_PLAN_ID,
    serverPlanId: SERVER_PLAN_ID,
    resourceId: RESOURCE_ID,
    executionContractId: CONTRACT_ID,
    healthRouteId: ROUTE_A,
    runtimeConfirmed: true,
    routes: [
      { routeId: ROUTE_A, confirmed: true, certificateAdapter: 'acme-http-01' },
      { routeId: ROUTE_B, confirmed: true, certificateAdapter: 'acme-dns-01' }
    ],
    confirmation: SAVE_STATELESS_MIGRATION_REVIEW_CONFIRMATION
  };
}

test('persists a complete plan-bound review without opening the execution gate', () => {
  const context = harness();
  const record = context.manager.save({
    ...completeInput(),
    password: 'must-never-persist',
    routes: completeInput().routes.map((route) => ({ ...route, token: 'must-never-persist' }))
  });

  assert.match(record.reviewId, /^smreview_[a-f0-9]{32}$/);
  assert.equal(record.reviewComplete, true);
  assert.equal(record.reviewBlockers.length, 0);
  assert.equal(record.executionGate.status, 'sealed');
  assert.equal(record.executionGate.approvalIssued, false);
  assert.equal(record.guarantees.runtimeMutated, false);
  assert.equal(record.guarantees.routesMutated, false);
  assert.equal(record.guarantees.certificateProviderSelected, false);
  assert.equal(record.configuration.healthTarget.privatePort, 8080);
  assert.equal(record.configuration.runtime.memoryBytes, 536870912);
  assert.equal(context.manager.status(STATELESS_PLAN_ID).state, 'complete');
  const persisted = fs.readFileSync(path.join(
    context.manager.paths.configurationsRoot,
    STATELESS_PLAN_ID + '.json'
  ), 'utf8');
  assert.equal(persisted.includes('must-never-persist'), false);
  assert.equal(persisted.toLowerCase().includes('cloudflare'), false);
  assert.equal(fs.statSync(context.manager.paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(
    context.manager.paths.configurationsRoot,
    STATELESS_PLAN_ID + '.json'
  )).mode & 0o777, 0o600);
});

test('review binds the compiler-owned Docker health path instead of replacing it with the route path', () => {
  const contract = executionContract();
  contract.candidate.health.path = '/healthz';
  contract.candidate.health.source = 'docker-http-healthcheck';
  const context = harness(contract);
  const record = context.manager.save(completeInput());

  assert.equal(record.configuration.healthTarget.routeId, ROUTE_A);
  assert.equal(record.configuration.healthTarget.privatePort, 8080);
  assert.equal(record.configuration.healthTarget.path, '/healthz');
  assert.equal(record.configuration.healthTarget.source, 'docker-http-healthcheck');
  assert.equal(record.configuration.routes[0].path, '/');
});

test('saves an incomplete review and returns exact missing review blockers', () => {
  const context = harness();
  assert.equal(context.manager.status(STATELESS_PLAN_ID).defaults.healthRouteId, null);
  const record = context.manager.save({
    ...completeInput(),
    healthRouteId: null,
    runtimeConfirmed: false,
    routes: [{ routeId: ROUTE_A, confirmed: true, certificateAdapter: null }]
  });

  assert.equal(record.reviewComplete, false);
  assert.deepEqual(new Set(record.reviewBlockers.map((blocker) => blocker.code)), new Set([
    'health-target-not-reviewed',
    'runtime-defaults-not-reviewed',
    'certificate-adapter-not-selected',
    'route-not-reviewed'
  ]));
  assert.equal(context.manager.status(STATELESS_PLAN_ID).state, 'incomplete');
});

test('rejects configuration tampering and blocked execution contracts', () => {
  const context = harness();
  assert.throws(() => context.manager.save({
    ...completeInput(),
    executionContractId: 'smcontract_' + '9'.repeat(32)
  }), (error) => error.code === 'review-binding-mismatch');
  assert.throws(() => context.manager.save({
    ...completeInput(),
    healthRouteId: 'smroute_' + '9'.repeat(24)
  }), (error) => error.code === 'health-target-not-in-contract');
  assert.throws(() => context.manager.save({
    ...completeInput(),
    healthRouteId: ROUTE_B
  }), (error) => error.code === 'health-route-port-mismatch');
  assert.throws(() => context.manager.save({
    ...completeInput(),
    routes: [{ routeId: ROUTE_A, confirmed: true, certificateAdapter: 'vendor-account' }]
  }), (error) => error.code === 'unsupported-certificate-adapter');

  const blocked = harness(executionContract({
    readiness: { blockers: [{ code: 'source-missing' }] }
  }));
  assert.throws(() => blocked.manager.save(completeInput()), (error) => error.code === 'execution-contract-blocked');
});

test('marks a review stale and rejects writes after registry drift', () => {
  const context = harness();
  context.manager.save(completeInput());
  context.setSnapshot({ snapshotId: 'snap_' + '9'.repeat(32) });

  const status = context.manager.status(STATELESS_PLAN_ID);
  assert.equal(status.state, 'stale');
  assert.equal(status.stale, true);
  assert.throws(() => context.manager.save(completeInput()), (error) => error.code === 'stale-stateless-plan');
});

test('marks an unsaved plan stale after registry drift', () => {
  const context = harness();
  context.setSnapshot({ snapshotId: 'snap_' + '9'.repeat(32) });

  const status = context.manager.status(STATELESS_PLAN_ID);
  assert.equal(status.state, 'stale');
  assert.equal(status.current, null);
});
