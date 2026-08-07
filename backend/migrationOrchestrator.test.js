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
    if (current.id === stateless.id) blockers.push(
      {
        code: 'foxos-route-missing',
        section: 'routes',
        severity: 'blocking',
        message: 'The stateless transaction will acquire this route.'
      },
      {
        code: 'runtime-resource-limits-missing',
        section: 'runtime',
        severity: 'blocking',
        message: 'The reviewed candidate contract will set limits.'
      }
    );
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
  return {
    database,
    managed,
    manager,
    protectedCore,
    root,
    secretValue,
    stateful,
    stateless: resources.find((entry) => entry.id === stateless.id)
  };
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
    assert.equal(first.summary.reviewEligible, 1);
    assert.equal(first.summary.applyImplemented, 0);
    assert.equal(first.coordinationHints[0].dependencyDirectionKnown, false);
    assert.equal(first.coordinationHints[0].applyOrderInferred, false);

    const statelessPlan = first.resources.find((entry) => entry.resourceId === stateless.id);
    assert.equal(statelessPlan.strategy, 'blue-green-atomic-route');
    assert.equal(statelessPlan.availability.currentMode, 'zero-downtime-required');
    assert.equal(statelessPlan.availability.sourcePauseBudgetMs, 0);
    assert.equal(statelessPlan.readiness.evidenceComplete, true);
    assert.equal(statelessPlan.readiness.reviewEligible, true);
    assert.equal(statelessPlan.blockers.evidence.length, 0);
    assert.equal(
      statelessPlan.blockers.transaction.some((entry) => entry.code === 'foxos-route-missing'),
      true
    );

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

