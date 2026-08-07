const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  RESOURCE_CLASSIFICATION_SCHEMA_VERSION,
  classifyResource
} = require('./resourceClassification');

const SCHEMA_VERSION = 1;
const INSPECT_CONCURRENCY = 6;
const MAX_REVISIONS = 100;
const VERIFIED_STATELESS_MIGRATION_STATUS = 'traffic-on-foxos-source-preserved';
const VERIFIED_STATEFUL_MIGRATION_STATUS = 'traffic-on-server-source-preserved';
const VERIFIED_RUNTIME_TRANSFER_STATUSES = new Set([
  'server-runtime-adopted',
  'server-definition-adopted'
]);

const SAFE_LABEL_KEYS = new Set([
  'com.foxos.managed',
  'com.foxos.app.id',
  'com.foxos.app.name',
  'com.foxos.core',
  'com.foxos.gateway',
  'com.foxos.adoption.disposable',
  'com.foxos.deployment.disposable',
  'com.foxos.compose-deployment.disposable',
  'com.foxos.image-update.disposable',
  'com.foxos.stateful-shadow',
  'com.foxos.stateful-shadow.source-resource-id',
  'com.foxos.stateful-shadow.operation',
  'com.foxos.migration.source-resource-id',
  'com.foxos.stateful-migration.id',
  'com.foxos.deployment.group.id',
  'com.foxos.deployment.service',
  'com.foxos.deployment.revision',
  'com.foxos.deployment.operation',
  'com.foxos.resource.id',
  'com.docker.compose.project',
  'com.docker.compose.service',
  'com.docker.compose.container-number',
  'com.docker.compose.version',
  'coolify.managed',
  'coolify.type',
  'coolify.service.subType',
  'coolify.service.subName',
  'coolify.serviceName',
  'coolify.projectName',
  'coolify.resourceName',
  'coolify.environmentName'
]);

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function isTrue(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== null && value !== undefined && value !== '')
  );
}

function safeLabels(labels = {}) {
  return Object.fromEntries(
    Object.keys(labels)
      .filter((key) => SAFE_LABEL_KEYS.has(key))
      .sort()
      .map((key) => [key, String(labels[key])])
  );
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function atomicWriteJson(target, value) {
  ensureDirectory(path.dirname(target));
  const temporary = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not exist if creation itself failed.
    }
    throw error;
  }
}

function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

