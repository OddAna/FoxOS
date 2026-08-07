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
  if (classification.authorityClass === 'server-owned') return 'already-server-owned';
  if (classification.authorityClass === 'foxos-owned') return 'already-foxos-managed';
  if (resource.kind === 'provider-definition') return 'provider-definition-recovery';
  if (classification.workloadRole === 'network-service') return 'host-network-service-adoption';
  if (resource.kind === 'host-service') return 'host-service-adoption';
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

function availabilityPolicy(resource, strategy, applyImplemented = false) {
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
  if (strategy === 'already-foxos-managed' || strategy === 'already-server-owned') {
    return {
      currentMode: 'already-managed',
      targetMode: 'preserve-current-availability',
      sourcePauseBudgetMs: null,
      explicitApprovalRequired: false,
      postRoadmapCapability: null
    };
  }
  if (strategy === 'migrate-with-parent') {
    return {
      currentMode: 'included-with-parent',
      targetMode: 'migrate-as-one-resource-group',
      sourcePauseBudgetMs: null,
      explicitApprovalRequired: false,
      postRoadmapCapability: null
    };
  }
  if (strategy === 'provider-control-plane-retirement-last') {
    return {
      currentMode: 'provider-retirement-pending',
      targetMode: 'remove-after-independent-workloads',
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
      currentMode: applyImplemented ? 'bounded-quiesce-ready' : 'bounded-quiesce-budget-required',
      targetMode: 'bounded-quiesce',
      sourcePauseBudgetMs: applyImplemented ? 120000 : null,
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
  if (classification.stateClass === 'host-configured') {
    return {
      currentMode: 'host-service-continuity-required',
      targetMode: 'reconcile-host-service-with-rollback',
      sourcePauseBudgetMs: 0,
      explicitApprovalRequired: true,
      postRoadmapCapability: null
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

function implementationGaps(resource, strategy, conflicts, applyImplemented = false) {
  if (
    strategy === 'protected-skip' || strategy === 'already-foxos-managed' ||
    strategy === 'already-server-owned'
  ) return [];
  if (applyImplemented) {
    return uniqueBlockers(conflicts.filter((entry) => entry.severity === 'blocking').map((conflict) => blocker(
      'blocking-resource-conflict:' + conflict.type,
      'conflicts',
      'A blocking observed resource conflict must be resolved before apply.'
    )));
  }
  const gaps = [blocker(
    'migration-apply-transaction-not-implemented',
    'apply',
    'This resource class has no runtime apply transaction yet.'
  )];
  if ((resource.routes || []).length || (resource.declaredRoutes || []).length) {
    gaps.push(blocker(
      'general-domain-route-cutover-not-implemented',
      'routes',
      'Arbitrary production domain, route and TLS authority cutover is not implemented.'
    ));
  }
  if (strategy === 'provider-definition-recovery') {
    gaps.push(blocker(
      'provider-definition-runtime-recovery-required',
      'runtime',
      'The inactive provider definition must be reconstructed into a provider-neutral runtime manifest before migration.'
    ));
  } else if (strategy === 'host-network-service-adoption') {
    gaps.push(blocker(
      'host-network-service-adoption-not-implemented',
      'runtime',
      'Host network configuration, encrypted key custody and exact rollback must be implemented before adoption.'
    ));
  } else if (strategy === 'host-service-adoption') {
    gaps.push(blocker(
      'host-service-adoption-not-implemented',
      'runtime',
      'The systemd unit and its configuration must be captured into a provider-neutral manifest with rollback proof.'
    ));
  } else if (strategy === 'blue-green-atomic-route') {
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

  function managedDefinitionProjection(currentSnapshot, resource) {
    if (!resource || resource.kind !== 'provider-definition') return null;
    const definitionDomains = new Set((resource.declaredRoutes || [])
      .map((route) => String(route && route.domain || '').toLowerCase())
      .filter(Boolean));
    if (!definitionDomains.size) return null;
    const matches = (currentSnapshot.resources || []).filter((candidate) => (
      candidate && candidate.management && candidate.management.owner === 'foxos' &&
      [
        ...(candidate.routes || []).map((route) => route && route.domain),
        ...(candidate.declaredRoutes || []).map((route) => route && route.domain),
        ...(candidate.management.domains || [])
      ].some((domain) => definitionDomains.has(String(domain || '').toLowerCase()))
    ));
    if (!matches.length) return null;
    return matches.sort((left, right) => left.id.localeCompare(right.id))[0];
  }

  function providerControlPlane(resource) {
    const name = String(resource && resource.name || '').toLowerCase();
    const project = String(resource && resource.provenance && resource.provenance.project || '').toLowerCase();
    return Boolean(
      /^coolify(?:-|$)/.test(name) &&
      (project === 'source' || ['coolify-proxy', 'coolify-sentinel'].includes(name))
    );
  }

  function providerResourceGroup(currentSnapshot, resource) {
    const labels = resource && resource.provenance && resource.provenance.safeLabels || {};
    const providerResourceName = String(labels['coolify.resourceName'] || '');
    if (!providerResourceName) return null;
    const members = (currentSnapshot.resources || []).filter((candidate) => {
      const candidateLabels = candidate && candidate.provenance && candidate.provenance.safeLabels || {};
      return candidate.kind === 'container' &&
        String(candidateLabels['coolify.resourceName'] || '') === providerResourceName;
    });
    if (members.length < 2) return null;
    const primaries = members.filter((candidate) => (
      candidate.classification && candidate.classification.workloadRole === 'application' &&
      ((candidate.routes || []).length > 0 || (candidate.ports || []).some((port) => port.hostPort))
    )).sort((left, right) => left.id.localeCompare(right.id));
    if (primaries.length !== 1) return null;
    return {
      parentResourceId: primaries[0].id,
      memberResourceIds: members.map((candidate) => candidate.id).sort()
    };
  }

  function planResource(currentSnapshot, resource) {
    const managedDefinition = managedDefinitionProjection(currentSnapshot, resource);
    const controlPlane = providerControlPlane(resource);
    const providerGroup = providerResourceGroup(currentSnapshot, resource);
    const groupedWithParent = Boolean(
      providerGroup && providerGroup.parentResourceId !== resource.id
    );
    const effectiveManagement = resource.management || managedDefinition && {
      ...managedDefinition.management,
      canonicalResourceId: managedDefinition.management.logicalResourceId || managedDefinition.id,
      inactiveDefinitionResourceId: resource.id
    } || null;
    const foxosManaged = Boolean(effectiveManagement && effectiveManagement.owner === 'foxos');
    const classification = managedDefinition && resource.classification
      ? { ...resource.classification, authorityClass: 'foxos-owned' }
      : resource.classification || null;
    const strategy = controlPlane
      ? 'provider-control-plane-retirement-last'
      : groupedWithParent
        ? 'migrate-with-parent'
        : managedDefinition ? 'already-foxos-managed' : migrationStrategy(resource);
    const migrationRequired = Boolean(
      !resource.protected && !foxosManaged && !controlPlane && !groupedWithParent &&
      classification && classification.authorityClass === 'provider-owned'
    );
    const statelessReviewEligible = Boolean(
      resource.kind === 'container' &&
      migrationRequired && strategy === 'blue-green-atomic-route' &&
      classification && classification.independenceAudit &&
      classification.independenceAudit.eligibleForReadOnlyAudit === true
    );
    const statefulAdapterEligible = Boolean(
      resource.kind === 'container' && migrationRequired &&
      strategy === 'shadow-refresh-bounded-quiesce' &&
      (!providerGroup || providerGroup.memberResourceIds.length === 1) &&
      resource.runtime && resource.runtime.state === 'running' && resource.runtime.inspection === 'complete' &&
      classification && classification.workloadRole === 'application' &&
      classification.stateClass === 'stateful' &&
      Array.isArray(resource.routes) && resource.routes.length > 0 &&
      Array.isArray(resource.mounts) && resource.mounts.length >= 1 && resource.mounts.length <= 4 &&
      resource.mounts.every((mount) => (
        mount.type === 'volume' && mount.name && mount.destination && mount.readOnly !== true
      ))
    );
    const statefulStorageReady = Boolean(
      !resource.migrationStorage || resource.migrationStorage.status === 'ready'
    );
    const statefulReviewEligible = statefulAdapterEligible && statefulStorageReady;
    const providerDefinitionArtifact = resource.provenance && resource.provenance.externalDefinition &&
      resource.provenance.externalDefinition.recoveryArtifact;
    const providerDefinitionReady = Boolean(
      resource.kind === 'provider-definition' && providerDefinitionArtifact &&
      providerDefinitionArtifact.encrypted === true && providerDefinitionArtifact.authenticated === true &&
      providerDefinitionArtifact.plaintextSecretValuesIncluded === false
    );
    const runtimeTransferEligible = Boolean(
      migrationRequired && (
        providerDefinitionReady ||
        resource.kind === 'container' && resource.runtime &&
        resource.runtime.state === 'running' && resource.runtime.inspection === 'complete' &&
        (
          strategy === 'shadow-refresh-bounded-quiesce' ||
          strategy === 'database-aware-replication-handoff' ||
          strategy === 'drain-and-replace' ||
          providerGroup && providerGroup.parentResourceId === resource.id
        )
      )
    );
    const executionAdapter = statelessReviewEligible
      ? 'stateless-blue-green'
      : statefulReviewEligible
        ? 'stateful-copy'
        : runtimeTransferEligible
          ? 'runtime-transfer'
          : null;
    const reviewEligible = statelessReviewEligible || statefulReviewEligible || runtimeTransferEligible;
    const applyImplemented = Boolean(executionAdapter);
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
    if (!migrationRequired) {
      // Server-owned host services and completed canonical migrations require no import manifest.
    } else if (resource.kind !== 'container') {
      compileFailure = blocker(
        resource.kind === 'provider-definition'
          ? 'provider-definition-runtime-evidence-missing'
          : 'host-service-manifest-missing',
        'manifest',
        resource.kind === 'provider-definition'
          ? 'The inactive definition has no inspected runtime evidence yet.'
          : 'The host service has no server-owned manifest and recovery revision yet.'
      );
    } else {
      try {
        manifest = compileApplicationManifest(resource.id);
      } catch (error) {
        compileFailure = blocker(
          'application-manifest-compilation-failed:' + (error.code || 'unknown'),
          'manifest',
          'The provider-neutral application manifest could not be compiled.'
        );
      }
    }

    const manifestBlockers = migrationRequired && manifest && manifest.gates && manifest.gates.blockers || [];
    const transactionAcquiredBlockers = strategy === 'blue-green-atomic-route'
      ? uniqueBlockers(manifestBlockers.filter((entry) => (
        TRANSACTION_PROVEN_MANIFEST_BLOCKERS.has(entry.code)
      )).map((entry) => ({ ...entry, source: 'stateless-transaction' })))
      : executionAdapter === 'runtime-transfer'
        ? uniqueBlockers(manifestBlockers.map((entry) => ({ ...entry, source: 'runtime-transfer' })))
        : [];
    const authorityBlockers = uniqueBlockers(manifestBlockers.filter((entry) => (
      entry.code === 'external-provider-authority'
    )).map((entry) => ({ ...entry, source: 'application-manifest' })));
    const evidenceBlockers = migrationRequired && executionAdapter !== 'runtime-transfer' ? uniqueBlockers([
      ...manifestBlockers.filter((entry) => (
        entry.code !== 'external-provider-authority' &&
        !(strategy === 'blue-green-atomic-route' && TRANSACTION_PROVEN_MANIFEST_BLOCKERS.has(entry.code))
      ))
        .map((entry) => ({ ...entry, source: 'application-manifest' })),
      ...(compileFailure ? [compileFailure] : [])
    ]) : [];
    const gaps = migrationRequired ? implementationGaps(resource, strategy, conflicts, applyImplemented) : [];
    if (
      migrationRequired && strategy === 'shadow-refresh-bounded-quiesce' &&
      statefulAdapterEligible && executionAdapter !== 'runtime-transfer' &&
      resource.migrationStorage && resource.migrationStorage.status !== 'ready'
    ) {
      gaps.push(blocker(
        resource.migrationStorage.blockerCode || 'stateful-capacity-inspection-failed',
        'storage',
        'The source volume does not satisfy the direct bounded-pause migration storage gate.'
      ));
    }
    if (
      migrationRequired && providerGroup && providerGroup.parentResourceId === resource.id &&
      providerGroup.memberResourceIds.length > 1 && executionAdapter !== 'runtime-transfer'
    ) {
      gaps.push(blocker(
        'provider-resource-group-transaction-required',
        'dependencies',
        'The application and every provider-group companion must migrate in one verified transaction.'
      ));
    }
    const evidenceComplete = migrationRequired && evidenceBlockers.length === 0;
    const planningStatus = resource.protected
      ? 'protected-skip'
      : controlPlane
        ? 'provider-retirement-pending'
        : groupedWithParent
          ? 'included-with-parent'
      : !migrationRequired
        ? strategy === 'already-server-owned' ? 'already-server-owned' : 'already-foxos-managed'
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
      currentProvider: foxosManaged ? 'foxos' : classification && classification.authorityClass === 'server-owned'
        ? 'server' : resource.provider,
      currentAuthorityClass: foxosManaged ? 'foxos-owned' : classification && classification.authorityClass || null,
      management: effectiveManagement,
      protected: Boolean(resource.protected),
      migrationRequired,
      targetLifecycle: migrationRequired ? 'independent' : foxosManaged ? 'foxos-managed'
        : strategy === 'already-server-owned' ? 'server-managed'
          : groupedWithParent ? 'independent-with-parent'
            : controlPlane ? 'retire-after-independent-workloads' : resource.ownership,
      canonicalResourceId: managedDefinition
        ? managedDefinition.management.logicalResourceId || managedDefinition.id
        : null,
      parentResourceId: groupedWithParent ? providerGroup.parentResourceId : null,
      migrationGroup: providerGroup && providerGroup.parentResourceId === resource.id
        ? { ...providerGroup, executionOwnedByParent: true }
        : null,
      executionAdapter,
      classification,
      strategy,
      availability: {
        ...(executionAdapter === 'runtime-transfer' ? {
          currentMode: 'in-place-runtime-transfer-ready',
          targetMode: 'server-authority-with-existing-runtime',
          sourcePauseBudgetMs: 0,
          explicitApprovalRequired: true,
          postRoadmapCapability: 'provider-definition-removal-after-control-plane-retirement'
        } : availabilityPolicy(resource, strategy, applyImplemented)),
        ...(executionAdapter !== 'runtime-transfer' && strategy === 'shadow-refresh-bounded-quiesce' &&
          resource.migrationStorage && resource.migrationStorage.status !== 'ready'
          ? { currentMode: resource.migrationStorage?.blockerCode || 'stateful-capacity-inspection-failed' }
          : {})
      },
      evidence: {
        registrySnapshotId: currentSnapshot.snapshotId,
        manifestRevisionId: manifest && manifest.revisionId || null,
        manifestGateStatus: manifest && manifest.gates && manifest.gates.status || 'unavailable',
        sourceType: manifest && manifest.desired && manifest.desired.source && manifest.desired.source.type || null,
        routeCount: (resource.routes || []).length + (resource.declaredRoutes || []).length,
        mountCount: (resource.mounts || []).length,
        migrationStorage: resource.migrationStorage || null,
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
        implementation: uniqueBlockers(gaps)
      },
      readiness: {
        planningStatus,
        reviewEligible,
        evidenceComplete,
        applyImplemented,
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
      alreadyServerOwned: resources.filter((resource) => (
        resource.readiness.planningStatus === 'already-server-owned'
      )).length,
      includedWithParent: resources.filter((resource) => (
        resource.readiness.planningStatus === 'included-with-parent'
      )).length,
      providerRetirementPending: resources.filter((resource) => (
        resource.readiness.planningStatus === 'provider-retirement-pending'
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
      applyImplemented: migrationResources.filter((resource) => resource.readiness.applyImplemented).length,
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
        applyImplemented: summary.applyImplemented > 0,
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
    const latest = plans.length ? plans[plans.length - 1] : null;
    return {
      schemaVersion: MIGRATION_ORCHESTRATOR_SCHEMA_VERSION,
      mode: 'read-only-server-migration-plan',
      latest,
      plans,
      summary: { plans: plans.length },
      guarantees: {
        runtimeMutated: false,
        routesMutated: false,
        providerStateMutated: false,
        providerDetached: false,
        applyImplemented: Boolean(latest && latest.summary && latest.summary.applyImplemented > 0),
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
