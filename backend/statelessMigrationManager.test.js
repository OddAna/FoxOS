const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson } = require('./resourceRegistry');
const {
  PREPARE_STATELESS_MIGRATION_CONFIRMATION,
  createStatelessMigrationManager
} = require('./statelessMigrationManager');

const SERVER_PLAN_ID = 'mplan_' + '1'.repeat(32);
const RESOURCE_ID = 'res_' + '2'.repeat(32);
const SNAPSHOT_ID = 'snap_' + '3'.repeat(32);

function resource(overrides = {}) {
  return {
    resourceId: RESOURCE_ID,
    name: 'reviewed-stateless-app',
    observedProvider: 'legacy-provider',
    observedOwnership: 'observed',
    protected: false,
    migrationRequired: true,
    classification: {
      status: 'classified',
      workloadRole: 'application',
      stateClass: 'stateless',
      authorityClass: 'provider-owned',
      revision: 'classification-v1'
    },
    strategy: 'blue-green-atomic-route',
    evidence: {
      registrySnapshotId: SNAPSHOT_ID,
      manifestRevisionId: 'arev_' + '4'.repeat(32),
      manifestGateStatus: 'blocked',
      sourceType: 'foxos-encrypted-source-archive-revision',
      routeCount: 1,
      mountCount: 0,
      environmentVariableCount: 4,
      secretValuesIncluded: false
    },
    dependencies: [],
    conflicts: [],
    blockers: {
      authority: [{
        code: 'external-provider-authority',
        section: 'ownership',
        severity: 'blocking',
        source: 'application-manifest'
      }],
      evidence: [],
      implementation: [
        {
          code: 'migration-apply-transaction-not-implemented',
          section: 'apply',
          severity: 'blocking'
        },
        {
          code: 'zero-downtime-blue-green-apply-not-implemented',
          section: 'availability',
          severity: 'blocking'
        },
        {
          code: 'general-domain-route-cutover-not-implemented',
          section: 'routes',
          severity: 'blocking'
        }
      ]
    },
    readiness: {
      planningStatus: 'evidence-complete-apply-unavailable',
      evidenceComplete: true,
      applyImplemented: false,
      applyApproved: false,
      providerDetachApproved: false
    },
    ...overrides
  };
}

function serverPlan(currentResource = resource()) {
  return {
    schemaVersion: 1,
    mode: 'read-only-server-migration-plan',
    planId: SERVER_PLAN_ID,
    sourceSnapshotId: SNAPSHOT_ID,
    resources: [currentResource]
  };
}

function readyAdapter(options = {}) {
  const events = [];
  const call = async (name, fallback, input) => {
    events.push(name);
    if (options[name]) return options[name](input);
    return fallback;
  };
  const adapter = {
    events,
    capabilities: {
      candidateRuntime: true,
      healthProof: true,
      stagedRouteTls: true,
      atomicTrafficSwitch: true,
      trafficProbe: true,
      rollback: true,
      sourcePreserved: true,
      providerDetach: false,
      sourceStop: false,
      sourceRecreation: false
    },
    preflight: (input) => call('preflight', {
      evidenceFingerprint: input.plan.resource.evidenceFingerprint,
      sourceHealthy: true,
      sourceContinuouslyRunning: true,
      routeCollisionFree: true
    }, input),
    createCandidate: (input) => call('createCandidate', {
      candidateId: 'candidate-1',
      owned: true,
      separateFromSource: true,
      sourceTouched: false,
      runtimeSecret: 'candidate-secret-must-not-persist'
    }, input),
    verifyCandidateHealth: (input) => call('verifyCandidateHealth', {
      healthy: true,
      status: 200,
      identity: 'candidate-1'
    }, input),
    stageRoute: (input) => call('stageRoute', {
      routeId: 'route-1',
      staged: true,
      active: false,
      collisionFree: true,
      tlsReady: true,
      sourceStillServing: true,
      dnsCredential: 'route-secret-must-not-persist'
    }, input),
    switchTraffic: (input) => call('switchTraffic', {
      switched: true,
      sourceStopped: false,
      sourceRecreated: false,
      routeRevision: 'route-revision-1'
    }, input),
    verifyTraffic: (input) => call('verifyTraffic', {
      healthy: true,
      tlsValid: true,
      candidateServing: true,
      sourceContinuouslyRunning: true,
      unavailableSamples: 0,
      probes: 5,
      responseAuthorization: 'traffic-secret-must-not-persist'
    }, input),
    rollbackTraffic: (input) => call('rollbackTraffic', {
      restored: true,
      sourceRouteRevision: 'source-route-revision'
    }, input),
    verifyRollback: (input) => call('verifyRollback', {
      sourceServing: true,
      trafficRestored: true,
      candidateServing: false
    }, input),
    cleanupCandidate: (input) => call('cleanupCandidate', { cleaned: true }, input),
    cleanupStagedRoute: (input) => call('cleanupStagedRoute', { cleaned: true }, input)
  };
  if (options.enableSourceParking) {
    adapter.parkSourceForRollback = (input) => call('parkSourceForRollback', {
      sourceStopped: true,
      sourceContainerId: 'source-container-id',
      candidateServing: true,
      unavailableSamples: 0,
      probes: 3,
      stoppedAt: '2026-08-05T10:00:00.000Z'
    }, input);
  }
  return adapter;
}

