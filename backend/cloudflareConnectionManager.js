const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const CONFIG_SCHEMA_VERSION = 1;
const PROVIDER = 'cloudflare';
const API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const PUBLIC_IPV4_URL = 'https://1.1.1.1/cdn-cgi/trace';
const DISCONNECT_CONFIRMATION = 'DISCONNECT CLOUDFLARE';
const IDENTIFIER_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

class CloudflareConnectionError extends Error {
  constructor(message, statusCode = 409, code = 'cloudflare-connection-error') {
    super(message);
    this.name = 'CloudflareConnectionError';
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

function removeFileIfPresent(target) {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function hash(value, length = 64) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length);
}

function isPublicIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const octets = value.split('.').map(Number);
  return !(
    octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 0 && [0, 2].includes(octets[2])) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 198 && [18, 19].includes(octets[1])) ||
    (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
    octets[0] >= 224
  );
}

function validateIdentifier(value, label) {
  if (!IDENTIFIER_PATTERN.test(String(value || ''))) {
    throw new CloudflareConnectionError(`${label} kimliği geçersiz.`, 409, 'cloudflare-identity-invalid');
  }
  return value;
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new CloudflareConnectionError(
      'Geçerli bir Cloudflare API Token girin.',
      400,
      'cloudflare-token-invalid'
    );
  }
  return token;
}

function normalizeDomain(value) {
  const domain = String(value || '').trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new CloudflareConnectionError('DNS hostname geçersiz.', 400, 'cloudflare-domain-invalid');
  }
  return domain;
}

function cloudflareMessage(payload, fallback) {
  const message = payload && Array.isArray(payload.errors) && payload.errors
    .map((entry) => String(entry && entry.message || '').trim())
    .find(Boolean);
  return (message || fallback).slice(0, 500);
}

