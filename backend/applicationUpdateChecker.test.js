const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  compareVersions,
  createApplicationUpdateChecker,
  parseImageReference
} = require('./applicationUpdateChecker');

test('image references normalize Docker Hub tags and preserve immutable digests', () => {
  assert.deepEqual(parseImageReference('n8nio/n8n:latest'), {
    registry: 'docker.io', repository: 'n8nio/n8n', digest: null,
    immutable: false, reference: 'n8nio/n8n:latest', tag: 'latest'
  });
  const pinned = parseImageReference('docker.io/library/nginx@sha256:' + 'a'.repeat(64));
  assert.equal(pinned.immutable, true);
  assert.equal(pinned.repository, 'library/nginx');
  assert.equal(parseImageReference('nginx:1.29@sha256:' + 'b'.repeat(64)).repository, 'library/nginx');
  assert.equal(compareVersions('2.28.7', '2.33.5'), -1);
  assert.equal(compareVersions('v2.33.5', '2.33.5'), 0);
});

test('direct application image check compares local and remote repository digests without pulling', async () => {
  const applicationId = 'res_' + 'a'.repeat(32);
  const containerId = 'b'.repeat(64);
  const imageId = 'sha256:' + 'c'.repeat(64);
  const localDigest = 'sha256:' + 'd'.repeat(64);
  const latestDigest = 'sha256:' + 'e'.repeat(64);
  const requests = [];
  const checker = createApplicationUpdateChecker({
    hostRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-update-host-')),
    getApplicationInventory: async () => ({ applications: [{ id: applicationId, runtime: { containerId } }] }),
    dockerRequest: async (method, requestPath) => {
      requests.push({ method, requestPath });
      if (requestPath.includes('/containers/')) return { Image: imageId, Config: { Image: 'nginx:latest', Labels: {} } };
      if (requestPath.includes('/images/')) return { RepoDigests: ['nginx@' + localDigest], Config: { Labels: {} } };
      if (requestPath.includes('/distribution/')) return { Descriptor: { digest: latestDigest } };
      throw new Error('unexpected request');
    },
    registryMetadataReader: async () => ({ version: '1.29.0' })
  });
  const result = await checker.check(applicationId);
  assert.equal(result.status, 'update-available');
  assert.equal(result.current.digest, localDigest);
  assert.equal(result.latest.digest, latestDigest);
  assert.equal(requests.some((request) => request.method !== 'GET'), false);
});

test('Compose-built n8n check follows the final inline Dockerfile base and compares versions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-update-n8n-'));
  const hostRoot = path.join(root, 'host');
  const composeFile = path.join(hostRoot, 'srv/n8n/compose.yaml');
  fs.mkdirSync(path.dirname(composeFile), { recursive: true });
  fs.writeFileSync(composeFile, [
    'services:',
    '  n8n:',
    '    build:',
    '      context: .',
    '      dockerfile_inline: |',
    '        FROM mwader/static-ffmpeg:latest AS ffmpeg',
    '        FROM n8nio/n8n:latest',
    ''
  ].join('\n'));
  const applicationId = 'app_' + '1'.repeat(32);
  const containerId = '2'.repeat(64);
  const imageId = 'sha256:' + '3'.repeat(64);
  const requests = [];
  const checker = createApplicationUpdateChecker({
    hostRoot,
    getApplicationInventory: async () => ({ applications: [{ id: applicationId, runtime: { containerId } }] }),
    dockerRequest: async (method, requestPath) => {
      requests.push({ method, requestPath });
      if (requestPath.includes('/containers/')) return {
        Image: imageId,
        Config: {
          Image: 'n8n-local:latest',
          Labels: {
            'com.docker.compose.project': 'n8n',
            'com.docker.compose.service': 'n8n',
            'com.docker.compose.project.working_dir': '/srv/n8n',
            'com.docker.compose.project.config_files': '/srv/n8n/compose.yaml'
          }
        }
      };
      if (requestPath.includes('/images/')) return {
        RepoDigests: [],
        Config: { Labels: { 'org.opencontainers.image.version': '2.28.7' } }
      };
      if (requestPath.includes('/distribution/')) return {
        Descriptor: { digest: 'sha256:' + '4'.repeat(64) }
      };
      throw new Error('unexpected request');
    },
    registryMetadataReader: async (parsed) => {
      assert.equal(parsed.reference, 'n8nio/n8n:latest');
      return { version: '2.33.5' };
    }
  });
  const result = await checker.check(applicationId);
  assert.equal(result.status, 'update-available');
  assert.equal(result.source.type, 'compose-build-base');
  assert.equal(result.current.version, '2.28.7');
  assert.equal(result.latest.version, '2.33.5');
  assert.equal(requests.some((request) => request.method !== 'GET'), false);
});
