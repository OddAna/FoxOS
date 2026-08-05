const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyResource } = require('./resourceClassification');
const {
  PLAN_APPLICATION_MANIFEST_CONFIRMATION,
  applicationManifestConfirmation,
  createApplicationManifestManager,
  resourceFingerprint
} = require('./applicationManifestManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const DEPENDENCY_ID = 'res_' + '2'.repeat(32);
const SOURCE_RESOURCE_ID = 'res_' + 'a'.repeat(32);
const COMPOSE_API_RESOURCE_ID = 'res_' + 'b'.repeat(32);
const COMPOSE_WEB_RESOURCE_ID = 'res_' + 'c'.repeat(32);
const COMPOSE_GROUP_RESOURCE_ID = 'res_' + 'd'.repeat(32);
const IMAGE_DIGEST = 'sha256:' + 'a'.repeat(64);

function resource(overrides = {}) {
  const value = {
    schemaVersion: 1,
    id: RESOURCE_ID,
    kind: 'container',
    name: 'foxos-image-update-lab',
    role: 'application',
    ownership: 'foxos-managed',
    provider: 'foxos',
    protected: false,
    provenance: {
      imported: false,
      safeLabels: { 'com.foxos.image-update.disposable': 'true' },
      project: null,
      service: null
    },
    runtime: {
      engine: 'docker',
      containerId: 'c'.repeat(64),
      image: 'traefik/whoami@' + IMAGE_DIGEST,
      imageId: 'sha256:' + 'b'.repeat(64),
      state: 'running',
      status: 'Up 1 minute',
      restartPolicy: 'unless-stopped',
      health: { configured: false, status: null },
      constraints: {
        user: '65532:65532',
        privileged: false,
        readOnlyRootFilesystem: true,
        noNewPrivileges: true,
        allCapabilitiesDropped: true,
        memoryBytes: 134217728,
        nanoCpus: 500000000,
        pidsLimit: 128
      },
      environmentVariableCount: 1,
      inspection: 'complete'
    },
    ports: [{ privatePort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 49152 }],
    routes: [],
    mounts: [],
    networks: [{ name: 'foxos-image-update-lab-candidate-abc123def456' }],
    adoption: { stage: 'foxos-managed', eligible: true, ready: true, blockers: [] }
  };
  const merged = { ...value, ...overrides };
  return {
    ...merged,
    classification: overrides.classification || classifyResource(merged)
  };
}

function imageProof(currentResource = resource()) {
  const healthProof = {
    verified: true,
    statusCode: 200,
    bodyDigest: 'sha256:' + 'd'.repeat(64),
    expectedBodyMatched: true,
    hostPort: 49152,
    verifiedAt: '2026-08-04T20:00:00.000Z'
  };
  return {
    guarantees: { environmentSupported: false },
    current: {
      resourceId: currentResource.id,
      operationId: 'iop_' + '3'.repeat(32),
      revisionId: 'irev_' + '4'.repeat(32),
      containerId: currentResource.runtime.containerId,
      image: { digest: IMAGE_DIGEST },
      healthProof
    },
    operations: [{
      operationId: 'iop_' + '5'.repeat(32),
      status: 'rolled-back',
      previous: { operationId: 'iop_' + '3'.repeat(32) },
      rollback: { proof: healthProof }
    }]
  };
}

function sourceProof(currentResource) {
  const healthProof = imageProof(currentResource).current.healthProof;
  const currentOperationId = 'dop_' + 'a'.repeat(32);
  const revisionId = 'drev_' + 'b'.repeat(32);
  const source = {
    adapter: 'public-git-https',
    repository: 'https://github.com/example/foxos-source-canary.git',
    ref: 'main',
    refType: 'branch',
    commit: 'c'.repeat(40),
    contextPath: '.',
    dockerfile: 'Dockerfile',
    contextDigest: 'sha256:' + 'd'.repeat(64),
    dockerfileDigest: 'sha256:' + 'e'.repeat(64),
    fileCount: 3,
    totalBytes: 4096
  };
  return {
    guarantees: { environmentSupported: false },
    current: {
      resourceId: currentResource.id,
      operationId: currentOperationId,
      revisionId,
      containerId: currentResource.runtime.containerId,
      imageId: currentResource.runtime.imageId,
      source,
      healthProof
    },
    plans: [{ revisionId, source }],
    operations: [{
      operationId: 'dop_' + 'f'.repeat(32),
      status: 'rolled-back',
      previous: { operationId: currentOperationId },
      rollback: { proof: healthProof }
    }]
  };
}

function composeProof(apiResource, webResource) {
  const healthProof = imageProof(webResource).current.healthProof;
  const currentOperationId = 'cop_' + '1'.repeat(32);
  const revisionId = 'crev_' + '2'.repeat(32);
  const source = {
    adapter: 'public-git-https',
    repository: 'https://github.com/example/foxos-compose-canary.git',
    ref: 'main',
    refType: 'branch',
    commit: '3'.repeat(40),
    manifestPath: 'compose.yaml',
    manifestDigest: 'sha256:' + '4'.repeat(64),
    manifestBytes: 2048
  };
  const services = [
    {
      name: 'api',
      build: { contextPath: 'api', dockerfile: 'Dockerfile' },
      dependsOn: [],
      privatePort: 3000,
      contextDigest: 'sha256:' + '5'.repeat(64),
      dockerfileDigest: 'sha256:' + '6'.repeat(64),
      fileCount: 2,
      totalBytes: 2048
    },
    {
      name: 'web',
      build: { contextPath: 'web', dockerfile: 'Dockerfile' },
      dependsOn: ['api'],
      privatePort: 8080,
      contextDigest: 'sha256:' + '7'.repeat(64),
      dockerfileDigest: 'sha256:' + '8'.repeat(64),
      fileCount: 2,
      totalBytes: 2048
    }
  ];
  return {
    guarantees: { environmentSupported: false },
    current: {
      resourceId: COMPOSE_GROUP_RESOURCE_ID,
      operationId: currentOperationId,
      revisionId,
      services: [
        { name: 'api', containerId: apiResource.runtime.containerId, imageId: apiResource.runtime.imageId },
        { name: 'web', containerId: webResource.runtime.containerId, imageId: webResource.runtime.imageId }
      ],
      startOrder: ['api', 'web'],
      ingressService: 'web',
      source,
      healthProof
    },
    plans: [{
      revisionId,
      source,
      workflow: {
        graphDigest: 'sha256:' + '9'.repeat(64),
        graph: { ingressService: 'web', services, startOrder: ['api', 'web'] }
      }
    }],
    operations: [{
      operationId: 'cop_' + 'a'.repeat(32),
      status: 'rolled-back',
      previous: { operationId: currentOperationId },
      rollback: { proof: healthProof }
    }]
  };
}

function snapshot(currentResources = [resource()], relationships = []) {
  return {
    schemaVersion: 1,
    snapshotId: 'snap_' + '6'.repeat(24),
    resources: currentResources,
    relationships,
    inventory: { images: [], networks: [], volumes: [] }
  };
}

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-app-manifest-'));
  let currentResources = options.currentResources || [options.currentResource || resource()];
  let currentRelationships = options.relationships || [];
  const manager = createApplicationManifestManager({
    dataRoot: root,
    resourceRegistry: { getLatest: () => snapshot(currentResources, currentRelationships) },
    getEnvironmentRevision: options.getEnvironmentRevision || (() => null),
    routeStatus: options.routeStatus || (() => ({ configured: false, routes: [] })),
    backupStatus: options.backupStatus || (() => ({ configured: false, ready: false, offHost: false, adapter: null })),
    sourceDeploymentStatus: options.sourceDeploymentStatus || (() => ({ current: null, plans: [], operations: [] })),
    composeDeploymentStatus: options.composeDeploymentStatus || (() => ({ current: null, plans: [], operations: [] })),
    imageUpdateStatus: options.imageUpdateStatus || (() => imageProof(currentResources[0])),
    workloadEvidenceStatus: options.workloadEvidenceStatus || (() => ({ sourceCurrent: [], guarantees: {} })),
    clock: () => new Date('2026-08-04T20:30:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000007'
  });
  return {
    manager,
    root,
    setResource: (value) => { currentResources = [value, ...currentResources.slice(1)]; },
    setResources: (value) => { currentResources = value; },
    setRelationships: (value) => { currentRelationships = value; }
  };
}

test('a fully evidenced FoxOS resource finalizes into an owner-only server manifest without runtime mutation', () => {
  const { manager, root } = harness();
  const draft = manager.createDraft({
    resourceId: RESOURCE_ID,
    confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION
  });

  assert.equal(draft.lifecycle, 'import-draft');
  assert.equal(draft.gates.status, 'ready');
  assert.equal(draft.gates.runtimeMutationIncluded, false);
  assert.equal(draft.desired.source.immutableReference, 'traefik/whoami@' + IMAGE_DIGEST);
  assert.equal(draft.desired.environment.valuesIncluded, false);
  assert.equal(draft.desired.environment.observedVariableCount, 1);
  assert.equal(draft.desired.environment.sourceDefaultVariableCount, 1);
  assert.equal(draft.desired.environment.managedVariableCount, 0);
  assert.equal(draft.schemaVersion, 2);
  assert.equal(draft.desired.identity.classification.workloadRole, 'application');
  assert.equal(draft.desired.identity.classification.stateClass, 'stateless');
  assert.equal(draft.desired.identity.classification.authorityClass, 'foxos-owned');
  assert.equal(draft.evidence.classificationRevision, resource().classification.revision);
  assert.equal(draft.confirmation, applicationManifestConfirmation(draft.draftId));

  const manifest = manager.finalizeDraft(draft.draftId, draft.confirmation);
  assert.equal(manifest.lifecycle, 'foxos-managed');
  assert.equal(manifest.gates.status, 'ready');
  assert.equal(manifest.gates.providerDetachApproved, false);
  assert.equal(manager.getCurrent(RESOURCE_ID).revisionId, manifest.revisionId);
  assert.equal(manager.status().summary.finalized, 1);
  assert.equal(fs.statSync(manager.paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(manager.paths.currentRoot, RESOURCE_ID + '.json')).mode & 0o777, 0o600);

  fs.rmSync(root, { recursive: true, force: true });
});

test('an external stateless workload uses its authenticated local source archive and environment revision but remains blocked', () => {
  const external = resource({
    name: 'provider-site',
    ownership: 'observed',
    provider: 'coolify',
    provenance: { imported: false, safeLabels: {}, project: 'site', service: 'web' },
    runtime: {
      ...resource().runtime,
      image: 'provider-site:latest',
      environmentVariableCount: 3,
      constraints: {
        ...resource().runtime.constraints,
        memoryBytes: null,
        nanoCpus: null,
        pidsLimit: null
      }
    },
    routes: [{ domain: 'site.example.test', path: '/', tls: true }]
  });
  external.classification = classifyResource(external);
  const environment = {
    schemaVersion: 2,
    resourceId: external.id,
    revision: 'env_rev_' + '1'.repeat(32),
    ordinary: [{ name: 'NODE_ENV', value: 'production' }],
    secretRefs: [{
      name: 'API_TOKEN',
      secretId: 'secret_' + '2'.repeat(32),
      revision: 'secret_rev_' + '3'.repeat(32),
      keyId: 'key_' + '4'.repeat(24)
    }],
    excluded: [{ name: 'COOLIFY_FQDN', reason: 'provider-runtime-metadata' }],
    secretValuesIncluded: false
  };
  const sourceRevision = {
    schemaVersion: 2,
    type: 'foxos-encrypted-source-archive-revision',
    revisionId: 'wsr_' + '5'.repeat(32),
    resourceId: external.id,
    resourceFingerprint: resourceFingerprint(external, []),
    observedContainerId: external.runtime.containerId,
    observedImageId: external.runtime.imageId,
    source: {
      adapter: 'git-https-private',
      repository: 'https://github.com/example/private-site.git',
      ref: 'main',
      commit: '6'.repeat(40),
      contextPath: '.',
      dockerfile: 'Dockerfile',
      contextDigest: 'sha256:' + '7'.repeat(64),
      dockerfileDigest: 'sha256:' + '8'.repeat(64),
      fileCount: 8,
      totalBytes: 4096,
      credential: {
        username: 'x-access-token',
        secretId: 'secret_' + '9'.repeat(32),
        revision: 'secret_rev_' + 'a'.repeat(32),
        keyId: 'key_' + 'b'.repeat(24),
        valueIncluded: false
      }
    },
    archive: {
      file: 'workload-evidence/source-archives/revision.enc',
      digest: 'sha256:' + 'c'.repeat(64),
      bytes: 8192,
      encryptedDigest: 'sha256:' + 'd'.repeat(64),
      encryptedBytes: 8300,
      algorithm: 'aes-256-gcm',
      keyId: 'key_' + 'e'.repeat(24),
      authenticated: true,
      plaintextIncluded: false,
      verification: { verified: true, code: 'source-archive-authenticated' }
    },
    runtimeBinding: {
      verified: false,
      observedImageId: external.runtime.imageId,
      reason: 'captured-source-has-not-yet-been-built-and-compared-by-foxos'
    },
    externalGitRequiredToReconstructRevision: false,
    credentialValueIncluded: false
  };
  const { manager, root } = harness({
    currentResource: external,
    getEnvironmentRevision: () => environment,
    imageUpdateStatus: () => ({ current: null, operations: [] }),
    workloadEvidenceStatus: () => ({
      sourceCurrent: [sourceRevision],
      guarantees: { environmentSupported: true, externalGitRequiredToReconstructCapturedRevision: false }
    })
  });
  try {
    const draft = manager.createDraft({
      resourceId: external.id,
      confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION
    });
    const blockerCodes = draft.gates.blockers.map((blocker) => blocker.code);
    assert.equal(draft.desired.source.type, 'foxos-encrypted-source-archive-revision');
    assert.equal(draft.desired.source.archive.externalGitRequiredToReconstructRevision, false);
    assert.equal(draft.desired.source.credential.valueIncluded, false);
    assert.equal(draft.desired.environment.revision, environment.revision);
    assert.equal(draft.desired.environment.observedVariableCount, 3);
    assert.equal(draft.desired.environment.managedVariableCount, 2);
    assert.equal(draft.desired.environment.excludedProviderVariableCount, 1);
    assert.deepEqual(draft.desired.environment.excluded, [{
      name: 'COOLIFY_FQDN',
      reason: 'provider-runtime-metadata'
    }]);
    assert.equal(blockerCodes.includes('immutable-image-missing'), false);
    assert.equal(blockerCodes.includes('environment-revision-missing'), false);
    assert.equal(blockerCodes.includes('source-runtime-binding-missing'), true);
    assert.equal(blockerCodes.includes('external-provider-authority'), true);
    assert.equal(draft.gates.status, 'blocked');
    assert.equal(draft.gates.runtimeMutationIncluded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external applications become redacted blocked import drafts and cannot be finalized', () => {
  const secretValue = 'must-never-enter-the-manifest';
  const external = resource({
    name: 'legacy-wordpress',
    ownership: 'observed',
    provider: 'coolify',
    runtime: {
      ...resource().runtime,
      image: 'wordpress:latest',
      environmentVariableCount: 2,
      constraints: { ...resource().runtime.constraints, memoryBytes: null }
    },
    routes: [{ domain: 'legacy.example.test', scheme: 'https', path: '/', tls: true }],
    mounts: [{ type: 'volume', name: 'wordpress-data', source: '/var/lib/docker/volumes/wordpress-data/_data', destination: '/var/www/html', readOnly: false }]
  });
  const relationship = {
    id: 'rel_' + '8'.repeat(24),
    type: 'shared-network',
    value: 'provider-network',
    resourceIds: [RESOURCE_ID, DEPENDENCY_ID]
  };
  const { manager, root } = harness({
    currentResource: external,
    relationships: [relationship],
    getEnvironmentRevision: () => ({
      revision: 'envrev_' + '9'.repeat(24),
      ordinary: [{ name: 'SITE_TITLE', value: secretValue }],
      secretRefs: [{ name: 'DB_PASSWORD', secretId: 'sec_123', revision: 3, keyId: 'key_123' }]
    }),
    imageUpdateStatus: () => ({ current: null, operations: [] })
  });

  const draft = manager.createDraft({ resourceId: RESOURCE_ID, confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION });
  const serialized = JSON.stringify(draft);
  const blockerCodes = draft.gates.blockers.map((blocker) => blocker.code);
  assert.equal(draft.gates.status, 'blocked');
  assert.equal(blockerCodes.includes('external-provider-authority'), true);
  assert.equal(blockerCodes.includes('foxos-route-missing'), true);
  assert.equal(blockerCodes.includes('restore-proof-missing'), true);
  assert.equal(blockerCodes.includes('dependency-manifest-missing:' + DEPENDENCY_ID), false);
  assert.equal(blockerCodes.includes('runtime-resource-limits-missing'), true);
  assert.equal(serialized.includes(secretValue), false);
  assert.equal(draft.desired.environment.ordinaryNames[0], 'SITE_TITLE');
  assert.equal(draft.provenance.importedFrom, 'coolify');
  assert.equal(draft.desired.identity.classification.stateClass, 'stateful');
  assert.equal(draft.desired.identity.classification.authorityClass, 'provider-owned');
  assert.equal(draft.provenance.providerIdentifiersRequired, false);
  assert.equal(draft.desired.dependencies[0].observed, true);
  assert.equal(draft.desired.dependencies[0].required, false);
  assert.throws(
    () => manager.finalizeDraft(draft.draftId, draft.confirmation),
    (error) => error.code === 'manifest-blocked'
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('database classification requires a dedicated lifecycle even without an observed mount', () => {
  const database = resource({
    name: 'foxos-postgres',
    role: 'database',
    runtime: {
      ...resource().runtime,
      image: 'postgres@' + IMAGE_DIGEST,
      environmentVariableCount: 1
    },
    ports: [{ privatePort: 5432, protocol: 'tcp', hostIp: null, hostPort: null }],
    mounts: []
  });
  const { manager, root } = harness({ currentResource: database });
  const draft = manager.createDraft({
    resourceId: RESOURCE_ID,
    confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION
  });
  const codes = draft.gates.blockers.map((blocker) => blocker.code);
  assert.equal(draft.desired.identity.classification.workloadRole, 'database');
  assert.equal(draft.desired.identity.classification.stateClass, 'database');
  assert.equal(codes.includes('workload-role-lifecycle-unsupported'), true);
  assert.equal(codes.includes('database-lifecycle-unsupported'), true);
  assert.equal(draft.gates.status, 'blocked');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a FoxOS public Git build revision becomes the immutable application source', () => {
  const sourceResource = resource({
    id: SOURCE_RESOURCE_ID,
    name: 'foxos-deployment-lab',
    runtime: {
      ...resource().runtime,
      containerId: 'a'.repeat(64),
      image: 'foxos-deployment-lab:drev-test',
      imageId: 'sha256:' + 'c'.repeat(64),
      environmentVariableCount: 3
    }
  });
  const state = sourceProof(sourceResource);
  const { manager, root } = harness({
    currentResources: [sourceResource],
    sourceDeploymentStatus: () => state,
    imageUpdateStatus: () => ({ current: null, operations: [] })
  });

  const draft = manager.createDraft({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION
  });
  assert.equal(draft.gates.status, 'ready');
  assert.equal(draft.desired.source.type, 'foxos-source-build-revision');
  assert.equal(draft.desired.source.commit, 'c'.repeat(40));
  assert.equal(draft.desired.source.context.digest, 'sha256:' + 'd'.repeat(64));
  assert.equal(draft.desired.source.build.imageId, sourceResource.runtime.imageId);
  assert.equal(draft.desired.environment.sourceDefaultVariableCount, 3);
  assert.equal(draft.desired.environment.managedVariableCount, 0);
  assert.equal(draft.evidence.sourceAuthority, 'foxos-source-deployment');
  assert.equal(draft.evidence.updateRollbackProof.verified, true);
  assert.equal(manager.finalizeDraft(draft.draftId, draft.confirmation).lifecycle, 'foxos-managed');

  fs.rmSync(root, { recursive: true, force: true });
});

test('corrupted FoxOS source revision evidence fails closed', () => {
  const sourceResource = resource({
    id: SOURCE_RESOURCE_ID,
    name: 'foxos-deployment-lab',
    runtime: {
      ...resource().runtime,
      containerId: 'a'.repeat(64),
      image: 'foxos-deployment-lab:drev-test',
      imageId: 'sha256:' + 'c'.repeat(64),
      environmentVariableCount: 0
    }
  });
  const state = sourceProof(sourceResource);
  state.plans[0].source.contextDigest = null;
  const { manager, root } = harness({
    currentResources: [sourceResource],
    sourceDeploymentStatus: () => state,
    imageUpdateStatus: () => ({ current: null, operations: [] })
  });

  const draft = manager.createDraft({
    resourceId: SOURCE_RESOURCE_ID,
    confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION
  });
  assert.equal(draft.gates.status, 'blocked');
  assert.equal(
    draft.gates.blockers.some((blocker) => blocker.code === 'foxos-source-revision-missing'),
    true
  );
  assert.throws(
    () => manager.finalizeDraft(draft.draftId, draft.confirmation),
    (error) => error.code === 'manifest-blocked'
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test('Compose service manifests share one immutable graph and enforce directed dependencies only', () => {
  const apiResource = resource({
    id: COMPOSE_API_RESOURCE_ID,
    name: 'foxos-compose-lab-api',
    runtime: {
      ...resource().runtime,
      containerId: 'b'.repeat(64),
      image: 'foxos-compose-lab-api:crev-test',
      imageId: 'sha256:' + 'd'.repeat(64),
      environmentVariableCount: 2
    },
    ports: [{ privatePort: 3000, protocol: 'tcp', hostIp: null, hostPort: null }]
  });
  const webResource = resource({
    id: COMPOSE_WEB_RESOURCE_ID,
    name: 'foxos-compose-lab-web',
    runtime: {
      ...resource().runtime,
      containerId: 'c'.repeat(64),
      image: 'foxos-compose-lab-web:crev-test',
      imageId: 'sha256:' + 'e'.repeat(64),
      environmentVariableCount: 2
    }
  });
  const state = composeProof(apiResource, webResource);
  const sharedNetwork = {
    id: 'rel_' + 'b'.repeat(24),
    type: 'shared-network',
    resourceIds: [COMPOSE_API_RESOURCE_ID, COMPOSE_WEB_RESOURCE_ID]
  };
  const { manager, root } = harness({
    currentResources: [apiResource, webResource],
    relationships: [sharedNetwork],
    composeDeploymentStatus: () => state,
    imageUpdateStatus: () => ({ current: null, operations: [] })
  });

  const apiDraft = manager.createDraft({
    resourceId: COMPOSE_API_RESOURCE_ID,
    confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION
  });
  assert.equal(apiDraft.gates.status, 'ready');
  assert.equal(apiDraft.desired.source.type, 'foxos-compose-deployment-revision');
  assert.equal(apiDraft.desired.source.graph.services.length, 2);
  assert.equal(apiDraft.desired.dependencies.length, 1);
  assert.equal(apiDraft.desired.dependencies[0].required, false);
  manager.finalizeDraft(apiDraft.draftId, apiDraft.confirmation);

  const webDraft = manager.createDraft({
    resourceId: COMPOSE_WEB_RESOURCE_ID,
    confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION
  });
  const directed = webDraft.desired.dependencies.find((dependency) => dependency.type === 'compose-depends-on');
  assert.equal(webDraft.gates.status, 'ready');
  assert.equal(directed.sourceResourceId, COMPOSE_WEB_RESOURCE_ID);
  assert.equal(directed.targetResourceId, COMPOSE_API_RESOURCE_ID);
  assert.equal(directed.required, true);
  assert.equal(webDraft.desired.environment.sourceDefaultVariableCount, 2);
  assert.equal(manager.finalizeDraft(webDraft.draftId, webDraft.confirmation).lifecycle, 'foxos-managed');
  assert.equal(manager.status().summary.finalized, 2);
  assert.deepEqual(manager.status().guarantees.sourceTypes, [
    'oci-image',
    'foxos-source-build-revision',
    'foxos-compose-deployment-revision',
    'foxos-encrypted-source-archive-revision'
  ]);
  assert.equal(manager.status().guarantees.sharedNetworkImpliesDependency, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('exact confirmations and observed-state drift protect manifest finalization', () => {
  const { manager, root, setResource } = harness();
  assert.throws(
    () => manager.createDraft({ resourceId: RESOURCE_ID, confirmation: 'yes' }),
    (error) => error.code === 'confirmation-required'
  );
  const draft = manager.createDraft({ resourceId: RESOURCE_ID, confirmation: PLAN_APPLICATION_MANIFEST_CONFIRMATION });
  assert.throws(
    () => manager.finalizeDraft(draft.draftId, 'yes'),
    (error) => error.code === 'confirmation-required'
  );
  setResource(resource({ name: 'drifted-name' }));
  assert.throws(
    () => manager.finalizeDraft(draft.draftId, draft.confirmation),
    (error) => error.code === 'manifest-draft-stale'
  );

  fs.rmSync(root, { recursive: true, force: true });
});
