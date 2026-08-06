const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('./applicationManifestManager');
const { TRANSACTION_PROVEN_MANIFEST_BLOCKERS } = require('./statelessMigrationManifestCompiler');
const { atomicWriteJson } = require('./resourceRegistry');

const MIGRATION_ORCHESTRATOR_SCHEMA_VERSION = 1;
const PLAN_SERVER_MIGRATION_CONFIRMATION = 'PLAN SERVER MIGRATION';
const PLAN_ID_PATTERN = /^mplan_[a-f0-9]{32}$/;
const MAX_PLANS = 50;

class MigrationOrchestratorError extends Error {
  constructor(message, statusCode = 400, code = 'migration-orchestrator-error') {
    super(message);
    this.name = 'MigrationOrchestratorError';
    this.statusCode = statusCode;
    this.code = code;
  }
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

function prune(directory) {
  const plans = listJson(directory).sort((left, right) => (
    String(left.createdAt).localeCompare(String(right.createdAt)) || left.planId.localeCompare(right.planId)
  ));
  for (const plan of plans.slice(0, Math.max(0, plans.length - MAX_PLANS))) {
    fs.unlinkSync(path.join(directory, plan.planId + '.json'));
  }
}

function blocker(code, section, message, source = 'orchestrator') {
  return { code, section, severity: 'blocking', source, message };
}

function uniqueBlockers(values) {
  const byKey = new Map();
  for (const value of values) {
    const normalized = {
      code: value.code,
      section: value.section || 'unknown',
      severity: value.severity || 'blocking',
      source: value.source || 'application-manifest',
      message: value.message || null
    };
    byKey.set(normalized.source + ':' + normalized.section + ':' + normalized.code, normalized);
  }
  return Array.from(byKey.values()).sort((left, right) => (
    left.section.localeCompare(right.section) || left.code.localeCompare(right.code)
  ));
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function migrationStrategy(resource) {
  const classification = resource.classification || {};
  if (resource.protected) return 'protected-skip';
  if (resource.management && resource.management.owner === 'foxos') return 'already-foxos-managed';
  if (classification.authorityClass === 'foxos-owned') return 'already-foxos-managed';
  if (classification.status !== 'classified') return 'manual-review-required';
  if (classification.workloadRole === 'proxy') return 'provider-proxy-retirement-last';
  if (classification.workloadRole === 'database' || classification.stateClass === 'database') {
    return 'database-aware-replication-handoff';
  }
  if (['worker', 'agent'].includes(classification.workloadRole)) return 'drain-and-replace';
  if (!['application', 'internal-service'].includes(classification.workloadRole)) {
    return 'dedicated-lifecycle-required';
  }
  if (classification.stateClass === 'stateless') return 'blue-green-atomic-route';
  if (classification.stateClass === 'stateful') return 'shadow-refresh-bounded-quiesce';
  return 'manual-review-required';
}

function availabilityPolicy(resource, strategy) {
  const classification = resource.classification || {};
  if (strategy === 'protected-skip') {
    return {
      currentMode: 'not-applicable',
      targetMode: 'not-applicable',
      sourcePauseBudgetMs: null,
      explicitApprovalRequired: false,
      postRoadmapCapability: null
    };
  }
  if (strategy === 'already-foxos-managed') {
    return {
      currentMode: 'already-managed',
      targetMode: 'preserve-current-availability',
      sourcePauseBudgetMs: null,
      explicitApprovalRequired: false,
      postRoadmapCapability: null
    };
  }
  if (classification.stateClass === 'stateless') {
    return {
      currentMode: 'zero-downtime-required',
      targetMode: 'zero-downtime',
      sourcePauseBudgetMs: 0,
      explicitApprovalRequired: true,
      postRoadmapCapability: null
    };
  }
  if (classification.stateClass === 'stateful') {
    return {
      currentMode: 'bounded-quiesce-budget-required',
      targetMode: 'bounded-quiesce',
      sourcePauseBudgetMs: null,
      explicitApprovalRequired: true,
      postRoadmapCapability: 'stateful-zero-downtime-continuous-sync-or-application-replication'
    };
  }
  if (classification.stateClass === 'database') {
    return {
      currentMode: 'database-aware-handoff-required',
      targetMode: 'engine-consistent-handoff',
      sourcePauseBudgetMs: null,
      explicitApprovalRequired: true,
      postRoadmapCapability: 'database-zero-downtime-replication-and-primary-handoff'
    };
  }
  return {
    currentMode: 'unknown-blocked',
    targetMode: 'manual-review-required',
    sourcePauseBudgetMs: null,
    explicitApprovalRequired: true,
    postRoadmapCapability: null
  };
}

function relationshipResourceIds(relationship) {
  return Array.from(new Set([
    ...(relationship.resourceIds || []),
    relationship.sourceResourceId,
    relationship.targetResourceId
  ].filter(Boolean))).sort();
}

function implementationGaps(resource, strategy, conflicts) {
  if (strategy === 'protected-skip' || strategy === 'already-foxos-managed') return [];
  const gaps = [blocker(
    'migration-apply-transaction-not-implemented',
    'apply',
    'This orchestrator version plans migrations but has no runtime apply transaction.'
  )];
  if ((resource.routes || []).length) {
    gaps.push(blocker(
      'general-domain-route-cutover-not-implemented',
      'routes',
      'Arbitrary production domain, route and TLS authority cutover is not implemented.'
    ));
  }
  if (strategy === 'blue-green-atomic-route') {
    gaps.push(blocker(
      'zero-downtime-blue-green-apply-not-implemented',
      'availability',
      'The required zero-downtime blue/green apply transaction is not implemented.'
    ));
  } else if (strategy === 'shadow-refresh-bounded-quiesce') {
    gaps.push(blocker(
      'stateful-cutover-pause-budget-unset',
      'availability',
      'A real stateful cutover must declare and enforce an approved maximum pause budget.'
    ));
  } else if (strategy === 'database-aware-replication-handoff') {
    gaps.push(blocker(
      'database-aware-handoff-not-implemented',
      'availability',
      'Database-consistent replication and controlled primary handoff are not implemented.'
    ));
  } else if (strategy === 'drain-and-replace') {
    gaps.push(blocker(
      'worker-drain-policy-not-implemented',
      'runtime',
      'Queue ownership, drain and in-flight work recovery policy are not implemented.'
    ));
  } else if (strategy === 'provider-proxy-retirement-last') {
    gaps.push(blocker(
      'provider-proxy-retirement-gate-open',
      'routes',
      'The provider proxy must remain until every dependent production route is independently verified.'
    ));
  } else {
    gaps.push(blocker(
      'resource-class-migration-policy-missing',
      'classification',
      'This resource class has no reviewed migration lifecycle policy.'
    ));
  }
  for (const conflict of conflicts.filter((entry) => entry.severity === 'blocking')) {
    gaps.push(blocker(
      'blocking-resource-conflict:' + conflict.type,
      'conflicts',
      'A blocking observed resource conflict must be resolved before apply.'
    ));
  }
  return uniqueBlockers(gaps);
}

function createMigrationOrchestrator({
  dataRoot,
  resourceRegistry,
  compileApplicationManifest,
  clock = () => new Date()
}) {
  if (
    !dataRoot || !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    typeof compileApplicationManifest !== 'function'
  ) {
    throw new Error('Migration orchestrator requires registry and manifest compiler adapters');
  }

  const root = path.join(dataRoot, 'migration-orchestrator');
  const plansRoot = path.join(root, 'plans');

  function snapshot() {
    const current = resourceRegistry.getLatest();
    if (!current) {
      throw new MigrationOrchestratorError(
        'Run a resource scan before planning the server migration',
        409,
        'registry-not-scanned'
      );
    }
    return current;
  }

  function getPlan(planId) {
    if (!PLAN_ID_PATTERN.test(String(planId || ''))) {
      throw new MigrationOrchestratorError('Invalid server migration plan ID', 400, 'invalid-plan-id');
    }
    const plan = readJson(path.join(plansRoot, planId + '.json'));
    if (!plan) throw new MigrationOrchestratorError('Server migration plan was not found', 404, 'plan-not-found');
    return plan;
  }

  function planResource(currentSnapshot, resource) {
    const strategy = migrationStrategy(resource);
    const classification = resource.classification || null;
    const foxosManaged = Boolean(resource.management && resource.management.owner === 'foxos');
    const migrationRequired = Boolean(
      !resource.protected && !foxosManaged && classification && classification.authorityClass === 'provider-owned'
    );
    const reviewEligible = Boolean(
      migrationRequired && strategy === 'blue-green-atomic-route' &&
      classification && classification.independenceAudit &&
      classification.independenceAudit.eligibleForReadOnlyAudit === true
    );
    const conflicts = (currentSnapshot.conflicts || []).filter((entry) => (
      (entry.resourceIds || []).includes(resource.id)
    )).map((entry) => ({
      type: entry.type,
      severity: entry.severity,
      value: entry.value,
      resourceIds: [...entry.resourceIds].sort()
    }));

    let manifest = null;
    let compileFailure = null;
    try {
      manifest = compileApplicationManifest(resource.id);
    } catch (error) {
      compileFailure = blocker(
        'application-manifest-compilation-failed:' + (error.code || 'unknown'),
        'manifest',
        'The provider-neutral application manifest could not be compiled.'
      );
    }

    const manifestBlockers = migrationRequired && manifest && manifest.gates && manifest.gates.blockers || [];
    const transactionAcquiredBlockers = strategy === 'blue-green-atomic-route'
      ? uniqueBlockers(manifestBlockers.filter((entry) => (
        TRANSACTION_PROVEN_MANIFEST_BLOCKERS.has(entry.code)
      )).map((entry) => ({ ...entry, source: 'stateless-transaction' })))
      : [];
    const authorityBlockers = uniqueBlockers(manifestBlockers.filter((entry) => (
      entry.code === 'external-provider-authority'
    )).map((entry) => ({ ...entry, source: 'application-manifest' })));
    const evidenceBlockers = uniqueBlockers([
      ...manifestBlockers.filter((entry) => (
        entry.code !== 'external-provider-authority' &&
        !(strategy === 'blue-green-atomic-route' && TRANSACTION_PROVEN_MANIFEST_BLOCKERS.has(entry.code))
      ))
        .map((entry) => ({ ...entry, source: 'application-manifest' })),
      ...(compileFailure ? [compileFailure] : [])
    ]);
    const gaps = implementationGaps(resource, strategy, conflicts);
    const evidenceComplete = migrationRequired && evidenceBlockers.length === 0;
    const planningStatus = resource.protected
      ? 'protected-skip'
      : !migrationRequired
        ? 'already-foxos-managed'
        : evidenceComplete
          ? 'evidence-complete-apply-unavailable'
          : reviewEligible
            ? 'review-eligible-evidence-incomplete'
            : 'evidence-incomplete';

    const dependencies = manifest && manifest.desired && manifest.desired.dependencies || [];
    return {
      resourceId: resource.id,
      name: resource.name,
      observedProvider: resource.provider,
      observedOwnership: resource.ownership,
      currentProvider: foxosManaged ? 'foxos' : resource.provider,
      currentAuthorityClass: foxosManaged ? 'foxos-owned' : classification && classification.authorityClass || null,
      management: resource.management || null,
      protected: Boolean(resource.protected),
      migrationRequired,
      targetLifecycle: migrationRequired ? 'independent' : foxosManaged ? 'foxos-managed' : resource.ownership,
      classification,
      strategy,
      availability: availabilityPolicy(resource, strategy),
      evidence: {
        registrySnapshotId: currentSnapshot.snapshotId,
        manifestRevisionId: manifest && manifest.revisionId || null,
        manifestGateStatus: manifest && manifest.gates && manifest.gates.status || 'unavailable',
        sourceType: manifest && manifest.desired && manifest.desired.source && manifest.desired.source.type || null,
        routeCount: (resource.routes || []).length,
        mountCount: (resource.mounts || []).length,
        environmentVariableCount: resource.runtime && resource.runtime.environmentVariableCount,
        secretValuesIncluded: false
      },
      dependencies: dependencies.map((entry) => ({
        relationshipId: entry.relationshipId || entry.id || null,
        type: entry.type,
        resourceIds: relationshipResourceIds(entry),
        required: entry.required === true,
        observed: entry.observed !== false
      })).sort((left, right) => (
        String(left.relationshipId).localeCompare(String(right.relationshipId))
      )),
      conflicts,
      blockers: {
        authority: authorityBlockers,
        evidence: evidenceBlockers,
        transaction: transactionAcquiredBlockers,
        implementation: gaps
      },
      readiness: {
        planningStatus,
        reviewEligible,
        evidenceComplete,
        applyImplemented: false,
        applyApproved: false,
        providerDetachApproved: false
      }
    };
  }

  function createPlan(input = {}) {
    if (input.confirmation !== PLAN_SERVER_MIGRATION_CONFIRMATION) {
      throw new MigrationOrchestratorError(
        'Exact server migration planning confirmation is required',
        400,
        'confirmation-required'
      );
    }
    const currentSnapshot = snapshot();
    const resources = (currentSnapshot.resources || []).map((resource) => (
      planResource(currentSnapshot, resource)
    )).sort((left, right) => left.name.localeCompare(right.name) || left.resourceId.localeCompare(right.resourceId));
    const migrationResourceIds = new Set(resources.filter((resource) => resource.migrationRequired)
      .map((resource) => resource.resourceId));
    const coordinationHints = (currentSnapshot.relationships || []).map((relationship) => ({
      relationshipId: relationship.id,
      type: relationship.type,
      value: relationship.value || null,
      resourceIds: relationshipResourceIds(relationship),
      dependencyDirectionKnown: false,
      applyOrderInferred: false
    })).filter((relationship) => (
      relationship.resourceIds.some((resourceId) => migrationResourceIds.has(resourceId))
    )).sort((left, right) => left.relationshipId.localeCompare(right.relationshipId));
    const migrationResources = resources.filter((resource) => resource.migrationRequired);
    const summary = {
      resources: resources.length,
      migrationRequired: migrationResources.length,
      alreadyFoxOSManaged: resources.filter((resource) => (
        resource.readiness.planningStatus === 'already-foxos-managed'
      )).length,
      protectedSkipped: resources.filter((resource) => (
        resource.readiness.planningStatus === 'protected-skip'
      )).length,
      evidenceComplete: migrationResources.filter((resource) => resource.readiness.evidenceComplete).length,
      evidenceIncomplete: migrationResources.filter((resource) => !resource.readiness.evidenceComplete).length,
      reviewEligible: migrationResources.filter((resource) => resource.readiness.reviewEligible).length,
      reviewEligibleEvidenceIncomplete: migrationResources.filter((resource) => (
        resource.readiness.reviewEligible && !resource.readiness.evidenceComplete
      )).length,
      applyImplemented: 0,
      byStrategy: countBy(resources, (resource) => resource.strategy),
      byAvailabilityMode: countBy(resources, (resource) => resource.availability.currentMode),
      blockingConflicts: (currentSnapshot.conflicts || []).filter((entry) => entry.severity === 'blocking').length
    };
    const core = {
      schemaVersion: MIGRATION_ORCHESTRATOR_SCHEMA_VERSION,
      mode: 'read-only-server-migration-plan',
      sourceSnapshotId: currentSnapshot.snapshotId,
      planningOrder: resources.map((resource) => resource.resourceId),
      resources,
      coordinationHints,
      summary,
      guarantees: {
        dockerRequestsMade: 0,
        runtimeMutated: false,
        routesMutated: false,
        providerStateMutated: false,
        providerDetached: false,
        applyImplemented: false,
        applyApproved: false,
        secretValuesIncluded: false,
        ordinaryEnvironmentValuesIncluded: false,
        sharedNetworkImpliesDependency: false,
        planningOrderIsExecutionOrder: false,
        zeroDowntimeStatefulPostRoadmap: true
      }
    };
    const planId = 'mplan_' + hash(canonicalJson(core));
    const target = path.join(plansRoot, planId + '.json');
    const existing = readJson(target);
    if (existing) return existing;
    const plan = {
      ...core,
      planId,
      createdAt: new Date(clock()).toISOString()
    };
    atomicWriteJson(target, plan);
    prune(plansRoot);
    return plan;
  }

  function status() {
    const plans = listJson(plansRoot).sort((left, right) => (
      String(left.createdAt).localeCompare(String(right.createdAt)) || left.planId.localeCompare(right.planId)
    ));
    return {
      schemaVersion: MIGRATION_ORCHESTRATOR_SCHEMA_VERSION,
      mode: 'read-only-server-migration-plan',
      latest: plans.length ? plans[plans.length - 1] : null,
      plans,
      summary: { plans: plans.length },
      guarantees: {
        runtimeMutated: false,
        routesMutated: false,
        providerStateMutated: false,
        providerDetached: false,
        applyImplemented: false,
        applyApproved: false,
        secretValuesIncluded: false,
        zeroDowntimeStatefulPostRoadmap: true
      }
    };
  }

  return { createPlan, getPlan, paths: { root, plansRoot }, status };
}

module.exports = {
  MIGRATION_ORCHESTRATOR_SCHEMA_VERSION,
  MigrationOrchestratorError,
  PLAN_SERVER_MIGRATION_CONFIRMATION,
  createMigrationOrchestrator,
  migrationStrategy
};
