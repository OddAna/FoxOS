const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const APPLICATION_MANIFEST_SCHEMA_VERSION = 2;
const PLAN_APPLICATION_MANIFEST_CONFIRMATION = 'PLAN APPLICATION MANIFEST';
const MAX_DRAFTS = 100;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const RECORD_ID_PATTERN = /^(adraft|app|arev)_[a-f0-9]{24,64}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;

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
      required: false,
      observed: true
    };
  }).sort((left, right) => left.relationshipId.localeCompare(right.relationshipId));
}

function rolledBackOperation(state, currentOperationId) {
  if (!currentOperationId) return null;
  return (state.operations || []).find((operation) => (
    operation.status === 'rolled-back' && operation.previous &&
    operation.previous.operationId === currentOperationId &&
    operation.rollback && operation.rollback.proof && operation.rollback.proof.verified
  )) || null;
}

function revisionPlan(state, revisionId) {
  return (state.plans || []).find((plan) => plan.revisionId === revisionId) || null;
}

function validPublicGitSource(source) {
  if (
    !source || source.adapter !== 'public-git-https' ||
    !GIT_COMMIT_PATTERN.test(String(source.commit || ''))
  ) return false;
  try {
    const repository = new URL(source.repository);
    return repository.protocol === 'https:' && !repository.username && !repository.password;
  } catch {
    return false;
  }
}

function sourceBuildDescriptor(current, plan, observedImageId) {
  if (
    !current || !plan || !validPublicGitSource(plan.source) ||
    canonicalJson(current.source) !== canonicalJson(plan.source) ||
    !/^drev_[a-f0-9]{24,64}$/.test(String(current.revisionId || '')) ||
    !/^dop_[a-f0-9]{24,64}$/.test(String(current.operationId || '')) ||
    !SHA256_PATTERN.test(String(current.imageId || '')) || current.imageId !== observedImageId ||
    !SHA256_PATTERN.test(String(plan.source.contextDigest || '')) ||
    !SHA256_PATTERN.test(String(plan.source.dockerfileDigest || '')) ||
    !String(plan.source.contextPath || '') || !String(plan.source.dockerfile || '')
  ) return null;
  return {
    type: 'foxos-source-build-revision',
    revisionId: current.revisionId,
    operationId: current.operationId,
    adapter: plan.source.adapter,
    repository: plan.source.repository,
    requestedRef: plan.source.ref,
    commit: plan.source.commit,
    context: {
      path: plan.source.contextPath,
      digest: plan.source.contextDigest,
      fileCount: plan.source.fileCount,
      totalBytes: plan.source.totalBytes
    },
    dockerfile: {
      path: plan.source.dockerfile,
      digest: plan.source.dockerfileDigest
    },
    build: {
      method: 'dockerfile',
      imageId: current.imageId,
      network: 'none',
      secretValuesIncluded: false
    }
  };
}

function composeBuildDescriptor(current, plan, currentService, observedImageId) {
  if (
    !current || !plan || !validPublicGitSource(plan.source) || !plan.workflow || !currentService ||
    canonicalJson(current.source) !== canonicalJson(plan.source) ||
    !RESOURCE_ID_PATTERN.test(String(current.resourceId || '')) ||
    !/^crev_[a-f0-9]{24,64}$/.test(String(current.revisionId || '')) ||
    !/^cop_[a-f0-9]{24,64}$/.test(String(current.operationId || '')) ||
    !SHA256_PATTERN.test(String(plan.source.manifestDigest || '')) ||
    !SHA256_PATTERN.test(String(plan.workflow.graphDigest || '')) ||
    currentService.imageId !== observedImageId
  ) return null;
  const graph = plan.workflow.graph;
  if (!graph || !Array.isArray(graph.services) || !Array.isArray(graph.startOrder)) return null;
  const images = new Map((current.services || []).map((service) => [service.name, service.imageId]));
  if (
    images.size !== graph.services.length ||
    graph.startOrder.length !== graph.services.length ||
    new Set(graph.startOrder).size !== graph.services.length ||
    graph.services.some((service) => (
      !images.has(service.name) || !SHA256_PATTERN.test(String(images.get(service.name) || '')) ||
      !SHA256_PATTERN.test(String(service.contextDigest || '')) ||
      !SHA256_PATTERN.test(String(service.dockerfileDigest || '')) ||
      !service.build || !String(service.build.contextPath || '') || !String(service.build.dockerfile || '') ||
      !Array.isArray(service.dependsOn)
    )) ||
    graph.startOrder.some((name) => !images.has(name))
  ) return null;
  return {
    type: 'foxos-compose-deployment-revision',
    revisionId: current.revisionId,
    operationId: current.operationId,
    groupResourceId: current.resourceId,
    adapter: plan.source.adapter,
    repository: plan.source.repository,
    requestedRef: plan.source.ref,
    commit: plan.source.commit,
    manifest: {
      path: plan.source.manifestPath,
      digest: plan.source.manifestDigest,
      bytes: plan.source.manifestBytes
    },
    graph: {
      digest: plan.workflow.graphDigest,
      ingressService: graph.ingressService,
      startOrder: [...graph.startOrder],
      services: graph.services.map((service) => ({
        name: service.name,
        dependsOn: [...service.dependsOn],
        privatePort: service.privatePort,
        context: {
          path: service.build.contextPath,
          digest: service.contextDigest,
          fileCount: service.fileCount,
          totalBytes: service.totalBytes
        },
        dockerfile: {
          path: service.build.dockerfile,
          digest: service.dockerfileDigest
        },
        imageId: images.get(service.name) || null
      }))
    },
    service: {
      name: currentService.name,
      imageId: currentService.imageId
    },
    build: {
      method: 'compose-graph',
      network: 'none',
      secretValuesIncluded: false
    }
  };
}

