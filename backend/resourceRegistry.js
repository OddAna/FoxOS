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
        status: healthState && healthState.Status || null
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
    const [containers, images, networks, volumePayload] = await Promise.all([
      dockerRequest('GET', '/containers/json?all=1'),
      dockerRequest('GET', '/images/json?all=0'),
      dockerRequest('GET', '/networks'),
      dockerRequest('GET', '/volumes')
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
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

    const inventory = normalizeInventory(images, networks, volumePayload && volumePayload.Volumes || [], resources);
    const conflicts = detectConflicts(resources);
    const relationships = buildRelationships(resources);
    const snapshotCore = {
      resources,
      inventory,
      relationships,
      conflicts,
      summary: {
        resources: resources.length,
        byOwnership: countBy(resources, (resource) => resource.ownership),
        byProvider: countBy(resources, (resource) => resource.provider),
        byRole: countBy(resources, (resource) => resource.role),
        byWorkloadRole: countBy(resources, (resource) => resource.classification.workloadRole),
        byStateClass: countBy(resources, (resource) => resource.classification.stateClass),
        byAuthorityClass: countBy(resources, (resource) => resource.classification.authorityClass),
        statelessAuditCandidates: resources.filter((resource) => (
          resource.classification.independenceAudit.eligibleForReadOnlyAudit
        )).length,
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
        runtimeMutated: false,
        secretValuesIncluded: false,
        classificationSchemaVersion: RESOURCE_CLASSIFICATION_SCHEMA_VERSION,
        classificationMethod: 'deterministic-local-evidence',
        classificationDoesNotImplyOwnership: true,
        statelessDoesNotProveApplicationDataFree: true
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

  return {
    exportLatest,
    getLatest,
    paths: { identitiesFile, latestFile, registryRoot, revisionsRoot },
    scan
  };
}

module.exports = {
  SCHEMA_VERSION,
  atomicWriteJson,
  buildRelationships,
  createResourceRegistry,
  detectConflicts,
  identityAliases,
  parseTraefikRoutes,
  resolveResourceId,
  roleFor,
  safeLabels
};
