const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const INGRESS_AUTHORITY_SCHEMA_VERSION = 1;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const OPERATION_ID_PATTERN = /^smop_[a-f0-9]{32}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const NETWORK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ROUTE_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const ROUTE_ALIAS_PATTERN = /^[a-z][a-z0-9-]{2,62}$/;

class IngressAuthorityError extends Error {
  constructor(message, statusCode = 409, code = 'ingress-authority-error') {
    super(message);
    this.name = 'IngressAuthorityError';
    this.statusCode = statusCode;
    this.code = code;
  }
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

function atomicWrite(target, value, mode = 0o600) {
  ensureDirectory(path.dirname(target));
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + crypto.randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, value, { mode, flag: 'wx' });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename or cleanup already completed */ }
  }
}

function containerName(details) {
  return String(details && details.Name || '').replace(/^\//, '');
}

function caddyPathMatcher(routePath) {
  return routePath === '/' ? null : routePath.replace(/\/$/, '') + '*';
}

function createIngressAuthorityManager({
  dataRoot,
  dockerRequest,
  dockerExec,
  hostCommand,
  routingNetwork = 'foxos-routing',
  gatewayContainer = 'foxos-gateway',
  ingressContainer = 'foxos-ingress',
  legacyBridgeContainer = 'foxos-legacy-ingress-bridge',
  agentContainer = 'foxos',
  ingressAdminHost = 'foxos-ingress',
  ingressAdminPort = 9999,
  ingressHttpPort = 9080,
  ingressHttpsPort = 9443,
  clock = () => new Date(),
  httpsRequest = https.request,
  connectAdmin = (options) => net.connect(options),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerExec !== 'function' ||
    typeof hostCommand !== 'function'
  ) {
    throw new Error('Ingress authority manager requires data, Docker exec and host command adapters');
  }

  const root = path.join(dataRoot, 'ingress');
  const authorityFile = path.join(root, 'authority.json');
  const routeMapFile = path.join(root, 'routes.map');
  const caddyRuntimeRoot = path.join(dataRoot, 'gateway', 'runtime');
  const caddyRoutesFile = path.join(caddyRuntimeRoot, '50-stateless-routes.caddy');

  function now() {
    return new Date(clock()).toISOString();
  }

  function state() {
    return readJson(authorityFile, {
      schemaVersion: INGRESS_AUTHORITY_SCHEMA_VERSION,
      owner: 'foxos',
      publicAuthorityActive: false,
      legacyBridge: null,
      domains: {},
      routes: {},
      updatedAt: null
    });
  }

  function persist(value) {
    value.updatedAt = now();
    atomicWriteJson(authorityFile, value);
    const lines = Object.entries(value.domains || {}).sort(([left], [right]) => left.localeCompare(right))
      .map(([domain, target]) => domain + ' ' + target);
    atomicWrite(routeMapFile, lines.join('\n') + (lines.length ? '\n' : ''));
    return value;
  }

  async function inspectOwnedInfrastructure() {
    const [network, gateway, ingress] = await Promise.all([
      dockerRequest('GET', '/networks/' + encodeURIComponent(routingNetwork)),
      dockerRequest('GET', '/containers/' + encodeURIComponent(gatewayContainer) + '/json'),
      dockerRequest('GET', '/containers/' + encodeURIComponent(ingressContainer) + '/json')
    ]);
    const networkLabels = network.Labels || {};
    const gatewayLabels = gateway.Config && gateway.Config.Labels || {};
    const ingressLabels = ingress.Config && ingress.Config.Labels || {};
    if (
      networkLabels['com.foxos.routing'] !== 'true' || networkLabels['com.foxos.core'] !== 'true' ||
      network.Internal !== true ||
      gatewayLabels['com.foxos.gateway'] !== 'true' || ingressLabels['com.foxos.ingress'] !== 'true' ||
      !CONTAINER_ID_PATTERN.test(String(gateway.Id || '')) ||
      !CONTAINER_ID_PATTERN.test(String(ingress.Id || '')) ||
      !gateway.State || gateway.State.Running !== true || !ingress.State || ingress.State.Running !== true
    ) {
      throw new IngressAuthorityError(
        'FoxOS gateway or ingress infrastructure is not healthy and owned',
        503,
        'foxos-ingress-unavailable'
      );
    }
    return { network, gateway, ingress };
  }

  async function ensureLegacyBridge({ proxyContainerId, legacyNetwork }) {
    if (!CONTAINER_ID_PATTERN.test(String(proxyContainerId || '')) || !NETWORK_NAME_PATTERN.test(String(legacyNetwork || ''))) {
      throw new IngressAuthorityError('Legacy bridge input is invalid', 400, 'invalid-legacy-bridge-input');
    }
    const [proxy, agent] = await Promise.all([
      dockerRequest('GET', '/containers/' + proxyContainerId + '/json'),
      dockerRequest('GET', '/containers/' + encodeURIComponent(agentContainer) + '/json')
    ]);
    const proxyNetworks = proxy.NetworkSettings && proxy.NetworkSettings.Networks || {};
    if (!proxy.State || proxy.State.Running !== true || !proxyNetworks[legacyNetwork]) {
      throw new IngressAuthorityError('The observed legacy proxy is not running on the selected network', 409, 'legacy-proxy-unavailable');
    }
    const proxyName = containerName(proxy);
    if (!proxyName || !NETWORK_NAME_PATTERN.test(proxyName) || !agent.Image) {
      throw new IngressAuthorityError('Legacy proxy DNS identity is invalid', 409, 'legacy-proxy-identity-invalid');
    }

    let bridge = null;
    try {
      bridge = await dockerRequest('GET', '/containers/' + encodeURIComponent(legacyBridgeContainer) + '/json');
    } catch (error) {
      if (!/No such container/i.test(String(error.message || ''))) throw error;
    }
    if (bridge) {
      const labels = bridge.Config && bridge.Config.Labels || {};
      if (
        labels['com.foxos.migration.bridge'] !== 'true' ||
        labels['com.foxos.legacy.proxy'] !== proxyContainerId ||
        labels['com.foxos.legacy.network'] !== legacyNetwork
      ) {
        throw new IngressAuthorityError('The legacy bridge name is occupied by another object', 409, 'legacy-bridge-conflict');
      }
      if (!bridge.State || bridge.State.Running !== true) {
        await dockerRequest('POST', '/containers/' + bridge.Id + '/start');
      }
    } else {
      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(legacyBridgeContainer),
        {
          Image: agent.Image,
          Entrypoint: ['node', '/app/legacyProxyBridge.js'],
          Cmd: [],
          Env: ['TARGET_HOST=' + proxyName],
          Labels: {
            'com.foxos.managed': 'true',
            'com.foxos.temporary': 'legacy-ingress-bridge',
            'com.foxos.migration.bridge': 'true',
            'com.foxos.legacy.proxy': proxyContainerId,
            'com.foxos.legacy.network': legacyNetwork
          },
          ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
          HostConfig: {
            NetworkMode: legacyNetwork,
            RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
            ReadonlyRootfs: true,
            Privileged: false,
            CapDrop: ['ALL'],
            CapAdd: ['NET_BIND_SERVICE'],
            SecurityOpt: ['no-new-privileges:true'],
            Memory: 128 * 1024 * 1024,
            NanoCpus: 250000000,
            PidsLimit: 64
          }
        }
      );
      bridge = await dockerRequest('GET', '/containers/' + created.Id + '/json');
      await dockerRequest('POST', '/networks/' + encodeURIComponent(routingNetwork) + '/connect', {
        Container: created.Id,
        EndpointConfig: { Aliases: [legacyBridgeContainer] }
      });
      await dockerRequest('POST', '/containers/' + created.Id + '/start');
      bridge = await dockerRequest('GET', '/containers/' + created.Id + '/json');
    }
    const bridgeNetworks = bridge.NetworkSettings && bridge.NetworkSettings.Networks || {};
    if (!bridgeNetworks[legacyNetwork] || !bridgeNetworks[routingNetwork]) {
      throw new IngressAuthorityError('Legacy bridge network proof failed', 503, 'legacy-bridge-network-failed');
    }
    const current = state();
    current.legacyBridge = {
      containerId: bridge.Id,
      proxyContainerId,
      legacyNetwork,
      sourcePreserved: true,
      providerStateMutated: false
    };
    persist(current);
    return current.legacyBridge;
  }

  function renderCaddyRoutes(routes) {
    const grouped = new Map();
    for (const route of Object.values(routes || {}).filter((entry) => entry.status !== 'removed')) {
      grouped.set(route.domain, [...(grouped.get(route.domain) || []), route]);
    }
    const blocks = [];
    for (const [domain, domainRoutes] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const lines = [domain + ' {', '\tencode zstd gzip'];
      for (const route of domainRoutes.sort((left, right) => (
        right.path.length - left.path.length || left.routeId.localeCompare(right.routeId)
      ))) {
        const matcher = caddyPathMatcher(route.path);
        lines.push(matcher ? '\thandle ' + matcher + ' {' : '\thandle {');
        lines.push('\t\theader X-FoxOS-Route "' + route.routeId + '"');
        lines.push('\t\theader X-FoxOS-Candidate "' + route.operationId + '"');
        lines.push('\t\treverse_proxy ' + route.alias + ':' + route.privatePort);
        lines.push('\t}');
      }
      lines.push('}');
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n') + (blocks.length ? '\n' : '');
  }

  async function reloadCaddy(routes, gatewayContainerId = null) {
    let exactGatewayContainerId = gatewayContainerId;
    if (!CONTAINER_ID_PATTERN.test(String(exactGatewayContainerId || ''))) {
      const infrastructure = await inspectOwnedInfrastructure();
      exactGatewayContainerId = infrastructure.gateway.Id;
    }
    ensureDirectory(caddyRuntimeRoot);
    atomicWrite(caddyRoutesFile, renderCaddyRoutes(routes));
    const validate = await dockerExec(exactGatewayContainerId, [
      'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'
    ], { timeoutMs: 30000 });
    if (validate.exitCode !== 0) {
      throw new IngressAuthorityError('FoxOS route configuration validation failed', 503, 'caddy-route-validation-failed');
    }
    const reload = await dockerExec(exactGatewayContainerId, [
      'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
      '--address', '127.0.0.1:2019'
    ], { timeoutMs: 30000 });
    if (reload.exitCode !== 0) {
      throw new IngressAuthorityError('FoxOS route configuration reload failed', 503, 'caddy-route-reload-failed');
    }
  }

  function validateRoute(route) {
    if (
      !route || !OPERATION_ID_PATTERN.test(String(route.operationId || '')) ||
      !/^smroute_[a-f0-9]{24}$/.test(String(route.routeId || '')) ||
      !DOMAIN_PATTERN.test(String(route.domain || '')) || !ROUTE_PATH_PATTERN.test(String(route.path || '')) ||
      !ROUTE_ALIAS_PATTERN.test(String(route.alias || '')) ||
      !Number.isInteger(route.privatePort) || route.privatePort < 1 || route.privatePort > 65535
    ) {
      throw new IngressAuthorityError('FoxOS production route is invalid', 400, 'invalid-production-route');
    }
  }

  async function stageRoutes(routeInputs) {
    const infrastructure = await inspectOwnedInfrastructure();
    if (!Array.isArray(routeInputs) || !routeInputs.length) {
      throw new IngressAuthorityError('At least one production route is required', 400, 'empty-production-routes');
    }
    for (const route of routeInputs) validateRoute(route);
    const current = state();
    for (const input of routeInputs) {
      const collision = Object.values(current.routes || {}).find((route) => (
        route.routeId !== input.routeId && route.status !== 'removed' &&
        route.domain === input.domain && route.path === input.path
      ));
      if (collision) throw new IngressAuthorityError('A FoxOS route already owns this domain and path', 409, 'foxos-route-conflict');
      current.routes[input.routeId] = { ...input, status: 'staged', stagedAt: now() };
      if (!current.domains[input.domain]) current.domains[input.domain] = 'legacy';
    }
    await reloadCaddy(current.routes, infrastructure.gateway.Id);
    persist(current);
    for (const domain of new Set(routeInputs.map((route) => route.domain))) {
      await setRuntimeMap(domain, current.domains[domain]);
    }
    return routeInputs.map((route) => current.routes[route.routeId]);
  }

  function adminCommand(command) {
    return new Promise((resolve, reject) => {
      const socket = connectAdmin({ host: ingressAdminHost, port: ingressAdminPort });
      let output = '';
      socket.setEncoding('utf8');
      socket.setTimeout(5000);
      socket.on('connect', () => socket.end(command + '\n'));
      socket.on('data', (chunk) => { output += chunk; });
      socket.on('end', () => resolve(output));
      socket.on('timeout', () => socket.destroy(new Error('HAProxy admin socket timed out')));
      socket.on('error', reject);
    });
  }

  async function setRuntimeMap(domain, target) {
    if (!DOMAIN_PATTERN.test(domain) || !['legacy', 'foxos'].includes(target)) {
      throw new IngressAuthorityError('Ingress map update is invalid', 400, 'invalid-ingress-map-update');
    }
    let output = await adminCommand('set map /runtime/routes.map ' + domain + ' ' + target);
    if (/not found|does not exist|unknown key/i.test(output)) {
      output = await adminCommand('add map /runtime/routes.map ' + domain + ' ' + target);
    }
    if (/error|failed|permission denied/i.test(output)) {
      throw new IngressAuthorityError('HAProxy rejected the atomic domain map update', 503, 'ingress-map-update-failed');
    }
  }

  async function firewall(binary, args, allowFailure = false) {
    const result = await hostCommand(binary, args);
    if (!result || (result.success !== true && !allowFailure)) {
      throw new IngressAuthorityError('FoxOS could not update host ingress authority', 503, 'host-ingress-update-failed');
    }
    return result && result.success === true;
  }

  async function installFirewallFamily(binary) {
    await firewall(binary, ['-w', '5', '-t', 'nat', '-N', 'FOXOS_INGRESS'], true);
    await firewall(binary, ['-w', '5', '-t', 'nat', '-F', 'FOXOS_INGRESS']);
    await firewall(binary, [
      '-w', '5', '-t', 'nat', '-A', 'FOXOS_INGRESS', '-p', 'tcp', '--dport', '80',
      '-j', 'REDIRECT', '--to-ports', String(ingressHttpPort)
    ]);
    await firewall(binary, [
      '-w', '5', '-t', 'nat', '-A', 'FOXOS_INGRESS', '-p', 'tcp', '--dport', '443',
      '-j', 'REDIRECT', '--to-ports', String(ingressHttpsPort)
    ]);
    const jump = [
      '-w', '5', '-t', 'nat', '-m', 'addrtype', '--dst-type', 'LOCAL', '-p', 'tcp',
      '-m', 'multiport', '--dports', '80,443', '-j', 'FOXOS_INGRESS'
    ];
    const exists = await firewall(binary, ['-w', '5', '-t', 'nat', '-C', 'PREROUTING', ...jump.slice(4)], true);
    if (!exists) {
      await firewall(binary, ['-w', '5', '-t', 'nat', '-I', 'PREROUTING', '1', ...jump.slice(4)]);
    }
  }

  async function removeFirewallFamily(binary) {
    const rule = [
      '-m', 'addrtype', '--dst-type', 'LOCAL', '-p', 'tcp', '-m', 'multiport',
      '--dports', '80,443', '-j', 'FOXOS_INGRESS'
    ];
    while (await firewall(binary, ['-w', '5', '-t', 'nat', '-C', 'PREROUTING', ...rule], true)) {
      await firewall(binary, ['-w', '5', '-t', 'nat', '-D', 'PREROUTING', ...rule]);
    }
  }

  async function activatePublicAuthority() {
    await inspectOwnedInfrastructure();
    await installFirewallFamily('iptables');
    try {
      await installFirewallFamily('ip6tables');
    } catch (error) {
      await removeFirewallFamily('iptables');
      throw error;
    }
    const current = state();
    current.publicAuthorityActive = true;
    current.firewall = {
      ipv4: true,
      ipv6: true,
      inputPorts: [80, 443],
      localTargetPorts: [ingressHttpPort, ingressHttpsPort],
      reversible: true
    };
    persist(current);
    return current.firewall;
  }

  async function deactivatePublicAuthorityIfUnused() {
    const current = state();
    if (Object.values(current.domains || {}).some((target) => target === 'foxos')) return false;
    await removeFirewallFamily('ip6tables');
    await removeFirewallFamily('iptables');
    current.publicAuthorityActive = false;
    persist(current);
    return true;
  }

  async function switchDomain(domain, target) {
    const normalized = String(domain || '').toLowerCase();
    const current = state();
    if (!DOMAIN_PATTERN.test(normalized) || !current.domains[normalized]) {
      throw new IngressAuthorityError('The domain has not been staged', 409, 'domain-not-staged');
    }
    await setRuntimeMap(normalized, target);
    current.domains[normalized] = target;
    for (const route of Object.values(current.routes || {}).filter((entry) => entry.domain === normalized)) {
      route.status = target === 'foxos' ? 'active' : 'staged';
      route.switchedAt = now();
    }
    persist(current);
    if (target === 'foxos' && !current.publicAuthorityActive) await activatePublicAuthority();
    if (target === 'legacy') await deactivatePublicAuthorityIfUnused();
    return { domain: normalized, target, publicAuthorityActive: state().publicAuthorityActive };
  }

  async function removeRoutes(routeIds) {
    const current = state();
    const domains = new Set();
    for (const routeId of routeIds || []) {
      const route = current.routes[routeId];
      if (!route) continue;
      domains.add(route.domain);
      delete current.routes[routeId];
    }
    for (const domain of domains) {
      if (!Object.values(current.routes).some((route) => route.domain === domain)) {
        current.domains[domain] = 'legacy';
        await setRuntimeMap(domain, 'legacy');
      }
    }
    await reloadCaddy(current.routes);
    persist(current);
    await deactivatePublicAuthorityIfUnused();
  }

  function httpsProbe({ hostname, connectHost = hostname, port = 443, requestPath = '/', expectedRouteId = null, timeoutMs = 10000 }) {
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        hostname: connectHost,
        port,
        path: requestPath,
        method: 'GET',
        servername: hostname,
        headers: { Host: hostname },
        timeout: timeoutMs,
        rejectUnauthorized: true
      }, (response) => {
        const tlsValid = Boolean(response.socket && response.socket.authorized);
        response.resume();
        response.on('end', () => {
          const routeId = String(response.headers['x-foxos-route'] || '');
          const candidate = String(response.headers['x-foxos-candidate'] || '');
          resolve({
            statusCode: response.statusCode || 0,
            tlsValid,
            routeId: routeId || null,
            candidateIdentity: candidate || null,
            expectedRoute: expectedRouteId ? routeId === expectedRouteId : null
          });
        });
      });
      request.on('timeout', () => request.destroy(new Error('HTTPS ingress probe timed out')));
      request.on('error', reject);
      request.end();
    });
  }

  async function verifyLegacyDomain({ hostname: rawHostname, requestPath = '/', attempts = 20 }) {
    const hostname = String(rawHostname || '').toLowerCase();
    if (
      !DOMAIN_PATTERN.test(hostname) || !ROUTE_PATH_PATTERN.test(String(requestPath || '')) ||
      !Number.isInteger(attempts) || attempts < 1 || attempts > 40
    ) {
      throw new IngressAuthorityError('Legacy ingress proof input is invalid', 400, 'invalid-legacy-ingress-proof');
    }
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const proof = await httpsProbe({
          hostname,
          connectHost: ingressContainer,
          port: 443,
          requestPath
        });
        if (
          proof.tlsValid === true && proof.statusCode >= 200 && proof.statusCode < 400 &&
          !proof.candidateIdentity
        ) return { ...proof, legacyReady: true, attempts: attempt + 1 };
        lastError = new Error('Legacy ingress returned an invalid response');
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < attempts) await delay(250);
    }
    throw new IngressAuthorityError(
      'Legacy ingress did not become ready before FoxOS traffic authority',
      503,
      lastError && lastError.code || 'legacy-ingress-not-ready'
    );
  }

  ensureDirectory(root);
  ensureDirectory(caddyRuntimeRoot);
  if (!fs.existsSync(routeMapFile)) atomicWrite(routeMapFile, '');
  if (!fs.existsSync(path.join(caddyRuntimeRoot, '00-empty.caddy'))) {
    atomicWrite(path.join(caddyRuntimeRoot, '00-empty.caddy'), '');
  }
  return {
    activatePublicAuthority,
    deactivatePublicAuthorityIfUnused,
    ensureLegacyBridge,
    httpsProbe,
    inspectOwnedInfrastructure,
    paths: { root, authorityFile, routeMapFile, caddyRoutesFile },
    removeRoutes,
    stageRoutes,
    state,
    switchDomain,
    verifyLegacyDomain
  };
}

module.exports = {
  INGRESS_AUTHORITY_SCHEMA_VERSION,
  IngressAuthorityError,
  createIngressAuthorityManager
};
