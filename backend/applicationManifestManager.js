const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const APPLICATION_MANIFEST_SCHEMA_VERSION = 1;
const PLAN_APPLICATION_MANIFEST_CONFIRMATION = 'PLAN APPLICATION MANIFEST';
const MAX_DRAFTS = 100;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const RECORD_ID_PATTERN = /^(adraft|app|arev)_[a-f0-9]{24,64}$/;

class ApplicationManifestError extends Error {
  constructor(message, statusCode = 400, code = 'application-manifest-error') {
    super(message);
    this.name = 'ApplicationManifestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => (
      JSON.stringify(key) + ':' + canonicalJson(value[key])
    )).join(',') + '}';
  }
  return JSON.stringify(value);
}

function hash(value, length = 24) {
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

function pruneJson(directory, maximum) {
  let entries;
  try {
    entries = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).map((file) => ({
      file,
      record: readJson(path.join(directory, file), {})
    })).sort((left, right) => (
      String(left.record.createdAt || '').localeCompare(String(right.record.createdAt || '')) ||
      left.file.localeCompare(right.file)
    ));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.slice(0, Math.max(0, entries.length - maximum))) {
    fs.unlinkSync(path.join(directory, entry.file));
  }
}

function applicationManifestConfirmation(draftId) {
  return 'FINALIZE APPLICATION MANIFEST ' + draftId;
}

