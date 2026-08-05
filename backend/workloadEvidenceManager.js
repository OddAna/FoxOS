const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { relatedRelationships, resourceFingerprint } = require('./applicationManifestManager');
const { atomicWriteJson } = require('./resourceRegistry');
const { isSensitiveEnvironmentName, validateEnvironmentName } = require('./secretManager');
const {
  createGitSourceAdapter,
  validateGitRef,
  validateRelativePath,
  validateRepositoryUrl
} = require('./sourceDeploymentManager');

const WORKLOAD_EVIDENCE_SCHEMA_VERSION = 1;
const PLAN_SOURCE_CONFIRMATION = 'PLAN WORKLOAD SOURCE EVIDENCE';
const PLAN_ENVIRONMENT_CONFIRMATION = 'PLAN WORKLOAD ENVIRONMENT EVIDENCE';
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const RECORD_ID_PATTERN = /^(wsp|wsr|wep|wec)_[a-f0-9]{24,64}$/;
const MAX_RECORDS = 100;

class WorkloadEvidenceError extends Error {
  constructor(message, statusCode = 400, code = 'workload-evidence-error') {
    super(message);
    this.name = 'WorkloadEvidenceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hash(value, length = 64) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
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

function pruneJson(directory, maximum = MAX_RECORDS) {
  const records = listJson(directory).sort((left, right) => (
    String(left.createdAt || left.capturedAt || '').localeCompare(String(right.createdAt || right.capturedAt || '')) ||
    String(left.planId || left.revisionId || left.captureId || '').localeCompare(
      String(right.planId || right.revisionId || right.captureId || '')
    )
  ));
  for (const record of records.slice(0, Math.max(0, records.length - maximum))) {
    const id = record.planId || record.revisionId || record.captureId;
    if (id && RECORD_ID_PATTERN.test(id)) fs.unlinkSync(path.join(directory, id + '.json'));
  }
}

function sourceCaptureConfirmation(planId) {
  return 'CAPTURE WORKLOAD SOURCE ' + planId;
}

function environmentCaptureConfirmation(planId) {
  return 'CAPTURE WORKLOAD ENVIRONMENT ' + planId;
}

function validateUsername(value) {
  const username = String(value || '').trim();
  if (!username || username.length > 128 || /[\r\n\0]/.test(username)) {
    throw new WorkloadEvidenceError('Private Git username is invalid', 400, 'invalid-git-username');
  }
  return username;
}

function parseEnvironment(entries) {
  if (!Array.isArray(entries)) {
    throw new WorkloadEvidenceError('Docker environment inspection is incomplete', 409, 'environment-inspection-incomplete');
  }
  const values = new Map();
  for (const rawEntry of entries) {
    const entry = String(rawEntry);
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new WorkloadEvidenceError('Docker environment contains an invalid entry', 409, 'invalid-observed-environment');
    }
    const name = validateEnvironmentName(entry.slice(0, separator));
    if (values.has(name)) {
      throw new WorkloadEvidenceError('Docker environment contains duplicate names', 409, 'duplicate-observed-environment');
    }
    values.set(name, entry.slice(separator + 1));
  }
  return values;
}

function redactedEnvironment(record) {
  if (!record) return null;
  return {
    schemaVersion: record.schemaVersion,
    resourceId: record.resourceId,
    revision: record.revision,
    ordinaryNames: (record.ordinary || []).map((entry) => entry.name).sort(),
    secretRefs: (record.secretRefs || []).map((entry) => ({
      name: entry.name,
      secretId: entry.secretId,
      revision: entry.revision,
      keyId: entry.keyId
    })).sort((left, right) => left.name.localeCompare(right.name)),
    variableCount: (record.ordinary || []).length + (record.secretRefs || []).length,
    secretValuesIncluded: false,
    ordinaryValuesIncluded: false,
    createdAt: record.createdAt
  };
}

function createWorkloadEvidenceManager({
  dataRoot,
  dockerRequest,
  resourceRegistry,
  encryptionStore,
  secretManager,
  sourceAdapter = null,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || !resourceRegistry ||
    typeof resourceRegistry.getLatest !== 'function' || !encryptionStore || !secretManager
  ) {
    throw new Error('Workload evidence manager requires registry, Docker, encryption and secret adapters');
  }

  const gitSourceAdapter = sourceAdapter || createGitSourceAdapter({
    enforceBuildPolicy: false,
    resolveCredential: async (credential) => ({
      username: credential.username,
      password: secretManager.resolveSecret(credential.secretId, credential.revision)
    })
  });
  const root = path.join(dataRoot, 'workload-evidence');
  const sourcePlansRoot = path.join(root, 'source-plans');
  const sourceRevisionsRoot = path.join(root, 'source-revisions');
  const sourceCurrentRoot = path.join(root, 'source-current');
  const sourceArchivesRoot = path.join(root, 'source-archives');
  const environmentPlansRoot = path.join(root, 'environment-plans');
  const environmentCapturesRoot = path.join(root, 'environment-captures');
  const environmentCurrentRoot = path.join(root, 'environment-current');

  function now() {
    return new Date(clock()).toISOString();
  }

  function recordPath(directory, id) {
    if (!RECORD_ID_PATTERN.test(String(id))) {
      throw new WorkloadEvidenceError('Workload evidence record ID is invalid', 400, 'invalid-evidence-record-id');
    }
    return path.join(directory, id + '.json');
  }

  function getRecord(directory, id, label) {
    const record = readJson(recordPath(directory, id));
    if (!record) throw new WorkloadEvidenceError(label + ' was not found', 404, 'evidence-record-not-found');
    return record;
  }

  function latestSnapshotResource(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId))) {
      throw new WorkloadEvidenceError('FoxOS resource ID is invalid', 400, 'invalid-resource-id');
    }
    const snapshot = resourceRegistry.getLatest();
    if (!snapshot) throw new WorkloadEvidenceError('Run a resource scan first', 409, 'registry-not-scanned');
    const resource = (snapshot.resources || []).find((candidate) => candidate.id === resourceId);
    if (!resource) throw new WorkloadEvidenceError('Resource was not found', 404, 'resource-not-found');
    return { snapshot, resource };
  }

  function candidate(resource) {
    const audit = resource.classification && resource.classification.independenceAudit;
    if (!audit || !audit.eligibleForReadOnlyAudit) {
      throw new WorkloadEvidenceError(
        'Only a running, fully inspected provider-owned stateless application can capture workload evidence',
        409,
        'not-a-stateless-application-candidate'
      );
    }
  }

  function currentFingerprint(snapshot, resource) {
    return resourceFingerprint(resource, relatedRelationships(snapshot, resource.id));
  }

  function getSourceRevision(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId))) {
      throw new WorkloadEvidenceError('FoxOS resource ID is invalid', 400, 'invalid-resource-id');
    }
    const revision = readJson(path.join(sourceCurrentRoot, resourceId + '.json'));
    if (!revision) return null;
    let verification = { verified: false, code: 'source-archive-unavailable' };
    try {
      const archiveFile = path.resolve(dataRoot, revision.archive && revision.archive.file || '');
      const archiveRoot = path.resolve(sourceArchivesRoot);
      if (archiveFile !== archiveRoot && !archiveFile.startsWith(archiveRoot + path.sep)) {
        throw new Error('source-archive-path-invalid');
      }
      const encrypted = fs.readFileSync(archiveFile);
      if ('sha256:' + hash(encrypted) !== revision.archive.encryptedDigest) {
        throw new Error('source-archive-ciphertext-drift');
      }
      const context = {
        purpose: 'foxos-workload-source-archive',
        schemaVersion: WORKLOAD_EVIDENCE_SCHEMA_VERSION,
        resourceId: revision.resourceId,
        revisionId: revision.revisionId
      };
      const archive = encryptionStore.decryptBuffer(encrypted, context);
      if ('sha256:' + hash(archive) !== revision.archive.digest) {
        throw new Error('source-archive-plaintext-drift');
      }
      verification = { verified: true, code: 'source-archive-authenticated' };
    } catch (error) {
      verification = { verified: false, code: error.code || error.message || 'source-archive-verification-failed' };
    }
    return {
      ...revision,
      archive: { ...revision.archive, verification }
    };
  }

  function getEnvironmentCapture(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId))) {
      throw new WorkloadEvidenceError('FoxOS resource ID is invalid', 400, 'invalid-resource-id');
    }
    return readJson(path.join(environmentCurrentRoot, resourceId + '.json'));
  }

  async function planSource(input = {}) {
    if (input.confirmation !== PLAN_SOURCE_CONFIRMATION) {
      throw new WorkloadEvidenceError('Exact workload source planning confirmation is required', 400, 'confirmation-required');
    }
    const { snapshot, resource } = latestSnapshotResource(input.resourceId);
    candidate(resource);
    const repository = validateRepositoryUrl(input.repository);
    const ref = validateGitRef(input.ref);
    const contextPath = validateRelativePath(input.contextPath, '.');
    const dockerfile = validateRelativePath(input.dockerfile, 'Dockerfile');
    let credential = null;
    if (input.credentialSecret) {
      const secret = secretManager.getSecretByName(input.credentialSecret);
      credential = {
        username: validateUsername(input.username),
        secretId: secret.secretId,
        revision: secret.revision,
        keyId: secret.keyId,
        valueIncluded: false
      };
    } else if (input.username) {
      throw new WorkloadEvidenceError('Git username requires an encrypted credential secret', 400, 'git-credential-missing');
    }
    const inspected = await gitSourceAdapter.inspect({ repository, ref, contextPath, dockerfile, credential });
    const source = {
      adapter: credential ? 'git-https-private' : 'git-https-public',
      repository,
      ref,
      refType: inspected.refType,
      commit: inspected.commit,
      contextPath,
      dockerfile,
      contextDigest: inspected.contextDigest,
      dockerfileDigest: inspected.dockerfileDigest,
      fileCount: inspected.fileCount,
      totalBytes: inspected.totalBytes,
      credential
    };
    const planId = 'wsp_' + randomUUID().replace(/-/g, '');
    const plan = {
      schemaVersion: WORKLOAD_EVIDENCE_SCHEMA_VERSION,
      planId,
      resourceId: resource.id,
      registrySnapshotId: snapshot.snapshotId,
      resourceFingerprint: currentFingerprint(snapshot, resource),
      observedContainerId: resource.runtime.containerId,
      observedImageId: resource.runtime.imageId,
      source,
      actions: [
        'reclone-and-verify-immutable-commit',
        'create-bounded-source-context-archive',
        'encrypt-archive-with-server-local-key',
        'authenticate-encrypted-archive',
        'record-source-runtime-binding-as-unverified'
      ],
      confirmation: sourceCaptureConfirmation(planId),
      createdAt: now(),
      guarantees: {
        dockerRequestsMade: 0,
        runtimeMutated: false,
        providerMutated: false,
        credentialValueIncluded: false,
        sourceArchiveEncrypted: true
      }
    };
    atomicWriteJson(recordPath(sourcePlansRoot, planId), plan);
    pruneJson(sourcePlansRoot);
    return plan;
  }

  async function captureSource(planId, confirmation) {
    const plan = getRecord(sourcePlansRoot, planId, 'Source evidence plan');
    if (confirmation !== plan.confirmation) {
      throw new WorkloadEvidenceError('Exact workload source capture confirmation is required', 400, 'confirmation-required');
    }
    const { snapshot, resource } = latestSnapshotResource(plan.resourceId);
    candidate(resource);
    if (
      currentFingerprint(snapshot, resource) !== plan.resourceFingerprint ||
      resource.runtime.containerId !== plan.observedContainerId ||
      resource.runtime.imageId !== plan.observedImageId
    ) {
      throw new WorkloadEvidenceError('Observed workload changed after source planning', 409, 'source-evidence-plan-stale');
    }
    const archive = await gitSourceAdapter.archive(plan.source);
    const archiveDigest = 'sha256:' + hash(archive);
    const revisionCore = {
      schemaVersion: WORKLOAD_EVIDENCE_SCHEMA_VERSION,
      resourceId: resource.id,
      resourceFingerprint: plan.resourceFingerprint,
      observedContainerId: resource.runtime.containerId,
      observedImageId: resource.runtime.imageId,
      source: plan.source,
      archiveDigest
    };
    const revisionId = 'wsr_' + hash(canonicalJson(revisionCore), 32);
    const encryptionContext = {
      purpose: 'foxos-workload-source-archive',
      schemaVersion: WORKLOAD_EVIDENCE_SCHEMA_VERSION,
      resourceId: resource.id,
      revisionId
    };
    const encrypted = encryptionStore.encryptBuffer(archive, encryptionContext);
    const archiveFile = path.join(sourceArchivesRoot, revisionId + '.enc');
    try {
      encryptionStore.atomicWriteBuffer(archiveFile, encrypted);
      const authenticated = encryptionStore.decryptBuffer(fs.readFileSync(archiveFile), encryptionContext);
      if (hash(authenticated) !== hash(archive)) {
        throw new WorkloadEvidenceError('Encrypted source archive verification failed', 500, 'source-archive-verification-failed');
      }
    } catch (error) {
      try { fs.unlinkSync(archiveFile); } catch { /* archive may not have been written */ }
      throw error;
    }
    const revision = {
      ...revisionCore,
      revisionId,
      type: 'foxos-encrypted-source-archive-revision',
      archive: {
        file: path.relative(dataRoot, archiveFile),
        digest: archiveDigest,
        bytes: archive.length,
        encryptedDigest: 'sha256:' + hash(encrypted),
        encryptedBytes: encrypted.length,
        algorithm: 'aes-256-gcm',
        keyId: encryptionStore.keyId(),
        authenticated: true,
        plaintextIncluded: false
      },
      runtimeBinding: {
        verified: false,
        observedImageId: resource.runtime.imageId,
        reason: 'captured-source-has-not-yet-been-built-and-compared-by-foxos'
      },
      externalGitRequiredToReconstructRevision: false,
      credentialValueIncluded: false,
      capturedFromPlanId: plan.planId,
      capturedAt: now(),
      guarantees: {
        dockerRequestsMade: 0,
        runtimeMutated: false,
        providerMutated: false,
        providerDetached: false,
        sourceArchiveEncrypted: true,
        sourceArchiveAuthenticated: true,
        secretValuesIncluded: false
      }
    };
    atomicWriteJson(recordPath(sourceRevisionsRoot, revisionId), revision);
    atomicWriteJson(path.join(sourceCurrentRoot, resource.id + '.json'), revision);
    pruneJson(sourceRevisionsRoot);
    return revision;
  }

  async function inspectEnvironment(resource) {
    const details = await dockerRequest('GET', '/containers/' + resource.runtime.containerId + '/json');
    if (!details || details.Id !== resource.runtime.containerId) {
      throw new WorkloadEvidenceError('Docker returned a different workload identity', 409, 'environment-identity-mismatch');
    }
    return parseEnvironment(details.Config && details.Config.Env);
  }

  async function planEnvironment(input = {}) {
    if (input.confirmation !== PLAN_ENVIRONMENT_CONFIRMATION) {
      throw new WorkloadEvidenceError('Exact workload environment planning confirmation is required', 400, 'confirmation-required');
    }
    const { snapshot, resource } = latestSnapshotResource(input.resourceId);
    candidate(resource);
    const values = await inspectEnvironment(resource);
    if (values.size !== resource.runtime.environmentVariableCount) {
      throw new WorkloadEvidenceError('Observed environment count changed after registry scan', 409, 'environment-count-mismatch');
    }
    const explicitSecretNames = new Set((input.secretNames || []).map(validateEnvironmentName));
    for (const name of explicitSecretNames) {
      if (!values.has(name)) {
        throw new WorkloadEvidenceError('Explicit secret name is absent from the workload', 400, 'unknown-secret-environment-name');
      }
    }
    const names = Array.from(values.keys()).sort();
    const secretNames = names.filter((name) => explicitSecretNames.has(name) || isSensitiveEnvironmentName(name));
    const ordinaryNames = names.filter((name) => !secretNames.includes(name));
    const planId = 'wep_' + randomUUID().replace(/-/g, '');
    const plan = {
      schemaVersion: WORKLOAD_EVIDENCE_SCHEMA_VERSION,
      planId,
      resourceId: resource.id,
      registrySnapshotId: snapshot.snapshotId,
      resourceFingerprint: currentFingerprint(snapshot, resource),
      observedContainerId: resource.runtime.containerId,
      environmentFingerprint: secretManager.fingerprintEnvironment(
        Array.from(values, ([name, value]) => name + '=' + value)
      ),
      variableCount: values.size,
      ordinaryNames,
      secretNames,
      valuesIncluded: false,
      confirmation: environmentCaptureConfirmation(planId),
      createdAt: now(),
      guarantees: {
        dockerRequestsMade: 1,
        dockerRequestMethods: ['GET'],
        runtimeMutated: false,
        providerMutated: false,
        secretValuesIncluded: false,
        ordinaryValuesIncluded: false
      }
    };
    atomicWriteJson(recordPath(environmentPlansRoot, planId), plan);
    pruneJson(environmentPlansRoot);
    return plan;
  }

  async function captureEnvironment(planId, confirmation) {
    const plan = getRecord(environmentPlansRoot, planId, 'Environment evidence plan');
    if (confirmation !== plan.confirmation) {
      throw new WorkloadEvidenceError('Exact workload environment capture confirmation is required', 400, 'confirmation-required');
    }
    const { snapshot, resource } = latestSnapshotResource(plan.resourceId);
    candidate(resource);
    if (
      currentFingerprint(snapshot, resource) !== plan.resourceFingerprint ||
      resource.runtime.containerId !== plan.observedContainerId
    ) {
      throw new WorkloadEvidenceError('Observed workload changed after environment planning', 409, 'environment-evidence-plan-stale');
    }
    const values = await inspectEnvironment(resource);
    const fingerprint = secretManager.fingerprintEnvironment(
      Array.from(values, ([name, value]) => name + '=' + value)
    );
    if (fingerprint !== plan.environmentFingerprint || values.size !== plan.variableCount) {
      throw new WorkloadEvidenceError('Workload environment changed after planning', 409, 'environment-evidence-plan-stale');
    }
    const ordinary = {};
    const secretRefs = {};
    const secretNames = new Set(plan.secretNames);
    for (const [name, value] of values) {
      if (secretNames.has(name)) {
        const secret = secretManager.putSecret('workload/' + resource.id + '/' + name, value);
        secretRefs[name] = { secretId: secret.secretId, revision: secret.revision };
      } else {
        ordinary[name] = value;
      }
    }
    const environment = secretManager.createEnvironmentRevision(resource.id, { ordinary, secretRefs });
    const captureId = 'wec_' + randomUUID().replace(/-/g, '');
    const capture = {
      schemaVersion: WORKLOAD_EVIDENCE_SCHEMA_VERSION,
      captureId,
      resourceId: resource.id,
      resourceFingerprint: plan.resourceFingerprint,
      observedContainerId: resource.runtime.containerId,
      environment: redactedEnvironment(environment),
      capturedFromPlanId: plan.planId,
      capturedAt: now(),
      guarantees: {
        dockerRequestsMade: 1,
        dockerRequestMethods: ['GET'],
        runtimeMutated: false,
        providerMutated: false,
        providerDetached: false,
        secretValuesIncluded: false,
        ordinaryValuesIncluded: false
      }
    };
    atomicWriteJson(recordPath(environmentCapturesRoot, captureId), capture);
    atomicWriteJson(path.join(environmentCurrentRoot, resource.id + '.json'), capture);
    pruneJson(environmentCapturesRoot);
    return capture;
  }

  function status() {
    let sourceCurrent = [];
    let environmentCurrent = [];
    try {
      sourceCurrent = fs.readdirSync(sourceCurrentRoot).filter((file) => file.endsWith('.json'))
        .sort().map((file) => getSourceRevision(file.replace(/\.json$/, ''))).filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      environmentCurrent = fs.readdirSync(environmentCurrentRoot).filter((file) => file.endsWith('.json'))
        .sort().map((file) => readJson(path.join(environmentCurrentRoot, file))).filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      schemaVersion: WORKLOAD_EVIDENCE_SCHEMA_VERSION,
      scope: 'provider-neutral-stateless-read-only-evidence',
      sourcePlans: listJson(sourcePlansRoot),
      sourceCurrent,
      environmentPlans: listJson(environmentPlansRoot),
      environmentCurrent,
      summary: {
        sourceRevisions: sourceCurrent.length,
        environmentRevisions: environmentCurrent.length
      },
      guarantees: {
        cleanInstallRequiresGitCredential: false,
        externalGitRequiredToReconstructCapturedRevision: false,
        sourceArchivesEncrypted: true,
        sourceRuntimeBindingImplied: false,
        dockerRequestMethods: ['GET'],
        runtimeMutated: false,
        providerMutated: false,
        providerDetached: false,
        secretValuesIncluded: false,
        ordinaryValuesIncluded: false
      }
    };
  }

  ensureDirectory(root);
  return {
    captureEnvironment,
    captureSource,
    getEnvironmentCapture,
    getEnvironmentPlan: (planId) => getRecord(environmentPlansRoot, planId, 'Environment evidence plan'),
    getSourcePlan: (planId) => getRecord(sourcePlansRoot, planId, 'Source evidence plan'),
    getSourceRevision,
    paths: {
      root,
      sourcePlansRoot,
      sourceRevisionsRoot,
      sourceCurrentRoot,
      sourceArchivesRoot,
      environmentPlansRoot,
      environmentCapturesRoot,
      environmentCurrentRoot
    },
    planEnvironment,
    planSource,
    status
  };
}

module.exports = {
  PLAN_ENVIRONMENT_CONFIRMATION,
  PLAN_SOURCE_CONFIRMATION,
  WORKLOAD_EVIDENCE_SCHEMA_VERSION,
  WorkloadEvidenceError,
  createWorkloadEvidenceManager,
  environmentCaptureConfirmation,
  parseEnvironment,
  redactedEnvironment,
  sourceCaptureConfirmation
};
