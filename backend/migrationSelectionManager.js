const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const MIGRATION_SELECTION_SCHEMA_VERSION = 1;
const SAVE_MIGRATION_SELECTION_CONFIRMATION = 'SAVE MIGRATION SELECTION';
const PLAN_ID_PATTERN = /^mplan_[a-f0-9]{32}$/;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const MAX_SELECTED_RESOURCES = 1000;

class MigrationSelectionError extends Error {
  constructor(message, statusCode = 400, code = 'migration-selection-error') {
    super(message);
    this.name = 'MigrationSelectionError';
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

function isReviewSelectable(resource) {
  const plannedEligibility = resource && resource.readiness && resource.readiness.reviewEligible;
  const reviewEligible = plannedEligibility === true || Boolean(
    plannedEligibility === undefined &&
    resource && resource.classification && resource.classification.independenceAudit &&
    resource.classification.independenceAudit.eligibleForReadOnlyAudit === true
  );
  return Boolean(
    resource &&
    resource.migrationRequired === true &&
    resource.protected !== true &&
    resource.strategy === 'blue-green-atomic-route' &&
    reviewEligible
  );
}

function selectionGuarantees() {
  return {
    reviewOnly: true,
    runtimeMutated: false,
    routesMutated: false,
    providerStateMutated: false,
    providerDetached: false,
    sourceStopped: false,
    applyImplemented: false,
    applyApproved: false,
    secretValuesIncluded: false,
    browserStorageIsAuthority: false
  };
}

function createMigrationSelectionManager({
  dataRoot,
  getServerMigrationPlan,
  getLatestRegistrySnapshot,
  clock = () => new Date()
}) {
  if (
    !dataRoot || typeof getServerMigrationPlan !== 'function' ||
    typeof getLatestRegistrySnapshot !== 'function'
  ) {
    throw new Error('Migration selection manager requires plan and registry adapters');
  }

  const root = path.join(dataRoot, 'migration-selections');
  const currentFile = path.join(root, 'current.json');

  function currentSnapshotId() {
    const snapshot = getLatestRegistrySnapshot();
    return snapshot && snapshot.snapshotId || null;
  }

  function status() {
    const current = readJson(currentFile);
    const latestSnapshotId = currentSnapshotId();
    const stale = Boolean(
      current && (!latestSnapshotId || current.sourceSnapshotId !== latestSnapshotId)
    );
    return {
      schemaVersion: MIGRATION_SELECTION_SCHEMA_VERSION,
      mode: 'review-only-migration-selection',
      state: !current ? 'empty' : stale ? 'stale' : 'current',
      stale,
      latestSnapshotId,
      current,
      summary: {
        selectedResources: current ? current.selectedResourceIds.length : 0
      },
      guarantees: selectionGuarantees()
    };
  }

  function getPlan(planId) {
    try {
      return getServerMigrationPlan(planId);
    } catch (error) {
      throw new MigrationSelectionError(
        error.message || 'Server migration plan was not found',
        Number.isInteger(error.statusCode) ? error.statusCode : 404,
        error.code || 'plan-not-found'
      );
    }
  }

  function save(input = {}) {
    if (input.confirmation !== SAVE_MIGRATION_SELECTION_CONFIRMATION) {
      throw new MigrationSelectionError(
        'Exact migration selection confirmation is required',
        400,
        'confirmation-required'
      );
    }
    if (!PLAN_ID_PATTERN.test(String(input.serverPlanId || ''))) {
      throw new MigrationSelectionError('Invalid server migration plan ID', 400, 'invalid-plan-id');
    }
    if (!Array.isArray(input.resourceIds)) {
      throw new MigrationSelectionError('resourceIds must be an array', 400, 'invalid-resource-ids');
    }
    if (input.resourceIds.length > MAX_SELECTED_RESOURCES) {
      throw new MigrationSelectionError(
        'Too many resources were selected',
        400,
        'selection-limit-exceeded'
      );
    }

    const resourceIds = Array.from(new Set(input.resourceIds.map((value) => String(value)))).sort();
    if (resourceIds.some((resourceId) => !RESOURCE_ID_PATTERN.test(resourceId))) {
      throw new MigrationSelectionError('Invalid resource ID', 400, 'invalid-resource-id');
    }

    const plan = getPlan(input.serverPlanId);
    const latestSnapshotId = currentSnapshotId();
    if (!latestSnapshotId || plan.sourceSnapshotId !== latestSnapshotId) {
      throw new MigrationSelectionError(
        'The server inventory changed; scan again before saving the selection',
        409,
        'stale-server-plan'
      );
    }

    const planResources = new Map((plan.resources || []).map((resource) => [resource.resourceId, resource]));
    const selectedResources = resourceIds.map((resourceId) => {
      const resource = planResources.get(resourceId);
      if (!resource) {
        throw new MigrationSelectionError(
          'A selected resource does not belong to this server plan',
          409,
          'resource-not-in-plan'
        );
      }
      if (!isReviewSelectable(resource)) {
        throw new MigrationSelectionError(
          'A selected resource is not eligible for a migration review plan',
          409,
          'resource-not-review-selectable'
        );
      }
      return {
        resourceId: resource.resourceId,
        name: resource.name,
        strategy: resource.strategy,
        authorityClass: resource.classification && resource.classification.authorityClass || null,
        stateClass: resource.classification && resource.classification.stateClass || null,
        workloadRole: resource.classification && resource.classification.workloadRole || null,
        manifestRevisionId: resource.evidence && resource.evidence.manifestRevisionId || null,
        availabilityMode: resource.availability && resource.availability.currentMode || null,
        evidenceComplete: resource.readiness && resource.readiness.evidenceComplete === true
      };
    });

    const core = {
      schemaVersion: MIGRATION_SELECTION_SCHEMA_VERSION,
      mode: 'review-only-migration-selection',
      serverPlanId: plan.planId,
      sourceSnapshotId: plan.sourceSnapshotId,
      selectedResourceIds: resourceIds,
      resources: selectedResources,
      guarantees: selectionGuarantees()
    };
    const selectionId = 'msel_' + hash(JSON.stringify(core));
    const existing = readJson(currentFile);
    if (existing && existing.selectionId === selectionId) return existing;

    const selection = {
      ...core,
      selectionId,
      savedAt: new Date(clock()).toISOString()
    };
    atomicWriteJson(currentFile, selection);
    return selection;
  }

  return {
    paths: { currentFile, root },
    save,
    status
  };
}

module.exports = {
  MIGRATION_SELECTION_SCHEMA_VERSION,
  MigrationSelectionError,
  SAVE_MIGRATION_SELECTION_CONFIRMATION,
  createMigrationSelectionManager,
  isReviewSelectable
};
