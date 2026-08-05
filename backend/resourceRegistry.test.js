const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createResourceRegistry,
  detectConflicts,
  identityAliases,
  parseTraefikRoutes,
  resolveResourceId,
  roleFor,
  safeLabels
} = require('./resourceRegistry');

function container({ id, name, image, labels, port }) {
  return {
    Id: id,
    Image: image,
    ImageID: 'sha256:' + id,
    Names: ['/' + name],
    State: 'running',
    Status: 'Up 1 hour',
    Labels: labels,
    Ports: [{ PrivatePort: 8080, PublicPort: port, Type: 'tcp', IP: '0.0.0.0' }],
    NetworkSettings: { Networks: { coolify: { IPAddress: '172.18.0.10' } } }
  };
}

test('resource registry scans with GET only, redacts secrets and preserves stable identities', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-'));
  const secretValue = 'registry-super-secret-value';
  const hiddenLabelValue = 'hidden-provider-token';
  const calls = [];
  const labels = {
    'coolify.managed': 'true',
    'coolify.type': 'service',
    'coolify.service.subType': 'application',
    'coolify.service.subName': 'web',
    'coolify.serviceName': 'website',
    'coolify.projectName': 'project-one',
    'coolify.resourceName': 'website-production',
    'com.docker.compose.project': 'project-one',
    'com.docker.compose.service': 'web',
    'com.docker.compose.container-number': '1',
    'traefik.http.routers.website.rule': 'Host(`app.example.test`) && PathPrefix(`/dashboard`)',
    'traefik.http.routers.website.entrypoints': 'websecure',
    'traefik.http.middlewares.website.headers.customrequestheaders.Authorization': hiddenLabelValue,
    'example.secret': hiddenLabelValue
  };
  const databaseLabels = {
    'coolify.managed': 'true',
    'coolify.type': 'service',
    'coolify.service.subType': 'database',
    'coolify.service.subName': 'postgres',
    'coolify.projectName': 'project-one',
    'coolify.resourceName': 'database-production',
    'traefik.http.routers.database.rule': 'Host(`app.example.test`) && PathPrefix(`/dashboard`)',
    'traefik.http.routers.database.entrypoints': 'websecure'
  };

  let containers = [
    container({ id: 'a'.repeat(64), name: 'website', image: 'example/web:latest', labels, port: 18080 }),
    container({ id: 'b'.repeat(64), name: 'database', image: 'postgres:16', labels: databaseLabels, port: 18080 })
  ];

  function detailsFor(item) {
    const isDatabase = item.Names[0] === '/database';
    return {
      Image: item.ImageID,
      Config: {
        Image: item.Image,
        Labels: item.Labels,
        Env: isDatabase ? [`POSTGRES_PASSWORD=${secretValue}`] : [`API_TOKEN=${secretValue}`, 'NODE_ENV=production'],
        Healthcheck: isDatabase ? null : { Test: ['CMD-SHELL', `curl -H 'Authorization: ${secretValue}' http://localhost/`] }
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        Privileged: false,
        ReadonlyRootfs: true,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        Memory: 134217728,
        NanoCpus: 500000000,
        PidsLimit: 128,
        PortBindings: {
          '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '18080' }]
        }
      },
      Mounts: [{
        Type: 'volume',
        Name: 'shared-data',
        Source: '/var/lib/docker/volumes/shared-data/_data',
        Destination: isDatabase ? '/var/lib/postgresql/data' : '/app/data',
        RW: true
      }],
      NetworkSettings: { Networks: { coolify: { IPAddress: isDatabase ? '172.18.0.11' : '172.18.0.10', Gateway: '172.18.0.1' } } },
      State: { Status: 'running', Health: isDatabase ? null : { Status: 'healthy' } }
    };
  }

  async function dockerRequest(method, requestPath) {
    calls.push({ method, requestPath });
    if (method !== 'GET') throw new Error('Registry attempted a Docker mutation');
    if (requestPath === '/containers/json?all=1') return containers;
    if (requestPath === '/images/json?all=0') {
      return containers.map((item) => ({
        Id: item.ImageID,
        RepoTags: [item.Image],
        RepoDigests: [],
        Size: 123456,
        Created: 1722729600,
        Labels: { 'example.secret': hiddenLabelValue }
      }));
    }
    if (requestPath === '/networks') {
      return [{
        Id: 'network-id',
        Name: 'coolify',
        Driver: 'bridge',
        Scope: 'local',
        Internal: false,
        Attachable: true,
        Ingress: false,
        Labels: { 'example.secret': hiddenLabelValue }
      }];
    }
    if (requestPath === '/volumes') {
      return {
        Volumes: [{
          Name: 'shared-data',
          Driver: 'local',
          Scope: 'local',
          Mountpoint: '/var/lib/docker/volumes/shared-data/_data',
          Labels: { 'example.secret': hiddenLabelValue },
          Options: { password: secretValue }
        }],
        Warnings: []
      };
    }
    const inspectedId = requestPath.match(/^\/containers\/([a-f0-9]{64})\/json$/);
    if (inspectedId) {
      const item = containers.find((candidate) => candidate.Id === inspectedId[1]);
      if (!item) throw new Error('Container not found');
      return detailsFor(item);
    }
    throw new Error('Unexpected Docker request: ' + requestPath);
  }

  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003'
  ];
  const registry = createResourceRegistry({
    dataRoot: root,
    dockerRequest,
    clock: () => new Date('2026-08-04T12:00:00.000Z'),
    randomUUID: () => ids.shift()
  });

  const first = await registry.scan();
  assert.equal(calls.every((call) => call.method === 'GET'), true);
  assert.equal(first.mode, 'read-only-observation');
  assert.equal(first.guarantees.runtimeMutated, false);
  assert.equal(first.guarantees.secretValuesIncluded, false);
  assert.equal(first.summary.resources, 2);
  assert.deepEqual(first.summary.byProvider, { coolify: 2 });
  assert.deepEqual(first.summary.byRole, { application: 1, database: 1 });
  assert.deepEqual(first.summary.byWorkloadRole, { application: 1, database: 1 });
  assert.deepEqual(first.summary.byStateClass, { database: 1, stateful: 1 });
  assert.deepEqual(first.summary.byAuthorityClass, { 'provider-owned': 2 });
  assert.equal(first.summary.statelessAuditCandidates, 0);
  assert.equal(first.guarantees.classificationMethod, 'deterministic-local-evidence');
  assert.equal(first.guarantees.classificationDoesNotImplyOwnership, true);
  assert.equal(first.conflicts.some((conflict) => conflict.type === 'host-port'), true);
  assert.equal(first.conflicts.some((conflict) => conflict.type === 'domain-route'), true);
  assert.equal(first.conflicts.some((conflict) => conflict.type === 'shared-volume'), true);
  assert.equal(first.relationships.some((relationship) => relationship.type === 'shared-network'), true);
  assert.equal(first.relationships.some((relationship) => relationship.type === 'shared-volume'), true);
  assert.equal(first.relationships.some((relationship) => relationship.type === 'provider-project'), true);
  assert.equal(first.resources.every((resource) => resource.ownership === 'observed'), true);
  assert.equal(first.resources.every((resource) => resource.adoption.ready === false), true);
  assert.equal(first.resources.every((resource) => resource.classification.authorityClass === 'provider-owned'), true);
  assert.equal(first.resources.find((resource) => resource.name === 'website').classification.stateClass, 'stateful');
  assert.equal(first.resources.find((resource) => resource.name === 'database').classification.stateClass, 'database');
  assert.deepEqual(first.resources[0].runtime.constraints, {
    user: null,
    privileged: false,
    readOnlyRootFilesystem: true,
    noNewPrivileges: true,
    allCapabilitiesDropped: true,
    memoryBytes: 134217728,
    nanoCpus: 500000000,
    pidsLimit: 128
  });
  assert.equal(first.resources.find((resource) => resource.name === 'website').routes[0].domain, 'app.example.test');

  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(secretValue), false);
  assert.equal(serialized.includes(hiddenLabelValue), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('example.secret'), false);
  assert.equal(serialized.includes('environment-unclassified'), true);

  const firstWebsiteId = first.resources.find((resource) => resource.name === 'website').id;
  containers = [
    container({ id: 'c'.repeat(64), name: 'website', image: 'example/web:latest', labels, port: 18080 }),
    containers[1]
  ];
  const second = await registry.scan();
  assert.equal(second.resources.find((resource) => resource.name === 'website').id, firstWebsiteId);
  assert.equal(registry.getLatest().snapshotId, second.snapshotId);

  const migrationPlan = registry.exportLatest();
  assert.equal(migrationPlan.exportType, 'foxos-resource-migration-plan');
  assert.equal(migrationPlan.guarantees.secretValuesIncluded, false);
  assert.equal(JSON.stringify(migrationPlan).includes(secretValue), false);

  assert.equal(fs.statSync(registry.paths.registryRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(registry.paths.identitiesFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(registry.paths.latestFile).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(registry.paths.revisionsRoot).length, 2);

  const persisted = fs.readdirSync(registry.paths.revisionsRoot)
    .map((file) => fs.readFileSync(path.join(registry.paths.revisionsRoot, file), 'utf8'))
    .join('\n');
  assert.equal(persisted.includes(secretValue), false);
  assert.equal(persisted.includes(hiddenLabelValue), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('route and label normalization keeps only migration-safe fields', () => {
  const labels = {
    'coolify.managed': 'true',
    'coolify.projectName': 'example-project',
    'traefik.http.routers.app.rule': 'Host(`one.example.test`, `two.example.test`) && PathPrefix(`/api`)',
    'traefik.http.routers.app.tls': 'true',
    'traefik.http.middlewares.app.basicauth.users': 'user:password-hash',
    'private.token': 'do-not-copy'
  };

  assert.deepEqual(parseTraefikRoutes(labels), [
    { domain: 'one.example.test', scheme: 'https', path: '/api', tls: true },
    { domain: 'two.example.test', scheme: 'https', path: '/api', tls: true }
  ]);
  assert.deepEqual(safeLabels(labels), {
    'coolify.managed': 'true',
    'coolify.projectName': 'example-project'
  });

  const secretPathRoutes = parseTraefikRoutes({
    'traefik.http.routers.webhook.rule': 'Host(`hooks.example.test`) && PathPrefix(`/webhook/abcdefghijklmnopqrstuvwxyz123456`)',
    'traefik.http.routers.webhook.entrypoints': 'websecure'
  });
  assert.equal(secretPathRoutes[0].path.startsWith('/webhook/:redacted-'), true);
  assert.equal(secretPathRoutes[0].path.includes('abcdefghijklmnopqrstuvwxyz123456'), false);
});

test('FoxOS gateway stays protected while being classified as the FoxOS proxy', () => {
  const labels = {
    'com.foxos.core': 'true',
    'com.foxos.gateway': 'true',
    'com.foxos.adoption.disposable': 'true'
  };

  assert.equal(roleFor(labels, 'foxos-gateway:0.0.1', 'foxos-gateway', [], []), 'proxy');
  assert.deepEqual(safeLabels(labels), labels);
});

test('a stateful shadow is a separate FoxOS application identity with migration-safe linkage labels', () => {
  const labels = {
    'com.foxos.managed': 'true',
    'com.foxos.stateful-shadow': 'true',
    'com.foxos.stateful-shadow.source-resource-id': 'res_' + '1'.repeat(32),
    'com.foxos.stateful-shadow.operation': 'sso_' + '3'.repeat(32),
    'com.foxos.resource.id': 'res_' + '2'.repeat(32)
  };
  assert.equal(roleFor(labels, 'henrygd/beszel:latest', 'foxos-stateful-shadow-example', [], []), 'application');
  assert.deepEqual(safeLabels(labels), labels);
  assert.equal(identityAliases({
    Id: 'a'.repeat(64),
    Names: ['/foxos-stateful-shadow-example']
  }, labels).includes('foxos:' + labels['com.foxos.resource.id']), true);
});

test('a preserved rollback container cannot claim the adopted resource identity', () => {
  const labels = {
    'com.foxos.managed': 'true',
    'com.foxos.resource.id': 'res_' + '1'.repeat(32),
    'com.docker.compose.project': 'foxos-adoption-lab',
    'com.docker.compose.service': 'web',
    'com.docker.compose.container-number': '1'
  };
  const adoptedAliases = identityAliases({
    Id: 'a'.repeat(64),
    Names: ['/foxos-adoption-lab']
  }, labels);
  const rollbackAliases = identityAliases({
    Id: 'b'.repeat(64),
    Names: ['/foxos-adoption-lab-foxos-rollback-1234abcd']
  }, labels);

  assert.equal(adoptedAliases.includes('foxos:' + labels['com.foxos.resource.id']), true);
  assert.deepEqual(rollbackAliases, ['rollback-container:' + 'b'.repeat(64)]);
});

test('trusted FoxOS labels own the canonical resource ID and replace a previous generated alias', () => {
  const claimedId = 'res_' + 'a'.repeat(32);
  const generatedId = 'res_' + 'b'.repeat(32);
  const identityState = { schemaVersion: 1, aliases: {} };
  const observedAt = '2026-08-04T20:00:00.000Z';

  const first = resolveResourceId(
    identityState,
    ['container-name:foxos-image-update-lab'],
    observedAt,
    () => generatedId.slice(4)
  );
  assert.equal(first, generatedId);

  const trustedAliases = identityAliases({
    Id: 'a'.repeat(64),
    Names: ['/foxos-image-update-lab']
  }, {
    'com.foxos.managed': 'true',
    'com.foxos.resource.id': claimedId
  });
  const migrated = resolveResourceId(identityState, trustedAliases, observedAt, () => {
    throw new Error('A trusted FoxOS identity must not generate a replacement ID');
  });
  assert.equal(migrated, claimedId);
  assert.equal(
    Object.values(identityState.aliases).every((record) => record.resourceId === claimedId),
    true
  );

  const untrustedAliases = identityAliases({
    Id: 'c'.repeat(64),
    Names: ['/external-container']
  }, { 'com.foxos.resource.id': 'res_' + 'd'.repeat(32) });
  assert.equal(untrustedAliases.some((alias) => alias.startsWith('foxos:')), false);
});

test('deployment history containers cannot claim the active deployment identity', () => {
  const labels = {
    'com.foxos.managed': 'true',
    'com.foxos.resource.id': 'res_' + '2'.repeat(32),
    'com.foxos.deployment.disposable': 'true',
    'com.foxos.deployment.revision': 'drev_' + '3'.repeat(32),
    'com.foxos.deployment.operation': 'dop_' + '4'.repeat(32)
  };
  const activeAliases = identityAliases({
    Id: 'c'.repeat(64),
    Names: ['/foxos-deployment-lab']
  }, labels);
  const historyAliases = identityAliases({
    Id: 'd'.repeat(64),
    Names: ['/foxos-deployment-lab-rollback-1234abcd']
  }, labels);

  assert.equal(activeAliases.includes('foxos:' + labels['com.foxos.resource.id']), true);
  assert.deepEqual(historyAliases, ['deployment-history-container:' + 'd'.repeat(64)]);
  assert.deepEqual(safeLabels(labels), labels);
});

test('Compose deployment history cannot claim a stable service identity', () => {
  const labels = {
    'com.foxos.managed': 'true',
    'com.foxos.resource.id': 'res_' + '5'.repeat(32),
    'com.foxos.compose-deployment.disposable': 'true',
    'com.foxos.deployment.group.id': 'res_' + '6'.repeat(32),
    'com.foxos.deployment.service': 'web',
    'com.foxos.deployment.revision': 'crev_' + '7'.repeat(32),
    'com.foxos.deployment.operation': 'cop_' + '8'.repeat(32)
  };
  const activeAliases = identityAliases({
    Id: 'e'.repeat(64),
    Names: ['/foxos-compose-lab-web']
  }, labels);
  const historyAliases = identityAliases({
    Id: 'f'.repeat(64),
    Names: ['/foxos-compose-lab-rollback-1234abcd-web']
  }, labels);

  assert.equal(activeAliases.includes('foxos:' + labels['com.foxos.resource.id']), true);
  assert.deepEqual(historyAliases, ['compose-deployment-history-container:' + 'f'.repeat(64)]);
  assert.deepEqual(safeLabels(labels), labels);
});

test('image-update history cannot claim the active image-update identity', () => {
  const labels = {
    'com.foxos.managed': 'true',
    'com.foxos.resource.id': 'res_' + '9'.repeat(32),
    'com.foxos.image-update.disposable': 'true',
    'com.foxos.deployment.revision': 'irev_' + 'a'.repeat(32),
    'com.foxos.deployment.operation': 'iop_' + 'b'.repeat(32)
  };
  const activeAliases = identityAliases({
    Id: '1'.repeat(64),
    Names: ['/foxos-image-update-lab']
  }, labels);
  const historyAliases = identityAliases({
    Id: '2'.repeat(64),
    Names: ['/foxos-image-update-lab-rolled-forward-1234abcd']
  }, labels);

  assert.equal(activeAliases.includes('foxos:' + labels['com.foxos.resource.id']), true);
  assert.deepEqual(historyAliases, ['image-update-history-container:' + '2'.repeat(64)]);
  assert.deepEqual(safeLabels(labels), labels);
});

test('a preserved rollback container does not create a false active host-port conflict', () => {
  const port = { privatePort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 18088 };
  const mount = { type: 'volume', name: 'foxos-adoption-lab-data' };
  const conflicts = detectConflicts([
    { id: 'res_target', name: 'foxos-adoption-lab', ports: [port], routes: [], mounts: [mount] },
    {
      id: 'res_source',
      name: 'foxos-adoption-lab-foxos-rollback-1234abcd',
      ports: [port],
      routes: [],
      mounts: [mount]
    }
  ]);
  assert.equal(conflicts.some((conflict) => conflict.type === 'host-port'), false);
  assert.equal(conflicts.some((conflict) => conflict.type === 'shared-volume'), true);
});
