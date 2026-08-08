const assert = require('node:assert/strict');
const test = require('node:test');
const { createUiApprovalManager } = require('./uiApprovalManager');

function input(overrides = {}) {
  return {
    kind: 'stateless-migration-apply',
    planId: 'smplan_' + '1'.repeat(32),
    resourceId: 'res_' + '2'.repeat(32),
    evidenceFingerprint: '3'.repeat(64),
    actor: {
      type: 'foxos-session',
      username: 'burak',
      sessionToken: 'session-secret-that-must-not-persist'
    },
    ...overrides
  };
}

test('issues a short-lived binding and consumes it exactly once without persisting the token', async () => {
  const bytes = [Buffer.alloc(12, 1), Buffer.alloc(32, 2)];
  const manager = createUiApprovalManager({
    clock: () => new Date('2026-08-05T10:00:00.000Z'),
    randomBytes: () => bytes.shift(),
    ttlMs: 60_000
  });
  const approval = manager.issue(input());
  assert.match(approval, /^uig_[a-f0-9]{24}\.[A-Za-z0-9_-]+$/);
  assert.equal(manager.status().outstanding, 1);
  assert.equal(JSON.stringify(manager.status()).includes(approval), false);

  const verified = await manager.verify({ ...input(), approval });
  assert.equal(verified.approved, true);
  assert.equal(verified.source, 'foxos-ui');
  assert.equal(verified.oneTime, true);
  assert.equal(verified.consumed, true);
  assert.equal(manager.status().outstanding, 0);
  await assert.rejects(() => manager.verify({ ...input(), approval }), (error) => (
    error.code === 'ui-approval-unavailable'
  ));
});

test('a binding mismatch consumes the grant and cannot be replayed', async () => {
  const bytes = [Buffer.alloc(12, 3), Buffer.alloc(32, 4)];
  const manager = createUiApprovalManager({
    clock: () => new Date('2026-08-05T10:00:00.000Z'),
    randomBytes: () => bytes.shift()
  });
  const approval = manager.issue(input());
  await assert.rejects(() => manager.verify({
    ...input({ resourceId: 'res_' + '9'.repeat(32) }),
    approval
  }), (error) => error.code === 'ui-approval-binding-mismatch');
  await assert.rejects(() => manager.verify({ ...input(), approval }), (error) => (
    error.code === 'ui-approval-unavailable'
  ));
});
