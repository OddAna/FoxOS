const assert = require('node:assert/strict');
const test = require('node:test');
const {
  StatelessMigrationManifestError,
  createStatelessMigrationManifestCompiler
} = require('./statelessMigrationManifestCompiler');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const SNAPSHOT_ID = 'snap_' + '2'.repeat(32);
const MANIFEST_REVISION_ID = 'arev_' + '3'.repeat(32);
const IMAGE_ID = 'sha256:' + '4'.repeat(64);
const IMAGE_REFERENCE = 'registry.example.test/team/app@sha256:' + '5'.repeat(64);

function observedResource(overrides = {}) {
  const base = {
    id: RESOURCE_ID,
    kind: 'container',
    name: 'generic-stateless-app',
    provider: 'legacy-control-plane',
    ownership: 'observed',
    protected: false,
    classification: {
      status: 'classified',
      workloadRole: 'application',
      stateClass: 'stateless',
      authorityClass: 'provider-owned'
    },
    runtime: {
      engine: 'docker',
      containerId: '6'.repeat(64),
      image: 'registry.example.test/team/app:current',
      imageId: IMAGE_ID,
      state: 'running',
      inspection: 'complete',
      restartPolicy: 'no',
      constraints: {
        user: '10001:10001',
        privileged: false,
        readOnlyRootFilesystem: true,
        memoryBytes: null,
        nanoCpus: null,
        pidsLimit: null
      }
    },
    ports: [
      { privatePort: 8080, protocol: 'tcp', hostIp: null, hostPort: null },
      { privatePort: 9090, protocol: 'tcp', hostIp: null, hostPort: null }
    ],
    routes: [
      { domain: 'app.example.test', path: '/', tls: true, privatePort: 8080 },
      { domain: 'api.example.test', path: '/v1', tls: true, privatePort: 9090 }
    ],
    mounts: []
  };
  return { ...base, ...overrides };
}

function applicationManifest(resource, overrides = {}) {
  const desired = {
    source: {
      type: 'oci-image',
      immutableReference: IMAGE_REFERENCE,
      imageId: resource.runtime.imageId
    },
    runtime: {
      engine: 'docker',
      desiredState: 'running',
      restartPolicy: resource.runtime.restartPolicy,
      constraints: resource.runtime.constraints
    },
    environment: {
      revision: 'env_rev_' + '7'.repeat(32),
      ordinaryNames: ['APP_MODE'],
      secretRefs: [{
        name: 'API_TOKEN',
        secretId: 'secret_' + '8'.repeat(32),
        revision: 'secret_rev_' + '9'.repeat(32),
        keyId: 'key_' + 'a'.repeat(24)
      }],
      excluded: [{ name: 'PROVIDER_FQDN', reason: 'provider-runtime-metadata' }],
      valuesIncluded: false
    },
    dependencies: []
  };
  return {
    schemaVersion: 2,
    resourceId: resource.id,
    revisionId: MANIFEST_REVISION_ID,
    desired: { ...desired, ...(overrides.desired || {}) },
    evidence: { registrySnapshotId: SNAPSHOT_ID },
    gates: {
      status: 'blocked',
      blockers: [
        { code: 'external-provider-authority', section: 'ownership', message: 'Provider remains.' },
        { code: 'foxos-route-missing', section: 'routes', message: 'Route is acquired by the transaction.' },
        { code: 'foxos-health-proof-missing', section: 'health', message: 'Candidate health is transaction-gated.' },
        { code: 'update-rollback-proof-missing', section: 'updates', message: 'Rollback is transaction-gated.' },
        { code: 'restart-policy-not-resilient', section: 'runtime', message: 'Candidate policy is explicit.' },
        { code: 'runtime-resource-limits-missing', section: 'runtime', message: 'Candidate defaults are reviewed.' }
      ]
    },
    ignoredOrdinaryValue: 'ordinary-value-must-not-enter-contract',
    ignoredSecretValue: 'secret-value-must-not-enter-contract',
    ...overrides,
    desired: { ...desired, ...(overrides.desired || {}) }
  };
}

