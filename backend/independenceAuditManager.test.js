const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyResource } = require('./resourceClassification');
const {
  AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION,
  createIndependenceAuditManager
} = require('./independenceAuditManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);

function resource(overrides = {}) {
  const value = {
    id: RESOURCE_ID,
    name: 'real-web-app',
    role: 'application',
    ownership: 'observed',
    provider: 'coolify',
    protected: false,
    provenance: {
      project: 'production',
      service: 'web',
      safeLabels: { 'coolify.service.subType': 'application' }
    },
    runtime: {
      image: 'example/web:latest',
      imageId: 'sha256:' + '2'.repeat(64),
      state: 'running',
      inspection: 'complete',
      environmentVariableCount: 3
    },
    ports: [{ privatePort: 8080, hostIp: null, hostPort: null }],
    routes: [{ domain: 'example.test', path: '/', tls: true }],
    mounts: []
  };
  const merged = { ...value, ...overrides };
  return { ...merged, classification: classifyResource(merged) };
}

function manifest(blockers = []) {
  return {
    revisionId: 'arev_' + '3'.repeat(32),
    desired: { source: { type: 'oci-image' } },
    gates: { status: blockers.length ? 'blocked' : 'ready', blockers }
  };
}

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-independence-audit-'));
  const currentResource = options.resource || resource();
  const manager = createIndependenceAuditManager({
    dataRoot: root,
    resourceRegistry: {
      getLatest: () => ({
        schemaVersion: 1,
        snapshotId: 'snap_' + '4'.repeat(32),
        resources: [currentResource]
      })
    },
    compileApplicationManifest: options.compile || (() => manifest([
      { code: 'external-provider-authority', section: 'ownership', severity: 'blocking' },
      { code: 'environment-revision-missing', section: 'environment', severity: 'blocking' },
      { code: 'foxos-route-missing', section: 'routes', severity: 'blocking' }
    ])),
    clock: () => new Date('2026-08-05T10:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000005'
  });
  return { manager, root };
}

test('candidate listing exposes only a read-only stateless application choice', () => {
  const { manager, root } = harness();
  const candidates = manager.candidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].resourceId, RESOURCE_ID);
  assert.equal(candidates[0].stateClass, 'stateless');
  assert.equal(candidates[0].authorityClass, 'provider-owned');
  assert.equal(candidates[0].applyApproved, false);
  assert.equal(candidates[0].providerDetachApproved, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a real-workload audit persists redacted evidence but performs and approves no mutation', () => {
  const { manager, root } = harness();
  const report = manager.createAudit({
    resourceId: RESOURCE_ID,
    confirmation: AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION
  });
  assert.equal(report.mode, 'read-only-independence-audit');
  assert.equal(report.result, 'evidence-incomplete');
  assert.equal(report.guarantees.dockerRequestsMade, 0);
  assert.equal(report.guarantees.runtimeMutated, false);
  assert.equal(report.guarantees.providerDetached, false);
  assert.equal(report.guarantees.applyApproved, false);
  assert.equal(report.evidence.secretValuesIncluded, false);
  assert.deepEqual(report.evidence.manifestBlockers.map((entry) => entry.code), [
    'environment-revision-missing',
    'external-provider-authority',
    'foxos-route-missing'
  ]);
  assert.equal(report.checks.find((entry) => entry.code === 'environment-and-secrets').status, 'blocked');
  assert.equal(report.checks.find((entry) => entry.code === 'routes-and-tls').status, 'blocked');
  assert.equal(fs.statSync(manager.paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(manager.paths.reportsRoot, report.auditId + '.json')).mode & 0o777, 0o600);
  assert.equal(manager.getAudit(report.auditId).auditId, report.auditId);
  fs.rmSync(root, { recursive: true, force: true });
});

test('only external authority remaining means planning-ready, never apply-ready', () => {
  const { manager, root } = harness({
    compile: () => manifest([
      { code: 'external-provider-authority', section: 'ownership', severity: 'blocking' }
    ])
  });
  const report = manager.createAudit({
    resourceId: RESOURCE_ID,
    confirmation: AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION
  });
  assert.equal(report.result, 'ready-for-explicit-migration-planning');
  assert.equal(report.guarantees.applyApproved, false);
  assert.equal(report.guarantees.providerDetached, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('stateful and database resources fail closed as non-candidates', () => {
  const stateful = resource({
    mounts: [{ type: 'volume', name: 'data', destination: '/data', readOnly: false }]
  });
  const { manager, root } = harness({ resource: stateful });
  assert.deepEqual(manager.candidates(), []);
  const report = manager.createAudit({
    resourceId: RESOURCE_ID,
    confirmation: AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION
  });
  assert.equal(report.result, 'not-a-stateless-application-candidate');
  assert.equal(report.checks.find((entry) => entry.code === 'declared-persistence').status, 'blocked');
  fs.rmSync(root, { recursive: true, force: true });
});

test('exact confirmation and resource identifiers gate audit record creation', () => {
  const { manager, root } = harness();
  assert.throws(
    () => manager.createAudit({ resourceId: RESOURCE_ID, confirmation: 'yes' }),
    (error) => error.code === 'confirmation-required'
  );
  assert.throws(
    () => manager.createAudit({ resourceId: '../escape', confirmation: AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION }),
    (error) => error.code === 'invalid-resource-id'
  );
  assert.equal(manager.status().audits.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
