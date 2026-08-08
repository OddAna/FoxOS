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

test('stateful migrated application check follows the retained Compose source instead of its local runtime alias', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-update-stateful-'));
  const dataRoot = path.join(root, 'data');
  const hostRoot = path.join(root, 'host');
  const composeFile = path.join(hostRoot, 'data/apps/nocodb/docker-compose.yml');
  fs.mkdirSync(path.dirname(composeFile), { recursive: true });
  fs.writeFileSync(composeFile, 'services:\n  nocodb:\n    image: nocodb/nocodb:latest\n');
  const applicationId = 'res_' + '5'.repeat(32);
  const candidateId = '6'.repeat(64);
  const sourceId = '7'.repeat(64);
  const imageId = 'sha256:' + '8'.repeat(64);
  const localDigest = 'sha256:' + '9'.repeat(64);
  const latestDigest = 'sha256:' + 'a'.repeat(64);
  const operationId = 'stmop_' + 'b'.repeat(32);
  const planId = 'stmplan_' + 'c'.repeat(32);
  fs.mkdirSync(path.join(dataRoot, 'stateful-migrations/operations'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'stateful-migrations/plans'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'stateful-migrations/operations', operationId + '.json'), JSON.stringify({
    operationId,
    planId,
    resourceId: applicationId,
    candidate: { containerId: candidateId }
  }));
  fs.writeFileSync(path.join(dataRoot, 'stateful-migrations/plans', planId + '.json'), JSON.stringify({
    planId,
    resource: { resourceId: applicationId },
    executionContract: { source: { containerId: sourceId, imageId } }
  }));
  const requests = [];
  const checker = createApplicationUpdateChecker({
    dataRoot,
    hostRoot,
    getApplicationInventory: async () => ({ applications: [{ id: applicationId, runtime: { containerId: candidateId } }] }),
    dockerRequest: async (method, requestPath) => {
      requests.push({ method, requestPath });
      if (requestPath === '/containers/' + candidateId + '/json') return {
        Id: candidateId,
        Image: imageId,
        Config: {
          Image: 'local/db-example-com:current',
          Labels: {
            'com.foxos.migration.source-resource-id': applicationId,
            'com.foxos.stateful-migration.id': operationId
          }
        }
      };
      if (requestPath === '/containers/' + sourceId + '/json') return {
        Id: sourceId,
        Image: imageId,
        Config: {
          Image: 'server-recovery/nocodb:rollback',
          Labels: {
            'com.docker.compose.project': 'nocodb',
            'com.docker.compose.service': 'nocodb',
            'com.docker.compose.project.working_dir': '/data/apps/nocodb',
            'com.docker.compose.project.config_files': '/data/apps/nocodb/docker-compose.yml'
          }
        }
      };
      if (requestPath.includes('/images/')) return {
        RepoTags: ['local/db-example-com:current'],
        RepoDigests: ['nocodb/nocodb@' + localDigest],
        Config: { Labels: {} }
      };
      if (requestPath === '/distribution/' + encodeURIComponent('nocodb/nocodb:latest') + '/json') {
        return { Descriptor: { digest: latestDigest } };
      }
      throw new Error('unexpected request: ' + requestPath);
    },
    registryMetadataReader: async (parsed) => {
      assert.equal(parsed.reference, 'nocodb/nocodb:latest');
      return { version: null };
    }
  });
  const result = await checker.check(applicationId);
  assert.equal(result.status, 'update-available');
  assert.equal(result.source.reference, 'nocodb/nocodb:latest');
  assert.equal(result.source.type, 'migration-compose-image');
  assert.equal(result.current.digest, localDigest);
  assert.equal(result.latest.digest, latestDigest);
  assert.equal(requests.some((request) => request.requestPath.includes('/distribution/local%2F')), false);
});

test('server-local image without verifiable upstream provenance stays unknown and never queries a registry', async () => {
  const applicationId = 'res_' + 'd'.repeat(32);
  const containerId = 'e'.repeat(64);
  const imageId = 'sha256:' + 'f'.repeat(64);
  const requests = [];
  const checker = createApplicationUpdateChecker({
    hostRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-update-local-')),
    getApplicationInventory: async () => ({ applications: [{ id: applicationId, runtime: { containerId } }] }),
    dockerRequest: async (method, requestPath) => {
      requests.push({ method, requestPath });
      if (requestPath.includes('/containers/')) return {
        Id: containerId,
        Image: imageId,
        Config: { Image: 'local/private-app:current', Labels: {} }
      };
      if (requestPath.includes('/images/')) return {
        RepoTags: ['local/private-app:current'],
        RepoDigests: [],
        Config: { Labels: {} }
      };
      throw new Error('registry must not be queried');
    }
  });
  const result = await checker.check(applicationId);
  assert.equal(result.status, 'unknown');
  assert.equal(result.updateAvailable, null);
  assert.match(result.message, /upstream registry/);
  assert.equal(requests.some((request) => request.requestPath.includes('/distribution/')), false);
});
