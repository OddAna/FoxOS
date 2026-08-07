const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const APPLICATION_REMOVAL_SCHEMA_VERSION = 1;
const APPLICATION_ID_PATTERN = /^(?:app|res)_[a-f0-9]{24,64}$/;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const PLAN_ID_PATTERN = /^arplan_[a-f0-9]{32}$/;
const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_GROUP_CONTAINERS = 32;
const PROTECTED_CONTAINER_NAMES = new Set(['foxos', 'foxos-gateway', 'foxos-ingress']);
const PROTECTED_NETWORKS = new Set(['bridge', 'host', 'none', 'foxos-routing', 'foxos-egress']);

class ApplicationRemovalError extends Error {
  constructor(message, statusCode = 409, code = 'application-removal-error') {
    super(message);
    this.name = 'ApplicationRemovalError';
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

function hash(value, length = 64) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length);
}

function containerName(details) {
  return String(details && details.Name || '').replace(/^\//, '');
}

function labelsFor(details) {
  return details && details.Config && details.Config.Labels || {};
}

function projectPaths(labels) {
  return [
    labels['com.docker.compose.project.working_dir'],
    ...String(labels['com.docker.compose.project.config_files'] || '').split(',')
  ].map((entry) => String(entry || '').trim()).filter(Boolean);
}

function assertContainerRemovable(details) {
  const labels = labelsFor(details);
  const name = containerName(details);
  if (
    !details || !CONTAINER_ID_PATTERN.test(String(details.Id || '')) ||
    labels['com.foxos.core'] === 'true' || PROTECTED_CONTAINER_NAMES.has(name) ||
    projectPaths(labels).some((entry) => entry === '/opt/foxos' || entry.startsWith('/opt/foxos/'))
  ) {
    throw new ApplicationRemovalError(
      'FoxOS çekirdeği ve kurulum altyapısı uygulama kaldırma işleminden korunuyor.',
      409,
      'application-removal-core-protected'
    );
  }
}

function containerFingerprint(details) {
  const labels = labelsFor(details);
  const mounts = (details.Mounts || []).map((mount) => ({
    type: mount.Type || null,
    name: mount.Name || null,
    source: mount.Type === 'bind' ? mount.Source || null : null,
    destination: mount.Destination || null,
    readOnly: mount.RW === false
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const networks = Object.keys(details.NetworkSettings && details.NetworkSettings.Networks || {}).sort();
  return hash({
    id: details.Id,
    name: details.Name,
    created: details.Created,
    imageId: details.Image,
    image: details.Config && details.Config.Image || null,
    labels,
    mounts,
    networks
  }, 48);
}

function descriptor(details, resourceId = null, relation = 'primary') {
  const labels = labelsFor(details);
  return {
    containerId: details.Id,
    name: containerName(details),
    image: details.Config && details.Config.Image || null,
    state: details.State && details.State.Status || 'unknown',
    running: Boolean(details.State && details.State.Running),
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
    resourceId: RESOURCE_ID_PATTERN.test(String(resourceId || '')) ? resourceId : null,
    relation,
    fingerprint: containerFingerprint(details)
  };
}

function publicContainer(target) {
  return {
    name: target.name,
    image: target.image,
    state: target.state,
    project: target.project,
    service: target.service,
    relation: target.relation
  };
}

function publicPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    applicationId: plan.applicationId,
    applicationName: plan.applicationName,
    kind: plan.kind,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    primary: plan.primary ? publicContainer(plan.primary) : null,
    sameApplicationCopies: plan.automaticTargets.map(publicContainer),
    linkedServices: plan.linkedTargets.map(publicContainer),
    persistentData: {
      namedVolumes: plan.volumes.map((volume) => ({
        name: volume.name,
        removableWithPrimary: volume.removableWithPrimary,
        removableWithLinkedServices: volume.removableWithLinkedServices
      })),
      bindMounts: plan.bindMounts,
      preservedByDefault: true
    },
    cleanup: {
      foxosRoutes: plan.routeCount,
      projectNetworks: plan.networks.length,
      desktopShortcut: true,
      sourceDefinition: plan.definitionResourceId ? true : false,
      imagesPreserved: true,
      composeFilesPreserved: true,
      dnsRecordsPreserved: true
    },
    warning: plan.kind === 'inactive-definition'
      ? 'Çalışmayan kurulum kaydı ve masaüstü kısayolu kaldırılacak.'
      : 'Uygulama containerı kalıcı olarak kaldırılacak. Kalıcı veriler ayrıca seçilmedikçe korunur.'
  };
}

function createApplicationRemovalManager({
  dataRoot,
  dockerRequest,
  getApplicationInventory,
  resourceRegistry,
  ingressAuthority,
  desktopShortcutManager,
  applicationDomainManager,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof getApplicationInventory !== 'function' ||
    !resourceRegistry || typeof resourceRegistry.scan !== 'function' ||
    !ingressAuthority || typeof ingressAuthority.removeResourceAuthority !== 'function' ||
    typeof ingressAuthority.state !== 'function' ||
    !desktopShortcutManager || typeof desktopShortcutManager.forget !== 'function' ||
    !applicationDomainManager || typeof applicationDomainManager.forgetApplication !== 'function' ||
    typeof applicationDomainManager.state !== 'function'
  ) {
    throw new Error('Application removal manager requires Docker, inventory, registry, ingress, shortcut and domain adapters');
  }

  const root = path.join(dataRoot, 'application-removals');
  const plansRoot = path.join(root, 'plans');
  const operationsRoot = path.join(root, 'operations');
  const inFlight = new Set();

  function now() {
    return new Date(clock()).toISOString();
  }

  function recordPath(directory, id) {
    return path.join(directory, id + '.json');
  }

  function writeRecord(directory, id, value) {
    ensureDirectory(directory);
    atomicWriteJson(recordPath(directory, id), value);
    return value;
  }

  async function inventoryApplication(applicationId) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) {
      throw new ApplicationRemovalError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    const inventory = await getApplicationInventory();
    const application = (inventory.applications || []).find((candidate) => candidate.id === applicationId);
    if (!application) {
      throw new ApplicationRemovalError('Uygulama artık sunucuda bulunamıyor.', 404, 'application-not-found');
    }
    return application;
  }

  async function latestSnapshot() {
    return resourceRegistry.getLatest && resourceRegistry.getLatest() || resourceRegistry.scan();
  }

  function resourceByContainerId(snapshot, containerId) {
    return (snapshot.resources || []).find((resource) => (
      resource && resource.runtime && resource.runtime.containerId === containerId
    )) || null;
  }

  function authorityEvidence(resourceIds) {
    const selected = new Set(resourceIds);
    const authority = ingressAuthority.state();
    const domainState = applicationDomainManager.state();
    const routes = Object.values(authority.routes || {}).filter((route) => (
      selected.has(route.resourceId)
    )).map((route) => ({
      routeId: route.routeId,
      resourceId: route.resourceId,
      operationId: route.operationId,
      domain: route.domain,
      path: route.path,
      status: route.status
    })).sort((left, right) => left.routeId.localeCompare(right.routeId));
    const inactiveDomains = Object.entries(authority.inactiveDomains || {})
      .filter(([, entry]) => entry && selected.has(entry.resourceId))
      .map(([domain, entry]) => ({ domain, resourceId: entry.resourceId }))
      .sort((left, right) => left.domain.localeCompare(right.domain));
    const preferences = Object.entries(domainState.preferences || {})
      .filter(([resourceId]) => selected.has(resourceId))
      .map(([resourceId, preference]) => ({ resourceId, preference }))
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
    return {
      routeCount: routes.length + inactiveDomains.length,
      fingerprint: hash({ routes, inactiveDomains, preferences }, 48)
    };
  }

  async function inspectContainer(containerId) {
    if (!CONTAINER_ID_PATTERN.test(String(containerId || ''))) {
      throw new ApplicationRemovalError('Container kimliği doğrulanamadı.', 409, 'application-container-invalid');
    }
    try {
      return await dockerRequest('GET', '/containers/' + encodeURIComponent(containerId) + '/json');
    } catch (error) {
      throw new ApplicationRemovalError(
        'Uygulama containerı artık bulunamıyor. Kaldırma penceresini yeniden açın.',
        409,
        'application-removal-target-stale'
      );
    }
  }

  async function definitionPlan(application, snapshot) {
    const resource = (snapshot.resources || []).find((entry) => entry.id === application.resourceId);
    if (!resource || resource.kind !== 'provider-definition' || resource.runtime && resource.runtime.containerId) {
      throw new ApplicationRemovalError(
        'Bu kurulum kaydı güvenli biçimde kaldırılamıyor.',
        409,
        'application-definition-removal-unsupported'
      );
    }
    const routeResourceIds = [resource.id];
    const authority = authorityEvidence(routeResourceIds);
    return {
      kind: 'inactive-definition',
      primary: null,
      automaticTargets: [],
      linkedTargets: [],
      volumes: [],
      bindMounts: [],
      networks: [],
      routeResourceIds,
      routeCount: authority.routeCount,
      definitionResourceId: resource.id,
      fingerprint: hash({
        id: resource.id,
        kind: resource.kind,
        provider: resource.provider,
        name: resource.name,
        runtime: resource.runtime,
        authority: authority.fingerprint
      }, 48)
    };
  }

  async function dockerPlan(application, snapshot) {
    const primaryId = application.runtime && application.runtime.containerId;
    const primaryDetails = await inspectContainer(primaryId);
    assertContainerRemovable(primaryDetails);
    const summaries = await dockerRequest('GET', '/containers/json?all=1');
    const resource = (snapshot.resources || []).find((entry) => entry.id === application.resourceId) || null;
    const primaryResource = resourceByContainerId(snapshot, primaryId);
    const primary = descriptor(primaryDetails, application.resourceId || primaryResource && primaryResource.id, 'primary');
    const automaticIds = new Set();
    const linkedIds = new Set();

    const sourceContainerId = resource && resource.kind === 'container' && resource.runtime && resource.runtime.containerId;
    if (CONTAINER_ID_PATTERN.test(String(sourceContainerId || '')) && sourceContainerId !== primaryId) {
      automaticIds.add(sourceContainerId);
    }

    const labels = labelsFor(primaryDetails);
    const project = labels['com.docker.compose.project'] || null;
    if (project) {
      for (const summary of summaries || []) {
        if (
          summary.Id !== primaryId && !automaticIds.has(summary.Id) &&
          summary.Labels && summary.Labels['com.docker.compose.project'] === project
        ) linkedIds.add(summary.Id);
      }
    }

    const operationId = application.management && application.management.operationId ||
      labels['com.foxos.stateless-migration.id'] || null;
    if (operationId) {
      for (const summary of summaries || []) {
        const summaryLabels = summary.Labels || {};
        if (
          summary.Id !== primaryId && !automaticIds.has(summary.Id) &&
          summaryLabels['com.foxos.stateless-migration.id'] === operationId &&
          summaryLabels['com.foxos.temporary'] === 'stateless-dependency-bridge'
        ) linkedIds.add(summary.Id);
      }
    }

    if (1 + automaticIds.size + linkedIds.size > MAX_GROUP_CONTAINERS) {
      throw new ApplicationRemovalError(
        'Bağlı servis grubu güvenli kaldırma sınırını aşıyor.',
        409,
        'application-removal-group-too-large'
      );
    }

    const inspectTargets = async (ids, relation) => Promise.all([...ids].sort().map(async (containerId) => {
      const details = await inspectContainer(containerId);
      assertContainerRemovable(details);
      const targetResource = resourceByContainerId(snapshot, containerId);
      return descriptor(details, targetResource && targetResource.id, relation);
    }));
    const automaticTargets = await inspectTargets(automaticIds, 'same-application-copy');
    const linkedTargets = await inspectTargets(linkedIds, 'linked-service');
    const allTargets = [primary, ...automaticTargets, ...linkedTargets];
    const allTargetIds = new Set(allTargets.map((target) => target.containerId));
    const primaryTargetIds = new Set([primary, ...automaticTargets].map((target) => target.containerId));
    const detailsById = new Map([[primaryId, primaryDetails]]);
    for (const target of [...automaticTargets, ...linkedTargets]) {
      detailsById.set(target.containerId, await inspectContainer(target.containerId));
    }

    const volumeNames = new Set();
    const bindMounts = [];
    for (const target of allTargets) {
      for (const mount of detailsById.get(target.containerId).Mounts || []) {
        if (mount.Type === 'volume' && mount.Name) volumeNames.add(mount.Name);
        if (mount.Type === 'bind') {
          bindMounts.push({ container: target.name, destination: mount.Destination || null });
        }
      }
    }
    const volumes = [...volumeNames].sort().map((name) => {
      const consumers = (summaries || []).filter((summary) => (
        (summary.Mounts || []).some((mount) => mount.Type === 'volume' && mount.Name === name)
      )).map((summary) => summary.Id).sort();
      return {
        name,
        consumers,
        removableWithPrimary: consumers.length > 0 && consumers.every((id) => primaryTargetIds.has(id)),
        removableWithLinkedServices: consumers.length > 0 && consumers.every((id) => allTargetIds.has(id))
      };
    });

    const networks = [];
    if (project) {
      const networkNames = new Set(allTargets.flatMap((target) => (
        Object.keys(detailsById.get(target.containerId).NetworkSettings &&
          detailsById.get(target.containerId).NetworkSettings.Networks || {})
      )));
      for (const name of [...networkNames].sort()) {
        if (PROTECTED_NETWORKS.has(name)) continue;
        try {
          const network = await dockerRequest('GET', '/networks/' + encodeURIComponent(name));
          if (
            network && network.Name === name && network.Labels &&
            network.Labels['com.docker.compose.project'] === project
          ) networks.push({ name, id: network.Id || null });
        } catch {
          // Only verified, project-owned networks participate in cleanup.
        }
      }
    }

    const routeResourceIds = [...new Set([
      application.resourceId,
      ...allTargets.map((target) => target.resourceId)
    ].filter((id) => RESOURCE_ID_PATTERN.test(String(id || ''))))].sort();
    const authority = authorityEvidence(routeResourceIds);
    const definitionResourceId = resource && resource.kind === 'provider-definition'
      ? resource.id
      : application.resourceId;
    const membership = [...new Set([
      primaryId,
      ...automaticTargets.map((target) => target.containerId),
      ...linkedTargets.map((target) => target.containerId)
    ])].sort();
    return {
      kind: 'docker',
      primary,
      automaticTargets,
      linkedTargets,
      volumes,
      bindMounts: bindMounts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      networks,
      routeResourceIds,
      routeCount: authority.routeCount,
      definitionResourceId: RESOURCE_ID_PATTERN.test(String(definitionResourceId || ''))
        ? definitionResourceId
        : null,
      membership,
      fingerprint: hash({
        applicationId: application.id,
        runtimeContainerId: primaryId,
        targets: allTargets.map((target) => ({
          id: target.containerId,
          relation: target.relation,
          fingerprint: target.fingerprint
        })).sort((left, right) => left.id.localeCompare(right.id)),
        volumes,
        networks,
        routeResourceIds,
        authority: authority.fingerprint
      }, 48)
    };
  }

  async function resolvePlanState(application) {
    const snapshot = await latestSnapshot();
    if (application.installation && application.installation.state === 'host-service') {
      throw new ApplicationRemovalError(
        'Sunucu servisleri genel uygulama kaldırma akışından silinemez. Paket ve ağ yapılandırması için servise özel kaldırma desteği gerekir.',
        409,
        'host-service-removal-unsupported'
      );
    }
    if (application.installation && application.installation.state === 'inactive-definition') {
      return definitionPlan(application, snapshot);
    }
    if (!application.runtime || !CONTAINER_ID_PATTERN.test(String(application.runtime.containerId || ''))) {
      throw new ApplicationRemovalError(
        'Bu uygulamanın kaldırılabilir bir Docker çalışma örneği bulunamadı.',
        409,
        'application-removal-runtime-required'
      );
    }
    return dockerPlan(application, snapshot);
  }

  async function createPlan(applicationId) {
    const application = await inventoryApplication(applicationId);
    const resolved = await resolvePlanState(application);
    const createdAt = now();
    const plan = {
      schemaVersion: APPLICATION_REMOVAL_SCHEMA_VERSION,
      planId: 'arplan_' + randomUUID().replace(/-/g, ''),
      applicationId: application.id,
      applicationName: application.name,
      createdAt,
      expiresAt: new Date(new Date(createdAt).getTime() + PLAN_TTL_MS).toISOString(),
      status: 'planned',
      ...resolved
    };
    writeRecord(plansRoot, plan.planId, plan);
    return publicPlan(plan);
  }

  async function assertFresh(plan) {
    if (Date.parse(plan.expiresAt) <= new Date(clock()).getTime()) {
      throw new ApplicationRemovalError(
        'Kaldırma planının süresi doldu. Pencereyi kapatıp yeniden açın.',
        409,
        'application-removal-plan-expired'
      );
    }
    const application = await inventoryApplication(plan.applicationId);
    const current = await resolvePlanState(application);
    if (current.kind !== plan.kind || current.fingerprint !== plan.fingerprint) {
      throw new ApplicationRemovalError(
        'Uygulama veya bağlı servisler onay penceresi açıldıktan sonra değişti. Kaldırma planını yeniden oluşturun.',
        409,
        'application-removal-plan-stale'
      );
    }
    return { application, current };
  }

  async function restoreStoppedContainers(targets) {
    for (const target of [...targets].reverse()) {
      if (!target.running) continue;
      try { await dockerRequest('POST', '/containers/' + target.containerId + '/start'); } catch { /* best effort */ }
    }
  }

  async function removeDefinition(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId || ''))) return false;
    let snapshot = await resourceRegistry.scan();
    const resource = (snapshot.resources || []).find((entry) => entry.id === resourceId);
    if (!resource || resource.kind !== 'provider-definition' || resource.runtime && resource.runtime.containerId) {
      return false;
    }
    resourceRegistry.retireProviderDefinition(resourceId, `REMOVE INACTIVE DEFINITION ${resourceId}`);
    snapshot = await resourceRegistry.scan();
    if ((snapshot.resources || []).some((entry) => entry.id === resourceId)) {
      throw new ApplicationRemovalError(
        'Kurulum kaydı kaldırıldı ancak envanterden kaybolduğu doğrulanamadı.',
        503,
        'application-definition-removal-unverified'
      );
    }
    return true;
  }

  async function applyPlan(planId, { includeLinkedServices = false, removeData = false } = {}) {
    if (!PLAN_ID_PATTERN.test(String(planId || ''))) {
      throw new ApplicationRemovalError('Kaldırma planı kimliği geçersiz.', 400, 'invalid-application-removal-plan-id');
    }
    if (typeof includeLinkedServices !== 'boolean' || typeof removeData !== 'boolean') {
      throw new ApplicationRemovalError('Kaldırma seçenekleri geçersiz.', 400, 'invalid-application-removal-options');
    }
    const plan = readJson(recordPath(plansRoot, planId), null);
    if (!plan || plan.schemaVersion !== APPLICATION_REMOVAL_SCHEMA_VERSION) {
      throw new ApplicationRemovalError('Kaldırma planı bulunamadı.', 404, 'application-removal-plan-not-found');
    }
    const applicationLock = 'application:' + plan.applicationId;
    if (inFlight.has(planId) || inFlight.has(applicationLock)) {
      throw new ApplicationRemovalError('Bu uygulama için kaldırma işlemi zaten sürüyor.', 409, 'application-removal-in-progress');
    }
    inFlight.add(planId);
    inFlight.add(applicationLock);
    const operationId = 'arop_' + randomUUID().replace(/-/g, '');
    const operation = {
      schemaVersion: APPLICATION_REMOVAL_SCHEMA_VERSION,
      operationId,
      planId,
      applicationId: plan.applicationId,
      applicationName: plan.applicationName,
      status: 'applying',
      startedAt: now(),
      options: { includeLinkedServices, removeData },
      removedContainers: [],
      removedVolumes: [],
      removedNetworks: [],
      preservedVolumes: [],
      removedRouteResources: [],
      sourceDefinitionRetired: false
    };
    writeRecord(operationsRoot, operationId, operation);

    try {
      const { current } = await assertFresh(plan);
      if (plan.kind === 'inactive-definition') {
        const removed = await ingressAuthority.removeResourceAuthority(plan.definitionResourceId);
        if (removed && (removed.routesRemoved || removed.inactiveDomainsRemoved)) {
          operation.removedRouteResources.push(plan.definitionResourceId);
        }
        operation.sourceDefinitionRetired = await removeDefinition(plan.definitionResourceId);
        desktopShortcutManager.forget(plan.applicationId);
        applicationDomainManager.forgetApplication(plan.applicationId);
        operation.status = 'completed';
        operation.completedAt = now();
        operation.message = 'Çalışmayan kurulum kaydı kaldırıldı.';
        writeRecord(operationsRoot, operationId, operation);
        return operation;
      }

      const targets = [
        current.primary,
        ...current.automaticTargets,
        ...(includeLinkedServices ? current.linkedTargets : [])
      ];
      const targetIds = new Set(targets.map((target) => target.containerId));
      const stopped = [];
      try {
        for (const target of targets) {
          if (!target.running) continue;
          await dockerRequest('POST', '/containers/' + target.containerId + '/stop?t=10');
          stopped.push(target);
        }
        const routeResourceIds = [...new Set([
          plan.applicationId,
          ...targets.map((target) => target.resourceId)
        ].filter((id) => RESOURCE_ID_PATTERN.test(String(id || ''))))];
        for (const resourceId of routeResourceIds) {
          const removed = await ingressAuthority.removeResourceAuthority(resourceId);
          if (removed && (removed.routesRemoved || removed.inactiveDomainsRemoved)) {
            operation.removedRouteResources.push(resourceId);
          }
          applicationDomainManager.forgetApplication(resourceId);
        }
      } catch (error) {
        await restoreStoppedContainers(stopped);
        throw error;
      }

      for (const target of targets) {
        await dockerRequest('DELETE', '/containers/' + target.containerId + '?force=1&v=0');
        operation.removedContainers.push(target.name);
      }

      const remainingContainers = await dockerRequest('GET', '/containers/json?all=1');
      for (const volume of current.volumes) {
        const stillUsed = (remainingContainers || []).some((container) => (
          (container.Mounts || []).some((mount) => mount.Type === 'volume' && mount.Name === volume.name)
        ));
        const selectedConsumers = volume.consumers.every((containerId) => targetIds.has(containerId));
        if (!removeData || stillUsed || !selectedConsumers) {
          operation.preservedVolumes.push({ name: volume.name, reason: stillUsed ? 'shared-or-in-use' : 'preserved-by-choice' });
          continue;
        }
        await dockerRequest('DELETE', '/volumes/' + encodeURIComponent(volume.name));
        operation.removedVolumes.push(volume.name);
      }

      for (const network of current.networks) {
        try {
          const details = await dockerRequest('GET', '/networks/' + encodeURIComponent(network.name));
          if (details && Object.keys(details.Containers || {}).length === 0) {
            await dockerRequest('DELETE', '/networks/' + encodeURIComponent(network.name));
            operation.removedNetworks.push(network.name);
          }
        } catch {
          // A non-empty or concurrently changed network is safely preserved.
        }
      }

      operation.sourceDefinitionRetired = await removeDefinition(plan.definitionResourceId);
      for (const applicationId of new Set([
        plan.applicationId,
        ...targets.map((target) => target.resourceId).filter(Boolean)
      ])) desktopShortcutManager.forget(applicationId);
      await resourceRegistry.scan();
      const inventory = await getApplicationInventory();
      if ((inventory.applications || []).some((application) => application.id === plan.applicationId)) {
        throw new ApplicationRemovalError(
          'Çalışma örneği kaldırıldı ancak uygulama envanterde yeniden belirdi. Dış sağlayıcı tanımı yeniden oluşturmuş olabilir.',
          503,
          'application-removal-reappeared'
        );
      }
      operation.status = 'completed';
      operation.completedAt = now();
      operation.message = operation.removedContainers.length > 1
        ? `${operation.removedContainers.length} bağlı çalışma örneği temiz biçimde kaldırıldı.`
        : 'Uygulama temiz biçimde kaldırıldı.';
      writeRecord(operationsRoot, operationId, operation);
      return operation;
    } catch (error) {
      operation.status = 'attention-required';
      operation.completedAt = now();
      operation.error = {
        code: error.code || 'application-removal-failed',
        message: String(error.message || 'Kaldırma işlemi tamamlanamadı.').slice(0, 500)
      };
      writeRecord(operationsRoot, operationId, operation);
      if (error instanceof ApplicationRemovalError) throw error;
      throw new ApplicationRemovalError(
        'Uygulama kaldırma işlemi tamamlanamadı: ' + String(error.message || 'bilinmeyen hata').slice(0, 300),
        503,
        'application-removal-failed'
      );
    } finally {
      inFlight.delete(planId);
      inFlight.delete(applicationLock);
    }
  }

  return {
    applyPlan,
    createPlan,
    paths: { root, plansRoot, operationsRoot },
    publicPlan
  };
}

module.exports = {
  APPLICATION_REMOVAL_SCHEMA_VERSION,
  ApplicationRemovalError,
  createApplicationRemovalManager
};
