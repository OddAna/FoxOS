const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ApplicationDomainError,
  createApplicationDomainManager,
  normalizeDomain
} = require('./applicationDomainManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const OTHER_RESOURCE_ID = 'res_' + '2'.repeat(32);
const MIGRATION_OPERATION_ID = 'smop_' + 'a'.repeat(32);
const ROUTE_ID = 'smroute_' + 'b'.repeat(24);
const CANDIDATE_ID = 'c'.repeat(64);

function fixture(t, options = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-domain-manager-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const calls = [];
  const authority = {
    owner: 'foxos',
    publicAuthorityActive: true,
    domains: { 'old.example.com': 'foxos' },
    routes: {
      [ROUTE_ID]: {
        routeId: ROUTE_ID,
        operationId: MIGRATION_OPERATION_ID,
        domain: 'old.example.com',
        path: '/',
        alias: 'server-app',
        privatePort: 3000,
        status: 'active'
      }
    }
  };
  if (options.authority) options.authority(authority);

  const ingressAuthority = {
    state: () => JSON.parse(JSON.stringify(authority)),
    stageRoutes: async (routes) => {
      calls.push({ kind: 'stage', routes: JSON.parse(JSON.stringify(routes)) });
      for (const route of routes) {
        authority.routes[route.routeId] = { ...route, status: 'staged' };
        if (!authority.domains[route.domain]) authority.domains[route.domain] = 'legacy';
      }
      return routes.map((route) => authority.routes[route.routeId]);
    },
    switchDomain: async (domain, target) => {
      calls.push({ kind: 'switch', domain, target });
      authority.domains[domain] = target;
      for (const route of Object.values(authority.routes)) {
        if (route.domain === domain) route.status = target === 'foxos' ? 'active' : 'staged';
      }
      return { domain, target };
    },
    removeRoutes: async (routeIds) => {
      calls.push({ kind: 'remove', routeIds: [...routeIds] });
      for (const routeId of routeIds) {
        const route = authority.routes[routeId];
        if (route) authority.domains[route.domain] = 'legacy';
        delete authority.routes[routeId];
      }
    },
    httpsProbe: async (input) => {
      calls.push({ kind: 'probe', ...input });
      if (options.failProbe && options.failProbe(input)) throw new Error('probe failed');
      const route = authority.routes[input.expectedRouteId];
      return {
        statusCode: 200,
        tlsValid: true,
        routeId: input.expectedRouteId,
        expectedRoute: Boolean(route && route.status === 'active'),
        candidateIdentity: route && route.operationId || null
      };
    }
  };

  const management = {
    owner: 'foxos',
    state: 'active',
    lifecycle: 'stateless-blue-green',
    operationId: MIGRATION_OPERATION_ID,
    routeId: ROUTE_ID,
    domains: ['old.example.com'],
    candidateContainerId: CANDIDATE_ID,
    authorityActive: true
  };
  const resources = [
    {
      id: RESOURCE_ID,
      routes: [{ domain: 'old.example.com', path: '/', privatePort: 3000 }],
      runtime: { containerId: 'd'.repeat(64) }
    }
  ];
  if (options.resources) resources.push(...options.resources);
  const resourceRegistry = {
    getMigrationManagement: (resourceId) => resourceId === RESOURCE_ID ? { ...management } : null,
    getLatest: () => ({ resources })
  };

  let manager = null;
  const getApplicationInventory = async () => {
    const primary = manager && manager.primaryDomains()[RESOURCE_ID] || 'old.example.com';
    const applications = [{
      id: RESOURCE_ID,
      resourceId: RESOURCE_ID,
      externalUrl: 'https://' + primary,
      managedByServer: true,
      capabilities: { editDomain: true },
      runtime: { operationalState: 'running', containerId: CANDIDATE_ID }
    }];
    if (options.otherApplication) applications.push(options.otherApplication);
    return { applications };
  };

  manager = createApplicationDomainManager({
    dataRoot,
    ingressAuthority,
    resourceRegistry,
    getApplicationInventory,
    panelBaseUrl: 'https://panel.example.com:8443',
    dnsLookup: async (domain) => {
      calls.push({ kind: 'dns', domain });
      return options.dns || [{ address: '93.184.216.34', family: 4 }];
    },
    delay: async () => {},
    probeAttempts: 2,
    probeIntervalMs: 1
  });
  return { authority, calls, dataRoot, manager };
}

function observedFixture(t, options = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-observed-access-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const containerId = 'd'.repeat(64);
  const calls = [];
  let attached = false;
  const authority = { owner: 'foxos', publicAuthorityActive: true, domains: {}, routes: {} };
  const resource = {
    id: RESOURCE_ID,
    kind: 'container',
    provider: 'coolify',
    ownership: 'observed',
    runtime: { containerId, state: 'running' },
    ports: options.ports || [{ privatePort: 8080, protocol: 'tcp', hostPort: null }],
    routes: [{ domain: 'old.example.com', scheme: 'https', path: '/' }]
  };
  const ingressAuthority = {
    state: () => JSON.parse(JSON.stringify(authority)),
    stageRoutes: async (routes) => {
      calls.push({ kind: 'stage', routes });
      for (const route of routes) {
        authority.routes[route.routeId] = { ...route, status: 'staged' };
        authority.domains[route.domain] = 'legacy';
      }
    },
    switchDomain: async (domain, target) => {
      calls.push({ kind: 'switch', domain, target });
      authority.domains[domain] = target;
      for (const route of Object.values(authority.routes)) {
        if (route.domain === domain) route.status = target === 'foxos' ? 'active' : 'staged';
      }
    },
    removeRoutes: async (routeIds) => {
      calls.push({ kind: 'remove', routeIds });
      for (const routeId of routeIds) {
        const route = authority.routes[routeId];
        if (route) authority.domains[route.domain] = 'legacy';
        delete authority.routes[routeId];
      }
    },
    httpsProbe: async (input) => {
      calls.push({ kind: 'probe', ...input });
      if (options.failProbe && options.failProbe(input)) throw new Error('probe failed');
      const route = authority.routes[input.expectedRouteId];
      return {
        statusCode: 200,
        tlsValid: true,
        expectedRoute: Boolean(route && route.status === 'active'),
        candidateIdentity: route && route.operationId || null
      };
    }
  };
  const resourceRegistry = {
    getMigrationManagement: () => null,
    getLatest: () => ({ resources: [resource] })
  };
  const dockerRequest = async (method, requestPath, payload) => {
    calls.push({ kind: 'docker', method, requestPath, payload });
    if (method === 'GET' && requestPath === '/networks/foxos-routing') {
      return {
        Internal: true,
        Labels: { 'com.foxos.routing': 'true', 'com.foxos.core': 'true' }
      };
    }
    if (method === 'GET' && requestPath === '/containers/' + containerId + '/json') {
      return {
        Id: containerId,
        State: { Running: true },
        NetworkSettings: {
          Networks: attached ? { 'foxos-routing': { Aliases: ['app-' + hashForTest(RESOURCE_ID)] } } : {}
        }
      };
    }
    if (method === 'POST' && requestPath === '/networks/foxos-routing/connect') {
      attached = true;
      return {};
    }
    if (method === 'POST' && requestPath === '/networks/foxos-routing/disconnect') {
      attached = false;
      return {};
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  };
  let manager = null;
  const getApplicationInventory = async () => ({
    applications: [{
      id: RESOURCE_ID,
      resourceId: RESOURCE_ID,
      externalUrl: manager && manager.primaryDomains()[RESOURCE_ID]
        ? 'https://' + manager.primaryDomains()[RESOURCE_ID]
        : 'https://old.example.com',
      managedByServer: false,
      capabilities: { editAccessLink: true, editDomain: true },
      runtime: { operationalState: 'running', containerId }
    }]
  });
  manager = createApplicationDomainManager({
    dataRoot,
    ingressAuthority,
    resourceRegistry,
    getApplicationInventory,
    dockerRequest,
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    delay: async () => {},
    probeAttempts: 1
  });
  return { authority, calls, manager, isAttached: () => attached };
}

function hashForTest(value) {
  return require('node:crypto').createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

test('domain input accepts a hostname or HTTPS root URL and rejects unsafe URL components', () => {
  assert.equal(normalizeDomain('App.Example.COM'), 'app.example.com');
  assert.equal(normalizeDomain('https://app.example.com/'), 'app.example.com');
  assert.throws(() => normalizeDomain('http://app.example.com'), { code: 'invalid-domain-url' });
  assert.throws(() => normalizeDomain('https://app.example.com/admin'), { code: 'invalid-domain-url' });
  assert.throws(() => normalizeDomain('localhost'), { code: 'reserved-domain' });
  assert.throws(() => normalizeDomain('app.test'), { code: 'reserved-domain' });
});

test('planning proves public DNS without mutating live ingress', async (t) => {
  const { authority, calls, manager } = fixture(t);
  const before = JSON.parse(JSON.stringify(authority));

  const plan = await manager.createPlan(RESOURCE_ID, { domain: 'new.example.com' });

  assert.match(plan.planId, /^adplan_[a-f0-9]{32}$/);
  assert.equal(plan.currentDomain, 'old.example.com');
  assert.equal(plan.domain, 'new.example.com');
  assert.equal(plan.oldAddressPreserved, true);
  assert.deepEqual(plan.dns, [{ address: '93.184.216.34', family: 4 }]);
  assert.deepEqual(authority, before);
  assert.deepEqual(calls.map((call) => call.kind), ['dns']);
});

test('apply adds and verifies a new route while preserving the previous address', async (t) => {
  const { authority, calls, manager } = fixture(t);
  const plan = await manager.createPlan(RESOURCE_ID, { domain: 'new.example.com' });

  const operation = await manager.applyPlan(plan.planId, plan.confirmation);

  assert.equal(operation.status, 'completed');
  assert.equal(operation.previousDomain, 'old.example.com');
  assert.equal(operation.primaryDomain, 'new.example.com');
  assert.equal(operation.rollbackAvailable, true);
  assert.equal(authority.domains['old.example.com'], 'foxos');
  assert.equal(authority.domains['new.example.com'], 'foxos');
  assert.equal(manager.primaryDomains()[RESOURCE_ID], 'new.example.com');
  assert.deepEqual(
    calls.filter((call) => call.kind === 'switch').map(({ domain, target }) => ({ domain, target })),
    [{ domain: 'new.example.com', target: 'foxos' }]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === 'probe' && call.hostname === 'new.example.com')
      .map((call) => call.connectHost),
    ['foxos-gateway', '93.184.216.34']
  );
});

test('failed TLS or route proof removes only the new route and retains the previous address', async (t) => {
  const { authority, calls, manager } = fixture(t, {
    failProbe: (input) => input.hostname === 'new.example.com'
  });
  const plan = await manager.createPlan(RESOURCE_ID, { domain: 'new.example.com' });

  await assert.rejects(
    manager.applyPlan(plan.planId, plan.confirmation),
    (error) => error instanceof ApplicationDomainError && error.code === 'domain-apply-rolled-back'
  );

  assert.equal(authority.domains['old.example.com'], 'foxos');
  assert.equal(authority.domains['new.example.com'], 'legacy');
  assert.equal(Object.values(authority.routes).some((route) => route.domain === 'new.example.com'), false);
  assert.equal(manager.primaryDomains()[RESOURCE_ID], undefined);
  assert.equal(calls.some((call) => call.kind === 'remove'), true);
  const operation = Object.values(manager.state().operations)[0];
  assert.equal(operation.status, 'failed-rolled-back');
  assert.equal(operation.rollback.completed, true);
  assert.equal(operation.rollback.previousDomainPreserved, true);
});

test('rollback proves the old route before removing the exact newly added route', async (t) => {
  const { authority, calls, manager } = fixture(t);
  const plan = await manager.createPlan(RESOURCE_ID, { domain: 'new.example.com' });
  const applied = await manager.applyPlan(plan.planId, plan.confirmation);

  const status = await manager.getStatus(RESOURCE_ID);
  const rolledBack = await manager.rollbackOperation(applied.operationId, status.rollbackConfirmation);

  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(manager.primaryDomains()[RESOURCE_ID], 'old.example.com');
  assert.equal(authority.domains['old.example.com'], 'foxos');
  assert.equal(authority.domains['new.example.com'], 'legacy');
  assert.equal(Object.values(authority.routes).some((route) => route.domain === 'new.example.com'), false);
  const rollbackProofIndex = calls.findIndex((call) => call.kind === 'probe' && call.hostname === 'old.example.com');
  const removalIndex = calls.findIndex((call) => call.kind === 'remove');
  assert.ok(rollbackProofIndex >= 0 && rollbackProofIndex < removalIndex);
});

test('conflicts, panel hostname and private DNS fail before any ingress mutation', async (t) => {
  const conflict = fixture(t, {
    authority: (authority) => {
      authority.domains['used.example.com'] = 'foxos';
      authority.routes['smroute_' + 'e'.repeat(24)] = {
        routeId: 'smroute_' + 'e'.repeat(24),
        operationId: 'smop_' + 'f'.repeat(32),
        domain: 'used.example.com',
        path: '/',
        alias: 'other-app',
        privatePort: 8080,
        status: 'active'
      };
    }
  });
  await assert.rejects(conflict.manager.createPlan(RESOURCE_ID, { domain: 'used.example.com' }), { code: 'domain-conflict' });
  await assert.rejects(conflict.manager.createPlan(RESOURCE_ID, { domain: 'panel.example.com' }), { code: 'panel-domain-conflict' });
  assert.equal(conflict.calls.some((call) => ['stage', 'switch', 'remove'].includes(call.kind)), false);

  const privateDns = fixture(t, { dns: [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(privateDns.manager.createPlan(RESOURCE_ID, { domain: 'private.example.com' }), { code: 'domain-dns-not-public' });
  assert.equal(privateDns.calls.some((call) => ['stage', 'switch', 'remove'].includes(call.kind)), false);
});

test('a domain observed on another server resource is rejected even when not active in ingress', async (t) => {
  const { manager } = fixture(t, {
    resources: [{
      id: OTHER_RESOURCE_ID,
      routes: [{ domain: 'reserved.example.com', path: '/', privatePort: 8080 }],
      runtime: { containerId: 'e'.repeat(64) }
    }]
  });
  await assert.rejects(
    manager.createPlan(RESOURCE_ID, { domain: 'reserved.example.com' }),
    { code: 'resource-domain-conflict' }
  );
});

test('a discovered running web app receives a real reversible access link without full migration', async (t) => {
  const { authority, calls, manager, isAttached } = observedFixture(t);
  const plan = await manager.createPlan(RESOURCE_ID, { domain: 'new.example.com' });

  assert.equal(plan.currentDomain, 'old.example.com');
  assert.equal(isAttached(), false);
  assert.equal(calls.some((call) => call.kind === 'stage'), false);

  const applied = await manager.applyPlan(plan.planId, plan.confirmation);
  assert.equal(applied.status, 'completed');
  assert.equal(manager.primaryDomains()[RESOURCE_ID], 'new.example.com');
  assert.equal(authority.domains['new.example.com'], 'foxos');
  assert.equal(isAttached(), true);
  assert.equal(calls.filter((call) => call.requestPath === '/networks/foxos-routing/connect').length, 1);
  assert.equal(calls.filter((call) => call.kind === 'probe').length, 2);

  const status = await manager.getStatus(RESOURCE_ID);
  const rolledBack = await manager.rollbackOperation(applied.operationId, status.rollbackConfirmation);
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(manager.primaryDomains()[RESOURCE_ID], undefined);
  assert.equal(isAttached(), false);
  assert.equal(Object.values(authority.routes).some((route) => route.domain === 'new.example.com'), false);
});

test('failed access-link proof removes the new route and exact observed network attachment', async (t) => {
  const { authority, manager, isAttached } = observedFixture(t, {
    failProbe: (input) => input.hostname === 'new.example.com'
  });
  const plan = await manager.createPlan(RESOURCE_ID, { domain: 'new.example.com' });

  await assert.rejects(manager.applyPlan(plan.planId, plan.confirmation), { code: 'domain-apply-rolled-back' });
  assert.equal(isAttached(), false);
  assert.equal(Object.values(authority.routes).some((route) => route.domain === 'new.example.com'), false);
  assert.equal(manager.primaryDomains()[RESOURCE_ID], undefined);
});

test('an ambiguous discovered service explains why its access link cannot be changed', async (t) => {
  const { manager } = observedFixture(t, {
    ports: [
      { privatePort: 80, protocol: 'tcp' },
      { privatePort: 3000, protocol: 'tcp' }
    ]
  });
  const status = await manager.getStatus(RESOURCE_ID);
  assert.equal(status.editable, false);
  assert.match(status.reason, /web portu kesin olarak belirlenemedi/i);
});
