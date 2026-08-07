const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { atomicWriteJson } = require('./resourceRegistry');

const INACTIVE_RUNTIME_SCHEMA_VERSION = 1;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PROVIDER_APPLICATION_ID_PATTERN = /^[a-z0-9]{20,128}$/;
const OPERATION_ID_PATTERN = /^rtop_[a-f0-9]{32}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IMAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_COMPOSE_BYTES = 2 * 1024 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;

class InactiveDefinitionRuntimeError extends Error {
  constructor(message, statusCode = 409, code = 'inactive-definition-runtime-error') {
    super(message);
    this.name = 'InactiveDefinitionRuntimeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function slug(value) {
  const result = String(value || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!result || result === 'foxos' || result.startsWith('foxos-')) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulama için güvenli bir çalışma adı üretilemedi.',
      409,
      'inactive-definition-name-invalid'
    );
  }
  return result;
}

function durationNanoseconds(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)$/);
  if (!match) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın health-check süresi desteklenmiyor.',
      409,
      'inactive-definition-health-duration-unsupported'
    );
  }
  const multiplier = { ns: 1, us: 1e3, ms: 1e6, s: 1e9, m: 60e9, h: 3600e9 }[match[2]];
  const result = Math.round(Number(match[1]) * multiplier);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın health-check süresi geçersiz.',
      409,
      'inactive-definition-health-duration-invalid'
    );
  }
  return result;
}

function parseCompose(value) {
  const source = String(value || '');
  if (!source || Buffer.byteLength(source) > MAX_COMPOSE_BYTES) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın şifreli Compose tanımı eksik veya çok büyük.',
      409,
      'inactive-definition-compose-invalid'
    );
  }
  const document = YAML.parseDocument(source, { maxAliasCount: 50, uniqueKeys: true });
  if (document.errors.length) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın Compose tanımı güvenle ayrıştırılamadı.',
      409,
      'inactive-definition-compose-invalid'
    );
  }
  const compose = document.toJS({ maxAliasCount: 50 });
  if (!compose || typeof compose !== 'object' || Array.isArray(compose)) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın Compose tanımı geçersiz.',
      409,
      'inactive-definition-compose-invalid'
    );
  }
  return compose;
}

function environmentMap(rows = []) {
  const result = new Map();
  for (const row of rows) {
    const key = String(row && row.key || '');
    const value = String(row && row.value !== undefined ? row.value : '');
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || Buffer.byteLength(value) > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif uygulamanın şifreli environment tanımı geçersiz.',
        409,
        'inactive-definition-environment-invalid'
      );
    }
    if (result.has(key)) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif uygulamanın environment tanımında tekrar eden anahtar var.',
        409,
        'inactive-definition-environment-duplicate'
      );
    }
    result.set(key, value);
  }
  return result;
}

function resolvedEnvironment(service, recoveredEnvironment) {
  const definition = service.environment;
  if (definition === null || definition === undefined) return [];
  const entries = [];
  if (Array.isArray(definition)) {
    for (const item of definition) {
      if (typeof item !== 'string') {
        throw new InactiveDefinitionRuntimeError(
          'Pasif uygulamanın environment listesi desteklenmiyor.',
          409,
          'inactive-definition-environment-unsupported'
        );
      }
      const separator = item.indexOf('=');
      const key = separator === -1 ? item : item.slice(0, separator);
      const value = separator === -1 ? recoveredEnvironment.get(key) : item.slice(separator + 1);
      if (!ENVIRONMENT_KEY_PATTERN.test(key) || value === undefined) {
        throw new InactiveDefinitionRuntimeError(
          'Pasif uygulamanın gerekli environment değeri şifreli kayıtta bulunamadı.',
          409,
          'inactive-definition-environment-missing'
        );
      }
      entries.push(`${key}=${value}`);
    }
  } else if (typeof definition === 'object') {
    for (const [key, rawValue] of Object.entries(definition)) {
      if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
        throw new InactiveDefinitionRuntimeError(
          'Pasif uygulamanın environment anahtarı geçersiz.',
          409,
          'inactive-definition-environment-invalid'
        );
      }
      const value = rawValue === null
        ? recoveredEnvironment.get(key)
        : String(rawValue).replace(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/, (_, name) => (
          recoveredEnvironment.has(name) ? recoveredEnvironment.get(name) : `\${${name}}`
        ));
      if (value === undefined || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) {
        throw new InactiveDefinitionRuntimeError(
          'Pasif uygulamanın gerekli environment değeri şifreli kayıtta bulunamadı.',
          409,
          'inactive-definition-environment-missing'
        );
      }
      entries.push(`${key}=${value}`);
    }
  } else {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın environment tanımı desteklenmiyor.',
      409,
      'inactive-definition-environment-unsupported'
    );
  }
  return entries;
}

function isProviderMetadataEnvironmentKey(key) {
  return /^COOLIFY_/.test(key) || /^SERVICE_(?:FQDN|URL|NAME)_/.test(key);
}

