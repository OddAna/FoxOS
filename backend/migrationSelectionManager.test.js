const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SAVE_MIGRATION_SELECTION_CONFIRMATION,
  createMigrationSelectionManager,
  isReviewSelectable
} = require('./migrationSelectionManager');

function planResource(index, overrides = {}) {
  return {
    resourceId: 'res_' + index.repeat(32),
    name: 'resource-' + index,
    migrationRequired: true,
    protected: false,
    strategy: 'blue-green-atomic-route',
    classification: {
      authorityClass: 'provider-owned',
      stateClass: 'stateless',
      workloadRole: 'application',
      independenceAudit: { eligibleForReadOnlyAudit: true }
    },
    evidence: { manifestRevisionId: 'manifest-' + index },
    availability: { currentMode: 'zero-downtime-required' },
    readiness: { evidenceComplete: true },
    ...overrides
  };
}

function harness() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-migration-selection-'));
  let snapshot = { snapshotId: 'snap_' + 'a'.repeat(32) };
  const plan = {
    planId: 'mplan_' + 'b'.repeat(32),
    sourceSnapshotId: snapshot.snapshotId,
    resources: [
      planResource('1'),
      planResource('2', { strategy: 'shadow-refresh-bounded-quiesce' }),
      planResource('3', { protected: true })
    ]
  };
  const manager = createMigrationSelectionManager({
    dataRoot,
    getServerMigrationPlan: (planId) => {
      if (planId !== plan.planId) {
        const error = new Error('Plan not found');
        error.statusCode = 404;
        error.code = 'plan-not-found';
        throw error;
      }
      return plan;
    },
    getLatestRegistrySnapshot: () => snapshot,
    clock: () => new Date('2026-08-05T10:00:00.000Z')
  });
  return {
    dataRoot,
    manager,
    plan,
    setSnapshot: (value) => { snapshot = value; }
  };
}

test('persists only review-selectable resources and owner-only data', () => {
  const context = harness();
  const resourceId = context.plan.resources[0].resourceId;
  const selection = context.manager.save({
    serverPlanId: context.plan.planId,
    resourceIds: [resourceId, resourceId],
    confirmation: SAVE_MIGRATION_SELECTION_CONFIRMATION
  });

  assert.match(selection.selectionId, /^msel_[a-f0-9]{32}$/);
  assert.deepEqual(selection.selectedResourceIds, [resourceId]);
  assert.equal(selection.guarantees.reviewOnly, true);
  assert.equal(selection.guarantees.runtimeMutated, false);
  assert.equal(selection.guarantees.applyImplemented, false);
  assert.equal(context.manager.status().state, 'current');
  assert.equal(fs.statSync(context.manager.paths.currentFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(context.manager.paths.root).mode & 0o777, 0o700);
});

test('rejects resources outside the reviewable class, protected or outside the plan', () => {
  const context = harness();
  for (const resourceId of [
    context.plan.resources[1].resourceId,
    context.plan.resources[2].resourceId,
    'res_' + '9'.repeat(32)
  ]) {
    assert.throws(() => context.manager.save({
      serverPlanId: context.plan.planId,
      resourceIds: [resourceId],
      confirmation: SAVE_MIGRATION_SELECTION_CONFIRMATION
    }), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(
        ['resource-not-review-selectable', 'resource-not-in-plan'].includes(error.code),
        true
      );
      return true;
    });
  }
});

test('marks a saved selection stale when the registry snapshot changes', () => {
  const context = harness();
  context.manager.save({
    serverPlanId: context.plan.planId,
    resourceIds: [context.plan.resources[0].resourceId],
    confirmation: SAVE_MIGRATION_SELECTION_CONFIRMATION
  });
  context.setSnapshot({ snapshotId: 'snap_' + 'c'.repeat(32) });

  const status = context.manager.status();
  assert.equal(status.state, 'stale');
  assert.equal(status.stale, true);
  assert.equal(status.current.selectedResourceIds.length, 1);
  assert.throws(() => context.manager.save({
    serverPlanId: context.plan.planId,
    resourceIds: [],
    confirmation: SAVE_MIGRATION_SELECTION_CONFIRMATION
  }), (error) => error.code === 'stale-server-plan');
});

test('review-selectable predicate accepts safe preparation candidates before evidence is complete', () => {
  assert.equal(isReviewSelectable(planResource('1')), true);
  assert.equal(isReviewSelectable(planResource('1', { readiness: { evidenceComplete: false, reviewEligible: true } })), true);
  assert.equal(isReviewSelectable(planResource('1', {
    readiness: { evidenceComplete: false },
    classification: {
      authorityClass: 'provider-owned',
      stateClass: 'stateless',
      workloadRole: 'application',
      independenceAudit: { eligibleForReadOnlyAudit: true }
    }
  })), true);
  assert.equal(isReviewSelectable(planResource('1', { migrationRequired: false })), false);
  assert.equal(isReviewSelectable(planResource('1', { protected: true })), false);
  assert.equal(isReviewSelectable(planResource('1', { strategy: 'drain-and-replace' })), false);
  assert.equal(isReviewSelectable(planResource('1', {
    readiness: { evidenceComplete: false, reviewEligible: false }
  })), false);
  assert.equal(isReviewSelectable(planResource('1', {
    readiness: { evidenceComplete: false, reviewEligible: false },
    classification: {
      authorityClass: 'provider-owned',
      stateClass: 'stateless',
      workloadRole: 'application',
      independenceAudit: { eligibleForReadOnlyAudit: false }
    }
  })), false);
  assert.equal(isReviewSelectable(planResource('1', {
    strategy: 'shadow-refresh-bounded-quiesce',
    readiness: { evidenceComplete: false, reviewEligible: true, applyImplemented: true },
    classification: {
      authorityClass: 'provider-owned',
      stateClass: 'stateful',
      workloadRole: 'application',
      independenceAudit: { eligibleForReadOnlyAudit: false }
    }
  })), true);
  assert.equal(isReviewSelectable(planResource('1', {
    strategy: 'shadow-refresh-bounded-quiesce',
    readiness: { evidenceComplete: false, reviewEligible: true, applyImplemented: false }
  })), false);
});
