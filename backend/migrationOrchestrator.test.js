const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyResource } = require('./resourceClassification');
const {
  PLAN_SERVER_MIGRATION_CONFIRMATION,
  createMigrationOrchestrator
} = require('./migrationOrchestrator');

function resource(index, overrides = {}) {
  const base = {
    schemaVersion: 1,
    id: 'res_' + index.repeat(32),
    kind: 'container',
    name: 'resource-' + index,
    role: 'application',
    ownership: 'observed',
    provider: 'coolify',
    protected: false,
    provenance: { imported: false, safeLabels: {}, project: 'project-one', service: 'service-' + index },
    runtime: {
      engine: 'docker',
      containerId: index.repeat(64),
      image: 'example/app:latest',
      imageId: 'sha256:' + index.repeat(64),
      state: 'running',
      restartPolicy: 'unless-stopped',
      health: { configured: true, status: 'healthy' },
      constraints: { memoryBytes: null, nanoCpus: null, pidsLimit: null },
      environmentVariableCount: 0,
      inspection: 'complete'
    },
    ports: [{ privatePort: 8080, protocol: 'tcp', hostIp: null, hostPort: null }],
    routes: [{ domain: 'app-' + index + '.example.test', path: '/', tls: true }],
    mounts: [],
    networks: [{ name: 'provider-network' }],
    adoption: { stage: 'observed', eligible: true, ready: false, blockers: [] }
  };
  const merged = { ...base, ...overrides };
  return { ...merged, classification: overrides.classification || classifyResource(merged) };
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-migration-orchestrator-'));
  const stateless = resource('1');
  const stateful = resource('2', {
    name: 'stateful-app',
    mounts: [{ type: 'volume', name: 'stateful-data', destination: '/data', readOnly: false }]
  });
  const database = resource('3', {
    name: 'postgres-database',
    role: 'database',
    provenance: {
      imported: false,
      safeLabels: { 'coolify.service.subType': 'database' },
      project: 'project-one',
      service: 'postgres'
    },
    routes: [],
    mounts: [{ type: 'volume', name: 'postgres-data', destination: '/var/lib/postgresql/data', readOnly: false }]
  });
  const managed = resource('4', {
    name: 'foxos-managed-app',
    provider: 'foxos',
    ownership: 'foxos-managed',
    routes: []
  });
  const protectedCore = resource('5', {
    name: 'foxos',
    role: 'core',
    provider: 'foxos',
    ownership: 'foxos-managed',
    protected: true,
    routes: []
  });
  const resources = [stateless, stateful, database, managed, protectedCore].map((value) => ({
    ...value,
    classification: classifyResource(value)
  }));
  const snapshot = {
    schemaVersion: 1,
    snapshotId: 'snap_' + 'a'.repeat(32),
    generatedAt: '2026-08-05T12:00:00.000Z',
    resources,
    relationships: [{
      id: 'rel_' + 'b'.repeat(24),
      type: 'shared-network',
      value: 'provider-network',
      resourceIds: [stateless.id, stateful.id, database.id]
    }],
    conflicts: []
  };
  const secretValue = 'must-never-enter-orchestrator-plan';
  const compileApplicationManifest = (resourceId) => {
    const current = resources.find((candidate) => candidate.id === resourceId);
    const external = current.classification.authorityClass === 'provider-owned';
    const blockers = external ? [{
      code: 'external-provider-authority',
      section: 'ownership',
      severity: 'blocking',
      message: 'External authority remains.'
    }] : [];
    if (current.id === stateful.id) blockers.push({
      code: 'recovery-target-unavailable',
      section: 'recovery',
      severity: 'blocking',
      message: 'Off-host recovery is missing.'
    });
    if (current.id === database.id) blockers.push({
      code: 'database-lifecycle-unsupported',
      section: 'classification',
      severity: 'blocking',
      message: 'Database lifecycle is missing.'
    });
    return {
      revisionId: 'apprev_' + resourceId.slice(-24),
      desired: {
        source: { type: 'oci-image', immutableReference: null },
        dependencies: [{
          relationshipId: 'rel_' + 'b'.repeat(24),
          type: 'shared-network',
          resourceIds: [stateless.id, stateful.id, database.id],
          required: false,
          observed: true
        }],
        environment: { ordinaryNames: ['SAFE_NAME'], secretRefs: [{ name: 'TOKEN', secretId: 'sec_redacted' }] }
      },
      gates: { status: blockers.length ? 'blocked' : 'ready', blockers },
      testOnlySecretValue: secretValue
    };
  };
  const manager = createMigrationOrchestrator({
    dataRoot: root,
    resourceRegistry: { getLatest: () => snapshot },
    compileApplicationManifest,
    clock: () => new Date('2026-08-05T12:30:00.000Z')
  });
  return { database, managed, manager, protectedCore, root, secretValue, stateful, stateless };
}