function workloadSourceArchiveDescriptor(revision, resourceFingerprintValue, resource) {
  if (
    !revision || revision.type !== 'foxos-encrypted-source-archive-revision' ||
    !/^wsr_[a-f0-9]{24,64}$/.test(String(revision.revisionId || '')) ||
    revision.resourceId !== resource.id || revision.resourceFingerprint !== resourceFingerprintValue ||
    revision.observedContainerId !== resource.runtime.containerId ||
    revision.observedImageId !== resource.runtime.imageId ||
    !revision.source || !['git-https-private', 'git-https-public'].includes(revision.source.adapter) ||
    !GIT_COMMIT_PATTERN.test(String(revision.source.commit || '')) ||
    !SHA256_PATTERN.test(String(revision.source.contextDigest || '')) ||
    !SHA256_PATTERN.test(String(revision.source.dockerfileDigest || '')) ||
    !revision.archive || !SHA256_PATTERN.test(String(revision.archive.digest || '')) ||
    !SHA256_PATTERN.test(String(revision.archive.encryptedDigest || '')) ||
    revision.archive.authenticated !== true || revision.archive.plaintextIncluded !== false ||
    !revision.archive.verification || revision.archive.verification.verified !== true ||
    revision.externalGitRequiredToReconstructRevision !== false
  ) return null;
  const credential = revision.source.credential ? {
    username: revision.source.credential.username,
    secretId: revision.source.credential.secretId,
    revision: revision.source.credential.revision,
    keyId: revision.source.credential.keyId,
    valueIncluded: false
  } : null;
  return {
    type: 'foxos-encrypted-source-archive-revision',
    revisionId: revision.revisionId,
    adapter: revision.source.adapter,
    repository: revision.source.repository,
    requestedRef: revision.source.ref,
    commit: revision.source.commit,
    context: {
      path: revision.source.contextPath,
      digest: revision.source.contextDigest,
      fileCount: revision.source.fileCount,
      totalBytes: revision.source.totalBytes
    },
    dockerfile: {
      path: revision.source.dockerfile,
      digest: revision.source.dockerfileDigest
    },
    credential,
    archive: {
      localReference: revision.archive.file,
      digest: revision.archive.digest,
      bytes: revision.archive.bytes,
      encryptedDigest: revision.archive.encryptedDigest,
      encryptedBytes: revision.archive.encryptedBytes,
      algorithm: revision.archive.algorithm,
      keyId: revision.archive.keyId,
      authenticated: true,
      plaintextIncluded: false,
      externalGitRequiredToReconstructRevision: false
    },
    runtimeBinding: revision.runtimeBinding,
    build: {
      method: 'dockerfile',
      observedImageId: resource.runtime.imageId,
      imageBindingVerified: Boolean(revision.runtimeBinding && revision.runtimeBinding.verified),
      secretValuesIncluded: false
    }
  };
}

function resourceFingerprint(resource, relationships) {
  return 'sha256:' + hash(canonicalJson({ resource, relationships }), 64);
}

