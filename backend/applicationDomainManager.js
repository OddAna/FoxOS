const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { domainToASCII } = require('node:url');
const { atomicWriteJson } = require('./resourceRegistry');

const APPLICATION_DOMAIN_SCHEMA_VERSION = 1;
const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_HISTORY = 50;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const PLAN_ID_PATTERN = /^adplan_[a-f0-9]{32}$/;
const OPERATION_ID_PATTERN = /^adop_[a-f0-9]{32}$/;
const MIGRATION_OPERATION_ID_PATTERN = /^smop_[a-f0-9]{32}$/;
const ROUTE_ID_PATTERN = /^smroute_[a-f0-9]{24}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.invalid', '.test', '.example'];

class ApplicationDomainError extends Error {
  constructor(message, statusCode = 409, code = 'application-domain-error') {
    super(message);
    this.name = 'ApplicationDomainError';
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
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function id(prefix, bytes = 16) {
  return prefix + crypto.randomBytes(bytes).toString('hex');
}

function normalizeDomain(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 512 || /[\r\n\0]/.test(input)) {
    throw new ApplicationDomainError('Geçerli bir alan adı girin.', 400, 'invalid-domain');
  }

  let parsed;
  try {
    parsed = new URL(input.includes('://') ? input : 'https://' + input);
  } catch {
    throw new ApplicationDomainError('Geçerli bir alan adı girin.', 400, 'invalid-domain');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
    (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash
  ) {
    throw new ApplicationDomainError(
      'Yalnızca HTTPS alan adı girin; port, yol, kullanıcı bilgisi veya sorgu eklemeyin.',
      400,
      'invalid-domain-url'
    );
  }

  const domain = domainToASCII(parsed.hostname).toLowerCase();
  if (
    !DOMAIN_PATTERN.test(domain) || domain === 'localhost' ||
    RESERVED_SUFFIXES.some((suffix) => domain.endsWith(suffix))
  ) {
    throw new ApplicationDomainError('Bu alan adı genel HTTPS yayını için kullanılamaz.', 400, 'reserved-domain');
  }
  return domain;
}

function hostnameFromUrl(value) {
  try {
    return normalizeDomain(value);
  } catch {
    return null;
  }
}

function configuredHostname(value) {
  try {
    const parsed = new URL(String(value || ''));
    const hostname = domainToASCII(parsed.hostname).toLowerCase();
    return DOMAIN_PATTERN.test(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

function fingerprintRoute({ applicationId, management, route, primaryDomain }) {
  return hash(JSON.stringify({
    applicationId,
    operationId: management.operationId,
    routeId: route.routeId,
    domain: route.domain,
    path: route.path,
    alias: route.alias,
    privatePort: route.privatePort,
    candidateContainerId: management.candidateContainerId,
    primaryDomain
  }), 40);
}

function publicDnsEvidence(addresses) {
  return [...new Set(addresses.map((entry) => String(entry.address || '').toLowerCase()))]
    .sort()
    .map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

function isPublicAddress(address) {
  const value = String(address || '').toLowerCase();
  const family = net.isIP(value);
  if (family === 4) {
    const octets = value.split('.').map(Number);
    return !(
      octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && [0, 2, 168].includes(octets[1])) ||
      (octets[0] === 198 && [18, 19, 51].includes(octets[1])) ||
      (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
      octets[0] >= 224
    );
  }
  if (family === 6) {
    return !(
      value === '::' || value === '::1' || value.startsWith('::ffff:') ||
      value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) ||
      value.startsWith('ff') || value.startsWith('2001:db8:')
    );
  }
  return false;
}

function createApplicationDomainManager({
  dataRoot,
  ingressAuthority,
  resourceRegistry,
  getApplicationInventory,
  panelBaseUrl = null,
  dnsLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  clock = () => new Date(),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  probeAttempts = 30,
  probeIntervalMs = 2000
}) {
  if (
    !dataRoot || !ingressAuthority || typeof ingressAuthority.state !== 'function' ||
    typeof ingressAuthority.stageRoutes !== 'function' ||
    typeof ingressAuthority.switchDomain !== 'function' ||
    typeof ingressAuthority.removeRoutes !== 'function' ||
    typeof ingressAuthority.httpsProbe !== 'function' ||
    !resourceRegistry || typeof resourceRegistry.getMigrationManagement !== 'function' ||
    typeof getApplicationInventory !== 'function'
  ) {
    throw new Error('Application domain manager requires inventory, registry and ingress adapters');
  }

  const root = path.join(dataRoot, 'application-domains');
  const stateFile = path.join(root, 'state.json');
  const lockFile = path.join(root, 'operation.lock');
  const panelDomain = panelBaseUrl ? configuredHostname(panelBaseUrl) : null;
  ensureDirectory(root);

  function now() {
    return new Date(clock()).toISOString();
  }

  function emptyState() {
    return {
      schemaVersion: APPLICATION_DOMAIN_SCHEMA_VERSION,
      preferences: {},
      plans: {},
      operations: {},
      updatedAt: null
    };
  }

  function state() {
    const value = readJson(stateFile, emptyState());
    if (
      value.schemaVersion !== APPLICATION_DOMAIN_SCHEMA_VERSION ||
      !value.preferences || !value.plans || !value.operations
    ) {
      throw new ApplicationDomainError('Alan adı kayıt biçimi desteklenmiyor.', 503, 'domain-state-invalid');
    }
    return value;
  }

  function prune(value) {
    const trim = (records) => Object.fromEntries(Object.entries(records)
      .sort(([, left], [, right]) => String(right.updatedAt || right.createdAt)
        .localeCompare(String(left.updatedAt || left.createdAt)))
      .slice(0, MAX_HISTORY));
    value.plans = trim(value.plans);
    value.operations = trim(value.operations);
    return value;
  }

  function persist(value) {
    value.updatedAt = now();
    atomicWriteJson(stateFile, prune(value));
    return value;
  }

  function primaryDomains() {
    const authority = ingressAuthority.state();
    return Object.fromEntries(Object.entries(state().preferences)
      .filter(([resourceId, preference]) => (
        RESOURCE_ID_PATTERN.test(resourceId) && preference && DOMAIN_PATTERN.test(preference.primaryDomain) &&
        authority.routes && authority.routes[preference.primaryRouteId] &&
        authority.routes[preference.primaryRouteId].domain === preference.primaryDomain &&
        authority.routes[preference.primaryRouteId].status === 'active' &&
        authority.domains && authority.domains[preference.primaryDomain] === 'foxos'
      ))
      .map(([resourceId, preference]) => [resourceId, preference.primaryDomain]));
  }

  async function resolveApplication(applicationId) {
    if (!RESOURCE_ID_PATTERN.test(String(applicationId || ''))) {
      throw new ApplicationDomainError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    const inventory = await getApplicationInventory();
    const application = (inventory.applications || []).find((entry) => entry.id === applicationId);
    if (!application) {
      throw new ApplicationDomainError('Uygulama bulunamadı.', 404, 'application-not-found');
    }
    const management = resourceRegistry.getMigrationManagement(application.resourceId);
    if (
      !application.managedByServer || !application.capabilities || application.capabilities.editDomain !== true ||
      !management || management.authorityActive !== true || management.state !== 'active' ||
      !MIGRATION_OPERATION_ID_PATTERN.test(String(management.operationId || '')) ||
      !ROUTE_ID_PATTERN.test(String(management.routeId || '')) ||
      application.runtime.operationalState !== 'running' ||
      application.runtime.containerId !== management.candidateContainerId
    ) {
      throw new ApplicationDomainError(
        'Bu uygulamanın alan adı henüz sunucu tarafından güvenle yönetilemiyor.',
        409,
        'domain-management-unavailable'
      );
    }
    const authority = ingressAuthority.state();
    const route = authority.routes && authority.routes[management.routeId];
    if (
      !route || route.operationId !== management.operationId || route.status !== 'active' ||
      authority.domains && authority.domains[route.domain] !== 'foxos'
    ) {
      throw new ApplicationDomainError('Uygulamanın etkin sunucu rotası doğrulanamadı.', 409, 'active-route-unverified');
    }
    const persistedPreference = state().preferences[application.resourceId] || null;
    const preferredRoute = persistedPreference && authority.routes && authority.routes[persistedPreference.primaryRouteId];
    const preference = preferredRoute && preferredRoute.domain === persistedPreference.primaryDomain &&
      preferredRoute.operationId === management.operationId && preferredRoute.status === 'active' &&
      authority.domains[persistedPreference.primaryDomain] === 'foxos'
      ? persistedPreference
      : null;
    const currentPrimary = preference && preference.primaryDomain || hostnameFromUrl(application.externalUrl) || route.domain;
    const primaryRoute = preference ? preferredRoute : Object.values(authority.routes || {}).find((entry) => (
      entry.domain === currentPrimary && entry.operationId === management.operationId && entry.status === 'active'
    )) || route;
    return { application, management, authority, route: primaryRoute, currentPrimary, preference };
  }

  async function resolvePublicDns(domain) {
    let addresses;
    try {
      addresses = await dnsLookup(domain);
    } catch {
      throw new ApplicationDomainError(
        'Alan adı DNS üzerinde henüz çözümlenmiyor. Önce A/AAAA kaydını bu sunucuya yönlendirin.',
        409,
        'domain-dns-unresolved'
      );
    }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new ApplicationDomainError(
        'Alan adı yalnızca genel internet adreslerine çözülmelidir.',
        409,
        'domain-dns-not-public'
      );
    }
    return publicDnsEvidence(addresses);
  }

  async function assertDomainAvailable(domain, applicationId, planId = null) {
    if (panelDomain && domain === panelDomain) {
      throw new ApplicationDomainError('Bu alan adı yönetim paneli tarafından kullanılıyor.', 409, 'panel-domain-conflict');
    }

    const authority = ingressAuthority.state();
    const management = resourceRegistry.getMigrationManagement(applicationId);
    const collision = Object.values(authority.routes || {}).find((route) => (
      route.domain === domain && route.status !== 'removed' &&
      (!management || route.operationId !== management.operationId)
    ));
    if (collision) {
      throw new ApplicationDomainError('Bu alan adı başka bir uygulama tarafından kullanılıyor.', 409, 'domain-conflict');
    }

    const inventory = await getApplicationInventory();
    const applicationCollision = (inventory.applications || []).find((entry) => (
      entry.id !== applicationId && hostnameFromUrl(entry.externalUrl) === domain
    ));
    if (applicationCollision) {
      throw new ApplicationDomainError('Bu alan adı başka bir uygulama tarafından kullanılıyor.', 409, 'domain-conflict');
    }

    const snapshot = resourceRegistry.getLatest && resourceRegistry.getLatest();
    const resourceCollision = snapshot && (snapshot.resources || []).find((resource) => (
      resource.id !== applicationId && (resource.routes || []).some((route) => route.domain === domain)
    ));
    if (resourceCollision) {
      throw new ApplicationDomainError('Bu alan adı başka bir sunucu kaynağına bağlı.', 409, 'resource-domain-conflict');
    }

    const current = state();
    const preferenceCollision = Object.entries(current.preferences).find(([resourceId, preference]) => (
      resourceId !== applicationId && preference && preference.primaryDomain === domain
    ));
    if (preferenceCollision) {
      throw new ApplicationDomainError('Bu alan adı başka bir uygulama tarafından kullanılıyor.', 409, 'domain-conflict');
    }
    const pendingCollision = Object.values(current.plans).find((plan) => (
      plan.planId !== planId && plan.applicationId !== applicationId && plan.domain === domain &&
      plan.status === 'ready' && Date.parse(plan.expiresAt) > Date.parse(now())
    ));
    if (pendingCollision) {
      throw new ApplicationDomainError('Bu alan adı başka bir bekleyen işlem tarafından ayrılmış.', 409, 'domain-reserved');
    }
  }

  function routeForDomain(authority, domain, operationId) {
    return Object.values(authority.routes || {}).find((route) => (
      route.domain === domain && route.operationId === operationId && route.status !== 'removed'
    )) || null;
  }

  function publicPlan(plan) {
    return {
      planId: plan.planId,
      applicationId: plan.applicationId,
      currentDomain: plan.currentDomain,
      domain: plan.domain,
      dns: plan.dns,
      existingAlias: plan.existingAlias,
      oldAddressPreserved: true,
      expiresAt: plan.expiresAt,
      confirmation: plan.confirmation,
      status: plan.status
    };
  }

  function publicOperation(operation) {
    return {
      operationId: operation.operationId,
      applicationId: operation.applicationId,
      previousDomain: operation.previousDomain,
      primaryDomain: operation.primaryDomain,
      status: operation.status,
      createdRoute: operation.createdRoute,
      rollbackAvailable: operation.status === 'completed' && operation.previousDomain !== operation.primaryDomain,
      healthProof: operation.healthProof || null,
      rollback: operation.rollback || null,
      startedAt: operation.startedAt,
      completedAt: operation.completedAt || null,
      failure: operation.failure || null
    };
  }

  async function createPlan(applicationId, input = {}) {
    const domain = normalizeDomain(input.domain);
    const resolved = await resolveApplication(applicationId);
    if (domain === resolved.currentPrimary) {
      throw new ApplicationDomainError('Bu alan adı zaten uygulamanın birincil adresi.', 409, 'domain-unchanged');
    }
    await assertDomainAvailable(domain, applicationId);
    const dnsEvidence = await resolvePublicDns(domain);
    const matchingRoute = routeForDomain(resolved.authority, domain, resolved.management.operationId);
    if (matchingRoute && (
      matchingRoute.status !== 'active' || resolved.authority.domains[domain] !== 'foxos'
    )) {
      throw new ApplicationDomainError(
        'Bu alan adı için tamamlanmamış bir sunucu rotası var; önce işlem kaydını çözün.',
        409,
        'domain-route-attention-required'
      );
    }
    const existingRoute = matchingRoute;
    const planId = id('adplan_');
    const createdAt = now();
    const expiresAt = new Date(Date.parse(createdAt) + PLAN_TTL_MS).toISOString();
    const routeId = existingRoute && existingRoute.routeId || id('smroute_', 12);
    const plan = {
      schemaVersion: APPLICATION_DOMAIN_SCHEMA_VERSION,
      planId,
      applicationId,
      resourceId: resolved.application.resourceId,
      currentDomain: resolved.currentPrimary,
      currentRouteId: resolved.route.routeId,
      domain,
      routeId,
      existingAlias: Boolean(existingRoute),
      sourceFingerprint: fingerprintRoute({
        applicationId,
        management: resolved.management,
        route: resolved.route,
        primaryDomain: resolved.currentPrimary
      }),
      migrationOperationId: resolved.management.operationId,
      candidateContainerId: resolved.management.candidateContainerId,
      alias: resolved.route.alias,
      privatePort: resolved.route.privatePort,
      path: resolved.route.path,
      dns: dnsEvidence,
      previousPreferenceOperationId: resolved.preference && resolved.preference.operationId || null,
      status: 'ready',
      createdAt,
      expiresAt,
      updatedAt: createdAt,
      confirmation: 'CHANGE APPLICATION DOMAIN ' + planId
    };
    const current = state();
    current.plans[planId] = plan;
    persist(current);
    return publicPlan(plan);
  }

  function assertPlanFresh(plan, resolved) {
    if (plan.status !== 'ready') {
      throw new ApplicationDomainError('Bu alan adı planı artık kullanılamaz.', 409, 'domain-plan-consumed');
    }
    if (Date.parse(plan.expiresAt) <= Date.parse(now())) {
      throw new ApplicationDomainError('Alan adı kontrolünün süresi doldu. Yeniden kontrol edin.', 409, 'domain-plan-expired');
    }
    const fingerprint = fingerprintRoute({
      applicationId: plan.applicationId,
      management: resolved.management,
      route: resolved.route,
      primaryDomain: resolved.currentPrimary
    });
    if (fingerprint !== plan.sourceFingerprint || resolved.currentPrimary !== plan.currentDomain) {
      throw new ApplicationDomainError('Uygulama rotası kontrolden sonra değişti. Yeniden kontrol edin.', 409, 'domain-plan-stale');
    }
  }

  async function probeRoute({ domain, routeId, operationId, connectHost, requestPath = '/' }) {
    let lastFailure = null;
    for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
      try {
        const proof = await ingressAuthority.httpsProbe({
          hostname: domain,
          connectHost,
          port: 443,
          requestPath,
          expectedRouteId: routeId,
          timeoutMs: 5000
        });
        if (
          proof.tlsValid === true && proof.expectedRoute === true &&
          proof.candidateIdentity === operationId && proof.statusCode >= 200 && proof.statusCode < 500
        ) {
          return { ...proof, attempts: attempt, checkedAt: now() };
        }
        lastFailure = 'Yönlendirme beklenen uygulamayı sağlıklı biçimde döndürmedi.';
      } catch (error) {
        lastFailure = error.message;
      }
      if (attempt < probeAttempts) await delay(probeIntervalMs);
    }
    throw new ApplicationDomainError(lastFailure || 'HTTPS doğrulaması başarısız oldu.', 503, 'domain-health-proof-failed');
  }

  function acquireLock(operationId) {
    try {
      const descriptor = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ operationId, acquiredAt: now() }) + '\n');
      return descriptor;
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new ApplicationDomainError('Başka bir alan adı işlemi devam ediyor.', 409, 'domain-operation-locked');
      }
      throw error;
    }
  }

