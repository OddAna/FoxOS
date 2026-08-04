const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRouteManager } = require('./routeManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const TARGET_ID = 'b'.repeat(64);

function createHarness(overrides = {}) {
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
        Config: { Labels: { 'com.foxos.managed': 'true', 'com.foxos.resource.id': RESOURCE_ID } },
        NetworkSettings: {
          Networks: attached
            ? { 'foxos-routing': { Aliases: ['foxos-route-adoption-lab'] } }
            : { bridge: { Aliases: null } }
        }
      };
    }
    if (method === 'POST' && requestPath === '/networks/foxos-routing/connect') {
      assert.deepEqual(payload, {
        Container: TARGET_ID,
        EndpointConfig: { Aliases: ['foxos-route-adoption-lab'] }
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
        routeHeader: input.expectedAvailable ? 'foxos-adoption-lab' : null,
        authorizedTls: true
      };
    },
    ...overrides
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
