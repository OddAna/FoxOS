const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PREPARE_RUNTIME_TRANSFER_CONFIRMATION,
  createRuntimeTransferManager
} = require('./runtimeTransferManager');

function managerHarness({ snapshot, internalProbe = null }) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-runtime-transfer-'));
  const dockerCalls = [];
  const ingressCalls = [];
  let stagedOperationId = null;
  const manager = createRuntimeTransferManager({
    dataRoot,
    dockerRequest: async (method, requestPath, body) => {
      dockerCalls.push({ method, path: requestPath, body });
      if (method === 'GET' && requestPath.startsWith('/containers/')) {
        const containerId = requestPath.split('/')[2];
        const resource = snapshot.resources.find((entry) => (
          entry.runtime && entry.runtime.containerId === containerId
        ));
        if (!resource) throw new Error('No such container');
        return {
          Id: containerId,
          Image: resource.runtime.imageId,
          State: { Running: true },
          NetworkSettings: { Networks: Object.fromEntries(
            (resource.networks || []).map((network) => [network.name, {}])
          ) }
        };
      }
      return {};
    },
    dockerExec: internalProbe || (async () => ({ exitCode: 0, output: 'HTTP/1.1 200 OK' })),
    resourceRegistry: { getLatest: () => snapshot },
    secretManager: {
      getEnvironmentRevision: (resourceId) => ({
        resourceId,
        revision: 'env_rev_' + resourceId.slice(-32)
      })
    },
    certificateImporter: {
      importDomain: async (input) => {
        ingressCalls.push({ action: 'certificate', ...input });
        return { imported: true };
      }
    },
    ingressAuthority: {
      inspectOwnedInfrastructure: async () => ({ gateway: { Id: 'f'.repeat(64) } }),
      ensureLegacyBridge: async (input) => {
        ingressCalls.push({ action: 'bridge', ...input });
        return { ready: true };
      },
      verifyLegacyDomain: async (input) => {
        ingressCalls.push({ action: 'legacy-proof', ...input });
        return { legacyReady: true };
      },
      stageRoutes: async (routes) => {
        stagedOperationId = routes[0].operationId;
        ingressCalls.push({ action: 'stage', routes });
        return routes.map((route) => ({ ...route, status: 'staged' }));
      },
      switchDomain: async (domain, target) => {
        ingressCalls.push({ action: 'switch', domain, target });
        return { domain, target };
      },
      httpsProbe: async ({ expectedRouteId }) => ({
        statusCode: 200,
        tlsValid: true,
        expectedRoute: true,
        routeId: expectedRouteId,
        candidateIdentity: stagedOperationId
      }),
      hostIngressAddress: async () => '172.20.0.1',
      removeRoutes: async (routeIds) => {
        ingressCalls.push({ action: 'remove', routeIds });
      }
    },
    approvalVerifier: async (input) => ({
      approved: input.kind === 'runtime-transfer-apply',
      source: 'foxos-ui'
    }),
    readProviderRecoveryArtifact: () => ({ schemaVersion: 1, provider: 'coolify' }),
    wait: async () => {},
    randomUUID: () => '12345678-1234-1234-1234-1234567890ab'
  });
  return { dataRoot, dockerCalls, ingressCalls, manager };
}

