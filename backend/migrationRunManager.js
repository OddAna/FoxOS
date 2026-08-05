const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');
const {
  SAVE_MIGRATION_SELECTION_CONFIRMATION,
  isReviewSelectable
} = require('./migrationSelectionManager');
const { PREPARE_STATELESS_MIGRATION_CONFIRMATION } = require('./statelessMigrationManager');

const MIGRATION_RUN_SCHEMA_VERSION = 1;
const START_SERVER_MIGRATION_CONFIRMATION = 'START SERVER MIGRATION';
const PLAN_ID_PATTERN = /^mplan_[a-f0-9]{32}$/;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const RUN_ID_PATTERN = /^mrun_[a-f0-9]{32}$/;
const MAX_RUNS = 50;
const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'executing']);

class MigrationRunError extends Error {
  constructor(message, statusCode = 400, code = 'migration-run-error') {
    super(message);
    this.name = 'MigrationRunError';
    this.statusCode = statusCode;
    this.code = code;
  }
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

function safeError(error, fallbackCode = 'migration-preparation-failed') {
  const suppliedCode = String(error && error.code || '');
  const code = /^[a-z0-9][a-z0-9:._-]{0,127}$/.test(suppliedCode) ? suppliedCode : fallbackCode;
  return {
    code,
    message: fallbackCode === 'migration-execution-failed'
      ? 'Kaynak işlemi güvenli biçimde tamamlanamadı; geçiş sırası durduruldu.'
      : 'Geçiş hazırlığı güvenli biçimde tamamlanamadı.',
    section: 'execution',
    severity: 'blocking',
    source: 'migration-run'
  };
}

function uniqueBlockers(blockers = []) {
  const values = new Map();
  for (const blocker of blockers) {
    const normalized = {
      code: String(blocker.code || 'migration-blocked'),
      message: blocker.message || null,
      section: blocker.section || 'unknown',
      severity: 'blocking',
      source: blocker.source || 'migration-run'
    };
    values.set(normalized.source + ':' + normalized.section + ':' + normalized.code, normalized);
  }
  return Array.from(values.values()).sort((left, right) => (
    left.section.localeCompare(right.section) || left.code.localeCompare(right.code)
  ));
}

function createMigrationRunManager({
  dataRoot,
  getServerMigrationPlan,
  getLatestRegistrySnapshot,
  saveSelection,
  prepareStatelessPlan,
  getStatelessReviewStatus,
  prepareResourceEvidence = null,
  refreshServerMigrationPlan = null,
  prepareStatelessReview = null,
  executeStatelessMigration,
  issueApproval,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  schedule = (work) => setImmediate(work)
}) {
  if (
    !dataRoot || typeof getServerMigrationPlan !== 'function' ||
    typeof getLatestRegistrySnapshot !== 'function' || typeof saveSelection !== 'function' ||
    typeof prepareStatelessPlan !== 'function' || typeof getStatelessReviewStatus !== 'function' ||
    typeof executeStatelessMigration !== 'function' || typeof issueApproval !== 'function' ||
    typeof schedule !== 'function'
  ) {
    throw new Error('Migration run manager requires plan, selection, review, approval and execution adapters');
  }

  const root = path.join(dataRoot, 'migration-runs');
  const runsRoot = path.join(root, 'runs');
  const approvalContexts = new Map();

  function now() {
    return new Date(clock()).toISOString();
  }

  function runFile(runId) {
    if (!RUN_ID_PATTERN.test(String(runId || ''))) {
      throw new MigrationRunError('Invalid migration run ID', 400, 'invalid-run-id');
    }
    return path.join(runsRoot, runId + '.json');
  }

  function getRun(runId) {
    const run = readJson(runFile(runId));
    if (!run) throw new MigrationRunError('Migration run was not found', 404, 'run-not-found');
    return run;
  }

  function persist(run) {
    atomicWriteJson(runFile(run.runId), run);
    return run;
  }

  function summarize(run) {
    const resources = run.resources || [];
    return {
      selected: resources.length,
      ready: resources.filter((resource) => resource.status === 'ready').length,
      executing: resources.filter((resource) => resource.status === 'executing').length,
      completed: resources.filter((resource) => resource.status === 'completed').length,
      blocked: resources.filter((resource) => resource.status === 'blocked').length,
      failed: resources.filter((resource) => resource.status === 'failed').length,
      notStarted: resources.filter((resource) => resource.status === 'selected').length
    };
  }

  function setRunState(run, status, phase) {
    run.status = status;
    run.phase = phase;
    run.updatedAt = now();
    run.history.push({ status, phase, at: run.updatedAt });
    run.summary = summarize(run);
    persist(run);
  }

  function prune() {
    const runs = listJson(runsRoot).sort((left, right) => (
      String(left.createdAt).localeCompare(String(right.createdAt)) || left.runId.localeCompare(right.runId)
    ));
    for (const run of runs.slice(0, Math.max(0, runs.length - MAX_RUNS))) {
      if (!ACTIVE_STATUSES.has(run.status)) fs.unlinkSync(runFile(run.runId));
    }
  }

  function activeRun() {
    return listJson(runsRoot).find((run) => ACTIVE_STATUSES.has(run.status)) || null;
  }

  function explicitExecutionOrder(plan, selectedResourceIds) {
    const selected = new Set(selectedResourceIds);
    const resources = new Map((plan.resources || [])
      .filter((resource) => selected.has(resource.resourceId))
      .map((resource) => [resource.resourceId, resource]));
    const dependencies = new Map();
    const blockers = [];
    for (const resource of resources.values()) {
      const required = new Set();
      for (const dependency of resource.dependencies || []) {
        if (dependency.required !== true) continue;
        for (const resourceId of dependency.resourceIds || []) {
          if (resourceId !== resource.resourceId) required.add(resourceId);
        }
      }
      for (const resourceId of required) {
        if (!selected.has(resourceId)) {
          blockers.push({
            code: 'required-dependency-not-selected',
            message: `${resource.name} için gerekli bağımlılık seçilmedi.`,
            section: 'dependencies',
            severity: 'blocking',
            source: 'migration-run'
          });
        }
      }
      dependencies.set(resource.resourceId, new Set([...required].filter((resourceId) => selected.has(resourceId))));
    }
    if (blockers.length) return { order: [], blockers: uniqueBlockers(blockers) };

    const remaining = new Set(selectedResourceIds);
    const order = [];
    while (remaining.size) {
      const ready = [...remaining].filter((resourceId) => (
        [...(dependencies.get(resourceId) || [])].every((dependencyId) => !remaining.has(dependencyId))
      )).sort((left, right) => {
        const leftResource = resources.get(left);
        const rightResource = resources.get(right);
        return String(leftResource && leftResource.name).localeCompare(String(rightResource && rightResource.name)) ||
          left.localeCompare(right);
      });
      if (!ready.length) {
        return {
          order: [],
          blockers: [{
            code: 'required-dependency-cycle',
            message: 'Seçilen kaynakların açık bağımlılıklarında döngü bulundu.',
            section: 'dependencies',
            severity: 'blocking',
            source: 'migration-run'
          }]
        };
      }
      for (const resourceId of ready) {
        remaining.delete(resourceId);
        order.push(resourceId);
      }
    }
    return { order, blockers: [] };
  }

  function markInterruptedRuns() {
    for (const run of listJson(runsRoot)) {
      if (!ACTIVE_STATUSES.has(run.status)) continue;
      run.status = run.status === 'executing' ? 'interrupted-recovery-required' : 'interrupted-before-execution';
      run.phase = run.status === 'interrupted-recovery-required' ? 'recovery-required' : 'interrupted';
      run.updatedAt = now();
      run.completedAt = run.updatedAt;
      run.history.push({ status: run.status, phase: run.phase, at: run.updatedAt });
      run.summary = summarize(run);
      persist(run);
    }
  }

  markInterruptedRuns();

  async function process(runId) {
    const run = getRun(runId);
    const context = approvalContexts.get(runId);
    try {
      const latestSnapshot = getLatestRegistrySnapshot();
      if (!latestSnapshot || latestSnapshot.snapshotId !== run.sourceSnapshotId) {
        run.blockers = [{
          code: 'migration-snapshot-stale',
          message: 'Sunucu envanteri değişti; geçiş başlamadan önce yeniden tarama gerekli.',
          section: 'inventory',
          severity: 'blocking',
          source: 'migration-run'
        }];
        run.completedAt = now();
        setRunState(run, 'blocked', 'preflight-blocked');
        prune();
        return run;
      }

      setRunState(run, 'preparing', 'immutable-preflight');
      let serverPlanId = run.serverPlanId;
      if (prepareResourceEvidence || refreshServerMigrationPlan) {
        if (typeof prepareResourceEvidence !== 'function' || typeof refreshServerMigrationPlan !== 'function') {
          throw new MigrationRunError(
            'Migration evidence preparation is configured incompletely',
            500,
            'evidence-preparation-adapter-incomplete'
          );
        }
        setRunState(run, 'preparing', 'server-owned-evidence-capture');
        await prepareResourceEvidence(run.executionOrder);
        const refreshedPlan = refreshServerMigrationPlan();
        if (!refreshedPlan || refreshedPlan.sourceSnapshotId !== run.sourceSnapshotId) {
          throw new MigrationRunError(
            'Server inventory changed while migration evidence was captured',
            409,
            'migration-snapshot-stale'
          );
        }
        const refreshedIds = new Set((refreshedPlan.resources || []).map((resource) => resource.resourceId));
        if (run.executionOrder.some((resourceId) => !refreshedIds.has(resourceId))) {
          throw new MigrationRunError(
            'A selected resource disappeared while migration evidence was captured',
            409,
            'resource-not-in-refreshed-plan'
          );
        }
        serverPlanId = refreshedPlan.planId;
        run.serverPlanId = refreshedPlan.planId;
        run.selectionId = saveSelection({
          serverPlanId: refreshedPlan.planId,
          resourceIds: run.executionOrder,
          confirmation: SAVE_MIGRATION_SELECTION_CONFIRMATION
        }).selectionId;
        run.updatedAt = now();
        persist(run);
      }
      const preparedPlans = new Map();
      let anyBlocked = false;
      for (const resourceId of run.executionOrder) {
        const result = run.resources.find((resource) => resource.resourceId === resourceId);
        try {
          const plan = prepareStatelessPlan({
            serverPlanId,
            resourceId,
            confirmation: PREPARE_STATELESS_MIGRATION_CONFIRMATION
          });
          result.statelessPlanId = plan.planId;
          result.blockers = uniqueBlockers(plan.readiness && plan.readiness.blockers || []);
          if (!result.blockers.length) {
            let review = getStatelessReviewStatus(plan.planId);
            if (
              typeof prepareStatelessReview === 'function' &&
              (review.stale || review.state !== 'complete' || !review.current || review.current.reviewComplete !== true)
            ) {
              prepareStatelessReview(plan);
              review = getStatelessReviewStatus(plan.planId);
            }
            if (review.stale || review.state !== 'complete' || !review.current || review.current.reviewComplete !== true) {
              result.blockers = uniqueBlockers([
                ...(review.current && review.current.reviewBlockers || []),
                {
                  code: 'stateless-configuration-not-ready',
                  message: 'Geçiş sözleşmesinin sağlık, çalışma ve rota ayarları henüz tamamlanmadı.',
                  section: 'review',
                  severity: 'blocking',
                  source: 'migration-run'
                }
              ]);
            }
          }
          if (result.blockers.length) {
            result.status = 'blocked';
            anyBlocked = true;
          } else {
            result.status = 'ready';
            preparedPlans.set(resourceId, plan);
          }
        } catch (error) {
          result.status = 'blocked';
          result.blockers = [safeError(error)];
          anyBlocked = true;
        }
        result.updatedAt = now();
        run.summary = summarize(run);
        persist(run);
      }

      if (anyBlocked) {
        run.blockers = uniqueBlockers(run.resources.flatMap((resource) => resource.blockers || []));
        run.completedAt = now();
        setRunState(run, 'blocked', 'preflight-blocked');
        prune();
        return run;
      }

      setRunState(run, 'executing', 'serial-execution');
      for (const resourceId of run.executionOrder) {
        const result = run.resources.find((resource) => resource.resourceId === resourceId);
        const plan = preparedPlans.get(resourceId);
        result.status = 'executing';
        result.updatedAt = now();
        run.summary = summarize(run);
        persist(run);
        try {
          const approval = issueApproval({
            kind: 'stateless-migration-apply',
            planId: plan.planId,
            resourceId,
            evidenceFingerprint: plan.resource.evidenceFingerprint,
            actor: context
          });
          const operation = await executeStatelessMigration(plan.planId, approval);
          if (!operation || operation.status !== 'traffic-on-foxos-source-preserved') {
            throw new MigrationRunError('Stateless migration did not reach verified FoxOS traffic', 500, 'execution-proof-incomplete');
          }
          result.status = 'completed';
          result.operationId = operation.operationId;
          result.completedAt = now();
        } catch (error) {
          result.status = 'failed';
          result.blockers = [safeError(error, 'migration-execution-failed')];
          result.completedAt = now();
          run.error = result.blockers[0];
          run.completedAt = now();
          setRunState(run, 'failed', 'execution-stopped');
          prune();
          return run;
        }
        run.summary = summarize(run);
        persist(run);
      }
      run.completedAt = now();
      setRunState(run, 'completed', 'complete');
      prune();
      return run;
    } finally {
      approvalContexts.delete(runId);
    }
  }

  function start(input = {}, actor = {}) {
    if (input.confirmation !== START_SERVER_MIGRATION_CONFIRMATION) {
      throw new MigrationRunError('Exact server migration start confirmation is required', 400, 'confirmation-required');
    }
    if (!PLAN_ID_PATTERN.test(String(input.serverPlanId || ''))) {
      throw new MigrationRunError('Invalid server migration plan ID', 400, 'invalid-plan-id');
    }
    if (!Array.isArray(input.resourceIds) || input.resourceIds.length === 0) {
      throw new MigrationRunError('Select at least one resource before starting migration', 400, 'empty-selection');
    }
    const selectedResourceIds = Array.from(new Set(input.resourceIds.map(String))).sort();
    if (selectedResourceIds.some((resourceId) => !RESOURCE_ID_PATTERN.test(resourceId))) {
      throw new MigrationRunError('Invalid resource ID', 400, 'invalid-resource-id');
    }
    if (!actor || actor.type !== 'foxos-session' || !actor.sessionToken) {
      throw new MigrationRunError('Authenticated FoxOS UI session is required', 401, 'ui-session-required');
    }
    const existing = activeRun();
    if (existing) throw new MigrationRunError('Another migration run is already active', 409, 'run-in-progress');

    const plan = getServerMigrationPlan(input.serverPlanId);
    if (!plan || plan.planId !== input.serverPlanId) {
      throw new MigrationRunError('Server migration plan identity is invalid', 409, 'server-plan-invalid');
    }
    const latestSnapshot = getLatestRegistrySnapshot();
    if (!latestSnapshot || plan.sourceSnapshotId !== latestSnapshot.snapshotId) {
      throw new MigrationRunError('The server inventory changed; scan again before migration', 409, 'stale-server-plan');
    }
    const planResources = new Map((plan.resources || []).map((resource) => [resource.resourceId, resource]));
    const selectedResources = selectedResourceIds.map((resourceId) => {
      const resource = planResources.get(resourceId);
      if (!resource) throw new MigrationRunError('A selected resource is outside this server plan', 409, 'resource-not-in-plan');
      if (!isReviewSelectable(resource)) {
        throw new MigrationRunError('A selected resource cannot enter automatic migration preparation', 409, 'resource-not-selectable');
      }
      return resource;
    });
    const ordered = explicitExecutionOrder(plan, selectedResourceIds);
    if (ordered.blockers.length) {
      throw new MigrationRunError(ordered.blockers[0].message, 409, ordered.blockers[0].code);
    }

    const selection = saveSelection({
      serverPlanId: plan.planId,
      resourceIds: selectedResourceIds,
      confirmation: SAVE_MIGRATION_SELECTION_CONFIRMATION
    });
    const runId = 'mrun_' + randomUUID().replace(/-/g, '');
    const createdAt = now();
    const run = {
      schemaVersion: MIGRATION_RUN_SCHEMA_VERSION,
      mode: 'server-migration-run',
      runId,
      serverPlanId: plan.planId,
      selectionId: selection.selectionId,
      sourceSnapshotId: plan.sourceSnapshotId,
      status: 'queued',
      phase: 'queued',
      executionOrder: ordered.order,
      resources: selectedResources.map((resource) => ({
        resourceId: resource.resourceId,
        name: resource.name,
        strategy: resource.strategy,
        status: 'selected',
        statelessPlanId: null,
        operationId: null,
        blockers: []
      })),
      blockers: [],
      summary: null,
      actor: {
        type: 'foxos-session',
        username: actor.username || null,
        sessionFingerprint: crypto.createHash('sha256').update(actor.sessionToken).digest('hex').slice(0, 16)
      },
      approval: {
        source: 'foxos-ui',
        issuedJustInTime: true,
        oneTimePerResource: true,
        rawTokensPersisted: false
      },
      guarantees: {
        exactSelectionPersistedInternally: true,
        snapshotRevalidatedBeforeExecution: true,
        allResourcesPreflightedBeforeMutation: true,
        serialExecution: true,
        zeroDowntimeRequired: true,
        automaticRollbackDelegatedToTransaction: true,
        sourceStopAllowed: false,
        providerDetachIncluded: false,
        destructiveCleanupIncluded: false,
        browserStorageIsAuthority: false
      },
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      history: [{ status: 'queued', phase: 'queued', at: createdAt }]
    };
    run.summary = summarize(run);
    persist(run);
    approvalContexts.set(runId, {
      type: 'foxos-session',
      username: actor.username || null,
      sessionToken: actor.sessionToken
    });
    schedule(async () => {
      try {
        await process(runId);
      } catch (error) {
        const current = getRun(runId);
        current.error = safeError(error, 'migration-run-failed');
        current.completedAt = now();
        setRunState(current, 'failed', 'run-failed');
        approvalContexts.delete(runId);
      }
    });
    return run;
  }

  function status() {
    const runs = listJson(runsRoot).sort((left, right) => (
      String(left.createdAt).localeCompare(String(right.createdAt)) || left.runId.localeCompare(right.runId)
    ));
    return {
      schemaVersion: MIGRATION_RUN_SCHEMA_VERSION,
      mode: 'server-migration-runs',
      latest: runs.length ? runs[runs.length - 1] : null,
      runs,
      summary: {
        runs: runs.length,
        active: runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length,
        blocked: runs.filter((run) => run.status === 'blocked').length,
        completed: runs.filter((run) => run.status === 'completed').length
      },
      guarantees: {
        startActionPersistsSelectionInternally: true,
        separateSaveActionRequired: false,
        serialExecution: true,
        allResourcesPreflightedBeforeMutation: true,
        rawApprovalTokensPersisted: false
      }
    };
  }

  return { getRun, paths: { root, runsRoot }, process, start, status };
}

module.exports = {
  ACTIVE_STATUSES,
  MIGRATION_RUN_SCHEMA_VERSION,
  MigrationRunError,
  START_SERVER_MIGRATION_CONFIRMATION,
  createMigrationRunManager
};