function recoveredEnvFileEnvironment(rows = []) {
  return rows.filter((row) => (
    row && row.isRuntime !== false && row.isCoolifyMetadata !== true &&
    !isProviderMetadataEnvironmentKey(String(row.key || ''))
  )).map((row) => {
    const key = String(row.key || '');
    const value = String(row.value !== undefined ? row.value : '');
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || Buffer.byteLength(value) > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif uygulamanın şifreli env-file kaydı geçersiz.',
        409,
        'inactive-definition-environment-invalid'
      );
    }
    return `${key}=${value}`;
  });
}

function mergeEnvironment(...groups) {
  const values = new Map();
  for (const entry of groups.flat()) {
    const separator = entry.indexOf('=');
    values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return Array.from(values.entries()).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

function hasSupportedEnvFile(service) {
  if (service.env_file === null || service.env_file === undefined) return false;
  const entries = Array.isArray(service.env_file) ? service.env_file : [service.env_file];
  if (
    !entries.length || entries.length > 8 ||
    entries.some((entry) => typeof entry !== 'string' || !entry || entry.length > 1024 || entry.includes('\0'))
  ) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın env-file tanımı desteklenmiyor.',
      409,
      'inactive-definition-env-file-unsupported'
    );
  }
  return true;
}

function resolvedVolumes(service, compose) {
  if (service.volumes === null || service.volumes === undefined) return [];
  if (!Array.isArray(service.volumes) || service.volumes.length > 16) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın volume tanımı desteklenmiyor.',
      409,
      'inactive-definition-volume-unsupported'
    );
  }
  const declaredVolumes = compose.volumes && typeof compose.volumes === 'object' && !Array.isArray(compose.volumes)
    ? compose.volumes
    : {};
  return service.volumes.map((entry) => {
    let source;
    let target;
    let readOnly = false;
    if (typeof entry === 'string') {
      const parts = entry.split(':');
      if (parts.length < 2 || parts.length > 3) {
        throw new InactiveDefinitionRuntimeError(
          'Pasif uygulamanın volume bağlantısı desteklenmiyor.',
          409,
          'inactive-definition-volume-unsupported'
        );
      }
      [source, target] = parts;
      readOnly = parts[2] === 'ro';
    } else if (entry && typeof entry === 'object' && entry.type === 'volume') {
      source = entry.source;
      target = entry.target;
      readOnly = entry.read_only === true;
    } else {
      throw new InactiveDefinitionRuntimeError(
        'Bind mount veya desteklenmeyen volume türü pasif tanımdan otomatik başlatılamaz.',
        409,
        'inactive-definition-bind-mount-blocked'
      );
    }
    const declared = declaredVolumes[source];
    const actualSource = declared && typeof declared === 'object' && declared.name
      ? String(declared.name)
      : String(source || '');
    if (
      !VOLUME_NAME_PATTERN.test(actualSource) || !String(target || '').startsWith('/') ||
      String(target).includes('\0')
    ) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif uygulamanın named-volume tanımı geçersiz.',
        409,
        'inactive-definition-volume-invalid'
      );
    }
    return { Type: 'volume', Source: actualSource, Target: String(target), ReadOnly: readOnly };
  });
}

function domainFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text.includes('://') ? text : `https://${text}`);
    const domain = parsed.hostname.toLowerCase();
    return DOMAIN_PATTERN.test(domain) ? domain : null;
  } catch {
    return null;
  }
}

