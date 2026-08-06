const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('./applicationManifestManager');
const { atomicWriteJson } = require('./resourceRegistry');

const STATELESS_MIGRATION_SCHEMA_VERSION = 1;
const PREPARE_STATELESS_MIGRATION_CONFIRMATION = 'PREPARE STATELESS MIGRATION';
const STATELESS_PLAN_PATTERN = /^smplan_[a-f0-9]{32}$/;
const STATELESS_OPERATION_PATTERN = /^smop_[a-f0-9]{32}$/;
const SERVER_PLAN_PATTERN = /^mplan_[a-f0-9]{32}$/;
const RESOURCE_PATTERN = /^res_[a-f0-9]{32}$/;
const MAX_PLANS = 100;
const MAX_OPERATIONS = 100;
const UI_APPROVAL_SOURCE = 'foxos-ui';

const REPLACED_IMPLEMENTATION_BLOCKERS = new Set([
  'migration-apply-transaction-not-implemented',
  'zero-downtime-blue-green-apply-not-implemented',
  'general-domain-route-cutover-not-implemented'
]);

const REQUIRED_ADAPTER_METHODS = [
  'preflight',
  'createCandidate',
  'verifyCandidateHealth',
  'stageRoute',
  'switchTraffic',
  'verifyTraffic',
  'rollbackTraffic',
  'verifyRollback',
  'cleanupCandidate',
  'cleanupStagedRoute'
];

const REQUIRED_CAPABILITIES = [
  'candidateRuntime',
  'healthProof',
  'stagedRouteTls',
  'atomicTrafficSwitch',
  'trafficProbe',
  'rollback',
  'sourcePreserved'
];

