const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  attachFoxosMigrationManagement,
  createResourceRegistry,
  detectConflicts,
  identityAliases,
  parseDockerHttpHealthTarget,
  parseTraefikRoutes,
  readFoxosMigrationManagement,
  resolveResourceId,
  roleFor,
  safeLabels
} = require('./resourceRegistry');
const { buildApplicationInventory } = require('./applicationInventory');
const { createDesktopShortcutManager } = require('./desktopShortcutManager');

function providerRecoveryArtifact(seed = 'a') {
  const artifactId = 'pdef_' + seed.repeat(32);
  const revision = 'pdef_rev_' + seed.repeat(32);
  return {
    schemaVersion: 1,
    artifactId,
    revision,
    file: `provider-definitions/recovery/${artifactId}-${revision}.foxosenc`,
    encrypted: true,
    authenticated: true,
    keyId: 'key_' + seed.repeat(24),
    plaintextSecretValuesIncluded: false
  };
}

test('verified FoxOS traffic authority projects a preserved provider source as FoxOS-managed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-management-'));
  const resourceId = 'res_' + '1'.repeat(32);
  const operationId = 'smop_' + '2'.repeat(32);
  const routeId = 'smroute_' + '3'.repeat(24);
  const candidateContainerId = '4'.repeat(64);
  const domain = 'app.example.test';
  try {
    fs.mkdirSync(path.join(root, 'stateless-migrations', 'operations'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ingress'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stateless-migrations', 'operations', operationId + '.json'), JSON.stringify({
      operationId,
      resourceId,
      status: 'traffic-on-foxos-source-preserved',
      completedAt: '2026-08-06T02:07:55.522Z',
      source: { retainedForRollback: true },
      candidate: { containerId: candidateContainerId },
      route: { routeId, domain },
      trafficProof: {
        healthy: true,
        tlsValid: true,
        candidateServing: true,
        sourceContinuouslyRunning: true
      }
    }));
    fs.writeFileSync(path.join(root, 'ingress', 'authority.json'), JSON.stringify({
      owner: 'foxos',
      publicAuthorityActive: true,
      domains: { [domain]: 'foxos' },
      routes: {
        [routeId]: { routeId, operationId, domain, status: 'active' }
      }
    }));

    const management = readFoxosMigrationManagement(root, [{
      id: 'res_' + '5'.repeat(32),
      runtime: { containerId: candidateContainerId, state: 'running' }
    }]).get(resourceId);
    assert.equal(management.owner, 'foxos');
    assert.equal(management.state, 'active');
    assert.equal(management.operationId, operationId);
    assert.equal(management.authorityActive, true);
    assert.equal(management.candidateRunning, true);
    assert.equal(management.sourcePreserved, true);
    assert.equal(management.automaticMigrationAllowed, false);

    fs.writeFileSync(path.join(root, 'ingress', 'authority.json'), JSON.stringify({
      owner: 'foxos',
      publicAuthorityActive: true,
      domains: { [domain]: 'legacy' },
      routes: {
        [routeId]: { routeId, operationId, domain, status: 'inactive' }
      }
    }));
    assert.equal(readFoxosMigrationManagement(root, []).get(resourceId).state, 'attention-required');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified in-place runtime transfer projects every group member as server-managed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-runtime-transfer-management-'));
  const parentId = 'res_' + 'a'.repeat(32);
  const memberId = 'res_' + 'b'.repeat(32);
  const operationId = 'rtop_' + 'c'.repeat(32);
  const routeId = 'smroute_' + 'd'.repeat(24);
  const parentContainerId = 'e'.repeat(64);
  const memberContainerId = 'f'.repeat(64);
  try {
    fs.mkdirSync(path.join(root, 'runtime-transfers', 'operations'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ingress'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime-transfers', 'operations', operationId + '.json'), JSON.stringify({
      operationId,
      resourceId: parentId,
      memberResourceIds: [parentId, memberId],
      status: 'server-runtime-adopted',
      completedAt: '2026-08-07T13:00:00.000Z',
      candidateContainerId: parentContainerId,
      routes: [{ routeId, domain: 'n8n.example.test', path: '/', privatePort: 5678 }],
      trafficProof: { healthy: true, unavailableSamples: 0 },
      manifests: [{
        resourceId: parentId,
        name: 'n8n',
        runtime: { containerId: parentContainerId },
        provenance: { importedFrom: 'coolify' }
      }, {
        resourceId: memberId,
        name: 'task-runners',
        runtime: { containerId: memberContainerId },
        provenance: { importedFrom: 'coolify' }
      }]
    }));
    fs.writeFileSync(path.join(root, 'ingress', 'authority.json'), JSON.stringify({
      owner: 'foxos',
      publicAuthorityActive: true,
      domains: { 'n8n.example.test': 'foxos' },
      routes: {
        [routeId]: { routeId, operationId, domain: 'n8n.example.test', status: 'active' }
      }
    }));
    const resources = [{
      id: parentId,
      provider: 'coolify',
      ownership: 'observed',
      runtime: { containerId: parentContainerId, state: 'running' }
    }, {
      id: memberId,
      provider: 'coolify',
      ownership: 'observed',
      runtime: { containerId: memberContainerId, state: 'running' }
    }];
    const management = readFoxosMigrationManagement(root, resources);
    assert.equal(management.get(parentId).state, 'active');
    assert.equal(management.get(parentId).authorityActive, true);
    assert.equal(management.get(memberId).state, 'active');
    assert.equal(management.get(memberId).candidateContainerId, memberContainerId);
    assert.deepEqual(management.get(memberId).domains, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified stateful traffic authority projects the restored candidate as server-managed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-stateful-management-'));
  const resourceId = 'res_' + 'a'.repeat(32);
  const operationId = 'stmop_' + 'b'.repeat(32);
  const planId = 'stmplan_' + 'c'.repeat(32);
  const routeId = 'smroute_' + 'd'.repeat(24);
  const candidateContainerId = 'e'.repeat(64);
  const candidateResourceId = 'res_' + 'f'.repeat(32);
  const domain = 'stateful.example.test';
  try {
    fs.mkdirSync(path.join(root, 'stateful-migrations', 'operations'), { recursive: true });
    fs.mkdirSync(path.join(root, 'stateful-migrations', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ingress'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stateful-migrations', 'plans', planId + '.json'), JSON.stringify({
      planId,
      resource: {
        name: 'Stateful application',
        observedProvider: 'coolify',
        observedOwnership: 'observed'
      }
    }));
    fs.writeFileSync(path.join(root, 'stateful-migrations', 'operations', operationId + '.json'), JSON.stringify({
      operationId,
      planId,
      resourceId,
      status: 'traffic-on-server-source-preserved',
      completedAt: '2026-08-07T10:00:00.000Z',
      source: { retainedForRollback: true },
      candidate: { containerId: candidateContainerId },
      route: { routes: [{ routeId, domain }] },
      trafficProof: { healthy: true, tlsValid: true, candidateServing: true }
    }));
    fs.writeFileSync(path.join(root, 'ingress', 'authority.json'), JSON.stringify({
      owner: 'foxos',
      publicAuthorityActive: true,
      domains: { [domain]: 'foxos' },
      routes: { [routeId]: { routeId, operationId, domain, status: 'active' } }
    }));

    const management = readFoxosMigrationManagement(root, [{
      id: candidateResourceId,
      runtime: { containerId: candidateContainerId, state: 'running' }
    }]).get(resourceId);

    assert.equal(management.owner, 'foxos');
    assert.equal(management.state, 'active');
    assert.equal(management.lifecycle, 'stateful-bounded-quiesce');
    assert.equal(management.candidateResourceId, candidateResourceId);
    assert.deepEqual(management.domains, [domain]);
    assert.equal(management.sourceProvider, 'coolify');
    assert.equal(management.sourcePreserved, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified migration management follows the running candidate after the cold source is removed', () => {
  const logicalResourceId = 'res_' + '6'.repeat(32);
  const candidateResourceId = 'res_' + '7'.repeat(32);
  const candidateContainerId = '8'.repeat(64);
  const resources = [{
    id: candidateResourceId,
    provider: 'foxos',
    ownership: 'foxos-managed',
    runtime: { containerId: candidateContainerId, state: 'running' }
  }];
  const management = new Map([[logicalResourceId, {
    owner: 'foxos',
    logicalResourceId,
    state: 'active',
    candidateContainerId,
    candidateRunning: true,
    sourceProvider: 'coolify',
    sourceOwnership: 'observed'
  }]]);

  attachFoxosMigrationManagement(resources, management);

  assert.equal(resources[0].id, candidateResourceId);
  assert.equal(resources[0].management.logicalResourceId, logicalResourceId);
  assert.equal(resources[0].management.sourceResourcePresent, false);
  assert.equal(resources[0].management.sourceProvider, 'coolify');
  assert.equal(resources[0].management.sourceOwnership, 'observed');
});

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

test('registry merges matching provider definitions and retains inactive definitions plus host services', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-sources-'));
  const coolifyUuid = 'app-uuid-long-enough';
  const running = container({
    id: 'd'.repeat(64),
    name: `running-${coolifyUuid}`,
    image: 'example/running:1',
    labels: { 'coolify.managed': 'true' },
    port: 18081
  });
  try {
    const registry = createResourceRegistry({
      dataRoot: root,
      randomUUID: (() => {
        let sequence = 1;
        return () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
      })(),
      dockerRequest: async (method, requestPath) => {
        assert.equal(method, 'GET');
        if (requestPath === '/containers/json?all=1') return [running];
        if (requestPath === `/containers/${running.Id}/json`) return {
          Config: { Image: running.Image, Labels: running.Labels, Env: [] },
          HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, PortBindings: {} },
          Mounts: [],
          NetworkSettings: { Networks: {} },
          State: { Status: 'running' }
        };
        if (requestPath === '/images/json?all=0' || requestPath === '/networks') return [];
        if (requestPath === '/volumes') return { Volumes: [] };
        throw new Error(`unexpected ${requestPath}`);
      },
      providerResourceReader: async () => ({
        provider: 'coolify', configured: true, readOnly: true, resources: [{
          sourceKind: 'provider-definition', provider: 'coolify', externalId: coolifyUuid,
          name: 'Running app', providerKind: 'application', status: 'running:healthy', routes: []
        }, {
          sourceKind: 'provider-definition', provider: 'coolify', externalId: 'inactive-service-uuid',
          name: 'Inactive service', providerKind: 'service', serviceType: 'directus', status: 'exited', routes: []
        }]
      }),
      hostResourceReader: async () => ({
        source: 'linux-host', configured: true, readOnly: true,
        inventory: { wireGuardInterfaces: 1 },
        resources: [{
          sourceKind: 'host-service', provider: 'linux-host', externalId: 'wireguard:wg0',
          name: 'WireGuard (wg0)', providerKind: 'network-service', serviceType: 'wireguard',
          runtime: { unit: 'wg-quick@wg0.service', state: 'running', status: 'active:exited', inspection: 'complete' },
          configuration: { interface: 'wg0', filePresent: true, contentsRead: false }
        }]
      })
    });
    const snapshot = await registry.scan();
    assert.equal(snapshot.summary.resources, 3);
    assert.deepEqual(snapshot.summary.byKind, {
      container: 1,
      'host-service': 1,
      'provider-definition': 1
    });
    const dockerResource = snapshot.resources.find((resource) => resource.kind === 'container');
    assert.equal(dockerResource.provenance.externalDefinition.runtimePresent, true);
    assert.equal(snapshot.resources.filter((resource) => resource.kind === 'provider-definition').length, 1);
    const inactive = snapshot.resources.find((resource) => resource.name === 'Inactive service');
    assert.equal(inactive.runtime.state, 'stopped');
    assert.equal(inactive.classification.evidence.stateClass.includes('provider-definition-runtime-absent'), true);
    const wireguard = snapshot.resources.find((resource) => resource.name === 'WireGuard (wg0)');
    assert.equal(wireguard.classification.workloadRole, 'network-service');
    assert.equal(wireguard.classification.stateClass, 'host-configured');
    assert.equal(snapshot.discovery.sources.every((source) => source.readOnly), true);
    assert.equal(snapshot.guarantees.runtimeMutated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('offline provider scans retain redacted definitions and their explicit desktop shortcuts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-provider-offline-'));
  let providerOnline = true;
  try {
    const registry = createResourceRegistry({
      dataRoot: root,
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
      dockerRequest: async (method, requestPath) => {
        assert.equal(method, 'GET');
        if (requestPath === '/containers/json?all=1' || requestPath === '/images/json?all=0' || requestPath === '/networks') return [];
        if (requestPath === '/volumes') return { Volumes: [] };
        throw new Error(`unexpected ${requestPath}`);
      },
      providerResourceReader: async () => {
        if (!providerOnline) {
          const error = new Error('provider unavailable');
          error.code = 'provider-unavailable';
          throw error;
        }
        return {
          provider: 'coolify',
          configured: true,
          readOnly: true,
          resources: [{
            sourceKind: 'provider-definition',
            provider: 'coolify',
            externalId: 'offline-definition-1',
            name: 'Offline definition',
            providerKind: 'service',
            serviceType: 'directus',
            status: 'exited',
            routes: [],
            recoveryArtifact: providerRecoveryArtifact('a')
          }]
        };
      }
    });
    const onlineSnapshot = await registry.scan();
    const definitionId = onlineSnapshot.resources[0].id;
    const shortcuts = createDesktopShortcutManager({ dataRoot: root });
    shortcuts.setVisible(definitionId, true);

    providerOnline = false;
    const offlineSnapshot = await registry.scan();
    assert.equal(offlineSnapshot.summary.resources, 1);
    assert.equal(offlineSnapshot.resources[0].id, definitionId);
    assert.equal(offlineSnapshot.resources[0].name, 'Offline definition');
    assert.equal(offlineSnapshot.discovery.sources.find((source) => source.source === 'legacy-provider').status, 'error');
    assert.equal(offlineSnapshot.discovery.sources.find((source) => source.source === 'legacy-provider').retainedResources, 1);
    assert.equal(offlineSnapshot.guarantees.offlineProviderDefinitionsRetainedFromRedactedServerState, true);

    const applications = buildApplicationInventory({ resources: offlineSnapshot.resources });
    assert.equal(applications.length, 1);
    assert.equal(applications[0].id, definitionId);
    assert.equal(shortcuts.isVisible(applications[0].id, applications[0].desktopShortcutDefaultVisible), true);
    assert.equal(fs.readFileSync(registry.paths.latestFile, 'utf8').includes('provider unavailable'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adopted inactive definitions remain server-managed without provider history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-adopted-definition-'));
  const resourceId = 'res_' + 'b'.repeat(32);
  const operationId = 'rtop_' + 'c'.repeat(32);
  try {
    fs.mkdirSync(path.join(root, 'runtime-transfers', 'operations'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime-transfers', 'operations', operationId + '.json'), JSON.stringify({
      operationId,
      resourceId,
      memberResourceIds: [resourceId],
      status: 'server-definition-adopted',
      completedAt: '2026-08-07T12:00:00.000Z',
      routes: [],
      manifests: [{
        schemaVersion: 1,
        resourceId,
        name: 'Recovered definition',
        kind: 'inactive-provider-definition',
        role: 'service',
        desiredState: 'stopped',
        source: null,
        serviceType: 'directus',
        declaredRoutes: [],
        observedStatus: 'exited',
        recoveryArtifact: providerRecoveryArtifact('b'),
        provenance: { importedFrom: 'coolify' }
      }]
    }));
    const registry = createResourceRegistry({
      dataRoot: root,
      dockerRequest: async (method, requestPath) => {
        assert.equal(method, 'GET');
        if (requestPath === '/containers/json?all=1' || requestPath === '/images/json?all=0' || requestPath === '/networks') return [];
        if (requestPath === '/volumes') return { Volumes: [] };
        throw new Error(`unexpected ${requestPath}`);
      },
      providerResourceReader: async () => {
        const error = new Error('provider unavailable');
        error.code = 'provider-unavailable';
        throw error;
      }
    });
    const snapshot = await registry.scan();
    assert.equal(snapshot.summary.resources, 1);
    assert.equal(snapshot.resources[0].id, resourceId);
    assert.equal(snapshot.resources[0].name, 'Recovered definition');
    assert.equal(snapshot.resources[0].management.owner, 'foxos');
    assert.equal(snapshot.resources[0].management.lifecycle, 'inactive-definition-transfer');
    assert.equal(snapshot.resources[0].management.state, 'active');
    assert.equal(snapshot.discovery.sources.find((source) => source.source === 'legacy-provider').recoveredServerOwnedResources, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('route and label normalization keeps only migration-safe fields', () => {
  const labels = {
    'coolify.managed': 'true',
    'coolify.projectName': 'example-project',
    'traefik.http.routers.app.rule': 'Host(`one.example.test`, `two.example.test`) && PathPrefix(`/api`)',
    'traefik.http.routers.app.service': 'app-service@docker',
    'traefik.http.routers.app.tls': 'true',
    'traefik.http.services.app-service.loadbalancer.server.port': '8080',
    'traefik.http.middlewares.app.basicauth.users': 'user:password-hash',
    'private.token': 'do-not-copy'
  };

  assert.deepEqual(parseTraefikRoutes(labels), [
    { domain: 'one.example.test', scheme: 'https', path: '/api', tls: true, privatePort: 8080 },
    { domain: 'two.example.test', scheme: 'https', path: '/api', tls: true, privatePort: 8080 }
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

test('Docker health discovery retains only a credential-free local HTTP target', () => {
  const ports = [{ privatePort: 8080, protocol: 'tcp' }];
  assert.deepEqual(parseDockerHttpHealthTarget({
    Test: ['CMD-SHELL', 'curl --fail --silent http://localhost:8080/healthz || exit 1']
  }, ports), {
    protocol: 'http',
    privatePort: 8080,
    path: '/healthz',
    source: 'docker-http-healthcheck'
  });
  assert.deepEqual(parseDockerHttpHealthTarget({
    Test: ['CMD', 'wget', '--spider', 'http://127.0.0.1:8080/ready']
  }, ports), {
    protocol: 'http',
    privatePort: 8080,
    path: '/ready',
    source: 'docker-http-healthcheck'
  });
  assert.equal(parseDockerHttpHealthTarget({
    Test: ['CMD-SHELL', 'curl -H "Authorization: secret" http://localhost:8080/healthz']
  }, ports), null);
  assert.equal(parseDockerHttpHealthTarget({
    Test: ['CMD-SHELL', 'curl http://localhost:8080/healthz?token=secret']
  }, ports), null);
  assert.equal(parseDockerHttpHealthTarget({
    Test: ['CMD-SHELL', 'curl http://metadata.example:8080/healthz']
  }, ports), null);
  assert.equal(parseDockerHttpHealthTarget({
    Test: ['CMD-SHELL', 'curl http://localhost:9090/healthz']
  }, ports), null);
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

test('inactive definition runtime projects its verified candidate onto the logical resource', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-inactive-runtime-'));
  const resourceId = 'res_' + '1'.repeat(32);
  const candidateResourceId = 'res_' + '2'.repeat(32);
  const candidateContainerId = '3'.repeat(64);
  const operationId = 'rtop_' + '4'.repeat(32);
  const routeId = 'smroute_' + '5'.repeat(24);
  const domain = 'firefox.example.com';
  fs.mkdirSync(path.join(dataRoot, 'inactive-definition-runtimes', 'operations'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'ingress'), { recursive: true });
  fs.writeFileSync(path.join(
    dataRoot,
    'inactive-definition-runtimes',
    'operations',
    operationId + '.json'
  ), JSON.stringify({
    schemaVersion: 1,
    operationId,
    resourceId,
    status: 'server-definition-runtime-active',
    candidateContainerId,
    candidateResourceId,
    application: { name: 'firefox' },
    route: { routeId, domain, path: '/', privatePort: 5800 },
    trafficProof: { healthy: true, tlsValid: true, expectedRoute: true },
    completedAt: '2026-08-07T14:00:00.000Z'
  }));
  fs.writeFileSync(path.join(dataRoot, 'ingress', 'authority.json'), JSON.stringify({
    owner: 'foxos',
    publicAuthorityActive: true,
    domains: { [domain]: 'foxos' },
    routes: { [routeId]: { operationId, domain, status: 'active' } }
  }));

  const management = readFoxosMigrationManagement(dataRoot, [{
    id: candidateResourceId,
    runtime: { containerId: candidateContainerId, state: 'running' }
  }]).get(resourceId);
  assert.equal(management.owner, 'foxos');
  assert.equal(management.state, 'active');
  assert.equal(management.lifecycle, 'inactive-definition-runtime');
  assert.equal(management.candidateContainerId, candidateContainerId);
  assert.equal(management.candidateResourceId, candidateResourceId);
  assert.deepEqual(management.domains, [domain]);
  assert.equal(management.authorityActive, true);
  assert.equal(management.candidateRunning, true);
  assert.equal(management.trafficVerified, true);
});

test('a stopped inactive-definition runtime supersedes its earlier definition-only adoption', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-stopped-inactive-runtime-'));
  const resourceId = 'res_' + 'a'.repeat(32);
  const candidateResourceId = 'res_' + 'b'.repeat(32);
  const candidateContainerId = 'c'.repeat(64);
  const adoptionOperationId = 'rtop_' + 'd'.repeat(32);
  const runtimeOperationId = 'rtop_' + 'e'.repeat(32);
  const routeId = 'smroute_' + 'f'.repeat(24);
  const domain = 'firefox.example.com';
  fs.mkdirSync(path.join(dataRoot, 'runtime-transfers', 'operations'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'inactive-definition-runtimes', 'operations'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'ingress'), { recursive: true });
  fs.writeFileSync(path.join(
    dataRoot,
    'runtime-transfers',
    'operations',
    adoptionOperationId + '.json'
  ), JSON.stringify({
    operationId: adoptionOperationId,
    resourceId,
    memberResourceIds: [resourceId],
    status: 'server-definition-adopted',
    completedAt: '2026-08-07T12:00:00.000Z',
    routes: [],
    manifests: [{ resourceId, name: 'firefox', provenance: { importedFrom: 'coolify' } }]
  }));
  fs.writeFileSync(path.join(
    dataRoot,
    'inactive-definition-runtimes',
    'operations',
    runtimeOperationId + '.json'
  ), JSON.stringify({
    schemaVersion: 1,
    operationId: runtimeOperationId,
    resourceId,
    status: 'server-definition-runtime-active',
    candidateContainerId,
    candidateResourceId,
    application: { name: 'firefox' },
    route: { routeId, domain, path: '/', privatePort: 5800 },
    runtimeState: 'stopped',
    trafficProof: { healthy: false, tlsValid: true, expectedRoute: false, statusCode: 503 },
    completedAt: '2026-08-07T14:00:00.000Z'
  }));
  fs.writeFileSync(path.join(dataRoot, 'ingress', 'authority.json'), JSON.stringify({
    owner: 'foxos',
    publicAuthorityActive: true,
    domains: { [domain]: 'foxos' },
    routes: {},
    inactiveDomains: { [domain]: { resourceId, responseStatus: 503 } }
  }));

  try {
    const management = readFoxosMigrationManagement(dataRoot, [{
      id: candidateResourceId,
      runtime: { containerId: candidateContainerId, state: 'exited' }
    }]).get(resourceId);
    assert.equal(management.lifecycle, 'inactive-definition-runtime');
    assert.equal(management.state, 'attention-required');
    assert.equal(management.candidateContainerId, candidateContainerId);
    assert.equal(management.candidateResourceId, candidateResourceId);
    assert.equal(management.candidateRunning, false);
    assert.equal(management.authorityActive, false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('route-less inactive definition runtime becomes active from candidate and internal HTTP proof', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-registry-inactive-runtime-'));
  const resourceId = 'res_' + '6'.repeat(32);
  const candidateResourceId = 'res_' + '7'.repeat(32);
  const candidateContainerId = '8'.repeat(64);
  const operationId = 'rtop_' + '9'.repeat(32);
  fs.mkdirSync(path.join(dataRoot, 'inactive-definition-runtimes', 'operations'), { recursive: true });
  fs.writeFileSync(path.join(
    dataRoot,
    'inactive-definition-runtimes',
    'operations',
    operationId + '.json'
  ), JSON.stringify({
    schemaVersion: 1,
    operationId,
    resourceId,
    status: 'server-definition-runtime-active',
    candidateContainerId,
    candidateResourceId,
    application: { name: 'route-less-app' },
    route: { routeId: null, domain: null, path: '/', privatePort: 3000 },
    trafficProof: { healthy: true, internal: true, statusCode: 200 },
    completedAt: '2026-08-07T14:00:00.000Z'
  }));

  const management = readFoxosMigrationManagement(dataRoot, [{
    id: candidateResourceId,
    runtime: { containerId: candidateContainerId, state: 'running' }
  }]).get(resourceId);
  assert.equal(management.state, 'active');
  assert.deepEqual(management.domains, []);
  assert.equal(management.authorityActive, true);
  assert.equal(management.candidateRunning, true);
  assert.equal(management.trafficVerified, true);
});
