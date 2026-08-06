const { finalDockerfileBaseReference, resolveComposeProject } = require('./composeSource');

const APPLICATION_UPDATE_SCHEMA_VERSION = 1;
const APPLICATION_ID_PATTERN = /^(?:app|res)_[a-f0-9]{24,64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_REGISTRY_DOCUMENT_BYTES = 4 * 1024 * 1024;

class ApplicationUpdateError extends Error {
  constructor(message, statusCode = 400, code = 'application-update-error') {
    super(message);
    this.name = 'ApplicationUpdateError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseImageReference(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 512 || /[\s?#\\]/.test(raw) || raw.includes('://') || raw.includes('$')) return null;
  const at = raw.lastIndexOf('@');
  if (at !== -1) {
    const digest = raw.slice(at + 1).toLowerCase();
    if (!IMAGE_DIGEST_PATTERN.test(digest)) return null;
    const taggedRepository = raw.slice(0, at).toLowerCase();
    const lastSlash = taggedRepository.lastIndexOf('/');
    const lastColon = taggedRepository.lastIndexOf(':');
    const repositoryPart = lastColon > lastSlash ? taggedRepository.slice(0, lastColon) : taggedRepository;
    const parsedRepository = parseRepository(repositoryPart);
    return parsedRepository ? { ...parsedRepository, digest, immutable: true, reference: raw } : null;
  }
  const lastSlash = raw.lastIndexOf('/');
  const lastColon = raw.lastIndexOf(':');
  const repositoryPart = (lastColon > lastSlash ? raw.slice(0, lastColon) : raw).toLowerCase();
  const tag = lastColon > lastSlash ? raw.slice(lastColon + 1) : 'latest';
  if (!tag || tag.length > 128 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tag)) return null;
  const parsedRepository = parseRepository(repositoryPart);
  return parsedRepository ? {
    ...parsedRepository,
    digest: null,
    immutable: false,
    reference: repositoryPart + ':' + tag,
    tag
  } : null;
}

function parseRepository(value) {
  const parts = String(value || '').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?$/.test(part))) return null;
  const first = parts[0];
  const hasRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  let registry = hasRegistry ? first : 'docker.io';
  let repository = (hasRegistry ? parts.slice(1) : parts).join('/');
  if (['index.docker.io', 'registry-1.docker.io'].includes(registry)) registry = 'docker.io';
  if (!repository) return null;
  if (registry === 'docker.io' && !repository.includes('/')) repository = 'library/' + repository;
  return { registry, repository };
}

