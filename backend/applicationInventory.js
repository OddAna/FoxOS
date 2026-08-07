const crypto = require('node:crypto');

const APPLICATION_INVENTORY_SCHEMA_VERSION = 2;

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

function managedExternalUrl(appStates, management, primaryDomain = null) {
  if (primaryDomain && /^[a-z0-9.-]+$/i.test(String(primaryDomain))) {
    return 'https://' + String(primaryDomain).toLowerCase();
  }
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

function applicationLogoUrl(app, applicationId, externalUrl) {
  const existing = app && app.logoUrl || null;
  const dynamicIcon = /^\/api\/apps\/[^/]+\/icon$/.test(String(existing || ''));
  if (existing && !dynamicIcon) return existing;
  if (!externalUrl) return existing;
  return '/api/apps/' + encodeURIComponent(applicationId) + '/icon';
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
  const canEditAccessLink = Boolean(canonicalResource && canManage);

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
    logoUrl: applicationLogoUrl(app, id, externalUrl),
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
      present: Boolean(containerId),
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
      checkUpdates: canManage,
      editCompose: canManage,
      editAccessLink: canEditAccessLink,
      editDomain: canEditAccessLink
    },
    desktopShortcutDefaultVisible: true,
    installation: {
      state: 'runtime-present',
      definitionType: 'application',
      sourceType: app.installationSource || 'docker'
    },
    management: management ? {
      state: management.state || 'attention-required',
      lifecycle: management.lifecycle || null,
      routeAuthorityActive: management.authorityActive === true
    } : null
  };
}

function definitionRoutes(resource) {
  const definition = resource && resource.provenance && resource.provenance.externalDefinition || {};
  return (definition.declaredRoutes || resource.declaredRoutes || []).map((route) => {
    if (!route || !route.domain || !['http', 'https'].includes(route.scheme)) return null;
    const path = route.path && route.path !== '/' ? route.path : '';
    return `${route.scheme}://${route.domain}${path}`;
  }).filter(Boolean);
}

function definitionApplicationProjection(resource) {
  const definition = resource.provenance && resource.provenance.externalDefinition || {};
  const management = resource.management && resource.management.owner === 'foxos'
    ? resource.management
    : null;
  const definitionType = definition.providerKind || resource.role || 'application';
  const category = {
    application: 'Web Apps',
    database: 'Databases',
    service: 'Services'
  }[definitionType] || 'Services';
  const status = resource.runtime && resource.runtime.status || 'Kurulu · çalışmıyor';

  return {
    schemaVersion: APPLICATION_INVENTORY_SCHEMA_VERSION,
    id: resource.id,
    resourceId: resource.id,
    name: resource.name || 'İsimsiz kurulum',
    instanceName: definition.serviceType || (definitionType === 'database' ? 'Veritabanı' : 'Deaktif kurulum'),
    publisher: 'Kurulum Kaydı',
    category,
    summary: 'Kurulu tanımı bulundu; çalışan örneği yok.',
    description: null,
    image: resource.runtime && resource.runtime.image || null,
    logoUrl: null,
    externalUrl: null,
    declaredUrls: definitionRoutes(resource),
    hostPort: null,
    bindAddress: null,
    authority: management ? 'server' : 'observed',
    managedByServer: Boolean(management),
    provenance: {
      source: management ? 'server' : resource.provider || 'provider-definition',
      importedFrom: management ? resource.provider || null : null
    },
    runtime: {
      present: false,
      containerId: null,
      containerName: null,
      state: 'stopped',
      status,
      healthStatus: null,
      exitCode: null,
      operationalState: 'stopped'
    },
    capabilities: {
      open: false,
      start: false,
      stop: false,
      restart: false,
      settings: true,
      checkUpdates: false,
      editCompose: false,
      editAccessLink: false,
      editDomain: false
    },
    desktopShortcutDefaultVisible: false,
    installation: {
      state: 'inactive-definition',
      definitionType,
      sourceType: definition.source && definition.source.type || 'provider-definition'
    },
    management: management ? {
      state: management.state || 'attention-required',
      lifecycle: management.lifecycle || null,
      routeAuthorityActive: management.authorityActive === true
    } : null
  };
}

function hostServiceOperationalState(resource) {
  const runtime = resource && resource.runtime || {};
  const state = String(runtime.state || '').toLowerCase();
  const activeState = String(runtime.activeState || '').toLowerCase();
  const subState = String(runtime.subState || '').toLowerCase();
  const status = String(runtime.status || '').toLowerCase();

  if (activeState === 'failed' || subState === 'failed' || status.includes('failed')) return 'error';
  if (state === 'running' || activeState === 'active') return 'running';
  if (['activating', 'deactivating', 'reloading'].includes(activeState)) return 'transitioning';
  return 'stopped';
}

