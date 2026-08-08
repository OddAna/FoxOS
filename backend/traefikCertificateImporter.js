const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const CERTIFICATE_IMPORT_SCHEMA_VERSION = 1;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const MAX_ACME_STORAGE_BYTES = 16 * 1024 * 1024;

class CertificateImportError extends Error {
  constructor(message, statusCode = 409, code = 'certificate-import-error') {
    super(message);
    this.name = 'CertificateImportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function atomicWrite(target, value, mode = 0o600) {
  ensureDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    '.' + path.basename(target) + '.' + crypto.randomUUID().replace(/-/g, '') + '.tmp'
  );
  try {
    fs.writeFileSync(temporary, value, { mode, flag: 'wx' });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename or cleanup already completed */ }
  }
}

function publicKeysMatch(certificate, privateKey) {
  const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const derivedKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return Buffer.from(certificateKey).equals(Buffer.from(derivedKey));
}

function createTraefikCertificateImporter({
  dataRoot,
  dockerRequest,
  hostRoot = '/host',
  clock = () => new Date()
}) {
  if (!dataRoot || typeof dockerRequest !== 'function' || !hostRoot) {
    throw new Error('Traefik certificate importer requires data root, Docker and host root adapters');
  }

  const recordsRoot = path.join(dataRoot, 'certificate-imports');
  const caddyCertificateRoot = path.join(
    dataRoot,
    'gateway',
    'caddy-data',
    'caddy',
    'certificates',
    'acme-v02.api.letsencrypt.org-directory'
  );

  function safeHostPath(source) {
    if (!path.isAbsolute(source)) {
      throw new CertificateImportError('Legacy certificate storage path is invalid', 409, 'certificate-storage-path-invalid');
    }
    const resolvedRoot = path.resolve(hostRoot);
    const resolved = path.resolve(resolvedRoot, '.' + source);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      throw new CertificateImportError('Legacy certificate storage escapes the host root', 409, 'certificate-storage-path-invalid');
    }
    return resolved;
  }

  async function importDomain({ domain: rawDomain, proxyContainerId }) {
    const domain = String(rawDomain || '').toLowerCase();
    if (!DOMAIN_PATTERN.test(domain) || !CONTAINER_ID_PATTERN.test(String(proxyContainerId || ''))) {
      throw new CertificateImportError('Certificate import identity is invalid', 400, 'invalid-certificate-import');
    }
    const proxy = await dockerRequest('GET', '/containers/' + proxyContainerId + '/json');
    const storageMount = (proxy.Mounts || []).find((mount) => (
      mount && mount.Type === 'bind' && mount.Destination === '/traefik' && mount.RW !== false
    ));
    if (!storageMount) {
      throw new CertificateImportError(
        'The observed Traefik proxy exposes no readable ACME storage',
        409,
        'traefik-acme-storage-unavailable'
      );
    }
    const acmeFile = path.join(safeHostPath(storageMount.Source), 'acme.json');
    const stats = fs.statSync(acmeFile);
    if (!stats.isFile() || stats.size < 2 || stats.size > MAX_ACME_STORAGE_BYTES) {
      throw new CertificateImportError('Traefik ACME storage is invalid or too large', 409, 'traefik-acme-storage-invalid');
    }
    const storage = JSON.parse(fs.readFileSync(acmeFile, 'utf8'));
    let selected = null;
    for (const resolver of Object.values(storage || {})) {
      for (const entry of resolver && (resolver.Certificates || resolver.certificates) || []) {
        try {
          const certificatePem = Buffer.from(entry.Certificate || entry.certificate || '', 'base64').toString('utf8');
          const privateKeyPem = Buffer.from(entry.Key || entry.key || '', 'base64').toString('utf8');
          const certificate = new crypto.X509Certificate(certificatePem);
          const privateKey = crypto.createPrivateKey(privateKeyPem);
          if (certificate.checkHost(domain) && publicKeysMatch(certificate, privateKey)) {
            selected = { certificatePem, privateKeyPem, certificate };
          }
        } catch {
          // Ignore unrelated or malformed entries. The requested exact domain must still match below.
        }
      }
    }
    if (!selected) {
      throw new CertificateImportError(
        'No matching browser-trusted certificate was found in the observed proxy',
        409,
        'matching-certificate-unavailable'
      );
    }
    const validTo = new Date(selected.certificate.validTo);
    if (!Number.isFinite(validTo.getTime()) || validTo.getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
      throw new CertificateImportError('The matching certificate expires too soon', 409, 'certificate-expiring');
    }

    const domainRoot = path.join(caddyCertificateRoot, domain);
    const certificateFile = path.join(domainRoot, domain + '.crt');
    const privateKeyFile = path.join(domainRoot, domain + '.key');
    const metadataFile = path.join(domainRoot, domain + '.json');
    atomicWrite(certificateFile, selected.certificatePem);
    atomicWrite(privateKeyFile, selected.privateKeyPem);
    atomicWrite(metadataFile, JSON.stringify({ sans: [domain], issuer_data: null }, null, 2) + '\n');

    const importedAt = new Date(clock()).toISOString();
    const record = {
      schemaVersion: CERTIFICATE_IMPORT_SCHEMA_VERSION,
      importId: 'certimp_' + hash(domain + ':' + selected.certificate.fingerprint256),
      domain,
      owner: 'foxos',
      adapter: 'traefik-acme-import',
      certificateAuthority: selected.certificate.issuer,
      fingerprint256: selected.certificate.fingerprint256,
      validFrom: new Date(selected.certificate.validFrom).toISOString(),
      validTo: validTo.toISOString(),
      caddyStorage: {
        authority: 'acme-v02.api.letsencrypt.org-directory',
        domain,
        privateKeyPersisted: true,
        privateKeyValueIncluded: false
      },
      renewal: {
        owner: 'foxos-caddy',
        method: 'acme-http-01',
        dnsProviderRequired: false,
        legacyProxyRequired: false
      },
      importedAt,
      guarantees: {
        providerApiCalled: false,
        providerStateMutated: false,
        certificateValueIncluded: false,
        privateKeyValueIncluded: false,
        cloudflareRequired: false
      }
    };
    ensureDirectory(recordsRoot);
    atomicWriteJson(path.join(recordsRoot, record.importId + '.json'), record);
    return record;
  }

  ensureDirectory(recordsRoot);
  return { importDomain, paths: { recordsRoot, caddyCertificateRoot } };
}

module.exports = {
  CERTIFICATE_IMPORT_SCHEMA_VERSION,
  CertificateImportError,
  createTraefikCertificateImporter
};
