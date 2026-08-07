const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  InactiveDefinitionRuntimeError,
  compileContract,
  createInactiveDefinitionRuntimeManager
} = require('./inactiveDefinitionRuntimeManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const CANDIDATE_ID = '2'.repeat(64);
const PROXY_ID = '3'.repeat(64);
const IMAGE_ID = 'sha256:' + '4'.repeat(64);

function artifact() {
  return {
    schemaVersion: 1,
    artifactId: 'pdef_' + 'a'.repeat(32),
    revision: 'pdef_rev_' + 'b'.repeat(32),
    file: 'provider-definitions/recovery/example.foxosenc',
    encrypted: true,
    authenticated: true,
    plaintextSecretValuesIncluded: false
  };
}

function resource() {
  return {
    id: RESOURCE_ID,
    kind: 'provider-definition',
    name: 'firefox',
    provider: 'coolify',
    management: {
      owner: 'foxos',
      state: 'active',
      lifecycle: 'inactive-definition-transfer'
    },
    provenance: {
      externalDefinition: { recoveryArtifact: artifact() }
    }
  };
}

function recovered(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'coolify',
    providerKind: 'service',
    definition: {
      docker_compose: [
        'services:',
        '  firefox:',
        '    image: jlesage/firefox',
        '    env_file:',
        '      - /data/coolify/services/firefox/.env',
        '    environment:',
        '      - SERVICE_URL_FIREFOX_5800',
        '    volumes:',
        '      - firefox_config:/config',
        '    restart: unless-stopped',
        '    healthcheck:',
        '      test: ["CMD-SHELL", "curl -f http://127.0.0.1:5800/ || exit 1"]',
        '      interval: 5s',
        '      timeout: 20s',
        '      retries: 10',
        'volumes:',
        '  firefox_config:',
        '    name: provider_firefox_config'
      ].join('\n'),
      ...overrides.definition
    },
    environment: [
      { key: 'SERVICE_URL_FIREFOX_5800', value: 'https://firefox.example.com', isRuntime: true, isCoolifyMetadata: true },
      { key: 'SERVICE_FQDN_FIREFOX_5800', value: 'firefox.example.com', isRuntime: true, isCoolifyMetadata: true },
      { key: 'VNC_PASSWORD', value: 'never-persist-this-secret', isRuntime: true, isCoolifyMetadata: false }
    ],
    ...overrides
  };
}