  function releaseLock(descriptor) {
    try { fs.closeSync(descriptor); } catch { /* descriptor may already be closed */ }
    try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function applyPlan(planId, confirmation) {
    if (!PLAN_ID_PATTERN.test(String(planId || ''))) {
      throw new ApplicationDomainError('Alan adı planı kimliği geçersiz.', 400, 'invalid-domain-plan-id');
    }
    let current = state();
    const plan = current.plans[planId];
    if (!plan) throw new ApplicationDomainError('Alan adı planı bulunamadı.', 404, 'domain-plan-not-found');
    if (confirmation !== plan.confirmation) {
      throw new ApplicationDomainError('Alan adı değişikliği onayı geçersiz.', 400, 'domain-confirmation-invalid');
    }

    const operationId = id('adop_');
    const lock = acquireLock(operationId);
    let staged = false;
    let switched = false;
    let operation = null;
    try {
      const resolved = await resolveApplication(plan.applicationId);
      assertPlanFresh(plan, resolved);
      await assertDomainAvailable(plan.domain, plan.applicationId, plan.planId);
      const dnsEvidence = await resolvePublicDns(plan.domain);
      const existingRoute = routeForDomain(ingressAuthority.state(), plan.domain, plan.migrationOperationId);
      if (Boolean(existingRoute) !== plan.existingAlias || (existingRoute && existingRoute.routeId !== plan.routeId)) {
        throw new ApplicationDomainError('Alan adı rotası kontrolden sonra değişti.', 409, 'domain-plan-stale');
      }

      operation = {
        schemaVersion: APPLICATION_DOMAIN_SCHEMA_VERSION,
        operationId,
        planId,
        applicationId: plan.applicationId,
        resourceId: plan.resourceId,
        previousDomain: plan.currentDomain,
        previousRouteId: plan.currentRouteId,
        previousPreferenceOperationId: plan.previousPreferenceOperationId || null,
        primaryDomain: plan.domain,
        routeId: plan.routeId,
        migrationOperationId: plan.migrationOperationId,
        createdRoute: !plan.existingAlias,
        dns: dnsEvidence,
        status: 'applying',
        startedAt: now(),
        updatedAt: now()
      };
      current = state();
      current.plans[planId].status = 'applying';
      current.plans[planId].updatedAt = now();
      current.operations[operationId] = operation;
      persist(current);

      const previousDomainProof = await probeRoute({
        domain: plan.currentDomain,
        routeId: plan.currentRouteId,
        operationId: plan.migrationOperationId,
        connectHost: 'foxos-gateway',
        requestPath: plan.path
      });

      if (!existingRoute) {
        await ingressAuthority.stageRoutes([{
          routeId: plan.routeId,
          operationId: plan.migrationOperationId,
          domain: plan.domain,
          path: plan.path,
          alias: plan.alias,
          privatePort: plan.privatePort
        }]);
        staged = true;
        await ingressAuthority.switchDomain(plan.domain, 'foxos');
        switched = true;
      }

      const internalProof = await probeRoute({
        domain: plan.domain,
        routeId: plan.routeId,
        operationId: plan.migrationOperationId,
        connectHost: 'foxos-gateway',
        requestPath: plan.path
      });
      const publicProof = await probeRoute({
        domain: plan.domain,
        routeId: plan.routeId,
        operationId: plan.migrationOperationId,
        connectHost: (dnsEvidence.find((entry) => entry.family === 4) || dnsEvidence[0]).address,
        requestPath: plan.path
      });

      current = state();
      operation = current.operations[operationId];
      operation.status = 'completed';
      operation.healthProof = {
        previousDomain: previousDomainProof,
        internal: internalProof,
        public: {
          ...publicProof,
          resolvedAddress: (dnsEvidence.find((entry) => entry.family === 4) || dnsEvidence[0]).address
        }
      };
      operation.completedAt = now();
      operation.updatedAt = now();
      current.preferences[plan.resourceId] = {
        primaryDomain: plan.domain,
        primaryRouteId: plan.routeId,
        previousDomain: plan.currentDomain,
        previousRouteId: plan.currentRouteId,
        operationId,
        changedAt: now()
      };
      current.plans[planId].status = 'applied';
      current.plans[planId].updatedAt = now();
      persist(current);
      return publicOperation(operation);
    } catch (error) {
      let rollback = { attempted: Boolean(staged || switched), completed: false, previousDomainPreserved: true };
      if (staged || switched) {
        try {
          const authority = ingressAuthority.state();
          const exactRoute = authority.routes && authority.routes[plan.routeId];
          if (exactRoute && exactRoute.operationId === plan.migrationOperationId && exactRoute.domain === plan.domain) {
            if (authority.domains && authority.domains[plan.domain] === 'foxos') {
              await ingressAuthority.switchDomain(plan.domain, 'legacy');
            }
            await ingressAuthority.removeRoutes([plan.routeId]);
          }
          rollback.previousDomainProof = await probeRoute({
            domain: plan.currentDomain,
            routeId: plan.currentRouteId,
            operationId: plan.migrationOperationId,
            connectHost: 'foxos-gateway',
            requestPath: plan.path
          });
          rollback.completed = true;
        } catch (rollbackError) {
          rollback.error = rollbackError.message;
        }
      }
      current = state();
      if (current.plans[planId]) {
        current.plans[planId].status = 'failed';
        current.plans[planId].updatedAt = now();
      }
      if (operation && current.operations[operationId]) {
        current.operations[operationId].status = rollback.completed || !rollback.attempted
          ? 'failed-rolled-back'
          : 'attention-required';
        current.operations[operationId].failure = {
          code: error.code || 'domain-apply-failed',
          message: error.message,
          recordedAt: now()
        };
        current.operations[operationId].rollback = rollback;
        current.operations[operationId].updatedAt = now();
      }
      persist(current);
      if (rollback.attempted && !rollback.completed) {
        throw new ApplicationDomainError(
          'Yeni alan adı doğrulanamadı ve otomatik geri alma tamamlanamadı. Eski adres korunuyor; işlem kaydını inceleyin.',
          503,
          'domain-rollback-attention-required'
        );
      }
      if (rollback.attempted && rollback.completed) {
        throw new ApplicationDomainError(
          'Yeni alan adı doğrulanamadı. Yeni rota geri alındı; eski adres çalışmaya devam ediyor.',
          503,
          'domain-apply-rolled-back'
        );
      }
      if (error instanceof ApplicationDomainError) throw error;
      throw new ApplicationDomainError(
        'Yeni alan adı doğrulanamadı. Yeni rota geri alındı; eski adres çalışmaya devam ediyor.',
        503,
        'domain-apply-rolled-back'
      );
    } finally {
      releaseLock(lock);
    }
  }

  async function rollbackOperation(operationId, confirmation) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) {
      throw new ApplicationDomainError('Alan adı işlem kimliği geçersiz.', 400, 'invalid-domain-operation-id');
    }
    let current = state();
    const operation = current.operations[operationId];
    if (!operation) throw new ApplicationDomainError('Alan adı işlemi bulunamadı.', 404, 'domain-operation-not-found');
    const expected = 'ROLL BACK APPLICATION DOMAIN ' + operationId;
    if (confirmation !== expected) {
      throw new ApplicationDomainError('Geri alma onayı geçersiz.', 400, 'domain-rollback-confirmation-invalid');
    }
    if (operation.status !== 'completed') {
      throw new ApplicationDomainError('Bu işlem geri alınabilir durumda değil.', 409, 'domain-operation-not-reversible');
    }
    const preference = current.preferences[operation.resourceId];
    if (!preference || preference.operationId !== operationId || preference.primaryDomain !== operation.primaryDomain) {
      throw new ApplicationDomainError('Birincil adres daha sonra değişti; eski işlem geri alınamaz.', 409, 'domain-rollback-stale');
    }