class StatelessMigrationError extends Error {
  constructor(message, statusCode = 400, code = 'stateless-migration-error') {
    super(message);
    this.name = 'StatelessMigrationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function transactionFailure(error) {
  if (error instanceof StatelessMigrationError) return error;
  if (
    error && error.name === 'ProductionStatelessMigrationError' &&
    /^[a-z0-9][a-z0-9-]{2,80}$/.test(String(error.code || '')) &&
    typeof error.message === 'string' && error.message.length >= 1 && error.message.length <= 240 &&
    !/[\r\n\0]/.test(error.message)
  ) {
    return new StatelessMigrationError(
      error.message,
      Number.isInteger(error.statusCode) ? error.statusCode : 500,
      error.code
    );
  }
  return new StatelessMigrationError(
    'Stateless migration transaction failed',
    500,
    'stateless-migration-failed'
  );
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
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

function prune(directory, maximum, dateField, idField) {
  const records = listJson(directory).sort((left, right) => (
    String(left[dateField] || '').localeCompare(String(right[dateField] || '')) ||
    String(left[idField] || '').localeCompare(String(right[idField] || ''))
  ));
  for (const record of records.slice(0, Math.max(0, records.length - maximum))) {
    fs.unlinkSync(path.join(directory, record[idField] + '.json'));
  }
}

function safeBlocker(blocker, source) {
  return {
    code: blocker.code,
    section: blocker.section || 'unknown',
    severity: blocker.severity || 'blocking',
    source: blocker.source || source,
    message: blocker.message || null
  };
}

function uniqueBlockers(blockers) {
  const values = new Map();
  for (const blocker of blockers) {
    const normalized = safeBlocker(blocker, blocker.source || 'unknown');
    values.set(normalized.source + ':' + normalized.section + ':' + normalized.code, normalized);
  }
  return Array.from(values.values()).sort((left, right) => (
    left.section.localeCompare(right.section) || left.code.localeCompare(right.code)
  ));
}

function adapterStatus(executionAdapter, approvalVerifier) {
  const missingMethods = REQUIRED_ADAPTER_METHODS.filter((name) => (
    !executionAdapter || typeof executionAdapter[name] !== 'function'
  ));
  const capabilities = executionAdapter && executionAdapter.capabilities || {};
  const missingCapabilities = REQUIRED_CAPABILITIES.filter((name) => capabilities[name] !== true);
  const unsafeCapabilities = [];
  if (capabilities.providerDetach === true) unsafeCapabilities.push('provider-detach-enabled');
  if (capabilities.sourceStop === true) unsafeCapabilities.push('source-stop-enabled');
  if (capabilities.sourceRecreation === true) unsafeCapabilities.push('source-recreation-enabled');
  if (executionAdapter && typeof executionAdapter.stopSource === 'function') {
    unsafeCapabilities.push('source-stop-method-present');
  }
  if (executionAdapter && typeof executionAdapter.recreateSource === 'function') {
    unsafeCapabilities.push('source-recreation-method-present');
  }
  if (executionAdapter && typeof executionAdapter.detachProvider === 'function') {
    unsafeCapabilities.push('provider-detach-method-present');
  }
  if (executionAdapter && typeof executionAdapter.deleteSource === 'function') {
    unsafeCapabilities.push('destructive-source-delete-method-present');
  }
  return {
    configured: Boolean(executionAdapter),
    approvalVerifierConfigured: typeof approvalVerifier === 'function',
    missingMethods,
    missingCapabilities,
    unsafeCapabilities,
    ready: Boolean(
      executionAdapter && typeof approvalVerifier === 'function' &&
      missingMethods.length === 0 && missingCapabilities.length === 0 && unsafeCapabilities.length === 0
    )
  };
}

function executionBlockers(resource, adapter, executionContract = null) {
  const evidence = resource.blockers && resource.blockers.evidence || [];
  const conflicts = resource.conflicts || [];
  const implementation = resource.blockers && resource.blockers.implementation || [];
  const blockers = [
    ...evidence.map((entry) => safeBlocker(entry, 'orchestrator-evidence')),
    ...conflicts.filter((entry) => entry.severity === 'blocking').map((entry) => ({
      code: 'blocking-resource-conflict:' + entry.type,
      section: 'conflicts',
      severity: 'blocking',
      source: 'resource-registry'
    })),
    ...implementation.filter((entry) => !REPLACED_IMPLEMENTATION_BLOCKERS.has(entry.code))
      .map((entry) => safeBlocker(entry, 'orchestrator-implementation')),
    ...(executionContract && executionContract.readiness && executionContract.readiness.blockers || [])
      .map((entry) => safeBlocker(entry, 'stateless-manifest-compiler'))
  ];
  if (!resource.readiness || resource.readiness.evidenceComplete !== true) {
    blockers.push({
      code: 'migration-evidence-incomplete',
      section: 'evidence',
      severity: 'blocking',
      source: 'stateless-migration'
    });
  }
  if (!adapter.configured) {
    blockers.push({
      code: 'stateless-runtime-adapter-not-configured',
      section: 'execution',
      severity: 'blocking',
      source: 'stateless-migration'
    });
  }
  for (const name of adapter.missingMethods) {
    blockers.push({
      code: 'execution-adapter-method-missing:' + name,
      section: 'execution',
      severity: 'blocking',
      source: 'stateless-migration'
    });
  }
  for (const name of adapter.missingCapabilities) {
    blockers.push({
      code: 'execution-adapter-capability-missing:' + name,
      section: 'execution',
      severity: 'blocking',
      source: 'stateless-migration'
    });
  }
  for (const name of adapter.unsafeCapabilities) {
    blockers.push({
      code: 'unsafe-execution-adapter:' + name,
      section: 'execution',
      severity: 'blocking',
      source: 'stateless-migration'
    });
  }
  if (!adapter.approvalVerifierConfigured) {
    blockers.push({
      code: 'foxos-ui-approval-provider-sealed',
      section: 'approval',
      severity: 'blocking',
      source: 'stateless-migration'
    });
  }
  return uniqueBlockers(blockers);
}

function validateProof(condition, message, code) {
  if (!condition) throw new StatelessMigrationError(message, 409, code);
}

function select(value, keys) {
  return Object.fromEntries(keys.filter((key) => value && value[key] !== undefined)
    .map((key) => [key, value[key]]));
}

function safeCandidate(value) {
  return select(value, [
    'candidateId', 'containerId', 'networkId', 'networkName', 'revisionId',
    'imageId', 'imageDigest', 'privatePort', 'owned', 'separateFromSource', 'sourceTouched'
  ]);
}

function safeHealth(value) {
  return select(value, ['healthy', 'status', 'statusCode', 'attempts', 'identity', 'checkedAt']);
}

function safeRoute(value) {
  return select(value, [
    'routeId', 'routeRevision', 'domain', 'path', 'alias', 'staged', 'active',
    'collisionFree', 'tlsReady', 'sourceStillServing'
  ]);
}

function safeTrafficProof(value) {
  return select(value, [
    'healthy', 'tlsValid', 'candidateServing', 'sourceContinuouslyRunning',
    'unavailableSamples', 'probes', 'checkedAt', 'candidateIdentity'
  ]);
}

function safeRollbackProof(value) {
  return select(value, [
    'sourceServing', 'trafficRestored', 'candidateServing', 'unavailableSamples',
    'probes', 'checkedAt'
  ]);
}

function createStatelessMigrationManager({
  dataRoot,
  getServerMigrationPlan,
  compileExecutionContract = null,
  executionAdapter = null,
  approvalVerifier = null,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (
    !dataRoot || typeof getServerMigrationPlan !== 'function' ||
    (compileExecutionContract !== null && typeof compileExecutionContract !== 'function')
  ) {
    throw new Error('Stateless migration manager requires a data root and server-plan adapter');
  }
  const root = path.join(dataRoot, 'stateless-migrations');
  const plansRoot = path.join(root, 'plans');
  const operationsRoot = path.join(root, 'operations');
  const operationLockFile = path.join(root, 'operation.lock');
  const inFlight = new Set();

  function now() {
    return new Date(clock()).toISOString();
  }

  function getPlan(planId) {
    if (!STATELESS_PLAN_PATTERN.test(String(planId || ''))) {
      throw new StatelessMigrationError('Invalid stateless migration plan ID', 400, 'invalid-plan-id');
    }
    const plan = readJson(path.join(plansRoot, planId + '.json'));
    if (!plan) throw new StatelessMigrationError('Stateless migration plan was not found', 404, 'plan-not-found');
    return plan;
  }

  function getOperation(operationId) {
    if (!STATELESS_OPERATION_PATTERN.test(String(operationId || ''))) {
      throw new StatelessMigrationError('Invalid stateless migration operation ID', 400, 'invalid-operation-id');
    }
    const operation = readJson(path.join(operationsRoot, operationId + '.json'));
    if (!operation) {
      throw new StatelessMigrationError('Stateless migration operation was not found', 404, 'operation-not-found');
    }
    return operation;
  }

  function persistOperation(operation) {
    atomicWriteJson(path.join(operationsRoot, operation.operationId + '.json'), operation);
    return operation;
  }

  function acquireOperationLock(resourceId) {
    const token = randomUUID();
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      fs.chmodSync(root, 0o700);
      const descriptor = fs.openSync(operationLockFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ resourceId, token }) + '\n', { encoding: 'utf8' });
      fs.closeSync(descriptor);
      return token;
    } catch (error) {
      if (error.code === 'EEXIST') return null;
      throw error;
    }
  }