test('activates one recovered service with existing data and a FoxOS-owned route', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-inactive-runtime-'));
  const snapshot = { snapshotId: 'snap_' + '5'.repeat(32), resources: [resource()] };
  let createdPayload = null;
  let scanCount = 0;
  const dockerRequest = async (method, requestPath, payload) => {
    if (method === 'GET' && requestPath === '/containers/json?all=1') {
      return [{ Id: PROXY_ID, Names: ['/coolify-proxy'] }];
    }
    if (method === 'GET' && requestPath === '/volumes/provider_firefox_config') {
      return { Name: 'provider_firefox_config' };
    }
    if (method === 'POST' && requestPath.startsWith('/images/create?')) return {};
    if (method === 'GET' && requestPath === '/images/jlesage%2Ffirefox/json') {
      return { Id: IMAGE_ID, RepoDigests: ['jlesage/firefox@sha256:' + '6'.repeat(64)] };
    }
    if (method === 'POST' && requestPath === '/containers/create?name=firefox') {
      createdPayload = payload;
      return { Id: CANDIDATE_ID };
    }
    if (method === 'POST' && requestPath === `/containers/${CANDIDATE_ID}/start`) return null;
    if (method === 'GET' && requestPath === `/containers/${CANDIDATE_ID}/json`) {
      return {
        Id: CANDIDATE_ID,
        Image: IMAGE_ID,
        State: { Running: true, Status: 'running', Health: { Status: 'healthy' } }
      };
    }
    throw new Error(`Unexpected Docker call: ${method} ${requestPath}`);
  };
  const ingressCalls = [];
  const manager = createInactiveDefinitionRuntimeManager({
    dataRoot,
    dockerRequest,
    resourceRegistry: {
      getLatest: () => snapshot,
      scan: async () => { scanCount += 1; return snapshot; }
    },
    readRecoveryArtifact: () => recovered(),
    certificateImporter: {
      importDomain: async (input) => { ingressCalls.push(['certificate', input]); return {}; }
    },
    ingressAuthority: {
      reconcileInactiveDomains: async (input) => { ingressCalls.push(['inactive', input]); return {}; },
      stageRoutes: async (input) => { ingressCalls.push(['stage', input]); return input; },
      switchDomain: async (domain, target) => { ingressCalls.push(['switch', domain, target]); return {}; },
      httpsProbe: async () => ({ statusCode: 200, tlsValid: true, expectedRoute: true }),
      removeRoutes: async () => {}
    },
    randomUUID: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    wait: async () => {}
  });

  assert.deepEqual(manager.capability(RESOURCE_ID), {
    available: true,
    mode: 'single-service-compose-recovery',
    domain: 'firefox.example.com',
    privatePort: 5800,
    persistentVolumes: 1
  });
  const operation = await manager.activate(RESOURCE_ID);

  assert.equal(operation.status, 'server-definition-runtime-active');
  assert.equal(operation.candidateContainerId, CANDIDATE_ID);
  assert.equal(operation.route.domain, 'firefox.example.com');
  assert.equal(operation.trafficProof.healthy, true);
  assert.equal(scanCount, 1);
  assert.equal(createdPayload.Image, IMAGE_ID);
  assert.deepEqual(createdPayload.Env, [
    'SERVICE_URL_FIREFOX_5800=https://firefox.example.com',
    'VNC_PASSWORD=never-persist-this-secret'
  ]);
  assert.deepEqual(createdPayload.HostConfig.Mounts, [{
    Type: 'volume',
    Source: 'provider_firefox_config',
    Target: '/config',
    ReadOnly: false
  }]);
  assert.equal(createdPayload.Labels['com.foxos.managed'], 'true');
  assert.equal(createdPayload.Labels['com.foxos.app.id'], RESOURCE_ID);
  assert.equal(Object.keys(createdPayload.Labels).some((key) => key.startsWith('coolify.')), false);
  assert.equal(JSON.stringify(operation).includes('never-persist-this-secret'), false);
  assert.equal(ingressCalls[0][0], 'certificate');
  assert.equal(ingressCalls.some((entry) => entry[0] === 'stage'), true);
  assert.deepEqual(ingressCalls.at(-1), ['switch', 'firefox.example.com', 'foxos']);

  const persisted = JSON.parse(fs.readFileSync(path.join(
    dataRoot,
    'inactive-definition-runtimes',
    'operations',
    operation.operationId + '.json'
  ), 'utf8'));
  assert.equal(persisted.environment.valuesIncluded, false);
  assert.equal(JSON.stringify(persisted).includes('never-persist-this-secret'), false);
});

test('fails closed for privileged or bind-mounted recovered services', () => {
  const base = recovered();
  const privileged = {
    ...base,
    definition: {
      docker_compose: base.definition.docker_compose.replace(
        '    image: jlesage/firefox',
        '    image: jlesage/firefox\n    privileged: true'
      )
    }
  };
  assert.throws(
    () => compileContract(resource(), privileged),
    (error) => error instanceof InactiveDefinitionRuntimeError &&
      error.code === 'inactive-definition-runtime-unsupported'
  );

  const bind = {
    ...base,
    definition: {
      docker_compose: base.definition.docker_compose.replace(
        '      - firefox_config:/config',
        '      - /srv/firefox:/config'
      )
    }
  };
  assert.throws(
    () => compileContract(resource(), bind),
    (error) => error instanceof InactiveDefinitionRuntimeError &&
      error.code === 'inactive-definition-volume-invalid'
  );
});

test('does not advertise activation for unsupported recovered kinds', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-inactive-runtime-'));
  const manager = createInactiveDefinitionRuntimeManager({
    dataRoot,
    dockerRequest: async () => [],
    resourceRegistry: { getLatest: () => ({ resources: [resource()] }), scan: async () => ({}) },
    readRecoveryArtifact: () => recovered({ providerKind: 'database' }),
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      stageRoutes: async () => [],
      switchDomain: async () => ({}),
      httpsProbe: async () => ({}),
      removeRoutes: async () => ({}),
      reconcileInactiveDomains: async () => ({})
    }
  });
  assert.deepEqual(manager.capability(RESOURCE_ID), {
    available: false,
    code: 'inactive-definition-kind-unsupported'
  });
});
