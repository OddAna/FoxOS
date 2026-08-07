const MANAGED_LABEL = 'com.foxos.managed';
const APP_ID_LABEL = 'com.foxos.app.id';
const DASHBOARD_ICON_BASE = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';

const DISCOVERED_APP_PROFILES = Object.freeze([
  Object.freeze({
    id: 'adguard-home',
    name: 'AdGuard Home',
    publisher: 'AdGuard Team',
    category: 'Network',
    containerPort: 80,
    logoUrl: DASHBOARD_ICON_BASE + 'adguard-home.svg',
    imageRepositories: Object.freeze(['adguard/adguardhome']),
    serviceNames: Object.freeze(['adguardhome']),
    description: 'Ağ genelinde reklam ve takip engelleme sağlayan DNS yönetim uygulaması.'
  }),
  Object.freeze({
    id: 'beszel',
    name: 'Beszel',
    publisher: 'Beszel',
    category: 'Monitoring',
    containerPort: 8090,
    logoUrl: DASHBOARD_ICON_BASE + 'beszel.svg',
    imageRepositories: Object.freeze(['henrygd/beszel']),
    serviceNames: Object.freeze(['beszel']),
    description: 'Sunucu kaynaklarını ve servis durumunu izleyen hafif yönetim paneli.'
  }),
  Object.freeze({
    id: 'coolify',
    name: 'Coolify',
    publisher: 'Coollabs',
    category: 'DevOps',
    containerPort: 8080,
    logoUrl: DASHBOARD_ICON_BASE + 'coolify.svg',
    imageRepositories: Object.freeze(['ghcr.io/coollabsio/coolify']),
    serviceNames: Object.freeze(['coolify']),
    description: 'Uygulamaları ve veritabanlarını kendi sunucunuzda dağıtmak için kullanılan platform.'
  }),
  Object.freeze({
    id: 'evolution-api',
    name: 'Evolution API',
    publisher: 'Evolution API',
    category: 'Developer',
    containerPort: 8080,
    openPath: '/manager',
    logoUrl: 'https://raw.githubusercontent.com/evolution-foundation/docs-evolution/main/favicon.png',
    imageRepositories: Object.freeze(['evoapicloud/evolution-api']),
    serviceNames: Object.freeze(['evolution-api']),
    description: 'WhatsApp bağlantıları ve otomasyonları için kendi sunucunuzda çalışan API.'
  }),
  Object.freeze({
    id: 'firefox',
    name: 'Firefox',
    publisher: 'Mozilla',
    category: 'Web Apps',
    containerPort: 5800,
    logoUrl: DASHBOARD_ICON_BASE + 'firefox.svg',
    imageRepositories: Object.freeze(['jlesage/firefox']),
    serviceNames: Object.freeze(['firefox']),
    description: 'Sunucuda çalışan ve tarayıcıdan erişilebilen Firefox masaüstü uygulaması.'
  }),
  Object.freeze({
    id: 'n8n',
    name: 'n8n',
    publisher: 'n8n',
    category: 'Automation',
    containerPort: 5678,
    logoUrl: DASHBOARD_ICON_BASE + 'n8n.svg',
    imageRepositories: Object.freeze(['n8nio/n8n']),
    serviceNames: Object.freeze(['n8n']),
    description: 'İş akışlarını görsel olarak oluşturup sunucunuzda çalıştırabileceğiniz otomasyon platformu.'
  }),
  Object.freeze({
    id: 'nocodb',
    name: 'NocoDB',
    publisher: 'NocoDB',
    category: 'Databases',
    containerPort: 8080,
    logoUrl: DASHBOARD_ICON_BASE + 'nocodb.svg',
    imageRepositories: Object.freeze(['nocodb/nocodb']),
    serviceNames: Object.freeze(['nocodb']),
    description: 'Veritabanlarını elektronik tablo benzeri bir arayüzle yöneten açık kaynaklı platform.'
  }),
  Object.freeze({
    id: 'open-webui',
    name: 'Open WebUI',
    publisher: 'Open WebUI',
    category: 'AI',
    containerPort: 8080,
    logoUrl: DASHBOARD_ICON_BASE + 'open-webui.svg',
    imageRepositories: Object.freeze(['ghcr.io/open-webui/open-webui']),
    serviceNames: Object.freeze(['open-webui']),
    description: 'Yerel ve uzak yapay zekâ modelleri için kendi sunucunuzda çalışan web arayüzü.'
  }),
  Object.freeze({
    id: 'qdrant',
    name: 'Qdrant',
    publisher: 'Qdrant',
    category: 'Databases',
    containerPort: 6333,
    openPath: '/dashboard',
    logoUrl: DASHBOARD_ICON_BASE + 'qdrant.svg',
    imageRepositories: Object.freeze(['qdrant/qdrant']),
    serviceNames: Object.freeze(['qdrant']),
    description: 'Vektör arama ve yapay zekâ uygulamaları için açık kaynaklı veritabanı.'
  }),
  Object.freeze({
    id: 'wordpress',
    name: 'WordPress',
    publisher: 'WordPress.org',
    category: 'Web Apps',
    containerPort: 80,
    logoUrl: DASHBOARD_ICON_BASE + 'wordpress.svg',
    imageRepositories: Object.freeze(['wordpress']),
    serviceNames: Object.freeze(['wordpress']),
    description: 'Web siteleri ve içerik yönetimi için açık kaynaklı yayın platformu.'
  })
]);