function statefulRehearsalResourceFingerprint(resource) {
  return 'sha256:' + hash(canonicalJson({
    schemaVersion: resource.schemaVersion,
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    role: resource.role,
    ownership: resource.ownership,
    provider: resource.provider,
    protected: resource.protected,
    classification: resource.classification && {
      revision: resource.classification.revision,
      workloadRole: resource.classification.workloadRole,
      stateClass: resource.classification.stateClass,
      authorityClass: resource.classification.authorityClass,
      status: resource.classification.status
    },
    runtime: resource.runtime && {
      containerId: resource.runtime.containerId,
      image: resource.runtime.image,
      imageId: resource.runtime.imageId,
      state: resource.runtime.state,
      restartPolicy: resource.runtime.restartPolicy,
      healthConfigured: Boolean(resource.runtime.health && resource.runtime.health.configured),
      constraints: resource.runtime.constraints,
      environmentVariableCount: resource.runtime.environmentVariableCount,
      inspection: resource.runtime.inspection
    },
    ports: resource.ports,
    mounts: resource.mounts
  }), 64);
}

function statefulRestoreProofDescriptor(operation, rehearsalResourceFingerprintValue, resource) {
  const routeRehearsal = operation && operation.routeRehearsal || null;
  const coupledCutoverRehearsalProven = Boolean(
    operation && operation.mode === 'reversible-route-cutover' && routeRehearsal &&
    routeRehearsal.status === 'inactive' && routeRehearsal.rollbackVerified === true &&
    routeRehearsal.sourceRemainedPausedThroughRollback === true &&
    routeRehearsal.coupledCutoverRehearsalProven === true &&
    routeRehearsal.productionTrafficCutover === false &&
    routeRehearsal.finalSynchronizationProven === false &&
    routeRehearsal.activationProof && routeRehearsal.activationProof.verified === true &&
    routeRehearsal.removalProof && routeRehearsal.removalProof.verified === true
  );
  const restoreOnly = operation && (operation.mode === undefined || operation.mode === 'restore-only');
  if (
    !operation || operation.status !== 'verified-and-cleaned' ||
    operation.resourceId !== resource.id ||
    operation.rehearsalResourceFingerprint !== rehearsalResourceFingerprintValue ||
    !operation.source || operation.source.containerId !== resource.runtime.containerId ||
    operation.source.imageId !== resource.runtime.imageId ||
    operation.source.stopped !== false || operation.source.recreated !== false ||
    operation.source.pauseState !== 'unpaused' ||
    !operation.source.healthAfterProof || operation.source.healthAfterProof.status !== 'running' ||
    operation.source.healthAfterProof.paused !== false ||
    !operation.restore || operation.restore.verified !== true ||
    !Array.isArray(operation.backups) || operation.backups.length < 1 ||
    operation.backups.some((backup) => (
      backup.authenticated !== true || backup.plaintextStored !== false || backup.offHost !== false
    )) ||
    !operation.candidate || operation.candidate.health !== 'healthy' ||
    operation.candidate.internalNetwork !== true || operation.candidate.externalNetwork !== false ||
    operation.candidate.hostBinding !== 'none' ||
    !['docker-healthcheck', 'internal-http'].includes(operation.candidate.healthMode) ||
    operation.candidate.hostPortPublished !== false ||
    (operation.candidate.healthMode === 'internal-http' &&
      operation.candidate.healthProbe !== 'host-namespace-to-internal-ip') ||
    (operation.candidate.healthMode === 'docker-healthcheck' && operation.source.healthAfterProof.health !== 'healthy') ||
    operation.candidate.removedAfterProof !== true ||
    !operation.cleanup || operation.cleanup.completed !== true ||
    !operation.guarantees ||
    !(
      (restoreOnly && operation.guarantees.routeMutated === false) ||
      (coupledCutoverRehearsalProven && operation.guarantees.routeMutated === true &&
        operation.guarantees.foxosCanaryTrafficCutover === true &&
        operation.guarantees.productionTrafficCutover === false &&
        operation.guarantees.finalSynchronizationProven === false &&
        operation.guarantees.coupledCutoverRehearsalProven === true)
    ) ||
    operation.guarantees.trafficCutover !== false ||
    operation.guarantees.providerMetadataMutated !== false ||
    operation.guarantees.providerDetached !== false ||
    operation.guarantees.candidateHadExternalNetwork !== false ||
    operation.guarantees.candidateHostPortPublished !== false ||
    operation.guarantees.environmentValuesIncluded !== false ||
    operation.guarantees.secretValuesIncluded !== false ||
    operation.guarantees.plaintextArchiveStored !== false
  ) return null;
  return {
    type: 'foxos-stateful-restore-rehearsal',
    operationId: operation.operationId,
    planId: operation.planId,
    resourceId: operation.resourceId,
    volumeCount: operation.backups.length,
    restoredVolumeCount: (operation.restore.volumes || []).filter((volume) => volume.verified).length,
    candidateHealth: operation.candidate.health,
    candidateHealthMode: operation.candidate.healthMode,
    candidateRemovedAfterProof: true,
    coupledCutoverRehearsalProven,
    foxosCanaryRouteRolledBack: coupledCutoverRehearsalProven,
    productionTrafficCutover: false,
    finalSynchronizationProven: false,
    sourcePauseDurationMs: operation.source.pauseDurationMs,
    localEncryptedArchive: true,
    offHost: false,
    offHostRecoveryProven: false,
    environmentValuesIncluded: false,
    secretValuesIncluded: false,
    verifiedAt: operation.completedAt
  };
}

