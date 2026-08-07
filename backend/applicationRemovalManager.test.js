const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createApplicationRemovalManager
} = require('./applicationRemovalManager');

const APPLICATION_ID = 'res_' + '1'.repeat(32);
const LINKED_RESOURCE_ID = 'res_' + '2'.repeat(32);
const CANDIDATE_RESOURCE_ID = 'res_' + '3'.repeat(32);
const PRIMARY_ID = 'a'.repeat(64);
const SOURCE_ID = 'b'.repeat(64);
const LINKED_ID = 'c'.repeat(64);

function details({ id, name, service, resourceId, running = true, core = false }) {
  return {
    Id: id,
    Name: '/' + name,
    Created: '2026-08-08T00:00:00.000Z',
    Image: 'sha256:' + id[0].repeat(64),
    Config: {
      Image: service === 'db' ? 'postgres:16' : 'example/app:1',
      Labels: {
        ...(core ? { 'com.foxos.core': 'true' } : {}),
        'com.docker.compose.project': 'example',
        'com.docker.compose.service': service,
        'com.docker.compose.project.working_dir': '/srv/example',
        'com.foxos.resource.id': resourceId
      }
    },
    State: { Status: running ? 'running' : 'exited', Running: running },
    Mounts: [{
      Type: 'volume',
      Name: 'example-data',
      Source: '/var/lib/docker/volumes/example-data/_data',
      Destination: '/data',
      RW: true
    }],
    NetworkSettings: { Networks: { example_default: {} } }
  };
}

