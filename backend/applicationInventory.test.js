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
