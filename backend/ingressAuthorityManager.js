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

function domainForBaseUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    const hostname = parsed.hostname.toLowerCase();
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username && !parsed.password &&
      DOMAIN_PATTERN.test(hostname)
    ) ? hostname : null;
  } catch {
    return null;
  }
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
  panelBaseUrl = null,
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
  const panelDomain = domainForBaseUrl(panelBaseUrl);

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
    const ingressDomains = { ...(value.domains || {}) };
    if (panelDomain) ingressDomains[panelDomain] = 'foxos';
    const lines = Object.entries(ingressDomains).sort(([left], [right]) => left.localeCompare(right))
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

  async function hostIngressAddress() {
    const agent = await dockerRequest('GET', '/containers/' + encodeURIComponent(agentContainer) + '/json');
    const labels = agent.Config && agent.Config.Labels || {};
    const networks = agent.NetworkSettings && agent.NetworkSettings.Networks || {};
    const gateways = [...new Set(Object.values(networks)
      .map((entry) => String(entry && entry.Gateway || ''))
      .filter((gateway) => net.isIP(gateway) === 4))].sort();
    if (
      labels['com.foxos.core'] !== 'true' || !agent.State || agent.State.Running !== true ||
      gateways.length === 0
    ) {
      throw new IngressAuthorityError(
        'FoxOS could not resolve a direct host ingress address',
        503,
        'host-ingress-address-unavailable'
      );
    }
    return gateways[0];
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
          Healthcheck: {
            Test: [
              'CMD', 'node', '-e',
              "const net=require('node:net');const probe=(port)=>new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port},()=>{socket.destroy();resolve()});socket.setTimeout(1000,()=>socket.destroy(new Error('timeout')));socket.on('error',reject)});Promise.all([80,443].map(probe)).then(()=>process.exit(0)).catch(()=>process.exit(1))"
            ],
            Interval: 30000000000,
            Timeout: 3000000000,
            StartPeriod: 5000000000,
            Retries: 3
          },
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
        lines.push('\t\theader X-FoxOS-Runtime "' + route.runtimeContainerId.slice(0, 12) + '"');
        lines.push('\t\treverse_proxy ' + route.runtimeAddress + ':' + route.privatePort);
        lines.push('\t}');
      }
      lines.push('}');
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n') + (blocks.length ? '\n' : '');
  }

  async function resolveRouteRuntime(route, preferredContainerId = null) {
    const network = await dockerRequest('GET', '/networks/' + encodeURIComponent(routingNetwork));
    const candidateIds = preferredContainerId
      ? [preferredContainerId]
      : Object.keys(network.Containers || {}).filter((containerId) => CONTAINER_ID_PATTERN.test(containerId));
    const matches = [];
    for (const containerId of candidateIds) {
      if (!CONTAINER_ID_PATTERN.test(String(containerId || ''))) continue;
      let details;
      try {
        details = await dockerRequest('GET', '/containers/' + containerId + '/json');
      } catch (error) {
        if (!preferredContainerId && /No such container/i.test(String(error.message || ''))) continue;
        throw error;
      }
      const attachment = details.NetworkSettings && details.NetworkSettings.Networks &&
        details.NetworkSettings.Networks[routingNetwork];
      const aliases = attachment && Array.isArray(attachment.Aliases) ? attachment.Aliases : [];
      const address = String(attachment && attachment.IPAddress || '').split('/')[0];
      if (
        details.State && details.State.Running === true && aliases.includes(route.alias) &&
        net.isIP(address) === 4 && CONTAINER_ID_PATTERN.test(String(details.Id || ''))
      ) {
        matches.push({ containerId: details.Id, address });
      }
    }
    if (matches.length !== 1) {
      throw new IngressAuthorityError(
        preferredContainerId
          ? 'The selected route runtime is not running with the required Docker alias'
          : 'The route alias does not resolve to exactly one running container',
        503,
        preferredContainerId ? 'route-runtime-proof-failed' : 'route-runtime-ambiguous'
      );
    }
    return matches[0];
  }

  async function hydrateRouteRuntimes(routes, runtimeOverrides = {}) {
    const hydrated = {};
    const resolvedAliases = new Map();
    for (const [routeId, route] of Object.entries(routes || {})) {
      if (route.status === 'removed') {
        hydrated[routeId] = { ...route };
        continue;
      }
      const preferredContainerId = runtimeOverrides[routeId] || null;
      const cacheKey = route.alias + ':' + (preferredContainerId || 'auto');
      let runtime = resolvedAliases.get(cacheKey);
      if (!runtime) {
        runtime = await resolveRouteRuntime(route, preferredContainerId);
        resolvedAliases.set(cacheKey, runtime);
      }
      hydrated[routeId] = {
        ...route,
        runtimeContainerId: runtime.containerId,
        runtimeAddress: runtime.address,
        runtimeResolvedAt: now()
      };
    }
    return hydrated;
  }

  async function reloadCaddy(routes, gatewayContainerId = null, runtimeOverrides = {}) {
    let exactGatewayContainerId = gatewayContainerId;
    if (!CONTAINER_ID_PATTERN.test(String(exactGatewayContainerId || ''))) {
      const infrastructure = await inspectOwnedInfrastructure();
      exactGatewayContainerId = infrastructure.gateway.Id;
    }
    const hydratedRoutes = await hydrateRouteRuntimes(routes, runtimeOverrides);
    ensureDirectory(caddyRuntimeRoot);
    atomicWrite(caddyRoutesFile, renderCaddyRoutes(hydratedRoutes));
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
    return hydratedRoutes;
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
    current.routes = await reloadCaddy(current.routes, infrastructure.gateway.Id);
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

  async function resolveFirewallBinary(binary) {
    const candidates = [binary, binary + '-legacy', binary + '-nft'];
    const available = [];
    for (const candidate of candidates) {
      const compatible = await firewall(candidate, ['-w', '5', '-t', 'nat', '-L'], true);
      if (!compatible) continue;
      available.push(candidate);
      const ownsDockerNat = await firewall(candidate, ['-w', '5', '-t', 'nat', '-S', 'DOCKER'], true);
      if (!ownsDockerNat) continue;
      return candidate;
    }
    if (available.length) {
      return available[0];
    }
    throw new IngressAuthorityError(
      'No compatible host firewall backend is available for FoxOS ingress',
      503,
      'host-firewall-unavailable'
    );
  }

  async function installFirewallFamily(binary) {
    const executable = await resolveFirewallBinary(binary);
    await firewall(executable, ['-w', '5', '-t', 'nat', '-N', 'FOXOS_INGRESS'], true);
    await firewall(executable, ['-w', '5', '-t', 'nat', '-F', 'FOXOS_INGRESS']);
    await firewall(executable, [
      '-w', '5', '-t', 'nat', '-A', 'FOXOS_INGRESS', '-p', 'tcp', '--dport', '80',
      '-j', 'REDIRECT', '--to-ports', String(ingressHttpPort)
    ]);
    await firewall(executable, [
      '-w', '5', '-t', 'nat', '-A', 'FOXOS_INGRESS', '-p', 'tcp', '--dport', '443',
      '-j', 'REDIRECT', '--to-ports', String(ingressHttpsPort)
    ]);
    const jump = [
      '-w', '5', '-t', 'nat', '-m', 'addrtype', '--dst-type', 'LOCAL', '-p', 'tcp',
      '-m', 'multiport', '--dports', '80,443', '-j', 'FOXOS_INGRESS'
    ];
    const exists = await firewall(executable, ['-w', '5', '-t', 'nat', '-C', 'PREROUTING', ...jump.slice(4)], true);
    if (!exists) {
      await firewall(executable, ['-w', '5', '-t', 'nat', '-I', 'PREROUTING', '1', ...jump.slice(4)]);
    }
    return executable;
  }

  async function removeFirewallFamily(binary) {
    const executable = await resolveFirewallBinary(binary);
    const rule = [
      '-m', 'addrtype', '--dst-type', 'LOCAL', '-p', 'tcp', '-m', 'multiport',
      '--dports', '80,443', '-j', 'FOXOS_INGRESS'
    ];
    while (await firewall(executable, ['-w', '5', '-t', 'nat', '-C', 'PREROUTING', ...rule], true)) {
      await firewall(executable, ['-w', '5', '-t', 'nat', '-D', 'PREROUTING', ...rule]);
    }
  }

  async function activatePublicAuthority() {
    await inspectOwnedInfrastructure();
    const ipv4Backend = await installFirewallFamily('iptables');
    let ipv6Backend;
    try {
      ipv6Backend = await installFirewallFamily('ip6tables');
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
      backends: { ipv4: ipv4Backend, ipv6: ipv6Backend },
      reversible: true
    };
    persist(current);
    if (panelDomain) await setRuntimeMap(panelDomain, 'foxos');
    return current.firewall;
  }

  async function reconcilePublicAuthority() {
    const current = state();
    if (current.publicAuthorityActive !== true) {
      return { active: false, reconciled: false };
    }
    const infrastructure = await inspectOwnedInfrastructure();
    current.routes = await reloadCaddy(current.routes, infrastructure.gateway.Id);
    const ipv4Backend = await installFirewallFamily('iptables');
    let ipv6Backend;
    try {
      ipv6Backend = await installFirewallFamily('ip6tables');
    } catch (error) {
      await removeFirewallFamily('iptables');
      throw error;
    }
    current.firewall = {
      ipv4: true,
      ipv6: true,
      inputPorts: [80, 443],
      localTargetPorts: [ingressHttpPort, ingressHttpsPort],
      backends: { ipv4: ipv4Backend, ipv6: ipv6Backend },
      reversible: true,
      reconciledAt: now()
    };
    persist(current);
    if (panelDomain) await setRuntimeMap(panelDomain, 'foxos');
    return { active: true, reconciled: true, ...current.firewall };
  }

  async function refreshOperationRuntime(operationId, containerId) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || '')) || !CONTAINER_ID_PATTERN.test(String(containerId || ''))) {
      throw new IngressAuthorityError('Route runtime refresh input is invalid', 400, 'invalid-route-runtime-refresh');
    }
    const current = state();
    const routes = Object.values(current.routes || {}).filter((route) => (
      route.operationId === operationId && route.status !== 'removed'
    ));
    if (!routes.length) {
      throw new IngressAuthorityError('No route belongs to the selected operation', 409, 'operation-route-not-found');
    }
    const overrides = Object.fromEntries(routes.map((route) => [route.routeId, containerId]));
    current.routes = await reloadCaddy(current.routes, null, overrides);
    persist(current);
    return routes.map((route) => current.routes[route.routeId]);
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
    current.routes = await reloadCaddy(current.routes);
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

  async function verifyLegacyBackend({ hostname: rawHostname, requestPath = '/', attempts = 40 }) {
    const hostname = String(rawHostname || '').toLowerCase();
    if (
      !DOMAIN_PATTERN.test(hostname) || !ROUTE_PATH_PATTERN.test(String(requestPath || '')) ||
      !Number.isInteger(attempts) || attempts < 1 || attempts > 80
    ) {
      throw new IngressAuthorityError('Legacy backend proof input is invalid', 400, 'invalid-legacy-backend-proof');
    }
    const current = state();
    const bridgeId = current.legacyBridge && current.legacyBridge.containerId;
    if (!CONTAINER_ID_PATTERN.test(String(bridgeId || ''))) {
      throw new IngressAuthorityError('Legacy bridge identity is unavailable', 503, 'legacy-bridge-unavailable');
    }
    const bridge = await dockerRequest('GET', '/containers/' + bridgeId + '/json');
    const labels = bridge.Config && bridge.Config.Labels || {};
    if (
      !bridge.State || bridge.State.Running !== true ||
      labels['com.foxos.migration.bridge'] !== 'true' ||
      labels['com.foxos.legacy.proxy'] !== current.legacyBridge.proxyContainerId ||
      labels['com.foxos.legacy.network'] !== current.legacyBridge.legacyNetwork
    ) {
      throw new IngressAuthorityError('Legacy bridge ownership proof failed', 503, 'legacy-bridge-unavailable');
    }
    const probeScript = [
      "const https=require('node:https')",
      "const hostname=process.argv[1]",
      "const requestPath=process.argv[2]",
      "const request=https.request({host:process.env.TARGET_HOST,port:443,servername:hostname,path:requestPath,method:'GET',headers:{Host:hostname},rejectUnauthorized:true,timeout:5000},(response)=>{const tlsValid=Boolean(response.socket&&response.socket.authorized);response.resume();response.on('end',()=>{process.stdout.write(JSON.stringify({statusCode:response.statusCode||0,tlsValid}));process.exit(tlsValid&&response.statusCode>=200&&response.statusCode<400?0:2)})})",
      "request.on('timeout',()=>request.destroy(new Error('timeout')))",
      "request.on('error',()=>process.exit(1))",
      "request.end()"
    ].join(';');
    let lastCode = 'legacy-backend-not-ready';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await dockerExec(bridgeId, ['node', '-e', probeScript, hostname, requestPath], {
        timeoutMs: 7000
      });
      if (result.exitCode === 0) {
        try {
          const proof = JSON.parse(String(result.output || '').trim());
          if (proof.tlsValid === true && proof.statusCode >= 200 && proof.statusCode < 400) {
            return { ...proof, legacyReady: true, attempts: attempt + 1 };
          }
        } catch {
          lastCode = 'legacy-backend-proof-invalid';
        }
      }
      if (attempt + 1 < attempts) await delay(250);
    }
    throw new IngressAuthorityError(
      'Legacy backend did not become ready before rollback',
      503,
      lastCode
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
    hostIngressAddress,
    httpsProbe,
    inspectOwnedInfrastructure,
    paths: { root, authorityFile, routeMapFile, caddyRoutesFile },
    removeRoutes,
    reconcilePublicAuthority,
    refreshOperationRuntime,
    stageRoutes,
    state,
    switchDomain,
    verifyLegacyBackend,
    verifyLegacyDomain
  };
}

module.exports = {
  domainForBaseUrl,
  INGRESS_AUTHORITY_SCHEMA_VERSION,
  IngressAuthorityError,
  createIngressAuthorityManager
};