  function releaseOperationLock(token) {
    try {
      const lock = readJson(operationLockFile);
      if (lock && lock.token === token) fs.unlinkSync(operationLockFile);
    } catch {
      // A corrupt or foreign lock is preserved for explicit recovery.
    }
  }

  function markInterruptedOperations() {
    for (const operation of listJson(operationsRoot)) {
      if (operation.status === 'running') {
        operation.status = 'interrupted-ui-recovery-required';
        operation.phase = 'recovery-required';
        operation.interruptedAt = now();
        operation.recovery = {
          automaticReplay: false,
          runtimeMutatedDuringStartup: false,
          uiApprovalRequired: true
        };
        persistOperation(operation);
      }
    }
  }

  markInterruptedOperations();

  function createPlan(input = {}) {
    if (input.confirmation !== PREPARE_STATELESS_MIGRATION_CONFIRMATION) {
      throw new StatelessMigrationError(
        'Exact stateless migration preparation confirmation is required',
        400,
        'confirmation-required'
      );
    }
    if (!SERVER_PLAN_PATTERN.test(String(input.serverPlanId || ''))) {
      throw new StatelessMigrationError('Invalid server migration plan ID', 400, 'invalid-server-plan-id');
    }
    if (!RESOURCE_PATTERN.test(String(input.resourceId || ''))) {
      throw new StatelessMigrationError('Invalid FoxOS resource ID', 400, 'invalid-resource-id');
    }
    const serverPlan = getServerMigrationPlan(input.serverPlanId);
    if (
      !serverPlan || serverPlan.planId !== input.serverPlanId ||
      serverPlan.mode !== 'read-only-server-migration-plan'
    ) {
      throw new StatelessMigrationError('Server migration plan identity is invalid', 409, 'server-plan-invalid');
    }
    const resource = (serverPlan.resources || []).find((entry) => entry.resourceId === input.resourceId);
    if (!resource) {
      throw new StatelessMigrationError('Resource is not present in the server migration plan', 404, 'resource-not-found');
    }
    if (
      resource.protected || !resource.migrationRequired || resource.strategy !== 'blue-green-atomic-route' ||
      !resource.classification || resource.classification.stateClass !== 'stateless'
    ) {
      throw new StatelessMigrationError(
        'Only unprotected provider-owned stateless blue/green resources can enter this transaction',
        403,
        'unsupported-resource-class'
      );
    }
    const adapter = adapterStatus(executionAdapter, approvalVerifier);
    const executionContract = compileExecutionContract
      ? compileExecutionContract({ serverPlan, resource })
      : null;
    if (
      executionContract &&
      (!executionContract.contractId || !executionContract.readiness || !executionContract.guarantees ||
        executionContract.guarantees.runtimeMutated !== false ||
        executionContract.guarantees.providerDetached !== false ||
        executionContract.guarantees.secretValuesIncluded !== false)
    ) {
      throw new StatelessMigrationError(
        'Stateless execution contract is invalid or unsafe',
        409,
        'execution-contract-invalid'
      );
    }
    const blockers = executionBlockers(resource, adapter, executionContract);
    const evidenceFingerprint = hash(canonicalJson({
      serverPlanId: serverPlan.planId,
      sourceSnapshotId: serverPlan.sourceSnapshotId,
      resourceId: resource.resourceId,
      classification: resource.classification,
      evidence: resource.evidence,
      dependencies: resource.dependencies,
      conflicts: resource.conflicts,
      blockers: resource.blockers,
      readiness: resource.readiness,
      executionContract
    }), 64);
    const core = {
      schemaVersion: STATELESS_MIGRATION_SCHEMA_VERSION,
      mode: 'stateless-blue-green-transaction-review',
      serverPlanId: serverPlan.planId,
      sourceSnapshotId: serverPlan.sourceSnapshotId,
      resource: {
        resourceId: resource.resourceId,
        name: resource.name,
        observedProvider: resource.observedProvider,
        observedOwnership: resource.observedOwnership,
        classification: resource.classification,
        evidence: resource.evidence,
        dependencies: resource.dependencies,
        evidenceFingerprint
      },
      strategy: 'blue-green-atomic-route',
      executionContract,
      transaction: {
        steps: [
          'revalidate-immutable-evidence-and-source-health',
          'create-separate-foxos-owned-candidate',
          'verify-candidate-health',
          'stage-conflict-checked-route-and-tls',
          'switch-traffic-atomically-with-source-running',
          'probe-availability-and-candidate-identity',
          'retain-source-and-exact-rollback-path'
        ],
        sourceStopAllowed: false,
        sourceRecreationAllowed: false,
        providerDetachIncluded: false,
        destructiveCleanupIncluded: false,
        unavailableSamplesAllowed: 0
      },
      readiness: {
        status: blockers.length ? 'blocked' : 'backend-ready-ui-approval-required',
        evidenceComplete: resource.readiness && resource.readiness.evidenceComplete === true,
        manifestCompilerConfigured: typeof compileExecutionContract === 'function',
        manifestContractStatus: executionContract && executionContract.readiness.status || 'not-configured',
        executionAdapterReady: adapter.ready,
        uiApprovalRequired: true,
        uiApprovalConfigured: adapter.approvalVerifierConfigured,
        runEndpointExposed: false,
        applyStarted: false,
        blockers
      },
      guarantees: {
        planDockerRequestsMade: 0,
        runtimeMutated: false,
        routesMutated: false,
        trafficSwitched: false,
        sourceStopped: false,
        sourceRecreated: false,
        providerStateMutated: false,
        providerDetached: false,
        destructiveCleanupApproved: false,
        secretValuesIncluded: false,
        ordinaryEnvironmentValuesIncluded: false,
        uiApprovalRequiredForExecution: true,
        executionEndpointExposed: false
      }
    };
    const planId = 'smplan_' + hash(canonicalJson(core));
    const target = path.join(plansRoot, planId + '.json');
    const existing = readJson(target);
    if (existing) return existing;
    const plan = { ...core, planId, createdAt: now() };
    atomicWriteJson(target, plan);
    prune(plansRoot, MAX_PLANS, 'createdAt', 'planId');
    return plan;
  }

