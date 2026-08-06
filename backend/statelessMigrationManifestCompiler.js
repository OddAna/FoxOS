const crypto = require('node:crypto');
const { canonicalJson } = require('./applicationManifestManager');

const STATELESS_EXECUTION_CONTRACT_SCHEMA_VERSION = 1;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const SNAPSHOT_ID_PATTERN = /^snap_[a-f0-9]{32}$/;
const MANIFEST_REVISION_PATTERN = /^arev_[a-f0-9]{32}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ROUTE_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENVIRONMENT_REVISION_PATTERN = /^env_rev_[a-f0-9]{32}$/;
const SECRET_ID_PATTERN = /^secret_[a-f0-9]{32}$/;
const SECRET_REVISION_PATTERN = /^secret_rev_[a-f0-9]{32}$/;
const KEY_ID_PATTERN = /^key_[a-f0-9]{24}$/;
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_NANO_CPUS = 1_000_000_000;
const DEFAULT_PIDS_LIMIT = 256;

const TRANSACTION_PROVEN_MANIFEST_BLOCKERS = new Set([
  'external-provider-authority',
  'foxos-route-missing',
  'foxos-health-proof-missing',
  'update-rollback-proof-missing',
  'restart-policy-not-resilient',
  'runtime-resource-limits-missing'
]);

const LOCAL_IMAGE_REPLACED_MANIFEST_BLOCKERS = new Set([
  'foxos-source-archive-invalid',
  'source-runtime-binding-missing'
]);

