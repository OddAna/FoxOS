const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');
const {
  SourceDeploymentError,
  canonicalJson,
  defaultHostProbe,
  ensureDirectory,
  hash,
  readJson,
  validateExpectedBody,
  validateHealthPath
} = require('./sourceDeploymentManager');

const IMAGE_UPDATE_SCHEMA_VERSION = 1;
const IMAGE_UPDATE_NAME = 'foxos-image-update-lab';
const IMAGE_UPDATE_RESOURCE_ID = 'res_' + hash(IMAGE_UPDATE_NAME, 32);
const IMAGE_UPDATE_DISPOSABLE_LABEL = 'com.foxos.image-update.disposable';
const PLAN_IMAGE_UPDATE_CONFIRMATION = 'PLAN DISPOSABLE IMAGE UPDATE';
const MAX_RECORDS = 50;
const RECORD_ID_PATTERN = /^(iplan|iop|irev)_[a-f0-9]{24,64}$/;
const CANARY_REPOSITORY = 'traefik/whoami';
const CANARY_DIGESTS = Object.freeze({
  'v1.10.3': 'sha256:43a68d10b9dfcfc3ffbfe4dd42100dc9aeaf29b3a5636c856337a5940f1b4f1c',
  'v1.11.0': 'sha256:200689790a0a0ea48ca45992e0450bc26ccab5307375b41c84dfc4f2475937ab'
});

class ImageUpdateError extends SourceDeploymentError {
  constructor(message, statusCode = 400, code = 'image-update-error') {
    super(message, statusCode, code);
    this.name = 'ImageUpdateError';
  }
}

