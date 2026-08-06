const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildApplicationInventory,
  canonicalApplicationName,
  operationalStateForRuntime
} = require('./applicationInventory');

test('runtime state maps to the existing FoxOS desktop status contract', () => {
  assert.equal(operationalStateForRuntime({ state: 'running', status: 'Up 1 minute', healthStatus: 'healthy' }), 'running');
  assert.equal(operationalStateForRuntime({ state: 'running', status: 'Up 1 minute (unhealthy)', healthStatus: 'unhealthy' }), 'error');
  assert.equal(operationalStateForRuntime({ state: 'created', status: 'Created', healthStatus: null }), 'stopped');
  assert.equal(operationalStateForRuntime({ state: 'restarting', status: 'Restarting (1)', healthStatus: null }), 'transitioning');
  assert.equal(operationalStateForRuntime({ state: 'exited', status: 'Exited (0) 1 minute ago', healthStatus: null }), 'stopped');
  assert.equal(operationalStateForRuntime({ state: 'exited', status: 'Exited (137) 1 minute ago', healthStatus: null }), 'stopped');
  assert.equal(operationalStateForRuntime({ state: 'exited', status: 'Exited (2) 1 minute ago', healthStatus: null }), 'error');
});

test('custom applications use a permanent domain while profiles and temporary previews keep their names', () => {
  assert.equal(
    canonicalApplicationName({ name: 'Provider Generated Name', profileId: null }, 'https://notes.example.com'),
    'notes.example.com'
  );
  assert.equal(
    canonicalApplicationName({ name: 'WordPress', profileId: 'wordpress' }, 'https://blog.example.com'),
    'WordPress'
  );
  assert.equal(
    canonicalApplicationName({ name: 'Preview Site', profileId: null }, 'https://preview.192.0.2.10.sslip.io'),
    'Preview Site'
  );
});

test('a migrated source and active candidate become one server-owned application', () => {
  const sourceId = 'a'.repeat(64);
  const candidateId = 'b'.repeat(64);
  const resourceId = 'res_' + '1'.repeat(32);
  const applications = buildApplicationInventory({
    appStates: [
      {
        id: 'discovered-custom-source',
        installed: true,
        canManage: true,
        managedByFoxOS: false,
        installationSource: 'coolify',
        name: 'Defter',
        publisher: 'Docker',
        logoUrl: '/api/apps/discovered-custom-source/icon',
        externalUrl: 'https://legacy.example.test',
        containerId: sourceId,
        containerName: 'provider-source',
        state: 'exited',
        status: 'Exited (137)'
      },
      {
        id: 'discovered-active-candidate',
        installed: true,
        canManage: true,
        managedByFoxOS: true,
        installationSource: 'foxos',
        name: 'defter.example.test',
        publisher: 'Sunucu',
        logoUrl: null,
        externalUrl: null,
        containerId: candidateId,
        containerName: 'defter-example-test',
        state: 'running',
        status: 'Up 10 minutes (healthy)'
      }
    ],
    containers: [
      { Id: sourceId, Image: 'example/defter:1', Names: ['/provider-source'], State: 'exited', Status: 'Exited (137)' },
      { Id: candidateId, Image: 'example/defter@sha256:' + 'c'.repeat(64), Names: ['/defter-example-test'], State: 'running', Status: 'Up 10 minutes (healthy)' }
    ],
    resources: [
      {
        id: resourceId,
        provider: 'coolify',
        ownership: 'observed',
        runtime: { containerId: sourceId, health: { status: null } },
        management: {
          owner: 'foxos',
          state: 'active',
          lifecycle: 'stateless-blue-green',
          candidateContainerId: candidateId,
          domains: ['defter.example.com'],
          authorityActive: true
        }
      },
      {
        id: 'res_' + '2'.repeat(32),
        provider: 'foxos',
        ownership: 'foxos-managed',
        runtime: { containerId: candidateId, health: { status: 'healthy' } }
      }
    ]
  });

  assert.equal(applications.length, 1);
  assert.equal(applications[0].id, resourceId);
  assert.equal(applications[0].runtime.containerId, candidateId);
  assert.equal(applications[0].runtime.operationalState, 'running');
  assert.equal(applications[0].name, 'defter.example.com');
  assert.equal(applications[0].externalUrl, 'https://defter.example.com');
  assert.equal(applications[0].managedByServer, true);
  assert.equal(applications[0].authority, 'server');
  assert.equal(applications[0].provenance.importedFrom, 'coolify');
  assert.equal(applications[0].logoUrl, '/api/apps/discovered-custom-source/icon');
});

