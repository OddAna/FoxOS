const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyResource } = require('./resourceClassification');
const { createEncryptionStore } = require('./encryptionStore');
const { createSecretManager } = require('./secretManager');
const {
  PLAN_ENVIRONMENT_CONFIRMATION,
  PLAN_SOURCE_CONFIRMATION,
  createWorkloadEvidenceManager
} = require('./workloadEvidenceManager');

const RESOURCE_ID = 'res_' + '4'.repeat(32);
const CONTAINER_ID = 'c'.repeat(64);
const IMAGE_ID = 'sha256:' + 'd'.repeat(64);
const PRIVATE_GIT_VALUE = 'private-git-token-that-must-never-persist-in-evidence';
const RUNTIME_SECRET_VALUE = 'runtime-secret-that-must-stay-encrypted';

function resource() {
  const value = {
    schemaVersion: 1,
    id: RESOURCE_ID,
    kind: 'container',
    name: 'real-stateless-site',
    role: 'application',
    ownership: 'observed',
    provider: 'coolify',
    protected: false,
    provenance: { imported: false, safeLabels: {}, project: 'site', service: 'web' },
    runtime: {
      engine: 'docker',
      containerId: CONTAINER_ID,
      image: 'site:latest',
      imageId: IMAGE_ID,
      state: 'running',
      status: 'Up 1 hour',
      restartPolicy: 'unless-stopped',
      health: { configured: true, status: 'healthy' },
      constraints: {
        user: '1000:1000',
        privileged: false,
        readOnlyRootFilesystem: false,
        noNewPrivileges: false,
        allCapabilitiesDropped: false,
        memoryBytes: null,
        nanoCpus: null,
        pidsLimit: null
      },
      environmentVariableCount: 4,
      inspection: 'complete'
    },
    ports: [{ privatePort: 3000, protocol: 'tcp', hostIp: null, hostPort: null }],
    routes: [{ domain: 'site.example.test', path: '/', tls: true }],
    mounts: [],
    networks: [{ name: 'provider-network' }],
    adoption: { stage: 'observed', eligible: true, ready: false, blockers: [] }
  };
  return { ...value, classification: classifyResource(value) };
}

function snapshot(currentResource = resource()) {
  return {
    schemaVersion: 1,
    snapshotId: 'snap_' + '1'.repeat(32),
    resources: [currentResource],
    relationships: [],
    inventory: { images: [], networks: [], volumes: [] }
  };
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-workload-evidence-'));
  const encryptionStore = createEncryptionStore({ dataRoot: root });
  let currentSnapshot = snapshot();
  const secretManager = createSecretManager({
    dataRoot: root,
    encryptionStore,
    clock: () => new Date('2026-08-05T08:00:00.000Z'),
    randomUUID: (() => {
      let value = 10;
      return () => (++value).toString(16).padStart(32, '0');
    })()
  });
  secretManager.putSecret('git/site/read', PRIVATE_GIT_VALUE);
  const dockerCalls = [];
  async function dockerRequest(method, requestPath) {
    dockerCalls.push({ method, requestPath });
    assert.equal(method, 'GET');
    assert.equal(requestPath, '/containers/' + CONTAINER_ID + '/json');
    return {
      Id: CONTAINER_ID,
      Config: {
        Env: [
          'NODE_ENV=production',
          'CRM_TARGET=dual',
          'DAAS_HUB_SHARED_SECRET=' + RUNTIME_SECRET_VALUE,
          'HIGHLEVEL_API_TOKEN=another-encrypted-runtime-value'
        ]
      }
    };
  }
  const sourceAdapter = {
    async inspect(source) {
      assert.equal(source.credential.valueIncluded, false);
      return {
        commit: 'a'.repeat(40),
        refType: 'branch',
        contextDigest: 'sha256:' + 'b'.repeat(64),
        dockerfileDigest: 'sha256:' + 'c'.repeat(64),
        fileCount: 8,
        totalBytes: 4096
      };
    },
    async archive(source) {
      assert.equal(source.commit, 'a'.repeat(40));
      return Buffer.from('private source archive body');
    }
  };
  let counter = 100;
  const manager = createWorkloadEvidenceManager({
    dataRoot: root,
    dockerRequest,
    resourceRegistry: { getLatest: () => currentSnapshot },
    encryptionStore,
    secretManager,
    sourceAdapter,
    clock: () => new Date('2026-08-05T08:30:00.000Z'),
    randomUUID: () => (++counter).toString(16).padStart(32, '0')
  });
  return {
    dockerCalls,
    encryptionStore,
    manager,
    root,
    secretManager,
    setSnapshot: (value) => { currentSnapshot = value; }
  };
}