function repositoryAliases(parsed) {
  const short = parsed.registry === 'docker.io'
    ? parsed.repository.replace(/^library\//, '')
    : parsed.registry + '/' + parsed.repository;
  const aliases = new Set([short, parsed.repository, parsed.registry + '/' + parsed.repository]);
  if (parsed.registry === 'docker.io') {
    aliases.add('docker.io/' + parsed.repository);
    aliases.add('index.docker.io/' + parsed.repository);
  }
  return aliases;
}

function digestForRepository(repoDigests, parsed) {
  const aliases = repositoryAliases(parsed);
  for (const value of repoDigests || []) {
    const separator = String(value).lastIndexOf('@');
    if (separator === -1) continue;
    const repository = String(value).slice(0, separator).toLowerCase();
    const digest = String(value).slice(separator + 1).toLowerCase();
    if (aliases.has(repository) && IMAGE_DIGEST_PATTERN.test(digest)) return digest;
  }
  return null;
}

function labelVersion(imageDetails, parsed) {
  const config = imageDetails && imageDetails.Config || {};
  const labels = config.Labels || {};
  const label = labels['org.opencontainers.image.version'];
  if (label) return String(label).trim();
  const basename = parsed.repository.split('/').pop().replace(/[^a-z0-9]+/gi, '_').toUpperCase();
  const candidates = new Set([basename + '_VERSION', 'APP_VERSION']);
  for (const entry of config.Env || []) {
    const separator = String(entry).indexOf('=');
    if (separator === -1) continue;
    const key = String(entry).slice(0, separator);
    if (candidates.has(key)) return String(entry).slice(separator + 1).trim() || null;
  }
  return null;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i);
    return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

async function limitedJson(response) {
  if (!response.ok) throw new Error('Registry HTTP ' + response.status);
  const length = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (Number.isFinite(length) && length > MAX_REGISTRY_DOCUMENT_BYTES) {
    throw new Error('Registry metadata exceeded the safety limit');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REGISTRY_DOCUMENT_BYTES) throw new Error('Registry metadata exceeded the safety limit');
  return JSON.parse(buffer.toString('utf8'));
}

function createDockerHubMetadataReader({ fetchImpl = fetch } = {}) {
  return async function readDockerHubMetadata(parsed) {
    if (!parsed || parsed.registry !== 'docker.io' || parsed.immutable) return null;
    const tokenUrl = new URL('https://auth.docker.io/token');
    tokenUrl.searchParams.set('service', 'registry.docker.io');
    tokenUrl.searchParams.set('scope', 'repository:' + parsed.repository + ':pull');
    const tokenPayload = await limitedJson(await fetchImpl(tokenUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    }));
    const token = tokenPayload.token || tokenPayload.access_token;
    if (!token) throw new Error('Docker Hub did not return an anonymous pull token');

    const accept = [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json'
    ].join(', ');
    const base = 'https://registry-1.docker.io/v2/' + parsed.repository;
    const headers = { Accept: accept, Authorization: 'Bearer ' + token };
    const fetchManifest = async (reference) => {
      const response = await fetchImpl(base + '/manifests/' + encodeURIComponent(reference), {
        headers,
        signal: AbortSignal.timeout(10000)
      });
      return {
        body: await limitedJson(response),
        digest: String(response.headers.get('docker-content-digest') || '').toLowerCase()
      };
    };

    const top = await fetchManifest(parsed.tag);
    let manifest = top.body;
    if (Array.isArray(manifest.manifests)) {
      const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
      const selected = manifest.manifests.find((candidate) => (
        candidate.platform && candidate.platform.os === 'linux' && candidate.platform.architecture === architecture
      ));
      if (!selected || !IMAGE_DIGEST_PATTERN.test(String(selected.digest || '').toLowerCase())) {
        throw new Error('Registry image does not include this server platform');
      }
      manifest = (await fetchManifest(selected.digest)).body;
    }
    const configDigest = String(manifest.config && manifest.config.digest || '').toLowerCase();
    if (!IMAGE_DIGEST_PATTERN.test(configDigest)) throw new Error('Registry image config digest is missing');
    const config = await limitedJson(await fetchImpl(base + '/blobs/' + encodeURIComponent(configDigest), {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10000)
    }));
    const labels = config.config && config.config.Labels || config.config && config.config.labels || {};
    return {
      created: config.created || null,
      digest: IMAGE_DIGEST_PATTERN.test(top.digest) ? top.digest : null,
      version: labels['org.opencontainers.image.version'] ? String(labels['org.opencontainers.image.version']) : null
    };
  };
}