function harness({ core = false, hostService = false, inactiveDefinition = false } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-app-removal-'));
  const containers = new Map();
  if (!inactiveDefinition && !hostService) {
    containers.set(PRIMARY_ID, details({
      id: PRIMARY_ID,
      name: 'example-web',
      service: 'web',
      resourceId: APPLICATION_ID,
      core
    }));
    containers.set(SOURCE_ID, details({
      id: SOURCE_ID,
      name: 'example-source',
      service: 'web-source',
      resourceId: APPLICATION_ID,
      running: false
    }));
    containers.set(LINKED_ID, details({
      id: LINKED_ID,
      name: 'example-db',
      service: 'db',
      resourceId: LINKED_RESOURCE_ID
    }));
  }
  const volumes = new Set(['example-data']);
  const networks = new Map([['example_default', {
    Id: 'network-example',
    Name: 'example_default',
    Labels: { 'com.docker.compose.project': 'example' },
    Containers: {}
  }]]);
  const calls = [];
  const forgotten = [];
  const domainForgotten = [];
  const routeRemoved = [];
  const retired = new Set();
  const authorityState = { routes: {}, inactiveDomains: {} };

  const summaries = () => [...containers.values()].map((entry) => ({
    Id: entry.Id,
    Names: [entry.Name],
    Image: entry.Config.Image,
    State: entry.State.Status,
    Status: entry.State.Status,
    Labels: entry.Config.Labels,
    Mounts: entry.Mounts
  }));
  const snapshot = () => ({
    snapshotId: 'snap-test',
    resources: inactiveDefinition && !retired.has(APPLICATION_ID)
      ? [{
          id: APPLICATION_ID,
          kind: 'provider-definition',
          provider: 'coolify',
          name: 'Inactive Example',
          runtime: { state: 'stopped', containerId: null }
        }]
      : [...containers.values()].map((entry) => ({
          id: entry.Id === LINKED_ID
            ? LINKED_RESOURCE_ID
            : entry.Id === PRIMARY_ID ? CANDIDATE_RESOURCE_ID : APPLICATION_ID,
          kind: 'container',
          runtime: { containerId: entry.Id },
          ...(entry.Id === SOURCE_ID ? {
            management: {
              owner: 'foxos',
              candidateContainerId: PRIMARY_ID,
              operationId: 'smop_' + '9'.repeat(32)
            }
          } : {})
        }))
  });
  const inventory = () => {
    if (inactiveDefinition && !retired.has(APPLICATION_ID)) {
      return [{
        id: APPLICATION_ID,
        resourceId: APPLICATION_ID,
        name: 'Inactive Example',
        installation: { state: 'inactive-definition' },
        runtime: { present: false, containerId: null }
      }];
    }
    if (hostService) {
      return [{
        id: APPLICATION_ID,
        resourceId: APPLICATION_ID,
        name: 'WireGuard',
        installation: { state: 'host-service' },
        runtime: { engine: 'systemd', containerId: null }
      }];
    }
    if (!containers.has(PRIMARY_ID)) return [];
    return [{
      id: APPLICATION_ID,
      resourceId: APPLICATION_ID,
      name: 'Example',
      installation: { state: 'runtime-present' },
      runtime: { present: true, containerId: PRIMARY_ID },
      management: { operationId: 'smop_' + '9'.repeat(32) }
    }];
  };
  const dockerRequest = async (method, requestPath) => {
    calls.push([method, requestPath]);
    if (method === 'GET' && requestPath === '/containers/json?all=1') return summaries();
    if (method === 'GET' && requestPath.startsWith('/containers/') && requestPath.endsWith('/json')) {
      const id = decodeURIComponent(requestPath.slice('/containers/'.length, -'/json'.length));
      if (!containers.has(id)) throw new Error('No such container');
      return containers.get(id);
    }
    if (method === 'POST' && /\/containers\/[a-f0-9]{64}\/stop\?t=10$/.test(requestPath)) {
      const id = requestPath.split('/')[2];
      containers.get(id).State = { Status: 'exited', Running: false };
      return null;
    }
    if (method === 'POST' && /\/containers\/[a-f0-9]{64}\/start$/.test(requestPath)) {
      const id = requestPath.split('/')[2];
      containers.get(id).State = { Status: 'running', Running: true };
      return null;
    }
    if (method === 'DELETE' && requestPath.startsWith('/containers/')) {
      containers.delete(requestPath.split('/')[2].split('?')[0]);
      return null;
    }
    if (method === 'GET' && requestPath.startsWith('/networks/')) {
      const name = decodeURIComponent(requestPath.slice('/networks/'.length));
      const network = networks.get(name);
      if (!network) throw new Error('No such network');
      network.Containers = Object.fromEntries([...containers.keys()].map((id) => [id, {}]));
      return network;
    }
    if (method === 'DELETE' && requestPath.startsWith('/networks/')) {
      networks.delete(decodeURIComponent(requestPath.slice('/networks/'.length)));
      return null;
    }
    if (method === 'DELETE' && requestPath.startsWith('/volumes/')) {
      volumes.delete(decodeURIComponent(requestPath.slice('/volumes/'.length)));
      return null;
    }
    throw new Error(`Unexpected Docker request: ${method} ${requestPath}`);
  };
  const resourceRegistry = {
    getLatest: snapshot,
    scan: async () => snapshot(),
    retireProviderDefinition: (resourceId, confirmation) => {
      assert.equal(confirmation, `REMOVE INACTIVE DEFINITION ${resourceId}`);
      retired.add(resourceId);
      return { resourceId };
    }
  };
  const manager = createApplicationRemovalManager({
    dataRoot,
    dockerRequest,
    getApplicationInventory: async () => ({ applications: inventory() }),
    resourceRegistry,
    ingressAuthority: {
      state: () => authorityState,
      removeResourceAuthority: async (resourceId) => {
        routeRemoved.push(resourceId);
        return { routesRemoved: 1, inactiveDomainsRemoved: 0 };
      }
    },
    desktopShortcutManager: { forget: (id) => forgotten.push(id) },
    applicationDomainManager: {
      state: () => ({ preferences: {} }),
      forgetApplication: (id) => domainForgotten.push(id)
    },
    randomUUID: (() => {
      let count = 0;
      return () => `${String(++count).padStart(8, '0')}-0000-0000-0000-000000000000`;
    })()
  });
  return {
    authorityState,
    calls,
    containers,
    dataRoot,
    domainForgotten,
    forgotten,
    manager,
    networks,
    retired,
    routeRemoved,
    volumes
  };
}

