const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('./applicationManifestManager');
const { atomicWriteJson } = require('./resourceRegistry');

const STATELESS_MIGRATION_REVIEW_SCHEMA_VERSION = 1;
const SAVE_STATELESS_MIGRATION_REVIEW_CONFIRMATION = 'SAVE STATELESS MIGRATION REVIEW';
const STATELESS_PLAN_PATTERN = /^smplan_[a-f0-9]{32}$/;
const ROUTE_ID_PATTERN = /^smroute_[a-f0-9]{24}$/;
const CERTIFICATE_ADAPTERS = Object.freeze([
  'acme-http-01',
  'acme-dns-01',
  'imported-certificate'
]);

class StatelessMigrationReviewError extends Error {
  constructor(message, statusCode = 400, code = 'stateless-migration-review-error') {
    super(message);
    this.name = 'StatelessMigrationReviewError';
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

function reviewGuarantees() {
  return {
    reviewOnly: true,
    runtimeMutated: false,
    routesMutated: false,
    trafficSwitched: false,
    providerStateMutated: false,
    providerDetached: false,
    sourceStopped: false,
    approvalIssued: false,
    executionEndpointExposed: false,
    secretValuesIncluded: false,
    browserStorageIsAuthority: false,
    certificateProviderSelected: false
  };
}

function reviewBlocker(code, section, message, routeId = null) {
  return {
    code,
    section,
    severity: 'blocking',
    source: 'stateless-migration-review',
    message,
    ...(routeId ? { routeId } : {})
  };
}

function createStatelessMigrationReviewManager({
  dataRoot,
  getStatelessMigrationPlan,
  getLatestRegistrySnapshot,
  clock = () => new Date()
}) {
  if (
    !dataRoot || typeof getStatelessMigrationPlan !== 'function' ||
    typeof getLatestRegistrySnapshot !== 'function'
  ) {
    throw new Error('Stateless migration review manager requires plan and registry adapters');
  }

  const root = path.join(dataRoot, 'stateless-migration-reviews');
  const configurationsRoot = path.join(root, 'configurations');

  function getPlan(planId) {
    if (!STATELESS_PLAN_PATTERN.test(String(planId || ''))) {
      throw new StatelessMigrationReviewError('Invalid stateless migration plan ID', 400, 'invalid-plan-id');
    }
    try {
      return getStatelessMigrationPlan(planId);
    } catch (error) {
      throw new StatelessMigrationReviewError(
        error.message || 'Stateless migration plan was not found',
        Number.isInteger(error.statusCode) ? error.statusCode : 404,
        error.code || 'plan-not-found'
      );
    }
  }

  function contractFor(plan) {
    const contract = plan && plan.executionContract;
    if (
      !contract || !contract.contractId || !contract.candidate ||
      !contract.candidate.runtime || !contract.candidate.health || !Array.isArray(contract.routes)
    ) {
      throw new StatelessMigrationReviewError(
        'The stateless migration plan has no reviewable execution contract',
        409,
        'execution-contract-unavailable'
      );
    }
    return contract;
  }

  function latestSnapshotId() {
    const snapshot = getLatestRegistrySnapshot();
    return snapshot && snapshot.snapshotId || null;
  }

  function assertCurrent(plan) {
    const currentSnapshotId = latestSnapshotId();
    if (!currentSnapshotId || currentSnapshotId !== plan.sourceSnapshotId) {
      throw new StatelessMigrationReviewError(
        'The server inventory changed; scan and prepare the review again',
        409,
        'stale-stateless-plan'
      );
    }
    return currentSnapshotId;
  }

  function configurationFile(planId) {
    return path.join(configurationsRoot, planId + '.json');
  }

  function safeRuntime(runtime) {
    return {
      user: runtime.user || null,
      privileged: false,
      readOnlyRootFilesystem: runtime.readOnlyRootFilesystem === true,
      noNewPrivileges: runtime.noNewPrivileges === true,
      allCapabilitiesDropped: runtime.allCapabilitiesDropped === true,
      memoryBytes: runtime.memoryBytes,
      nanoCpus: runtime.nanoCpus,
      pidsLimit: runtime.pidsLimit,
      restartPolicy: runtime.restartPolicy,
      hostPortsPublished: false,
      writableMounts: 0
    };
  }

  function normalize(plan, input = {}) {
    const contract = contractFor(plan);
    if (contract.readiness && (contract.readiness.blockers || []).length) {
      throw new StatelessMigrationReviewError(
        'Resolve the execution contract blockers before saving its reviewed configuration',
        409,
        'execution-contract-blocked'
      );
    }
    const routeById = new Map(contract.routes.map((route) => [route.routeId, route]));
    if (routeById.size !== contract.routes.length || contract.routes.some((route) => (
      !ROUTE_ID_PATTERN.test(String(route.routeId || ''))
    ))) {
      throw new StatelessMigrationReviewError('Execution contract routes are invalid', 409, 'contract-routes-invalid');
    }

    const healthRouteId = input.healthRouteId === null || input.healthRouteId === undefined || input.healthRouteId === ''
      ? null
      : String(input.healthRouteId);
    if (healthRouteId && !routeById.has(healthRouteId)) {
      throw new StatelessMigrationReviewError(
        'The selected health target is not part of the execution contract',
        409,
        'health-target-not-in-contract'
      );
    }

    const suppliedRoutes = Array.isArray(input.routes) ? input.routes : [];
    const suppliedById = new Map();
    for (const supplied of suppliedRoutes) {
      const routeId = String(supplied && supplied.routeId || '');
      if (!routeById.has(routeId)) {
        throw new StatelessMigrationReviewError(
          'A reviewed route is not part of the execution contract',
          409,
          'route-not-in-contract'
        );
      }
      if (suppliedById.has(routeId)) {
        throw new StatelessMigrationReviewError('A reviewed route was supplied more than once', 400, 'duplicate-route');
      }
      const certificateAdapter = supplied.certificateAdapter === null ||
        supplied.certificateAdapter === undefined || supplied.certificateAdapter === ''
        ? null
        : String(supplied.certificateAdapter);
      if (certificateAdapter && !CERTIFICATE_ADAPTERS.includes(certificateAdapter)) {
        throw new StatelessMigrationReviewError(
          'Unsupported certificate adapter selection',
          400,
          'unsupported-certificate-adapter'
        );
      }
      suppliedById.set(routeId, {
        confirmed: supplied.confirmed === true,
        certificateAdapter
      });
    }

    const blockers = [];
    const healthRoute = healthRouteId ? routeById.get(healthRouteId) : null;
    if (!healthRoute) {
      blockers.push(reviewBlocker(
        'health-target-not-reviewed',
        'health',
        'Select and review one observed route as the candidate health target.'
      ));
    }
    const runtimeConfirmed = input.runtimeConfirmed === true;
    if (!runtimeConfirmed) {
      blockers.push(reviewBlocker(
        'runtime-defaults-not-reviewed',
        'runtime',
        'Review and confirm the complete candidate runtime specification.'
      ));
    }

    const routes = contract.routes.map((route) => {
      const supplied = suppliedById.get(route.routeId) || { confirmed: false, certificateAdapter: null };
      if (!supplied.confirmed) {
        blockers.push(reviewBlocker(
          'route-not-reviewed',
          'routes',
          'Review the exact domain, path and private port for this route.',
          route.routeId
        ));
      }
      if (!supplied.certificateAdapter) {
        blockers.push(reviewBlocker(
          'certificate-adapter-not-selected',
          'tls',
          'Select a replaceable certificate adapter for this route.',
          route.routeId
        ));
      }
      return {
        routeId: route.routeId,
        domain: route.domain,
        path: route.path,
        upstreamPrivatePort: route.upstreamPrivatePort,
        redirectHttpToHttps: route.redirectHttpToHttps === true,
        tlsAuthority: route.tls && route.tls.authority || null,
        tlsTrust: route.tls && route.tls.trust || null,
        confirmed: supplied.confirmed,
        certificateAdapter: supplied.certificateAdapter
      };
    });

    const configuration = {
      healthTarget: healthRoute ? {
        routeId: healthRoute.routeId,
        protocol: 'http',
        privatePort: healthRoute.upstreamPrivatePort,
        path: healthRoute.path,
        acceptedStatusMinimum: contract.candidate.health.acceptedStatusMinimum,
        acceptedStatusMaximum: contract.candidate.health.acceptedStatusMaximum
      } : null,
      runtime: {
        ...safeRuntime(contract.candidate.runtime),
        confirmed: runtimeConfirmed,
        defaultsApplied: [...(contract.uiReview && contract.uiReview.runtimeDefaultsApplied || [])]
      },
      routes
    };
    return {
      configuration,
      reviewBlockers: blockers,
      reviewComplete: blockers.length === 0
    };
  }

  function defaultInput(plan) {
    const contract = contractFor(plan);
    return {
      healthRouteId: null,
      runtimeConfirmed: false,
      routes: contract.routes.map((route) => ({
        routeId: route.routeId,
        confirmed: false,
        certificateAdapter: null
      }))
    };
  }

  function status(planId) {
    const plan = getPlan(planId);
    const contract = contractFor(plan);
    const currentSnapshotId = latestSnapshotId();
    const current = readJson(configurationFile(plan.planId));
    const stale = Boolean(
      !currentSnapshotId || plan.sourceSnapshotId !== currentSnapshotId ||
      (current && (
        current.sourceSnapshotId !== currentSnapshotId ||
        current.serverPlanId !== plan.serverPlanId ||
        current.resourceId !== plan.resource.resourceId ||
        current.executionContractId !== contract.contractId
      ))
    );
    return {
      schemaVersion: STATELESS_MIGRATION_REVIEW_SCHEMA_VERSION,
      mode: 'stateless-migration-reviewed-configuration',
      state: stale ? 'stale' : !current ? 'empty' : current.reviewComplete ? 'complete' : 'incomplete',
      stale,
      statelessPlanId: plan.planId,
      serverPlanId: plan.serverPlanId,
      sourceSnapshotId: plan.sourceSnapshotId,
      latestSnapshotId: currentSnapshotId,
      resourceId: plan.resource.resourceId,
      executionContractId: contract.contractId,
      current,
      defaults: defaultInput(plan),
      certificateAdapters: [...CERTIFICATE_ADAPTERS],
      executionGate: {
        status: 'sealed',
        approvalIssued: false,
        runtimeAdapterConfigured: false,
        routeAdapterConfigured: false,
        runEndpointExposed: false
      },
      guarantees: reviewGuarantees()
    };
  }

  function save(input = {}) {
    if (input.confirmation !== SAVE_STATELESS_MIGRATION_REVIEW_CONFIRMATION) {
      throw new StatelessMigrationReviewError(
        'Exact stateless migration review confirmation is required',
        400,
        'confirmation-required'
      );
    }
    const plan = getPlan(input.statelessPlanId);
    const contract = contractFor(plan);
    assertCurrent(plan);
    if (
      input.serverPlanId !== plan.serverPlanId ||
      input.resourceId !== plan.resource.resourceId ||
      input.executionContractId !== contract.contractId
    ) {
      throw new StatelessMigrationReviewError(
        'The reviewed configuration is bound to another plan, resource or execution contract',
        409,
        'review-binding-mismatch'
      );
    }
    const normalized = normalize(plan, input);
    const core = {
      schemaVersion: STATELESS_MIGRATION_REVIEW_SCHEMA_VERSION,
      mode: 'stateless-migration-reviewed-configuration',
      statelessPlanId: plan.planId,
      serverPlanId: plan.serverPlanId,
      sourceSnapshotId: plan.sourceSnapshotId,
      resourceId: plan.resource.resourceId,
      manifestRevisionId: contract.manifestRevisionId,
      executionContractId: contract.contractId,
      evidenceFingerprint: plan.resource.evidenceFingerprint,
      configuration: normalized.configuration,
      reviewComplete: normalized.reviewComplete,
      reviewBlockers: normalized.reviewBlockers,
      executionGate: {
        status: 'sealed',
        approvalIssued: false,
        runtimeAdapterConfigured: false,
        routeAdapterConfigured: false,
        runEndpointExposed: false
      },
      guarantees: reviewGuarantees()
    };
    const configurationFingerprint = hash(canonicalJson(core), 64);
    const reviewId = 'smreview_' + hash(configurationFingerprint, 32);
    const existing = readJson(configurationFile(plan.planId));
    if (existing && existing.reviewId === reviewId) return existing;
    const record = {
      ...core,
      reviewId,
      configurationFingerprint,
      savedAt: new Date(clock()).toISOString()
    };
    atomicWriteJson(configurationFile(plan.planId), record);
    return record;
  }

  return {
    paths: { root, configurationsRoot },
    save,
    status
  };
}

module.exports = {
  CERTIFICATE_ADAPTERS,
  SAVE_STATELESS_MIGRATION_REVIEW_CONFIRMATION,
  STATELESS_MIGRATION_REVIEW_SCHEMA_VERSION,
  StatelessMigrationReviewError,
  createStatelessMigrationReviewManager
};