function createApplicationUpdateChecker({
  hostRoot,
  dockerRequest,
  getApplicationInventory,
  registryMetadataReader = createDockerHubMetadataReader(),
  clock = () => new Date()
}) {
  if (!hostRoot || typeof dockerRequest !== 'function' || typeof getApplicationInventory !== 'function') {
    throw new Error('Application update checker requires host, Docker and inventory adapters');
  }

  async function check(applicationId) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) {
      throw new ApplicationUpdateError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    const inventory = await getApplicationInventory();
    const application = (inventory.applications || []).find((candidate) => candidate.id === applicationId);
    if (!application || !application.runtime || !application.runtime.containerId) {
      throw new ApplicationUpdateError('Uygulama artık sunucuda bulunamıyor.', 404, 'application-not-found');
    }
    const details = await dockerRequest('GET', '/containers/' + application.runtime.containerId + '/json');
    const labels = details && details.Config && details.Config.Labels || {};
    if (labels['com.foxos.core'] === 'true') {
      throw new ApplicationUpdateError('FoxOS çekirdek imajı bu alandan denetlenemez.', 409, 'core-image-protected');
    }

    let sourceReference = details && details.Config && details.Config.Image || null;
    let sourceType = 'container-image';
    try {
      const project = resolveComposeProject(details, hostRoot);
      if (project && project.service) {
        if (typeof project.service.image === 'string') {
          sourceReference = project.service.image;
          sourceType = 'compose-image';
        } else {
          const baseReference = finalDockerfileBaseReference(project.service, project);
          if (baseReference) {
            sourceReference = baseReference;
            sourceType = 'compose-build-base';
          }
        }
      }
    } catch {
      // Container metadata remains a safe fallback when a legacy Compose source is unavailable.
    }

    const parsed = parseImageReference(sourceReference);
    const checkedAt = new Date(clock()).toISOString();
    if (!parsed) {
      return {
        schemaVersion: APPLICATION_UPDATE_SCHEMA_VERSION,
        applicationId,
        checkedAt,
        status: 'unknown',
        updateAvailable: null,
        source: { reference: sourceReference, type: sourceType },
        current: { imageId: details.Image || null, version: null, digest: null },
        latest: null,
        message: 'Bu uygulamanın takip ettiği registry imajı güvenle belirlenemedi.'
      };
    }
    if (parsed.immutable) {
      return {
        schemaVersion: APPLICATION_UPDATE_SCHEMA_VERSION,
        applicationId,
        checkedAt,
        status: 'immutable',
        updateAvailable: false,
        source: { reference: parsed.reference, type: sourceType },
        current: { imageId: details.Image || null, version: null, digest: parsed.digest },
        latest: { digest: parsed.digest, version: null },
        message: 'Uygulama değişmez bir imaj digest’ine sabitlenmiş; takip edilen bir tag yok.'
      };
    }

    const imageDetails = await dockerRequest('GET', '/images/' + encodeURIComponent(details.Image) + '/json');
    const currentDigest = sourceType === 'compose-build-base'
      ? null
      : digestForRepository(imageDetails.RepoDigests, parsed);
    const currentVersion = labelVersion(imageDetails, parsed);
    let distribution;
    try {
      distribution = await dockerRequest('GET', '/distribution/' + encodeURIComponent(parsed.reference) + '/json');
    } catch (error) {
      throw new ApplicationUpdateError(
        'Registry güncelleme bilgisi okunamadı: ' + error.message,
        502,
        'registry-check-failed'
      );
    }
    const latestDigest = String(distribution && distribution.Descriptor && distribution.Descriptor.digest || '').toLowerCase();
    if (!IMAGE_DIGEST_PATTERN.test(latestDigest)) {
      throw new ApplicationUpdateError('Registry değişmez bir imaj digest’i döndürmedi.', 502, 'registry-digest-missing');
    }
    let remoteMetadata = null;
    try {
      remoteMetadata = await registryMetadataReader(parsed);
    } catch {
      // Version metadata is optional; digest comparison remains authoritative for direct images.
    }
    const latestVersion = remoteMetadata && remoteMetadata.version || null;

    if (currentDigest) {
      const updateAvailable = currentDigest !== latestDigest;
      return {
        schemaVersion: APPLICATION_UPDATE_SCHEMA_VERSION,
        applicationId,
        checkedAt,
        status: updateAvailable ? 'update-available' : 'up-to-date',
        updateAvailable,
        source: { reference: parsed.reference, type: sourceType },
        current: { imageId: details.Image || null, version: currentVersion, digest: currentDigest },
        latest: { digest: latestDigest, version: latestVersion },
        message: updateAvailable
          ? 'Registry’de bu uygulama için daha yeni bir imaj bulundu.'
          : 'Çalışan imaj registry’deki güncel digest ile aynı.'
      };
    }

    if (sourceType === 'compose-build-base' && currentVersion && latestVersion) {
      const comparison = compareVersions(currentVersion, latestVersion);
      const updateAvailable = comparison === null ? currentVersion !== latestVersion : comparison < 0;
      const status = comparison !== null && comparison > 0
        ? 'unknown'
        : updateAvailable ? 'update-available' : 'up-to-date';
      return {
        schemaVersion: APPLICATION_UPDATE_SCHEMA_VERSION,
        applicationId,
        checkedAt,
        status,
        updateAvailable: status === 'unknown' ? null : updateAvailable,
        source: { reference: parsed.reference, type: sourceType },
        current: { imageId: details.Image || null, version: currentVersion, digest: null },
        latest: { digest: latestDigest, version: latestVersion },
        message: status === 'update-available'
          ? `${currentVersion} sürümünden ${latestVersion} sürümüne güncelleme bulundu.`
          : status === 'up-to-date'
            ? `Çalışan build ${latestVersion} taban sürümüyle güncel.`
            : 'Çalışan build sürümü registry tag’inden daha yeni görünüyor; otomatik sonuç verilmedi.'
      };
    }

    return {
      schemaVersion: APPLICATION_UPDATE_SCHEMA_VERSION,
      applicationId,
      checkedAt,
      status: 'unknown',
      updateAvailable: null,
      source: { reference: parsed.reference, type: sourceType },
      current: { imageId: details.Image || null, version: currentVersion, digest: null },
      latest: { digest: latestDigest, version: latestVersion },
      message: sourceType === 'compose-build-base'
        ? 'Compose build tabanı bulundu fakat mevcut build’in taban digest’i kanıtlanamadı.'
        : 'Yerel imajın repository digest’i bulunamadığı için güncellik kesinleştirilemedi.'
    };
  }

  return { check };
}

module.exports = {
  APPLICATION_UPDATE_SCHEMA_VERSION,
  ApplicationUpdateError,
  compareVersions,
  createApplicationUpdateChecker,
  createDockerHubMetadataReader,
  digestForRepository,
  parseImageReference
};