function recoveredRoute(recoveredEnvironment, service) {
  const routes = [];
  for (const [key, value] of recoveredEnvironment.entries()) {
    const match = key.match(/^SERVICE_FQDN_[A-Z0-9_]+_(\d{1,5})$/);
    const port = match ? Number(match[1]) : null;
    const domain = match ? domainFromValue(value) : null;
    if (domain && port >= 1 && port <= 65535) routes.push({ domain, path: '/', privatePort: port });
  }
  if (!routes.length) {
    const labels = Array.isArray(service.labels)
      ? Object.fromEntries(service.labels.map((entry) => {
        const separator = String(entry).indexOf('=');
        return separator === -1 ? [String(entry), ''] : [String(entry).slice(0, separator), String(entry).slice(separator + 1)];
      }))
      : service.labels && typeof service.labels === 'object' ? service.labels : {};
    const domains = Object.entries(labels)
      .filter(([key]) => key.endsWith('.rule'))
      .flatMap(([, value]) => Array.from(String(value).matchAll(/Host\(`([^`]+)`\)/g)).map((match) => match[1].toLowerCase()))
      .filter((domain) => DOMAIN_PATTERN.test(domain));
    const port = Object.entries(labels)
      .map(([key, value]) => key.includes('reverse_proxy') && String(value).match(/upstreams\s+(\d{1,5})/))
      .find(Boolean);
    if (domains.length && port) {
      for (const domain of domains) routes.push({ domain, path: '/', privatePort: Number(port[1]) });
    }
  }
  const unique = Array.from(new Map(routes.map((route) => [`${route.domain}:${route.privatePort}`, route])).values());
  if (unique.length !== 1) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın tek ve doğrulanabilir erişim alanı/portu bulunamadı.',
      409,
      'inactive-definition-route-ambiguous'
    );
  }
  return unique[0];
}

function applicationRoute(definition) {
  const routes = Array.from(new Set(String(definition.fqdn || '').split(',').map((value) => {
    const text = String(value || '').trim();
    if (!text) return null;
    try {
      const parsed = new URL(text);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      if (parsed.pathname && parsed.pathname !== '/') return null;
      const domain = parsed.hostname.toLowerCase();
      return DOMAIN_PATTERN.test(domain) ? domain : null;
    } catch {
      return null;
    }
  }).filter(Boolean)));
  const ports = Array.from(new Set(String(definition.ports_exposes || '').split(',')
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65535)));
  if (routes.length > 1 || ports.length !== 1) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif Git uygulamasının tek ve doğrulanabilir erişim alanı/portu bulunamadı.',
      409,
      'inactive-definition-route-ambiguous'
    );
  }
  return { domain: routes[0] || null, path: '/', privatePort: ports[0] };
}

function applicationEnvironment(rows = [], privatePort) {
  const values = new Map();
  for (const row of rows) {
    if (!row || row.isRuntime === false || row.isCoolifyMetadata === true) continue;
    const key = String(row.key || '');
    const value = String(row.value !== undefined ? row.value : '');
    if (
      !ENVIRONMENT_KEY_PATTERN.test(key) || Buffer.byteLength(value) > MAX_ENVIRONMENT_VALUE_BYTES
    ) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif Git uygulamasının şifreli environment tanımı geçersiz.',
        409,
        'inactive-definition-environment-invalid'
      );
    }
    if (values.has(key) && values.get(key) !== value) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif Git uygulamasının environment tanımında çelişen değer var.',
        409,
        'inactive-definition-environment-duplicate'
      );
    }
    values.set(key, value);
  }
  if (values.has('PORT') && values.get('PORT') !== String(privatePort)) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif Git uygulamasının PORT değeri erişim portuyla eşleşmiyor.',
      409,
      'inactive-definition-port-conflict'
    );
  }
  if (values.has('HOST') && values.get('HOST') !== '0.0.0.0') {
    throw new InactiveDefinitionRuntimeError(
      'Pasif Git uygulamasının HOST değeri sunucu ağına bağlanmaya uygun değil.',
      409,
      'inactive-definition-host-conflict'
    );
  }
  values.set('HOST', '0.0.0.0');
  values.set('PORT', String(privatePort));
  return Array.from(values.entries()).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

function compileApplicationContract(resource, recovered) {
  const definition = recovered.definition || {};
  if (String(definition.build_pack || '').toLowerCase() !== 'nixpacks') {
    throw new InactiveDefinitionRuntimeError(
      'Bu pasif Git uygulamasının build pack türü henüz desteklenmiyor.',
      409,
      'inactive-definition-buildpack-unsupported'
    );
  }
  const providerApplicationId = String(recovered.externalId || '').trim();
  if (!PROVIDER_APPLICATION_ID_PATTERN.test(providerApplicationId)) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif Git uygulamasının yerel build kimliği doğrulanamadı.',
      409,
      'inactive-definition-build-identity-invalid'
    );
  }
  const repository = String(definition.git_repository || '').trim();
  const branch = String(definition.git_branch || '').trim();
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !branch || branch.length > 256 || branch.includes('\0')
  ) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif Git uygulamasının kaynak tanımı doğrulanamadı.',
      409,
      'inactive-definition-source-invalid'
    );
  }
  if (
    definition.ports_mappings || definition.custom_docker_run_options ||
    definition.is_http_basic_auth_enabled === true
  ) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif Git uygulamasının çalışma seçenekleri otomatik başlatma güvenlik sınırının dışında.',
      409,
      'inactive-definition-runtime-unsupported'
    );
  }
  const route = applicationRoute(definition);
  const environment = applicationEnvironment(recovered.environment || [], route.privatePort);
  const applicationName = resource.name || repository.split('/').at(-1);
  const containerName = slug(applicationName);
  const expectedStatusCode = Number(definition.health_check_return_code);
  return {
    resourceId: resource.id,
    candidateResourceId: 'res_' + hash(`inactive-definition-runtime\0${resource.id}`, 32),
    applicationName,
    containerName,
    serviceName: containerName,
    imageStrategy: 'local-nixpacks-artifact',
    providerApplicationId,
    sourceRepository: repository,
    sourceBranch: branch,
    environment,
    environmentKeys: environment.map((entry) => entry.slice(0, entry.indexOf('='))).sort(),
    volumes: [],
    route,
    healthcheck: null,
    requiresDockerHealth: false,
    expectedStatusCode: Number.isInteger(expectedStatusCode) && expectedStatusCode >= 100 && expectedStatusCode <= 599
      ? expectedStatusCode
      : null,
    restartPolicy: 'unless-stopped',
    sourceRevision: resource.provenance && resource.provenance.externalDefinition &&
      resource.provenance.externalDefinition.recoveryArtifact &&
      resource.provenance.externalDefinition.recoveryArtifact.revision || null
  };
}

function imagePullPath(reference) {
  const digestSeparator = reference.lastIndexOf('@');
  if (digestSeparator > 0) {
    return '/images/create?fromImage=' + encodeURIComponent(reference);
  }
  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? reference.slice(0, lastColon) : reference;
  const tag = hasTag ? reference.slice(lastColon + 1) : 'latest';
  return '/images/create?fromImage=' + encodeURIComponent(repository) + '&tag=' + encodeURIComponent(tag);
}

function dockerHealthcheck(service) {
  const health = service.healthcheck;
  if (!health || typeof health !== 'object' || !Array.isArray(health.test) || !health.test.length) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulama doğrulanabilir bir health check taşımıyor.',
      409,
      'inactive-definition-health-missing'
    );
  }
  const test = health.test.map(String);
  if (!['CMD', 'CMD-SHELL'].includes(test[0]) || test.some((entry) => entry.includes('\0') || entry.length > 4096)) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın health check komutu desteklenmiyor.',
      409,
      'inactive-definition-health-unsupported'
    );
  }
  return {
    Test: test,
    Interval: durationNanoseconds(health.interval, 5e9),
    Timeout: durationNanoseconds(health.timeout, 20e9),
    Retries: Number.isInteger(health.retries) && health.retries > 0 && health.retries <= 100 ? health.retries : 10,
    StartPeriod: durationNanoseconds(health.start_period, 0)
  };
}

function unsupportedServiceField(service) {
  const fields = [
    ['build', service.build], ['privileged', service.privileged === true], ['devices', service.devices && service.devices.length],
    ['cap_add', service.cap_add && service.cap_add.length], ['pid', service.pid], ['ipc', service.ipc],
    ['uts', service.uts], ['network_mode', service.network_mode], ['extra_hosts', service.extra_hosts && service.extra_hosts.length],
    ['command', service.command], ['entrypoint', service.entrypoint]
  ];
  const match = fields.find(([, value]) => Boolean(value));
  return match && match[0] || null;
}

function compileContract(resource, recovered) {
  if (!resource || resource.kind !== 'provider-definition' || !RESOURCE_ID_PATTERN.test(String(resource.id || ''))) {
    throw new InactiveDefinitionRuntimeError('Pasif uygulama tanımı bulunamadı.', 404, 'inactive-definition-not-found');
  }
  if (
    !resource.management || resource.management.owner !== 'foxos' || resource.management.state !== 'active' ||
    resource.management.lifecycle !== 'inactive-definition-transfer'
  ) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulama henüz sunucu recovery otoritesine geçirilmemiş.',
      409,
      'inactive-definition-not-adopted'
    );
  }
  if (!recovered || recovered.schemaVersion !== 1 || !['service', 'application'].includes(recovered.providerKind)) {
    throw new InactiveDefinitionRuntimeError(
      'Bu pasif tanım türü henüz güvenli otomatik başlatmayı desteklemiyor.',
      409,
      'inactive-definition-kind-unsupported'
    );
  }
  if (recovered.providerKind === 'application') return compileApplicationContract(resource, recovered);
  const definition = recovered.definition || {};
  const compose = parseCompose(definition.docker_compose || definition.docker_compose_raw);
  const serviceEntries = Object.entries(compose.services || {});
  if (serviceEntries.length !== 1) {
    throw new InactiveDefinitionRuntimeError(
      'Yalnız tek servisli pasif Compose tanımları otomatik başlatılabilir.',
      409,
      'inactive-definition-service-count-unsupported'
    );
  }
  const [serviceName, service] = serviceEntries[0];
  if (!service || typeof service !== 'object' || Array.isArray(service) || unsupportedServiceField(service)) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif servisin çalışma sözleşmesi otomatik başlatma güvenlik sınırının dışında.',
      409,
      'inactive-definition-runtime-unsupported'
    );
  }
  const imageReference = String(service.image || '').trim();
  if (!IMAGE_PATTERN.test(imageReference)) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif servisin güvenli bir container image tanımı yok.',
      409,
      'inactive-definition-image-invalid'
    );
  }
  const recoveredEnvironment = environmentMap(recovered.environment || []);
  const usesEnvFile = hasSupportedEnvFile(service);
  const environment = mergeEnvironment(
    usesEnvFile ? recoveredEnvFileEnvironment(recovered.environment || []) : [],
    resolvedEnvironment(service, recoveredEnvironment)
  ).filter((entry) => !isProviderMetadataEnvironmentKey(entry.slice(0, entry.indexOf('='))));
  if (usesEnvFile && environment.length === 0) {
    throw new InactiveDefinitionRuntimeError(
      'Pasif uygulamanın env-file değerleri şifreli recovery kaydında bulunamadı.',
      409,
      'inactive-definition-environment-missing'
    );
  }
  const volumes = resolvedVolumes(service, compose);
  const route = recoveredRoute(recoveredEnvironment, service);
  const healthcheck = dockerHealthcheck(service);
  const containerName = slug(resource.name || serviceName);
  const candidateResourceId = 'res_' + hash(`inactive-definition-runtime\0${resource.id}`, 32);
  return {
    resourceId: resource.id,
    candidateResourceId,
    applicationName: resource.name || serviceName,
    containerName,
    serviceName,
    imageReference,
    imageStrategy: 'registry-image',
    environment,
    environmentKeys: environment.map((entry) => entry.slice(0, entry.indexOf('='))).sort(),
    volumes,
    route,
    healthcheck,
    requiresDockerHealth: true,
    expectedStatusCode: null,
    restartPolicy: ['no', 'always', 'unless-stopped'].includes(service.restart) ? service.restart : 'unless-stopped',
    sourceRevision: resource.provenance && resource.provenance.externalDefinition &&
      resource.provenance.externalDefinition.recoveryArtifact &&
      resource.provenance.externalDefinition.recoveryArtifact.revision || null
  };
}

function createInactiveDefinitionRuntimeManager({
  dataRoot,
  dockerRequest,
  resourceRegistry,
  readRecoveryArtifact,
  certificateImporter,
  ingressAuthority,
  internalHttpProbe = null,
  routingNetwork = 'foxos-routing',
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || !resourceRegistry ||
    typeof resourceRegistry.getLatest !== 'function' || typeof resourceRegistry.scan !== 'function' ||
    typeof readRecoveryArtifact !== 'function' || !certificateImporter ||
    typeof certificateImporter.importDomain !== 'function' || !ingressAuthority ||
    typeof ingressAuthority.stageRoutes !== 'function'
  ) throw new Error('Inactive-definition runtime manager requires Docker, Registry, recovery and ingress adapters');

  const operationsRoot = path.join(dataRoot, 'inactive-definition-runtimes', 'operations');
  const locks = new Set();

  function now() {
    return new Date(clock()).toISOString();
  }

  function persist(operation) {
    operation.updatedAt = now();
    atomicWriteJson(path.join(operationsRoot, operation.operationId + '.json'), operation);
    return operation;
  }

  function resourceFor(resourceId) {
    if (!RESOURCE_ID_PATTERN.test(String(resourceId || ''))) {
      throw new InactiveDefinitionRuntimeError('Pasif uygulama kimliği geçersiz.', 400, 'inactive-definition-id-invalid');
    }
    const snapshot = resourceRegistry.getLatest();
    const resource = snapshot && (snapshot.resources || []).find((entry) => entry.id === resourceId);
    if (!resource) throw new InactiveDefinitionRuntimeError('Pasif uygulama bulunamadı.', 404, 'inactive-definition-not-found');
    return { resource, snapshot };
  }

  function contractFor(resource) {
    const artifact = resource.provenance && resource.provenance.externalDefinition &&
      resource.provenance.externalDefinition.recoveryArtifact;
    const recovered = readRecoveryArtifact(artifact);
    if (!recovered || recovered.provider !== resource.provider) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif uygulamanın şifreli recovery kaydı doğrulanamadı.',
        409,
        'inactive-definition-recovery-invalid'
      );
    }
    return compileContract(resource, recovered);
  }

  function capability(resourceId) {
    try {
      const { resource } = resourceFor(resourceId);
      const contract = contractFor(resource);
      return {
        available: true,
        mode: contract.imageStrategy === 'local-nixpacks-artifact'
          ? 'local-nixpacks-artifact-recovery'
          : 'single-service-compose-recovery',
        domain: contract.route.domain,
        privatePort: contract.route.privatePort,
        persistentVolumes: contract.volumes.length,
        ...(contract.sourceRepository ? { sourceRepository: contract.sourceRepository } : {})
      };
    } catch (error) {
      return {
        available: false,
        code: error.code || 'inactive-definition-runtime-unavailable'
      };
    }
  }

  async function exactLegacyProxyId() {
    const containers = await dockerRequest('GET', '/containers/json?all=1');
    const matches = (containers || []).filter((container) => (
      (container.Names || []).includes('/coolify-proxy')
    ));
    if (matches.length !== 1 || !CONTAINER_ID_PATTERN.test(String(matches[0].Id || ''))) {
      throw new InactiveDefinitionRuntimeError(
        'Alan adının eski sertifika kaynağı doğrulanamadı.',
        409,
        'inactive-definition-certificate-source-unavailable'
      );
    }
    return matches[0].Id;
  }

  async function ensureContainerNameAvailable(name) {
    if (!CONTAINER_NAME_PATTERN.test(name)) {
      throw new InactiveDefinitionRuntimeError('Çalışma adı geçersiz.', 409, 'inactive-definition-name-invalid');
    }
    const containers = await dockerRequest('GET', '/containers/json?all=1');
    const existing = (containers || []).find((container) => (container.Names || []).includes('/' + name));
    if (existing) {
      throw new InactiveDefinitionRuntimeError(
        'Aynı okunabilir çalışma adı başka bir container tarafından kullanılıyor.',
        409,
        'inactive-definition-container-name-conflict'
      );
    }
  }

  async function ensureVolumes(volumes) {
    for (const volume of volumes) {
      try {
        const details = await dockerRequest('GET', '/volumes/' + encodeURIComponent(volume.Source));
        if (!details || details.Name !== volume.Source) throw new Error('mismatch');
      } catch {
        throw new InactiveDefinitionRuntimeError(
          'Pasif uygulamanın mevcut kalıcı volume verisi bulunamadı.',
          409,
          'inactive-definition-volume-missing'
        );
      }
    }
  }

  async function pullImage(reference) {
    await dockerRequest('POST', imagePullPath(reference));
    const details = await dockerRequest('GET', '/images/' + encodeURIComponent(reference) + '/json');
    const imageId = String(details && details.Id || '').toLowerCase();
    if (!IMAGE_ID_PATTERN.test(imageId)) {
      throw new InactiveDefinitionRuntimeError(
        'İndirilen image değişmez kimlikle doğrulanamadı.',
        502,
        'inactive-definition-image-proof-failed'
      );
    }
    return {
      imageId,
      repoDigests: (details.RepoDigests || []).map(String).filter((entry) => entry.includes('@sha256:')).sort()
    };
  }

  async function resolveLocalApplicationImage(contract) {
    const images = await dockerRequest('GET', '/images/json?all=1');
    const prefix = contract.providerApplicationId + ':';
    const candidates = (images || []).flatMap((image) => (
      (image.RepoTags || []).filter((reference) => String(reference).startsWith(prefix)).map((reference) => ({
        imageId: String(image.Id || '').toLowerCase(),
        reference: String(reference),
        sourceCommit: String(reference).slice(prefix.length).toLowerCase(),
        created: Number(image.Created) || 0,
        repoDigests: (image.RepoDigests || []).map(String).filter((entry) => entry.includes('@sha256:')).sort()
      }))
    )).filter((candidate) => (
      IMAGE_ID_PATTERN.test(candidate.imageId) && SOURCE_COMMIT_PATTERN.test(candidate.sourceCommit)
    ));
    if (!candidates.length) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif Git uygulamasının son başarılı yerel build imajı bulunamadı.',
        409,
        'inactive-definition-build-artifact-missing'
      );
    }
    candidates.sort((left, right) => (
      right.created - left.created || right.sourceCommit.localeCompare(left.sourceCommit)
    ));
    const selected = candidates[0];
    const details = await dockerRequest('GET', '/images/' + encodeURIComponent(selected.imageId) + '/json');
    if (String(details && details.Id || '').toLowerCase() !== selected.imageId) {
      throw new InactiveDefinitionRuntimeError(
        'Pasif Git uygulamasının yerel build imajı değişmez kimlikle doğrulanamadı.',
        409,
        'inactive-definition-image-proof-failed'
      );
    }
    const runtimeRepository = `server/${contract.containerName}`;
    const runtimeTag = 'git-' + selected.sourceCommit.slice(0, 12);
    const runtimeReference = `${runtimeRepository}:${runtimeTag}`;
    await dockerRequest(
      'POST',
      '/images/' + encodeURIComponent(selected.imageId) + '/tag?repo=' +
        encodeURIComponent(runtimeRepository) + '&tag=' + encodeURIComponent(runtimeTag)
    );
    const tagged = await dockerRequest('GET', '/images/' + encodeURIComponent(runtimeReference) + '/json');
    if (String(tagged && tagged.Id || '').toLowerCase() !== selected.imageId) {
      throw new InactiveDefinitionRuntimeError(
        'Sunucuya ait okunabilir image etiketi doğrulanamadı.',
        502,
        'inactive-definition-image-tag-proof-failed'
      );
    }
    return {
      imageId: selected.imageId,
      runtimeReference,
      sourceArtifactReference: selected.reference,
      sourceCommit: selected.sourceCommit,
      repoDigests: selected.repoDigests
    };
  }

  async function resolveImage(contract) {
    if (contract.imageStrategy === 'local-nixpacks-artifact') {
      return resolveLocalApplicationImage(contract);
    }
    const image = await pullImage(contract.imageReference);
    return {
      ...image,
      runtimeReference: contract.imageReference,
      sourceArtifactReference: contract.imageReference,
      sourceCommit: null
    };
  }

  async function waitForReady(containerId, imageId, requiresDockerHealth) {
    let last = null;
    for (let attempt = 0; attempt < 36; attempt += 1) {
      last = await dockerRequest('GET', '/containers/' + containerId + '/json');
      if (last && last.State && last.State.Running === true && last.Image === imageId) {
        if (!requiresDockerHealth || last.State.Health && last.State.Health.Status === 'healthy') return last;
      }
      if (last && last.State && ['exited', 'dead'].includes(last.State.Status)) break;
      await wait(5000);
    }
    throw new InactiveDefinitionRuntimeError(
      'Yeni çalışma örneği health check süresinde sağlıklı olmadı.',
      503,
      'inactive-definition-health-failed'
    );
  }

  async function waitForPublicProof(contract, routeId) {
    let lastError = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const proof = await ingressAuthority.httpsProbe({
          hostname: contract.route.domain,
          connectHost: 'foxos-gateway',
          requestPath: '/',
          expectedRouteId: routeId,
          timeoutMs: 15000
        });
        const statusAccepted = contract.expectedStatusCode
          ? proof.statusCode === contract.expectedStatusCode
          : proof.statusCode >= 200 && proof.statusCode < 400;
        if (proof.tlsValid === true && proof.expectedRoute === true && statusAccepted) return proof;
        lastError = new Error('public proof mismatch');
      } catch (error) {
        lastError = error;
      }
      await wait(2000);
    }
    throw new InactiveDefinitionRuntimeError(
      'Yeni çalışma public HTTPS üzerinden doğrulanamadı.',
      503,
      'inactive-definition-public-proof-failed',
      { cause: lastError }
    );
  }

  async function waitForInternalProof(contract, routeAlias) {
    if (typeof internalHttpProbe !== 'function') {
      throw new InactiveDefinitionRuntimeError(
        'Alan adı olmayan Git uygulaması için dahili HTTP doğrulayıcısı bulunmuyor.',
        503,
        'inactive-definition-internal-proof-unavailable'
      );
    }
    let lastStatusCode = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const proof = await internalHttpProbe({
          alias: routeAlias,
          privatePort: contract.route.privatePort,
          requestPath: '/'
        });
        lastStatusCode = Number(proof && proof.statusCode) || null;
        const statusAccepted = contract.expectedStatusCode
          ? lastStatusCode === contract.expectedStatusCode
          : lastStatusCode >= 200 && lastStatusCode < 400;
        if (statusAccepted) return { statusCode: lastStatusCode, internal: true };
      } catch { /* bounded retry */ }
      await wait(1000);
    }
    throw new InactiveDefinitionRuntimeError(
      'Yeni çalışma dahili HTTP üzerinden doğrulanamadı.',
      503,
      'inactive-definition-internal-proof-failed'
    );
  }

  async function activate(resourceId) {
    if (locks.has(resourceId)) {
      throw new InactiveDefinitionRuntimeError(
        'Bu uygulama için başka bir etkinleştirme işlemi sürüyor.',
        409,
        'inactive-definition-operation-locked'
      );
    }
    locks.add(resourceId);
    let operation = null;
    let candidateContainerId = null;
    let stagedRouteIds = [];
    let contract = null;
    try {
      const { resource } = resourceFor(resourceId);
      contract = contractFor(resource);
      await ensureContainerNameAvailable(contract.containerName);
      await ensureVolumes(contract.volumes);

      if (contract.route.domain) {
        const proxyContainerId = await exactLegacyProxyId();
        await certificateImporter.importDomain({
          domain: contract.route.domain,
          proxyContainerId
        });
        await ingressAuthority.reconcileInactiveDomains([{
          domain: contract.route.domain,
          resourceId
        }]);
      }

      const image = await resolveImage(contract);
      const operationId = 'rtop_' + randomUUID().replace(/-/g, '');
      if (!OPERATION_ID_PATTERN.test(operationId)) {
        throw new InactiveDefinitionRuntimeError('Etkinleştirme işlem kimliği geçersiz.', 500, 'operation-id-invalid');
      }
      const routeAlias = 'app-' + hash(resourceId, 20);
      const routeId = contract.route.domain
        ? 'smroute_' + hash(`${operationId}\0${contract.route.domain}\0/`, 24)
        : null;
      operation = {
        schemaVersion: INACTIVE_RUNTIME_SCHEMA_VERSION,
        operationId,
        resourceId,
        mode: 'inactive-definition-runtime',
        status: 'preparing',
        sourceRevision: contract.sourceRevision,
        application: {
          name: contract.applicationName,
          containerName: contract.containerName,
          serviceName: contract.serviceName
        },
        image: {
          requestedReference: image.runtimeReference,
          sourceArtifactReference: image.sourceArtifactReference,
          imageId: image.imageId,
          repoDigests: image.repoDigests,
          sourceCommit: image.sourceCommit
        },
        source: contract.sourceRepository ? {
          type: 'git',
          repository: contract.sourceRepository,
          branch: contract.sourceBranch,
          commit: image.sourceCommit
        } : null,
        environment: {
          keys: contract.environmentKeys,
          valuesIncluded: false
        },
        persistence: {
          namedVolumes: contract.volumes.map((volume) => ({
            name: volume.Source,
            target: volume.Target,
            readOnly: volume.ReadOnly
          })),
          existingVolumesReused: true,
          dataCopied: false
        },
        route: {
          routeId,
          domain: contract.route.domain,
          path: '/',
          privatePort: contract.route.privatePort,
          alias: routeAlias
        },
        candidateContainerId: null,
        candidateResourceId: contract.candidateResourceId,
        startedAt: now(),
        guarantees: {
          providerApiCalled: false,
          providerRuntimeRequired: false,
          providerLabelsCopied: false,
          secretValuesIncluded: false,
          existingVolumePreserved: true
        }
      };
      persist(operation);

      const containerPayload = {
        Image: image.runtimeReference,
        Env: contract.environment,
        Labels: {
          'com.foxos.managed': 'true',
          'com.foxos.resource.id': contract.candidateResourceId,
          'com.foxos.app.id': resourceId,
          'com.foxos.app.name': contract.applicationName,
          'com.foxos.image.reference': image.runtimeReference
        },
        ExposedPorts: { [`${contract.route.privatePort}/tcp`]: {} },
        HostConfig: {
          NetworkMode: routingNetwork,
          RestartPolicy: { Name: contract.restartPolicy, MaximumRetryCount: 0 },
          Mounts: contract.volumes,
          Privileged: false,
          SecurityOpt: ['no-new-privileges:true']
        },
        NetworkingConfig: {
          EndpointsConfig: { [routingNetwork]: { Aliases: [routeAlias] } }
        }
      };
      if (contract.healthcheck) containerPayload.Healthcheck = contract.healthcheck;
      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(contract.containerName),
        containerPayload
      );
      candidateContainerId = created && created.Id;
      if (!CONTAINER_ID_PATTERN.test(String(candidateContainerId || ''))) {
        throw new InactiveDefinitionRuntimeError(
          'Docker yeni çalışma kimliğini döndürmedi.',
          502,
          'inactive-definition-container-create-failed'
        );
      }
      operation.candidateContainerId = candidateContainerId;
      operation.status = 'starting';
      persist(operation);
      await dockerRequest('POST', '/containers/' + candidateContainerId + '/start');
      await waitForReady(candidateContainerId, image.imageId, contract.requiresDockerHealth);

      let proof;
      if (contract.route.domain) {
        const staged = await ingressAuthority.stageRoutes([{
          routeId,
          operationId,
          domain: contract.route.domain,
          path: '/',
          alias: routeAlias,
          privatePort: contract.route.privatePort
        }]);
        stagedRouteIds = staged.map((route) => route.routeId);
        operation.status = 'route-staged';
        persist(operation);
        await ingressAuthority.switchDomain(contract.route.domain, 'foxos');
        proof = await waitForPublicProof(contract, routeId);
      } else {
        proof = await waitForInternalProof(contract, routeAlias);
      }
      operation.status = 'server-definition-runtime-active';
      operation.trafficProof = {
        healthy: true,
        tlsValid: contract.route.domain ? true : null,
        expectedRoute: contract.route.domain ? true : null,
        internal: contract.route.domain ? false : true,
        statusCode: proof.statusCode,
        verifiedAt: now()
      };
      operation.completedAt = now();
      persist(operation);
      await resourceRegistry.scan();
      return operation;
    } catch (error) {
      if (operation) {
        operation.status = 'failed';
        operation.failure = { code: error.code || 'inactive-definition-runtime-failed' };
        operation.failedAt = now();
        persist(operation);
      }
      if (stagedRouteIds.length) {
        try { await ingressAuthority.removeRoutes(stagedRouteIds); } catch { /* preserve original error */ }
      }
      if (candidateContainerId) {
        try { await dockerRequest('POST', '/containers/' + candidateContainerId + '/stop?t=10'); } catch { /* already stopped */ }
        try { await dockerRequest('DELETE', '/containers/' + candidateContainerId + '?force=true'); } catch { /* preserve original error */ }
      }
      if (contract && contract.route.domain) {
        try {
          await ingressAuthority.reconcileInactiveDomains([{
            domain: contract.route.domain,
            resourceId
          }]);
        } catch { /* preserve original error */ }
      }
      if (error instanceof InactiveDefinitionRuntimeError) throw error;
      throw new InactiveDefinitionRuntimeError(
        'Pasif uygulama güvenli biçimde etkinleştirilemedi.',
        502,
        'inactive-definition-runtime-failed'
      );
    } finally {
      locks.delete(resourceId);
    }
  }

  fs.mkdirSync(operationsRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(operationsRoot, 0o700);
  return { activate, capability, paths: { operationsRoot } };
}

module.exports = {
  INACTIVE_RUNTIME_SCHEMA_VERSION,
  InactiveDefinitionRuntimeError,
  compileContract,
  createInactiveDefinitionRuntimeManager,
  imagePullPath
};
