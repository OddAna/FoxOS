const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCoolifyMigrationReader } = require('./coolifyMigrationReader');
const { createEncryptionStore } = require('./encryptionStore');

test('optional Coolify reader encrypts its token and persists only projected migration fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-coolify-reader-'));
  const token = 'coolify-test-token-that-must-never-be-persisted';
  const hidden = 'provider-secret-that-must-not-leave-memory';
  const calls = [];
  try {
    const apiRequest = async ({ baseUrl, token: actualToken, endpoint }) => {
      calls.push({ baseUrl, actualToken, endpoint });
      if (endpoint === 'applications') return [{
        uuid: 'app-uuid',
        name: 'example/stopped-site:main-abcdefghijklmnopqrstuv',
        status: 'exited:unhealthy',
        fqdn: 'https://stopped.example.test',
        git_repository: 'example/stopped-site',
        git_branch: 'main',
        git_commit_sha: 'a'.repeat(40),
        build_pack: 'nixpacks',
        compose_parsing_version: '3',
        manual_webhook_secret_github: hidden,
        docker_compose_raw: `PASSWORD=${hidden}`
      }];
      if (endpoint === 'services') return [{
        uuid: 'service-uuid',
        name: 'WireGuard Easy',
        service_type: 'wireguard-easy',
        status: 'exited',
        docker_compose_raw: hidden
      }];
      if (endpoint === 'databases') return [{
        uuid: 'database-uuid',
        name: 'PostgreSQL',
        database_type: 'postgresql',
        status: 'running:healthy',
        image: 'postgres:16',
        postgres_password: hidden,
        internal_db_url: hidden
      }];
      if (endpoint === 'applications/app-uuid/envs') return [{
        key: 'APP_API_TOKEN', real_value: hidden, is_runtime: true
      }];
      if (endpoint === 'services/service-uuid/envs') return [{
        key: 'SERVICE_PASSWORD', real_value: hidden, is_runtime: true
      }];
      throw new Error('unexpected endpoint');
    };
    const reader = createCoolifyMigrationReader({
      dataRoot: root,
      encryptionStore: createEncryptionStore({ dataRoot: root }),
      apiRequest,
      clock: () => new Date('2026-08-07T00:00:00.000Z')
    });
    assert.deepEqual(await reader.scan(), {
      provider: 'coolify',
      configured: false,
      optional: true,
      runtimeDependency: false,
      readOnly: true,
      tokenStoredEncrypted: false,
      tokenIncluded: false,
      baseUrl: null,
      configuredAt: null,
      lastVerifiedAt: null,
      resources: []
    });

    const configured = await reader.configure({ baseUrl: 'https://panel.example.test/api/v1/', token });
    assert.equal(configured.configured, true);
    assert.equal(configured.discoveredResources, 3);
    assert.equal(calls.every((call) => call.actualToken === token), true);
    const scan = await reader.scan();
    assert.equal(scan.resources.length, 3);
    assert.deepEqual(scan.resources.map((resource) => resource.providerKind).sort(), [
      'application', 'database', 'service'
    ]);
    assert.equal(scan.resources.find((resource) => resource.externalId === 'app-uuid').status, 'exited:unhealthy');
    assert.equal(scan.resources.find((resource) => resource.externalId === 'app-uuid').name, 'stopped-site');
    assert.equal(scan.resources.find((resource) => resource.externalId === 'service-uuid').serviceType, 'wireguard-easy');
    assert.equal(scan.resources.find((resource) => resource.externalId === 'service-uuid').name, 'WireGuard Easy');
    const applicationArtifact = scan.resources.find((resource) => resource.externalId === 'app-uuid').recoveryArtifact;
    assert.equal(applicationArtifact.encrypted, true);
    assert.equal(applicationArtifact.plaintextSecretValuesIncluded, false);
    assert.equal(reader.readRecoveryArtifact(applicationArtifact).environment[0].value, hidden);

    const persisted = [
      reader.paths.configFile,
      reader.paths.tokenFile,
      ...fs.readdirSync(reader.paths.recoveryRoot).map((file) => path.join(reader.paths.recoveryRoot, file))
    ]
      .map((file) => fs.readFileSync(file).toString('utf8')).join('\n');
    assert.equal(persisted.includes(token), false);
    assert.equal(persisted.includes(hidden), false);
    assert.equal(fs.statSync(reader.paths.configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(reader.paths.tokenFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