test('a verified server domain preference changes the primary URL without changing application identity', () => {
  const sourceId = 'a'.repeat(64);
  const candidateId = 'b'.repeat(64);
  const resourceId = 'res_' + '9'.repeat(32);
  const applications = buildApplicationInventory({
    appStates: [{
      id: 'source-app',
      installed: true,
      canManage: true,
      name: 'Old Name',
      externalUrl: 'https://old.example.com',
      containerId: sourceId,
      containerName: 'source-app',
      state: 'exited',
      status: 'Exited (137)'
    }, {
      id: 'candidate-app',
      installed: true,
      canManage: true,
      managedByFoxOS: true,
      name: 'Candidate',
      containerId: candidateId,
      containerName: 'candidate-app',
      state: 'running',
      status: 'Up 1 hour'
    }],
    containers: [
      { Id: sourceId, Names: ['/source-app'], State: 'exited', Status: 'Exited (137)' },
      { Id: candidateId, Names: ['/candidate-app'], State: 'running', Status: 'Up 1 hour' }
    ],
    resources: [{
      id: resourceId,
      provider: 'docker',
      ownership: 'observed',
      runtime: { containerId: sourceId },
      management: {
        owner: 'foxos',
        state: 'active',
        candidateContainerId: candidateId,
        domains: ['old.example.com'],
        authorityActive: true
      }
    }],
    domainPreferences: { [resourceId]: 'new.example.com' }
  });

  assert.equal(applications.length, 1);
  assert.equal(applications[0].id, resourceId);
  assert.equal(applications[0].externalUrl, 'https://new.example.com');
  assert.equal(applications[0].name, 'new.example.com');
});

test('multiple instances retain separate stable resource identities', () => {
  const firstContainer = 'c'.repeat(64);
  const secondContainer = 'd'.repeat(64);
  const appStates = [firstContainer, secondContainer].map((containerId, index) => ({
    id: 'discovered-wordpress-' + index,
    installed: true,
    canManage: true,
    managedByFoxOS: false,
    installationSource: 'docker',
    name: 'WordPress',
    profileId: 'wordpress',
    instanceName: 'site-' + (index + 1) + '.example.test',
    containerId,
    containerName: 'wordpress-' + (index + 1),
    state: index === 0 ? 'running' : 'exited',
    status: index === 0 ? 'Up 1 hour' : 'Exited (0)'
  }));
  const resources = [firstContainer, secondContainer].map((containerId, index) => ({
    id: 'res_' + String(index + 3).repeat(32),
    provider: 'docker',
    ownership: 'observed',
    runtime: { containerId, health: { status: null } }
  }));

  const applications = buildApplicationInventory({
    appStates,
    containers: [
      { Id: firstContainer, Names: ['/wordpress-1'], State: 'running', Status: 'Up 1 hour' },
      { Id: secondContainer, Names: ['/wordpress-2'], State: 'exited', Status: 'Exited (0)' }
    ],
    resources
  });

  assert.equal(applications.length, 2);
  assert.notEqual(applications[0].id, applications[1].id);
  assert.deepEqual(
    applications.map((application) => application.name),
    ['WordPress · site-1.example.test', 'WordPress · site-2.example.test']
  );
  assert.deepEqual(
    applications.map((application) => application.runtime.operationalState).sort(),
    ['running', 'stopped']
  );
});