const DISCOVERY_EXCLUDED_NAMES = new Set([
  'coolify-db',
  'coolify-proxy',
  'coolify-realtime',
  'coolify-redis',
  'coolify-sentinel'
]);

function containerName(appId) {
  return appId;
}

function validateInstallOptions(catalogApp, input = {}) {
  const rawPort = input.hostPort === undefined || input.hostPort === ''
    ? String(catalogApp.defaultPort)
    : String(input.hostPort);

  if (!/^\d+$/.test(rawPort)) {
    throw new Error('Port must be a whole number');
  }

  const hostPort = Number(rawPort);
  if (!Number.isSafeInteger(hostPort) || hostPort < 1024 || hostPort > 65535) {
    throw new Error('Port must be between 1024 and 65535');
  }

  const bindAddress = input.bindAddress || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(bindAddress)) {
    throw new Error('Bind address must be private or public');
  }

  return { hostPort, bindAddress };
}

function createContainerPayload(catalogApp, options) {
  const privatePort = catalogApp.containerPort + '/tcp';
  const binds = [
    ...(catalogApp.volumes || []).map((volume) => volume.name + ':' + volume.target),
    ...(catalogApp.binds || [])
  ];

  return {
    Image: catalogApp.image,
    Labels: {
      [MANAGED_LABEL]: 'true',
      [APP_ID_LABEL]: catalogApp.id,
      'com.foxos.app.name': catalogApp.name
    },
    Env: [...(catalogApp.environment || [])],
    ExposedPorts: { [privatePort]: {} },
    HostConfig: {
      Binds: binds,
      PortBindings: {
        [privatePort]: [{
          HostIp: options.bindAddress,
          HostPort: String(options.hostPort)
        }]
      },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }
    }
  };
}

function managedContainerForApp(containers, appId) {
  return containers.find((container) => (
    container.Labels &&
    container.Labels[MANAGED_LABEL] === 'true' &&
    container.Labels[APP_ID_LABEL] === appId
  )) || null;
}