  async function verifyApproval(kind, plan, approval) {
    const adapter = adapterStatus(executionAdapter, approvalVerifier);
    if (!adapter.ready) {
      throw new StatelessMigrationError(
        'Stateless migration execution is sealed until the FoxOS UI approval provider and runtime adapters exist',
        423,
        'ui-approval-gate-sealed'
      );
    }
    const grant = await approvalVerifier({
      kind,
      planId: plan.planId,
      resourceId: plan.resource.resourceId,
      evidenceFingerprint: plan.resource.evidenceFingerprint,
      approval
    });
    const expiresAt = grant && Date.parse(grant.expiresAt);
    validateProof(grant && grant.approved === true, 'FoxOS UI approval was not granted', 'ui-approval-required');
    validateProof(grant.source === UI_APPROVAL_SOURCE, 'Approval source is not the FoxOS UI', 'invalid-approval-source');
    validateProof(grant.kind === kind, 'Approval is bound to another action', 'approval-kind-mismatch');
    validateProof(grant.planId === plan.planId, 'Approval is bound to another plan', 'approval-plan-mismatch');
    validateProof(
      grant.resourceId === plan.resource.resourceId,
      'Approval is bound to another resource',
      'approval-resource-mismatch'
    );
    validateProof(
      grant.evidenceFingerprint === plan.resource.evidenceFingerprint,
      'Approval evidence fingerprint is stale',
      'approval-evidence-stale'
    );
    validateProof(grant.oneTime === true && grant.consumed === true, 'Approval grant was not consumed once', 'approval-not-one-time');
    validateProof(Number.isFinite(expiresAt) && expiresAt > Date.parse(now()), 'Approval grant expired', 'approval-expired');
    return {
      grantIdFingerprint: hash(String(grant.grantId || 'ui-grant'), 16),
      source: UI_APPROVAL_SOURCE,
      oneTime: true,
      approvedAt: grant.approvedAt || now(),
      expiresAt: grant.expiresAt,
      rawApprovalPersisted: false
    };
  }