test('whole-server planning is deterministic, class-aware, redacted and plan-only', () => {
  const { database, managed, manager, protectedCore, root, secretValue, stateful, stateless } = harness();
  try {
    const first = manager.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION });
    const second = manager.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION });
    assert.equal(first.planId, second.planId);
    assert.equal(first.summary.resources, 5);
    assert.equal(first.summary.migrationRequired, 3);
    assert.equal(first.summary.alreadyFoxOSManaged, 1);
    assert.equal(first.summary.protectedSkipped, 1);
    assert.equal(first.summary.applyImplemented, 0);
    assert.equal(first.coordinationHints[0].dependencyDirectionKnown, false);
    assert.equal(first.coordinationHints[0].applyOrderInferred, false);

    const statelessPlan = first.resources.find((entry) => entry.resourceId === stateless.id);
    assert.equal(statelessPlan.strategy, 'blue-green-atomic-route');
    assert.equal(statelessPlan.availability.currentMode, 'zero-downtime-required');
    assert.equal(statelessPlan.availability.sourcePauseBudgetMs, 0);

    const statefulPlan = first.resources.find((entry) => entry.resourceId === stateful.id);
    assert.equal(statefulPlan.strategy, 'shadow-refresh-bounded-quiesce');
    assert.equal(statefulPlan.availability.sourcePauseBudgetMs, null);
    assert.match(statefulPlan.availability.postRoadmapCapability, /zero-downtime/);
    assert.equal(
      statefulPlan.blockers.implementation.some((entry) => entry.code === 'stateful-cutover-pause-budget-unset'),
      true
    );

    const databasePlan = first.resources.find((entry) => entry.resourceId === database.id);
    assert.equal(databasePlan.strategy, 'database-aware-replication-handoff');
    assert.equal(databasePlan.readiness.evidenceComplete, false);
    assert.equal(
      databasePlan.blockers.implementation.some((entry) => entry.code === 'database-aware-handoff-not-implemented'),
      true
    );
    assert.equal(first.resources.find((entry) => entry.resourceId === managed.id).strategy, 'already-foxos-managed');
    assert.equal(first.resources.find((entry) => entry.resourceId === protectedCore.id).strategy, 'protected-skip');

    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes(secretValue), false);
    assert.equal(first.guarantees.dockerRequestsMade, 0);
    assert.equal(first.guarantees.runtimeMutated, false);
    assert.equal(first.guarantees.routesMutated, false);
    assert.equal(first.guarantees.providerStateMutated, false);
    assert.equal(first.guarantees.applyImplemented, false);
    assert.equal(first.guarantees.applyApproved, false);
    assert.equal(first.guarantees.zeroDowntimeStatefulPostRoadmap, true);

    const planFile = path.join(manager.paths.plansRoot, first.planId + '.json');
    assert.equal(fs.statSync(manager.paths.plansRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(planFile).mode & 0o777, 0o600);
    assert.equal(manager.getPlan(first.planId).planId, first.planId);
    assert.equal(manager.status().summary.plans, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planning requires exact confirmation and an existing registry snapshot', () => {
  const { manager, root } = harness();
  try {
    assert.throws(
      () => manager.createPlan({ confirmation: 'PLAN MIGRATION' }),
      (error) => error.code === 'confirmation-required'
    );
    assert.throws(
      () => manager.getPlan('mplan_invalid'),
      (error) => error.code === 'invalid-plan-id'
    );
    const empty = createMigrationOrchestrator({
      dataRoot: root,
      resourceRegistry: { getLatest: () => null },
      compileApplicationManifest: () => null
    });
    assert.throws(
      () => empty.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION }),
      (error) => error.code === 'registry-not-scanned'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
