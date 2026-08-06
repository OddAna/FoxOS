const crypto = require('node:crypto');

const RESOURCE_CLASSIFICATION_SCHEMA_VERSION = 2;

const DATABASE_IDENTITY = /(?:^|[\s/_.:@-])(postgres(?:ql)?|mysql|mariadb|mongodb?|mongo|redis|valkey|qdrant|clickhouse|cassandra|elasticsearch|opensearch|influxdb|cockroach(?:db)?|mssql|sqlserver)(?:$|[\s/_.:@-])/i;
const PROXY_IDENTITY = /(?:^|[\s/_.:@-])(traefik|caddy|nginx|haproxy|envoy)(?:$|[\s/_.:@-])/i;
const AGENT_IDENTITY = /(?:^|[\s/_.:@-])(agent|sentinel|watchtower|collector|exporter)(?:$|[\s/_.:@-])/i;
const WORKER_IDENTITY = /(?:^|[\s/_.:@-])(worker|runner|queue|scheduler|cron)(?:$|[\s/_.:@-])/i;

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort();
}

function identityText(resource) {
  const labels = resource.provenance && resource.provenance.safeLabels || {};
  return [
    resource.name,
    resource.runtime && resource.runtime.image,
    resource.runtime && resource.runtime.unit,
    resource.runtime && resource.runtime.version,
    resource.provenance && resource.provenance.service,
    labels['coolify.service.subName'],
    labels['coolify.serviceName']
  ].filter(Boolean).join(' ').toLowerCase();
}

function workloadRole(resource) {
  const labels = resource.provenance && resource.provenance.safeLabels || {};
  const subtype = String(labels['coolify.service.subType'] || labels['coolify.type'] || '').toLowerCase();
  const identity = identityText(resource);
  const reasons = [];

  if (resource.protected || labels['com.foxos.core'] === 'true' || resource.role === 'core') {
    reasons.push('foxos-core-protection');
    return { value: 'core', reasons };
  }
  if (
    labels['com.foxos.gateway'] === 'true' || resource.name === 'coolify-proxy'
  ) {
    reasons.push(labels['com.foxos.gateway'] === 'true' ? 'foxos-gateway-label' : 'proxy-identity');
    return { value: 'proxy', reasons };
  }
  if (resource.role === 'network-service' || resource.kind === 'host-service' && /wireguard|wg-quick/i.test(identity)) {
    reasons.push('host-network-service');
    return { value: 'network-service', reasons };
  }
  if (subtype === 'database' || resource.role === 'database' || DATABASE_IDENTITY.test(identity)) {
    reasons.push(subtype === 'database' ? 'provider-database-subtype' : 'database-identity');
    return { value: 'database', reasons };
  }
  if (AGENT_IDENTITY.test(identity)) {
    reasons.push('agent-identity');
    return { value: 'agent', reasons };
  }
  if (WORKER_IDENTITY.test(identity) || resource.role === 'worker') {
    reasons.push('worker-identity');
    return { value: 'worker', reasons };
  }

  const hasRoute = Array.isArray(resource.routes) && resource.routes.length > 0;
  const hasPublishedPort = Array.isArray(resource.ports) && resource.ports.some((port) => port.hostPort);
  const foxosApplication = [
    'com.foxos.adoption.disposable',
    'com.foxos.deployment.disposable',
    'com.foxos.compose-deployment.disposable',
    'com.foxos.image-update.disposable'
  ].some((key) => labels[key] === 'true');
  if (foxosApplication) {
    return {
      value: hasRoute || hasPublishedPort ? 'application' : 'internal-service',
      reasons: [hasRoute || hasPublishedPort ? 'foxos-managed-public-workload' : 'foxos-managed-internal-workload']
    };
  }
  if (subtype === 'application') {
    reasons.push('provider-application-subtype');
    if (hasRoute) reasons.push('published-route');
    if (hasPublishedPort) reasons.push('published-host-port');
    return { value: 'application', reasons: sortedUnique(reasons) };
  }
  if (resource.role === 'proxy' || PROXY_IDENTITY.test(identity)) {
    reasons.push('proxy-identity');
    return { value: 'proxy', reasons };
  }
  if (resource.role === 'application' || hasRoute || hasPublishedPort) {
    if (hasRoute) reasons.push('published-route');
    if (hasPublishedPort) reasons.push('published-host-port');
    if (!reasons.length) reasons.push('application-role');
    return { value: 'application', reasons: sortedUnique(reasons) };
  }

  const hasPrivatePort = Array.isArray(resource.ports) && resource.ports.some((port) => port.privatePort);
  const hasProjectIdentity = Boolean(
    resource.provenance && (resource.provenance.project || resource.provenance.service)
  );
  if (hasPrivatePort || hasProjectIdentity || resource.role === 'service') {
    if (hasPrivatePort) reasons.push('private-port-only');
    if (hasProjectIdentity) reasons.push('provider-project-service');
    if (!reasons.length) reasons.push('generic-service-role');
    return { value: 'internal-service', reasons: sortedUnique(reasons) };
  }

  return { value: 'unknown', reasons: ['insufficient-role-evidence'] };
}