function normalizedImageRepository(image = '') {
  const withoutDigest = String(image).trim().toLowerCase().split('@')[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

function containerDisplayName(container) {
  const labels = container.Labels || {};
  const name = labels['coolify.service.subName'] || labels['coolify.serviceName'] || labels['coolify.name'] ||
    (container.Names && container.Names[0]) || container.Id.slice(0, 12);
  return String(name).replace(/^\//, '');
}

function dockerContainerName(container) {
  const name = container.Names && container.Names[0];
  return name ? String(name).replace(/^\//, '') : containerDisplayName(container);
}

function catalogContainerForApp(containers, catalogApp) {
  const managed = managedContainerForApp(containers, catalogApp.id);
  if (managed) {
    return managed;
  }

  const repositories = new Set([
    normalizedImageRepository(catalogApp.image),
    ...(catalogApp.imageAliases || []).map(normalizedImageRepository)
  ]);

  return containers.find((container) => (
    (!container.Labels || container.Labels['com.foxos.stateful-shadow'] !== 'true') &&
    repositories.has(normalizedImageRepository(container.Image))
  )) || null;
}

function externalUrlForContainer(container) {
  const labels = container.Labels || {};
  const candidates = [];

  for (const [key, rule] of Object.entries(labels)) {
    if (!key.startsWith('traefik.http.routers.') || !key.endsWith('.rule')) {
      continue;
    }

    const routerKey = key.slice(0, -'.rule'.length);
    const entrypoints = labels[routerKey + '.entrypoints'] || '';
    const secure = key.includes('.https-') || /(^|,)(https|websecure)(,|$)/.test(entrypoints);
    const hostGroups = String(rule).matchAll(/Host\(([^)]+)\)/g);

    for (const hostGroup of hostGroups) {
      for (const hostMatch of hostGroup[1].matchAll(/[`"]([^`"]+)[`"]+/g)) {
        const hostname = hostMatch[1].trim().toLowerCase();
        if (/^[a-z0-9.-]+$/.test(hostname)) {
          candidates.push({ hostname, secure });
        }
      }
    }
  }

  candidates.sort((left, right) => {
    if (left.secure !== right.secure) return left.secure ? -1 : 1;
    const leftTemporary = left.hostname.endsWith('.sslip.io');
    const rightTemporary = right.hostname.endsWith('.sslip.io');
    if (leftTemporary !== rightTemporary) return leftTemporary ? 1 : -1;
    const leftWww = left.hostname.startsWith('www.');
    const rightWww = right.hostname.startsWith('www.');
    if (leftWww !== rightWww) return leftWww ? 1 : -1;
    return left.hostname.localeCompare(right.hostname);
  });

  if (!candidates.length) {
    return null;
  }

  return (candidates[0].secure ? 'https://' : 'http://') + candidates[0].hostname;
}

function publishedPortForContainer(container, preferredPrivatePort = null) {
  const ports = (container.Ports || []).filter((port) => port.Type === 'tcp' && port.PublicPort);
  return ports.find((port) => preferredPrivatePort && port.PrivatePort === preferredPrivatePort) || ports[0] || null;
}

function discoveredProfileForContainer(container) {
  const labels = container.Labels || {};
  const repository = normalizedImageRepository(container.Image);
  const serviceName = String(labels['coolify.service.subName'] || containerDisplayName(container)).toLowerCase();

  return DISCOVERED_APP_PROFILES.find((profile) => (
    profile.imageRepositories.includes(repository) || profile.serviceNames.includes(serviceName)
  )) || null;
}

function isManagedMigrationCandidate(container) {
  const labels = container && container.Labels || {};
  return labels[MANAGED_LABEL] === 'true' &&
    /^res_[a-f0-9]{32}$/.test(String(labels['com.foxos.migration.source-resource-id'] || '')) &&
    /^smop_[a-f0-9]{32}$/.test(String(labels['com.foxos.stateless-migration.id'] || ''));
}

function isDiscoverableApplication(container) {
  const labels = container.Labels || {};
  const name = containerDisplayName(container);
  const runtimeName = dockerContainerName(container);
  if (
    labels['com.foxos.core'] === 'true' ||
    labels['com.foxos.stateful-shadow'] === 'true' ||
    labels['com.foxos.stateless-migration.disposable'] === 'true' ||
    DISCOVERY_EXCLUDED_NAMES.has(name) ||
    /^foxos-(?:deployment|compose|image-update)-lab(?:-|$)/.test(runtimeName) ||
    /-foxos-rollback-[a-f0-9]{8,32}$/.test(runtimeName)
  ) {
    return false;
  }

  const profile = discoveredProfileForContainer(container);
  const isCoolifyApplication = labels['coolify.managed'] === 'true' && (
    labels['coolify.type'] === 'application' || labels['coolify.service.subType'] === 'application'
  );
  const hasUsableEndpoint = Boolean(externalUrlForContainer(container) || publishedPortForContainer(container));
  const managedMigrationCandidate = isManagedMigrationCandidate(container);
  const managedApplication = labels[MANAGED_LABEL] === 'true' &&
    /^res_[a-f0-9]{32}$/.test(String(labels[APP_ID_LABEL] || ''));

  return Boolean(
    profile ||
    managedMigrationCandidate ||
    managedApplication ||
    (isCoolifyApplication && (hasUsableEndpoint || container.State !== 'running')) ||
    (hasUsableEndpoint && labels['coolify.managed'] !== 'true')
  );
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'application';
}

function humanizeName(value) {
  return String(value)
    .replace(/-[a-z0-9]{20,}$/i, '')
    .replace(/main$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Docker Application';
}

function hostnameForUrl(url) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function discoveredAppStates(containers, catalogApps) {
  const catalogContainerIds = new Set(
    catalogApps.map((catalogApp) => catalogContainerForApp(containers, catalogApp))
      .filter(Boolean)
      .map((container) => container.Id)
  );

  const discoverableContainers = containers.filter((container) => (
    !catalogContainerIds.has(container.Id) && isDiscoverableApplication(container)
  ));
  const profileCounts = discoverableContainers.reduce((counts, container) => {
    const profile = discoveredProfileForContainer(container);
    if (profile) {
      counts.set(profile.id, (counts.get(profile.id) || 0) + 1);
    }
    return counts;
  }, new Map());

  return discoverableContainers
    .map((container) => {
      const labels = container.Labels || {};
      const profile = discoveredProfileForContainer(container);
      const rawName = profile ? profile.name : containerDisplayName(container);
      const port = publishedPortForContainer(container, profile ? profile.containerPort : null);
      const stableName = labels['coolify.resourceName'] || containerDisplayName(container);
      const externalUrl = externalUrlForContainer(container);
      const instanceName = hostnameForUrl(externalUrl) || humanizeName(stableName);
      const hasMultipleProfileInstances = profile && profileCounts.get(profile.id) > 1;
      const appId = 'discovered-' + (profile ? profile.id + '-' : '') + slugify(stableName);
      const managedByFoxOS = labels[MANAGED_LABEL] === 'true';
      const imageReference = managedByFoxOS && String(labels['com.foxos.image.reference'] || '').trim()
        ? String(labels['com.foxos.image.reference']).trim()
        : container.Image;

      return {
        id: appId,
        profileId: profile ? profile.id : null,
        name: profile
          ? profile.name + (hasMultipleProfileInstances ? ' · ' + instanceName : '')
          : humanizeName(rawName),
        instanceName,
        publisher: profile ? profile.publisher : labels['coolify.projectName'] || 'Docker',
        category: profile ? profile.category : 'Web Apps',
        summary: profile ? profile.description : 'Bu sunucuda önceden kurulmuş uygulama.',
        description: profile ? profile.description : 'Bu uygulama sunucunun mevcut Docker kurulumunda otomatik olarak keşfedildi.',
        image: imageReference,
        logoUrl: profile && profile.logoUrl
          ? profile.logoUrl
          : externalUrl ? '/api/apps/' + encodeURIComponent(appId) + '/icon' : null,
        containerPort: port ? port.PrivatePort : null,
        defaultPort: port ? port.PublicPort : null,
        docsUrl: null,
        volumes: [],
        binds: [],
        environment: [],
        notes: [],
        installed: true,
        installable: false,
        managedByFoxOS,
        canManage: true,
        installationSource: managedByFoxOS
          ? 'foxos'
          : labels['coolify.managed'] === 'true' ? 'coolify' : 'docker',
        state: container.State || 'unknown',
        status: container.Status || null,
        containerId: container.Id,
        containerName: dockerContainerName(container),
        hostPort: port ? port.PublicPort : null,
        bindAddress: port ? port.IP || null : null,
        externalUrl: externalUrl && profile && profile.openPath
          ? externalUrl + profile.openPath
          : externalUrl
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function stateForCatalogApp(catalogApp, containers) {
  const container = catalogContainerForApp(containers, catalogApp);
  if (!container) {
    return {
      ...catalogApp,
      profileId: catalogApp.id,
      installed: false,
      installable: true,
      managedByFoxOS: false,
      canManage: false,
      installationSource: null,
      state: 'not-installed',
      status: null,
      containerId: null,
      containerName: null,
      instanceName: null,
      hostPort: null,
      bindAddress: null,
      externalUrl: null
    };
  }

  const managedByFoxOS = Boolean(
    container.Labels && container.Labels[MANAGED_LABEL] === 'true' &&
    container.Labels[APP_ID_LABEL] === catalogApp.id
  );
  const port = publishedPortForContainer(container, catalogApp.containerPort);
  const externalUrl = externalUrlForContainer(container);

  return {
    ...catalogApp,
    profileId: catalogApp.id,
    installed: true,
    installable: true,
    managedByFoxOS,
    canManage: true,
    installationSource: managedByFoxOS
      ? 'foxos'
      : container.Labels && container.Labels['coolify.managed'] === 'true' ? 'coolify' : 'docker',
    state: container.State || 'unknown',
    status: container.Status || null,
    containerId: container.Id,
    containerName: dockerContainerName(container),
    instanceName: hostnameForUrl(externalUrl) || dockerContainerName(container),
    hostPort: port && port.PublicPort ? port.PublicPort : null,
    bindAddress: port && port.IP ? port.IP : null,
    externalUrl
  };
}

function imagePullPath(image) {
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? image.slice(0, lastColon) : image;
  const tag = hasTag ? image.slice(lastColon + 1) : 'latest';
  return '/images/create?fromImage=' + encodeURIComponent(repository) + '&tag=' + encodeURIComponent(tag);
}

module.exports = {
  APP_ID_LABEL,
  DISCOVERED_APP_PROFILES,
  MANAGED_LABEL,
  catalogContainerForApp,
  containerName,
  createContainerPayload,
  discoveredAppStates,
  externalUrlForContainer,
  imagePullPath,
  isManagedMigrationCandidate,
  managedContainerForApp,
  normalizedImageRepository,
  stateForCatalogApp,
  validateInstallOptions
};