  function setPhase(operation, phase, patch = {}) {
    operation.phase = phase;
    operation.history.push({ phase, at: now() });
    Object.assign(operation, patch);
    persistOperation(operation);
  }

  async function execute(planId, approval) {
    const plan = getPlan(planId);
    const adapter = adapterStatus(executionAdapter, approvalVerifier);
    if (!adapter.ready) {
      throw new StatelessMigrationError(
        'Stateless migration execution is sealed until the FoxOS UI approval provider and runtime adapters exist',
        423,
        'ui-approval-gate-sealed'
      );
    }
    if (plan.readiness.status !== 'backend-ready-ui-approval-required') {
      throw new StatelessMigrationError('Stateless migration plan is blocked', 409, 'plan-blocked');
    }
    if (inFlight.has(plan.resource.resourceId)) {
      throw new StatelessMigrationError('A stateless migration is already running for this resource', 409, 'operation-in-progress');
    }
    const operationLock = acquireOperationLock(plan.resource.resourceId);
    if (!operationLock) {
      throw new StatelessMigrationError('Another stateless migration process is active', 409, 'operation-in-progress');
    }
    let approvalRecord;
    try {
      approvalRecord = await verifyApproval('stateless-migration-apply', plan, approval);
    } catch (error) {
      releaseOperationLock(operationLock);
      throw error;
    }
    inFlight.add(plan.resource.resourceId);
    const operationId = 'smop_' + randomUUID().replace(/-/g, '');
    const operation = {
      schemaVersion: STATELESS_MIGRATION_SCHEMA_VERSION,
      operationId,
      planId: plan.planId,
      resourceId: plan.resource.resourceId,
      mode: 'stateless-blue-green-transaction',
      status: 'running',
      phase: 'approved',
      startedAt: now(),
      history: [{ phase: 'approved', at: now() }],
      approval: approvalRecord,
      candidate: null,
      route: null,
      trafficProof: null,
      availability: {
        zeroDowntimeRequired: true,
        unavailableSamplesAllowed: 0,
        zeroDowntimeProven: false
      },
      source: {
        stopped: false,
        recreated: false,
        retainedForRollback: true
      },
      provider: { mutated: false, detached: false },
      cleanup: { destructiveSourceCleanup: false, candidateCleaned: false, stagedRouteCleaned: false },
      rollback: { automaticAttempted: false, available: false, verified: false },
      guarantees: {
        rawApprovalPersisted: false,
        secretValuesIncluded: false,
        ordinaryEnvironmentValuesIncluded: false,
        sourceStopMethodAvailable: false,
        providerDetachMethodAvailable: false
      }
    };
    let switched = false;
    let candidateCreated = false;
    let routeStaged = false;
    try {
      persistOperation(operation);
      setPhase(operation, 'preflight');
      const preflight = await executionAdapter.preflight({ plan, operationId });
      validateProof(
        preflight && preflight.evidenceFingerprint === plan.resource.evidenceFingerprint,
        'Stateless migration evidence changed after planning',
        'migration-plan-stale'
      );
      validateProof(preflight.sourceHealthy === true, 'Source health failed before migration', 'source-health-failed');
      validateProof(
        preflight.sourceContinuouslyRunning === true,
        'Source is not continuously running before migration',
        'source-not-continuously-running'
      );
      validateProof(preflight.routeCollisionFree === true, 'Route conflict blocks migration', 'route-conflict');

      setPhase(operation, 'candidate-create');
      const candidate = await executionAdapter.createCandidate({ plan, operationId, preflight });
      validateProof(
        candidate && candidate.owned === true && candidate.separateFromSource === true,
        'Candidate ownership or isolation proof failed',
        'candidate-ownership-failed'
      );
      validateProof(candidate.sourceTouched === false, 'Candidate creation touched the source', 'source-mutated');
      candidateCreated = true;
      operation.candidate = safeCandidate(candidate);
      persistOperation(operation);

      setPhase(operation, 'candidate-health');
      const candidateHealth = await executionAdapter.verifyCandidateHealth({ plan, operationId, candidate });
      validateProof(candidateHealth && candidateHealth.healthy === true, 'Candidate health proof failed', 'candidate-health-failed');
      operation.candidate = { ...safeCandidate(candidate), health: safeHealth(candidateHealth) };
      persistOperation(operation);

      setPhase(operation, 'route-stage');
      const route = await executionAdapter.stageRoute({ plan, operationId, candidate });
      validateProof(
        route && route.staged === true && route.active === false && route.collisionFree === true,
        'Route staging proof failed',
        'route-stage-failed'
      );
      validateProof(route.tlsReady === true, 'TLS proof is not ready before traffic switch', 'tls-proof-failed');
      validateProof(route.sourceStillServing === true, 'Source stopped serving while route was staged', 'source-not-serving');
      routeStaged = true;
      operation.route = safeRoute(route);
      persistOperation(operation);

      setPhase(operation, 'traffic-switch');
      const switchProof = await executionAdapter.switchTraffic({ plan, operationId, candidate, route });
      validateProof(switchProof && switchProof.switched === true, 'Atomic traffic switch failed', 'traffic-switch-failed');
      validateProof(switchProof.sourceStopped === false, 'Traffic switch stopped the source', 'source-stopped');
      validateProof(switchProof.sourceRecreated === false, 'Traffic switch recreated the source', 'source-recreated');
      switched = true;

      setPhase(operation, 'traffic-verify');
      const trafficProof = await executionAdapter.verifyTraffic({ plan, operationId, candidate, route, switchProof });
      validateProof(trafficProof && trafficProof.healthy === true, 'Candidate traffic health failed', 'traffic-health-failed');
      validateProof(trafficProof.tlsValid === true, 'Candidate traffic TLS proof failed', 'traffic-tls-failed');
      validateProof(trafficProof.candidateServing === true, 'Candidate identity was not served', 'candidate-identity-failed');
      validateProof(
        trafficProof.sourceContinuouslyRunning === true,
        'Source continuity proof failed',
        'source-continuity-failed'
      );
      validateProof(trafficProof.unavailableSamples === 0, 'Availability probe observed downtime', 'downtime-observed');
      operation.trafficProof = safeTrafficProof(trafficProof);
      operation.availability.zeroDowntimeProven = true;
      operation.rollback.available = true;
      operation.status = 'traffic-on-foxos-source-preserved';
      operation.phase = 'complete';
      operation.completedAt = now();
      operation.history.push({ phase: 'complete', at: operation.completedAt });
      persistOperation(operation);
      prune(operationsRoot, MAX_OPERATIONS, 'startedAt', 'operationId');
      return operation;
    } catch (error) {
      const failure = transactionFailure(error);
      if (switched) {
        operation.rollback.automaticAttempted = true;
        try {
          setPhase(operation, 'automatic-rollback');
          const rollback = await executionAdapter.rollbackTraffic({
            plan,
            operationId,
            candidate: operation.candidate,
            route: operation.route
          });
          const rollbackProof = await executionAdapter.verifyRollback({ plan, operationId, rollback });
          validateProof(
            rollbackProof && rollbackProof.sourceServing === true && rollbackProof.trafficRestored === true,
            'Automatic rollback proof failed',
            'automatic-rollback-proof-failed'
          );
          operation.rollback = {
            automaticAttempted: true,
            available: false,
            verified: true,
            proof: safeRollbackProof(rollbackProof)
          };
          if (routeStaged) {
            await executionAdapter.cleanupStagedRoute({ plan, operationId, route: operation.route });
            operation.cleanup.stagedRouteCleaned = true;
          }
          if (candidateCreated) {
            await executionAdapter.cleanupCandidate({ plan, operationId, candidate: operation.candidate });
            operation.cleanup.candidateCleaned = true;
          }
          operation.status = 'rolled-back-after-failure';
          operation.phase = 'rolled-back';
          operation.completedAt = now();
          operation.error = { code: failure.code, message: failure.message };
          persistOperation(operation);
        } catch {
          operation.status = 'automatic-rollback-failed';
          operation.phase = 'recovery-required';
          operation.completedAt = now();
          operation.rollback.verified = false;
          operation.error = { code: failure.code, message: failure.message };
          persistOperation(operation);
          throw new StatelessMigrationError(
            'Automatic rollback could not be verified; FoxOS UI recovery is required',
            500,
            'automatic-rollback-failed'
          );
        }
      } else {
        let cleanupComplete = true;
        if (routeStaged) {
          try {
            await executionAdapter.cleanupStagedRoute({ plan, operationId, route: operation.route });
            operation.cleanup.stagedRouteCleaned = true;
          } catch { cleanupComplete = false; }
        }
        if (candidateCreated) {
          try {
            await executionAdapter.cleanupCandidate({ plan, operationId, candidate: operation.candidate });
            operation.cleanup.candidateCleaned = true;
          } catch { cleanupComplete = false; }
        }
        operation.status = cleanupComplete
          ? 'failed-before-switch-cleaned'
          : 'failed-before-switch-cleanup-required';
        operation.phase = cleanupComplete ? 'cleaned' : 'recovery-required';
        operation.completedAt = now();
        operation.error = { code: failure.code, message: failure.message };
        persistOperation(operation);
      }
      failure.operationId = operationId;
      throw failure;
    } finally {
      inFlight.delete(plan.resource.resourceId);
      releaseOperationLock(operationLock);
    }
  }