function listJson(directory) {
  try {
    return fs.readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => readJson(path.join(directory, file)))
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function readFoxosMigrationManagement(dataRoot, resources = []) {
  const authority = readJson(path.join(dataRoot, 'ingress', 'authority.json'), null);
  const operations = listJson(path.join(dataRoot, 'stateless-migrations', 'operations'));
  const plansById = new Map(listJson(path.join(dataRoot, 'stateless-migrations', 'plans'))
    .filter((plan) => plan && plan.planId)
    .map((plan) => [plan.planId, plan]));
  const resourcesByContainerId = new Map((resources || [])
    .filter((resource) => resource && resource.runtime && resource.runtime.containerId)
    .map((resource) => [resource.runtime.containerId, resource]));
  const managementByResourceId = new Map();

  function recordManagement(resourceId, management) {
    const current = managementByResourceId.get(resourceId);
    const currentPriority = current && current.state === 'active' ? 1 : 0;
    const nextPriority = management.state === 'active' ? 1 : 0;
    if (
      !current || nextPriority > currentPriority ||
      (nextPriority === currentPriority && String(management.completedAt).localeCompare(String(current.completedAt)) > 0)
    ) managementByResourceId.set(resourceId, management);
  }

  for (const operation of operations) {
    if (
      operation.status !== VERIFIED_STATELESS_MIGRATION_STATUS ||
      !/^res_[a-f0-9]{32}$/.test(String(operation.resourceId || '')) ||
      !/^smop_[a-f0-9]{32}$/.test(String(operation.operationId || ''))
    ) continue;

    const routeId = operation.route && operation.route.routeId || null;
    const authorityRoute = routeId && authority && authority.routes && authority.routes[routeId] || null;
    const domain = operation.route && operation.route.domain || authorityRoute && authorityRoute.domain || null;
    const authorityActive = Boolean(
      authority && authority.owner === 'foxos' && authority.publicAuthorityActive === true &&
      authorityRoute && authorityRoute.operationId === operation.operationId && authorityRoute.status === 'active' &&
      domain && authority.domains && authority.domains[domain] === 'foxos'
    );
    const candidateContainerId = operation.candidate && operation.candidate.containerId || null;
    const candidateResource = candidateContainerId ? resourcesByContainerId.get(candidateContainerId) : null;
    const candidateRunning = Boolean(
      candidateResource && candidateResource.runtime && candidateResource.runtime.state === 'running'
    );
    const trafficVerified = Boolean(
      operation.trafficProof && operation.trafficProof.healthy === true &&
      operation.trafficProof.candidateServing === true && operation.trafficProof.tlsValid === true
    );
    const sourcePreserved = Boolean(
      operation.source && operation.source.retainedForRollback === true &&
      operation.trafficProof && operation.trafficProof.sourceContinuouslyRunning === true
    );
    const plan = plansById.get(operation.planId) || null;
    const plannedResource = plan && plan.resource || {};
    const state = authorityActive && candidateRunning && trafficVerified && sourcePreserved
      ? 'active'
      : 'attention-required';
    const management = {
      owner: 'foxos',
      logicalResourceId: operation.resourceId,
      state,
      lifecycle: 'stateless-blue-green',
      operationId: operation.operationId,
      routeId,
      domains: domain ? [domain] : [],
      candidateContainerId,
      candidateResourceId: candidateResource && candidateResource.id || null,
      authorityActive,
      candidateRunning,
      trafficVerified,
      sourcePreserved,
      sourceName: plannedResource.name || null,
      sourceProvider: plannedResource.observedProvider || null,
      sourceOwnership: plannedResource.observedOwnership || null,
      automaticMigrationAllowed: false,
      completedAt: operation.completedAt || null
    };
    recordManagement(operation.resourceId, management);
  }

  const statefulOperations = listJson(path.join(dataRoot, 'stateful-migrations', 'operations'));
  const statefulPlansById = new Map(listJson(path.join(dataRoot, 'stateful-migrations', 'plans'))
    .filter((plan) => plan && plan.planId)
    .map((plan) => [plan.planId, plan]));
  for (const operation of statefulOperations) {
    if (
      operation.status !== VERIFIED_STATEFUL_MIGRATION_STATUS ||
      !/^res_[a-f0-9]{32}$/.test(String(operation.resourceId || '')) ||
      !/^stmop_[a-f0-9]{32}$/.test(String(operation.operationId || ''))
    ) continue;
    const operationRoutes = operation.route && Array.isArray(operation.route.routes)
      ? operation.route.routes
      : operation.route ? [operation.route] : [];
    const authorityRoutes = operationRoutes.map((route) => (
      route && route.routeId && authority && authority.routes && authority.routes[route.routeId]
    )).filter(Boolean);
    const domains = Array.from(new Set(operationRoutes.map((route) => route && route.domain).filter(Boolean))).sort();
    const authorityActive = Boolean(
      authority && authority.owner === 'foxos' && authority.publicAuthorityActive === true &&
      authorityRoutes.length === operationRoutes.length && operationRoutes.length > 0 &&
      authorityRoutes.every((route) => (
        route.operationId === operation.operationId && route.status === 'active' &&
        authority.domains && authority.domains[route.domain] === 'foxos'
      ))
    );
    const candidateContainerId = operation.candidate && operation.candidate.containerId || null;
    const candidateResource = candidateContainerId ? resourcesByContainerId.get(candidateContainerId) : null;
    const candidateRunning = Boolean(candidateResource && candidateResource.runtime && candidateResource.runtime.state === 'running');
    const trafficVerified = Boolean(
      operation.trafficProof && operation.trafficProof.healthy === true &&
      operation.trafficProof.candidateServing === true && operation.trafficProof.tlsValid === true
    );
    const sourcePreserved = Boolean(operation.source && operation.source.retainedForRollback === true);
    const plan = statefulPlansById.get(operation.planId) || null;
    const plannedResource = plan && plan.resource || {};
    const state = authorityActive && candidateRunning && trafficVerified && sourcePreserved
      ? 'active'
      : 'attention-required';
    recordManagement(operation.resourceId, {
      owner: 'foxos',
      logicalResourceId: operation.resourceId,
      state,
      lifecycle: 'stateful-bounded-quiesce',
      operationId: operation.operationId,
      routeId: operationRoutes[0] && operationRoutes[0].routeId || null,
      domains,
      candidateContainerId,
      candidateResourceId: candidateResource && candidateResource.id || null,
      authorityActive,
      candidateRunning,
      trafficVerified,
      sourcePreserved,
      sourceName: plannedResource.name || null,
      sourceProvider: plannedResource.observedProvider || null,
      sourceOwnership: plannedResource.observedOwnership || null,
      automaticMigrationAllowed: false,
      completedAt: operation.completedAt || null
    });
  }

  const runtimeTransferOperations = listJson(path.join(dataRoot, 'runtime-transfers', 'operations'));
  for (const operation of runtimeTransferOperations) {
    if (
      !VERIFIED_RUNTIME_TRANSFER_STATUSES.has(operation.status) ||
      !/^rtop_[a-f0-9]{32}$/.test(String(operation.operationId || ''))
    ) continue;
    const manifests = Array.isArray(operation.manifests) ? operation.manifests : [];
    const operationRoutes = Array.isArray(operation.routes) ? operation.routes : [];
    const authorityRoutes = operationRoutes.map((route) => (
      route && route.routeId && authority && authority.routes && authority.routes[route.routeId]
    )).filter(Boolean);
    const domains = Array.from(new Set(operationRoutes.map((route) => route && route.domain).filter(Boolean))).sort();
    const routeAuthorityActive = !operationRoutes.length || Boolean(
      authority && authority.owner === 'foxos' && authority.publicAuthorityActive === true &&
      authorityRoutes.length === operationRoutes.length &&
      authorityRoutes.every((route) => (
        route.operationId === operation.operationId && route.status === 'active' &&
        authority.domains && authority.domains[route.domain] === 'foxos'
      ))
    );
    for (const resourceId of operation.memberResourceIds || [operation.resourceId]) {
      if (!/^res_[a-f0-9]{32}$/.test(String(resourceId || ''))) continue;
      const manifest = manifests.find((entry) => entry && entry.resourceId === resourceId) || null;
      const containerId = manifest && manifest.runtime && manifest.runtime.containerId ||
        (resourceId === operation.resourceId ? operation.candidateContainerId : null);
      const candidateResource = containerId ? resourcesByContainerId.get(containerId) || null : null;
      const definitionOnly = operation.status === 'server-definition-adopted';
      const candidateRunning = definitionOnly || Boolean(
        candidateResource && candidateResource.runtime && candidateResource.runtime.state === 'running'
      );
      const resourceDomains = resourceId === operation.resourceId ? domains : [];
      const trafficVerified = !resourceDomains.length || Boolean(
        operation.trafficProof && operation.trafficProof.healthy === true &&
        operation.trafficProof.unavailableSamples === 0
      );
      const state = routeAuthorityActive && candidateRunning && trafficVerified
        ? 'active'
        : 'attention-required';
      recordManagement(resourceId, {
        owner: 'foxos',
        logicalResourceId: resourceId,
        state,
        lifecycle: definitionOnly ? 'inactive-definition-transfer' : 'in-place-runtime-transfer',
        operationId: operation.operationId,
        routeId: resourceDomains.length && operationRoutes[0] && operationRoutes[0].routeId || null,
        domains: resourceDomains,
        candidateContainerId: containerId,
        candidateResourceId: candidateResource && candidateResource.id || null,
        authorityActive: resourceDomains.length ? routeAuthorityActive : true,
        candidateRunning,
        trafficVerified,
        sourcePreserved: true,
        sourceName: manifest && manifest.name || null,
        sourceProvider: manifest && manifest.provenance && manifest.provenance.importedFrom || null,
        sourceOwnership: 'observed',
        automaticMigrationAllowed: false,
        completedAt: operation.completedAt || null
      });
    }
  }
  return managementByResourceId;
}

function attachFoxosMigrationManagement(resources = [], managementByResourceId = new Map()) {
  const resourcesById = new Map(resources
    .filter((resource) => resource && resource.id)
    .map((resource) => [resource.id, resource]));
  const resourcesByContainerId = new Map(resources
    .filter((resource) => resource && resource.runtime && resource.runtime.containerId)
    .map((resource) => [resource.runtime.containerId, resource]));

  for (const [logicalResourceId, management] of managementByResourceId) {
    const sourceResource = resourcesById.get(logicalResourceId) || null;
    const candidateResource = management && management.candidateContainerId
      ? resourcesByContainerId.get(management.candidateContainerId) || null
      : null;
    const projectionResource = sourceResource || candidateResource;
    if (!projectionResource) continue;

    projectionResource.management = {
      ...management,
      logicalResourceId,
      sourceResourcePresent: Boolean(sourceResource),
      sourceProvider: sourceResource && sourceResource.provider || management.sourceProvider || null,
      sourceOwnership: sourceResource && sourceResource.ownership || management.sourceOwnership || null
    };
  }

  return resources;
}

function dockerName(container) {
  const name = container.Names && container.Names[0];
  return String(name || container.Id || 'container').replace(/^\//, '');
}

function providerFor(labels) {
  if (isTrue(labels['com.foxos.managed']) || isTrue(labels['com.foxos.core'])) {
    return 'foxos';
  }
  if (isTrue(labels['coolify.managed'])) {
    return 'coolify';
  }
  if (labels['com.docker.compose.project']) {
    return 'docker-compose';
  }
  return 'docker';
}

function parseTraefikRoutes(labels = {}) {
  const routes = [];
  const servicePorts = new Map();

  for (const [key, rawPort] of Object.entries(labels)) {
    const match = key.match(/^traefik\.http\.services\.([A-Za-z0-9_.-]+)\.loadbalancer\.server\.port$/);
    const port = Number.parseInt(String(rawPort), 10);
    if (match && Number.isInteger(port) && port >= 1 && port <= 65535) {
      servicePorts.set(match[1], port);
    }
  }

  for (const [key, rule] of Object.entries(labels)) {
    if (!key.startsWith('traefik.http.routers.') || !key.endsWith('.rule')) {
      continue;
    }

    const routerPrefix = key.slice(0, -'.rule'.length);
    const entrypoints = String(labels[routerPrefix + '.entrypoints'] || '');
    const tlsEnabled = isTrue(labels[routerPrefix + '.tls']);
    const secure = tlsEnabled || /(^|,)(https|websecure)(,|$)/.test(entrypoints) || key.includes('.https-');
    const serviceName = String(labels[routerPrefix + '.service'] || '').replace(/@docker$/, '');
    const privatePort = servicePorts.get(serviceName) || (servicePorts.size === 1
      ? Array.from(servicePorts.values())[0]
      : null);
    const paths = Array.from(String(rule).matchAll(/PathPrefix\([`"]([^`"]+)[`"]\)/g))
      .map((match) => match[1])
      .filter((value) => /^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*$/.test(value));

    for (const hostGroup of String(rule).matchAll(/Host\(([^)]+)\)/g)) {
      for (const hostMatch of hostGroup[1].matchAll(/[`"]([^`"]+)[`"]+/g)) {
        const domain = hostMatch[1].trim().toLowerCase();
        if (!/^[a-z0-9.-]+$/.test(domain)) {
          continue;
        }
        routes.push({
          domain,
          scheme: secure ? 'https' : 'http',
          path: redactRoutePath(paths[0] || '/'),
          tls: secure,
          ...(privatePort ? { privatePort } : {})
        });
      }
    }
  }

  return Array.from(
    new Map(routes.map((route) => [`${route.scheme}:${route.domain}:${route.path}`, route])).values()
  ).sort((left, right) => (
    left.domain.localeCompare(right.domain) || left.scheme.localeCompare(right.scheme) || left.path.localeCompare(right.path)
  ));
}

function redactRoutePath(routePath) {
  return String(routePath).split('/').map((segment) => {
    if (segment.length >= 24 && /^[a-zA-Z0-9_-]+$/.test(segment)) {
      return ':redacted-' + hash(segment, 10);
    }
    return segment;
  }).join('/');
}

function parseDockerHttpHealthTarget(healthcheck, observedPorts = []) {
  const test = healthcheck && healthcheck.Test;
  if (!Array.isArray(test) || test.length < 2 || test[0] === 'NONE') return null;
  const command = test.slice(1).map(String).join(' ');
  if (
    /(?:^|\s)(?:-H|--header|-u|--user|--cookie|--proxy-user|--cert|--key)(?:\s|=)/i.test(command) ||
    /\b(?:authorization|cookie)\b/i.test(command)
  ) return null;
  const candidates = test.slice(1)
    .flatMap((entry) => String(entry).split(/\s+/))
    .map((entry) => entry.replace(/^["']+|["']+$/g, ''))
    .filter((entry) => /^https?:\/\//i.test(entry));
  const targets = new Map();
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (
      parsed.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase()) ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname.length > 256 || !/^\/[A-Za-z0-9._~%/-]*$/.test(parsed.pathname)
    ) continue;
    const privatePort = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
    if (
      !Number.isInteger(privatePort) || privatePort < 1 || privatePort > 65535 ||
      !observedPorts.some((port) => port.protocol === 'tcp' && port.privatePort === privatePort)
    ) continue;
    const target = {
      protocol: 'http',
      privatePort,
      path: parsed.pathname || '/',
      source: 'docker-http-healthcheck'
    };
    targets.set(`${target.privatePort}:${target.path}`, target);
  }
  return targets.size === 1 ? Array.from(targets.values())[0] : null;
}

function normalizePorts(container, details) {
  const ports = [];
  for (const port of container.Ports || []) {
    ports.push({
      privatePort: Number(port.PrivatePort),
      protocol: port.Type || 'tcp',
      hostIp: port.IP || null,
      hostPort: port.PublicPort ? Number(port.PublicPort) : null
    });
  }

  const bindings = details && details.HostConfig && details.HostConfig.PortBindings;
  for (const [privatePort, hostBindings] of Object.entries(bindings || {})) {
    const [number, protocol = 'tcp'] = privatePort.split('/');
    if (!hostBindings || !hostBindings.length) {
      ports.push({ privatePort: Number(number), protocol, hostIp: null, hostPort: null });
      continue;
    }
    for (const binding of hostBindings) {
      ports.push({
        privatePort: Number(number),
        protocol,
        hostIp: binding.HostIp || '0.0.0.0',
        hostPort: binding.HostPort ? Number(binding.HostPort) : null
      });
    }
  }

  return Array.from(
    new Map(ports
      .filter((port) => Number.isInteger(port.privatePort))
      .map((port) => [
        `${port.privatePort}/${port.protocol}:${port.hostIp || ''}:${port.hostPort || ''}`,
        port
      ])).values()
  ).sort((left, right) => (
    (left.hostPort || 0) - (right.hostPort || 0) || left.privatePort - right.privatePort
  ));
}

function normalizeMounts(container, details) {
  return (details && details.Mounts || container.Mounts || [])
    .map((mount) => compactObject({
      type: mount.Type || 'unknown',
      name: mount.Name || null,
      source: mount.Source || null,
      destination: mount.Destination || null,
      readOnly: mount.RW === false
    }))
    .sort((left, right) => String(left.destination || '').localeCompare(String(right.destination || '')));
}

function normalizeNetworks(container, details) {
  const networks = details && details.NetworkSettings && details.NetworkSettings.Networks ||
    container.NetworkSettings && container.NetworkSettings.Networks || {};

  return Object.entries(networks).map(([name, network]) => compactObject({
    name,
    ipAddress: network && network.IPAddress || null,
    gateway: network && network.Gateway || null
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function roleFor(labels, image, name, ports, routes) {
  const subtype = String(labels['coolify.service.subType'] || labels['coolify.type'] || '').toLowerCase();
  const identity = `${image} ${name} ${labels['coolify.service.subName'] || ''} ${labels['coolify.serviceName'] || ''}`.toLowerCase();

  if (isTrue(labels['com.foxos.gateway'])) return 'proxy';
  if (isTrue(labels['com.foxos.core'])) return 'core';
  if (isTrue(labels['com.foxos.stateful-shadow'])) return 'application';
  if (/(^|[/_.-])(traefik|caddy|nginx|haproxy)(:|[/_.-]|$)/.test(identity) || name === 'coolify-proxy') return 'proxy';
  if (subtype === 'database' || /(postgres|mysql|mariadb|mongo|redis|qdrant|clickhouse|cassandra|elasticsearch|opensearch|influxdb)/.test(identity)) return 'database';
  if (/(worker|runner|agent|sentinel|realtime)/.test(identity)) return 'worker';
  if (subtype === 'application' || routes.length || ports.some((port) => port.hostPort)) return 'application';
  return 'service';
}

function imageIsPinned(image) {
  return /@sha256:[a-f0-9]{64}$/i.test(String(image));
}

function adoptionBlockers(resource, inspectionFailed) {
  const blockers = [];
  const add = (code, severity, message) => blockers.push({ code, severity, message });

  if (resource.protected) {
    add('foxos-core-protected', 'blocking', 'FoxOS core resources cannot be adopted or detached.');
  }
  if (resource.provider !== 'foxos') {
    add('external-provider-authority', 'blocking', 'The current runtime is still authoritative outside FoxOS.');
  }
  if (inspectionFailed) {
    add('inspection-incomplete', 'blocking', 'Docker inspection did not return the complete resource state.');
  }
  if (resource.runtime.environmentVariableCount > 0 && resource.provider !== 'foxos') {
    add('environment-unclassified', 'blocking', 'Runtime environment values have not been classified into environment and encrypted secrets.');
  }
  if (resource.routes.length && resource.provider !== 'foxos') {
    add('route-provider-dependent', 'blocking', 'Routes still depend on provider-owned proxy configuration.');
  }
  if (resource.mounts.length) {
    add('persistence-unverified', 'blocking', 'Persistent data has no FoxOS backup and tested restore proof.');
  }
  if (['application', 'database'].includes(resource.role) && !resource.runtime.health.configured) {
    add('healthcheck-missing', 'warning', 'No container health check is configured.');
  }
  if (!imageIsPinned(resource.runtime.image)) {
    add('image-not-digest-pinned', 'warning', 'The image reference is not pinned to an immutable digest.');
  }
  if (!resource.runtime.restartPolicy || resource.runtime.restartPolicy === 'no') {
    add('restart-policy-not-resilient', 'warning', 'The resource has no resilient restart policy.');
  }
  if (resource.role === 'proxy' && resource.provider !== 'foxos') {
    add('provider-proxy-critical', 'blocking', 'This proxy carries routes for resources that have not been migrated.');
  }

  return blockers;
}

function identityAliases(container, labels) {
  const aliases = [];
  const name = dockerName(container);

  if (/-foxos-rollback-[a-f0-9]{8,32}$/.test(name)) {
    return [`rollback-container:${container.Id || name}`];
  }
  if (/^foxos-deployment-lab-(?:candidate|rollback|rolled-forward)-[a-f0-9]{8,32}$/.test(name)) {
    return [`deployment-history-container:${container.Id || name}`];
  }
  if (/^foxos-compose-lab-(?:candidate|rollback|rolled-forward)-[a-f0-9]{8,32}-[a-z][a-z0-9-]{0,31}$/.test(name)) {
    return [`compose-deployment-history-container:${container.Id || name}`];
  }
  if (/^foxos-image-update-lab-(?:candidate|rollback|rolled-forward)-[a-f0-9]{8,32}$/.test(name)) {
    return [`image-update-history-container:${container.Id || name}`];
  }

  const foxosId = labels['com.foxos.resource.id'];
  const composeProject = labels['com.docker.compose.project'];
  const composeService = labels['com.docker.compose.service'];
  const composeNumber = labels['com.docker.compose.container-number'] || '1';
  const coolifyResource = labels['coolify.resourceName'];
  const coolifyService = labels['coolify.serviceName'] || labels['coolify.service.subName'];

  if (foxosId && /^res_[a-f0-9]{32}$/.test(foxosId) && (
    isTrue(labels['com.foxos.managed']) || isTrue(labels['com.foxos.core'])
  )) aliases.push(`foxos:${foxosId}`);
  if (composeProject && composeService) aliases.push(`compose:${composeProject}:${composeService}:${composeNumber}`);
  if (coolifyResource) aliases.push(`coolify-resource:${coolifyResource}:${coolifyService || ''}:${name}`);
  aliases.push(`container-name:${name}`);
  if (container.Id) aliases.push(`docker-container:${container.Id}`);
  return Array.from(new Set(aliases));
}

function resolveResourceId(identityState, aliases, observedAt, randomUUID) {
  const aliasHashes = aliases.map((alias) => hash(alias, 64));
  const claimedFoxosId = aliases.map((alias) => alias.match(/^foxos:(res_[a-f0-9]{32})$/))
    .find(Boolean);
  const existing = aliasHashes.map((aliasHash) => identityState.aliases[aliasHash])
    .find((candidate) => candidate && candidate.resourceId);
  const resourceId = claimedFoxosId
    ? claimedFoxosId[1]
    : existing ? existing.resourceId : 'res_' + randomUUID().replace(/-/g, '');

  for (const aliasHash of aliasHashes) {
    const record = identityState.aliases[aliasHash];
    identityState.aliases[aliasHash] = {
      resourceId,
      firstSeenAt: record && record.firstSeenAt || observedAt,
      lastSeenAt: observedAt
    };
  }
  return resourceId;
}

function normalizeResource(container, details, resourceId, inspectionFailed) {
  const labels = details && details.Config && details.Config.Labels || container.Labels || {};
  const ports = normalizePorts(container, details);
  const routes = parseTraefikRoutes(labels);
  const mounts = normalizeMounts(container, details);
  const networks = normalizeNetworks(container, details);
  const image = container.Image || details && details.Config && details.Config.Image || 'unknown';
  const provider = providerFor(labels);
  const healthConfig = details && details.Config && details.Config.Healthcheck;
  const healthState = details && details.State && details.State.Health;
  const httpHealthTarget = parseDockerHttpHealthTarget(healthConfig, ports);

  const resource = {
    schemaVersion: SCHEMA_VERSION,
    id: resourceId,
    kind: 'container',
    name: dockerName(container),
    role: roleFor(labels, image, dockerName(container), ports, routes),
    ownership: provider === 'foxos' ? 'foxos-managed' : 'observed',
    provider,
    protected: isTrue(labels['com.foxos.core']),
    provenance: {
      imported: false,
      safeLabels: safeLabels(labels),
      project: labels['coolify.projectName'] || labels['com.docker.compose.project'] || null,
      service: labels['coolify.serviceName'] || labels['coolify.service.subName'] || labels['com.docker.compose.service'] || null
    },
    runtime: {
      engine: 'docker',
      containerId: container.Id || null,
      image,
      imageId: container.ImageID || details && details.Image || null,
      state: container.State || details && details.State && details.State.Status || 'unknown',
      status: container.Status || null,
      restartPolicy: details && details.HostConfig && details.HostConfig.RestartPolicy && details.HostConfig.RestartPolicy.Name || 'no',
      health: {
        configured: Boolean(healthConfig && Array.isArray(healthConfig.Test) && healthConfig.Test.length),
        status: healthState && healthState.Status || null,
        httpTarget: httpHealthTarget
      },
      constraints: {
        user: details && details.Config && details.Config.User || null,
        privileged: Boolean(details && details.HostConfig && details.HostConfig.Privileged),
        readOnlyRootFilesystem: Boolean(details && details.HostConfig && details.HostConfig.ReadonlyRootfs),
        noNewPrivileges: Boolean(
          details && details.HostConfig && Array.isArray(details.HostConfig.SecurityOpt) &&
          details.HostConfig.SecurityOpt.includes('no-new-privileges:true')
        ),
        allCapabilitiesDropped: Boolean(
          details && details.HostConfig && Array.isArray(details.HostConfig.CapDrop) &&
          details.HostConfig.CapDrop.includes('ALL')
        ),
        memoryBytes: details && details.HostConfig && Number(details.HostConfig.Memory) || null,
        nanoCpus: details && details.HostConfig && Number(details.HostConfig.NanoCpus) || null,
        pidsLimit: details && details.HostConfig && Number(details.HostConfig.PidsLimit) || null
      },
      environmentVariableCount: details && details.Config && Array.isArray(details.Config.Env)
        ? details.Config.Env.length
        : null,
      inspection: inspectionFailed ? 'partial' : 'complete'
    },
    ports,
    routes,
    mounts,
    networks,
    adoption: null
  };

  const blockers = adoptionBlockers(resource, inspectionFailed);
  resource.adoption = {
    stage: resource.ownership,
    eligible: !resource.protected,
    ready: blockers.every((blocker) => blocker.severity !== 'blocking'),
    blockers
  };
  resource.classification = classifyResource(resource);
  return resource;
}

function observationAliases(observation) {
  const provider = String(observation.provider || 'unknown');
  const externalId = String(observation.externalId || '');
  if (!externalId || externalId.length > 256) return [];
  return [`${observation.sourceKind || 'external-observation'}:${provider}:${externalId}`];
}

function declaredRoutes(observation) {
  return (observation.routes || []).map((value) => {
    try {
      const parsed = new URL(value);
      return {
        domain: parsed.hostname.toLowerCase(),
        scheme: parsed.protocol.slice(0, -1),
        path: redactRoutePath(parsed.pathname || '/'),
        tls: parsed.protocol === 'https:'
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function providerRecoveryArtifact(observation) {
  const artifact = observation && observation.recoveryArtifact;
  if (
    !artifact || artifact.schemaVersion !== 1 ||
    !/^pdef_[a-f0-9]{32}$/.test(String(artifact.artifactId || '')) ||
    !/^pdef_rev_[a-f0-9]{32}$/.test(String(artifact.revision || '')) ||
    !/^provider-definitions\/recovery\/pdef_[a-f0-9]{32}-pdef_rev_[a-f0-9]{32}\.foxosenc$/.test(String(artifact.file || '')) ||
    !/^key_[a-f0-9]{24}$/.test(String(artifact.keyId || '')) ||
    artifact.encrypted !== true || artifact.authenticated !== true ||
    artifact.plaintextSecretValuesIncluded !== false
  ) return null;
  return {
    schemaVersion: 1,
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    file: artifact.file,
    encrypted: true,
    authenticated: true,
    keyId: artifact.keyId,
    plaintextSecretValuesIncluded: false
  };
}

function statusState(value) {
  const status = String(value || '').toLowerCase();
  if (status.startsWith('running') || status.startsWith('active')) return 'running';
  if (status.startsWith('exited') || status.startsWith('stopped') || status.startsWith('inactive')) return 'stopped';
  return 'defined';
}

function normalizeObservedResource(observation, resourceId) {
  const providerDefinition = observation.sourceKind === 'provider-definition';
  const providerKind = observation.providerKind || 'service';
  const runtimeObservation = observation.runtime || {};
  const state = providerDefinition ? statusState(observation.status) : runtimeObservation.state || 'unknown';
  const resource = {
    schemaVersion: SCHEMA_VERSION,
    id: resourceId,
    kind: observation.sourceKind,
    name: String(observation.name || observation.serviceType || 'Observed resource').slice(0, 256),
    role: providerKind === 'database' ? 'database' : providerKind,
    ownership: 'observed',
    provider: observation.provider || 'linux-host',
    protected: false,
    provenance: {
      imported: false,
      safeLabels: {},
      project: null,
      service: observation.serviceType || null,
      externalDefinition: providerDefinition ? {
        providerKind,
        serviceType: observation.serviceType || null,
        source: observation.source || null,
        declaredRoutes: declaredRoutes(observation),
        observedUpdatedAt: observation.observedUpdatedAt || null,
        runtimePresent: false,
        recoveryArtifact: providerRecoveryArtifact(observation)
      } : null,
      hostConfiguration: !providerDefinition ? observation.configuration || null : null
    },
    runtime: providerDefinition ? {
      engine: 'provider-definition',
      containerId: null,
      image: observation.image || null,
      imageId: null,
      state,
      status: observation.status || null,
      restartPolicy: null,
      health: {
        configured: false,
        status: String(observation.status || '').includes(':')
          ? String(observation.status).split(':').slice(1).join(':')
          : null,
        httpTarget: null
      },
      constraints: {},
      environmentVariableCount: null,
      inspection: 'definition-only'
    } : {
      engine: 'systemd',
      containerId: null,
      image: null,
      imageId: null,
      state,
      status: runtimeObservation.status || null,
      unit: runtimeObservation.unit || null,
      activeState: runtimeObservation.activeState || null,
      subState: runtimeObservation.subState || null,
      unitFileState: runtimeObservation.unitFileState || null,
      version: runtimeObservation.version || null,
      restartPolicy: runtimeObservation.unitFileState || null,
      health: { configured: false, status: runtimeObservation.activeState || null, httpTarget: null },
      constraints: {},
      environmentVariableCount: null,
      inspection: runtimeObservation.inspection || 'complete'
    },
    ports: [],
    routes: [],
    declaredRoutes: providerDefinition ? declaredRoutes(observation) : [],
    mounts: [],
    networks: [],
    adoption: {
      stage: 'observed',
      eligible: false,
      ready: false,
      blockers: [{
        code: providerDefinition ? 'provider-definition-runtime-missing' : 'host-service-manifest-missing',
        severity: 'blocking',
        message: providerDefinition
          ? 'The provider definition has no current Docker runtime to inspect.'
          : 'The host service has no provider-neutral FoxOS manifest and recovery proof.'
      }]
    }
  };
  resource.classification = classifyResource(resource);
  return resource;
}

function providerDefinitionMatches(resource, observation) {
  if (!resource || resource.kind !== 'container' || resource.provider !== observation.provider) return false;
  const externalId = String(observation.externalId || '');
  if (!externalId) return false;
  const labels = resource.provenance && resource.provenance.safeLabels || {};
  return [resource.name, ...Object.values(labels)].some((value) => String(value || '').includes(externalId));
}

async function readOptionalObservation(reader, source) {
  if (typeof reader !== 'function') {
    return { source, configured: false, readOnly: true, resources: [], status: 'disabled' };
  }
  try {
    const result = await reader();
    return {
      ...result,
      source: result && (result.source || result.provider) || source,
      resources: Array.isArray(result && result.resources) ? result.resources : [],
      status: result && result.configured === false ? 'disabled' : 'ready'
    };
  } catch (error) {
    return {
      source,
      configured: true,
      readOnly: true,
      resources: [],
      status: 'error',
      errorCode: String(error && error.code || `${source}-unavailable`).slice(0, 128)
    };
  }
}

function declaredRouteUrl(route) {
  if (!route || !['http', 'https'].includes(route.scheme) || !route.domain) return null;
  const pathValue = route.path && String(route.path).startsWith('/') ? route.path : '/';
  try {
    const parsed = new URL(`${route.scheme}://${route.domain}${pathValue}`);
    if (parsed.username || parsed.password || parsed.hostname.toLowerCase() !== String(route.domain).toLowerCase()) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function rebuildProviderDefinition(resource) {
  if (
    !resource || resource.kind !== 'provider-definition' ||
    !/^res_[a-f0-9]{32}$/.test(String(resource.id || ''))
  ) return null;
  const external = resource.provenance && resource.provenance.externalDefinition || {};
  const recoveryArtifact = providerRecoveryArtifact({ recoveryArtifact: external.recoveryArtifact });
  if (!recoveryArtifact) return null;
  return normalizeObservedResource({
    sourceKind: 'provider-definition',
    provider: resource.provider,
    name: resource.name,
    providerKind: external.providerKind || resource.role || 'service',
    serviceType: external.serviceType || null,
    status: resource.runtime && resource.runtime.status || 'stopped',
    image: resource.runtime && resource.runtime.image || null,
    source: external.source || null,
    routes: (external.declaredRoutes || resource.declaredRoutes || []).map(declaredRouteUrl).filter(Boolean),
    observedUpdatedAt: external.observedUpdatedAt || null,
    recoveryArtifact
  }, resource.id);
}

function providerDefinitionsFromSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION || !Array.isArray(snapshot.resources)) return [];
  return snapshot.resources.map(rebuildProviderDefinition).filter(Boolean);
}

function readCachedProviderDefinitions(latestFile, revisionsRoot) {
  const candidates = [];
  try {
    const latest = readJson(latestFile, null);
    if (latest) candidates.push(latest);
  } catch {
    // A corrupt latest snapshot must not prevent using an older valid revision.
  }
  try {
    const revisions = fs.readdirSync(revisionsRoot).filter((file) => file.endsWith('.json')).sort().reverse();
    for (const revision of revisions) {
      try {
        candidates.push(readJson(path.join(revisionsRoot, revision), null));
      } catch {
        // Keep looking for the newest intact provider-definition revision.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const snapshot of candidates) {
    const definitions = providerDefinitionsFromSnapshot(snapshot);
    if (definitions.length) return definitions;
  }
  return [];
}

function readAdoptedProviderDefinitions(dataRoot) {
  const resources = [];
  for (const operation of listJson(path.join(dataRoot, 'runtime-transfers', 'operations'))) {
    if (
      operation.status !== 'server-definition-adopted' ||
      !/^rtop_[a-f0-9]{32}$/.test(String(operation.operationId || ''))
    ) continue;
    for (const manifest of Array.isArray(operation.manifests) ? operation.manifests : []) {
      if (
        !manifest || manifest.kind !== 'inactive-provider-definition' ||
        !/^res_[a-f0-9]{32}$/.test(String(manifest.resourceId || ''))
      ) continue;
      const recoveryArtifact = providerRecoveryArtifact({ recoveryArtifact: manifest.recoveryArtifact });
      const provider = manifest.provenance && manifest.provenance.importedFrom;
      if (!recoveryArtifact || !provider) continue;
      resources.push(normalizeObservedResource({
        sourceKind: 'provider-definition',
        provider,
        name: manifest.name,
        providerKind: manifest.role || 'service',
        serviceType: manifest.serviceType || null,
        status: manifest.observedStatus || 'stopped',
        source: manifest.source || null,
        routes: (manifest.declaredRoutes || []).map(declaredRouteUrl).filter(Boolean),
        recoveryArtifact
      }, manifest.resourceId));
    }
  }
  return resources;
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function detectConflicts(resources) {
  const conflicts = [];
  const addGroupedConflicts = (type, severity, groups) => {
    for (const [value, resourceIds] of groups.entries()) {
      const uniqueIds = Array.from(new Set(resourceIds)).sort();
      if (uniqueIds.length > 1) {
        conflicts.push({ type, severity, value, resourceIds: uniqueIds });
      }
    }
  };

  const hostPorts = new Map();
  const domains = new Map();
  const volumes = new Map();
  for (const resource of resources) {
    const preservedRollback = /-foxos-rollback-[a-f0-9]{8,32}$/.test(resource.name);
    if (!preservedRollback) {
      for (const port of resource.ports.filter((candidate) => candidate.hostPort)) {
        const key = `${port.hostIp || '0.0.0.0'}:${port.hostPort}/${port.protocol}`;
        hostPorts.set(key, [...(hostPorts.get(key) || []), resource.id]);
      }
    }
    for (const route of resource.routes) {
      const key = `${route.domain}${route.path}`;
      domains.set(key, [...(domains.get(key) || []), resource.id]);
    }
    for (const mount of resource.mounts.filter((candidate) => candidate.type === 'volume' && candidate.name)) {
      volumes.set(mount.name, [...(volumes.get(mount.name) || []), resource.id]);
    }
  }

  addGroupedConflicts('host-port', 'blocking', hostPorts);
  addGroupedConflicts('domain-route', 'blocking', domains);
  addGroupedConflicts('shared-volume', 'warning', volumes);
  return conflicts.sort((left, right) => left.type.localeCompare(right.type) || left.value.localeCompare(right.value));
}

function buildRelationships(resources) {
  const relationships = [];
  const networkGroups = new Map();
  const volumeGroups = new Map();
  const projectGroups = new Map();

  for (const resource of resources) {
    for (const network of resource.networks) {
      networkGroups.set(network.name, [...(networkGroups.get(network.name) || []), resource.id]);
    }
    for (const mount of resource.mounts.filter((candidate) => candidate.type === 'volume' && candidate.name)) {
      volumeGroups.set(mount.name, [...(volumeGroups.get(mount.name) || []), resource.id]);
    }
    if (resource.provenance.project) {
      const key = `${resource.provider}:${resource.provenance.project}`;
      projectGroups.set(key, [...(projectGroups.get(key) || []), resource.id]);
    }
  }

  const addGroups = (type, groups) => {
    for (const [value, ids] of groups.entries()) {
      const resourceIds = Array.from(new Set(ids)).sort();
      if (resourceIds.length > 1) {
        relationships.push({
          id: 'rel_' + hash(`${type}:${value}:${resourceIds.join(':')}`),
          type,
          value,
          resourceIds
        });
      }
    }
  };

  addGroups('shared-network', networkGroups);
  addGroups('shared-volume', volumeGroups);
  addGroups('provider-project', projectGroups);

  const proxies = resources.filter((resource) => resource.role === 'proxy');
  for (const resource of resources.filter((candidate) => candidate.routes.length && candidate.role !== 'proxy')) {
    const resourceNetworks = new Set(resource.networks.map((network) => network.name));
    for (const proxy of proxies) {
      const sharedNetworks = proxy.networks
        .map((network) => network.name)
        .filter((name) => resourceNetworks.has(name));
      if (proxy.provider === resource.provider && sharedNetworks.length) {
        relationships.push({
          id: 'rel_' + hash(`route-proxy:${resource.id}:${proxy.id}:${sharedNetworks.join(':')}`),
          type: 'route-through-proxy',
          sourceResourceId: resource.id,
          targetResourceId: proxy.id,
          viaNetworks: sharedNetworks.sort()
        });
      }
    }
  }

  return relationships.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeInventory(images, networks, volumes, resources) {
  const imageUsers = new Map();
  const networkUsers = new Map();
  const volumeUsers = new Map();
  for (const resource of resources) {
    const imageKeys = [resource.runtime.image, resource.runtime.imageId].filter(Boolean);
    for (const key of imageKeys) imageUsers.set(key, [...(imageUsers.get(key) || []), resource.id]);
    for (const network of resource.networks) networkUsers.set(network.name, [...(networkUsers.get(network.name) || []), resource.id]);
    for (const mount of resource.mounts.filter((candidate) => candidate.type === 'volume' && candidate.name)) {
      volumeUsers.set(mount.name, [...(volumeUsers.get(mount.name) || []), resource.id]);
    }
  }

  return {
    images: (images || []).map((image) => {
      const tags = (image.RepoTags || []).filter((tag) => tag !== '<none>:<none>').sort();
      const digests = (image.RepoDigests || []).filter((digest) => digest !== '<none>@<none>').sort();
      const users = new Set([...(imageUsers.get(image.Id) || [])]);
      for (const tag of tags) for (const user of imageUsers.get(tag) || []) users.add(user);
      return {
        id: 'img_' + hash(image.Id || tags[0] || digests[0] || JSON.stringify(image)),
        tags,
        digests,
        size: Number(image.Size) || 0,
        created: Number(image.Created) || null,
        usedBy: Array.from(users).sort()
      };
    }).sort((left, right) => left.id.localeCompare(right.id)),
    networks: (networks || []).map((network) => ({
      id: 'net_' + hash(network.Name || network.Id),
      name: network.Name || null,
      driver: network.Driver || null,
      scope: network.Scope || null,
      internal: Boolean(network.Internal),
      attachable: Boolean(network.Attachable),
      ingress: Boolean(network.Ingress),
      safeLabels: safeLabels(network.Labels || {}),
      usedBy: Array.from(new Set(networkUsers.get(network.Name) || [])).sort()
    })).sort((left, right) => String(left.name).localeCompare(String(right.name))),
    volumes: (volumes || []).map((volume) => ({
      id: 'vol_' + hash(volume.Name),
      name: volume.Name,
      driver: volume.Driver || null,
      scope: volume.Scope || null,
      mountpoint: volume.Mountpoint || null,
      safeLabels: safeLabels(volume.Labels || {}),
      usedBy: Array.from(new Set(volumeUsers.get(volume.Name) || [])).sort()
    })).sort((left, right) => left.name.localeCompare(right.name))
  };
}

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function createResourceRegistry({
  dataRoot,
  dockerRequest,
  hostResourceReader = null,
  providerResourceReader = null,
  volumeCapacityReader = null,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (!dataRoot || typeof dockerRequest !== 'function') {
    throw new Error('Resource registry requires a data root and Docker request function');
  }

  const registryRoot = path.join(dataRoot, 'registry');
  const identitiesFile = path.join(registryRoot, 'identities.json');
  const latestFile = path.join(registryRoot, 'latest.json');
  const revisionsRoot = path.join(registryRoot, 'revisions');
  let scanInFlight = null;

  function pruneRevisions() {
    const revisions = fs.readdirSync(revisionsRoot)
      .filter((file) => file.endsWith('.json'))
      .sort();
    for (const revision of revisions.slice(0, Math.max(0, revisions.length - MAX_REVISIONS))) {
      fs.unlinkSync(path.join(revisionsRoot, revision));
    }
  }

  function getLatest() {
    const snapshot = readJson(latestFile, null);
    if (!snapshot) return null;
    if (snapshot.schemaVersion !== SCHEMA_VERSION) {
      throw new Error('Unsupported resource registry schema version');
    }
    return snapshot;
  }

  async function scanInternal() {
    const observedAt = new Date(clock()).toISOString();
    const [containers, images, networks, volumePayload, hostObservation, providerObservation] = await Promise.all([
      dockerRequest('GET', '/containers/json?all=1'),
      dockerRequest('GET', '/images/json?all=0'),
      dockerRequest('GET', '/networks'),
      dockerRequest('GET', '/volumes'),
      readOptionalObservation(hostResourceReader, 'linux-host'),
      readOptionalObservation(providerResourceReader, 'legacy-provider')
    ]);

    const inspections = await mapLimit(containers || [], INSPECT_CONCURRENCY, async (container) => {
      try {
        return { details: await dockerRequest('GET', '/containers/' + container.Id + '/json'), failed: false };
      } catch {
        return { details: null, failed: true };
      }
    });

    const identityState = readJson(identitiesFile, { schemaVersion: SCHEMA_VERSION, aliases: {} });
    if (identityState.schemaVersion !== SCHEMA_VERSION || !identityState.aliases) {
      throw new Error('Unsupported resource identity schema version');
    }

    const resources = (containers || []).map((container, index) => {
      const inspection = inspections[index];
      const labels = inspection.details && inspection.details.Config && inspection.details.Config.Labels || container.Labels || {};
      const resourceId = resolveResourceId(
        identityState,
        identityAliases(container, labels),
        observedAt,
        randomUUID
      );
      return normalizeResource(container, inspection.details, resourceId, inspection.failed);
    });

    for (const observation of providerObservation.resources) {
      const matchingResources = resources.filter((resource) => providerDefinitionMatches(resource, observation));
      if (matchingResources.length) {
        const definition = {
          providerKind: observation.providerKind || null,
          serviceType: observation.serviceType || null,
          status: observation.status || null,
          source: observation.source || null,
          declaredRoutes: declaredRoutes(observation),
          observedUpdatedAt: observation.observedUpdatedAt || null,
          runtimePresent: true,
          recoveryArtifact: providerRecoveryArtifact(observation)
        };
        for (const resource of matchingResources) resource.provenance.externalDefinition = definition;
        continue;
      }
      const resourceId = resolveResourceId(
        identityState,
        observationAliases(observation),
        observedAt,
        randomUUID
      );
      resources.push(normalizeObservedResource(observation, resourceId));
    }

    for (const observation of hostObservation.resources) {
      const resourceId = resolveResourceId(
        identityState,
        observationAliases(observation),
        observedAt,
        randomUUID
      );
      resources.push(normalizeObservedResource(observation, resourceId));
    }

    const resourceIds = new Set(resources.map((resource) => resource.id));
    let retainedProviderDefinitions = 0;
    if (providerObservation.status !== 'ready') {
      for (const resource of readCachedProviderDefinitions(latestFile, revisionsRoot)) {
        if (resourceIds.has(resource.id)) continue;
        resources.push(resource);
        resourceIds.add(resource.id);
        retainedProviderDefinitions += 1;
      }
    }
    let recoveredAdoptedDefinitions = 0;
    for (const resource of readAdoptedProviderDefinitions(dataRoot)) {
      if (resourceIds.has(resource.id)) continue;
      resources.push(resource);
      resourceIds.add(resource.id);
      recoveredAdoptedDefinitions += 1;
    }

    const capacityCandidates = resources.filter((resource) => (
      resource.kind === 'container' && resource.classification &&
      resource.classification.workloadRole === 'application' &&
      resource.classification.stateClass === 'stateful' &&
      Array.isArray(resource.mounts) && resource.mounts.length >= 1 && resource.mounts.length <= 4 &&
      resource.mounts.every((mount) => (
        mount.type === 'volume' && mount.name && mount.destination && mount.readOnly !== true
      ))
    ));
    if (typeof volumeCapacityReader === 'function') {
      await mapLimit(capacityCandidates, 2, async (resource) => {
        try {
          const evidence = await volumeCapacityReader({
            volumes: resource.mounts.map((mount) => ({ name: mount.name }))
          });
          const blockerCode = evidence && evidence.supported !== true
            ? 'stateful-storage-layout-unsupported'
            : evidence && evidence.withinTransactionLimit !== true
              ? 'stateful-presync-required'
              : evidence && evidence.capacitySufficient !== true
                ? 'stateful-storage-capacity-insufficient'
                : null;
          resource.migrationStorage = {
            status: blockerCode ? 'blocked' : 'ready',
            blockerCode,
            totalBytes: Number(evidence && evidence.totalBytes) || 0,
            maximumTransactionBytes: Number(evidence && evidence.maximumTransactionBytes) || 0,
            withinTransactionLimit: evidence && evidence.withinTransactionLimit === true,
            capacitySufficient: evidence && evidence.capacitySufficient === true,
            inspectedReadOnly: true
          };
        } catch {
          resource.migrationStorage = {
            status: 'blocked',
            blockerCode: 'stateful-capacity-inspection-failed',
            totalBytes: null,
            maximumTransactionBytes: null,
            withinTransactionLimit: false,
            capacitySufficient: false,
            inspectedReadOnly: true
          };
        }
      });
    }

    resources.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const migrationManagement = readFoxosMigrationManagement(dataRoot, resources);
    attachFoxosMigrationManagement(resources, migrationManagement);

    const inventory = normalizeInventory(images, networks, volumePayload && volumePayload.Volumes || [], resources);
    const conflicts = detectConflicts(resources);
    const relationships = buildRelationships(resources);
    const snapshotCore = {
      resources,
      inventory,
      relationships,
      conflicts,
      discovery: {
        sources: [hostObservation, providerObservation].map((observation) => ({
          source: observation.source,
          configured: observation.configured !== false,
          readOnly: observation.readOnly !== false,
          status: observation.status,
          discoveredResources: observation.resources.length,
          errorCode: observation.errorCode || null,
          retainedResources: observation === providerObservation ? retainedProviderDefinitions : 0,
          recoveredServerOwnedResources: observation === providerObservation ? recoveredAdoptedDefinitions : 0
        })),
        hostInventory: hostObservation.inventory || null
      },
      summary: {
        resources: resources.length,
        byKind: countBy(resources, (resource) => resource.kind),
        byOwnership: countBy(resources, (resource) => resource.ownership),
        byProvider: countBy(resources, (resource) => resource.provider),
        byRole: countBy(resources, (resource) => resource.role),
        byWorkloadRole: countBy(resources, (resource) => resource.classification.workloadRole),
        byStateClass: countBy(resources, (resource) => resource.classification.stateClass),
        byAuthorityClass: countBy(resources, (resource) => resource.classification.authorityClass),
        statelessAuditCandidates: resources.filter((resource) => (
          resource.classification.independenceAudit.eligibleForReadOnlyAudit
        )).length,
        foxosMigrated: resources.filter((resource) => resource.management && resource.management.owner === 'foxos').length,
        adoptionReady: resources.filter((resource) => resource.adoption.ready).length,
        relationships: relationships.length,
        blockingConflicts: conflicts.filter((conflict) => conflict.severity === 'blocking').length
      }
    };
    const snapshotId = 'snap_' + hash(JSON.stringify(snapshotCore), 32);
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      snapshotId,
      generatedAt: observedAt,
      mode: 'read-only-observation',
      guarantees: {
        dockerRequests: 'GET-only',
        hostRequests: 'fixed-read-only-observation',
        optionalProviderRequests: 'GET-only-when-explicitly-configured',
        runtimeMutated: false,
        secretValuesIncluded: false,
        classificationSchemaVersion: RESOURCE_CLASSIFICATION_SCHEMA_VERSION,
        classificationMethod: 'deterministic-local-evidence',
        classificationDoesNotImplyOwnership: true,
        foxosManagementDerivedFromVerifiedLocalAuthority: true,
        offlineProviderDefinitionsRetainedFromRedactedServerState: true,
        adoptedProviderDefinitionsRecoverableWithoutProvider: true,
        statelessDoesNotProveApplicationDataFree: true,
        volumeCapacityInspectedReadOnly: typeof volumeCapacityReader === 'function'
      },
      ...snapshotCore
    };

    atomicWriteJson(identitiesFile, identityState);
    atomicWriteJson(latestFile, snapshot);
    const revisionName = observedAt.replace(/[:.]/g, '-') + '-' + snapshotId + '.json';
    atomicWriteJson(path.join(revisionsRoot, revisionName), snapshot);
    pruneRevisions();
    return snapshot;
  }

  function scan() {
    if (!scanInFlight) {
      scanInFlight = scanInternal().finally(() => {
        scanInFlight = null;
      });
    }
    return scanInFlight;
  }

  function exportLatest() {
    const snapshot = getLatest();
    if (!snapshot) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      exportType: 'foxos-resource-migration-plan',
      snapshotId: snapshot.snapshotId,
      generatedAt: snapshot.generatedAt,
      guarantees: snapshot.guarantees,
      summary: snapshot.summary,
      resources: snapshot.resources,
      inventory: snapshot.inventory,
      relationships: snapshot.relationships,
      conflicts: snapshot.conflicts
    };
  }

  function getMigrationManagement(resourceId) {
    if (!/^res_[a-f0-9]{32}$/.test(String(resourceId || ''))) return null;
    const snapshot = getLatest();
    const management = readFoxosMigrationManagement(dataRoot, snapshot && snapshot.resources || []).get(resourceId);
    if (!management) return null;
    const resource = snapshot && (snapshot.resources || []).find((entry) => entry.id === resourceId);
    return {
      ...management,
      sourceProvider: resource && resource.provider || management.sourceProvider || null,
      sourceOwnership: resource && resource.ownership || management.sourceOwnership || null
    };
  }

  return {
    exportLatest,
    getMigrationManagement,
    getLatest,
    paths: { identitiesFile, latestFile, registryRoot, revisionsRoot },
    scan
  };
}

module.exports = {
  SCHEMA_VERSION,
  attachFoxosMigrationManagement,
  atomicWriteJson,
  buildRelationships,
  createResourceRegistry,
  detectConflicts,
  identityAliases,
  normalizeObservedResource,
  observationAliases,
  parseDockerHttpHealthTarget,
  parseTraefikRoutes,
  readFoxosMigrationManagement,
  readAdoptedProviderDefinitions,
  readCachedProviderDefinitions,
  resolveResourceId,
  roleFor,
  safeLabels,
  statusState
};