function approvalVerifier(secretValue = 'approval-secret-value') {
  let consumed = false;
  const verifier = async ({ kind, planId, resourceId, evidenceFingerprint, approval }) => {
    assert.equal(approval, secretValue);
    assert.equal(consumed, false);
    consumed = true;
    return {
      approved: true,
      source: 'foxos-ui',
      kind,
      planId,
      resourceId,
      evidenceFingerprint,
      grantId: 'grant-sensitive-identifier',
      oneTime: true,
      consumed: true,
      approvedAt: '2026-08-05T10:00:00.000Z',
      expiresAt: '2026-08-05T10:05:00.000Z'
    };
  };
  verifier.consumed = () => consumed;
  return verifier;
}

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateless-migration-'));
  const adapter = options.adapter === undefined ? readyAdapter() : options.adapter;
  const verifier = options.verifier === undefined ? approvalVerifier() : options.verifier;
  const plan = options.serverPlan || serverPlan();
  const manager = createStatelessMigrationManager({
    dataRoot: root,
    getServerMigrationPlan: (planId) => {
      assert.equal(planId, SERVER_PLAN_ID);
      return plan;
    },
    compileExecutionContract: options.compiler === undefined ? null : options.compiler,
    executionAdapter: adapter,
    approvalVerifier: verifier,
    clock: () => new Date('2026-08-05T10:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000006'
  });
  return { adapter, manager, root, verifier };
}

function prepare(manager) {
  return manager.createPlan({
    serverPlanId: SERVER_PLAN_ID,
    resourceId: RESOURCE_ID,
    confirmation: PREPARE_STATELESS_MIGRATION_CONFIRMATION
  });
}

