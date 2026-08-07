const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectInactiveDefinitionDomains,
  createInactiveDefinitionIngressReconciler
} = require('./inactiveDefinitionIngressReconciler');

function inactiveResource({ id, domain, provider = 'coolify' }) {
  return {
    id,
    kind: 'provider-definition',
    provider,
    declaredRoutes: domain ? [{ domain, scheme: 'https', path: '/', tls: true }] : [],
    management: {
      owner: 'foxos',
      state: 'active',
      lifecycle: 'inactive-definition-transfer'
    }
  };
}

test('collects only adopted inactive domains that do not already have an active route', () => {
  const firstId = 'res_' + 'a'.repeat(32);
  const secondId = 'res_' + 'b'.repeat(32);
  const domains = collectInactiveDefinitionDomains({
    resources: [
      inactiveResource({ id: firstId, domain: 'stopped.example.com' }),
      inactiveResource({ id: secondId, domain: 'active.example.com' }),
      { ...inactiveResource({ id: 'res_' + 'c'.repeat(32), domain: 'ignored.example.com' }), management: null }
    ]
  }, {
    routes: {
      active: { domain: 'active.example.com', status: 'active' }
    }
  });
  assert.deepEqual(domains, [{
    domain: 'stopped.example.com',
    provider: 'coolify',
    resourceId: firstId
  }]);
});

test('imports exact pending certificates before reconciling inactive FoxOS routes', async () => {
  const resourceId = 'res_' + 'd'.repeat(32);
  const proxyId = 'e'.repeat(64);
  const imported = [];
  const reconciled = [];
  const snapshot = {
    resources: [
      inactiveResource({ id: resourceId, domain: 'stopped.example.com' }),
      {
        id: 'res_' + 'f'.repeat(32),
        kind: 'container',
        provider: 'coolify',
        role: 'proxy',
        runtime: { containerId: proxyId },
        mounts: [{ destination: '/traefik', readOnly: false }]
      }
    ]
  };
  const manager = createInactiveDefinitionIngressReconciler({
    certificateImporter: {
      importDomain: async (input) => { imported.push(input); return { importId: 'certimp_test' }; }
    },
    ingressAuthority: {
      state: () => ({ routes: {}, inactiveDomains: {} }),
      reconcileInactiveDomains: async (entries) => {
        reconciled.push(entries);
        return { reconciled: true, addedDomains: entries.map((entry) => entry.domain) };
      }
    }
  });
  const result = await manager.reconcile(snapshot);
  assert.deepEqual(imported, [{ domain: 'stopped.example.com', proxyContainerId: proxyId }]);
  assert.deepEqual(reconciled, [[{
    domain: 'stopped.example.com',
    provider: 'coolify',
    resourceId
  }]]);
  assert.equal(result.certificatesImported, 1);
  assert.deepEqual(result.discoveredDomains, ['stopped.example.com']);
});

test('reuses persisted inactive ingress without requiring the legacy proxy again', async () => {
  const resourceId = 'res_' + '1'.repeat(32);
  let imports = 0;
  const manager = createInactiveDefinitionIngressReconciler({
    certificateImporter: { importDomain: async () => { imports += 1; } },
    ingressAuthority: {
      state: () => ({
        routes: {},
        inactiveDomains: { 'stopped.example.com': { resourceId } }
      }),
      reconcileInactiveDomains: async () => ({ reconciled: false, addedDomains: [] })
    }
  });
  const result = await manager.reconcile({
    resources: [inactiveResource({ id: resourceId, domain: 'stopped.example.com' })]
  });
  assert.equal(imports, 0);
  assert.equal(result.certificatesImported, 0);
});

test('a clean server with no adopted inactive domains performs no ingress work', async () => {
  let reconciliations = 0;
  const manager = createInactiveDefinitionIngressReconciler({
    certificateImporter: { importDomain: async () => { throw new Error('must not import'); } },
    ingressAuthority: {
      state: () => ({ routes: {}, inactiveDomains: {} }),
      reconcileInactiveDomains: async () => { reconciliations += 1; }
    }
  });
  const result = await manager.reconcile({ resources: [] });
  assert.equal(result.reconciled, false);
  assert.equal(result.certificatesImported, 0);
  assert.equal(reconciliations, 0);
});