function stateClass(resource, role) {
  if (resource.kind === 'provider-definition') {
    if (role === 'database') return { value: 'database', reasons: ['provider-database-definition'] };
    return { value: 'unknown', reasons: ['provider-definition-runtime-absent'] };
  }
  if (resource.kind === 'host-service') {
    return { value: 'host-configured', reasons: ['host-configuration-and-unit-state'] };
  }
  if (!resource.runtime || resource.runtime.inspection !== 'complete') {
    return { value: 'unknown', reasons: ['docker-inspection-incomplete'] };
  }
  if (role === 'database') {
    return { value: 'database', reasons: ['database-workload-role'] };
  }

  const mounts = Array.isArray(resource.mounts) ? resource.mounts : [];
  if (mounts.some((mount) => !mount.type || mount.type === 'unknown')) {
    return { value: 'unknown', reasons: ['mount-type-unknown'] };
  }
  const writable = mounts.filter((mount) => mount.readOnly !== true);
  if (writable.length) {
    const types = writable.map((mount) => `writable-${mount.type || 'unknown'}-mount`);
    return { value: 'stateful', reasons: sortedUnique(types) };
  }
  return {
    value: 'stateless',
    reasons: mounts.length ? ['read-only-mounts-only'] : ['no-declared-mounts']
  };
}

function authorityClass(resource) {
  if (resource.provider === 'foxos' && resource.ownership === 'foxos-managed') {
    return { value: 'foxos-owned', reasons: ['foxos-provider-and-managed-ownership'] };
  }
  return { value: 'provider-owned', reasons: ['external-or-observed-authority'] };
}

function auditCandidate(resource, classification) {
  const blockers = [];
  if (classification.authorityClass !== 'provider-owned') blockers.push('already-foxos-owned');
  if (classification.workloadRole !== 'application') blockers.push('not-application-workload');
  if (classification.stateClass !== 'stateless') blockers.push('not-stateless');
  if (classification.status !== 'classified') blockers.push('classification-needs-review');
  if (resource.protected) blockers.push('protected-resource');
  if (!resource.runtime || resource.runtime.inspection !== 'complete') blockers.push('inspection-incomplete');
  if (!resource.runtime || resource.runtime.state !== 'running') blockers.push('runtime-not-running');
  if (resource.kind && resource.kind !== 'container') blockers.push('not-docker-container');
  return {
    eligibleForReadOnlyAudit: blockers.length === 0,
    blockers: sortedUnique(blockers),
    applyApproved: false,
    providerDetachApproved: false
  };
}

function classifyResource(resource) {
  const role = workloadRole(resource);
  const state = stateClass(resource, role.value);
  const authority = authorityClass(resource);
  const status = role.value === 'unknown' || state.value === 'unknown' ? 'needs-review' : 'classified';
  const core = {
    schemaVersion: RESOURCE_CLASSIFICATION_SCHEMA_VERSION,
    workloadRole: role.value,
    stateClass: state.value,
    authorityClass: authority.value,
    status,
    evidence: {
      workloadRole: sortedUnique(role.reasons),
      stateClass: sortedUnique(state.reasons),
      authorityClass: sortedUnique(authority.reasons)
    },
    warnings: state.value === 'stateless'
      ? ['no-declared-writable-mount-does-not-prove-application-data-free']
      : []
  };
  const revision = 'class_' + stableHash(core).slice(0, 32);
  const classification = { ...core, revision };
  return {
    ...classification,
    independenceAudit: auditCandidate(resource, classification)
  };
}

module.exports = {
  RESOURCE_CLASSIFICATION_SCHEMA_VERSION,
  classifyResource
};
