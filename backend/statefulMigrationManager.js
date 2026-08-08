const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('./applicationManifestManager');
const { atomicWriteJson } = require('./resourceRegistry');

const STATEFUL_MIGRATION_SCHEMA_VERSION = 1;
const PREPARE_STATEFUL_MIGRATION_CONFIRMATION = 'PREPARE STATEFUL MIGRATION';
const UI_APPROVAL_SOURCE = 'foxos-ui';
const PLAN_ID_PATTERN = /^stmplan_[a-f0-9]{32}$/;
const OPERATION_ID_PATTERN = /^stmop_[a-f0-9]{32}$/;
const MAX_RECORDS = 100;

class StatefulMigrationError extends Error {
  constructor(message, statusCode = 409, code = 'stateful-migration-error') {
    super(message);
    this.name = 'StatefulMigrationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function listJson(directory) {
  try {
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
      .map((file) => readJson(path.join(directory, file))).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function prune(directory) {
  const records = listJson(directory).sort((left, right) => (
    String(left.createdAt || left.startedAt).localeCompare(String(right.createdAt || right.startedAt))
  ));
  for (const record of records.slice(0, Math.max(0, records.length - MAX_RECORDS))) {
    const id = record.planId || record.operationId;
    if (id) fs.unlinkSync(path.join(directory, id + '.json'));
  }
}

function transactionFailure(error) {
  if (error instanceof StatefulMigrationError) return error;
  const failure = new StatefulMigrationError(
    error && error.message || 'Stateful migration failed',
    Number.isInteger(error && error.statusCode) ? error.statusCode : 500,
    error && error.code || 'stateful-migration-transaction-failed'
  );
  if (error && error.operationId) failure.operationId = error.operationId;
  return failure;
}

function assertProof(value, message, code) {
  if (!value) throw new StatefulMigrationError(message, 503, code);
}

function createStatefulMigrationManager({
  dataRoot,
  getServerMigrationPlan,
  compileExecutionContract,
  executionAdapter,
  approvalVerifier,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (
    !dataRoot || typeof getServerMigrationPlan !== 'function' ||
    typeof compileExecutionContract !== 'function' || !executionAdapter ||
    typeof approvalVerifier !== 'function'
  ) throw new Error('Stateful migration manager requires planning, compiler, execution and approval adapters');

  const root = path.join(dataRoot, 'stateful-migrations');
  const plansRoot = path.join(root, 'plans');
  const operationsRoot = path.join(root, 'operations');
  const operationLockFile = path.join(root, 'operation.lock');
  const inFlight = new Set();

  function now() {
    return new Date(clock()).toISOString();
  }

  function planFile(planId) {
    if (!PLAN_ID_PATTERN.test(String(planId || ''))) throw new StatefulMigrationError('Invalid stateful plan ID', 400, 'invalid-plan-id');
    return path.join(plansRoot, planId + '.json');
  }

  function operationFile(operationId) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) throw new StatefulMigrationError('Invalid stateful operation ID', 400, 'invalid-operation-id');
    return path.join(operationsRoot, operationId + '.json');
  }

  function getPlan(planId) {
    const plan = readJson(planFile(planId));
    if (!plan) throw new StatefulMigrationError('Stateful migration plan was not found', 404, 'plan-not-found');
    return plan;
  }

  function getOperation(operationId) {
    const operation = readJson(operationFile(operationId));
    if (!operation) throw new StatefulMigrationError('Stateful migration operation was not found', 404, 'operation-not-found');
    return operation;
  }

  function persistOperation(operation) {
    atomicWriteJson(operationFile(operation.operationId), operation);
    return operation;
  }

  function setPhase(operation, phase) {
    operation.phase = phase;
    operation.updatedAt = now();
    operation.history.push({ phase, at: operation.updatedAt });
    persistOperation(operation);
  }

  function acquireLock(operationId, clearStale = false) {
    ensureDirectory(root);
    if (clearStale) {
      try { fs.unlinkSync(operationLockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const owner = { operationId, pid: process.pid, token: crypto.randomBytes(24).toString('hex'), acquiredAt: now() };
    try {
      fs.writeFileSync(operationLockFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      return owner;
    } catch (error) {
      if (error.code === 'EEXIST') throw new StatefulMigrationError('Another stateful migration is active', 409, 'operation-in-progress');
      throw error;
    }
  }

  function releaseLock(owner) {
    const current = readJson(operationLockFile, null);
    if (!current || current.token !== owner.token) return false;
    fs.unlinkSync(operationLockFile);
    return true;
  }

  function createPlan(input = {}) {
    if (input.confirmation !== PREPARE_STATEFUL_MIGRATION_CONFIRMATION) {
      throw new StatefulMigrationError('Exact stateful planning confirmation is required', 400, 'confirmation-required');
    }
    const serverPlan = getServerMigrationPlan(input.serverPlanId);
    const resource = (serverPlan.resources || []).find((entry) => entry.resourceId === input.resourceId);
    if (!resource) throw new StatefulMigrationError('Selected resource is outside the server plan', 404, 'resource-not-in-plan');
    if (
      resource.protected || resource.migrationRequired !== true ||
      resource.strategy !== 'shadow-refresh-bounded-quiesce' ||
      !resource.readiness || resource.readiness.reviewEligible !== true || resource.readiness.applyImplemented !== true
    ) throw new StatefulMigrationError('Selected resource has no executable stateful adapter', 409, 'stateful-adapter-unavailable');

    const executionContract = compileExecutionContract({ serverPlan, resource });
    const evidenceFingerprint = hash(canonicalJson({
      serverPlanId: serverPlan.planId,
      sourceSnapshotId: serverPlan.sourceSnapshotId,
      resource,
      executionContract
    }), 64);
    const core = {
      schemaVersion: STATEFUL_MIGRATION_SCHEMA_VERSION,
      mode: 'stateful-bounded-quiesce-transaction-review',
      serverPlanId: serverPlan.planId,
      sourceSnapshotId: serverPlan.sourceSnapshotId,
      resource: {
        resourceId: resource.resourceId,
        name: resource.name,
        observedProvider: resource.observedProvider,
        observedOwnership: resource.observedOwnership,
        evidenceFingerprint,
        executionContractId: executionContract.contractId
      },
      strategy: resource.strategy,
      executionContract,
      readiness: {
        status: executionContract.readiness.blockers.length ? 'blocked' : 'backend-ready-ui-approval-required',
        blockers: executionContract.readiness.blockers,
        executionAdapterReady: true,
        uiApprovalRequired: true
      },
      guarantees: {
        runtimeMutated: false,
        routesMutated: false,
        sourcePaused: false,
        providerMutated: false,
        providerDetached: false,
        destructiveSourceCleanup: false,
        secretValuesIncluded: false,
        ordinaryEnvironmentValuesIncluded: false
      }
    };
    const planId = 'stmplan_' + hash(canonicalJson(core), 32);
    const existing = readJson(planFile(planId), null);
    if (existing) return existing;
    const plan = { ...core, planId, createdAt: now() };
    atomicWriteJson(planFile(planId), plan);
    prune(plansRoot);
    return plan;
  }

  async function verifyApproval(kind, plan, approval) {
    const grant = await approvalVerifier({
      kind,
      planId: plan.planId,
      resourceId: plan.resource.resourceId,
      evidenceFingerprint: plan.resource.evidenceFingerprint,
      approval
    });
    if (
      !grant || grant.approved !== true || grant.source !== UI_APPROVAL_SOURCE ||
      grant.planId !== plan.planId || grant.resourceId !== plan.resource.resourceId ||
      grant.evidenceFingerprint !== plan.resource.evidenceFingerprint
    ) throw new StatefulMigrationError('Stateful migration UI approval is invalid', 403, 'ui-approval-invalid');
    return {
      source: UI_APPROVAL_SOURCE,
      oneTime: true,
      grantIdFingerprint: hash(String(grant.grantId || 'ui-grant'), 16),
      approvedAt: grant.approvedAt || now(),
      expiresAt: grant.expiresAt,
      rawApprovalPersisted: false
    };
  }

  function assertPauseBudget(plan, snapshot) {
    const started = snapshot && snapshot.pauseStartedAtMs;
    const budget = plan.executionContract.availability.sourcePauseBudgetMs;
    if (!Number.isFinite(started) || Date.now() - started > budget) {
      throw new StatefulMigrationError('Stateful source pause budget was exceeded', 503, 'stateful-pause-budget-exceeded');
    }
  }

  function adapterState(operationId) {
    if (typeof executionAdapter.getState !== 'function') return null;
    try {
      return executionAdapter.getState(operationId);
    } catch (error) {
      if (error && (error.code === 'adapter-state-not-found' || error.statusCode === 404)) return null;
      throw error;
    }
  }

  async function execute(planId, approval) {
    const plan = getPlan(planId);
    if (plan.readiness.status !== 'backend-ready-ui-approval-required') {
      throw new StatefulMigrationError('Stateful migration plan is blocked', 409, 'plan-blocked');
    }
    if (inFlight.has(plan.resource.resourceId)) throw new StatefulMigrationError('Stateful migration is already running', 409, 'operation-in-progress');
    const approvalRecord = await verifyApproval('stateful-migration-apply', plan, approval);
    const operationId = 'stmop_' + randomUUID().replace(/-/g, '');
    const lock = acquireLock(operationId);
    inFlight.add(plan.resource.resourceId);
    const operation = {
      schemaVersion: STATEFUL_MIGRATION_SCHEMA_VERSION,
      operationId,
      planId: plan.planId,
      resourceId: plan.resource.resourceId,
      mode: 'stateful-bounded-quiesce-transaction',
      status: 'running',
      phase: 'approved',
      startedAt: now(),
      history: [{ phase: 'approved', at: now() }],
      approval: approvalRecord,
      snapshot: null,
      candidate: null,
      route: null,
      trafficProof: null,
      source: { paused: false, stopped: false, retainedForRollback: true },
      provider: { mutated: false, detached: false },
      rollback: { automaticAttempted: false, available: false, verified: false },
      cleanup: { candidateCleaned: false, routeCleaned: false },
      availability: {
        zeroDowntimeClaimed: false,
        sourcePauseBudgetMs: plan.executionContract.availability.sourcePauseBudgetMs,
        sourcePauseDurationMs: null
      }
    };
    let candidateCreated = false;
    let candidateCreationStarted = false;
    let routeStaged = false;
    let routeMutationStarted = false;
    let sourceQuiesced = false;
    let switched = false;
    try {
      persistOperation(operation);
      setPhase(operation, 'preflight');
      const preflight = await executionAdapter.preflight({ plan, operationId });
      assertProof(preflight && preflight.evidenceFingerprint === plan.resource.evidenceFingerprint, 'Stateful evidence changed', 'migration-plan-stale');
      assertProof(preflight.sourceHealthy === true, 'Source health failed before stateful migration', 'source-health-failed');
      assertProof(preflight.routeCollisionFree === true, 'Route conflict blocks stateful migration', 'route-conflict');

      setPhase(operation, 'final-snapshot');
      const snapshot = await executionAdapter.quiesceAndSnapshot({ plan, operationId });
      assertProof(snapshot && snapshot.sourcePaused === true && snapshot.encrypted === true, 'Final encrypted snapshot failed', 'final-snapshot-failed');
      operation.snapshot = {
        snapshotCount: snapshot.snapshotCount,
        encrypted: true,
        plaintextStored: false,
        pauseStartedAtMs: snapshot.pauseStartedAtMs
      };
      operation.source.paused = true;
      sourceQuiesced = true;
      persistOperation(operation);
      assertPauseBudget(plan, snapshot);

      setPhase(operation, 'candidate-create-and-restore');
      candidateCreationStarted = true;
      const candidate = await executionAdapter.createCandidate({ plan, operationId, snapshot });
      assertProof(candidate && candidate.owned === true && candidate.separateFromSource === true, 'Stateful candidate isolation failed', 'candidate-ownership-failed');
      assertProof(candidate.restoredVolumes === snapshot.snapshotCount, 'Not every stateful volume was restored', 'restore-proof-incomplete');
      candidateCreated = true;
      operation.candidate = candidate;
      persistOperation(operation);
      assertPauseBudget(plan, snapshot);

      setPhase(operation, 'candidate-health');
      const health = await executionAdapter.verifyCandidateHealth({ plan, operationId, candidate });
      assertProof(health && health.healthy === true, 'Stateful candidate health failed', 'candidate-health-failed');
      operation.candidate = { ...candidate, health };
      persistOperation(operation);
      assertPauseBudget(plan, snapshot);

      setPhase(operation, 'route-stage');
      routeMutationStarted = true;
      const route = await executionAdapter.stageRoute({ plan, operationId, candidate });
      assertProof(route && route.staged === true && route.active === false && route.tlsReady === true, 'Stateful route staging failed', 'route-stage-failed');
      routeStaged = true;
      operation.route = route;
      persistOperation(operation);
      assertPauseBudget(plan, snapshot);

      setPhase(operation, 'traffic-switch');
      const switchProof = await executionAdapter.switchTraffic({ plan, operationId, candidate, route });
      assertProof(switchProof && switchProof.switched === true, 'Stateful traffic switch failed', 'traffic-switch-failed');
      switched = true;
      assertPauseBudget(plan, snapshot);

      setPhase(operation, 'traffic-verify');
      const traffic = await executionAdapter.verifyTraffic({ plan, operationId, candidate, route });
      assertProof(
        traffic && traffic.healthy === true && traffic.tlsValid === true &&
        traffic.candidateServing === true && traffic.unavailableSamples === 0,
        'Stateful candidate traffic proof failed',
        'traffic-health-failed'
      );
      operation.trafficProof = traffic;
      persistOperation(operation);
      assertPauseBudget(plan, snapshot);

      setPhase(operation, 'source-parking');
      const parking = await executionAdapter.parkSourceForRollback({ plan, operationId, candidate, route });
      assertProof(parking && parking.sourceStopped === true && parking.candidateServing === true, 'Stateful rollback source parking failed', 'rollback-source-parking-failed');
      operation.source.paused = false;
      operation.source.stopped = true;
      operation.source.retainedForRollback = true;
      operation.availability.sourcePauseDurationMs = parking.pauseDurationMs;
      operation.rollback = { automaticAttempted: false, available: true, verified: false, mode: 'cold-source' };
      operation.status = 'traffic-on-server-source-preserved';
      operation.phase = 'complete';
      operation.completedAt = now();
      operation.history.push({ phase: 'complete', at: operation.completedAt });
      persistOperation(operation);
      prune(operationsRoot);
      return operation;
    } catch (error) {
      const failure = transactionFailure(error);
      failure.operationId = operationId;
      let persistedAdapterState = null;
      try { persistedAdapterState = adapterState(operationId); } catch { /* recovery below remains fail-closed */ }
      const trafficMayBeSwitched = Boolean(
        switched || persistedAdapterState && (
          persistedAdapterState.trafficSwitched === true ||
          Array.isArray(persistedAdapterState.switchedDomains) && persistedAdapterState.switchedDomains.length > 0
        )
      );
      const sourceMayBeQuiesced = Boolean(
        sourceQuiesced || persistedAdapterState && persistedAdapterState.source && (
          persistedAdapterState.source.paused === true ||
          persistedAdapterState.source.pauseIntentPersisted === true
        )
      );
      operation.rollback.automaticAttempted = trafficMayBeSwitched;
      try {
        if (trafficMayBeSwitched) {
          setPhase(operation, 'automatic-rollback');
          const rollback = await executionAdapter.rollbackTraffic({ plan, operationId });
          const proof = await executionAdapter.verifyRollback({ plan, operationId, rollback });
          assertProof(proof && proof.sourceServing === true && proof.trafficRestored === true, 'Automatic rollback proof failed', 'automatic-rollback-proof-failed');
          operation.rollback.verified = true;
          operation.rollback.proof = proof;
        } else if (sourceMayBeQuiesced) {
          await executionAdapter.resumeSource({ plan, operationId });
        }
        operation.source.paused = false;
        operation.source.stopped = false;
        if (routeStaged || routeMutationStarted) {
          await executionAdapter.cleanupStagedRoute({ plan, operationId });
          operation.cleanup.routeCleaned = true;
        }
        if (candidateCreated || candidateCreationStarted) {
          await executionAdapter.cleanupCandidate({ plan, operationId });
          operation.cleanup.candidateCleaned = true;
        }
        operation.status = trafficMayBeSwitched ? 'rolled-back-after-failure' : 'failed-before-switch-cleaned';
        operation.phase = trafficMayBeSwitched ? 'rolled-back' : 'cleaned';
      } catch (rollbackError) {
        operation.status = 'automatic-rollback-failed';
        operation.phase = 'recovery-required';
        operation.rollback.errorCode = rollbackError.code || 'rollback-failed';
      }
      operation.completedAt = now();
      operation.error = { code: failure.code, message: failure.message };
      persistOperation(operation);
      if (operation.status === 'automatic-rollback-failed') {
        throw new StatefulMigrationError('Automatic stateful rollback requires recovery', 500, 'automatic-rollback-failed');
      }
      throw failure;
    } finally {
      inFlight.delete(plan.resource.resourceId);
      try { releaseLock(lock); } catch { /* operation record remains authoritative */ }
    }
  }

  async function rollback(operationId, approval) {
    const operation = getOperation(operationId);
    if (operation.status !== 'traffic-on-server-source-preserved' || operation.rollback.available !== true) {
      throw new StatefulMigrationError('Stateful rollback is unavailable', 409, 'rollback-unavailable');
    }
    const plan = getPlan(operation.planId);
    await verifyApproval('stateful-migration-rollback', plan, approval);
    const lock = acquireLock(operationId);
    try {
      setPhase(operation, 'ui-approved-rollback');
      const result = await executionAdapter.rollbackTraffic({ plan, operationId });
      const proof = await executionAdapter.verifyRollback({ plan, operationId, rollback: result });
      assertProof(proof && proof.sourceServing === true && proof.trafficRestored === true, 'Stateful rollback proof failed', 'rollback-proof-failed');
      await executionAdapter.cleanupStagedRoute({ plan, operationId });
      await executionAdapter.cleanupCandidate({ plan, operationId });
      operation.status = 'rolled-back';
      operation.phase = 'rolled-back';
      operation.completedAt = now();
      operation.rollback = { available: false, automaticAttempted: false, verified: true, proof };
      operation.cleanup = { routeCleaned: true, candidateCleaned: true };
      persistOperation(operation);
      return operation;
    } finally {
      releaseLock(lock);
    }
  }

  async function recoverInterruptedOperations({ clearStaleLock = false } = {}) {
    const active = listJson(operationsRoot).filter((operation) => (
      operation.status === 'running' || operation.status === 'automatic-rollback-failed'
    ));
    if (!active.length) {
      if (clearStaleLock) {
        try { fs.unlinkSync(operationLockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return { recovered: [] };
    }
    const lock = acquireLock('startup-recovery', clearStaleLock);
    const recovered = [];
    try {
      for (const operation of active) {
        const plan = getPlan(operation.planId);
        try {
          const persistedAdapterState = adapterState(operation.operationId);
          const adapterRoutes = persistedAdapterState && Array.isArray(persistedAdapterState.routes)
            ? persistedAdapterState.routes : [];
          const trafficMayBeSwitched = Boolean(
            persistedAdapterState && (
              persistedAdapterState.trafficSwitched === true ||
              Array.isArray(persistedAdapterState.switchedDomains) && persistedAdapterState.switchedDomains.length > 0
            )
          );
          const routeCreated = Boolean(operation.route || adapterRoutes.length > 0);
          const candidateCreated = Boolean(
            operation.candidate || persistedAdapterState && (
              persistedAdapterState.candidate ||
              Array.isArray(persistedAdapterState.targetVolumes) && persistedAdapterState.targetVolumes.length > 0
            )
          );
          if (trafficMayBeSwitched || operation.route) {
            await executionAdapter.rollbackTraffic({ plan, operationId: operation.operationId });
            await executionAdapter.verifyRollback({ plan, operationId: operation.operationId });
          } else {
            await executionAdapter.resumeSource({ plan, operationId: operation.operationId });
          }
          if (routeCreated) await executionAdapter.cleanupStagedRoute({ plan, operationId: operation.operationId });
          if (candidateCreated) await executionAdapter.cleanupCandidate({ plan, operationId: operation.operationId });
          operation.status = 'interrupted-rolled-back';
          operation.phase = 'rolled-back';
        } catch (error) {
          operation.status = 'interrupted-recovery-required';
          operation.phase = 'recovery-required';
          operation.recoveryErrorCode = error.code || 'startup-recovery-failed';
        }
        operation.completedAt = now();
        persistOperation(operation);
        recovered.push({ operationId: operation.operationId, status: operation.status });
      }
      return { recovered };
    } finally {
      releaseLock(lock);
    }
  }

  function status() {
    const plans = listJson(plansRoot);
    const operations = listJson(operationsRoot);
    return {
      schemaVersion: STATEFUL_MIGRATION_SCHEMA_VERSION,
      mode: 'stateful-bounded-quiesce-transaction',
      plans,
      operations,
      summary: {
        plans: plans.length,
        operations: operations.length,
        active: operations.filter((operation) => operation.status === 'running').length,
        completed: operations.filter((operation) => operation.status === 'traffic-on-server-source-preserved').length,
        recoveryRequired: operations.filter((operation) => String(operation.status).includes('recovery-required')).length
      },
      guarantees: {
        sourcePreserved: true,
        automaticRollback: true,
        providerDetachIncluded: false,
        destructiveSourceCleanupIncluded: false,
        zeroDowntimeClaimed: false,
        secretValuesIncluded: false
      }
    };
  }

  ensureDirectory(plansRoot);
  ensureDirectory(operationsRoot);
  return {
    createPlan,
    execute,
    getOperation,
    getPlan,
    paths: { root, plansRoot, operationsRoot, operationLockFile },
    recoverInterruptedOperations,
    rollback,
    status
  };
}

module.exports = {
  PREPARE_STATEFUL_MIGRATION_CONFIRMATION,
  STATEFUL_MIGRATION_SCHEMA_VERSION,
  StatefulMigrationError,
  createStatefulMigrationManager
};