function plannedResource(overrides = {}) {
  return {
    resourceId: RESOURCE_ID,
    evidence: {
      registrySnapshotId: SNAPSHOT_ID,
      manifestRevisionId: MANIFEST_REVISION_ID
    },
    dependencies: [],
    ...overrides
  };
}

function harness(options = {}) {
  const resource = options.resource || observedResource();
  const snapshot = options.snapshot || {
    snapshotId: SNAPSHOT_ID,
    resources: [resource]
  };
  const manifest = options.manifest || applicationManifest(resource);
  let registryReads = 0;
  const compiler = createStatelessMigrationManifestCompiler({
    resourceRegistry: {
      getLatest: () => {
        registryReads += 1;
        return snapshot;
      }
    },
    compileApplicationManifest: () => manifest
  });
  const serverPlan = {
    planId: 'mplan_' + 'b'.repeat(32),
    mode: 'read-only-server-migration-plan',
    sourceSnapshotId: SNAPSHOT_ID
  };
  return {
    compile: (planned = plannedResource()) => compiler.compile({ serverPlan, resource: planned }),
    compiler,
    manifest,
    registryReads: () => registryReads,
    resource,
    serverPlan
  };
}

test('generic OCI manifest compiles to a deterministic, multi-route and value-free review contract', () => {
  const context = harness();
  const first = context.compile();
  const second = context.compile();

  assert.deepEqual(first, second);
  assert.match(first.contractId, /^smcontract_[a-f0-9]{32}$/);
  assert.equal(first.readiness.status, 'backend-contract-ready-ui-configuration-required');
  assert.deepEqual(first.readiness.blockers, []);
  assert.equal(first.routes.length, 2);
  assert.deepEqual(first.routes.map((route) => [route.domain, route.upstreamPrivatePort]), [
    ['api.example.test', 9090],
    ['app.example.test', 8080]
  ]);
  assert.equal(first.routes.every((route) => route.tls.authority === 'foxos'), true);
  assert.equal(first.routes.every((route) => route.tls.certificateAdapter === null), true);
  assert.equal(first.routes.every((route) => route.tls.providerRequiredAsAuthority === false), true);
  assert.deepEqual(first.candidate.ingressPorts, [8080, 9090]);
  assert.equal(first.candidate.health.privatePort, null);
  assert.equal(first.candidate.health.path, null);
  assert.equal(first.candidate.health.selectionRequired, true);
  assert.equal(first.candidate.runtime.memoryBytes, 512 * 1024 * 1024);
  assert.equal(first.candidate.runtime.nanoCpus, 1_000_000_000);
  assert.equal(first.candidate.runtime.pidsLimit, 256);
  assert.equal(first.candidate.runtime.restartPolicy, 'unless-stopped');
  assert.equal(first.candidate.runtime.hostPortsPublished, false);
  assert.equal(first.availability.sourcePauseBudgetMs, 0);
  assert.equal(first.availability.unavailableSamplesAllowed, 0);
  assert.equal(first.guarantees.dockerRequestsMade, 0);
  assert.equal(first.guarantees.providerDetached, false);
  assert.equal(first.candidate.environment.valuesIncluded, false);
  assert.equal(first.candidate.environment.resolveOnlyDuringCandidateCreation, true);
  assert.equal(context.registryReads(), 2);

  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes('ordinary-value-must-not-enter-contract'), false);
  assert.equal(serialized.includes('secret-value-must-not-enter-contract'), false);
  assert.equal(serialized.includes('legacy-control-plane'), false);
  assert.equal(serialized.toLowerCase().includes('cloudflare'), false);
});