test('inactive provider definitions remain visible as non-running installed applications', () => {
  const applications = buildApplicationInventory({
    resources: [
      {
        id: 'res_' + '7'.repeat(32),
        kind: 'provider-definition',
        name: 'Directus',
        role: 'application',
        ownership: 'observed',
        provider: 'coolify',
        provenance: {
          externalDefinition: {
            providerKind: 'application',
            serviceType: 'dockerfile',
            source: { type: 'git' },
            declaredRoutes: [{ domain: 'directus.example.com', scheme: 'https', path: '/', tls: true }],
            runtimePresent: false
          }
        },
        runtime: { containerId: null, image: null, state: 'stopped', status: 'exited:unknown' }
      },
      ...['8', '9'].map((digit) => ({
        id: 'res_' + digit.repeat(32),
        kind: 'provider-definition',
        name: 'Unnamed service',
        role: 'service',
        ownership: 'observed',
        provider: 'coolify',
        provenance: {
          externalDefinition: {
            providerKind: 'service',
            serviceType: 'compose',
            source: { type: 'compose-service' },
            declaredRoutes: [],
            runtimePresent: false
          }
        },
        runtime: { containerId: null, image: null, state: 'defined', status: 'unknown' }
      }))
    ]
  });

  assert.equal(applications.length, 3);
  const directus = applications.find((application) => application.name === 'Directus');
  assert.equal(directus.runtime.present, false);
  assert.equal(directus.runtime.containerId, null);
  assert.equal(directus.runtime.operationalState, 'stopped');
  assert.equal(directus.installation.state, 'inactive-definition');
  assert.equal(directus.desktopShortcutDefaultVisible, false);
  assert.deepEqual(directus.declaredUrls, ['https://directus.example.com']);
  assert.deepEqual(directus.capabilities, {
    open: false,
    start: false,
    stop: false,
    restart: false,
    settings: true,
    checkUpdates: false,
    editCompose: false,
    editAccessLink: false,
    editDomain: false
  });
  assert.deepEqual(
    applications.filter((application) => application.name.startsWith('Unnamed service')).map((application) => application.name),
    ['Unnamed service · 1', 'Unnamed service · 2']
  );
});

test('host-native services remain visible with their systemd state and no fake Docker controls', () => {
  const applications = buildApplicationInventory({
    resources: [{
      id: 'res_' + 'a'.repeat(32),
      kind: 'host-service',
      name: 'WireGuard (wg0)',
      role: 'network-service',
      ownership: 'observed',
      provider: 'linux-host',
      runtime: {
        engine: 'systemd',
        containerId: null,
        state: 'running',
        status: 'active:exited',
        unit: 'wg-quick@wg0.service',
        activeState: 'active',
        subState: 'exited',
        inspection: 'complete'
      }
    }, {
      id: 'res_' + 'b'.repeat(32),
      kind: 'host-service',
      name: 'clickup-hosts-refresh',
      role: 'service',
      ownership: 'observed',
      provider: 'linux-host',
      runtime: {
        engine: 'systemd',
        containerId: null,
        state: 'stopped',
        status: 'failed:failed',
        unit: 'clickup-hosts-refresh.service',
        activeState: 'failed',
        subState: 'failed',
        inspection: 'complete'
      }
    }]
  });

  assert.equal(applications.length, 2);
  const wireGuard = applications.find((application) => application.name === 'WireGuard (wg0)');
  assert.equal(wireGuard.installation.state, 'host-service');
  assert.equal(wireGuard.runtime.present, true);
  assert.equal(wireGuard.runtime.engine, 'systemd');
  assert.equal(wireGuard.runtime.containerId, null);
  assert.equal(wireGuard.runtime.serviceUnit, 'wg-quick@wg0.service');
  assert.equal(wireGuard.runtime.operationalState, 'running');
  assert.equal(wireGuard.desktopShortcutDefaultVisible, false);
  assert.deepEqual(wireGuard.capabilities, {
    open: false,
    start: false,
    stop: false,
    restart: false,
    settings: true,
    checkUpdates: false,
    editCompose: false,
    editAccessLink: false,
    editDomain: false
  });
  const failedService = applications.find((application) => application.name === 'clickup-hosts-refresh');
  assert.equal(failedService.runtime.operationalState, 'error');
});