function hostServiceApplicationProjection(resource) {
  const runtime = resource.runtime || {};
  const role = resource.role || 'service';
  const operationalState = hostServiceOperationalState(resource);

  return {
    schemaVersion: APPLICATION_INVENTORY_SCHEMA_VERSION,
    id: resource.id,
    resourceId: resource.id,
    name: resource.name || runtime.unit || 'Sunucu servisi',
    instanceName: runtime.unit || 'systemd servisi',
    publisher: 'Sunucu Servisi',
    category: ['network-service', 'proxy'].includes(role) ? 'Network' : 'Services',
    summary: 'Sunucuya doğrudan kurulu systemd servisi.',
    description: null,
    image: null,
    logoUrl: null,
    externalUrl: null,
    declaredUrls: [],
    hostPort: null,
    bindAddress: null,
    authority: 'server-owned',
    managedByServer: true,
    provenance: {
      source: resource.provider || 'linux-host',
      importedFrom: null
    },
    runtime: {
      present: true,
      engine: 'systemd',
      containerId: null,
      containerName: null,
      serviceUnit: runtime.unit || null,
      unitFileState: runtime.unitFileState || 'unknown',
      bootEnabled: ['enabled', 'enabled-runtime', 'linked', 'linked-runtime'].includes(
        String(runtime.unitFileState || '').toLowerCase()
      ),
      state: runtime.state || 'stopped',
      status: runtime.status || null,
      healthStatus: runtime.activeState || null,
      exitCode: null,
      operationalState
    },
    capabilities: {
      open: false,
      start: !['running', 'transitioning'].includes(operationalState),
      stop: operationalState === 'running',
      restart: operationalState === 'running',
      settings: true,
      editBootState: true,
      checkUpdates: false,
      editCompose: false,
      editAccessLink: false,
      editDomain: false
    },
    desktopShortcutDefaultVisible: false,
    installation: {
      state: 'host-service',
      definitionType: role,
      sourceType: 'systemd'
    },
    management: {
      owner: 'server',
      state: 'native-host-service',
      runtime: 'systemd'
    }
  };
}

function disambiguateDuplicateNames(applications) {
  const nameCounts = applications.reduce((counts, application) => {
    const key = String(application.name || '').trim().toLocaleLowerCase('tr');
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());

  const proposedSuffixCounts = applications.reduce((counts, application) => {
    const key = String(application.name || '').trim().toLocaleLowerCase('tr');
    if ((nameCounts.get(key) || 0) < 2) return counts;
    const suffix = application.instanceName || application.runtime.containerName;
    const proposed = suffix && !application.name.includes(suffix)
      ? `${application.name} · ${suffix}`
      : null;
    if (proposed) counts.set(proposed, (counts.get(proposed) || 0) + 1);
    return counts;
  }, new Map());
  const ordinals = new Map();

  return applications.map((application) => {
    const key = String(application.name || '').trim().toLocaleLowerCase('tr');
    if ((nameCounts.get(key) || 0) < 2) return application;
    const suffix = application.instanceName || application.runtime.containerName;
    const proposed = suffix && !application.name.includes(suffix)
      ? application.name + ' · ' + suffix
      : null;
    if (proposed && proposedSuffixCounts.get(proposed) === 1) {
      return { ...application, name: proposed };
    }
    const ordinal = (ordinals.get(key) || 0) + 1;
    ordinals.set(key, ordinal);
    return { ...application, name: `${application.name} · ${ordinal}` };
  });
}

function buildApplicationInventory({ appStates = [], containers = [], resources = [], domainPreferences = {} } = {}) {
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
    const logicalResourceId = management.logicalResourceId || sourceResource.id;
    const canonicalResource = logicalResourceId === sourceResource.id
      ? sourceResource
      : {
          ...sourceResource,
          id: logicalResourceId,
          provider: management.sourceProvider || sourceResource.provider,
          ownership: management.sourceOwnership || sourceResource.ownership
        };
    const externalUrl = managedExternalUrl(groupStates, management, domainPreferences[logicalResourceId]);

    applications.push(applicationProjection({
      app: metadata,
      canonicalResource,
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
    const preferredDomain = resource && domainPreferences[resource.id];
    applications.push(applicationProjection({
      app,
      canonicalResource: resource,
      runtimeResource: resource,
      container,
      externalUrl: preferredDomain ? 'https://' + preferredDomain : app.externalUrl || null,
      managedByServer
    }));
  }

  const managedDomains = new Set(applications
    .filter((application) => application.managedByServer)
    .flatMap((application) => {
      const domains = application.management && application.management.domains || [];
      const external = externalHostname(application.externalUrl);
      return [...domains, external].filter(Boolean).map((domain) => String(domain).toLowerCase());
    }));

  for (const resource of resources
    .filter((candidate) => candidate && candidate.kind === 'provider-definition')
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const declaredDomains = definitionRoutes(resource)
      .map(externalHostname)
      .filter(Boolean);
    if (declaredDomains.some((domain) => managedDomains.has(domain))) continue;
    applications.push(definitionApplicationProjection(resource));
  }

  for (const resource of resources
    .filter((candidate) => candidate && candidate.kind === 'host-service')
    .sort((left, right) => left.id.localeCompare(right.id))) {
    applications.push(hostServiceApplicationProjection(resource));
  }

  const uniqueApplications = Array.from(
    new Map(applications.map((application) => [application.id, application])).values()
  );
  return disambiguateDuplicateNames(uniqueApplications)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

module.exports = {
  APPLICATION_INVENTORY_SCHEMA_VERSION,
  applicationLogoUrl,
  buildApplicationInventory,
  canonicalApplicationName,
  definitionApplicationProjection,
  disambiguateDuplicateNames,
  exitCodeFromStatus,
  healthStatusFromRuntime,
  hostServiceApplicationProjection,
  hostServiceOperationalState,
  operationalStateForRuntime
};