test('stateless review plans are deterministic, owner-only and require a future UI grant', () => {
  const { manager, root } = harness();
  const first = prepare(manager);
  const second = prepare(manager);
  assert.equal(first.planId, second.planId);
  assert.equal(first.readiness.status, 'backend-ready-ui-approval-required');
  assert.equal(first.readiness.uiApprovalRequired, true);
  assert.equal(first.readiness.runEndpointExposed, false);
  assert.equal(first.transaction.sourceStopAllowed, false);
  assert.equal(first.transaction.providerDetachIncluded, false);
  assert.equal(first.guarantees.runtimeMutated, false);
  assert.equal(first.guarantees.routesMutated, false);
  assert.equal(first.guarantees.executionEndpointExposed, false);
  assert.equal(first.readiness.blockers.length, 0);
  assert.equal(fs.statSync(manager.paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(manager.paths.plansRoot, first.planId + '.json')).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a provider-neutral manifest contract is fingerprinted into the review plan and its blockers fail closed', () => {
  const contract = {
    contractId: 'smcontract_' + 'a'.repeat(32),
    readiness: {
      status: 'blocked',
      blockers: [{
        code: 'route-private-port-ambiguous',
        section: 'routes',
        severity: 'blocking',
        source: 'stateless-manifest-compiler',
        message: 'Select the exact private port.'
      }]
    },
    guarantees: {
      runtimeMutated: false,
      providerDetached: false,
      secretValuesIncluded: false
    }
  };
  const { manager, root } = harness({ compiler: () => contract });
  const plan = prepare(manager);
  assert.deepEqual(plan.executionContract, contract);
  assert.equal(plan.readiness.manifestCompilerConfigured, true);
  assert.equal(plan.readiness.manifestContractStatus, 'blocked');
  assert.equal(plan.readiness.status, 'blocked');
  assert.equal(plan.readiness.blockers.some((entry) => (
    entry.code === 'route-private-port-ambiguous' && entry.message === 'Select the exact private port.'
  )), true);
  assert.equal(manager.status().executionGate.manifestCompilerConfigured, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an exact local image contract replaces only stale or unbound archive evidence', () => {
  const fallbackContract = {
    contractId: 'smcontract_' + 'b'.repeat(32),
    readiness: { status: 'backend-contract-ready-ui-configuration-required', blockers: [] },
    guarantees: {
      runtimeMutated: false,
      providerDetached: false,
      secretValuesIncluded: false,
      exactLocalImageFallback: true
    }
  };
  const blockedResource = resource({
    blockers: {
      ...resource().blockers,
      evidence: [{
        code: 'foxos-source-archive-invalid',
        section: 'source',
        severity: 'blocking',
        source: 'application-manifest'
      }]
    },
    readiness: {
      ...resource().readiness,
      planningStatus: 'review-eligible-evidence-incomplete',
      evidenceComplete: false
    }
  });
  const { manager, root } = harness({
    serverPlan: serverPlan(blockedResource),
    compiler: () => fallbackContract
  });

  const plan = prepare(manager);

  assert.equal(plan.readiness.status, 'backend-ready-ui-approval-required');
  assert.deepEqual(plan.readiness.blockers, []);
  assert.equal(plan.executionContract.guarantees.exactLocalImageFallback, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an exact local image contract does not hide unrelated incomplete evidence', () => {
  const fallbackContract = {
    contractId: 'smcontract_' + 'c'.repeat(32),
    readiness: { status: 'backend-contract-ready-ui-configuration-required', blockers: [] },
    guarantees: {
      runtimeMutated: false,
      providerDetached: false,
      secretValuesIncluded: false,
      exactLocalImageFallback: true
    }
  };
  const blockedResource = resource({
    blockers: {
      ...resource().blockers,
      evidence: [
        {
          code: 'foxos-source-archive-invalid',
          section: 'source',
          severity: 'blocking',
          source: 'application-manifest'
        },
        {
          code: 'environment-revision-missing',
          section: 'environment',
          severity: 'blocking',
          source: 'application-manifest'
        }
      ]
    },
    readiness: {
      ...resource().readiness,
      planningStatus: 'review-eligible-evidence-incomplete',
      evidenceComplete: false
    }
  });
  const { manager, root } = harness({
    serverPlan: serverPlan(blockedResource),
    compiler: () => fallbackContract
  });

  const plan = prepare(manager);

  assert.equal(plan.readiness.status, 'blocked');
  assert.equal(plan.readiness.blockers.some((entry) => (
    entry.code === 'environment-revision-missing'
  )), true);
  assert.equal(plan.readiness.blockers.some((entry) => (
    entry.code === 'foxos-source-archive-invalid'
  )), false);
  assert.equal(plan.readiness.blockers.some((entry) => (
    entry.code === 'migration-evidence-incomplete'
  )), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unsafe execution contract is rejected before a plan is persisted', () => {
  const { manager, root } = harness({
    compiler: () => ({
      contractId: 'smcontract_' + 'a'.repeat(32),
      readiness: { status: 'ready', blockers: [] },
      guarantees: { runtimeMutated: true, providerDetached: false, secretValuesIncluded: false }
    })
  });
  assert.throws(() => prepare(manager), (error) => error.code === 'execution-contract-invalid');
  assert.equal(manager.status().summary.plans, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the production construction stays sealed before any adapter or approval call', async () => {
  const { manager, root } = harness({ adapter: null, verifier: null });
  const plan = prepare(manager);
  assert.equal(plan.readiness.status, 'blocked');
  assert.equal(plan.readiness.blockers.some((entry) => entry.code === 'foxos-ui-approval-provider-sealed'), true);
  assert.equal(manager.status().executionGate.status, 'sealed');
  await assert.rejects(
    manager.execute(plan.planId, 'anything'),
    (error) => error.code === 'ui-approval-gate-sealed'
  );
  assert.equal(manager.status().summary.operations, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an adapter exposing source-stop or provider-detach methods is rejected as unsafe', () => {
  const adapter = readyAdapter();
  adapter.stopSource = async () => {};
  adapter.detachProvider = async () => {};
  const { manager, root } = harness({ adapter });
  const plan = prepare(manager);
  assert.equal(plan.readiness.status, 'blocked');
  assert.equal(
    plan.readiness.blockers.some((entry) => entry.code === 'unsafe-execution-adapter:source-stop-method-present'),
    true
  );
  assert.equal(
    plan.readiness.blockers.some((entry) => entry.code === 'unsafe-execution-adapter:provider-detach-method-present'),
    true
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('configured transaction keeps the source running and proves zero unavailable samples', async () => {
  const { adapter, manager, root, verifier } = harness();
  const plan = prepare(manager);
  const operation = await manager.execute(plan.planId, 'approval-secret-value');
  assert.equal(verifier.consumed(), true);
  assert.equal(operation.status, 'traffic-on-foxos-source-preserved');
  assert.equal(operation.availability.zeroDowntimeProven, true);
  assert.equal(operation.trafficProof.unavailableSamples, 0);
  assert.equal(operation.source.stopped, false);
  assert.equal(operation.source.recreated, false);
  assert.equal(operation.provider.detached, false);
  assert.equal(operation.rollback.available, true);
  assert.equal(manager.status().executionGate.processLockPresent, false);
  assert.deepEqual(adapter.events, [
    'preflight',
    'createCandidate',
    'verifyCandidateHealth',
    'stageRoute',
    'switchTraffic',
    'verifyTraffic'
  ]);
  const persisted = fs.readFileSync(path.join(manager.paths.operationsRoot, operation.operationId + '.json'), 'utf8');
  assert.equal(persisted.includes('approval-secret-value'), false);
  assert.equal(persisted.includes('grant-sensitive-identifier'), false);
  assert.equal(persisted.includes('candidate-secret-must-not-persist'), false);
  assert.equal(persisted.includes('route-secret-must-not-persist'), false);
  assert.equal(persisted.includes('traffic-secret-must-not-persist'), false);
  assert.equal(operation.approval.rawApprovalPersisted, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a verified production transaction parks the preserved source as cold rollback', async () => {
  const adapter = readyAdapter({ enableSourceParking: true });
  const { manager, root } = harness({ adapter });
  const plan = prepare(manager);
  const operation = await manager.execute(plan.planId, 'approval-secret-value');
  assert.equal(operation.status, 'traffic-on-foxos-source-preserved');
  assert.equal(operation.source.stopped, true);
  assert.equal(operation.source.retainedForRollback, true);
  assert.equal(operation.rollback.available, true);
  assert.equal(operation.rollback.mode, 'cold-source');
  assert.equal(operation.rollback.sourceParking.sourceStopped, true);
  assert.equal(operation.rollback.sourceParking.unavailableSamples, 0);
  assert.equal(adapter.events.at(-1), 'parkSourceForRollback');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a persistent process lock blocks execution before consuming UI approval', async () => {
  const { adapter, manager, root, verifier } = harness();
  const plan = prepare(manager);
  atomicWriteJson(manager.paths.operationLockFile, {
    resourceId: RESOURCE_ID,
    token: 'another-process'
  });
  await assert.rejects(
    manager.execute(plan.planId, 'approval-secret-value'),
    (error) => error.code === 'operation-in-progress'
  );
  assert.equal(verifier.consumed(), false);
  assert.deepEqual(adapter.events, []);
  assert.equal(manager.status().executionGate.processLockPresent, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('expired, non-UI and stale grants fail before candidate creation', async () => {
  const variants = [
    { patch: { source: 'cli' }, code: 'invalid-approval-source' },
    { patch: { expiresAt: '2026-08-05T09:59:59.000Z' }, code: 'approval-expired' },
    { patch: { evidenceFingerprint: 'stale' }, code: 'approval-evidence-stale' },
    { patch: { kind: 'provider-detach' }, code: 'approval-kind-mismatch' }
  ];
  for (const variant of variants) {
    const adapter = readyAdapter();
    const verifier = async ({ kind, planId, resourceId, evidenceFingerprint }) => ({
      approved: true,
      source: 'foxos-ui',
      kind,
      planId,
      resourceId,
      evidenceFingerprint,
      grantId: 'bounded-grant',
      oneTime: true,
      consumed: true,
      approvedAt: '2026-08-05T10:00:00.000Z',
      expiresAt: '2026-08-05T10:05:00.000Z',
      ...variant.patch
    });
    const { manager, root } = harness({ adapter, verifier });
    const plan = prepare(manager);
    await assert.rejects(manager.execute(plan.planId, 'redacted'), (error) => error.code === variant.code);
    assert.equal(manager.status().summary.operations, 0);
    assert.equal(manager.status().executionGate.processLockPresent, false);
    assert.deepEqual(adapter.events, []);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate health failure occurs before switch and cleans exact temporary state', async () => {
  const adapter = readyAdapter({
    verifyCandidateHealth: async () => ({ healthy: false })
  });
  const { manager, root } = harness({ adapter });
  const plan = prepare(manager);
  await assert.rejects(
    manager.execute(plan.planId, 'approval-secret-value'),
    (error) => error.code === 'candidate-health-failed'
  );
  const operation = manager.status().operations[0];
  assert.equal(operation.status, 'failed-before-switch-cleaned');
  assert.equal(operation.cleanup.candidateCleaned, true);
  assert.equal(operation.cleanup.stagedRouteCleaned, false);
  assert.equal(adapter.events.includes('switchTraffic'), false);
  assert.equal(adapter.events.at(-1), 'cleanupCandidate');
  fs.rmSync(root, { recursive: true, force: true });
});

test('bounded production adapter failures remain actionable in the operation record', async () => {
  const productionFailure = new Error('A safe provider-neutral candidate startup contract could not be reconstructed');
  productionFailure.name = 'ProductionStatelessMigrationError';
  productionFailure.statusCode = 409;
  productionFailure.code = 'candidate-startup-contract-unsupported';
  const adapter = readyAdapter({
    createCandidate: async () => { throw productionFailure; }
  });
  const { manager, root } = harness({ adapter });
  const plan = prepare(manager);
  await assert.rejects(
    manager.execute(plan.planId, 'approval-secret-value'),
    (error) => (
      error.code === 'candidate-startup-contract-unsupported' &&
      error.message === productionFailure.message &&
      /^smop_[a-f0-9]{32}$/.test(error.operationId)
    )
  );
  const operation = manager.status().operations[0];
  assert.equal(operation.status, 'failed-before-switch-cleaned');
  assert.deepEqual(operation.error, {
    code: 'candidate-startup-contract-unsupported',
    message: productionFailure.message
  });
  assert.deepEqual(adapter.events, ['preflight', 'createCandidate']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bounded ingress authority failures remain actionable in the operation record', async () => {
  const ingressFailure = new Error('FoxOS route configuration reload failed');
  ingressFailure.name = 'IngressAuthorityError';
  ingressFailure.statusCode = 503;
  ingressFailure.code = 'caddy-route-reload-failed';
  const adapter = readyAdapter({
    stageRoute: async () => { throw ingressFailure; }
  });
  const { manager, root } = harness({ adapter });
  const plan = prepare(manager);
  await assert.rejects(
    manager.execute(plan.planId, 'approval-secret-value'),
    (error) => (
      error.code === 'caddy-route-reload-failed' &&
      error.message === ingressFailure.message &&
      /^smop_[a-f0-9]{32}$/.test(error.operationId)
    )
  );
  const operation = manager.status().operations[0];
  assert.equal(operation.status, 'failed-before-switch-cleaned');
  assert.deepEqual(operation.error, {
    code: 'caddy-route-reload-failed',
    message: ingressFailure.message
  });
  assert.deepEqual(adapter.events.slice(-2), ['stageRoute', 'cleanupCandidate']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('any unavailable traffic sample triggers verified automatic rollback and cleanup', async () => {
  const adapter = readyAdapter({
    verifyTraffic: async () => ({
      healthy: true,
      tlsValid: true,
      candidateServing: true,
      sourceContinuouslyRunning: true,
      unavailableSamples: 1
    })
  });
  const { manager, root } = harness({ adapter });
  const plan = prepare(manager);
  await assert.rejects(
    manager.execute(plan.planId, 'approval-secret-value'),
    (error) => error.code === 'downtime-observed'
  );
  const operation = manager.status().operations[0];
  assert.equal(operation.status, 'rolled-back-after-failure');
  assert.equal(operation.rollback.automaticAttempted, true);
  assert.equal(operation.rollback.verified, true);
  assert.equal(operation.cleanup.stagedRouteCleaned, true);
  assert.equal(operation.cleanup.candidateCleaned, true);
  assert.deepEqual(adapter.events.slice(-4), [
    'rollbackTraffic',
    'verifyRollback',
    'cleanupStagedRoute',
    'cleanupCandidate'
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a completed switch supports a second one-time UI-approved exact rollback', async () => {
  const adapter = readyAdapter();
  const firstVerifier = approvalVerifier('apply-secret');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateless-rollback-'));
  let rollbackMode = false;
  const manager = createStatelessMigrationManager({
    dataRoot: root,
    getServerMigrationPlan: () => serverPlan(),
    executionAdapter: adapter,
    approvalVerifier: async (input) => {
      if (!rollbackMode) return firstVerifier({ ...input, approval: 'apply-secret' });
      return {
        approved: true,
        source: 'foxos-ui',
        kind: input.kind,
        planId: input.planId,
        resourceId: input.resourceId,
        evidenceFingerprint: input.evidenceFingerprint,
        grantId: 'rollback-grant',
        oneTime: true,
        consumed: true,
        approvedAt: '2026-08-05T10:00:00.000Z',
        expiresAt: '2026-08-05T10:05:00.000Z'
      };
    },
    clock: () => new Date('2026-08-05T10:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000007'
  });
  const plan = prepare(manager);
  const operation = await manager.execute(plan.planId, 'apply-secret');
  rollbackMode = true;
  const rolledBack = await manager.rollback(operation.operationId, 'rollback-secret');
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(rolledBack.rollback.verified, true);
  assert.equal(rolledBack.cleanup.stagedRouteCleaned, true);
  assert.equal(rolledBack.cleanup.candidateCleaned, true);
  assert.equal(rolledBack.provider.detached, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('stateful, protected and evidence-incomplete resources fail closed', () => {
  const cases = [
    resource({
      strategy: 'shadow-refresh-bounded-quiesce',
      classification: {
        status: 'classified',
        workloadRole: 'application',
        stateClass: 'stateful',
        authorityClass: 'provider-owned'
      }
    }),
    resource({ protected: true }),
    resource({
      blockers: {
        authority: [],
        evidence: [{ code: 'immutable-source-missing', section: 'source', severity: 'blocking' }],
        implementation: []
      },
      readiness: { evidenceComplete: false }
    })
  ];
  for (const currentResource of cases) {
    const { manager, root } = harness({ serverPlan: serverPlan(currentResource) });
    if (currentResource.classification.stateClass !== 'stateless' || currentResource.protected) {
      assert.throws(() => prepare(manager), (error) => error.code === 'unsupported-resource-class');
    } else {
      const plan = prepare(manager);
      assert.equal(plan.readiness.status, 'blocked');
      assert.equal(plan.readiness.blockers.some((entry) => entry.code === 'immutable-source-missing'), true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup marks interrupted work for UI recovery without replaying an operation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateless-recovery-'));
  const operationsRoot = path.join(root, 'stateless-migrations', 'operations');
  const operationId = 'smop_' + '9'.repeat(32);
  atomicWriteJson(path.join(operationsRoot, operationId + '.json'), {
    schemaVersion: 1,
    operationId,
    planId: 'smplan_' + '8'.repeat(32),
    resourceId: RESOURCE_ID,
    status: 'running',
    phase: 'traffic-switch',
    startedAt: '2026-08-05T09:59:00.000Z',
    history: []
  });
  const adapter = readyAdapter();
  const manager = createStatelessMigrationManager({
    dataRoot: root,
    getServerMigrationPlan: () => serverPlan(),
    executionAdapter: adapter,
    approvalVerifier: approvalVerifier(),
    clock: () => new Date('2026-08-05T10:00:00.000Z')
  });
  const recovered = manager.getOperation(operationId);
  assert.equal(recovered.status, 'interrupted-ui-recovery-required');
  assert.equal(recovered.recovery.automaticReplay, false);
  assert.equal(recovered.recovery.runtimeMutatedDuringStartup, false);
  assert.deepEqual(adapter.events, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('exact confirmation and identifiers are required before a review plan is written', () => {
  const { manager, root } = harness();
  assert.throws(
    () => manager.createPlan({ serverPlanId: SERVER_PLAN_ID, resourceId: RESOURCE_ID, confirmation: 'yes' }),
    (error) => error.code === 'confirmation-required'
  );
  assert.throws(
    () => manager.createPlan({
      serverPlanId: '../escape',
      resourceId: RESOURCE_ID,
      confirmation: PREPARE_STATELESS_MIGRATION_CONFIRMATION
    }),
    (error) => error.code === 'invalid-server-plan-id'
  );
  assert.equal(manager.status().summary.plans, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