function parseCanaryImageReference(value) {
  const reference = String(value || '').trim().toLowerCase();
  if (
    !reference || reference.length > 180 || /[\s@?#]/.test(reference) ||
    reference.includes('://') || reference.includes('\\')
  ) {
    throw new ImageUpdateError('Image must be a reviewed tag reference', 400, 'invalid-image-reference');
  }
  const normalized = reference.startsWith('docker.io/') ? reference.slice('docker.io/'.length) : reference;
  const prefix = CANARY_REPOSITORY + ':';
  if (!normalized.startsWith(prefix)) {
    throw new ImageUpdateError(
      `The first image-update pilot accepts only ${CANARY_REPOSITORY}`,
      403,
      'image-repository-blocked'
    );
  }
  const tag = normalized.slice(prefix.length);
  if (!Object.hasOwn(CANARY_DIGESTS, tag)) {
    throw new ImageUpdateError('Image tag is outside the reviewed canary set', 403, 'image-tag-blocked');
  }
  return {
    repository: CANARY_REPOSITORY,
    tag,
    tagReference: CANARY_REPOSITORY + ':' + tag,
    reviewedDigest: CANARY_DIGESTS[tag]
  };
}

function imageUpdateConfirmation(planId) {
  return 'APPLY IMAGE UPDATE ' + planId;
}

function imageUpdateRollbackConfirmation(operationId) {
  return 'ROLLBACK IMAGE UPDATE ' + operationId;
}

function normalizePlatforms(platforms = []) {
  return platforms.map((platform) => ({
    os: String(platform.os || platform.OS || '').toLowerCase(),
    architecture: String(platform.architecture || platform.Architecture || '').toLowerCase(),
    variant: platform.variant || platform.Variant ? String(platform.variant || platform.Variant) : null
  })).filter((platform) => platform.os && platform.architecture)
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function createImageUpdateManager({
  dataRoot,
  dockerRequest,
  probeHttp = defaultHostProbe,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (!dataRoot || typeof dockerRequest !== 'function') {
    throw new Error('Image update manager requires a data root and Docker client');
  }

  const root = path.join(dataRoot, 'image-updates');
  const plansRoot = path.join(root, 'plans');
  const revisionsRoot = path.join(root, 'revisions');
  const operationsRoot = path.join(root, 'operations');
  const currentFile = path.join(root, 'current.json');
  const operationLockFile = path.join(root, 'operation.lock');
  const inFlight = new Set();

  function now() {
    return new Date(clock()).toISOString();
  }

  function recordPath(directory, id) {
    if (!RECORD_ID_PATTERN.test(String(id))) {
      throw new ImageUpdateError('Invalid image-update record ID', 400, 'invalid-image-update-record-id');
    }
    return path.join(directory, id + '.json');
  }

  function getRecord(directory, id, label) {
    const record = readJson(recordPath(directory, id));
    if (!record) throw new ImageUpdateError(label + ' was not found', 404, 'image-update-record-not-found');
    return record;
  }

  function listRecords(directory) {
    try {
      return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
        .map((file) => readJson(path.join(directory, file))).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function pruneOperations() {
    let records;
    try {
      records = fs.readdirSync(operationsRoot).filter((file) => file.endsWith('.json')).map((file) => ({
        file,
        record: readJson(path.join(operationsRoot, file))
      })).filter((entry) => entry.record && entry.record.status !== 'running')
        .sort((left, right) => (
          String(left.record.completedAt || left.record.startedAt || '').localeCompare(
            String(right.record.completedAt || right.record.startedAt || '')
          ) || left.file.localeCompare(right.file)
        ));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of records.slice(0, Math.max(0, records.length - MAX_RECORDS))) {
      fs.unlinkSync(path.join(operationsRoot, entry.file));
    }
  }

  function getPlan(planId) {
    return getRecord(plansRoot, planId, 'Image-update plan');
  }

  function getOperation(operationId) {
    return getRecord(operationsRoot, operationId, 'Image-update operation');
  }

  function liveLockOwner() {
    let lock;
    try { lock = readJson(operationLockFile); } catch { return fs.existsSync(operationLockFile); }
    const pid = Number.parseInt(lock && lock.pid, 10);
    const acquiredAt = Date.parse(lock && lock.acquiredAt);
    if (
      !Number.isInteger(pid) || pid < 1 || !Number.isFinite(acquiredAt) ||
      Date.now() - acquiredAt > 6 * 60 * 60 * 1000
    ) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }

  function acquireOperationLock() {
    ensureDirectory(root);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      try {
        fs.writeFileSync(operationLockFile, JSON.stringify({ pid: process.pid, token, acquiredAt: now() }) + '\n', {
          encoding: 'utf8', flag: 'wx', mode: 0o600
        });
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (liveLockOwner()) return null;
        try { fs.unlinkSync(operationLockFile); } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
    }
    return null;
  }

  function releaseOperationLock(token) {
    let lock;
    try { lock = readJson(operationLockFile); } catch { return; }
    if (!lock || lock.token !== token || Number(lock.pid) !== process.pid) return;
    try { fs.unlinkSync(operationLockFile); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function resolveReviewedImage(reference) {
    const parsed = parseCanaryImageReference(reference);
    const distribution = await dockerRequest(
      'GET',
      '/distribution/' + encodeURIComponent(parsed.tagReference) + '/json'
    );
    const descriptor = distribution && distribution.Descriptor || {};
    const digest = String(descriptor.digest || '').toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new ImageUpdateError('Registry did not return an immutable image digest', 502, 'image-digest-missing');
    }
    if (digest !== parsed.reviewedDigest) {
      throw new ImageUpdateError('Reviewed image tag digest changed', 409, 'reviewed-image-drift');
    }
    const platforms = normalizePlatforms(distribution.Platforms);
    if (!platforms.some((platform) => platform.os === 'linux' && platform.architecture === 'amd64')) {
      throw new ImageUpdateError('Reviewed image no longer includes linux/amd64', 409, 'image-platform-missing');
    }
    return {
      adapter: 'oci-registry-v2-through-docker-engine',
      repository: parsed.repository,
      tag: parsed.tag,
      requestedReference: parsed.tagReference,
      digest,
      reference: parsed.repository + '@' + digest,
      descriptorMediaType: String(descriptor.mediaType || ''),
      descriptorSize: Number(descriptor.size || 0),
      platforms
    };
  }

  async function assertOwnedNetwork(networkId, networkName, revisionId, expectedContainerId = null) {
    if (!networkId || !networkName) {
      throw new ImageUpdateError('Image-update network identity is missing', 409, 'image-update-network-drift');
    }
    const network = await dockerRequest('GET', '/networks/' + networkId);
    const labels = network && network.Labels || {};
    if (
      network.Name !== networkName || network.Internal !== false ||
      labels[IMAGE_UPDATE_DISPOSABLE_LABEL] !== 'true' ||
      labels['com.foxos.resource.id'] !== IMAGE_UPDATE_RESOURCE_ID ||
      labels['com.foxos.managed'] !== 'true' ||
      labels['com.foxos.deployment.revision'] !== revisionId
    ) {
      throw new ImageUpdateError('Image-update network identity drifted', 409, 'image-update-network-drift');
    }
    if (expectedContainerId) {
      const attached = Object.keys(network.Containers || {});
      if (attached.length !== 1 || attached[0] !== expectedContainerId) {
        throw new ImageUpdateError('Image-update network attachment drifted', 409, 'image-update-network-drift');
      }
    }
    return network;
  }

  function labelsFor(plan, operationId) {
    return {
      'com.foxos.managed': 'true',
      'com.foxos.resource.id': IMAGE_UPDATE_RESOURCE_ID,
      [IMAGE_UPDATE_DISPOSABLE_LABEL]: 'true',
      'com.foxos.deployment.revision': plan.revisionId,
      'com.foxos.deployment.operation': operationId
    };
  }

  function containerPayload(plan, operationId, networkName) {
    const portKey = plan.runtime.privatePort + '/tcp';
    return {
      Image: plan.image.reference,
      User: '65532:65532',
      Labels: labelsFor(plan, operationId),
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        NetworkMode: networkName,
        PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '0' }] },
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 128 * 1024 * 1024,
        NanoCpus: 500000000,
        PidsLimit: 128,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' }
      },
      NetworkingConfig: {
        EndpointsConfig: { [networkName]: { Aliases: [IMAGE_UPDATE_NAME] } }
      }
    };
  }

  function assertOwnedDetails(details, revisionId = null) {
    const labels = details && details.Config && details.Config.Labels || {};
    if (
      labels[IMAGE_UPDATE_DISPOSABLE_LABEL] !== 'true' ||
      labels['com.foxos.resource.id'] !== IMAGE_UPDATE_RESOURCE_ID ||
      labels['com.foxos.managed'] !== 'true' ||
      (revisionId && labels['com.foxos.deployment.revision'] !== revisionId)
    ) {
      throw new ImageUpdateError('Image-update container identity mismatch', 409, 'image-update-identity-mismatch');
    }
  }

  function assertConstrainedRuntime(details, expectedNetworkName = null) {
    const host = details.HostConfig || {};
    const security = host.SecurityOpt || [];
    const capDrop = host.CapDrop || [];
    if (
      (details.Config && details.Config.User !== '65532:65532') ||
      host.Privileged !== false || host.ReadonlyRootfs !== true ||
      !capDrop.includes('ALL') || !security.includes('no-new-privileges:true') ||
      host.Memory !== 128 * 1024 * 1024 || host.NanoCpus !== 500000000 ||
      host.PidsLimit !== 128 || (details.Mounts || []).length !== 0 ||
      !/^foxos-image-update-lab-candidate-[a-f0-9]{12}$/.test(String(host.NetworkMode || '')) ||
      (expectedNetworkName && host.NetworkMode !== expectedNetworkName) ||
      (expectedNetworkName && !Object.hasOwn(details.NetworkSettings && details.NetworkSettings.Networks || {}, expectedNetworkName))
    ) {
      throw new ImageUpdateError('Image-update runtime constraints drifted', 409, 'image-update-runtime-drift');
    }
  }

  function activeSummary(current, details) {
    if (!current || !details) return null;
    return {
      operationId: current.operationId,
      revisionId: current.revisionId,
      containerId: current.containerId,
      imageDigest: current.image.digest,
      imageId: current.imageId
    };
  }

  async function activeContainer() {
    const current = readJson(currentFile);
    const containers = await dockerRequest('GET', '/containers/json?all=1');
    if (!current) {
      const occupied = (containers || []).find((container) => (
        container.Names || []
      ).includes('/' + IMAGE_UPDATE_NAME));
      if (occupied) {
        throw new ImageUpdateError(
          'Image-update stable name is occupied while current state is missing',
          409,
          'image-update-name-conflict'
        );
      }
      return { current: null, details: null, summary: null };
    }
    const details = await dockerRequest('GET', '/containers/' + current.containerId + '/json');
    assertOwnedDetails(details, current.revisionId);
    assertConstrainedRuntime(details, current.networkName);
    await assertOwnedNetwork(current.networkId, current.networkName, current.revisionId, current.containerId);
    if (details.Name !== '/' + IMAGE_UPDATE_NAME) {
      throw new ImageUpdateError('Current image-update container name drifted', 409, 'image-update-name-drift');
    }
    if (String(details.Image || '').toLowerCase() !== String(current.imageId || '').toLowerCase()) {
      throw new ImageUpdateError('Current image-update image ID drifted', 409, 'image-update-image-drift');
    }
    return { current, details, summary: activeSummary(current, details) };
  }

  function publishedPort(details, privatePort) {
    const bindings = details.NetworkSettings && details.NetworkSettings.Ports &&
      details.NetworkSettings.Ports[privatePort + '/tcp'];
    const binding = bindings && bindings[0];
    const port = Number.parseInt(binding && binding.HostPort || '', 10);
    if (binding && binding.HostIp !== '127.0.0.1') {
      throw new ImageUpdateError('Image-update ingress is not loopback-only', 409, 'image-update-public-port');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ImageUpdateError('Image-update candidate has no loopback port', 502, 'image-update-port-missing');
    }
    return port;
  }

  async function proveHealth(containerId, plan, expectedNetworkName) {
    let lastError;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
        assertOwnedDetails(details, plan.revisionId);
        assertConstrainedRuntime(details, expectedNetworkName);
        if (!details.State || details.State.Status !== 'running') throw new Error('Image-update candidate is not running');
        const hostPort = publishedPort(details, plan.runtime.privatePort);
        const response = await probeHttp({ port: hostPort, healthPath: plan.health.path, timeoutMs: 5000 });
        if (response.statusCode === plan.health.expectedStatus && response.body.includes(plan.health.expectedBody)) {
          return {
            verified: true,
            statusCode: response.statusCode,
            bodyDigest: 'sha256:' + hash(response.body),
            expectedBodyMatched: true,
            hostPort,
            verifiedAt: now()
          };
        }
        lastError = new Error('Image-update health proof did not match the expected status and marker');
      } catch (error) {
        lastError = error;
      }
      await wait(500);
    }
    throw new ImageUpdateError(lastError && lastError.message || 'Image-update health proof failed', 502, 'image-update-health-failed');
  }

  async function pullPinnedImage(image) {
    await dockerRequest('POST', '/images/create?fromImage=' + encodeURIComponent(image.reference));
    const details = await dockerRequest('GET', '/images/' + encodeURIComponent(image.reference) + '/json');
    const imageId = String(details.Id || '').toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw new ImageUpdateError('Pulled image has no immutable local ID', 502, 'image-id-missing');
    }
    const expectedRepoDigest = image.repository + '@' + image.digest;
    if (!(details.RepoDigests || []).map(String).includes(expectedRepoDigest)) {
      throw new ImageUpdateError('Pulled image repository digest does not match the plan', 409, 'image-pull-drift');
    }
    return { imageId, repoDigest: expectedRepoDigest };
  }

  async function renameContainer(containerId, targetName) {
    const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
    if (details.Name !== '/' + targetName) {
      await dockerRequest('POST', '/containers/' + containerId + '/rename?name=' + encodeURIComponent(targetName));
    }
  }

  async function startContainer(containerId) {
    const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
    if (!details.State || details.State.Status !== 'running') {
      await dockerRequest('POST', '/containers/' + containerId + '/start');
    }
  }

  async function stopContainer(containerId) {
    const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
    if (details.State && details.State.Status === 'running') {
      await dockerRequest('POST', '/containers/' + containerId + '/stop?t=10');
    }
  }

  function status() {
    return {
      schemaVersion: IMAGE_UPDATE_SCHEMA_VERSION,
      scope: 'fixed-disposable-reviewed-image-update-only',
      resourceId: IMAGE_UPDATE_RESOURCE_ID,
      name: IMAGE_UPDATE_NAME,
      reviewedImages: Object.entries(CANARY_DIGESTS).map(([tag, digest]) => ({
        reference: CANARY_REPOSITORY + ':' + tag,
        digest
      })),
      current: readJson(currentFile),
      plans: listRecords(plansRoot),
      operations: listRecords(operationsRoot),
      operationLock: { active: liveLockOwner() },
      guarantees: {
        fixedRepository: CANARY_REPOSITORY,
        reviewedTagDigests: true,
        registryDigestResolvedBeforePull: true,
        applyDigestRevalidation: true,
        immutablePullReference: true,
        loopbackOnly: true,
        freshDedicatedNetworkPerRevision: true,
        nonRoot: true,
        volumesSupported: false,
        environmentSupported: false,
        secretsSupported: false,
        hostAccessSupported: false,
        candidateHealthBeforeCutover: true,
        providerAuthorityRequired: false,
        coolifyMutable: false
      }
    };
  }

  async function createPlan(input = {}) {
    if (input.confirmation !== PLAN_IMAGE_UPDATE_CONFIRMATION) {
      throw new ImageUpdateError('Exact disposable image-update planning confirmation is required', 400, 'confirmation-required');
    }
    const healthPath = validateHealthPath(input.healthPath);
    const expectedBody = validateExpectedBody(input.expectedBody);
    const image = await resolveReviewedImage(input.image);
    const active = await activeContainer();
    if (active.current && active.current.image.digest === image.digest) {
      throw new ImageUpdateError('The reviewed image digest is already current', 409, 'image-already-current');
    }
    const revisionBody = {
      schemaVersion: IMAGE_UPDATE_SCHEMA_VERSION,
      resourceId: IMAGE_UPDATE_RESOURCE_ID,
      image,
      runtime: {
        privatePort: 80,
        hostBinding: 'dynamic-loopback',
        user: '65532:65532',
        readOnlyRoot: true,
        capDrop: ['ALL'],
        noNewPrivileges: true,
        memoryBytes: 128 * 1024 * 1024,
        nanoCpus: 500000000,
        pidsLimit: 128,
        mounts: [],
        network: 'fresh-dedicated-foxos-bridge'
      },
      health: { path: healthPath, expectedStatus: 200, expectedBody }
    };
    const revisionId = 'irev_' + hash(canonicalJson(revisionBody), 32);
    const planId = 'iplan_' + randomUUID().replace(/-/g, '');
    const createdAt = now();
    const revision = { ...revisionBody, revisionId, createdAt };
    const plan = {
      ...revisionBody,
      planId,
      revisionId,
      from: active.summary,
      status: 'ready',
      actions: [
        're-resolve-reviewed-tag-and-reject-drift',
        'pull-immutable-repository-digest',
        'start-constrained-loopback-candidate',
        'verify-http-status-and-body-marker',
        'preserve-previous-image-container',
        'promote-candidate'
      ],
      confirmation: imageUpdateConfirmation(planId),
      createdAt
    };
    atomicWriteJson(recordPath(revisionsRoot, revisionId), revision);
    atomicWriteJson(recordPath(plansRoot, planId), plan);
    return plan;
  }

  async function applyPlan(planId, confirmation) {
    const plan = getPlan(planId);
    if (confirmation !== plan.confirmation) {
      throw new ImageUpdateError('Exact image-update apply confirmation is required', 400, 'confirmation-required');
    }
    if (inFlight.has(IMAGE_UPDATE_RESOURCE_ID)) {
      throw new ImageUpdateError('An image-update operation is already running', 409, 'image-update-in-progress');
    }
    const operationLock = acquireOperationLock();
    if (!operationLock) {
      throw new ImageUpdateError('Another image-update process is active', 409, 'image-update-in-progress');
    }
    inFlight.add(IMAGE_UPDATE_RESOURCE_ID);
    const operationId = 'iop_' + randomUUID().replace(/-/g, '');
    const operationFile = recordPath(operationsRoot, operationId);
    let operation = {
      schemaVersion: IMAGE_UPDATE_SCHEMA_VERSION,
      operationId,
      planId,
      revisionId: plan.revisionId,
      resourceId: IMAGE_UPDATE_RESOURCE_ID,
      status: 'running',
      startedAt: now(),
      image: plan.image,
      pull: { status: 'pending', imageId: null, repoDigest: null },
      candidate: null,
      previous: null,
      healthProof: null,
      rollback: { available: false, confirmation: imageUpdateRollbackConfirmation(operationId) }
    };
    let previous = null;
    let previousTouched = false;
    let candidateId = null;
    let candidateNetwork = null;
    try {
      atomicWriteJson(operationFile, operation);
      const resolved = await resolveReviewedImage(plan.image.requestedReference);
      if (canonicalJson(resolved) !== canonicalJson(plan.image)) {
        throw new ImageUpdateError('Reviewed image metadata changed after planning', 409, 'image-plan-stale');
      }
      previous = await activeContainer();
      if (canonicalJson(previous.summary) !== canonicalJson(plan.from)) {
        throw new ImageUpdateError('Current image-update state changed after planning', 409, 'image-update-current-drift');
      }
      operation.pull = { ...operation.pull, status: 'running' };
      atomicWriteJson(operationFile, operation);
      const pulled = await pullPinnedImage(plan.image);
      operation.pull = { ...pulled, status: 'succeeded' };
      atomicWriteJson(operationFile, operation);

      const suffix = hash(operationId, 12);
      const candidateName = IMAGE_UPDATE_NAME + '-candidate-' + suffix;
      const networkName = IMAGE_UPDATE_NAME + '-candidate-' + suffix;
      const createdNetwork = await dockerRequest('POST', '/networks/create', {
        Name: networkName,
        CheckDuplicate: true,
        Internal: false,
        Attachable: false,
        Labels: {
          'com.foxos.managed': 'true',
          'com.foxos.resource.id': IMAGE_UPDATE_RESOURCE_ID,
          [IMAGE_UPDATE_DISPOSABLE_LABEL]: 'true',
          'com.foxos.deployment.revision': plan.revisionId,
          'com.foxos.deployment.operation': operationId
        }
      });
      candidateNetwork = { networkId: createdNetwork.Id, networkName, owned: false };
      await assertOwnedNetwork(candidateNetwork.networkId, candidateNetwork.networkName, plan.revisionId);
      candidateNetwork.owned = true;
      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(candidateName),
        containerPayload(plan, operationId, networkName)
      );
      candidateId = created.Id;
      await dockerRequest('POST', '/containers/' + candidateId + '/start');
      await assertOwnedNetwork(candidateNetwork.networkId, candidateNetwork.networkName, plan.revisionId, candidateId);
      const candidateDetails = await dockerRequest('GET', '/containers/' + candidateId + '/json');
      if (String(candidateDetails.Image || '').toLowerCase() !== pulled.imageId) {
        throw new ImageUpdateError('Candidate did not use the pulled immutable image ID', 409, 'image-update-candidate-drift');
      }
      operation.healthProof = await proveHealth(candidateId, plan, candidateNetwork.networkName);
      operation.candidate = {
        containerId: candidateId,
        name: candidateName,
        imageId: pulled.imageId,
        imageDigest: plan.image.digest,
        networkId: candidateNetwork.networkId,
        networkName: candidateNetwork.networkName,
        hostPort: operation.healthProof.hostPort
      };
      atomicWriteJson(operationFile, operation);

      if (previous.current) {
        const rollbackName = IMAGE_UPDATE_NAME + '-rollback-' + hash(operationId, 12);
        operation.previous = {
          operationId: previous.current.operationId,
          revisionId: previous.current.revisionId,
          containerId: previous.current.containerId,
          imageId: previous.current.imageId,
          image: previous.current.image,
          networkId: previous.current.networkId,
          networkName: previous.current.networkName,
          rollbackName,
          wasRunning: previous.details.State && previous.details.State.Status === 'running'
        };
        previousTouched = true;
        await stopContainer(previous.current.containerId);
        await renameContainer(previous.current.containerId, rollbackName);
      }
      await renameContainer(candidateId, IMAGE_UPDATE_NAME);
      operation.candidate.name = IMAGE_UPDATE_NAME;
      operation.status = 'applied';
      operation.completedAt = now();
      operation.rollback.available = Boolean(previous.current);
      atomicWriteJson(operationFile, operation);
      atomicWriteJson(currentFile, {
        schemaVersion: IMAGE_UPDATE_SCHEMA_VERSION,
        resourceId: IMAGE_UPDATE_RESOURCE_ID,
        operationId,
        revisionId: plan.revisionId,
        containerId: candidateId,
        imageId: pulled.imageId,
        image: plan.image,
        networkId: candidateNetwork.networkId,
        networkName: candidateNetwork.networkName,
        hostPort: operation.healthProof.hostPort,
        healthProof: operation.healthProof,
        activatedAt: operation.completedAt
      });
      try { pruneOperations(); } catch { /* retention cleanup must not undo a committed cutover */ }
      return operation;
    } catch (error) {
      if (candidateId) {
        try { await dockerRequest('DELETE', '/containers/' + candidateId + '?force=1&v=0'); } catch { /* best effort */ }
      }
      if (candidateNetwork && candidateNetwork.owned) {
        try { await dockerRequest('DELETE', '/networks/' + candidateNetwork.networkId); } catch { /* best effort */ }
      }
      if (previousTouched && previous && previous.current) {
        try {
          await renameContainer(previous.current.containerId, IMAGE_UPDATE_NAME);
          await startContainer(previous.current.containerId);
          const previousOperation = getOperation(previous.current.operationId);
          const previousPlan = getPlan(previousOperation.planId);
          operation.restorationProof = await proveHealth(
            previous.current.containerId,
            previousPlan,
            previous.current.networkName
          );
        } catch { /* best effort */ }
      }
      operation.status = previousTouched ? 'failed-previous-restoration-attempted' : 'failed-before-cutover';
      operation.completedAt = now();
      operation.error = {
        code: error.code || 'image-update-failed',
        message: error instanceof SourceDeploymentError ? error.message : 'Image update failed'
      };
      atomicWriteJson(operationFile, operation);
      throw error;
    } finally {
      inFlight.delete(IMAGE_UPDATE_RESOURCE_ID);
      releaseOperationLock(operationLock);
    }
  }

  async function rollbackOperation(operationId, confirmation) {
    const operation = getOperation(operationId);
    if (operation.status !== 'applied' || !operation.rollback.available || !operation.previous) {
      throw new ImageUpdateError('This image update has no available rollback', 409, 'rollback-unavailable');
    }
    if (confirmation !== operation.rollback.confirmation) {
      throw new ImageUpdateError('Exact image-update rollback confirmation is required', 400, 'confirmation-required');
    }
    if (inFlight.has(IMAGE_UPDATE_RESOURCE_ID)) {
      throw new ImageUpdateError('An image-update operation is already running', 409, 'image-update-in-progress');
    }
    const operationLock = acquireOperationLock();
    if (!operationLock) {
      throw new ImageUpdateError('Another image-update process is active', 409, 'image-update-in-progress');
    }
    inFlight.add(IMAGE_UPDATE_RESOURCE_ID);
    const operationBeforeRollback = JSON.parse(JSON.stringify(operation));
    let current = null;
    let currentTouched = false;
    let previousTouched = false;
    try {
      current = await activeContainer();
      if (!current.current || current.current.operationId !== operationId) {
        throw new ImageUpdateError('Current image-update state does not match the rollback operation', 409, 'rollback-drift');
      }
      const previousDetails = await dockerRequest('GET', '/containers/' + operation.previous.containerId + '/json');
      assertOwnedDetails(previousDetails, operation.previous.revisionId);
      assertConstrainedRuntime(previousDetails, operation.previous.networkName);
      await assertOwnedNetwork(
        operation.previous.networkId,
        operation.previous.networkName,
        operation.previous.revisionId
      );
      if (previousDetails.Name !== '/' + operation.previous.rollbackName) {
        throw new ImageUpdateError('Previous image-update identity drifted', 409, 'rollback-drift');
      }
      const previousOperation = getOperation(operation.previous.operationId);
      const previousPlan = getPlan(previousOperation.planId);
      const parkedName = IMAGE_UPDATE_NAME + '-rolled-forward-' + hash(operationId, 12);

      currentTouched = true;
      await stopContainer(current.current.containerId);
      await renameContainer(current.current.containerId, parkedName);
      previousTouched = true;
      await renameContainer(operation.previous.containerId, IMAGE_UPDATE_NAME);
      await startContainer(operation.previous.containerId);
      const healthProof = await proveHealth(
        operation.previous.containerId,
        previousPlan,
        operation.previous.networkName
      );

      operation.status = 'rolled-back';
      operation.rolledBackAt = now();
      operation.rollback.available = false;
      operation.rollback.proof = healthProof;
      operation.rollback.currentParkedName = parkedName;
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      atomicWriteJson(currentFile, {
        schemaVersion: IMAGE_UPDATE_SCHEMA_VERSION,
        resourceId: IMAGE_UPDATE_RESOURCE_ID,
        operationId: operation.previous.operationId,
        revisionId: operation.previous.revisionId,
        containerId: operation.previous.containerId,
        imageId: operation.previous.imageId,
        image: operation.previous.image,
        networkId: operation.previous.networkId,
        networkName: operation.previous.networkName,
        hostPort: healthProof.hostPort,
        healthProof,
        activatedAt: operation.rolledBackAt,
        restoredBy: operationId
      });
      return operation;
    } catch (error) {
      if (previousTouched) {
        try { await stopContainer(operation.previous.containerId); } catch { /* best effort */ }
        try { await renameContainer(operation.previous.containerId, operation.previous.rollbackName); } catch { /* best effort */ }
      }
      if (currentTouched && current && current.current) {
        try {
          await renameContainer(current.current.containerId, IMAGE_UPDATE_NAME);
          await startContainer(current.current.containerId);
          const currentPlan = getPlan(operation.planId);
          const restorationProof = await proveHealth(
            current.current.containerId,
            currentPlan,
            current.current.networkName
          );
          atomicWriteJson(currentFile, {
            ...current.current,
            healthProof: restorationProof,
            activatedAt: now()
          });
          atomicWriteJson(recordPath(operationsRoot, operationId), {
            ...operationBeforeRollback,
            rollback: {
              ...operationBeforeRollback.rollback,
              lastFailure: {
                at: now(),
                code: error.code || 'image-update-rollback-failed',
                message: error instanceof SourceDeploymentError ? error.message : 'Image-update rollback failed'
              }
            }
          });
        } catch { /* best effort */ }
      }
      throw error;
    } finally {
      inFlight.delete(IMAGE_UPDATE_RESOURCE_ID);
      releaseOperationLock(operationLock);
    }
  }

  if (!liveLockOwner()) {
    for (const operation of listRecords(operationsRoot)) {
      if (operation.status === 'running') {
        atomicWriteJson(recordPath(operationsRoot, operation.operationId), {
          ...operation,
          status: 'interrupted',
          interruptedAt: now(),
          error: {
            code: 'agent-restarted',
            message: 'Agent restarted while this image update was running; inspect before retrying.'
          }
        });
      }
    }
  }

  return {
    applyPlan,
    createPlan,
    getOperation,
    getPlan,
    rollbackOperation,
    status
  };
}

module.exports = {
  CANARY_DIGESTS,
  CANARY_REPOSITORY,
  IMAGE_UPDATE_DISPOSABLE_LABEL,
  IMAGE_UPDATE_NAME,
  IMAGE_UPDATE_RESOURCE_ID,
  PLAN_IMAGE_UPDATE_CONFIRMATION,
  ImageUpdateError,
  createImageUpdateManager,
  imageUpdateConfirmation,
  imageUpdateRollbackConfirmation,
  parseCanaryImageReference
};