test('a verified FoxOS migration projection is managed and cannot re-enter migration selection', () => {
  const { manager, stateless, root } = harness();
  try {
    const current = manager.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION });
    const source = current.resources.find((entry) => entry.resourceId === stateless.id);
    assert.equal(source.migrationRequired, true);

    stateless.management = {
      owner: 'foxos',
      state: 'active',
      operationId: 'smop_' + '9'.repeat(32),
      sourceProvider: 'coolify',
      sourcePreserved: true,
      automaticMigrationAllowed: false
    };
    const projected = manager.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION });
    const managed = projected.resources.find((entry) => entry.resourceId === stateless.id);
    assert.equal(managed.currentProvider, 'foxos');
    assert.equal(managed.currentAuthorityClass, 'foxos-owned');
    assert.equal(managed.migrationRequired, false);
    assert.equal(managed.strategy, 'already-foxos-managed');
    assert.equal(managed.readiness.planningStatus, 'already-foxos-managed');
    assert.equal(managed.readiness.reviewEligible, false);
    assert.deepEqual(managed.blockers.authority, []);
    assert.deepEqual(managed.blockers.evidence, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux host services require no migration and completed domains suppress inactive provider duplicates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-native-host-plan-'));
  try {
    const managed = resource('6', {
      name: 'managed-site',
      management: {
        owner: 'foxos',
        logicalResourceId: 'res_' + '6'.repeat(32),
        domains: ['managed.example.test']
      },
      routes: [{ domain: 'managed.example.test', path: '/', tls: true }]
    });
    const definitionBase = {
      id: 'res_' + '7'.repeat(32),
      kind: 'provider-definition',
      name: 'old-managed-definition',
      role: 'application',
      ownership: 'observed',
      provider: 'coolify',
      protected: false,
      provenance: { imported: false, safeLabels: {}, externalDefinition: {} },
      runtime: { engine: 'provider-definition', state: 'stopped', inspection: 'definition-only' },
      ports: [], routes: [],
      declaredRoutes: [{ domain: 'managed.example.test', path: '/', tls: true }],
      mounts: [], networks: []
    };
    const definition = { ...definitionBase, classification: classifyResource(definitionBase) };
    const hostBase = {
      id: 'res_' + '8'.repeat(32),
      kind: 'host-service',
      name: 'WireGuard (wg0)',
      role: 'network-service',
      ownership: 'observed',
      provider: 'linux-host',
      protected: false,
      provenance: { imported: false, safeLabels: {} },
      runtime: {
        engine: 'systemd', unit: 'wg-quick@wg0.service', state: 'running', inspection: 'complete'
      },
      ports: [], routes: [], declaredRoutes: [], mounts: [], networks: []
    };
    const host = { ...hostBase, classification: classifyResource(hostBase) };
    managed.classification = classifyResource(managed);
    const snapshot = {
      snapshotId: 'snap_' + 'f'.repeat(32),
      resources: [managed, definition, host],
      relationships: [],
      conflicts: []
    };
    const manager = createMigrationOrchestrator({
      dataRoot: root,
      resourceRegistry: { getLatest: () => snapshot },
      compileApplicationManifest: () => { throw new Error('managed records need no manifest'); }
    });
    const plan = manager.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION });
    const definitionPlan = plan.resources.find((entry) => entry.resourceId === definition.id);
    const hostPlan = plan.resources.find((entry) => entry.resourceId === host.id);
    assert.equal(definitionPlan.migrationRequired, false);
    assert.equal(definitionPlan.strategy, 'already-foxos-managed');
    assert.equal(definitionPlan.canonicalResourceId, managed.id);
    assert.deepEqual(definitionPlan.blockers.evidence, []);
    assert.equal(hostPlan.migrationRequired, false);
    assert.equal(hostPlan.strategy, 'already-server-owned');
    assert.equal(hostPlan.currentAuthorityClass, 'server-owned');
    assert.equal(hostPlan.readiness.planningStatus, 'already-server-owned');
    assert.equal(plan.summary.alreadyServerOwned, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider sidecars travel with one parent while the provider control plane retires last', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-provider-groups-'));
  try {
    const resourceName = 'n8n-' + 'x'.repeat(20);
    const parent = resource('9', {
      name: resourceName,
      provenance: {
        imported: false,
        project: 'automation',
        service: 'n8n',
        safeLabels: { 'coolify.resourceName': resourceName }
      },
      mounts: [{ type: 'volume', name: 'n8n-data', destination: '/data', readOnly: false }]
    });
    const sidecar = resource('a', {
      name: 'task-runners-' + 'x'.repeat(20),
      role: 'worker',
      provenance: {
        imported: false,
        project: 'automation',
        service: 'task-runners',
        safeLabels: { 'coolify.resourceName': resourceName }
      },
      routes: [],
      ports: [],
      mounts: []
    });
    const proxy = resource('b', {
      name: 'coolify-proxy',
      role: 'proxy',
      provenance: {
        imported: false,
        project: 'coolify-proxy',
        service: 'traefik',
        safeLabels: { 'coolify.managed': 'true' }
      },
      routes: [],
      ports: [],
      mounts: [{ type: 'bind', source: '/data/coolify/proxy', destination: '/data', readOnly: false }]
    });
    const resources = [parent, sidecar, proxy].map((entry) => ({
      ...entry,
      classification: classifyResource(entry)
    }));
    const snapshot = {
      snapshotId: 'snap_' + 'e'.repeat(32),
      resources,
      relationships: [],
      conflicts: []
    };
    const manager = createMigrationOrchestrator({
      dataRoot: root,
      resourceRegistry: { getLatest: () => snapshot },
      compileApplicationManifest: () => ({
        revisionId: 'arev_' + 'c'.repeat(32),
        desired: { source: { type: 'oci-image' }, dependencies: [] },
        gates: { blockers: [{ code: 'external-provider-authority', section: 'ownership' }] }
      })
    });
    const plan = manager.createPlan({ confirmation: PLAN_SERVER_MIGRATION_CONFIRMATION });
    const parentPlan = plan.resources.find((entry) => entry.resourceId === parent.id);
    const sidecarPlan = plan.resources.find((entry) => entry.resourceId === sidecar.id);
    const proxyPlan = plan.resources.find((entry) => entry.resourceId === proxy.id);
    assert.equal(parentPlan.migrationRequired, true);
    assert.deepEqual(parentPlan.migrationGroup.memberResourceIds, [parent.id, sidecar.id].sort());
    assert.ok(parentPlan.blockers.implementation.some((entry) => (
      entry.code === 'provider-resource-group-transaction-required'
    )));
    assert.equal(sidecarPlan.migrationRequired, false);
    assert.equal(sidecarPlan.strategy, 'migrate-with-parent');
    assert.equal(sidecarPlan.parentResourceId, parent.id);
    assert.equal(sidecarPlan.readiness.planningStatus, 'included-with-parent');
    assert.equal(proxyPlan.migrationRequired, false);
    assert.equal(proxyPlan.strategy, 'provider-control-plane-retirement-last');
    assert.equal(proxyPlan.readiness.planningStatus, 'provider-retirement-pending');
    assert.equal(plan.summary.includedWithParent, 1);
    assert.equal(plan.summary.providerRetirementPending, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
