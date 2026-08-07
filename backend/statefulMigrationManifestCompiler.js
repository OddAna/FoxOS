const crypto = require('node:crypto');
const { canonicalJson } = require('./applicationManifestManager');
const { applicationRuntimeIdentity } = require('./productionStatelessMigrationAdapter');

const STATEFUL_EXECUTION_CONTRACT_SCHEMA_VERSION = 1;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const SNAPSHOT_ID_PATTERN = /^snap_[a-f0-9]{32}$/;
const MANIFEST_REVISION_PATTERN = /^arev_[a-f0-9]{32}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ROUTE_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const ENVIRONMENT_REVISION_PATTERN = /^env_rev_[a-f0-9]{32}$/;
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_NANO_CPUS = 1_000_000_000;
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_SOURCE_PAUSE_BUDGET_MS = 120_000;
const MAX_STATEFUL_VOLUMES = 4;

const TRANSACTION_PROVEN_STATEFUL_BLOCKERS = new Set([
  'external-provider-authority',
  'foxos-route-missing',
  'foxos-health-proof-missing',
  'recovery-target-unavailable',
  'restore-proof-missing',
  'restart-policy-not-resilient',
  'runtime-resource-limits-missing',
  'update-rollback-proof-missing',
  'source-runtime-binding-missing',
  'foxos-source-archive-invalid'
]);