function statefulShadowProofDescriptor(operation, rehearsalResourceFingerprintValue, resource) {
  const limits = operation && operation.runtimeLimits || {};
  const refresh = operation && operation.refresh || null;
  if ((operation && operation.action === 'refresh') !== Boolean(refresh)) return null;
  if (
    !operation || operation.status !== 'active' ||
    operation.sourceResourceId !== resource.id ||
    operation.sourceResourceFingerprint !== rehearsalResourceFingerprintValue ||
    !RESOURCE_ID_PATTERN.test(String(operation.shadowResourceId)) || operation.shadowResourceId === resource.id ||
    !operation.source || operation.source.containerId !== resource.runtime.containerId ||
    operation.source.imageId !== resource.runtime.imageId || operation.source.mutated !== false ||
    operation.source.paused !== false || operation.source.stopped !== false || operation.source.recreated !== false ||
    !operation.shadow || !operation.shadow.containerId || !operation.shadow.health || operation.shadow.health.verified !== true ||
    operation.shadow.internalNetworkVerified !== true || operation.shadow.hostPortPublished !== false ||
    operation.shadow.externalNetwork !== false || operation.shadow.routeCreated !== false ||
    !Array.isArray(operation.shadow.volumesRestored) || operation.shadow.volumesRestored.length < 1 ||
    operation.shadow.volumesRestored.some((volume) => volume.restored !== true) ||
    !operation.registryProof || operation.registryProof.verified !== true ||
    operation.registryProof.resourceId !== operation.shadowResourceId ||
    operation.registryProof.containerId !== operation.shadow.containerId ||
    !Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes < 1 ||
    !Number.isSafeInteger(limits.nanoCpus) || limits.nanoCpus < 1 ||
    !Number.isSafeInteger(limits.pidsLimit) || limits.pidsLimit < 1 ||
    !operation.guarantees || operation.guarantees.sourceMutationIncluded !== false ||
    operation.guarantees.sourcePauseIncluded !== false || operation.guarantees.sourceStopIncluded !== false ||
    operation.guarantees.sourceRecreationIncluded !== false ||
    operation.guarantees.sourceIdentityClaimed !== false || operation.guarantees.separateFoxOSIdentity !== true ||
    operation.guarantees.internalNetworkOnly !== true || operation.guarantees.hostPortPublished !== false ||
    operation.guarantees.externalNetworkIncluded !== false || operation.guarantees.routeCreated !== false ||
    operation.guarantees.trafficCutover !== false || operation.guarantees.providerMutationIncluded !== false ||
    operation.guarantees.providerDetachIncluded !== false || operation.guarantees.environmentValuesIncluded !== false ||
    operation.guarantees.secretValuesIncluded !== false ||
    (refresh && (
      refresh.newerSnapshotVerified !== true || refresh.inPlaceVolumeMutation !== false ||
      refresh.finalSynchronizationProven !== false || refresh.sourceWritesMayContinueAfterSnapshot !== true
    ))
  ) return null;
  return {
    type: 'foxos-persistent-stateful-shadow',
    operationId: operation.operationId,
    planId: operation.planId,
    sourceResourceId: operation.sourceResourceId,
    shadowResourceId: operation.shadowResourceId,
    shadowContainerId: operation.shadow.containerId,
    healthProof: {
      ...operation.shadow.health,
      type: 'foxos-persistent-stateful-shadow-health',
      verified: true,
      containerId: operation.shadow.containerId,
      resourceId: operation.shadowResourceId
    },
    runtimeLimits: {
      memoryBytes: limits.memoryBytes,
      nanoCpus: limits.nanoCpus,
      pidsLimit: limits.pidsLimit
    },
    restartPolicy: 'unless-stopped',
    internalNetworkOnly: true,
    hostPortPublished: false,
    trafficCutover: false,
    providerDetached: false,
    localSnapshot: true,
    pointInTimeSnapshot: true,
    refresh: refresh ? {
      previousRehearsalOperationId: refresh.previousRehearsalOperationId,
      rehearsalOperationId: refresh.rehearsalOperationId,
      previousSnapshotAt: refresh.previousSnapshotAt,
      snapshotAt: refresh.snapshotAt,
      newerSnapshotVerified: true,
      inPlaceVolumeMutation: false,
      finalSynchronizationProven: false,
      sourceWritesMayContinueAfterSnapshot: true
    } : null,
    finalSynchronizationProven: false,
    offHostRecoveryProven: false,
    verifiedAt: operation.completedAt
  };
}

