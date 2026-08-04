const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PLAN_APPLICATION_MANIFEST_CONFIRMATION,
  applicationManifestConfirmation,
  createApplicationManifestManager
} = require('./applicationManifestManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const DEPENDENCY_ID = 'res_' + '2'.repeat(32);
const IMAGE_DIGEST = 'sha256:' + 'a'.repeat(64);

function resource(overrides = {}) {
  return {
    schemaVersion: 1,
    id: RESOURCE_ID,
    kind: 'container',
    name: 'foxos-image-update-lab',
    role: 'application',
    ownership: 'foxos-managed',
    provider: 'foxos',
    protected: false,
    provenance: { imported: false, safeLabels: {}, project: null, service: null },
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
      environmentVariableCount: 0,
      inspection: 'complete'
    },
    ports: [{ privatePort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 49152 }],
    routes: [],
    mounts: [],
    networks: [{ name: 'foxos-image-update-lab-candidate-abc123def456' }],
    adoption: { stage: 'foxos-managed', eligible: true, ready: true, blockers: [] },
    ...overrides
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

function snapshot(currentResource = resource(), relationships = []) {
  return {
    schemaVersion: 1,
    snapshotId: 'snap_' + '6'.repeat(24),
    resources: [currentResource],
    relationships,
    inventory: { images: [], networks: [], volumes: [] }
  };
}

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-app-manifest-'));
  let currentResource = options.currentResource || resource();
  let currentRelationships = options.relationships || [];
  const manager = createApplicationManifestManager({
    dataRoot: root,
    resourceRegistry: { getLatest: () => snapshot(currentResource, currentRelationships) },
    getEnvironmentRevision: options.getEnvironmentRevision || (() => null),
    routeStatus: options.routeStatus || (() => ({ configured: false, routes: [] })),
    backupStatus: options.backupStatus || (() => ({ configured: false, ready: false, offHost: false, adapter: null })),
    imageUpdateStatus: options.imageUpdateStatus || (() => imageProof(currentResource)),
    clock: () => new Date('2026-08-04T20:30:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000007'
  });
  return {
    manager,
    root,
    setResource: (value) => { currentResource = value; },
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
  assert.equal(blockerCodes.includes('dependency-manifest-missing:' + DEPENDENCY_ID), true);
  assert.equal(blockerCodes.includes('runtime-resource-limits-missing'), true);
  assert.equal(serialized.includes(secretValue), false);
  assert.equal(draft.desired.environment.ordinaryNames[0], 'SITE_TITLE');
  assert.equal(draft.provenance.importedFrom, 'coolify');
  assert.equal(draft.provenance.providerIdentifiersRequired, false);
  assert.throws(
    () => manager.finalizeDraft(draft.draftId, draft.confirmation),
    (error) => error.code === 'manifest-blocked'
  );

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