test('removal keeps linked services and persistent data unless explicitly selected', async (t) => {
  const state = harness();
  t.after(() => fs.rmSync(state.dataRoot, { recursive: true, force: true }));
  const plan = await state.manager.createPlan(APPLICATION_ID);
  assert.equal(plan.linkedServices.length, 1);
  assert.equal(plan.sameApplicationCopies.length, 1);
  assert.equal(plan.persistentData.preservedByDefault, true);

  const operation = await state.manager.applyPlan(plan.planId);
  assert.equal(operation.status, 'completed');
  assert.equal(state.containers.has(PRIMARY_ID), false);
  assert.equal(state.containers.has(SOURCE_ID), false);
  assert.equal(state.containers.has(LINKED_ID), true);
  assert.equal(state.volumes.has('example-data'), true);
  assert.equal(state.networks.has('example_default'), true);
  assert.ok(state.forgotten.includes(APPLICATION_ID));
  assert.ok(state.routeRemoved.includes(APPLICATION_ID));
  assert.ok(state.domainForgotten.includes(APPLICATION_ID));
});

test('explicit linked-service and data selection removes the exact group, volume and empty project network', async (t) => {
  const state = harness();
  t.after(() => fs.rmSync(state.dataRoot, { recursive: true, force: true }));
  const plan = await state.manager.createPlan(APPLICATION_ID);
  const operation = await state.manager.applyPlan(plan.planId, {
    includeLinkedServices: true,
    removeData: true
  });
  assert.equal(operation.removedContainers.length, 3);
  assert.equal(state.containers.size, 0);
  assert.equal(state.volumes.has('example-data'), false);
  assert.equal(state.networks.has('example_default'), false);
  assert.ok(state.forgotten.includes(LINKED_RESOURCE_ID));
});

test('stale removal plan fails before any container mutation', async (t) => {
  const state = harness();
  t.after(() => fs.rmSync(state.dataRoot, { recursive: true, force: true }));
  const plan = await state.manager.createPlan(APPLICATION_ID);
  state.containers.get(PRIMARY_ID).Config.Image = 'example/app:changed';
  await assert.rejects(
    () => state.manager.applyPlan(plan.planId),
    { code: 'application-removal-plan-stale' }
  );
  assert.equal(state.containers.size, 3);
  assert.equal(state.calls.some(([method]) => method === 'DELETE'), false);
});

test('a route added after planning makes the destructive plan stale', async (t) => {
  const state = harness();
  t.after(() => fs.rmSync(state.dataRoot, { recursive: true, force: true }));
  const plan = await state.manager.createPlan(APPLICATION_ID);
  const routeId = 'smroute_' + '7'.repeat(24);
  state.authorityState.routes[routeId] = {
    routeId,
    resourceId: APPLICATION_ID,
    operationId: 'smop_' + '8'.repeat(32),
    domain: 'new.example.test',
    path: '/',
    status: 'active'
  };
  await assert.rejects(
    () => state.manager.applyPlan(plan.planId),
    { code: 'application-removal-plan-stale' }
  );
  assert.equal(state.containers.size, 3);
  assert.equal(state.routeRemoved.length, 0);
});

test('host services and FoxOS core containers remain protected', async (t) => {
  const host = harness({ hostService: true });
  const core = harness({ core: true });
  t.after(() => {
    fs.rmSync(host.dataRoot, { recursive: true, force: true });
    fs.rmSync(core.dataRoot, { recursive: true, force: true });
  });
  await assert.rejects(
    () => host.manager.createPlan(APPLICATION_ID),
    { code: 'host-service-removal-unsupported' }
  );
  await assert.rejects(
    () => core.manager.createPlan(APPLICATION_ID),
    { code: 'application-removal-core-protected' }
  );
});

test('inactive provider definition removal retires the record and shortcut without Docker mutation', async (t) => {
  const state = harness({ inactiveDefinition: true });
  t.after(() => fs.rmSync(state.dataRoot, { recursive: true, force: true }));
  const plan = await state.manager.createPlan(APPLICATION_ID);
  assert.equal(plan.kind, 'inactive-definition');
  const operation = await state.manager.applyPlan(plan.planId);
  assert.equal(operation.status, 'completed');
  assert.equal(state.retired.has(APPLICATION_ID), true);
  assert.equal(state.calls.length, 0);
  assert.ok(state.forgotten.includes(APPLICATION_ID));
});
