const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;

class InactiveDefinitionIngressError extends Error {
  constructor(message, statusCode = 409, code = 'inactive-definition-ingress-error') {
    super(message);
    this.name = 'InactiveDefinitionIngressError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function collectInactiveDefinitionDomains(snapshot, ingressState = {}) {
  const activeDomains = new Set(Object.values(ingressState.routes || {})
    .filter((route) => route && route.status !== 'removed')
    .map((route) => route.domain));
  const domains = new Map();
  for (const resource of snapshot && snapshot.resources || []) {
    const management = resource && resource.management || {};
    if (
      resource.kind !== 'provider-definition' ||
      management.owner !== 'foxos' || management.state !== 'active' ||
      management.lifecycle !== 'inactive-definition-transfer' ||
      !RESOURCE_ID_PATTERN.test(String(resource.id || ''))
    ) continue;
    for (const route of resource.declaredRoutes || []) {
      const domain = String(route && route.domain || '').toLowerCase();
      if (!DOMAIN_PATTERN.test(domain) || activeDomains.has(domain)) continue;
      const existing = domains.get(domain);
      if (existing && existing.resourceId !== resource.id) {
        throw new InactiveDefinitionIngressError(
          'Inactive definition domain belongs to more than one server resource',
          409,
          'inactive-definition-domain-conflict'
        );
      }
      domains.set(domain, {
        domain,
        provider: resource.provider,
        resourceId: resource.id
      });
    }
  }
  return [...domains.values()].sort((left, right) => left.domain.localeCompare(right.domain));
}

function proxyForProvider(snapshot, provider) {
  const candidates = (snapshot && snapshot.resources || []).filter((resource) => (
    resource && resource.kind === 'container' && resource.provider === provider &&
    resource.role === 'proxy' && resource.runtime &&
    CONTAINER_ID_PATTERN.test(String(resource.runtime.containerId || '')) &&
    (resource.mounts || []).some((mount) => mount.destination === '/traefik' && mount.readOnly !== true)
  ));
  if (candidates.length !== 1) {
    throw new InactiveDefinitionIngressError(
      'The exact certificate source for an inactive definition could not be verified',
      409,
      'inactive-definition-certificate-source-unavailable'
    );
  }
  return candidates[0];
}

function createInactiveDefinitionIngressReconciler({ certificateImporter, ingressAuthority }) {
  if (
    !certificateImporter || typeof certificateImporter.importDomain !== 'function' ||
    !ingressAuthority || typeof ingressAuthority.state !== 'function' ||
    typeof ingressAuthority.reconcileInactiveDomains !== 'function'
  ) throw new Error('Inactive definition ingress reconciler requires certificate and ingress adapters');

  async function reconcile(snapshot) {
    const current = ingressAuthority.state();
    const domains = collectInactiveDefinitionDomains(snapshot, current);
    if (!domains.length) {
      return {
        reconciled: false,
        addedDomains: [],
        inactiveDomains: Object.keys(current.inactiveDomains || {}).sort(),
        discoveredDomains: [],
        certificatesImported: 0
      };
    }
    const existing = current.inactiveDomains || {};
    const pending = domains.filter((entry) => !existing[entry.domain]);
    for (const entry of pending) {
      const proxy = proxyForProvider(snapshot, entry.provider);
      await certificateImporter.importDomain({
        domain: entry.domain,
        proxyContainerId: proxy.runtime.containerId
      });
    }
    const result = await ingressAuthority.reconcileInactiveDomains(domains);
    return {
      ...result,
      discoveredDomains: domains.map((entry) => entry.domain),
      certificatesImported: pending.length
    };
  }

  return { reconcile };
}

module.exports = {
  collectInactiveDefinitionDomains,
  createInactiveDefinitionIngressReconciler,
  InactiveDefinitionIngressError,
  proxyForProvider
};