function createApplicationManifestManager({
  dataRoot,
  resourceRegistry,
  getEnvironmentRevision = () => null,
  routeStatus = () => ({ configured: false, routes: [] }),
  backupStatus = () => ({ configured: false, ready: false, adapter: null, offHost: false }),
  sourceDeploymentStatus = () => ({ current: null, plans: [], operations: [], guarantees: {} }),
  composeDeploymentStatus = () => ({ current: null, plans: [], operations: [], guarantees: {} }),
  imageUpdateStatus = () => ({ current: null, operations: [] }),
  workloadEvidenceStatus = () => ({ sourceCurrent: [], guarantees: {} }),
  statefulRehearsalStatus = () => ({ current: [], guarantees: {} }),
  statefulShadowStatus = () => ({ current: [], guarantees: {} }),
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (!dataRoot || !resourceRegistry || typeof resourceRegistry.getLatest !== 'function') {
    throw new Error('Application manifest manager requires a data root and resource registry');
  }
  for (const dependency of [
    getEnvironmentRevision,
    routeStatus,
    backupStatus,
    sourceDeploymentStatus,
    composeDeploymentStatus,
    imageUpdateStatus,
    workloadEvidenceStatus,
    statefulRehearsalStatus,
    statefulShadowStatus
  ]) {
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
    const classification = resource.classification || null;
    const relationships = relatedRelationships(snapshot, resourceId);
    const environment = getEnvironmentRevision(resourceId);
    const routeState = routeStatus();
    const recoveryState = backupStatus();
    const sourceDeploymentState = sourceDeploymentStatus();
    const composeDeploymentState = composeDeploymentStatus();
    const updateState = imageUpdateStatus();
    const workloadEvidenceState = workloadEvidenceStatus();
    const statefulRehearsalState = statefulRehearsalStatus();
    const statefulShadowState = statefulShadowStatus();
    const currentResourceFingerprintValue = resourceFingerprint(resource, relationships);
    const restoreProof = statefulRestoreProofDescriptor(
      (statefulRehearsalState.current || []).find((operation) => operation.resourceId === resourceId),
      statefulRehearsalResourceFingerprint(resource),
      resource
    );
    const shadowProof = statefulShadowProofDescriptor(
      (statefulShadowState.current || []).find((operation) => operation.sourceResourceId === resourceId),
      statefulRehearsalResourceFingerprint(resource),
      resource
    );
    const ownedRoutes = (routeState.routes || []).filter((route) => (
      route.resourceId === resourceId && route.owner === 'foxos' && route.status === 'active'
    ));
    const environmentCount = resource.runtime.environmentVariableCount;
    const currentSourceDeployment = sourceDeploymentState.current &&
      sourceDeploymentState.current.resourceId === resourceId &&
      sourceDeploymentState.current.containerId === resource.runtime.containerId
      ? sourceDeploymentState.current : null;
    const currentComposeService = composeDeploymentState.current &&
      (composeDeploymentState.current.services || []).find((service) => (
        service.containerId === resource.runtime.containerId
      ));
    const currentComposeDeployment = currentComposeService ? composeDeploymentState.current : null;
    const currentUpdate = updateState.current && updateState.current.resourceId === resourceId &&
      updateState.current.containerId === resource.runtime.containerId ? updateState.current : null;
    const workloadSourceRevision = (workloadEvidenceState.sourceCurrent || []).find((revision) => (
      revision.resourceId === resourceId
    )) || null;
    const sourcePlan = currentSourceDeployment
      ? revisionPlan(sourceDeploymentState, currentSourceDeployment.revisionId) : null;
    const composePlan = currentComposeDeployment
      ? revisionPlan(composeDeploymentState, currentComposeDeployment.revisionId) : null;
    let source = null;
    let sourceAuthority = 'oci-image';
    let healthProof = null;
    let rollbackOperation = null;
    let sourceGuarantees = {};
    const sourceBlockers = [];
    const composeDependencies = [];

    if (currentComposeDeployment) {
      sourceAuthority = 'foxos-compose-deployment';
      source = composeBuildDescriptor(
        currentComposeDeployment,
        composePlan,
        currentComposeService,
        resource.runtime.imageId
      );
      healthProof = currentComposeDeployment.healthProof || null;
      rollbackOperation = rolledBackOperation(composeDeploymentState, currentComposeDeployment.operationId);
      sourceGuarantees = composeDeploymentState.guarantees || {};
      if (!source) {
        sourceBlockers.push({
          code: 'foxos-compose-revision-missing',
          section: 'source',
          message: 'The active Compose service has no complete immutable FoxOS graph revision.'
        });
      } else {
        const servicePlan = source.graph.services.find((service) => service.name === currentComposeService.name);
        for (const dependencyName of servicePlan ? servicePlan.dependsOn : []) {
          const dependencyService = (currentComposeDeployment.services || []).find((service) => (
            service.name === dependencyName
          ));
          const dependencyResource = dependencyService && (snapshot.resources || []).find((candidate) => (
            candidate.runtime.containerId === dependencyService.containerId
          ));
          if (!dependencyResource) {
            sourceBlockers.push({
              code: 'compose-dependency-resource-missing:' + dependencyName,
              section: 'dependencies',
              message: 'A Compose graph dependency has no current FoxOS resource identity.'
            });
            continue;
          }
          composeDependencies.push({
            relationshipId: 'mrel_' + hash(
              currentComposeDeployment.revisionId + ':' + resourceId + ':' + dependencyResource.id,
              24
            ),
            type: 'compose-depends-on',
            sourceResourceId: resourceId,
            targetResourceId: dependencyResource.id,
            resourceIds: [resourceId, dependencyResource.id].sort(),
            required: true,
            observed: false
          });
        }
      }
    } else if (currentSourceDeployment) {
      sourceAuthority = 'foxos-source-deployment';
      source = sourceBuildDescriptor(currentSourceDeployment, sourcePlan, resource.runtime.imageId);
      healthProof = currentSourceDeployment.healthProof || null;
      rollbackOperation = rolledBackOperation(sourceDeploymentState, currentSourceDeployment.operationId);
      sourceGuarantees = sourceDeploymentState.guarantees || {};
      if (!source) {
        sourceBlockers.push({
          code: 'foxos-source-revision-missing',
          section: 'source',
          message: 'The active source deployment has no complete immutable FoxOS build revision.'
        });
      }
    } else if (currentUpdate) {
      sourceAuthority = 'foxos-image-update';
      const immutableReference = immutableImageFor(resource, snapshot);
      source = {
        type: 'oci-image',
        requestedReference: resource.runtime.image,
        immutableReference,
        imageId: resource.runtime.imageId || null
      };
      healthProof = currentUpdate.healthProof || null;
      rollbackOperation = rolledBackOperation(updateState, currentUpdate.operationId);
      sourceGuarantees = updateState.guarantees || {};
      if (!immutableReference) {
        sourceBlockers.push({
          code: 'immutable-image-missing',
          section: 'source',
          message: 'No repository digest can reconstruct this image immutably.'
        });
      }
    } else if (workloadSourceRevision) {
      sourceAuthority = 'foxos-workload-source-archive';
      source = workloadSourceArchiveDescriptor(
        workloadSourceRevision,
        currentResourceFingerprintValue,
        resource
      );
      sourceGuarantees = workloadEvidenceState.guarantees || {};
      if (!source) {
        sourceBlockers.push({
          code: 'foxos-source-archive-invalid',
          section: 'source',
          message: 'The server-owned workload source archive is missing, stale or cannot be authenticated.'
        });
      } else if (!source.runtimeBinding || !source.runtimeBinding.verified) {
        sourceBlockers.push({
          code: 'source-runtime-binding-missing',
          section: 'source',
          message: 'The encrypted source revision has not yet been built and bound to the observed runtime image by FoxOS.'
        });
      }
    } else {
      const immutableReference = immutableImageFor(resource, snapshot);
      source = {
        type: 'oci-image',
        requestedReference: resource.runtime.image,
        immutableReference,
        imageId: resource.runtime.imageId || null
      };
      if (!immutableReference) {
        sourceBlockers.push({
          code: 'immutable-image-missing',
          section: 'source',
          message: 'No repository digest can reconstruct this image immutably.'
        });
      }
    }
    const imageDefaultEnvironmentOnly = Boolean(
      (currentUpdate || currentSourceDeployment || currentComposeDeployment) &&
      sourceGuarantees.environmentSupported === false
    );
    const excludedEnvironment = environment ? environment.excluded || [] : [];
    const excludedEnvironmentCount = excludedEnvironment.length;
    const managedEnvironmentCount = imageDefaultEnvironmentOnly
      ? 0
      : Math.max(0, Number(environmentCount || 0) - excludedEnvironmentCount);
    const sourceDefaultEnvironmentCount = imageDefaultEnvironmentOnly ? environmentCount : 0;
    const classifiedCount = environment
      ? (environment.ordinary || []).length + (environment.secretRefs || []).length
      : 0;
    const persistenceRequired = (resource.mounts || []).length > 0;
    for (const blocker of sourceBlockers) {
      addBlocker(blockers, blocker.code, blocker.section, blocker.message);
    }

    if (!classification || classification.status !== 'classified' || !classification.revision) {
      addBlocker(
        blockers,
        'workload-classification-incomplete',
        'classification',
        'A complete deterministic workload role and state classification is required.'
      );
    } else if (!['application', 'internal-service'].includes(classification.workloadRole)) {
      addBlocker(
        blockers,
        'workload-role-lifecycle-unsupported',
        'classification',
        'This workload role needs a dedicated lifecycle contract before manifest finalization.'
      );
    }
    if (classification && classification.stateClass === 'database') {
      addBlocker(
        blockers,
        'database-lifecycle-unsupported',
        'classification',
        'Database-consistent backup, restore and lifecycle evidence is not implemented.'
      );
    }
    if (resource.protected) addBlocker(blockers, 'foxos-core-protected', 'ownership', 'FoxOS core resources cannot become application manifests.');
    if (resource.provider !== 'foxos' || resource.ownership !== 'foxos-managed') {
      addBlocker(blockers, 'external-provider-authority', 'ownership', 'The current runtime is still authoritative outside FoxOS.');
    }
    if (resource.runtime.inspection !== 'complete') {
      addBlocker(blockers, 'inspection-incomplete', 'runtime', 'Complete Docker inspection is required.');
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
      if (!restoreProof) {
        addBlocker(blockers, 'restore-proof-missing', 'recovery', 'Persistent data requires a resource-scoped tested restore proof.');
      }
    }
    const dependencies = [...relationships, ...composeDependencies].sort((left, right) => (
      left.relationshipId.localeCompare(right.relationshipId)
    ));
    for (const relationship of dependencies.filter((candidate) => candidate.required)) {
      for (const dependencyId of relationship.resourceIds.filter((candidate) => candidate !== resourceId)) {
        const dependencyManifest = getCurrent(dependencyId);
        if (!dependencyManifest) {
          addBlocker(
            blockers,
            'dependency-manifest-missing:' + dependencyId,
            'dependencies',
            'A related resource has no finalized FoxOS application manifest.'
          );
          continue;
        }
        const dependencyResource = (snapshot.resources || []).find((candidate) => candidate.id === dependencyId);
        const dependencyRelationships = dependencyResource
          ? relatedRelationships(snapshot, dependencyId) : [];
        if (
          !dependencyResource ||
          dependencyManifest.evidence.resourceFingerprint !==
            resourceFingerprint(dependencyResource, dependencyRelationships)
        ) {
          addBlocker(
            blockers,
            'dependency-manifest-stale:' + dependencyId,
            'dependencies',
            'A related resource manifest no longer matches the latest observed resource.'
          );
        }
      }
    }
    const restartPolicy = shadowProof ? shadowProof.restartPolicy : resource.runtime.restartPolicy;
    if (!restartPolicy || restartPolicy === 'no') {
      addBlocker(blockers, 'restart-policy-not-resilient', 'runtime', 'A resilient restart policy is required.');
    }
    const observedConstraints = resource.runtime.constraints || {};
    const constraints = shadowProof ? {
      ...observedConstraints,
      privileged: false,
      noNewPrivileges: true,
      memoryBytes: shadowProof.runtimeLimits.memoryBytes,
      nanoCpus: shadowProof.runtimeLimits.nanoCpus,
      pidsLimit: shadowProof.runtimeLimits.pidsLimit
    } : observedConstraints;
    if (!constraints.memoryBytes || !constraints.nanoCpus || !constraints.pidsLimit) {
      addBlocker(blockers, 'runtime-resource-limits-missing', 'runtime', 'CPU, memory and process limits must be explicit.');
    }
    if (constraints.privileged) {
      addBlocker(blockers, 'privileged-runtime', 'runtime', 'Privileged application runtimes cannot be finalized.');
    }
    if (!healthProof && shadowProof) healthProof = shadowProof.healthProof;
    if (!healthProof || !healthProof.verified) {
      addBlocker(blockers, 'foxos-health-proof-missing', 'health', 'A FoxOS-owned current health proof is required.');
    }
    if (!rollbackOperation) {
      addBlocker(blockers, 'update-rollback-proof-missing', 'updates', 'A successful FoxOS update and exact rollback proof is required.');
    }

    const desired = {
      identity: {
        resourceId,
        name: resource.name,
        kind: resource.kind,
        role: resource.role,
        classification: classification ? {
          schemaVersion: classification.schemaVersion,
          revision: classification.revision,
          workloadRole: classification.workloadRole,
          stateClass: classification.stateClass,
          authorityClass: classification.authorityClass,
          status: classification.status,
          evidence: classification.evidence,
          warnings: classification.warnings
        } : null
      },
      source,
      runtime: {
        engine: resource.runtime.engine,
        desiredState: resource.runtime.state === 'running' ? 'running' : 'stopped',
        restartPolicy,
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
        excluded: excludedEnvironment.map((entry) => ({
          name: entry.name,
          reason: entry.reason
        })).sort((left, right) => left.name.localeCompare(right.name)),
        observedVariableCount: environmentCount,
        sourceDefaultVariableCount: sourceDefaultEnvironmentCount,
        managedVariableCount: managedEnvironmentCount,
        excludedProviderVariableCount: excludedEnvironmentCount,
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
      dependencies,
      recovery: {
        required: persistenceRequired,
        adapter: persistenceRequired ? recoveryState.adapter || null : null,
        offHost: persistenceRequired ? Boolean(recoveryState.offHost) : false,
        restoreProofReference: persistenceRequired && restoreProof ? {
          type: restoreProof.type,
          operationId: restoreProof.operationId,
          verifiedAt: restoreProof.verifiedAt,
          localOnly: true
        } : null
      }
    };
    const revisionId = 'arev_' + hash(canonicalJson(desired), 32);
    const evidence = {
      registrySnapshotId: snapshot.snapshotId,
      resourceFingerprint: currentResourceFingerprintValue,
      observedProvider: resource.provider,
      observedContainerId: resource.runtime.containerId,
      environmentRevision: environment && environment.revision || null,
      routeIds: ownedRoutes.map((route) => route.routeId).sort(),
      sourceAuthority,
      classificationRevision: classification && classification.revision || null,
      sourceRevision: source && source.type !== 'oci-image' ? {
        type: source.type,
        revisionId: source.revisionId,
        operationId: source.operationId,
        groupResourceId: source.groupResourceId || null,
        serviceName: source.service && source.service.name || null
      } : null,
      healthProof,
      updateRollbackProof: rollbackOperation ? {
        operationId: rollbackOperation.operationId,
        verified: true,
        proof: rollbackOperation.rollback.proof
      } : null,
      restoreProof,
      statefulShadowProof: shadowProof,
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
        externalProviderRequired: false,
        sourceTypes: [
          'oci-image',
          'foxos-source-build-revision',
          'foxos-compose-deployment-revision',
          'foxos-encrypted-source-archive-revision'
        ],
        composeDependencies: 'directed-depends-on-only',
        sharedNetworkImpliesDependency: false,
        classificationRequired: true,
        supportedWorkloadRoles: ['application', 'internal-service'],
        databaseLifecycleSupported: false
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
  relatedRelationships,
  resourceFingerprint,
  statefulRehearsalResourceFingerprint,
  statefulRestoreProofDescriptor,
  statefulShadowProofDescriptor
};
