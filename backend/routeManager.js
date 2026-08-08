const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const ROUTE_SCHEMA_VERSION = 1;
const ROUTE_NAME = 'foxos-adoption-lab';
const ROUTE_PATH = '/_foxos/apps/foxos-adoption-lab/';
const ROUTE_ALIAS = 'foxos-route-adoption-lab';
const STATEFUL_CUTOVER_ROUTE_KIND = 'stateful-cutover-rehearsal';
const STATEFUL_CUTOVER_ROUTE_NAME = 'foxos-stateful-cutover';
const STATEFUL_CUTOVER_ROUTE_PATH = '/_foxos/migrations/stateful-cutover/_/';
const STATEFUL_CUTOVER_ROUTE_ALIAS = 'foxos-route-stateful-cutover';
const STATEFUL_CUTOVER_PRIVATE_PORT = 8090;
const ROUTE_HEADER = 'x-foxos-route';
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const REHEARSAL_OPERATION_ID_PATTERN = /^sro_[a-f0-9]{24,64}$/;

class RouteError extends Error {
  constructor(message, statusCode = 400, code = 'route-error') {
    super(message);
    this.name = 'RouteError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function safeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new RouteError('FoxOS route base URL is not configured', 503, 'route-gateway-unavailable');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)
  ) {
    throw new RouteError('FoxOS route base URL must be an HTTPS origin', 503, 'route-gateway-invalid');
  }
  return parsed.origin;
}

function defaultHttpsProbe({
  gatewayHost,
  route,
  expectedAvailable,
  timeoutMs = 30000,
  httpsRequest = https.request
}) {
  const publicUrl = new URL(route.publicUrl);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let lastResult = null;

    const attempt = () => {
      const request = httpsRequest({
        hostname: gatewayHost,
        port: 443,
        path: publicUrl.pathname,
        method: 'GET',
        servername: publicUrl.hostname,
        headers: { Host: publicUrl.host },
        timeout: 5000,
        rejectUnauthorized: true
      }, (response) => {
        // IncomingMessage clears its socket reference after the response ends.
        // Capture the completed TLS handshake result while the socket is live.
        const authorizedTls = Boolean(response.socket && response.socket.authorized);
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > 256 * 1024) response.destroy();
        });
        response.on('end', () => {
          try {
            const statusCode = response.statusCode || 0;
            const routeHeader = String(response.headers[ROUTE_HEADER] || '');
            const available = authorizedTls &&
              statusCode >= 200 && statusCode < 300 &&
              routeHeader === (route.routeName || ROUTE_NAME);
            lastResult = { statusCode, routeHeader: routeHeader || null };
            if (available === expectedAvailable) {
              return resolve({
                verified: true,
                expectedAvailable,
                statusCode,
                routeHeader: routeHeader || null,
                authorizedTls
              });
            }
          } catch (error) {
            lastResult = { error: error.code || 'invalid-https-probe-response' };
          }
          retry();
        });
      });

      request.on('timeout', () => request.destroy(new Error('HTTPS route verification timed out')));
      request.on('error', (error) => {
        lastResult = { error: error.code || 'https-probe-failed' };
        retry();
      });
      request.end();
    };

    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        return reject(new RouteError(
          'HTTPS route verification failed: ' + JSON.stringify(lastResult),
          503,
          expectedAvailable ? 'route-health-verification-failed' : 'route-removal-verification-failed'
        ));
      }
      setTimeout(attempt, 500);
    };

    attempt();
  });
}

