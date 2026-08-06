const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  START_SERVER_MIGRATION_CONFIRMATION,
  createMigrationRunManager
} = require('./migrationRunManager');

const SERVER_PLAN_ID = 'mplan_' + '1'.repeat(32);
const SNAPSHOT_ID = 'snap_' + '2'.repeat(32);
const RESOURCE_A = 'res_' + 'a'.repeat(32);
const RESOURCE_B = 'res_' + 'b'.repeat(32);

function resource(resourceId, name, dependencies = []) {
  return {
    resourceId,
    name,
    migrationRequired: true,
    protected: false,
    strategy: 'blue-green-atomic-route',
    classification: {
      authorityClass: 'provider-owned',
      stateClass: 'stateless',
      workloadRole: 'application',
      independenceAudit: { eligibleForReadOnlyAudit: true }
    },
    evidence: { manifestRevisionId: 'arev_' + resourceId.slice(-32) },
    availability: { currentMode: 'zero-downtime-required' },
    readiness: { reviewEligible: true, evidenceComplete: true },
    dependencies
  };
}

function harness({ blockedResource = null, reviewComplete = true, executeFailure = null } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-migration-run-'));
  let snapshot = { snapshotId: SNAPSHOT_ID };
  const plan = {
    planId: SERVER_PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    resources: [
      resource(RESOURCE_A, 'alpha'),
      resource(RESOURCE_B, 'beta', [{ required: true, resourceIds: [RESOURCE_A] }])
    ]
  };
  let scheduled = null;
  const savedSelections = [];
  const executions = [];
  const approvals = [];
  const manager = createMigrationRunManager({
    dataRoot,
    getServerMigrationPlan: () => plan,
    getLatestRegistrySnapshot: () => snapshot,
    saveSelection: (input) => {
      savedSelections.push(input);
      return { selectionId: 'msel_' + '3'.repeat(32) };
    },
    prepareStatelessPlan: ({ resourceId }) => ({
      planId: 'smplan_' + (resourceId === RESOURCE_A ? '4' : '5').repeat(32),
      resource: { resourceId, evidenceFingerprint: resourceId.slice(-32).repeat(2) },
      readiness: {
        blockers: resourceId === blockedResource ? [{
          code: 'evidence-missing',
          section: 'evidence',
          severity: 'blocking',
          source: 'test'
        }] : []
      }
    }),
    getStatelessReviewStatus: () => ({
      stale: false,
      state: reviewComplete ? 'complete' : 'empty',
      current: reviewComplete ? { reviewComplete: true, reviewBlockers: [] } : null
    }),
    executeStatelessMigration: async (planId) => {
      executions.push(planId);
      if (executeFailure && executions.length === executeFailure) {
        const error = new Error('injected execution failure');
        error.code = 'injected-failure';
        error.operationId = 'smop_' + 'f'.repeat(32);
        throw error;
      }
      return {
        operationId: 'smop_' + String(executions.length).repeat(32),
        status: 'traffic-on-foxos-source-preserved'
      };
    },
    issueApproval: (input) => {
      approvals.push(input);
      return 'internal-one-time-approval';
    },
    clock: () => new Date('2026-08-05T10:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000008',
    schedule: (work) => { scheduled = work; }
  });
  const start = () => manager.start({
    serverPlanId: SERVER_PLAN_ID,
    resourceIds: [RESOURCE_B, RESOURCE_A],
    confirmation: START_SERVER_MIGRATION_CONFIRMATION
  }, {
    type: 'foxos-session',
    username: 'burak',
    sessionToken: 'session-secret'
  });
  return {
    approvals,
    dataRoot,
    executions,
    manager,
    savedSelections,
    setSnapshot: (value) => { snapshot = value; },
    start,
    work: async () => scheduled()
  };
}

test('one start action persists the exact selection internally and executes explicit dependencies serially', async () => {
  const context = harness();
  const queued = context.start();
  assert.equal(queued.status, 'queued');
  assert.deepEqual(queued.executionOrder, [RESOURCE_A, RESOURCE_B]);
  assert.equal(context.savedSelections.length, 1);
  assert.equal(context.savedSelections[0].confirmation, 'SAVE MIGRATION SELECTION');
  assert.deepEqual(context.savedSelections[0].resourceIds, [RESOURCE_A, RESOURCE_B]);
  await context.work();

  const completed = context.manager.getRun(queued.runId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.summary.completed, 2);
  assert.deepEqual(context.executions, ['smplan_' + '4'.repeat(32), 'smplan_' + '5'.repeat(32)]);
  assert.equal(context.approvals.length, 2);
  assert.equal(completed.guarantees.serialExecution, true);
  assert.equal(completed.guarantees.providerDetachIncluded, false);
  assert.equal(JSON.stringify(completed).includes('session-secret'), false);
  assert.equal(fs.statSync(context.manager.paths.runsRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(context.manager.paths.runsRoot, queued.runId + '.json')).mode & 0o777, 0o600);
  fs.rmSync(context.dataRoot, { recursive: true, force: true });
});

test('preflights every selected resource and executes none when one is blocked', async () => {
  const context = harness({ blockedResource: RESOURCE_B });
  const queued = context.start();
  await context.work();
  const blocked = context.manager.getRun(queued.runId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.summary.ready, 1);
  assert.equal(blocked.summary.blocked, 1);
  assert.equal(context.executions.length, 0);
  assert.equal(context.approvals.length, 0);
  fs.rmSync(context.dataRoot, { recursive: true, force: true });
});

test('snapshot drift after the click blocks before runtime execution', async () => {
  const context = harness();
  const queued = context.start();
  context.setSnapshot({ snapshotId: 'snap_' + '9'.repeat(32) });
  await context.work();
  const blocked = context.manager.getRun(queued.runId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockers[0].code, 'migration-snapshot-stale');
  assert.equal(context.executions.length, 0);
  fs.rmSync(context.dataRoot, { recursive: true, force: true });
});

test('stops the serial queue after a failed resource transaction', async () => {
  const context = harness({ executeFailure: 1 });
  const queued = context.start();
  await context.work();
  const failed = context.manager.getRun(queued.runId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.resources[0].status, 'failed');
  assert.equal(failed.resources[0].operationId, 'smop_' + 'f'.repeat(32));
  assert.equal(failed.resources[1].status, 'ready');
  assert.equal(context.executions.length, 1);
  fs.rmSync(context.dataRoot, { recursive: true, force: true });
});
