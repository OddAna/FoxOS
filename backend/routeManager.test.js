const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  STATEFUL_CUTOVER_ROUTE_ALIAS,
  STATEFUL_CUTOVER_ROUTE_NAME,
  STATEFUL_CUTOVER_ROUTE_PATH,
  createRouteManager,
  defaultHttpsProbe
} = require('./routeManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const TARGET_ID = 'b'.repeat(64);

function createHarness(overrides = {}) {
  const { stateful = false, ...managerOverrides } = overrides;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-route-test-'));
  const calls = [];
  const probes = [];
  let attached = false;

  async function dockerRequest(method, requestPath, payload = null) {
    calls.push({ method, requestPath, payload });
    if (method === 'GET' && requestPath === '/networks/foxos-routing') {
      return { Name: 'foxos-routing', Labels: { 'com.foxos.core': 'true', 'com.foxos.routing': 'true' } };
    }
    if (method === 'GET' && requestPath === '/containers/' + TARGET_ID + '/json') {
      return {
        Config: { Labels: stateful ? {
          'com.foxos.temporary': 'stateful-rehearsal',
          'com.foxos.stateful-rehearsal.id': 'sro_' + '2'.repeat(32),
          'com.foxos.resource.id': RESOURCE_ID
        } : { 'com.foxos.managed': 'true', 'com.foxos.resource.id': RESOURCE_ID } },
        NetworkSettings: {
          Networks: attached
            ? { 'foxos-routing': { Aliases: [stateful ? STATEFUL_CUTOVER_ROUTE_ALIAS : 'foxos-route-adoption-lab'] } }
            : { bridge: { Aliases: null } }
        }
      };
    }
    if (method === 'POST' && requestPath === '/networks/foxos-routing/connect') {
      assert.deepEqual(payload, {
        Container: TARGET_ID,
        EndpointConfig: { Aliases: [stateful ? STATEFUL_CUTOVER_ROUTE_ALIAS : 'foxos-route-adoption-lab'] }
      });
      attached = true;
      return null;
    }
    if (method === 'POST' && requestPath === '/networks/foxos-routing/disconnect') {
      assert.deepEqual(payload, { Container: TARGET_ID, Force: true });
      attached = false;
      return null;
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  }

  const manager = createRouteManager({
    dataRoot: root,
    dockerRequest,
    publicBaseUrl: 'https://foxos.example.test:8443',
    networkName: 'foxos-routing',
    gatewayHost: 'foxos-gateway',
    clock: () => new Date('2026-08-04T12:00:00.000Z'),
    httpsProbe: async (input) => {
      probes.push(input);
      return {
        verified: true,
        expectedAvailable: input.expectedAvailable,
        statusCode: input.expectedAvailable ? 200 : 502,
        routeHeader: input.expectedAvailable
          ? stateful ? STATEFUL_CUTOVER_ROUTE_NAME : 'foxos-adoption-lab'
          : null,
        authorizedTls: true
      };
    },
    ...managerOverrides
  });

  return { calls, manager, probes, root, runtime: () => ({ attached }) };
}

test('FoxOS route records activate and deactivate through the owned network', async () => {
  const harness = createHarness();
  try {
    const route = harness.manager.planRoute(RESOURCE_ID, 'foxos-adoption-lab', 80);
    assert.equal(route.owner, 'foxos');
    assert.equal(route.gateway, 'foxos-caddy');
    assert.equal(route.publicUrl, 'https://foxos.example.test:8443/_foxos/apps/foxos-adoption-lab/');

    const active = await harness.manager.activate(route, TARGET_ID);
    assert.equal(active.status, 'active');
    assert.equal(active.proof.authorizedTls, true);
    assert.equal(harness.runtime().attached, true);

    const inactive = await harness.manager.deactivate(route, TARGET_ID);
    assert.equal(inactive.status, 'inactive');
    assert.equal(inactive.proof.statusCode, 502);
    assert.equal(harness.runtime().attached, false);
    assert.deepEqual(harness.probes.map((probe) => probe.expectedAvailable), [true, false]);

    const state = harness.manager.status();
    assert.equal(state.routes.length, 1);
    assert.equal(state.routes[0].status, 'inactive');
    assert.equal(fs.statSync(harness.manager.paths.routesRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(harness.manager.paths.routesRoot, route.routeId + '.json')).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(state).includes('token'), false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('route planning rejects non-HTTPS origins and non-pilot resources', () => {
  const insecure = createHarness({ publicBaseUrl: 'http://foxos.example.test' });
  try {
    assert.throws(
      () => insecure.manager.planRoute(RESOURCE_ID, 'foxos-adoption-lab', 80),
      (error) => error.code === 'route-gateway-invalid'
    );
    assert.throws(
      () => insecure.manager.planRoute(RESOURCE_ID, 'some-production-app', 80),
      (error) => error.code === 'route-pilot-resource-only'
    );
  } finally {
    fs.rmSync(insecure.root, { recursive: true, force: true });
  }
});

test('route activation rejects networks that are not FoxOS-owned', async () => {
  const harness = createHarness({
    dockerRequest: async (method, requestPath) => {
      if (method === 'GET' && requestPath === '/networks/foxos-routing') {
        return { Name: 'foxos-routing', Labels: {} };
      }
      throw new Error('Unexpected Docker request');
    }
  });
  try {
    const route = harness.manager.planRoute(RESOURCE_ID, 'foxos-adoption-lab', 80);
    await assert.rejects(
      harness.manager.activate(route, TARGET_ID),
      (error) => error.code === 'route-network-not-owned'
    );
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('legacy disposable route records remain valid for rollback compatibility', async () => {
  const harness = createHarness();
  try {
    const current = harness.manager.planRoute(RESOURCE_ID, 'foxos-adoption-lab', 80);
    const legacy = { ...current };
    delete legacy.routeKind;
    delete legacy.routeName;
    delete legacy.targetPolicy;
    const active = await harness.manager.activate(legacy, TARGET_ID);
    assert.equal(active.status, 'active');
    const inactive = await harness.manager.deactivate(legacy, TARGET_ID);
    assert.equal(inactive.status, 'inactive');
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('stateful cutover route accepts only the exact temporary rehearsal candidate and rolls back', async () => {
  const harness = createHarness({ stateful: true });
  try {
    const operationId = 'sro_' + '2'.repeat(32);
    assert.throws(
      () => harness.manager.planStatefulCutoverRoute(RESOURCE_ID, operationId, 8080),
      (error) => error.code === 'stateful-cutover-pilot-port-only'
    );
    const route = harness.manager.planStatefulCutoverRoute(RESOURCE_ID, operationId, 8090);
    assert.equal(route.routeName, STATEFUL_CUTOVER_ROUTE_NAME);
    assert.equal(route.publicPath, STATEFUL_CUTOVER_ROUTE_PATH);
    assert.equal(route.upstream.alias, STATEFUL_CUTOVER_ROUTE_ALIAS);
    assert.equal(route.targetPolicy.operationId, operationId);

    const active = await harness.manager.activate(route, TARGET_ID);
    assert.equal(active.status, 'active');
    assert.equal(harness.runtime().attached, true);

    const inactive = await harness.manager.deactivate(route, TARGET_ID);
    assert.equal(inactive.status, 'inactive');
    assert.equal(inactive.proof.expectedAvailable, false);
    assert.equal(harness.runtime().attached, false);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('HTTPS proof retains TLS authorization after Node releases the response socket', async () => {
  const route = {
    publicUrl: 'https://foxos.example.test:8443/_foxos/apps/foxos-adoption-lab/'
  };
  const proof = await defaultHttpsProbe({
    gatewayHost: 'foxos-gateway',
    route,
    expectedAvailable: true,
    timeoutMs: 100,
    httpsRequest: (_options, onResponse) => {
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'x-foxos-route': 'foxos-adoption-lab' };
        response.socket = { authorized: true };
        onResponse(response);
        process.nextTick(() => {
          response.socket = null;
          response.emit('end');
        });
      };
      request.destroy = (error) => request.emit('error', error);
      return request;
    }
  });
  assert.equal(proof.verified, true);
  assert.equal(proof.authorizedTls, true);
});
