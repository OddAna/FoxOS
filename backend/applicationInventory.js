const crypto = require('node:crypto');

const APPLICATION_INVENTORY_SCHEMA_VERSION = 1;

function exitCodeFromStatus(status) {
  const match = String(status || '').match(/Exited \((-?\d+)\)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function healthStatusFromRuntime(container, resource) {
  const status = String(container && container.Status || '');
  const match = status.match(/\((healthy|unhealthy|health: starting)\)/i);
  if (match) {
    return match[1].toLowerCase() === 'health: starting' ? 'starting' : match[1].toLowerCase();
  }
  return resource && resource.runtime && resource.runtime.health
    ? resource.runtime.health.status || null
    : null;
}

function operationalStateForRuntime({ state, status, healthStatus }) {
  const normalizedState = String(state || 'unknown').toLowerCase();
  const normalizedHealth = String(healthStatus || '').toLowerCase();

  if (normalizedState === 'running') {
    if (normalizedHealth === 'unhealthy') return 'error';
    if (normalizedHealth === 'starting') return 'transitioning';
    return 'running';
  }
  if (normalizedState === 'created') return 'stopped';
  if (['restarting', 'paused', 'removing'].includes(normalizedState)) {
    return 'transitioning';
  }
  if (normalizedState === 'exited') {
    const exitCode = exitCodeFromStatus(status);
    return exitCode === null || [0, 137, 143].includes(exitCode) ? 'stopped' : 'error';
  }
  if (normalizedState === 'dead') return 'error';
  return 'transitioning';
}

function fallbackApplicationId(app) {
  const identity = [
    app.installationSource || 'docker',
    app.containerName || '',
    app.id || '',
    app.instanceName || ''
  ].join(':');
  return 'app_' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

function managedExternalUrl(appStates, management) {
  const domains = management && Array.isArray(management.domains) ? management.domains : [];
  const domain = domains.find((candidate) => /^[a-z0-9.-]+$/i.test(String(candidate || '')));
  if (domain) return 'https://' + String(domain).toLowerCase();
  return appStates.map((app) => app && app.externalUrl).find(Boolean) || null;
}

function externalHostname(externalUrl) {
  try {
    return new URL(String(externalUrl || '')).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isTemporaryHostname(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.sslip.io') || hostname.endsWith('.nip.io') ||
    hostname.endsWith('.invalid') || hostname.endsWith('.test');
}

function canonicalApplicationName(app, externalUrl) {
  const existingName = app.name || app.instanceName || app.containerName || 'Sunucu Uygulaması';
  if (app.profileId) return existingName;
  const hostname = externalHostname(externalUrl);
  return hostname && !isTemporaryHostname(hostname) ? hostname : existingName;
}

function preferredMetadata(appStates, candidateContainerId) {
  const candidate = appStates.find((app) => app.containerId === candidateContainerId) || null;
  const fallback = appStates.find((app) => app.logoUrl || app.externalUrl) || appStates[0] || {};
  return {
    ...fallback,
    ...candidate,
    logoUrl: candidate && candidate.logoUrl || fallback.logoUrl || null,
    externalUrl: candidate && candidate.externalUrl || fallback.externalUrl || null,
    summary: candidate && candidate.summary || fallback.summary || null,
    description: candidate && candidate.description || fallback.description || null
  };
}

function applicationProjection({
  app,
  canonicalResource,
  runtimeResource,
  container,
  externalUrl,
  managedByServer,
  management = null
}) {
  const containerId = container && container.Id || app.containerId || null;
  const state = container && container.State || app.state || 'unknown';
  const status = container && container.Status || app.status || null;
  const healthStatus = healthStatusFromRuntime(container, runtimeResource);
  const operationalState = operationalStateForRuntime({ state, status, healthStatus });
  const canManage = Boolean(app.canManage && containerId);
  const id = canonicalResource && canonicalResource.id || fallbackApplicationId(app);

  return {
    schemaVersion: APPLICATION_INVENTORY_SCHEMA_VERSION,
    id,
    resourceId: canonicalResource && canonicalResource.id || null,
    name: canonicalApplicationName(app, externalUrl),
    instanceName: app.instanceName || null,
    publisher: app.publisher || 'Sunucu',
    category: app.category || 'Web Apps',
    summary: app.summary || null,
    description: app.description || null,
    image: container && container.Image || app.image || null,
    logoUrl: app.logoUrl || null,
    externalUrl: externalUrl || null,
    hostPort: app.hostPort || null,
    bindAddress: app.bindAddress || null,
    authority: managedByServer ? 'server' : 'observed',
    managedByServer,
    provenance: {
      source: managedByServer ? 'server' : app.installationSource || 'docker',
      importedFrom: managedByServer && canonicalResource && canonicalResource.provider !== 'foxos'
        ? canonicalResource.provider
        : null
    },
    runtime: {
      containerId,
      containerName: container && container.Names && container.Names[0]
        ? String(container.Names[0]).replace(/^\//, '')
        : app.containerName || null,
      state,
      status,
      healthStatus,
      exitCode: exitCodeFromStatus(status),
      operationalState
    },
    capabilities: {
      open: Boolean(externalUrl || app.hostPort),
      start: canManage && !['running', 'restarting'].includes(String(state).toLowerCase()),
      stop: canManage && ['running', 'restarting'].includes(String(state).toLowerCase()),
      restart: canManage,
      settings: canManage,
      editDomain: Boolean(managedByServer && management && management.authorityActive)
    },
    management: management ? {
      state: management.state || 'attention-required',
      lifecycle: management.lifecycle || null,
      routeAuthorityActive: management.authorityActive === true
    } : null
  };
}

function disambiguateDuplicateNames(applications) {
  const nameCounts = applications.reduce((counts, application) => {
    const key = String(application.name || '').trim().toLocaleLowerCase('tr');
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());

  return applications.map((application) => {
    const key = String(application.name || '').trim().toLocaleLowerCase('tr');
    if ((nameCounts.get(key) || 0) < 2) return application;
    const suffix = application.instanceName || application.runtime.containerName;
    if (!suffix || application.name.includes(suffix)) return application;
    return { ...application, name: application.name + ' · ' + suffix };
  });
}

function buildApplicationInventory({ appStates = [], containers = [], resources = [] } = {}) {
  const installedApps = appStates.filter((app) => app && app.installed && app.containerId);
  const containerById = new Map(containers.filter(Boolean).map((container) => [container.Id, container]));
  const resourceByContainerId = new Map(resources
    .filter((resource) => resource && resource.runtime && resource.runtime.containerId)
    .map((resource) => [resource.runtime.containerId, resource]));
  const consumedContainerIds = new Set();
  const applications = [];

  for (const sourceResource of resources) {
    const management = sourceResource && sourceResource.management;
    const sourceContainerId = sourceResource && sourceResource.runtime && sourceResource.runtime.containerId;
    const candidateContainerId = management && management.candidateContainerId;
    if (
      !sourceContainerId || !candidateContainerId || !management || management.owner !== 'foxos'
    ) continue;

    const groupStates = installedApps.filter((app) => (
      app.containerId === sourceContainerId || app.containerId === candidateContainerId
    ));
    if (!groupStates.length) continue;

    const metadata = preferredMetadata(groupStates, candidateContainerId);
    const candidateContainer = containerById.get(candidateContainerId);
    const sourceContainer = containerById.get(sourceContainerId);
    const runtimeContainer = candidateContainer || sourceContainer || null;
    const runtimeResource = resourceByContainerId.get(runtimeContainer && runtimeContainer.Id) || sourceResource;
    const externalUrl = managedExternalUrl(groupStates, management);

    applications.push(applicationProjection({
      app: metadata,
      canonicalResource: sourceResource,
      runtimeResource,
      container: runtimeContainer,
      externalUrl,
      managedByServer: true,
      management
    }));
    consumedContainerIds.add(sourceContainerId);
    consumedContainerIds.add(candidateContainerId);
  }

  for (const app of installedApps) {
    if (consumedContainerIds.has(app.containerId)) continue;
    const resource = resourceByContainerId.get(app.containerId) || null;
    const container = containerById.get(app.containerId) || null;
    const managedByServer = Boolean(
      app.managedByFoxOS || resource && resource.ownership === 'foxos-managed'
    );
    applications.push(applicationProjection({
      app,
      canonicalResource: resource,
      runtimeResource: resource,
      container,
      externalUrl: app.externalUrl || null,
      managedByServer
    }));
  }

  const uniqueApplications = Array.from(
    new Map(applications.map((application) => [application.id, application])).values()
  );
  return disambiguateDuplicateNames(uniqueApplications)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

module.exports = {
  APPLICATION_INVENTORY_SCHEMA_VERSION,
  buildApplicationInventory,
  canonicalApplicationName,
  disambiguateDuplicateNames,
  exitCodeFromStatus,
  healthStatusFromRuntime,
  operationalStateForRuntime
};