class StatelessMigrationManifestError extends Error {
  constructor(message, statusCode = 409, code = 'stateless-manifest-contract-error') {
    super(message);
    this.name = 'StatelessMigrationManifestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function blocker(code, section, message, source = 'stateless-manifest-compiler') {
  return { code, section, severity: 'blocking', source, message };
}

function uniqueBlockers(values) {
  const byKey = new Map();
  for (const value of values) {
    const normalized = {
      code: String(value.code),
      section: String(value.section || 'unknown'),
      severity: 'blocking',
      source: String(value.source || 'stateless-manifest-compiler'),
      message: String(value.message || 'The stateless execution contract is incomplete.')
    };
    byKey.set(normalized.source + ':' + normalized.section + ':' + normalized.code, normalized);
  }
  return Array.from(byKey.values()).sort((left, right) => (
    left.section.localeCompare(right.section) || left.code.localeCompare(right.code)
  ));
}

function observedPrivatePorts(resource) {
  return Array.from(new Set((resource.ports || [])
    .filter((port) => port.protocol === 'tcp' && Number.isInteger(port.privatePort) && port.privatePort >= 1 && port.privatePort <= 65535)
    .map((port) => port.privatePort))).sort((left, right) => left - right);
}

function normalizedRoutes(resource, blockers) {
  const ports = observedPrivatePorts(resource);
  const values = [];
  if (!(resource.routes || []).length) {
    blockers.push(blocker(
      'public-route-evidence-missing',
      'routes',
      'A stateless blue/green migration requires at least one observed public route.'
    ));
    return values;
  }
  for (const observed of resource.routes || []) {
    const domain = String(observed.domain || '').toLowerCase();
    const routePath = String(observed.path || '/');
    const routePort = Number.isInteger(observed.privatePort) ? observed.privatePort : (
      ports.length === 1 ? ports[0] : null
    );
    if (!DOMAIN_PATTERN.test(domain)) {
      blockers.push(blocker('route-domain-invalid', 'routes', 'An observed route domain is invalid.'));
      continue;
    }
    if (!ROUTE_PATH_PATTERN.test(routePath) || routePath.includes(':redacted-')) {
      blockers.push(blocker(
        'route-path-review-required',
        'routes',
        'A redacted or invalid route path must be supplied explicitly through the reviewed interface.'
      ));
      continue;
    }
    if (!Number.isInteger(routePort) || routePort < 1 || routePort > 65535) {
      blockers.push(blocker(
        'route-private-port-ambiguous',
        'routes',
        'The route cannot be bound to exactly one observed private TCP port.'
      ));
      continue;
    }
    values.push({
      routeId: 'smroute_' + hash(canonicalJson({ domain, path: routePath, resourceId: resource.id }), 24),
      domain,
      path: routePath,
      upstreamPrivatePort: routePort,
      redirectHttpToHttps: true,
      tls: {
        authority: 'foxos',
        trust: 'browser-trusted',
        certificateAdapter: null,
        adapterSelectionRequired: true,
        providerRequiredAsAuthority: false
      }
    });
  }
  const routesByAuthority = new Map();
  for (const route of values) {
    const authority = route.domain + route.path;
    const current = routesByAuthority.get(authority);
    if (current && current.upstreamPrivatePort !== route.upstreamPrivatePort) {
      blockers.push(blocker(
        'duplicate-route-target-conflict',
        'routes',
        'The same public domain and path resolve to multiple observed private ports.'
      ));
      continue;
    }
    routesByAuthority.set(authority, route);
  }
  return Array.from(routesByAuthority.values()).sort((left, right) => (
    left.domain.localeCompare(right.domain) || left.path.localeCompare(right.path)
  ));
}

function safeEnvironment(environment, blockers, resourceId) {
  if (!environment || environment.valuesIncluded !== false) {
    blockers.push(blocker(
      'environment-contract-missing',
      'environment',
      'A value-free server-owned environment revision is required.'
    ));
    return null;
  }
  if (environment.revision && !ENVIRONMENT_REVISION_PATTERN.test(String(environment.revision))) {
    blockers.push(blocker('environment-revision-invalid', 'environment', 'The environment revision identity is invalid.'));
    return null;
  }
  const ordinaryNames = Array.from(new Set((environment.ordinaryNames || []).map(String))).sort();
  const secretRefs = (environment.secretRefs || []).map((reference) => ({
    name: String(reference.name || ''),
    secretId: String(reference.secretId || ''),
    revision: String(reference.revision || ''),
    keyId: String(reference.keyId || '')
  })).sort((left, right) => left.name.localeCompare(right.name));
  const excluded = (environment.excluded || []).map((entry) => ({
    name: String(entry.name || ''),
    reason: String(entry.reason || '')
  })).sort((left, right) => left.name.localeCompare(right.name));
  const validNames = ordinaryNames.every((name) => ENVIRONMENT_NAME_PATTERN.test(name)) &&
    secretRefs.every((reference) => (
      ENVIRONMENT_NAME_PATTERN.test(reference.name) &&
      SECRET_ID_PATTERN.test(reference.secretId) &&
      SECRET_REVISION_PATTERN.test(reference.revision) &&
      KEY_ID_PATTERN.test(reference.keyId)
    )) && excluded.every((entry) => (
      ENVIRONMENT_NAME_PATTERN.test(entry.name) && entry.reason === 'provider-runtime-metadata'
    ));
  const allNames = [...ordinaryNames, ...secretRefs.map((entry) => entry.name), ...excluded.map((entry) => entry.name)];
  if (!validNames || new Set(allNames).size !== allNames.length) {
    blockers.push(blocker('environment-reference-invalid', 'environment', 'Environment names or encrypted secret references are invalid.'));
    return null;
  }
  return {
    resourceId,
    revision: environment.revision || null,
    ordinaryNames,
    secretRefs,
    excluded,
    valuesIncluded: false,
    resolveOnlyDuringCandidateCreation: true
  };
}

function createStatelessMigrationManifestCompiler({
  resourceRegistry,
  compileApplicationManifest
}) {
  if (
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    typeof compileApplicationManifest !== 'function'
  ) {
    throw new Error('Stateless manifest compiler requires registry and manifest compiler adapters');
  }

  function compile({ serverPlan, resource: plannedResource }) {
    if (
      !serverPlan || !SNAPSHOT_ID_PATTERN.test(String(serverPlan.sourceSnapshotId || '')) ||
      !plannedResource || !RESOURCE_ID_PATTERN.test(String(plannedResource.resourceId || '')) ||
      !plannedResource.evidence ||
      plannedResource.evidence.registrySnapshotId !== serverPlan.sourceSnapshotId ||
      !MANIFEST_REVISION_PATTERN.test(String(plannedResource.evidence.manifestRevisionId || ''))
    ) {
      throw new StatelessMigrationManifestError('Stateless manifest compiler input is invalid', 400, 'invalid-compiler-input');
    }
    const snapshot = resourceRegistry.getLatest();
    if (!snapshot || snapshot.snapshotId !== serverPlan.sourceSnapshotId) {
      throw new StatelessMigrationManifestError('Registry snapshot changed after whole-server planning', 409, 'registry-snapshot-stale');
    }
    const resource = (snapshot.resources || []).find((entry) => entry.id === plannedResource.resourceId);
    if (!resource) throw new StatelessMigrationManifestError('Planned resource is absent from the current registry', 404, 'resource-not-found');
    const manifest = compileApplicationManifest(resource.id);
    const blockers = [];
    if (
      !manifest || manifest.resourceId !== resource.id ||
      !MANIFEST_REVISION_PATTERN.test(String(manifest.revisionId || '')) ||
      !manifest.evidence || manifest.evidence.registrySnapshotId !== snapshot.snapshotId ||
      manifest.revisionId !== plannedResource.evidence.manifestRevisionId
    ) {
      throw new StatelessMigrationManifestError('Application Manifest revision changed after planning', 409, 'manifest-revision-stale');
    }
    const runtimeFullyObserved = Boolean(
      resource.runtime && resource.runtime.inspection === 'complete' && resource.runtime.state === 'running'
    );
    if (
      resource.protected || resource.provider === 'foxos' || resource.ownership === 'foxos-managed' ||
      !resource.classification || resource.classification.workloadRole !== 'application' ||
      resource.classification.stateClass !== 'stateless' ||
      resource.classification.authorityClass !== 'provider-owned' ||
      !runtimeFullyObserved
    ) {
      blockers.push(blocker(
        'unsupported-runtime-authority',
        'classification',
        'Only a running, fully inspected, provider-owned stateless application can compile this contract.'
      ));
    }
    const source = manifest.desired && manifest.desired.source || null;
    const manifestBlockerCodes = new Set((manifest.gates && manifest.gates.blockers || [])
      .map((entry) => entry.code));
    const exactLocalImageFallback = Boolean(
      IMAGE_ID_PATTERN.test(String(resource.runtime && resource.runtime.imageId || '')) &&
      [...manifestBlockerCodes].some((code) => LOCAL_IMAGE_REPLACED_MANIFEST_BLOCKERS.has(code)) &&
      (!source || source.type === 'foxos-encrypted-source-archive-revision')
    );
    const executionSource = exactLocalImageFallback ? {
      type: 'docker-image-id',
      requestedReference: resource.runtime.image || null,
      immutableReference: null,
      imageId: resource.runtime.imageId,
      contentAddressed: true,
      localDockerAuthority: true,
      providerRequiredAtRuntime: false
    } : source;
    for (const entry of manifest.gates && manifest.gates.blockers || []) {
      if (
        !TRANSACTION_PROVEN_MANIFEST_BLOCKERS.has(entry.code) &&
        !(exactLocalImageFallback && LOCAL_IMAGE_REPLACED_MANIFEST_BLOCKERS.has(entry.code))
      ) {
        blockers.push(blocker(
          'manifest-blocker:' + entry.code,
          entry.section || 'manifest',
          entry.message || 'Application Manifest evidence is incomplete.',
          'application-manifest'
        ));
      }
    }

    const immutableOciSource = Boolean(
      executionSource && executionSource.type === 'oci-image' &&
      IMMUTABLE_IMAGE_PATTERN.test(String(executionSource.immutableReference || ''))
    );
    const localImageIdSource = Boolean(
      executionSource && executionSource.type === 'docker-image-id' && executionSource.contentAddressed === true &&
      executionSource.localDockerAuthority === true && executionSource.providerRequiredAtRuntime === false
    );
    if (
      (!immutableOciSource && !localImageIdSource) ||
      !IMAGE_ID_PATTERN.test(String(executionSource && executionSource.imageId || '')) ||
      executionSource.imageId !== resource.runtime.imageId
    ) {
      blockers.push(blocker(
        'immutable-oci-runtime-binding-missing',
        'source',
        'The stateless contract requires either an immutable OCI reference or the exact local content-addressed image ID.'
      ));
    }
    if ((resource.mounts || []).some((mount) => mount.readOnly !== true)) {
      blockers.push(blocker(
        'writable-persistence-not-stateless',
        'persistence',
        'A writable mount cannot enter the stateless candidate contract.'
      ));
    }
    if ((plannedResource.dependencies || []).some((dependency) => dependency.required === true)) {
      blockers.push(blocker(
        'required-dependency-transaction-not-ready',
        'dependencies',
        'Required application dependencies need a group transaction before this resource can move independently.'
      ));
    }
    const desiredRuntime = manifest.desired && manifest.desired.runtime || {};
    const constraints = desiredRuntime.constraints || {};
    if (constraints.privileged === true) {
      blockers.push(blocker('privileged-runtime-rejected', 'runtime', 'Privileged application candidates are not supported.'));
    }
    for (const [name, value] of Object.entries({
      memoryBytes: constraints.memoryBytes,
      nanoCpus: constraints.nanoCpus,
      pidsLimit: constraints.pidsLimit
    })) {
      if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        blockers.push(blocker(
          'runtime-limit-invalid:' + name,
          'runtime',
          'Observed runtime limits must be positive safe integers before they can enter the candidate contract.'
        ));
      }
    }
    const routes = normalizedRoutes(resource, blockers);
    const environment = safeEnvironment(manifest.desired && manifest.desired.environment, blockers, resource.id);
    const ingressPorts = Array.from(new Set(routes.map((route) => route.upstreamPrivatePort))).sort((left, right) => left - right);
    const healthTargets = Array.from(new Map(routes.map((route) => [
      canonicalJson({ privatePort: route.upstreamPrivatePort, path: route.path }),
      { privatePort: route.upstreamPrivatePort, path: route.path }
    ])).values()).sort((left, right) => (
      left.privatePort - right.privatePort || left.path.localeCompare(right.path)
    ));
    const healthSelectionRequired = healthTargets.length !== 1;
    const healthTarget = healthTargets.length === 1 ? healthTargets[0] : null;
    if (routes.length > 0 && healthSelectionRequired) {
      blockers.push(blocker(
        'multiple-health-targets-not-executable',
        'health',
        'Observed routes resolve to more than one candidate health target; automatic execution stays blocked until one reviewed target is bound to the runtime contract.'
      ));
    }
    const defaultedLimits = [];
    if (!constraints.memoryBytes) defaultedLimits.push('memoryBytes');
    if (!constraints.nanoCpus) defaultedLimits.push('nanoCpus');
    if (!constraints.pidsLimit) defaultedLimits.push('pidsLimit');
    const core = {
      schemaVersion: STATELESS_EXECUTION_CONTRACT_SCHEMA_VERSION,
      mode: 'stateless-manifest-execution-contract',
      resourceId: resource.id,
      registrySnapshotId: snapshot.snapshotId,
      manifestRevisionId: manifest.revisionId,
      source: {
        type: executionSource && executionSource.type || null,
        immutableReference: executionSource && executionSource.immutableReference || null,
        imageId: executionSource && executionSource.imageId || null,
        observedContainerId: resource.runtime && resource.runtime.containerId || null,
        localDockerAuthority: Boolean(localImageIdSource),
        providerRequiredAtRuntime: false,
        manifestSourceType: source && source.type || null,
        fallbackReason: exactLocalImageFallback ? 'unbound-or-invalid-source-archive' : null
      },
      candidate: {
        engine: 'docker',
        ownership: 'foxos',
        desiredState: 'running',
        imageId: executionSource && executionSource.imageId || null,
        environment,
        runtime: {
          user: constraints.user || null,
          privileged: false,
          readOnlyRootFilesystem: constraints.readOnlyRootFilesystem === true,
          noNewPrivileges: true,
          allCapabilitiesDropped: true,
          memoryBytes: Number.isSafeInteger(constraints.memoryBytes) && constraints.memoryBytes > 0
            ? constraints.memoryBytes : DEFAULT_MEMORY_BYTES,
          nanoCpus: Number.isSafeInteger(constraints.nanoCpus) && constraints.nanoCpus > 0
            ? constraints.nanoCpus : DEFAULT_NANO_CPUS,
          pidsLimit: Number.isSafeInteger(constraints.pidsLimit) && constraints.pidsLimit > 0
            ? constraints.pidsLimit : DEFAULT_PIDS_LIMIT,
          restartPolicy: desiredRuntime.restartPolicy && desiredRuntime.restartPolicy !== 'no'
            ? desiredRuntime.restartPolicy
            : 'unless-stopped',
          hostPortsPublished: false,
          writableMounts: 0
        },
        ingressPorts,
        health: {
          protocol: 'http',
          privatePort: healthTarget ? healthTarget.privatePort : null,
          path: healthTarget ? healthTarget.path : null,
          acceptedStatusMinimum: 200,
          acceptedStatusMaximum: 399,
          reviewRequired: true,
          selectionRequired: healthSelectionRequired
        }
      },
      routes,
      availability: {
        mode: 'zero-downtime-blue-green',
        sourcePauseBudgetMs: 0,
        unavailableSamplesAllowed: 0,
        atomicSwitchRequired: true,
        sourceRuntimeContinuityRequired: true,
        exactRollbackRequired: true
      },
      uiReview: {
        required: true,
        runtimeDefaultsApplied: defaultedLimits,
        healthContractReviewRequired: true,
        healthTargetSelectionRequired: healthSelectionRequired,
        certificateAdapterSelectionRequired: routes.length > 0,
        certificateAdapter: null
      },
      guarantees: {
        dockerRequestsMade: 0,
        runtimeMutated: false,
        routesMutated: false,
        providerMutated: false,
        providerDetached: false,
        providerRequiredAsRuntimeAuthority: false,
        exactLocalImageFallback,
        secretValuesIncluded: false,
        ordinaryEnvironmentValuesIncluded: false
      }
    };
    const finalBlockers = uniqueBlockers(blockers);
    return {
      ...core,
      contractId: 'smcontract_' + hash(canonicalJson(core), 32),
      readiness: {
        status: finalBlockers.length ? 'blocked' : 'backend-contract-ready-ui-configuration-required',
        blockers: finalBlockers
      }
    };
  }

  return { compile };
}

module.exports = {
  STATELESS_EXECUTION_CONTRACT_SCHEMA_VERSION,
  StatelessMigrationManifestError,
  TRANSACTION_PROVEN_MANIFEST_BLOCKERS,
  createStatelessMigrationManifestCompiler
};