  async function rollback(operationId, approval) {
    const operation = getOperation(operationId);
    if (operation.status !== 'traffic-on-foxos-source-preserved' || !operation.rollback.available) {
      throw new StatelessMigrationError('Stateless migration rollback is unavailable', 409, 'rollback-unavailable');
    }
    const plan = getPlan(operation.planId);
    if (inFlight.has(plan.resource.resourceId)) {
      throw new StatelessMigrationError('A stateless migration is already running for this resource', 409, 'operation-in-progress');
    }
    const operationLock = acquireOperationLock(plan.resource.resourceId);
    if (!operationLock) {
      throw new StatelessMigrationError('Another stateless migration process is active', 409, 'operation-in-progress');
    }
    try {
      await verifyApproval('stateless-migration-rollback', plan, approval);
    } catch (error) {
      releaseOperationLock(operationLock);
      throw error;
    }
    inFlight.add(plan.resource.resourceId);
    try {
      setPhase(operation, 'ui-approved-rollback');
      const rollbackResult = await executionAdapter.rollbackTraffic({
        plan,
        operationId,
        candidate: operation.candidate,
        route: operation.route
      });
      const proof = await executionAdapter.verifyRollback({ plan, operationId, rollback: rollbackResult });
      validateProof(
        proof && proof.sourceServing === true && proof.trafficRestored === true,
        'Rollback proof failed',
        'rollback-proof-failed'
      );
      await executionAdapter.cleanupStagedRoute({ plan, operationId, route: operation.route });
      operation.cleanup.stagedRouteCleaned = true;
      await executionAdapter.cleanupCandidate({ plan, operationId, candidate: operation.candidate });
      operation.cleanup.candidateCleaned = true;
      operation.status = 'rolled-back';
      operation.phase = 'rolled-back';
      operation.completedAt = now();
      operation.rollback = {
        available: false,
        automaticAttempted: false,
        verified: true,
        proof: safeRollbackProof(proof)
      };
      operation.availability.rollbackVerified = true;
      persistOperation(operation);
      return operation;
    } finally {
      inFlight.delete(plan.resource.resourceId);
      releaseOperationLock(operationLock);
    }
  }