function createRouteManager({
  dataRoot,
  dockerRequest,
  publicBaseUrl,
  networkName = 'foxos-routing',
  gatewayHost = 'foxos-gateway',
  clock = () => new Date(),
  httpsProbe = defaultHttpsProbe
}) {
  if (!dataRoot || typeof dockerRequest !== 'function' || typeof httpsProbe !== 'function') {
    throw new Error('Route manager requires data root, Docker client and HTTPS probe');
  }

  const routesRoot = path.join(dataRoot, 'routes');
  const revisionsRoot = path.join(routesRoot, 'revisions');

  function routeId(resourceId) {
    return 'route_' + hash(resourceId);
  }

  function routePath(routeIdentifier) {
    if (!/^route_[a-f0-9]{24}$/.test(String(routeIdentifier))) {
      throw new RouteError('Invalid FoxOS route ID', 400, 'invalid-route-id');
    }
    return path.join(routesRoot, routeIdentifier + '.json');
  }

  function planRoute(resourceId, name, privatePort) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId)) || name !== ROUTE_NAME) {
      throw new RouteError('The first route pilot accepts only the disposable adoption lab', 403, 'route-pilot-resource-only');
    }
    if (!Number.isSafeInteger(privatePort) || privatePort < 1 || privatePort > 65535) {
      throw new RouteError('Route upstream port is invalid', 400, 'invalid-route-port');
    }
    const baseUrl = safeBaseUrl(publicBaseUrl);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(networkName) || !gatewayHost) {
      throw new RouteError('FoxOS route network is not configured safely', 503, 'route-gateway-invalid');
    }
    return {
      schemaVersion: ROUTE_SCHEMA_VERSION,
      routeId: routeId(resourceId),
      routeKind: 'disposable-adoption-lab',
      routeName: ROUTE_NAME,
      resourceId,
      owner: 'foxos',
      gateway: 'foxos-caddy',
      publicBaseUrl: baseUrl,
      publicPath: ROUTE_PATH,
      publicUrl: baseUrl + ROUTE_PATH,
      tls: { mode: 'foxos-gateway', verificationRequired: true },
      upstream: {
        protocol: 'http',
        network: networkName,
        alias: ROUTE_ALIAS,
        privatePort
      },
      targetPolicy: { type: 'foxos-managed-resource' }
    };
  }

  function planStatefulCutoverRoute(resourceId, operationId, privatePort) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId)) || !REHEARSAL_OPERATION_ID_PATTERN.test(String(operationId))) {
      throw new RouteError('Stateful cutover route identity is invalid', 400, 'invalid-stateful-cutover-route');
    }
    if (privatePort !== STATEFUL_CUTOVER_PRIVATE_PORT) {
      throw new RouteError(
        'The first stateful cutover rehearsal accepts only the reviewed port 8090 workload',
        403,
        'stateful-cutover-pilot-port-only'
      );
    }
    const baseUrl = safeBaseUrl(publicBaseUrl);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(networkName) || !gatewayHost) {
      throw new RouteError('FoxOS route network is not configured safely', 503, 'route-gateway-invalid');
    }
    return {
      schemaVersion: ROUTE_SCHEMA_VERSION,
      routeId: 'route_' + hash(`stateful-cutover:${resourceId}:${operationId}`),
      routeKind: STATEFUL_CUTOVER_ROUTE_KIND,
      routeName: STATEFUL_CUTOVER_ROUTE_NAME,
      resourceId,
      operationId,
      owner: 'foxos',
      gateway: 'foxos-caddy',
      publicBaseUrl: baseUrl,
      publicPath: STATEFUL_CUTOVER_ROUTE_PATH,
      publicUrl: baseUrl + STATEFUL_CUTOVER_ROUTE_PATH,
      tls: { mode: 'foxos-gateway', verificationRequired: true },
      upstream: {
        protocol: 'http',
        network: networkName,
        alias: STATEFUL_CUTOVER_ROUTE_ALIAS,
        privatePort
      },
      targetPolicy: {
        type: 'stateful-rehearsal-candidate',
        operationId
      }
    };
  }

  function validateRoute(route) {
    const routeKind = route && route.routeKind || 'disposable-adoption-lab';
    const normalizedRoute = routeKind === 'disposable-adoption-lab' ? {
      ...route,
      routeKind,
      routeName: route && route.routeName || ROUTE_NAME,
      targetPolicy: route && route.targetPolicy || { type: 'foxos-managed-resource' }
    } : route;
    const expected = routeKind === STATEFUL_CUTOVER_ROUTE_KIND
      ? planStatefulCutoverRoute(
        normalizedRoute && normalizedRoute.resourceId,
        normalizedRoute && normalizedRoute.operationId,
        normalizedRoute && normalizedRoute.upstream && normalizedRoute.upstream.privatePort
      )
      : planRoute(
        normalizedRoute && normalizedRoute.resourceId,
        ROUTE_NAME,
        normalizedRoute && normalizedRoute.upstream && normalizedRoute.upstream.privatePort
      );
    for (const key of [
      'routeId', 'routeKind', 'routeName', 'resourceId', 'owner', 'gateway',
      'publicBaseUrl', 'publicPath', 'publicUrl'
    ]) {
      if (normalizedRoute[key] !== expected[key]) {
        throw new RouteError('Route record does not match FoxOS policy', 409, 'route-policy-mismatch');
      }
    }
    if (
      normalizedRoute.operationId !== expected.operationId ||
      JSON.stringify(normalizedRoute.targetPolicy) !== JSON.stringify(expected.targetPolicy)
    ) {
      throw new RouteError('Route target policy does not match FoxOS policy', 409, 'route-policy-mismatch');
    }
    if (JSON.stringify(normalizedRoute.upstream) !== JSON.stringify(expected.upstream)) {
      throw new RouteError('Route upstream does not match FoxOS policy', 409, 'route-policy-mismatch');
    }
    return expected;
  }

  function listRoutes() {
    try {
      return fs.readdirSync(routesRoot)
        .filter((file) => /^route_[a-f0-9]{24}\.json$/.test(file))
        .sort()
        .map((file) => readJson(path.join(routesRoot, file)))
        .filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function assertNoConflict(route) {
    const conflict = listRoutes().find((candidate) => (
      candidate.status === 'active' && candidate.routeId !== route.routeId &&
      (candidate.publicUrl === route.publicUrl || candidate.upstream.alias === route.upstream.alias)
    ));
    if (conflict) throw new RouteError('FoxOS route path or upstream alias is already active', 409, 'route-conflict');
  }

  async function inspectOwnedNetwork(route) {
    const network = await dockerRequest('GET', '/networks/' + encodeURIComponent(route.upstream.network));
    const labels = network.Labels || {};
    if (labels['com.foxos.routing'] !== 'true' || labels['com.foxos.core'] !== 'true') {
      throw new RouteError('Routing network is not owned by FoxOS', 409, 'route-network-not-owned');
    }
    return network;
  }

  async function inspectTarget(route, targetId) {
    const target = await dockerRequest('GET', '/containers/' + targetId + '/json');
    const labels = target.Config && target.Config.Labels || {};
    const expected = route.targetPolicy && route.targetPolicy.type === 'stateful-rehearsal-candidate'
      ? labels['com.foxos.temporary'] === 'stateful-rehearsal' &&
        labels['com.foxos.stateful-rehearsal.id'] === route.operationId &&
        labels['com.foxos.resource.id'] === route.resourceId
      : labels['com.foxos.managed'] === 'true' && labels['com.foxos.resource.id'] === route.resourceId;
    if (!expected) {
      throw new RouteError('Route target is not the expected FoxOS-managed resource', 409, 'route-target-mismatch');
    }
    return target;
  }

  function attachedToRouteNetwork(target, route) {
    const attachment = target.NetworkSettings && target.NetworkSettings.Networks &&
      target.NetworkSettings.Networks[route.upstream.network];
    return Boolean(attachment && (attachment.Aliases || []).includes(route.upstream.alias));
  }

  function persist(route, state) {
    const record = {
      ...route,
      status: state.status,
      targetContainerId: state.targetContainerId || null,
      proof: state.proof || null,
      updatedAt: new Date(clock()).toISOString()
    };
    const previous = readJson(routePath(route.routeId), null);
    record.createdAt = previous && previous.createdAt || record.updatedAt;
    ensureDirectory(revisionsRoot);
    atomicWriteJson(routePath(route.routeId), record);
    atomicWriteJson(
      path.join(revisionsRoot, record.updatedAt.replace(/[:.]/g, '-') + '-' + route.routeId + '.json'),
      record
    );
    return record;
  }

  async function activate(routeInput, targetId) {
    const route = validateRoute(routeInput);
    assertNoConflict(route);
    await inspectOwnedNetwork(route);
    let target = await inspectTarget(route, targetId);
    let connected = attachedToRouteNetwork(target, route);
    try {
      if (!connected) {
        await dockerRequest('POST', '/networks/' + encodeURIComponent(route.upstream.network) + '/connect', {
          Container: targetId,
          EndpointConfig: { Aliases: [route.upstream.alias] }
        });
        connected = true;
      }
      target = await inspectTarget(route, targetId);
      if (!attachedToRouteNetwork(target, route)) {
        throw new RouteError('Docker did not attach the route target with the required alias', 503, 'route-network-attachment-failed');
      }
      const proof = await httpsProbe({ gatewayHost, route, expectedAvailable: true });
      return persist(route, { status: 'active', targetContainerId: targetId, proof });
    } catch (error) {
      if (connected) {
        try {
          await dockerRequest('POST', '/networks/' + encodeURIComponent(route.upstream.network) + '/disconnect', {
            Container: targetId,
            Force: true
          });
        } catch {
          // Preserve the route verification error.
        }
      }
      throw error;
    }
  }

  async function deactivate(routeInput, targetId) {
    const route = validateRoute(routeInput);
    await inspectOwnedNetwork(route);
    const target = await inspectTarget(route, targetId);
    if (attachedToRouteNetwork(target, route)) {
      await dockerRequest('POST', '/networks/' + encodeURIComponent(route.upstream.network) + '/disconnect', {
        Container: targetId,
        Force: true
      });
    }
    const proof = await httpsProbe({ gatewayHost, route, expectedAvailable: false });
    return persist(route, { status: 'inactive', targetContainerId: null, proof });
  }

  function status() {
    return {
      schemaVersion: ROUTE_SCHEMA_VERSION,
      owner: 'foxos',
      gateway: 'foxos-caddy',
      configured: Boolean(publicBaseUrl),
      routes: listRoutes()
    };
  }

  return {
    activate,
    deactivate,
    paths: { routesRoot, revisionsRoot },
    planRoute,
    planStatefulCutoverRoute,
    status
  };
}

module.exports = {
  ROUTE_ALIAS,
  ROUTE_HEADER,
  ROUTE_NAME,
  ROUTE_PATH,
  ROUTE_SCHEMA_VERSION,
  STATEFUL_CUTOVER_ROUTE_ALIAS,
  STATEFUL_CUTOVER_ROUTE_KIND,
  STATEFUL_CUTOVER_ROUTE_NAME,
  STATEFUL_CUTOVER_ROUTE_PATH,
  STATEFUL_CUTOVER_PRIVATE_PORT,
  RouteError,
  createRouteManager,
  defaultHttpsProbe
};