test('private Git source evidence becomes an authenticated encrypted local archive without runtime authority', async () => {
  const { manager, root } = harness();
  try {
    const plan = await manager.planSource({
      resourceId: RESOURCE_ID,
      repository: 'https://github.com/example/private-site.git',
      ref: 'main',
      contextPath: '.',
      dockerfile: 'Dockerfile',
      username: 'x-access-token',
      credentialSecret: 'git/site/read',
      confirmation: PLAN_SOURCE_CONFIRMATION
    });
    assert.equal(plan.source.adapter, 'git-https-private');
    assert.equal(plan.source.credential.valueIncluded, false);
    assert.equal(JSON.stringify(plan).includes(PRIVATE_GIT_VALUE), false);
    assert.equal(plan.guarantees.runtimeMutated, false);

    const revision = await manager.captureSource(plan.planId, plan.confirmation);
    assert.equal(revision.type, 'foxos-encrypted-source-archive-revision');
    assert.equal(revision.archive.authenticated, true);
    assert.equal(revision.archive.plaintextIncluded, false);
    assert.equal(revision.runtimeBinding.verified, false);
    assert.equal(revision.externalGitRequiredToReconstructRevision, false);
    assert.equal(revision.guarantees.dockerRequestsMade, 0);
    assert.equal(revision.guarantees.runtimeMutated, false);
    assert.equal(manager.getSourceRevision(RESOURCE_ID).revisionId, revision.revisionId);

    const evidenceFiles = fs.readdirSync(manager.paths.sourceRevisionsRoot).map((file) => (
      fs.readFileSync(path.join(manager.paths.sourceRevisionsRoot, file), 'utf8')
    )).join('\n');
    const encryptedArchive = fs.readFileSync(path.join(root, revision.archive.file));
    assert.equal(evidenceFiles.includes(PRIVATE_GIT_VALUE), false);
    assert.equal(encryptedArchive.includes(Buffer.from('private source archive body')), false);
    assert.equal(fs.statSync(manager.paths.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, revision.archive.file)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('environment capture classifies sensitive names, rejects drift and persists only encrypted secret references', async () => {
  const { dockerCalls, manager, root, secretManager, setSnapshot } = harness();
  try {
    const plan = await manager.planEnvironment({
      resourceId: RESOURCE_ID,
      confirmation: PLAN_ENVIRONMENT_CONFIRMATION
    });
    assert.deepEqual(plan.ordinaryNames, ['CRM_TARGET', 'NODE_ENV']);
    assert.deepEqual(plan.secretNames, ['DAAS_HUB_SHARED_SECRET', 'HIGHLEVEL_API_TOKEN']);
    assert.equal(plan.valuesIncluded, false);
    assert.equal(JSON.stringify(plan).includes(RUNTIME_SECRET_VALUE), false);
    assert.deepEqual(dockerCalls.map((call) => call.method), ['GET']);

    const capture = await manager.captureEnvironment(plan.planId, plan.confirmation);
    assert.equal(capture.environment.variableCount, 4);
    assert.equal(capture.environment.secretValuesIncluded, false);
    assert.equal(capture.environment.ordinaryValuesIncluded, false);
    assert.equal(capture.guarantees.runtimeMutated, false);
    assert.deepEqual(dockerCalls.map((call) => call.method), ['GET', 'GET']);
    const environment = secretManager.getEnvironmentRevision(RESOURCE_ID);
    assert.equal(environment.revision, capture.environment.revision);
    assert.equal(environment.secretRefs.length, 2);
    assert.equal(JSON.stringify(capture).includes(RUNTIME_SECRET_VALUE), false);
    const persistedSecrets = fs.readdirSync(secretManager.paths.recordsRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith('.json'))
      .map((entry) => fs.readFileSync(path.join(secretManager.paths.recordsRoot, entry), 'utf8'))
      .join('\n');
    assert.equal(persistedSecrets.includes(RUNTIME_SECRET_VALUE), false);

    const changed = resource();
    changed.runtime = { ...changed.runtime, imageId: 'sha256:' + 'e'.repeat(64) };
    changed.classification = classifyResource(changed);
    setSnapshot(snapshot(changed));
    await assert.rejects(
      () => manager.captureEnvironment(plan.planId, plan.confirmation),
      (error) => error.code === 'environment-evidence-plan-stale'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workload evidence operations require exact confirmations and remain empty on a clean install', async () => {
  const { manager, root } = harness();
  try {
    const status = manager.status();
    assert.deepEqual(status.summary, { sourceRevisions: 0, environmentRevisions: 0 });
    assert.equal(status.guarantees.cleanInstallRequiresGitCredential, false);
    assert.equal(status.guarantees.runtimeMutated, false);
    await assert.rejects(
      () => manager.planSource({ resourceId: RESOURCE_ID, confirmation: 'yes' }),
      (error) => error.code === 'confirmation-required'
    );
    await assert.rejects(
      () => manager.planEnvironment({ resourceId: RESOURCE_ID, confirmation: 'yes' }),
      (error) => error.code === 'confirmation-required'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