  function status() {
    const plans = listJson(plansRoot);
    const operations = listJson(operationsRoot);
    const adapter = adapterStatus(executionAdapter, approvalVerifier);
    return {
      schemaVersion: STATELESS_MIGRATION_SCHEMA_VERSION,
      mode: 'stateless-blue-green-transaction',
      plans,
      operations,
      summary: {
        plans: plans.length,
        operations: operations.length,
        active: operations.filter((operation) => operation.status === 'running').length,
        recoveryRequired: operations.filter((operation) => (
          operation.status.endsWith('required') || operation.status === 'automatic-rollback-failed'
        )).length
      },
      executionGate: {
        status: adapter.ready ? 'ui-approval-required' : 'sealed',
        uiApprovalRequired: true,
        uiApprovalConfigured: adapter.approvalVerifierConfigured,
        runtimeAdapterConfigured: adapter.configured,
        manifestCompilerConfigured: typeof compileExecutionContract === 'function',
        processLockPresent: fs.existsSync(operationLockFile),
        runEndpointExposed: false,
        approveEndpointExposed: false
      },
      guarantees: {
        sourceStopAllowed: false,
        sourceRecreationAllowed: false,
        providerDetachIncluded: false,
        destructiveCleanupIncluded: false,
        startupOperationReplay: false,
        secretValuesIncluded: false,
        ordinaryEnvironmentValuesIncluded: false
      }
    };
  }

  return {
    createPlan,
    execute,
    getOperation,
    getPlan,
    paths: { root, plansRoot, operationsRoot, operationLockFile },
    rollback,
    status
  };
}

module.exports = {
  PREPARE_STATELESS_MIGRATION_CONFIRMATION,
  STATELESS_MIGRATION_SCHEMA_VERSION,
  StatelessMigrationError,
  UI_APPROVAL_SOURCE,
  adapterStatus,
  createStatelessMigrationManager
};
