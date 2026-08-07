const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PREPARE_STATEFUL_MIGRATION_CONFIRMATION,
  createStatefulMigrationManager
} = require('./statefulMigrationManager');

const RESOURCE_ID = 'res_' + 'a'.repeat(32);
const SERVER_PLAN_ID = 'mplan_' + 'b'.repeat(32);

function harness({
  failTraffic = false,
  failDuringSwitch = false,
  failSnapshotAfterPause = false,
  stalePause = false,
  contractBlockers = []
} = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateful-migration-'));
  const calls = [];
  const serverPlan = {
    planId: SERVER_PLAN_ID,
    sourceSnapshotId: 'snap_' + 'c'.repeat(32),
    resources: [{
      resourceId: RESOURCE_ID,
      name: 'stateful-app',
      observedProvider: 'coolify',
      observedOwnership: 'observed',
      migrationRequired: true,
      protected: false,
      strategy: 'shadow-refresh-bounded-quiesce',
      readiness: { reviewEligible: true, applyImplemented: true },
      evidence: { manifestRevisionId: 'arev_' + 'd'.repeat(32) }
    }]
  };
  const executionContract = {
    contractId: 'stmcontract_' + 'e'.repeat(32),
    availability: { sourcePauseBudgetMs: 120000 },
    candidate: { volumes: [{ sourceName: 'source-data', targetName: 'app-data' }] },
    routes: [{ routeId: 'smroute_' + 'f'.repeat(24), domain: 'app.example.com', path: '/' }],
    readiness: { status: contractBlockers.length ? 'blocked' : 'backend-ready', blockers: contractBlockers }
  };
  let persistedAdapterState = null;
  const adapter = {
    preflight: async ({ plan }) => {
      calls.push('preflight');
      return { evidenceFingerprint: plan.resource.evidenceFingerprint, sourceHealthy: true, routeCollisionFree: true };
    },
    quiesceAndSnapshot: async () => {
      calls.push('snapshot');
      if (failSnapshotAfterPause) {
        persistedAdapterState = { source: { paused: true, pauseIntentPersisted: true } };
        const error = new Error('snapshot stream failed');
        error.code = 'snapshot-stream-failed';
        throw error;
      }
      return {
        sourcePaused: true,
        snapshotCount: 1,
        encrypted: true,
        plaintextStored: false,
        pauseStartedAtMs: Date.now() - (stalePause ? 120001 : 5)
      };
    },
    createCandidate: async () => {
      calls.push('candidate');
      return { containerId: '1'.repeat(64), owned: true, separateFromSource: true, restoredVolumes: 1 };
    },
    verifyCandidateHealth: async () => {
      calls.push('health');
      return { healthy: true, statusCode: 200 };
    },
    stageRoute: async () => {
      calls.push('stage');
      return {
        routeId: 'smroute_' + 'f'.repeat(24), domain: 'app.example.com', path: '/',
        staged: true, active: false, tlsReady: true,
        routes: [{ routeId: 'smroute_' + 'f'.repeat(24), domain: 'app.example.com', path: '/' }]
      };
    },
    switchTraffic: async () => {
      calls.push('switch');
      if (failDuringSwitch) {
        persistedAdapterState = { switchedDomains: ['app.example.com'], routes: [] };
        const error = new Error('second domain switch failed');
        error.code = 'partial-switch-failed';
        throw error;
      }
      return { switched: true };
    },
    verifyTraffic: async () => {
      calls.push('traffic');
      return {
        healthy: !failTraffic,
        tlsValid: !failTraffic,
        candidateServing: !failTraffic,
        unavailableSamples: failTraffic ? 1 : 0
      };
    },
    parkSourceForRollback: async () => {
      calls.push('park');
      return { sourceStopped: true, candidateServing: true, pauseDurationMs: 42 };
    },
    rollbackTraffic: async () => {
      calls.push('rollback');
      return { restored: true };
    },
    verifyRollback: async () => {
      calls.push('rollback-proof');
      return { sourceServing: true, trafficRestored: true };
    },
    resumeSource: async () => {
      calls.push('resume');
      return { sourceRunning: true };
    },
    cleanupStagedRoute: async () => {
      calls.push('route-cleanup');
      return { cleaned: true };
    },
    cleanupCandidate: async () => {
      calls.push('candidate-cleanup');
      return { cleaned: true };
    },
    getState: () => persistedAdapterState
  };
  const manager = createStatefulMigrationManager({
    dataRoot,
    getServerMigrationPlan: () => serverPlan,
    compileExecutionContract: () => executionContract,
    executionAdapter: adapter,
    approvalVerifier: async (input) => ({
      approved: true,
      source: 'foxos-ui',
      planId: input.planId,
      resourceId: input.resourceId,
      evidenceFingerprint: input.evidenceFingerprint,
      grantId: 'grant-one'
    }),
    clock: () => new Date('2026-08-07T12:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000009'
  });
  const plan = manager.createPlan({
    serverPlanId: SERVER_PLAN_ID,
    resourceId: RESOURCE_ID,
    confirmation: PREPARE_STATEFUL_MIGRATION_CONFIRMATION
  });
  return {
    calls,
    dataRoot,
    manager,
    plan,
    setAdapterState: (value) => { persistedAdapterState = value; }
  };
}

test('stateful transaction snapshots, restores, switches traffic and preserves one cold rollback source', async () => {
  const context = harness();
  try {
    const operation = await context.manager.execute(context.plan.planId, 'one-time-ui-grant');
    assert.equal(operation.status, 'traffic-on-server-source-preserved');
    assert.equal(operation.source.stopped, true);
    assert.equal(operation.source.retainedForRollback, true);
    assert.equal(operation.rollback.available, true);
    assert.equal(operation.availability.sourcePauseDurationMs, 42);
    assert.deepEqual(context.calls, [
      'preflight', 'snapshot', 'candidate', 'health', 'stage', 'switch', 'traffic', 'park'
    ]);
    assert.equal(JSON.stringify(operation).includes('one-time-ui-grant'), false);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});

test('a failed post-switch proof automatically restores source traffic and removes candidate state', async () => {
  const context = harness({ failTraffic: true });
  try {
    await assert.rejects(
      context.manager.execute(context.plan.planId, 'one-time-ui-grant'),
      (error) => error.code === 'traffic-health-failed' && /^stmop_/.test(error.operationId)
    );
    const operation = context.manager.getOperation('stmop_' + '00000000000040008000000000000009');
    assert.equal(operation.status, 'rolled-back-after-failure');
    assert.equal(operation.rollback.verified, true);
    assert.deepEqual(context.calls.slice(-4), ['rollback', 'rollback-proof', 'route-cleanup', 'candidate-cleanup']);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});

test('a partially completed domain switch is rolled back from persisted adapter evidence', async () => {
  const context = harness({ failDuringSwitch: true });
  try {
    await assert.rejects(
      context.manager.execute(context.plan.planId, 'one-time-ui-grant'),
      (error) => error.code === 'partial-switch-failed'
    );
    const operation = context.manager.getOperation('stmop_' + '00000000000040008000000000000009');
    assert.equal(operation.status, 'rolled-back-after-failure');
    assert.equal(operation.rollback.automaticAttempted, true);
    assert.deepEqual(context.calls.slice(-4), ['rollback', 'rollback-proof', 'route-cleanup', 'candidate-cleanup']);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});

test('pause budget failure resumes the source before any route mutation', async () => {
  const context = harness({ stalePause: true });
  try {
    await assert.rejects(
      context.manager.execute(context.plan.planId, 'one-time-ui-grant'),
      (error) => error.code === 'stateful-pause-budget-exceeded'
    );
    assert.deepEqual(context.calls, ['preflight', 'snapshot', 'resume']);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});

test('a snapshot failure after source pause resumes from persisted adapter evidence', async () => {
  const context = harness({ failSnapshotAfterPause: true });
  try {
    await assert.rejects(
      context.manager.execute(context.plan.planId, 'one-time-ui-grant'),
      (error) => error.code === 'snapshot-stream-failed'
    );
    assert.deepEqual(context.calls, ['preflight', 'snapshot', 'resume']);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});

test('compiler blockers keep stateful execution sealed before adapter mutation', async () => {
  const context = harness({ contractBlockers: [{ code: 'blocked', section: 'test', severity: 'blocking' }] });
  try {
    assert.equal(context.plan.readiness.status, 'blocked');
    await assert.rejects(
      context.manager.execute(context.plan.planId, 'one-time-ui-grant'),
      (error) => error.code === 'plan-blocked'
    );
    assert.deepEqual(context.calls, []);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});

test('startup recovery cleans adapter-owned partial candidate and staged route absent from the parent record', async () => {
  const context = harness();
  const operationId = 'stmop_' + '1'.repeat(32);
  try {
    fs.writeFileSync(path.join(context.manager.paths.operationsRoot, operationId + '.json'), JSON.stringify({
      operationId,
      planId: context.plan.planId,
      resourceId: RESOURCE_ID,
      status: 'running',
      phase: 'route-stage',
      route: null,
      candidate: null,
      startedAt: '2026-08-07T12:00:00.000Z'
    }));
    context.setAdapterState({
      trafficSwitched: false,
      switchedDomains: [],
      routes: [{ routeId: 'smroute_' + 'f'.repeat(24), domain: 'app.example.com' }],
      candidate: { containerId: '2'.repeat(64) },
      targetVolumes: ['app-data']
    });
    await context.manager.recoverInterruptedOperations({ clearStaleLock: true });
    assert.deepEqual(context.calls, ['resume', 'route-cleanup', 'candidate-cleanup']);
  } finally {
    fs.rmSync(context.dataRoot, { recursive: true, force: true });
  }
});