class StatefulMigrationManifestError extends Error {
  constructor(message, statusCode = 409, code = 'stateful-manifest-contract-error') {
    super(message);
    this.name = 'StatefulMigrationManifestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function blocker(code, section, message, source = 'stateful-manifest-compiler') {
  return { code, section, severity: 'blocking', source, message };
}

function uniqueBlockers(values) {
  const byKey = new Map();
  for (const value of values) {
    const normalized = {
      code: String(value.code),
      section: String(value.section || 'unknown'),
      severity: 'blocking',
      source: String(value.source || 'stateful-manifest-compiler'),
      message: String(value.message || 'The stateful execution contract is incomplete.')
    };
    byKey.set(normalized.source + ':' + normalized.section + ':' + normalized.code, normalized);
  }
  return Array.from(byKey.values()).sort((left, right) => (
    left.section.localeCompare(right.section) || left.code.localeCompare(right.code)
  ));
}

function observedPrivatePorts(resource) {
  return Array.from(new Set((resource.ports || [])
    .filter((port) => port.protocol === 'tcp' && Number.isInteger(port.privatePort) && port.privatePort > 0)
    .map((port) => port.privatePort))).sort((left, right) => left - right);
}

function normalizedRoutes(resource, blockers) {
  const ports = observedPrivatePorts(resource);
  const routes = new Map();
  for (const observed of resource.routes || []) {
    const domain = String(observed.domain || '').trim().toLowerCase().replace(/\.$/, '');
    const routePath = String(observed.path || '/');
    const privatePort = Number.isInteger(observed.privatePort)
      ? observed.privatePort
      : ports.length === 1 ? ports[0] : null;
    if (!DOMAIN_PATTERN.test(domain)) {
      blockers.push(blocker('route-domain-invalid', 'routes', 'An observed route domain is invalid.'));
      continue;
    }
    if (!ROUTE_PATH_PATTERN.test(routePath) || routePath.includes(':redacted-')) {
      blockers.push(blocker('route-path-review-required', 'routes', 'The observed route path is invalid or redacted.'));
      continue;
    }
    if (!Number.isInteger(privatePort) || privatePort < 1 || privatePort > 65535) {
      blockers.push(blocker('route-private-port-ambiguous', 'routes', 'The route has no unambiguous private TCP port.'));
      continue;
    }
    const key = domain + '\n' + routePath;
    const current = routes.get(key);
    if (current && current.upstreamPrivatePort !== privatePort) {
      blockers.push(blocker('duplicate-route-target-conflict', 'routes', 'The same route points to multiple private ports.'));
      continue;
    }
    routes.set(key, {
      routeId: 'smroute_' + hash(canonicalJson({ domain, path: routePath, resourceId: resource.id }), 24),
      domain,
      path: routePath,
      upstreamPrivatePort: privatePort,
      redirectHttpToHttps: true,
      tls: { authority: 'foxos', trust: 'browser-trusted', certificateAdapter: 'imported-certificate' }
    });
  }
  if (!routes.size) {
    blockers.push(blocker('public-route-evidence-missing', 'routes', 'A production route is required for stateful cutover.'));
  }
  return Array.from(routes.values()).sort((left, right) => (
    left.domain.localeCompare(right.domain) || left.path.localeCompare(right.path)
  ));
}

function volumeSlug(value, fallback) {
  const normalized = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return normalized || fallback;
}

function normalizedVolumes(resource, application, blockers) {
  const mounts = resource.mounts || [];
  if (mounts.length < 1 || mounts.length > MAX_STATEFUL_VOLUMES) {
    blockers.push(blocker('unsupported-volume-count', 'persistence', `One to ${MAX_STATEFUL_VOLUMES} writable named volumes are required.`));
    return [];
  }
  if (mounts.some((mount) => (
    mount.type !== 'volume' || !mount.name || !mount.destination || mount.readOnly === true
  ))) {
    blockers.push(blocker('unsupported-mount-policy', 'persistence', 'Only writable Docker named volumes are supported by this transaction.'));
    return [];
  }
  const names = new Set();
  return mounts.map((mount, index) => {
    const leaf = String(mount.destination).split('/').filter(Boolean).pop() || `data-${index + 1}`;
    let targetName = volumeSlug(application.appId + '-' + leaf, application.appId + '-data-' + (index + 1));
    if (names.has(targetName)) targetName = volumeSlug(targetName + '-' + (index + 1), application.appId + '-data-' + (index + 1));
    names.add(targetName);
    return {
      sourceName: mount.name,
      targetName,
      destination: mount.destination,
      policy: 'persistent',
      readOnly: false
    };
  });
}

function environmentContract(manifest, resource, blockers) {
  const environment = manifest.desired && manifest.desired.environment;
  if (
    !environment || environment.valuesIncluded !== false ||
    !ENVIRONMENT_REVISION_PATTERN.test(String(environment.revision || ''))
  ) {
    blockers.push(blocker('environment-contract-missing', 'environment', 'A captured server-owned environment revision is required.'));
    return null;
  }
  return {
    resourceId: resource.id,
    revision: environment.revision,
    ordinaryNames: [...(environment.ordinaryNames || [])].map(String).sort(),
    secretRefs: [...(environment.secretRefs || [])].map((entry) => ({
      name: String(entry.name || ''),
      secretId: String(entry.secretId || ''),
      revision: String(entry.revision || ''),
      keyId: String(entry.keyId || '')
    })).sort((left, right) => left.name.localeCompare(right.name)),
    excluded: [...(environment.excluded || [])].map((entry) => ({
      name: String(entry.name || ''), reason: String(entry.reason || '')
    })).sort((left, right) => left.name.localeCompare(right.name)),
    valuesIncluded: false,
    resolveOnlyDuringCandidateCreation: true
  };
}

function createStatefulMigrationManifestCompiler({ resourceRegistry, compileApplicationManifest }) {
  if (
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    typeof compileApplicationManifest !== 'function'
  ) throw new Error('Stateful manifest compiler requires registry and manifest adapters');

  function compile({ serverPlan, resource: plannedResource }) {
    if (
      !serverPlan || !SNAPSHOT_ID_PATTERN.test(String(serverPlan.sourceSnapshotId || '')) ||
      !plannedResource || !RESOURCE_ID_PATTERN.test(String(plannedResource.resourceId || '')) ||
      !plannedResource.evidence ||
      plannedResource.evidence.registrySnapshotId !== serverPlan.sourceSnapshotId ||
      !MANIFEST_REVISION_PATTERN.test(String(plannedResource.evidence.manifestRevisionId || ''))
    ) throw new StatefulMigrationManifestError('Stateful compiler input is invalid', 400, 'invalid-compiler-input');

    const snapshot = resourceRegistry.getLatest();
    if (!snapshot || snapshot.snapshotId !== serverPlan.sourceSnapshotId) {
      throw new StatefulMigrationManifestError('Registry snapshot changed after planning', 409, 'registry-snapshot-stale');
    }
    const resource = (snapshot.resources || []).find((entry) => entry.id === plannedResource.resourceId);
    if (!resource) throw new StatefulMigrationManifestError('Planned resource is missing', 404, 'resource-not-found');
    const manifest = compileApplicationManifest(resource.id);
    if (
      !manifest || manifest.resourceId !== resource.id ||
      manifest.revisionId !== plannedResource.evidence.manifestRevisionId ||
      !manifest.evidence || manifest.evidence.registrySnapshotId !== snapshot.snapshotId
    ) throw new StatefulMigrationManifestError('Application Manifest changed after planning', 409, 'manifest-revision-stale');

    const blockers = [];
    if (
      resource.protected || resource.provider === 'foxos' || resource.ownership === 'foxos-managed' ||
      !resource.runtime || resource.runtime.state !== 'running' || resource.runtime.inspection !== 'complete' ||
      !resource.classification || resource.classification.workloadRole !== 'application' ||
      resource.classification.stateClass !== 'stateful' ||
      resource.classification.authorityClass !== 'provider-owned'
    ) blockers.push(blocker('unsupported-runtime-authority', 'classification', 'Only a running provider-owned stateful application is supported.'));
    if (plannedResource.migrationGroup && (plannedResource.migrationGroup.memberResourceIds || []).length > 1) {
      blockers.push(blocker('stateful-group-transaction-required', 'dependencies', 'This application must move with its companion services.'));
    }
    if ((plannedResource.dependencies || []).some((dependency) => dependency.required === true)) {
      blockers.push(blocker('required-dependency-transaction-not-ready', 'dependencies', 'Required dependencies need an atomic group transaction.'));
    }
    for (const entry of manifest.gates && manifest.gates.blockers || []) {
      if (!TRANSACTION_PROVEN_STATEFUL_BLOCKERS.has(entry.code)) {
        blockers.push(blocker('manifest-blocker:' + entry.code, entry.section || 'manifest', entry.message || 'Manifest evidence is incomplete.', 'application-manifest'));
      }
    }
    if (!IMAGE_ID_PATTERN.test(String(resource.runtime.imageId || ''))) {
      blockers.push(blocker('immutable-image-id-missing', 'source', 'The exact local Docker image identity is required.'));
    }

    const routes = normalizedRoutes(resource, blockers);
    let application = null;
    try {
      application = applicationRuntimeIdentity(resource, routes);
    } catch (error) {
      blockers.push(blocker(error.code || 'application-runtime-name-unavailable', 'runtime', error.message));
    }
    const volumes = application ? normalizedVolumes(resource, application, blockers) : [];
    const environment = environmentContract(manifest, resource, blockers);
    const healthTarget = resource.runtime && resource.runtime.health && resource.runtime.health.httpTarget;
    const routeTargets = Array.from(new Map(routes.map((route) => [
      route.upstreamPrivatePort + ':' + route.path,
      { privatePort: route.upstreamPrivatePort, path: route.path, source: 'observed-route' }
    ])).values());
    const health = healthTarget && healthTarget.protocol === 'http' &&
      routes.some((route) => route.upstreamPrivatePort === healthTarget.privatePort)
      ? { privatePort: healthTarget.privatePort, path: healthTarget.path, source: healthTarget.source }
      : routeTargets.length === 1 ? routeTargets[0] : null;
    if (!health || !ROUTE_PATH_PATTERN.test(String(health.path || ''))) {
      blockers.push(blocker('stateful-health-target-missing', 'health', 'An unambiguous internal HTTP health target is required.'));
    } else if (health.privatePort < 1024) {
      blockers.push(blocker('privileged-private-port-unsupported', 'runtime', 'This first stateful adapter supports unprivileged private ports only.'));
    }
    const constraints = manifest.desired && manifest.desired.runtime && manifest.desired.runtime.constraints || {};
    const core = {
      schemaVersion: STATEFUL_EXECUTION_CONTRACT_SCHEMA_VERSION,
      mode: 'stateful-bounded-quiesce-execution-contract',
      resourceId: resource.id,
      registrySnapshotId: snapshot.snapshotId,
      manifestRevisionId: manifest.revisionId,
      source: {
        containerId: resource.runtime.containerId,
        imageId: resource.runtime.imageId,
        requestedImage: resource.runtime.image || null,
        providerRequiredAtRuntime: false
      },
      application,
      candidate: {
        imageId: resource.runtime.imageId,
        environment,
        volumes,
        ingressPorts: Array.from(new Set(routes.map((route) => route.upstreamPrivatePort))).sort((a, b) => a - b),
        health: health ? {
          protocol: 'http', privatePort: health.privatePort, path: health.path,
          source: health.source, acceptedStatusMinimum: 200, acceptedStatusMaximum: 399
        } : null,
        runtime: {
          memoryBytes: Number.isSafeInteger(constraints.memoryBytes) && constraints.memoryBytes > 0 ? constraints.memoryBytes : DEFAULT_MEMORY_BYTES,
          nanoCpus: Number.isSafeInteger(constraints.nanoCpus) && constraints.nanoCpus > 0 ? constraints.nanoCpus : DEFAULT_NANO_CPUS,
          pidsLimit: Number.isSafeInteger(constraints.pidsLimit) && constraints.pidsLimit > 0 ? constraints.pidsLimit : DEFAULT_PIDS_LIMIT,
          restartPolicy: 'unless-stopped',
          privileged: false,
          noNewPrivileges: true,
          hostPortsPublished: false
        }
      },
      routes,
      availability: {
        mode: 'bounded-quiesce',
        sourcePauseBudgetMs: DEFAULT_SOURCE_PAUSE_BUDGET_MS,
        automaticRollbackRequired: true,
        exactSourcePreserved: true,
        zeroDowntimeClaimed: false
      },
      guarantees: {
        providerMutated: false,
        providerDetached: false,
        destructiveSourceCleanup: false,
        localEncryptedFinalSnapshot: true,
        secretValuesIncluded: false,
        ordinaryEnvironmentValuesIncluded: false
      }
    };
    const finalBlockers = uniqueBlockers(blockers);
    return {
      ...core,
      contractId: 'stmcontract_' + hash(canonicalJson(core), 32),
      readiness: { status: finalBlockers.length ? 'blocked' : 'backend-ready', blockers: finalBlockers }
    };
  }

  return { compile };
}

module.exports = {
  DEFAULT_SOURCE_PAUSE_BUDGET_MS,
  STATEFUL_EXECUTION_CONTRACT_SCHEMA_VERSION,
  StatefulMigrationManifestError,
  TRANSACTION_PROVEN_STATEFUL_BLOCKERS,
  createStatefulMigrationManifestCompiler
};