    const lock = acquireLock(operationId);
    try {
      const resolved = await resolveApplication(operation.applicationId);
      const authority = ingressAuthority.state();
      const previousRoute = routeForDomain(authority, operation.previousDomain, operation.migrationOperationId);
      if (!previousRoute || authority.domains[operation.previousDomain] !== 'foxos') {
        throw new ApplicationDomainError('Önceki alan adı rotası artık etkin değil.', 409, 'previous-domain-unavailable');
      }
      await probeRoute({
        domain: operation.previousDomain,
        routeId: previousRoute.routeId,
        operationId: operation.migrationOperationId,
        connectHost: 'foxos-gateway',
        requestPath: previousRoute.path
      });
      if (resolved.application.runtime.operationalState !== 'running') {
        throw new ApplicationDomainError('Uygulama çalışmadığı için geri alma doğrulanamadı.', 409, 'application-not-running');
      }

      current = state();
      current.operations[operationId].status = 'rolling-back';
      current.operations[operationId].updatedAt = now();
      persist(current);

      if (operation.createdRoute) {
        const exactRoute = ingressAuthority.state().routes[operation.routeId];
        if (
          !exactRoute || exactRoute.domain !== operation.primaryDomain ||
          exactRoute.operationId !== operation.migrationOperationId
        ) {
          throw new ApplicationDomainError('Yeni alan adı rotasının kimliği değişti.', 409, 'domain-rollback-route-stale');
        }
        await ingressAuthority.switchDomain(operation.primaryDomain, 'legacy');
        await ingressAuthority.removeRoutes([operation.routeId]);
      }

      const restoredProof = await probeRoute({
        domain: operation.previousDomain,
        routeId: previousRoute.routeId,
        operationId: operation.migrationOperationId,
        connectHost: 'foxos-gateway',
        requestPath: previousRoute.path
      });

      current = state();
      current.preferences[operation.resourceId] = {
        primaryDomain: operation.previousDomain,
        primaryRouteId: previousRoute.routeId,
        previousDomain: operation.primaryDomain,
        previousRouteId: operation.routeId,
        operationId: operation.previousPreferenceOperationId || null,
        changedAt: now()
      };
      current.operations[operationId].status = 'rolled-back';
      current.operations[operationId].rollback = {
        attempted: true,
        completed: true,
        previousDomainPreserved: true,
        previousDomainProof: restoredProof,
        completedAt: now()
      };
      current.operations[operationId].updatedAt = now();
      persist(current);
      return publicOperation(current.operations[operationId]);
    } catch (error) {
      current = state();
      if (current.operations[operationId] && current.operations[operationId].status === 'rolling-back') {
        current.operations[operationId].status = 'attention-required';
        current.operations[operationId].failure = {
          code: error.code || 'domain-rollback-failed',
          message: error.message,
          recordedAt: now()
        };
        current.operations[operationId].updatedAt = now();
        persist(current);
      }
      if (error instanceof ApplicationDomainError) throw error;
      throw new ApplicationDomainError('Alan adı geri alma işlemi tamamlanamadı.', 503, 'domain-rollback-failed');
    } finally {
      releaseLock(lock);
    }
  }

  async function getStatus(applicationId) {
    const resolved = await resolveApplication(applicationId);
    const current = state();
    const aliases = Object.values(resolved.authority.routes || {})
      .filter((route) => (
        route.operationId === resolved.management.operationId && route.status === 'active' &&
        resolved.authority.domains[route.domain] === 'foxos'
      ))
      .map((route) => route.domain)
      .filter((domain, index, values) => values.indexOf(domain) === index)
      .sort();
    const preferredOperation = resolved.preference && resolved.preference.operationId &&
      current.operations[resolved.preference.operationId] || null;
    const latest = preferredOperation || Object.values(current.operations)
      .filter((operation) => operation.applicationId === applicationId)
      .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))[0] || null;
    return {
      applicationId,
      editable: true,
      currentDomain: resolved.currentPrimary,
      aliases,
      oldAddressPreservedDuringChange: true,
      latestOperation: latest ? publicOperation(latest) : null,
      rollbackConfirmation: latest && latest.status === 'completed'
        ? 'ROLL BACK APPLICATION DOMAIN ' + latest.operationId
        : null
    };
  }

  // A stopped process cannot own this exact lock. Mark interrupted records for operator visibility,
  // then release only this manager's narrowly scoped lock file before accepting a new transaction.
  if (fs.existsSync(lockFile)) {
    const current = state();
    for (const operation of Object.values(current.operations)) {
      if (['applying', 'rolling-back'].includes(operation.status)) {
        operation.status = 'attention-required';
        operation.failure = {
          code: 'domain-operation-interrupted',
          message: 'Alan adı işlemi yönetim servisi yeniden başlatılırken kesildi.',
          recordedAt: now()
        };
        operation.updatedAt = now();
      }
    }
    persist(current);
    fs.unlinkSync(lockFile);
  }

  return {
    applyPlan,
    createPlan,
    getStatus,
    paths: { root, stateFile, lockFile },
    primaryDomains,
    rollbackOperation,
    state
  };
}

module.exports = {
  APPLICATION_DOMAIN_SCHEMA_VERSION,
  ApplicationDomainError,
  createApplicationDomainManager,
  normalizeDomain
};