test('a provider group transfers route authority in place without stopping or recreating containers', async () => {
  const parentId = 'res_' + '1'.repeat(32);
  const sidecarId = 'res_' + '2'.repeat(32);
  const proxyId = 'res_' + '3'.repeat(32);
  const parentContainerId = 'a'.repeat(64);
  const sidecarContainerId = 'b'.repeat(64);
  const proxyContainerId = 'c'.repeat(64);
  const snapshot = {
    snapshotId: 'snap_' + '4'.repeat(32),
    resources: [{
      id: parentId,
      name: 'n8n-service',
      provider: 'coolify',
      role: 'application',
      classification: { workloadRole: 'application', stateClass: 'stateful' },
      runtime: {
        containerId: parentContainerId,
        imageId: 'sha256:' + 'd'.repeat(64),
        image: 'n8nio/n8n:latest',
        state: 'running',
        inspection: 'complete'
      },
      routes: [
        { domain: 'n8n.example.com', path: '/', privatePort: 5678 },
        { domain: 'N8N.EXAMPLE.COM', path: '/', privatePort: 5678 }
      ],
      ports: [{ privatePort: 5678, protocol: 'tcp' }],
      mounts: [{ type: 'volume', name: 'n8n-data', destination: '/home/node/.n8n', readOnly: false }],
      networks: [{ name: 'legacy-network', aliases: ['n8n'] }],
      provenance: { project: 'automation', service: 'n8n' }
    }, {
      id: sidecarId,
      name: 'task-runners',
      provider: 'coolify',
      role: 'worker',
      classification: { workloadRole: 'worker', stateClass: 'stateless' },
      runtime: {
        containerId: sidecarContainerId,
        imageId: 'sha256:' + 'e'.repeat(64),
        image: 'n8nio/runners:latest',
        state: 'running',
        inspection: 'complete'
      },
      routes: [], ports: [], mounts: [],
      networks: [{ name: 'legacy-network', aliases: ['task-runners'] }],
      provenance: { project: 'automation', service: 'task-runners' }
    }, {
      id: proxyId,
      name: 'coolify-proxy',
      provider: 'coolify',
      role: 'proxy',
      runtime: { containerId: proxyContainerId, imageId: 'sha256:' + 'f'.repeat(64), state: 'running' },
      networks: [{ name: 'legacy-network' }]
    }],
    relationships: [{
      id: 'rel_' + '5'.repeat(24),
      type: 'route-through-proxy',
      sourceResourceId: parentId,
      targetResourceId: proxyId
    }]
  };
  const { dataRoot, dockerCalls, ingressCalls, manager } = managerHarness({ snapshot });
  try {
    const serverPlan = {
      planId: 'mplan_' + '6'.repeat(32),
      sourceSnapshotId: snapshot.snapshotId,
      resources: [{
        resourceId: parentId,
        name: 'n8n-service',
        migrationRequired: true,
        executionAdapter: 'runtime-transfer',
        migrationGroup: { parentResourceId: parentId, memberResourceIds: [parentId, sidecarId] },
        readiness: { reviewEligible: true, applyImplemented: true }
      }]
    };
    const plan = manager.createPlan({
      serverPlan,
      resourceId: parentId,
      confirmation: PREPARE_RUNTIME_TRANSFER_CONFIRMATION
    });
    assert.deepEqual(plan.memberResourceIds, [parentId, sidecarId]);
    assert.equal(plan.routes.length, 1);
    assert.equal(JSON.stringify(plan).includes('secret-value'), false);

    const operation = await manager.execute(plan.planId, 'one-time-ui-grant');
    assert.equal(operation.status, 'server-runtime-adopted');
    assert.equal(operation.source.stopped, false);
    assert.equal(operation.source.recreated, false);
    assert.equal(operation.memberResourceIds.length, 2);
    assert.equal(operation.trafficProof.zeroDowntime, true);
    assert.equal(dockerCalls.some((call) => /\/stop|\/create|\/delete/.test(call.path)), false);
    assert.equal(dockerCalls.filter((call) => call.path.endsWith('/connect')).length, 1);
    assert.equal(ingressCalls.filter((call) => call.action === 'switch' && call.target === 'foxos').length, 1);
    assert.equal(ingressCalls.some((call) => call.action === 'remove'), false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an inactive provider definition becomes a local server definition without Docker mutation', async () => {
  const resourceId = 'res_' + '7'.repeat(32);
  const snapshot = {
    snapshotId: 'snap_' + '8'.repeat(32),
    relationships: [],
    resources: [{
      id: resourceId,
      kind: 'provider-definition',
      name: 'Directus',
      role: 'application',
      provider: 'coolify',
      runtime: { state: 'stopped', status: 'exited' },
      declaredRoutes: [{ domain: 'directus.example.com', scheme: 'https', path: '/' }],
      provenance: {
        externalDefinition: {
          providerKind: 'application',
          serviceType: 'dockerfile',
          source: { type: 'git' },
          declaredRoutes: [{ domain: 'directus.example.com', scheme: 'https', path: '/' }],
          recoveryArtifact: {
            schemaVersion: 1,
            artifactId: 'pdef_' + 'a'.repeat(32),
            revision: 'pdef_rev_' + 'b'.repeat(32),
            file: 'provider-definitions/recovery/pdef_' + 'a'.repeat(32) + '-pdef_rev_' + 'b'.repeat(32) + '.foxosenc',
            encrypted: true,
            authenticated: true,
            keyId: 'key_' + 'c'.repeat(24),
            plaintextSecretValuesIncluded: false
          }
        }
      }
    }]
  };
  const { dataRoot, dockerCalls, manager } = managerHarness({ snapshot });
  try {
    const serverPlan = {
      planId: 'mplan_' + '9'.repeat(32),
      sourceSnapshotId: snapshot.snapshotId,
      resources: [{
        resourceId,
        migrationRequired: true,
        executionAdapter: 'runtime-transfer',
        readiness: { reviewEligible: true, applyImplemented: true }
      }]
    };
    const plan = manager.createPlan({
      serverPlan,
      resourceId,
      confirmation: PREPARE_RUNTIME_TRANSFER_CONFIRMATION
    });
    const operation = await manager.execute(plan.planId, 'one-time-ui-grant');
    assert.equal(operation.status, 'server-definition-adopted');
    assert.equal(operation.manifests[0].source.type, 'git');
    assert.equal(operation.manifests[0].guarantees.providerNeutralRecoveryCaptured, true);
    assert.equal(dockerCalls.length, 0);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a routed database resolves the one healthy HTTP port before staging traffic', async () => {
  const resourceId = 'res_' + 'a'.repeat(32);
  const proxyId = 'res_' + 'b'.repeat(32);
  const containerId = 'd'.repeat(64);
  const proxyContainerId = 'e'.repeat(64);
  const snapshot = {
    snapshotId: 'snap_' + 'c'.repeat(32),
    resources: [{
      id: resourceId,
      name: 'qdrant',
      provider: 'coolify',
      role: 'database',
      classification: { workloadRole: 'database', stateClass: 'database' },
      runtime: {
        containerId,
        imageId: 'sha256:' + '1'.repeat(64),
        image: 'qdrant/qdrant:latest',
        state: 'running',
        inspection: 'complete'
      },
      routes: [{ domain: 'qdrant.example.com', path: '/' }],
      ports: [
        { privatePort: 6333, protocol: 'tcp' },
        { privatePort: 6334, protocol: 'tcp' }
      ],
      mounts: [{ type: 'volume', name: 'qdrant-data', destination: '/qdrant/storage' }],
      networks: [{ name: 'legacy-network' }]
    }, {
      id: proxyId,
      name: 'coolify-proxy',
      provider: 'coolify',
      role: 'proxy',
      runtime: { containerId: proxyContainerId, imageId: 'sha256:' + '2'.repeat(64), state: 'running' },
      networks: [{ name: 'legacy-network' }]
    }],
    relationships: [{
      id: 'rel_' + '3'.repeat(24),
      type: 'route-through-proxy',
      sourceResourceId: resourceId,
      targetResourceId: proxyId
    }]
  };
  const { dataRoot, manager } = managerHarness({
    snapshot,
    internalProbe: async (_containerId, args) => ({
      exitCode: 0,
      output: String(args.at(-1)).includes(':6333/') ? 'HTTP/1.1 200 OK' : 'HTTP/1.1 400 Bad Request'
    })
  });
  try {
    const serverPlan = {
      planId: 'mplan_' + '4'.repeat(32),
      sourceSnapshotId: snapshot.snapshotId,
      resources: [{
        resourceId,
        migrationRequired: true,
        executionAdapter: 'runtime-transfer',
        readiness: { reviewEligible: true, applyImplemented: true }
      }]
    };
    const plan = manager.createPlan({
      serverPlan,
      resourceId,
      confirmation: PREPARE_RUNTIME_TRANSFER_CONFIRMATION
    });
    assert.deepEqual(plan.routes[0].privatePortCandidates, [6333, 6334]);
    const operation = await manager.execute(plan.planId, 'one-time-ui-grant');
    assert.equal(operation.status, 'server-runtime-adopted');
    assert.equal(operation.routes[0].privatePort, 6333);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