async function defaultApiRequest({ method = 'GET', apiPath, token, query = null, body = null }) {
  const url = new URL(API_BASE_URL + apiPath);
  for (const [name, value] of Object.entries(query || {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    throw new CloudflareConnectionError(
      error.name === 'AbortError' ? 'Cloudflare API zaman aşımına uğradı.' : 'Cloudflare API bağlantısı kurulamadı.',
      503,
      'cloudflare-api-unavailable'
    );
  } finally {
    clearTimeout(timeout);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CloudflareConnectionError('Cloudflare API geçersiz yanıt verdi.', 502, 'cloudflare-api-invalid-response');
  }
  if (!response.ok || payload.success !== true) {
    const permissionFailure = [401, 403].includes(response.status);
    throw new CloudflareConnectionError(
      permissionFailure
        ? 'Cloudflare token yetkisi yetersiz. Zone Read ve DNS Edit izinlerini kontrol edin.'
        : cloudflareMessage(payload, 'Cloudflare API işlemi başarısız oldu.'),
      permissionFailure ? 409 : 502,
      permissionFailure ? 'cloudflare-permission-required' : 'cloudflare-api-error'
    );
  }
  return payload;
}

async function defaultDetectPublicIpv4() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(PUBLIC_IPV4_URL, { signal: controller.signal });
  } catch {
    throw new CloudflareConnectionError(
      'Sunucunun public IPv4 adresi otomatik belirlenemedi.',
      503,
      'public-ipv4-detection-failed'
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new CloudflareConnectionError(
      'Sunucunun public IPv4 adresi otomatik belirlenemedi.',
      503,
      'public-ipv4-detection-failed'
    );
  }
  const trace = await response.text();
  const address = trace.split(/\r?\n/)
    .find((line) => line.startsWith('ip='))
    ?.slice(3).trim();
  if (!isPublicIpv4(address)) {
    throw new CloudflareConnectionError(
      'Sunucunun genel IPv4 adresi doğrulanamadı.',
      409,
      'public-ipv4-unverified'
    );
  }
  return address;
}

function recordSnapshot(record) {
  return {
    id: String(record.id || ''),
    type: String(record.type || ''),
    name: String(record.name || '').toLowerCase(),
    content: String(record.content || ''),
    ttl: Number(record.ttl) || 1,
    proxied: record.proxied === true,
    comment: typeof record.comment === 'string' ? record.comment : null,
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    settings: record.settings && typeof record.settings === 'object' ? record.settings : null
  };
}

function recordBody(record) {
  return {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl || 1,
    proxied: record.proxied === true,
    ...(record.comment ? { comment: record.comment } : {}),
    ...(record.tags && record.tags.length ? { tags: record.tags } : {}),
    ...(record.settings ? { settings: record.settings } : {})
  };
}

function dnsPlanFingerprint({ domain, desiredAddress, aRecords, aaaaRecords, cnameRecords }) {
  return hash({
    domain,
    desiredAddress,
    aRecords: aRecords.map(recordSnapshot),
    aaaaRecords: aaaaRecords.map(recordSnapshot),
    cnameRecords: cnameRecords.map(recordSnapshot)
  });
}

function createCloudflareConnectionManager({
  dataRoot,
  encryptionStore,
  apiRequest = defaultApiRequest,
  detectPublicIpv4 = defaultDetectPublicIpv4,
  clock = () => new Date()
}) {
  if (!dataRoot || !encryptionStore || typeof apiRequest !== 'function' || typeof detectPublicIpv4 !== 'function') {
    throw new Error('Cloudflare connection manager requires data, encryption and network adapters');
  }

  const root = path.join(dataRoot, 'connections', PROVIDER);
  const configFile = path.join(root, 'config.json');
  const credentialsFile = path.join(root, 'token.foxosenc');
  const credentialsContext = {
    purpose: 'foxos-provider-connection',
    schemaVersion: CONFIG_SCHEMA_VERSION,
    provider: PROVIDER
  };

  function now() {
    return new Date(clock()).toISOString();
  }

  function loadConfig() {
    const config = readJson(configFile, null);
    if (!config) return null;
    if (
      config.schemaVersion !== CONFIG_SCHEMA_VERSION || config.provider !== PROVIDER ||
      !Array.isArray(config.zones) || !isPublicIpv4(config.publicIpv4) ||
      typeof config.revision !== 'string' || typeof config.tokenFingerprint !== 'string'
    ) {
      throw new CloudflareConnectionError(
        'Cloudflare bağlantı kaydı desteklenmiyor.',
        409,
        'cloudflare-config-invalid'
      );
    }
    return config;
  }

  function credentialsAvailable() {
    try {
      return fs.statSync(credentialsFile).isFile();
    } catch {
      return false;
    }
  }

  function loadToken() {
    if (!credentialsAvailable()) {
      throw new CloudflareConnectionError('Cloudflare bağlı değil.', 409, 'cloudflare-not-connected');
    }
    try {
      const token = validateToken(encryptionStore.decryptBuffer(
        fs.readFileSync(credentialsFile),
        credentialsContext
      ).toString('utf8'));
      const config = loadConfig();
      if (!config || encryptionStore.fingerprint(token) !== config.tokenFingerprint) {
        throw new CloudflareConnectionError(
          'Cloudflare bağlantı kaydı ile şifreli token eşleşmiyor.',
          409,
          'cloudflare-token-revision-mismatch'
        );
      }
      return token;
    } catch (error) {
      if (error instanceof CloudflareConnectionError) throw error;
      throw new CloudflareConnectionError(
        'Cloudflare token şifresi çözülemedi.',
        409,
        'cloudflare-token-unavailable'
      );
    }
  }

  function publicStatus(config = loadConfig()) {
    const connected = Boolean(config && credentialsAvailable());
    return {
      id: PROVIDER,
      name: 'Cloudflare',
      connected,
      ready: connected && config.zones.length > 0 && isPublicIpv4(config.publicIpv4),
      zones: config ? config.zones.map((zone) => zone.name).sort() : [],
      zoneCount: config ? config.zones.length : 0,
      publicIpv4: config ? config.publicIpv4 : null,
      configuredAt: config ? config.configuredAt : null,
      lastVerifiedAt: config ? config.lastVerifiedAt : null,
      tokenStoredEncrypted: connected,
      tokenIncluded: false,
      permissions: ['Zone Read', 'DNS Edit'],
      optional: true,
      paidServiceRequired: false
    };
  }

  async function request(token, method, apiPath, options = {}) {
    return apiRequest({ method, apiPath, token, ...options });
  }

  async function verifyTokenAndZones(token) {
    const verified = await request(token, 'GET', '/user/tokens/verify');
    if (!verified.result || verified.result.status !== 'active') {
      throw new CloudflareConnectionError('Cloudflare token etkin değil.', 409, 'cloudflare-token-inactive');
    }
    const zoneResults = [];
    for (let page = 1; page <= 20; page += 1) {
      const zonesResponse = await request(token, 'GET', '/zones', {
        query: { page, per_page: 50, status: 'active' }
      });
      zoneResults.push(...(Array.isArray(zonesResponse.result) ? zonesResponse.result : []));
      const totalPages = Number(zonesResponse.result_info && zonesResponse.result_info.total_pages) || 1;
      if (page >= totalPages) break;
      if (page === 20) {
        throw new CloudflareConnectionError(
          'Cloudflare zone listesi güvenli sınırı aştı.',
          409,
          'cloudflare-zone-limit-exceeded'
        );
      }
    }
    const zones = zoneResults
      .filter((zone) => IDENTIFIER_PATTERN.test(String(zone.id || '')) && DOMAIN_PATTERN.test(String(zone.name || '').toLowerCase()))
      .map((zone) => ({ id: zone.id, name: zone.name.toLowerCase() }))
      .filter((zone, index, values) => values.findIndex((candidate) => candidate.id === zone.id) === index)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (!zones.length) {
      throw new CloudflareConnectionError(
        'Token ile erişilebilen etkin DNS bölgesi bulunamadı.',
        409,
        'cloudflare-zone-required'
      );
    }
    for (const zone of zones) {
      await request(token, 'GET', `/zones/${zone.id}/dns_records`, {
        query: { page: 1, per_page: 1 }
      });
    }
    return zones;
  }

  async function configure(input = {}) {
    const token = validateToken(input.apiToken);
    const [zones, detectedAddress] = await Promise.all([
      verifyTokenAndZones(token),
      detectPublicIpv4()
    ]);
    const publicIpv4 = detectedAddress;
    if (!isPublicIpv4(publicIpv4)) {
      throw new CloudflareConnectionError('Public IPv4 adresi geçersiz.', 400, 'public-ipv4-invalid');
    }
    const configuredAt = now();
    const config = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      provider: PROVIDER,
      revision: 'cfrev_' + crypto.randomBytes(16).toString('hex'),
      publicIpv4,
      zones,
      tokenFingerprint: encryptionStore.fingerprint(token),
      configuredAt,
      lastVerifiedAt: configuredAt,
      tokenIncluded: false,
      tokenStoredEncrypted: true
    };
    ensureDirectory(root);
    const previousCredentials = credentialsAvailable() ? fs.readFileSync(credentialsFile) : null;
    const previousConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile) : null;
    try {
      encryptionStore.atomicWriteBuffer(
        credentialsFile,
        encryptionStore.encryptBuffer(Buffer.from(token, 'utf8'), credentialsContext)
      );
      atomicWriteJson(configFile, config);
    } catch (error) {
      try {
        if (previousCredentials) encryptionStore.atomicWriteBuffer(credentialsFile, previousCredentials);
        else removeFileIfPresent(credentialsFile);
        if (previousConfig) encryptionStore.atomicWriteBuffer(configFile, previousConfig);
        else removeFileIfPresent(configFile);
      } catch (restoreError) {
        throw new CloudflareConnectionError(
          `Cloudflare bağlantısı kaydedilemedi ve önceki bağlantı kaydı geri yüklenemedi: ${restoreError.message}`,
          503,
          'cloudflare-config-rollback-attention-required'
        );
      }
      throw error;
    }
    return publicStatus(config);
  }

  async function verifyStored() {
    const config = loadConfig();
    if (!config) throw new CloudflareConnectionError('Cloudflare bağlı değil.', 409, 'cloudflare-not-connected');
    const token = loadToken();
    const [zones, publicIpv4] = await Promise.all([
      verifyTokenAndZones(token),
      detectPublicIpv4()
    ]);
    const updated = {
      ...config,
      zones,
      publicIpv4,
      lastVerifiedAt: now()
    };
    atomicWriteJson(configFile, updated);
    return publicStatus(updated);
  }

  function disconnect(confirmation) {
    if (confirmation !== DISCONNECT_CONFIRMATION) {
      throw new CloudflareConnectionError(
        'Cloudflare bağlantısını kesme onayı geçersiz.',
        400,
        'cloudflare-disconnect-confirmation-invalid'
      );
    }
    const tokenRemoved = removeFileIfPresent(credentialsFile);
    const configRemoved = removeFileIfPresent(configFile);
    return {
      tokenRemoved,
      configRemoved,
      dnsRecordsPreserved: true,
      connection: publicStatus(null)
    };
  }

  function zoneForDomain(config, domain) {
    return [...config.zones]
      .sort((left, right) => right.name.length - left.name.length)
      .find((zone) => domain === zone.name || domain.endsWith('.' + zone.name)) || null;
  }

  async function recordsForDomain(token, zone, domain) {
    validateIdentifier(zone.id, 'Cloudflare zone');
    const response = await request(token, 'GET', `/zones/${zone.id}/dns_records`, {
      query: { name: domain, page: 1, per_page: 5000 }
    });
    return (Array.isArray(response.result) ? response.result : [])
      .filter((record) => String(record.name || '').toLowerCase() === domain)
      .map(recordSnapshot);
  }

  async function planDns(domainInput) {
    const config = loadConfig();
    if (!config || !credentialsAvailable()) return null;
    const domain = normalizeDomain(domainInput);
    const zone = zoneForDomain(config, domain);
    if (!zone) return null;
    const token = loadToken();
    const records = await recordsForDomain(token, zone, domain);
    const aRecords = records.filter((record) => record.type === 'A');
    const aaaaRecords = records.filter((record) => record.type === 'AAAA');
    const cnameRecords = records.filter((record) => record.type === 'CNAME');
    if (cnameRecords.length) {
      throw new CloudflareConnectionError(
        'Bu hostname Cloudflare üzerinde CNAME olarak kullanılıyor; otomatik olarak üzerine yazılmadı.',
        409,
        'cloudflare-cname-conflict'
      );
    }
    if (aRecords.length > 1) {
      throw new CloudflareConnectionError(
        'Bu hostname için birden fazla A kaydı var; otomatik değişiklik güvenle yapılamıyor.',
        409,
        'cloudflare-a-record-ambiguous'
      );
    }
    const previousA = aRecords[0] || null;
    const action = !previousA
      ? 'create'
      : previousA.content !== config.publicIpv4 || previousA.proxied === true
        ? 'update'
        : aaaaRecords.length
          ? 'remove-ipv6'
          : 'none';
    return {
      schemaVersion: 1,
      provider: PROVIDER,
      connectionRevision: config.revision,
      zoneId: zone.id,
      zoneName: zone.name,
      domain,
      desiredAddress: config.publicIpv4,
      previousA,
      previousAAAA: aaaaRecords,
      action,
      mutationRequired: action !== 'none',
      removesIpv6: aaaaRecords.length,
      recordFingerprint: dnsPlanFingerprint({
        domain,
        desiredAddress: config.publicIpv4,
        aRecords,
        aaaaRecords,
        cnameRecords
      })
    };
  }

  async function assertPlanFresh(plan) {
    if (!plan || plan.provider !== PROVIDER || plan.schemaVersion !== 1) {
      throw new CloudflareConnectionError('Cloudflare DNS planı geçersiz.', 409, 'cloudflare-dns-plan-invalid');
    }
    const config = loadConfig();
    if (!config || config.revision !== plan.connectionRevision || config.publicIpv4 !== plan.desiredAddress) {
      throw new CloudflareConnectionError(
        'Cloudflare bağlantısı kontrolden sonra değişti. Yeniden kontrol edin.',
        409,
        'cloudflare-dns-plan-stale'
      );
    }
    const fresh = await planDns(plan.domain);
    if (!fresh || fresh.zoneId !== plan.zoneId || fresh.recordFingerprint !== plan.recordFingerprint) {
      throw new CloudflareConnectionError(
        'Cloudflare DNS kayıtları kontrolden sonra değişti. Yeniden kontrol edin.',
        409,
        'cloudflare-dns-plan-stale'
      );
    }
    return fresh;
  }

  async function rollbackAppliedChange(token, receipt, { verify = true } = {}) {
    if (!receipt || receipt.provider !== PROVIDER || receipt.schemaVersion !== 1) return null;
    validateIdentifier(receipt.zoneId, 'Cloudflare zone');
    if (verify) await prepareRollback(receipt);
    if (receipt.aAction === 'create' && receipt.appliedA) {
      validateIdentifier(receipt.appliedA.id, 'Cloudflare DNS record');
      await request(token, 'DELETE', `/zones/${receipt.zoneId}/dns_records/${receipt.appliedA.id}`);
    } else if (receipt.aAction === 'update' && receipt.previousA) {
      validateIdentifier(receipt.previousA.id, 'Cloudflare DNS record');
      await request(token, 'PATCH', `/zones/${receipt.zoneId}/dns_records/${receipt.previousA.id}`, {
        body: recordBody(receipt.previousA)
      });
    }
    for (const record of receipt.removedAAAA || []) {
      await request(token, 'POST', `/zones/${receipt.zoneId}/dns_records`, {
        body: recordBody(record)
      });
    }
    return {
      provider: PROVIDER,
      domain: receipt.domain,
      restored: true,
      restoredA: receipt.aAction !== 'none',
      restoredAAAA: (receipt.removedAAAA || []).length,
      completedAt: now()
    };
  }

  async function applyDnsPlan(plan) {
    const fresh = await assertPlanFresh(plan);
    if (!fresh.mutationRequired) return null;
    const token = loadToken();
    const receipt = {
      schemaVersion: 1,
      provider: PROVIDER,
      connectionRevision: fresh.connectionRevision,
      zoneId: fresh.zoneId,
      zoneName: fresh.zoneName,
      domain: fresh.domain,
      desiredAddress: fresh.desiredAddress,
      aAction: fresh.action === 'create' ? 'create' : fresh.action === 'update' ? 'update' : 'none',
      previousA: fresh.previousA,
      removedAAAA: [],
      appliedA: null,
      startedAt: now()
    };
    try {
      if (receipt.aAction === 'create') {
        const response = await request(token, 'POST', `/zones/${fresh.zoneId}/dns_records`, {
          body: {
            type: 'A',
            name: fresh.domain,
            content: fresh.desiredAddress,
            ttl: 1,
            proxied: false,
            comment: 'Managed by server access link'
          }
        });
        receipt.appliedA = recordSnapshot(response.result || {});
        validateIdentifier(receipt.appliedA.id, 'Cloudflare DNS record');
        if (
          receipt.appliedA.type !== 'A' || receipt.appliedA.name !== fresh.domain ||
          receipt.appliedA.content !== fresh.desiredAddress || receipt.appliedA.proxied !== false
        ) {
          throw new CloudflareConnectionError(
            'Cloudflare oluşturulan A kaydını beklenen değerlerle doğrulamadı.',
            502,
            'cloudflare-dns-write-unverified'
          );
        }
      } else if (receipt.aAction === 'update') {
        validateIdentifier(fresh.previousA.id, 'Cloudflare DNS record');
        const response = await request(token, 'PATCH', `/zones/${fresh.zoneId}/dns_records/${fresh.previousA.id}`, {
          body: {
            type: 'A',
            name: fresh.domain,
            content: fresh.desiredAddress,
            ttl: 1,
            proxied: false,
            comment: 'Managed by server access link'
          }
        });
        receipt.appliedA = recordSnapshot(response.result || {});
        validateIdentifier(receipt.appliedA.id, 'Cloudflare DNS record');
        if (
          receipt.appliedA.id !== fresh.previousA.id || receipt.appliedA.type !== 'A' ||
          receipt.appliedA.name !== fresh.domain || receipt.appliedA.content !== fresh.desiredAddress ||
          receipt.appliedA.proxied !== false
        ) {
          throw new CloudflareConnectionError(
            'Cloudflare güncellenen A kaydını beklenen değerlerle doğrulamadı.',
            502,
            'cloudflare-dns-write-unverified'
          );
        }
      }
      for (const record of fresh.previousAAAA) {
        validateIdentifier(record.id, 'Cloudflare DNS record');
        await request(token, 'DELETE', `/zones/${fresh.zoneId}/dns_records/${record.id}`);
        receipt.removedAAAA.push(record);
      }
      receipt.completedAt = now();
      return receipt;
    } catch (error) {
      try {
        await rollbackAppliedChange(token, receipt, { verify: false });
      } catch (rollbackError) {
        throw new CloudflareConnectionError(
          `Cloudflare DNS işlemi yarım kaldı ve otomatik geri alma tamamlanamadı: ${rollbackError.message}`,
          503,
          'cloudflare-dns-rollback-attention-required'
        );
      }
      if (error instanceof CloudflareConnectionError) throw error;
      throw new CloudflareConnectionError('Cloudflare DNS işlemi tamamlanamadı.', 502, 'cloudflare-dns-apply-failed');
    }
  }

  async function prepareRollback(receipt) {
    const config = loadConfig();
    if (!config || config.revision !== receipt.connectionRevision) {
      throw new CloudflareConnectionError(
        'DNS kaydını geri almak için kullanılan Cloudflare bağlantısı artık etkin değil.',
        409,
        'cloudflare-dns-rollback-connection-stale'
      );
    }
    const token = loadToken();
    const zone = zoneForDomain(config, normalizeDomain(receipt.domain));
    if (!zone || zone.id !== receipt.zoneId) {
      throw new CloudflareConnectionError('Cloudflare DNS bölgesi değişti.', 409, 'cloudflare-dns-rollback-zone-stale');
    }
    const records = await recordsForDomain(token, zone, receipt.domain);
    const currentA = records.filter((record) => record.type === 'A');
    const currentAAAA = records.filter((record) => record.type === 'AAAA');
    if (currentAAAA.length) {
      throw new CloudflareConnectionError(
        'Hostname için geri alma sonrasında eklenmiş AAAA kaydı var; otomatik olarak üzerine yazılmadı.',
        409,
        'cloudflare-dns-rollback-drift'
      );
    }
    if (receipt.aAction !== 'none') {
      if (
        currentA.length !== 1 || !receipt.appliedA || currentA[0].id !== receipt.appliedA.id ||
        currentA[0].content !== receipt.desiredAddress || currentA[0].proxied !== false
      ) {
        throw new CloudflareConnectionError(
          'Cloudflare A kaydı işlemden sonra değişti; otomatik geri alma durduruldu.',
          409,
          'cloudflare-dns-rollback-drift'
        );
      }
    } else if (
      !receipt.previousA || currentA.length !== 1 || currentA[0].id !== receipt.previousA.id ||
      currentA[0].content !== receipt.desiredAddress || currentA[0].proxied !== false
    ) {
      throw new CloudflareConnectionError(
        'Cloudflare A kaydı işlemden sonra değişti; otomatik geri alma durduruldu.',
        409,
        'cloudflare-dns-rollback-drift'
      );
    }
    return { token, records };
  }

  async function rollbackDnsChange(receipt) {
    if (!receipt) return null;
    const prepared = await prepareRollback(receipt);
    return rollbackAppliedChange(prepared.token, receipt, { verify: false });
  }

  function publicDnsPlan(plan) {
    if (!plan) return null;
    return {
      provider: PROVIDER,
      providerName: 'Cloudflare',
      zone: plan.zoneName,
      publicIpv4: plan.desiredAddress,
      action: plan.action,
      mutationRequired: plan.mutationRequired,
      removesIpv6: plan.removesIpv6
    };
  }

  return {
    applyDnsPlan,
    assertPlanFresh,
    configure,
    disconnect,
    paths: { root, configFile, credentialsFile },
    planDns,
    prepareRollback,
    publicDnsPlan,
    rollbackDnsChange,
    status: publicStatus,
    verifyStored
  };
}

module.exports = {
  CloudflareConnectionError,
  DISCONNECT_CONFIRMATION,
  createCloudflareConnectionManager,
  isPublicIpv4
};