function immutableImageFor(resource, snapshot) {
  const requestedReference = String(resource.runtime.image || '');
  if (/@sha256:[a-f0-9]{64}$/i.test(requestedReference)) {
    return requestedReference.toLowerCase();
  }
  const candidates = (snapshot.inventory && snapshot.inventory.images || [])
    .filter((image) => (image.usedBy || []).includes(resource.id));
  const requestedRepository = requestedReference.replace(/:[^/:]+$/, '').replace(/^docker\.io\//, '');
  const digests = candidates.flatMap((image) => image.digests || []).sort();
  return digests.find((digest) => (
    digest.replace(/^docker\.io\//, '').startsWith(requestedRepository + '@sha256:')
  )) || digests[0] || null;
}

function relatedRelationships(snapshot, resourceId) {
  return (snapshot.relationships || []).filter((relationship) => (
    (relationship.resourceIds || []).includes(resourceId) ||
    relationship.sourceResourceId === resourceId || relationship.targetResourceId === resourceId
  )).map((relationship) => {
    const resourceIds = relationship.resourceIds || [
      relationship.sourceResourceId,
      relationship.targetResourceId
    ].filter(Boolean);
    return {
      relationshipId: relationship.id,
      type: relationship.type,
      resourceIds: Array.from(new Set(resourceIds)).sort(),
      required: relationship.type !== 'provider-project'
    };
  }).sort((left, right) => left.relationshipId.localeCompare(right.relationshipId));
}

function resourceFingerprint(resource, relationships) {
  return 'sha256:' + hash(canonicalJson({ resource, relationships }), 64);
}

function createApplicationManifestManager({
  dataRoot,
  resourceRegistry,
  getEnvironmentRevision = () => null,
  routeStatus = () => ({ configured: false, routes: [] }),
  backupStatus = () => ({ configured: false, ready: false, adapter: null, offHost: false }),
  imageUpdateStatus = () => ({ current: null, operations: [] }),
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (!dataRoot || !resourceRegistry || typeof resourceRegistry.getLatest !== 'function') {
    throw new Error('Application manifest manager requires a data root and resource registry');
  }
  for (const dependency of [getEnvironmentRevision, routeStatus, backupStatus, imageUpdateStatus]) {
    if (typeof dependency !== 'function') throw new Error('Application manifest state adapters must be functions');
  }

  const root = path.join(dataRoot, 'application-manifests');
  const draftsRoot = path.join(root, 'drafts');
  const revisionsRoot = path.join(root, 'revisions');
  const currentRoot = path.join(root, 'current');

  function now() {
    return new Date(clock()).toISOString();
  }

  function recordPath(directory, id) {
    if (!RECORD_ID_PATTERN.test(String(id))) {
      throw new ApplicationManifestError('Invalid application manifest record ID', 400, 'invalid-manifest-record-id');
    }
    return path.join(directory, id + '.json');
  }

  function getDraft(draftId) {
    const draft = readJson(recordPath(draftsRoot, draftId));
    if (!draft) throw new ApplicationManifestError('Application manifest draft was not found', 404, 'manifest-draft-not-found');
    return draft;
  }

  function getCurrent(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId))) {
      throw new ApplicationManifestError('Invalid FoxOS resource ID', 400, 'invalid-resource-id');
    }
    return readJson(path.join(currentRoot, resourceId + '.json'));
  }

  function addBlocker(blockers, code, section, message) {
    blockers.push({ code, section, severity: 'blocking', message });
  }

  function compile(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId))) {
      throw new ApplicationManifestError('Invalid FoxOS resource ID', 400, 'invalid-resource-id');
    }
    const snapshot = resourceRegistry.getLatest();
    if (!snapshot) {
      throw new ApplicationManifestError('Run a resource scan before planning an application manifest', 409, 'registry-not-scanned');
    }
    const resource = (snapshot.resources || []).find((candidate) => candidate.id === resourceId);
    if (!resource) throw new ApplicationManifestError('Resource was not found in the latest registry snapshot', 404, 'resource-not-found');

    const blockers = [];
    const relationships = relatedRelationships(snapshot, resourceId);
    const environment = getEnvironmentRevision(resourceId);
    const routeState = routeStatus();
    const recoveryState = backupStatus();
    const updateState = imageUpdateStatus();
    const immutableReference = immutableImageFor(resource, snapshot);
    const ownedRoutes = (routeState.routes || []).filter((route) => (
      route.resourceId === resourceId && route.owner === 'foxos' && route.status === 'active'
    ));
    const environmentCount = resource.runtime.environmentVariableCount;
    const currentUpdate = updateState.current && updateState.current.resourceId === resourceId &&
      updateState.current.containerId === resource.runtime.containerId ? updateState.current : null;
    const imageDefaultEnvironmentOnly = Boolean(
      currentUpdate && updateState.guarantees && updateState.guarantees.environmentSupported === false
    );
    const managedEnvironmentCount = imageDefaultEnvironmentOnly ? 0 : environmentCount;
    const sourceDefaultEnvironmentCount = imageDefaultEnvironmentOnly ? environmentCount : 0;
    const classifiedCount = environment
      ? (environment.ordinary || []).length + (environment.secretRefs || []).length
      : 0;
    const persistenceRequired = (resource.mounts || []).length > 0;
    const rollbackOperation = currentUpdate && (updateState.operations || []).find((operation) => (
      operation.status === 'rolled-back' && operation.previous &&
      operation.previous.operationId === currentUpdate.operationId &&
      operation.rollback && operation.rollback.proof && operation.rollback.proof.verified
    ));

    if (resource.protected) addBlocker(blockers, 'foxos-core-protected', 'ownership', 'FoxOS core resources cannot become application manifests.');
    if (resource.provider !== 'foxos' || resource.ownership !== 'foxos-managed') {
      addBlocker(blockers, 'external-provider-authority', 'ownership', 'The current runtime is still authoritative outside FoxOS.');
    }
    if (resource.runtime.inspection !== 'complete') {
      addBlocker(blockers, 'inspection-incomplete', 'runtime', 'Complete Docker inspection is required.');
    }
    if (!immutableReference) {
      addBlocker(blockers, 'immutable-image-missing', 'source', 'No repository digest can reconstruct this image immutably.');
    }
    if (environmentCount === null || environmentCount === undefined) {
      addBlocker(blockers, 'environment-count-unknown', 'environment', 'The observed environment could not be counted safely.');
    } else if (managedEnvironmentCount > 0 && !environment) {
      addBlocker(blockers, 'environment-revision-missing', 'environment', 'Classify ordinary values and encrypted secret references into a local revision.');
    } else if (environment && classifiedCount !== managedEnvironmentCount) {
      addBlocker(blockers, 'environment-revision-mismatch', 'environment', 'The local environment revision does not cover the observed variable count.');
    }
    if ((resource.routes || []).length > 0 && ownedRoutes.length === 0) {
      addBlocker(blockers, 'foxos-route-missing', 'routes', 'Observed provider routes have no active FoxOS-owned route record.');
    }
    if (persistenceRequired) {
      if (!recoveryState.configured || !recoveryState.ready || !recoveryState.offHost) {
        addBlocker(blockers, 'recovery-target-unavailable', 'recovery', 'Persistent data requires a ready off-host recovery target.');
      }
      addBlocker(blockers, 'restore-proof-missing', 'recovery', 'Persistent data requires a resource-scoped tested restore proof.');
    }
    for (const relationship of relationships.filter((candidate) => candidate.required)) {
      for (const dependencyId of relationship.resourceIds.filter((candidate) => candidate !== resourceId)) {
        if (!getCurrent(dependencyId)) {
          addBlocker(
            blockers,
            'dependency-manifest-missing:' + dependencyId,
            'dependencies',
            'A related resource has no finalized FoxOS application manifest.'
          );
        }
      }
    }
    if (!resource.runtime.restartPolicy || resource.runtime.restartPolicy === 'no') {
      addBlocker(blockers, 'restart-policy-not-resilient', 'runtime', 'A resilient restart policy is required.');
    }
    const constraints = resource.runtime.constraints || {};
    if (!constraints.memoryBytes || !constraints.nanoCpus || !constraints.pidsLimit) {
      addBlocker(blockers, 'runtime-resource-limits-missing', 'runtime', 'CPU, memory and process limits must be explicit.');
    }
    if (constraints.privileged) {
      addBlocker(blockers, 'privileged-runtime', 'runtime', 'Privileged application runtimes cannot be finalized.');
    }
    if (!currentUpdate || !currentUpdate.healthProof || !currentUpdate.healthProof.verified) {
      addBlocker(blockers, 'foxos-health-proof-missing', 'health', 'A FoxOS-owned current health proof is required.');
    }
    if (!rollbackOperation) {
      addBlocker(blockers, 'update-rollback-proof-missing', 'updates', 'A successful FoxOS update and exact rollback proof is required.');
    }

    const desired = {
      identity: { resourceId, name: resource.name, kind: resource.kind, role: resource.role },
      source: {
        type: 'oci-image',
        requestedReference: resource.runtime.image,
        immutableReference,
        imageId: resource.runtime.imageId || null
      },
      runtime: {
        engine: resource.runtime.engine,
        desiredState: resource.runtime.state === 'running' ? 'running' : 'stopped',
        restartPolicy: resource.runtime.restartPolicy,
        constraints,
        ports: (resource.ports || []).map((port) => ({
          privatePort: port.privatePort,
          protocol: port.protocol,
          hostIp: port.hostIp || null,
          hostPort: port.hostPort || null
        }))
      },
      environment: {
        revision: environment && environment.revision || null,
        ordinaryNames: environment ? (environment.ordinary || []).map((entry) => entry.name).sort() : [],
        secretRefs: environment ? (environment.secretRefs || []).map((entry) => ({
          name: entry.name,
          secretId: entry.secretId,
          revision: entry.revision,
          keyId: entry.keyId
        })).sort((left, right) => left.name.localeCompare(right.name)) : [],
        observedVariableCount: environmentCount,
        sourceDefaultVariableCount: sourceDefaultEnvironmentCount,
        managedVariableCount: managedEnvironmentCount,
        valuesIncluded: false
      },
      persistence: {
        mounts: (resource.mounts || []).map((mount) => ({
          type: mount.type,
          name: mount.name || null,
          source: mount.source || null,
          destination: mount.destination || null,
          readOnly: Boolean(mount.readOnly)
        })),
        backupRequired: persistenceRequired,
        restoreVerificationRequired: persistenceRequired
      },
      routes: ownedRoutes.map((route) => ({
        routeId: route.routeId,
        publicUrl: route.publicUrl,
        publicPath: route.publicPath,
        tls: route.tls,
        upstream: route.upstream
      })),
      dependencies: relationships.filter((relationship) => relationship.required),
      recovery: {
        required: persistenceRequired,
        adapter: persistenceRequired ? recoveryState.adapter || null : null,
        offHost: persistenceRequired ? Boolean(recoveryState.offHost) : false,
        restoreProofReference: null
      }
    };
    const revisionId = 'arev_' + hash(canonicalJson(desired), 32);
    const evidence = {
      registrySnapshotId: snapshot.snapshotId,
      resourceFingerprint: resourceFingerprint(resource, relationships),
      observedProvider: resource.provider,
      observedContainerId: resource.runtime.containerId,
      environmentRevision: environment && environment.revision || null,
      routeIds: ownedRoutes.map((route) => route.routeId).sort(),
      healthProof: currentUpdate && currentUpdate.healthProof || null,
      updateRollbackProof: rollbackOperation ? {
        operationId: rollbackOperation.operationId,
        verified: true,
        proof: rollbackOperation.rollback.proof
      } : null,
      secretValuesIncluded: false
    };
    return {
      schemaVersion: APPLICATION_MANIFEST_SCHEMA_VERSION,
      manifestId: 'app_' + hash(resourceId, 32),
      revisionId,
      resourceId,
      lifecycle: 'import-draft',
      desired,
      provenance: {
        importedFrom: resource.provider,
        observedProject: resource.provenance.project || null,
        observedService: resource.provenance.service || null,
        providerIdentifiersRequired: false
      },
      evidence,
      gates: {
        status: blockers.length ? 'blocked' : 'ready',
        blockers: blockers.sort((left, right) => left.code.localeCompare(right.code)),
        providerDetachApproved: false,
        runtimeMutationIncluded: false
      }
    };
  }

  function createDraft(input = {}) {
    if (input.confirmation !== PLAN_APPLICATION_MANIFEST_CONFIRMATION) {
      throw new ApplicationManifestError('Exact application manifest planning confirmation is required', 400, 'confirmation-required');
    }
    const compiled = compile(input.resourceId);
    const draftId = 'adraft_' + randomUUID().replace(/-/g, '');
    const createdAt = now();
    const draft = {
      ...compiled,
      draftId,
      confirmation: applicationManifestConfirmation(draftId),
      createdAt
    };
    atomicWriteJson(recordPath(draftsRoot, draftId), draft);
    pruneJson(draftsRoot, MAX_DRAFTS);
    return draft;
  }

  function finalizeDraft(draftId, confirmation) {
    const draft = getDraft(draftId);
    if (confirmation !== draft.confirmation) {
      throw new ApplicationManifestError('Exact application manifest finalization confirmation is required', 400, 'confirmation-required');
    }
    const compiled = compile(draft.resourceId);
    if (
      compiled.evidence.resourceFingerprint !== draft.evidence.resourceFingerprint ||
      compiled.revisionId !== draft.revisionId
    ) {
      throw new ApplicationManifestError('Observed resource or desired manifest changed after planning', 409, 'manifest-draft-stale');
    }
    if (compiled.gates.blockers.length) {
      throw new ApplicationManifestError('Application manifest still has blocking safety gates', 409, 'manifest-blocked');
    }
    const finalizedAt = now();
    const manifest = {
      ...compiled,
      lifecycle: 'foxos-managed',
      gates: {
        ...compiled.gates,
        providerDetachApproved: false,
        runtimeMutationIncluded: false
      },
      finalizedFromDraftId: draftId,
      createdAt: draft.createdAt,
      finalizedAt
    };
    const revisionDirectory = path.join(revisionsRoot, manifest.manifestId);
    const revisionFile = recordPath(revisionDirectory, manifest.revisionId);
    const existing = readJson(revisionFile);
    if (existing && canonicalJson(existing.desired) !== canonicalJson(manifest.desired)) {
      throw new ApplicationManifestError('Application manifest revision hash collision', 500, 'manifest-revision-collision');
    }
    const immutableManifest = existing || manifest;
    if (!existing) atomicWriteJson(revisionFile, immutableManifest);
    atomicWriteJson(path.join(currentRoot, manifest.resourceId + '.json'), immutableManifest);
    return immutableManifest;
  }

  function status() {
    const drafts = listJson(draftsRoot);
    let current = [];
    try {
      current = fs.readdirSync(currentRoot).filter((file) => RESOURCE_ID_PATTERN.test(file.replace(/\.json$/, '')))
        .sort().map((file) => readJson(path.join(currentRoot, file))).filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      schemaVersion: APPLICATION_MANIFEST_SCHEMA_VERSION,
      authority: 'server-owned-provider-neutral',
      drafts,
      current,
      summary: {
        drafts: drafts.length,
        blockedDrafts: drafts.filter((draft) => draft.gates.status === 'blocked').length,
        finalized: current.length
      },
      guarantees: {
        runtimeMutated: false,
        providerDetached: false,
        secretValuesIncluded: false,
        externalProviderRequired: false
      }
    };
  }

  return {
    compile,
    createDraft,
    finalizeDraft,
    getCurrent,
    getDraft,
    paths: { root, draftsRoot, revisionsRoot, currentRoot },
    status
  };
}

module.exports = {
  APPLICATION_MANIFEST_SCHEMA_VERSION,
  ApplicationManifestError,
  PLAN_APPLICATION_MANIFEST_CONFIRMATION,
  applicationManifestConfirmation,
  canonicalJson,
  createApplicationManifestManager,
  resourceFingerprint
};