test('snapshot and manifest drift fail before a contract can be persisted or executed', () => {
  const current = harness();
  current.serverPlan.sourceSnapshotId = 'snap_' + 'c'.repeat(32);
  assert.throws(
    () => current.compiler.compile({ serverPlan: current.serverPlan, resource: plannedResource({
      evidence: { registrySnapshotId: current.serverPlan.sourceSnapshotId, manifestRevisionId: MANIFEST_REVISION_ID }
    }) }),
    (error) => error instanceof StatelessMigrationManifestError && error.code === 'registry-snapshot-stale'
  );

  const staleManifest = harness();
  assert.throws(
    () => staleManifest.compile(plannedResource({
      evidence: { registrySnapshotId: SNAPSHOT_ID, manifestRevisionId: 'arev_' + 'd'.repeat(32) }
    })),
    (error) => error instanceof StatelessMigrationManifestError && error.code === 'manifest-revision-stale'
  );
});

test('unsupported source, persistence, dependency, route and runtime evidence return explicit blockers', () => {
  const cases = [
    {
      expected: 'immutable-oci-runtime-binding-missing',
      setup: (resource) => ({
        resource,
        manifest: applicationManifest(resource, { desired: { source: { type: 'foxos-encrypted-source-archive-revision' } } })
      })
    },
    {
      expected: 'writable-persistence-not-stateless',
      setup: (resource) => ({ resource: { ...resource, mounts: [{ type: 'volume', destination: '/data', readOnly: false }] } })
    },
    {
      expected: 'required-dependency-transaction-not-ready',
      planned: plannedResource({ dependencies: [{ required: true }] }),
      setup: (resource) => ({ resource })
    },
    {
      expected: 'route-private-port-ambiguous',
      setup: (resource) => ({
        resource: { ...resource, routes: [{ domain: 'app.example.test', path: '/', tls: true }] }
      })
    },
    {
      expected: 'route-path-review-required',
      setup: (resource) => ({
        resource: { ...resource, routes: [{ domain: 'app.example.test', path: '/hook/:redacted-deadbeef', tls: true, privatePort: 8080 }] }
      })
    },
    {
      expected: 'privileged-runtime-rejected',
      setup: (resource) => ({
        resource,
        manifest: applicationManifest(resource, {
          desired: { runtime: { constraints: { ...resource.runtime.constraints, privileged: true } } }
        })
      })
    }
  ];

  for (const entry of cases) {
    const base = observedResource();
    const setup = entry.setup(base);
    const resource = setup.resource || base;
    const context = harness({
      resource,
      manifest: setup.manifest || applicationManifest(resource)
    });
    const contract = context.compile(entry.planned || plannedResource());
    assert.equal(
      contract.readiness.blockers.some((blocker) => blocker.code === entry.expected),
      true,
      entry.expected
    );
    assert.equal(contract.guarantees.runtimeMutated, false);
  }
});

test('invalid environment metadata is blocked and cannot smuggle a value into the contract', () => {
  const resource = observedResource();
  const manifest = applicationManifest(resource, {
    desired: {
      environment: {
        revision: 'env_rev_' + '7'.repeat(32),
        ordinaryNames: [],
        secretRefs: [],
        excluded: [{ name: 'PROVIDER_FQDN', reason: 'value-must-never-be-copied' }],
        valuesIncluded: false
      }
    }
  });
  const contract = harness({ resource, manifest }).compile();
  assert.equal(contract.readiness.blockers.some((entry) => entry.code === 'environment-reference-invalid'), true);
  assert.equal(JSON.stringify(contract).includes('value-must-never-be-copied'), false);
});

test('transaction-proven manifest blockers are separated from real precondition failures', () => {
  const resource = observedResource();
  const manifest = applicationManifest(resource);
  manifest.gates.blockers.push({
    code: 'environment-revision-missing',
    section: 'environment',
    message: 'This precondition is not acquired by the migration transaction.'
  });
  const contract = harness({ resource, manifest }).compile();
  assert.equal(contract.readiness.blockers.some((entry) => (
    entry.code === 'manifest-blocker:environment-revision-missing' && entry.source === 'application-manifest'
  )), true);
});
