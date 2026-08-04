const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyResource } = require('./resourceClassification');

function resource(overrides = {}) {
  const base = {
    name: 'website',
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
      image: 'example/website:latest',
      state: 'running',
      inspection: 'complete'
    },
    ports: [{ privatePort: 8080, hostIp: null, hostPort: null }],
    routes: [{ domain: 'example.test', path: '/', tls: true }],
    mounts: []
  };
  return { ...base, ...overrides };
}

test('a real external web workload is classified as stateless and provider-owned without approving apply', () => {
  const classification = classifyResource(resource());
  assert.equal(classification.workloadRole, 'application');
  assert.equal(classification.stateClass, 'stateless');
  assert.equal(classification.authorityClass, 'provider-owned');
  assert.equal(classification.status, 'classified');
  assert.equal(classification.independenceAudit.eligibleForReadOnlyAudit, true);
  assert.equal(classification.independenceAudit.applyApproved, false);
  assert.equal(classification.independenceAudit.providerDetachApproved, false);
  assert.deepEqual(classification.warnings, [
    'no-declared-writable-mount-does-not-prove-application-data-free'
  ]);
});

test('database evidence wins over public routes and writable storage remains database state', () => {
  const classification = classifyResource(resource({
    name: 'production-postgres',
    role: 'database',
    provenance: {
      project: 'production',
      service: 'postgres',
      safeLabels: { 'coolify.service.subType': 'database' }
    },
    runtime: { image: 'postgres:16', state: 'running', inspection: 'complete' },
    mounts: [{ type: 'volume', name: 'postgres-data', destination: '/var/lib/postgresql/data', readOnly: false }]
  }));
  assert.equal(classification.workloadRole, 'database');
  assert.equal(classification.stateClass, 'database');
  assert.equal(classification.authorityClass, 'provider-owned');
  assert.equal(classification.independenceAudit.eligibleForReadOnlyAudit, false);
  assert.equal(classification.independenceAudit.blockers.includes('not-stateless'), true);
});

test('writable mounts classify an application as stateful while read-only mounts do not', () => {
  const writable = classifyResource(resource({
    mounts: [{ type: 'bind', source: '/srv/data', destination: '/data', readOnly: false }]
  }));
  const readOnly = classifyResource(resource({
    mounts: [{ type: 'bind', source: '/srv/config', destination: '/config', readOnly: true }]
  }));
  assert.equal(writable.stateClass, 'stateful');
  assert.equal(writable.independenceAudit.eligibleForReadOnlyAudit, false);
  assert.equal(readOnly.stateClass, 'stateless');
  assert.deepEqual(readOnly.evidence.stateClass, ['read-only-mounts-only']);
});

test('core, proxy, agent, worker and private internal services are separated deterministically', () => {
  const core = classifyResource(resource({
    name: 'foxos', role: 'core', provider: 'foxos', ownership: 'foxos-managed', protected: true
  }));
  const proxy = classifyResource(resource({ name: 'coolify-proxy', role: 'proxy' }));
  const agent = classifyResource(resource({
    name: 'metrics-exporter', role: 'service', routes: [], ports: []
  }));
  const worker = classifyResource(resource({
    name: 'queue-worker', role: 'worker', routes: [], ports: []
  }));
  const internal = classifyResource(resource({
    name: 'internal-api',
    role: 'service',
    provenance: { project: 'production', service: 'api', safeLabels: {} },
    routes: [],
    ports: [{ privatePort: 3000, hostPort: null }]
  }));
  assert.equal(core.workloadRole, 'core');
  assert.equal(core.authorityClass, 'foxos-owned');
  assert.equal(proxy.workloadRole, 'proxy');
  assert.equal(agent.workloadRole, 'agent');
  assert.equal(worker.workloadRole, 'worker');
  assert.equal(internal.workloadRole, 'internal-service');
});

test('incomplete inspection fails closed instead of claiming statelessness', () => {
  const classification = classifyResource(resource({
    runtime: { image: 'example/web:latest', state: 'running', inspection: 'partial' }
  }));
  assert.equal(classification.stateClass, 'unknown');
  assert.equal(classification.status, 'needs-review');
  assert.equal(classification.independenceAudit.eligibleForReadOnlyAudit, false);
  assert.equal(classification.independenceAudit.blockers.includes('inspection-incomplete'), true);
});

test('classification revision is stable and contains no provider identifier value', () => {
  const first = classifyResource(resource());
  const second = classifyResource(resource());
  assert.equal(first.revision, second.revision);
  assert.match(first.revision, /^class_[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(first).includes('production'), false);
  assert.equal(JSON.stringify(first).includes('example.test'), false);
});
