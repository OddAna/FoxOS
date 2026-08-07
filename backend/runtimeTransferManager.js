const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const RUNTIME_TRANSFER_SCHEMA_VERSION = 1;
const PREPARE_RUNTIME_TRANSFER_CONFIRMATION = 'PREPARE RUNTIME TRANSFER';
const PLAN_ID_PATTERN = /^rtplan_[a-f0-9]{32}$/;
const OPERATION_ID_PATTERN = /^rtop_[a-f0-9]{32}$/;
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const SNAPSHOT_ID_PATTERN = /^snap_[a-f0-9]{32}$/;
const MAX_RECORDS = 100;

class RuntimeTransferError extends Error {
  constructor(message, statusCode = 409, code = 'runtime-transfer-error') {
    super(message);
    this.name = 'RuntimeTransferError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function listJson(directory) {
  try {
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
      .map((file) => readJson(path.join(directory, file))).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function prune(directory) {
  const records = listJson(directory).sort((left, right) => (
    String(left.createdAt || left.startedAt).localeCompare(String(right.createdAt || right.startedAt))
  ));
  for (const record of records.slice(0, Math.max(0, records.length - MAX_RECORDS))) {
    const id = record.planId || record.operationId;
    if (id) fs.unlinkSync(path.join(directory, id + '.json'));
  }
}

function routePath(value) {
  const normalized = String(value || '/');
  return normalized.startsWith('/') ? normalized : '/';
}

function routeAlias(resourceId) {
  return 'server-' + String(resourceId).replace(/^res_/, '').slice(0, 24);
}

function routeId(resourceId, domain, requestPath) {
  return 'smroute_' + hash(canonicalJson({ resourceId, domain, path: requestPath }), 24);
}

function normalizedRoutes(resource) {
  const observedPorts = Array.from(new Set((resource.ports || [])
    .filter((port) => port.protocol === 'tcp' && Number.isInteger(port.privatePort))
    .map((port) => port.privatePort))).sort((left, right) => left - right);
  const healthPort = resource.runtime && resource.runtime.health && resource.runtime.health.httpTarget &&
    resource.runtime.health.httpTarget.privatePort;
  const routes = new Map();
  for (const rawRoute of resource.routes || []) {
    const domain = String(rawRoute.domain || '').trim().toLowerCase();
    const requestPath = routePath(rawRoute.path);
    const privatePortCandidates = Number.isInteger(rawRoute.privatePort)
      ? [rawRoute.privatePort]
      : Number.isInteger(healthPort) && observedPorts.includes(healthPort)
        ? [healthPort]
        : observedPorts;
    if (!domain || !privatePortCandidates.length) continue;
    const key = domain + '\0' + requestPath;
    const existing = routes.get(key);
    if (existing && canonicalJson(existing.privatePortCandidates) !== canonicalJson(privatePortCandidates)) {
      throw new RuntimeTransferError(
        'The same public route resolves to multiple private ports',
        409,
        'ambiguous-public-route'
      );
    }
    routes.set(key, {
      routeId: routeId(resource.id, domain, requestPath),
      domain,
      path: requestPath,
      privatePort: privatePortCandidates.length === 1 ? privatePortCandidates[0] : null,
      privatePortCandidates
    });
  }
  return [...routes.values()].sort((left, right) => (
    left.domain.localeCompare(right.domain) || left.path.localeCompare(right.path)
  ));
}

function runtimeManifest(resource, environmentRevision) {
  const runtime = resource.runtime || {};
  return {
    schemaVersion: RUNTIME_TRANSFER_SCHEMA_VERSION,
    resourceId: resource.id,
    name: resource.name,
    role: resource.classification && resource.classification.workloadRole || resource.role || null,
    stateClass: resource.classification && resource.classification.stateClass || null,
    desiredState: runtime.state,
    runtime: {
      engine: 'docker',
      containerId: runtime.containerId,
      imageId: runtime.imageId,
      requestedImage: runtime.image || null,
      restartPolicy: runtime.restartPolicy || null,
      health: runtime.health || null
    },
    ports: resource.ports || [],
    mounts: resource.mounts || [],
    networks: (resource.networks || []).map((network) => ({
      name: network.name,
      aliases: network.aliases || []
    })),
    routes: resource.routes || [],
    environment: {
      revision: environmentRevision && environmentRevision.revision || null,
      valuesIncluded: false
    },
    provenance: {
      importedFrom: resource.provider,
      project: resource.provenance && resource.provenance.project || null,
      service: resource.provenance && resource.provenance.service || null
    },
    guarantees: {
      secretValuesIncluded: false,
      runtimeRecreated: false,
      namedVolumesMoved: false,
      existingRuntimePreserved: true
    }
  };
}

function definitionManifest(resource) {
  const external = resource.provenance && resource.provenance.externalDefinition || {};
  return {
    schemaVersion: RUNTIME_TRANSFER_SCHEMA_VERSION,
    resourceId: resource.id,
    name: resource.name,
    kind: 'inactive-provider-definition',
    role: resource.role || null,
    desiredState: 'stopped',
    source: external.source || null,
    serviceType: external.serviceType || null,
    declaredRoutes: external.declaredRoutes || resource.declaredRoutes || [],
    observedStatus: external.status || resource.runtime && resource.runtime.status || null,
    provenance: { importedFrom: resource.provider },
    guarantees: {
      secretValuesIncluded: false,
      providerRuntimeRequired: false,
      activationPerformed: false
    }
  };
}

function createRuntimeTransferManager({
  dataRoot,
  dockerRequest,
  dockerExec,
  resourceRegistry,
  secretManager,
  certificateImporter,
  ingressAuthority,
  approvalVerifier,
  routingNetwork = 'foxos-routing',
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerExec !== 'function' ||
    !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    !secretManager || typeof secretManager.getEnvironmentRevision !== 'function' ||
    !certificateImporter || typeof certificateImporter.importDomain !== 'function' ||
    !ingressAuthority || typeof ingressAuthority.stageRoutes !== 'function' ||
    typeof approvalVerifier !== 'function'
  ) throw new Error('Runtime transfer manager requires Docker, registry, secret, certificate, ingress and approval adapters');

  const root = path.join(dataRoot, 'runtime-transfers');
  const plansRoot = path.join(root, 'plans');
  const operationsRoot = path.join(root, 'operations');

  function now() {
    return new Date(clock()).toISOString();
  }

  function planFile(planId) {
    if (!PLAN_ID_PATTERN.test(String(planId || ''))) {
      throw new RuntimeTransferError('Invalid runtime transfer plan ID', 400, 'invalid-plan-id');
    }
    return path.join(plansRoot, planId + '.json');
  }

  function operationFile(operationId) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) {
      throw new RuntimeTransferError('Invalid runtime transfer operation ID', 400, 'invalid-operation-id');
    }
    return path.join(operationsRoot, operationId + '.json');
  }

  function getPlan(planId) {
    const plan = readJson(planFile(planId));
    if (!plan) throw new RuntimeTransferError('Runtime transfer plan was not found', 404, 'plan-not-found');
    return plan;
  }

  function getOperation(operationId) {
    const operation = readJson(operationFile(operationId));
    if (!operation) throw new RuntimeTransferError('Runtime transfer operation was not found', 404, 'operation-not-found');
    return operation;
  }

  function persistOperation(operation) {
    operation.updatedAt = now();
    atomicWriteJson(operationFile(operation.operationId), operation);
    return operation;
  }

  function currentSnapshot(snapshotId) {
    const snapshot = resourceRegistry.getLatest();
    if (!snapshot || snapshot.snapshotId !== snapshotId) {
      throw new RuntimeTransferError('Server inventory changed after runtime transfer planning', 409, 'registry-snapshot-stale');
    }
    return snapshot;
  }

  function memberResources(snapshot, resource, plannedResource) {
    const ids = plannedResource.migrationGroup && plannedResource.migrationGroup.memberResourceIds || [resource.id];
    const byId = new Map((snapshot.resources || []).map((entry) => [entry.id, entry]));
    const members = ids.map((id) => byId.get(id));
    if (members.some((member) => !member)) {
      throw new RuntimeTransferError('A grouped runtime disappeared before transfer', 409, 'group-member-missing');
    }
    return members;
  }

  function createPlan(input = {}) {
    if (input.confirmation !== PREPARE_RUNTIME_TRANSFER_CONFIRMATION) {
      throw new RuntimeTransferError('Exact runtime transfer planning confirmation is required', 400, 'confirmation-required');
    }
    if (!input.serverPlan || !SNAPSHOT_ID_PATTERN.test(String(input.serverPlan.sourceSnapshotId || ''))) {
      throw new RuntimeTransferError('Runtime transfer server plan is invalid', 400, 'invalid-server-plan');
    }
    const plannedResource = (input.serverPlan.resources || []).find((entry) => entry.resourceId === input.resourceId);
    if (
      !plannedResource || !RESOURCE_ID_PATTERN.test(String(plannedResource.resourceId || '')) ||
      plannedResource.migrationRequired !== true || plannedResource.executionAdapter !== 'runtime-transfer' ||
      !plannedResource.readiness || plannedResource.readiness.reviewEligible !== true ||
      plannedResource.readiness.applyImplemented !== true
    ) throw new RuntimeTransferError('Selected resource has no executable runtime transfer', 409, 'runtime-transfer-unavailable');

    const snapshot = currentSnapshot(input.serverPlan.sourceSnapshotId);
    const resource = (snapshot.resources || []).find((entry) => entry.id === plannedResource.resourceId);
    if (!resource) throw new RuntimeTransferError('Selected resource disappeared', 404, 'resource-not-found');
    const members = resource.kind === 'provider-definition'
      ? []
      : memberResources(snapshot, resource, plannedResource);
    const routes = normalizedRoutes(resource);
    const manifests = resource.kind === 'provider-definition'
      ? [definitionManifest(resource)]
      : members.map((member) => runtimeManifest(
          member,
          secretManager.getEnvironmentRevision(member.id)
        ));
    const core = {
      schemaVersion: RUNTIME_TRANSFER_SCHEMA_VERSION,
      mode: resource.kind === 'provider-definition' ? 'inactive-definition-transfer' : 'in-place-runtime-transfer',
      serverPlanId: input.serverPlan.planId,
      sourceSnapshotId: snapshot.snapshotId,
      resourceId: resource.id,
      resourceName: resource.name,
      memberResourceIds: resource.kind === 'provider-definition' ? [resource.id] : members.map((member) => member.id).sort(),
      primaryContainerId: resource.runtime && resource.runtime.containerId || null,
      routeAlias: routes.length ? routeAlias(resource.id) : null,
      routes,
      manifests,
      guarantees: {
        runtimeStopped: false,
        runtimeRecreated: false,
        dataCopied: false,
        secretValuesIncluded: false,
        providerStateMutated: false,
        existingContainersBecomeServerAuthority: resource.kind !== 'provider-definition'
      }
    };
    const evidenceFingerprint = hash(canonicalJson(core), 64);
    const planId = 'rtplan_' + hash(canonicalJson({ ...core, evidenceFingerprint }), 32);
    const existing = readJson(planFile(planId));
    if (existing) return existing;
    const plan = { ...core, evidenceFingerprint, planId, createdAt: now() };
    atomicWriteJson(planFile(planId), plan);
    prune(plansRoot);
    return plan;
  }

  async function verifyApproval(plan, approval) {
    const grant = await approvalVerifier({
      kind: 'runtime-transfer-apply',
      planId: plan.planId,
      resourceId: plan.resourceId,
      evidenceFingerprint: plan.evidenceFingerprint,
      approval
    });
    if (!grant || grant.approved !== true || grant.source !== 'foxos-ui') {
      throw new RuntimeTransferError('Runtime transfer UI approval is invalid', 403, 'ui-approval-invalid');
    }
  }

  function routeProxy(snapshot, resource) {
    const relationship = (snapshot.relationships || []).find((entry) => (
      entry.type === 'route-through-proxy' && entry.sourceResourceId === resource.id
    ));
    const proxy = relationship && (snapshot.resources || []).find((entry) => entry.id === relationship.targetResourceId);
    if (!proxy || !proxy.runtime || !CONTAINER_ID_PATTERN.test(String(proxy.runtime.containerId || ''))) {
      throw new RuntimeTransferError('Current public route proxy could not be verified', 409, 'legacy-route-proxy-unavailable');
    }
    const sourceNetworks = new Set((resource.networks || []).map((network) => network.name));
    const legacyNetwork = (proxy.networks || []).map((network) => network.name)
      .filter((name) => sourceNetworks.has(name) && name !== routingNetwork).sort()[0];
    if (!legacyNetwork) {
      throw new RuntimeTransferError('Source and public proxy have no verified shared network', 409, 'legacy-route-network-unavailable');
    }
    return { containerId: proxy.runtime.containerId, legacyNetwork };
  }

  async function resolveHealthyRoutes(containerId, alias, routes) {
    const infrastructure = await ingressAuthority.inspectOwnedInfrastructure();
    const gatewayId = infrastructure && infrastructure.gateway && infrastructure.gateway.Id;
    if (!routes.length || !CONTAINER_ID_PATTERN.test(String(gatewayId || ''))) return routes;
    let lastStatuses = [];
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
      if (!details.State || details.State.Running !== true) {
        throw new RuntimeTransferError('Existing runtime stopped during transfer', 503, 'source-runtime-stopped');
      }
      const resolved = [];
      lastStatuses = [];
      let pending = false;
      for (const route of routes) {
        const healthyPorts = [];
        for (const privatePort of route.privatePortCandidates || []) {
          let statusCode = null;
          try {
            const result = await dockerExec(gatewayId, [
              'wget', '--server-response', '--output-document=/dev/null', '--timeout=2',
              'http://' + alias + ':' + privatePort + route.path
            ], { timeoutMs: 5000, maxResponseBytes: 64 * 1024 });
            const match = String(result.output || '').match(/HTTP\/1\.[01]\s+([0-9]{3})/i);
            statusCode = match ? Number.parseInt(match[1], 10) : null;
          } catch { /* candidate stays unhealthy for this bounded sample */ }
          lastStatuses.push({ domain: route.domain, path: route.path, privatePort, statusCode, attempt });
          if (statusCode >= 200 && statusCode < 400) healthyPorts.push(privatePort);
        }
        if (healthyPorts.length > 1) {
          throw new RuntimeTransferError(
            'More than one private port answered the same public route',
            409,
            'ambiguous-public-route-port'
          );
        }
        if (!healthyPorts.length) {
          pending = true;
          continue;
        }
        resolved.push({ ...route, privatePort: healthyPorts[0] });
      }
      if (!pending && resolved.length === routes.length) return resolved;
      await wait(250);
    }
    const observed = lastStatuses.filter((entry) => entry.statusCode)
      .map((entry) => `${entry.privatePort}:${entry.statusCode}`).join(', ');
    throw new RuntimeTransferError(
      'Existing runtime did not answer through the server routing network' +
        (observed ? ` (${observed})` : ''),
      503,
      'runtime-route-health-failed'
    );
  }

  async function execute(planId, approval) {
    const plan = getPlan(planId);
    await verifyApproval(plan, approval);
    const snapshot = currentSnapshot(plan.sourceSnapshotId);
    const resource = (snapshot.resources || []).find((entry) => entry.id === plan.resourceId);
    if (!resource) throw new RuntimeTransferError('Selected resource disappeared', 404, 'resource-not-found');
    const operationId = 'rtop_' + randomUUID().replace(/-/g, '');
    const operation = {
      schemaVersion: RUNTIME_TRANSFER_SCHEMA_VERSION,
      operationId,
      planId,
      resourceId: plan.resourceId,
      memberResourceIds: plan.memberResourceIds,
      mode: plan.mode,
      status: 'running',
      primaryContainerId: plan.primaryContainerId,
      candidateContainerId: plan.primaryContainerId,
      network: { name: routingNetwork, connectedByOperation: false, alias: plan.routeAlias },
      routes: [],
      switchedDomains: [],
      provider: { mutated: false, detached: false },
      source: { stopped: false, recreated: false, retained: true },
      manifests: plan.manifests,
      startedAt: now()
    };
    persistOperation(operation);

    if (plan.mode === 'inactive-definition-transfer') {
      operation.status = 'server-definition-adopted';
      operation.completedAt = now();
      persistOperation(operation);
      prune(operationsRoot);
      return operation;
    }

    try {
      const members = plan.memberResourceIds.map((resourceId) => (
        (snapshot.resources || []).find((entry) => entry.id === resourceId)
      ));
      for (const member of members) {
        if (!member || !member.runtime || !CONTAINER_ID_PATTERN.test(String(member.runtime.containerId || ''))) {
          throw new RuntimeTransferError('A grouped runtime identity is missing', 409, 'group-runtime-identity-missing');
        }
        const details = await dockerRequest('GET', '/containers/' + member.runtime.containerId + '/json');
        if (!details.State || details.State.Running !== true || details.Image !== member.runtime.imageId) {
          throw new RuntimeTransferError('A grouped runtime changed before transfer', 409, 'group-runtime-stale');
        }
      }

      if (plan.routes.length) {
        const proxy = routeProxy(snapshot, resource);
        await ingressAuthority.ensureLegacyBridge({
          proxyContainerId: proxy.containerId,
          legacyNetwork: proxy.legacyNetwork
        });
        for (const route of plan.routes) {
          await ingressAuthority.verifyLegacyDomain({ hostname: route.domain, requestPath: route.path });
          await certificateImporter.importDomain({ domain: route.domain, proxyContainerId: proxy.containerId });
        }
        const primary = await dockerRequest('GET', '/containers/' + plan.primaryContainerId + '/json');
        const attached = primary.NetworkSettings && primary.NetworkSettings.Networks &&
          primary.NetworkSettings.Networks[routingNetwork];
        if (!attached) {
          await dockerRequest('POST', '/networks/' + encodeURIComponent(routingNetwork) + '/connect', {
            Container: plan.primaryContainerId,
            EndpointConfig: { Aliases: [plan.routeAlias] }
          });
          operation.network.connectedByOperation = true;
          persistOperation(operation);
        }
        const healthyRoutes = await resolveHealthyRoutes(plan.primaryContainerId, plan.routeAlias, plan.routes);
        const staged = await ingressAuthority.stageRoutes(healthyRoutes.map((route) => ({
          routeId: route.routeId,
          operationId,
          domain: route.domain,
          path: route.path,
          alias: plan.routeAlias,
          privatePort: route.privatePort
        })));
        operation.routes = staged.map((route) => ({
          routeId: route.routeId,
          domain: route.domain,
          path: route.path,
          alias: route.alias,
          privatePort: route.privatePort
        }));
        persistOperation(operation);
        const primaryRoute = operation.routes[0];
        const stagedProof = await ingressAuthority.httpsProbe({
          hostname: primaryRoute.domain,
          connectHost: 'foxos-gateway',
          requestPath: primaryRoute.path,
          expectedRouteId: primaryRoute.routeId
        });
        if (
          stagedProof.tlsValid !== true || stagedProof.expectedRoute !== true ||
          stagedProof.statusCode < 200 || stagedProof.statusCode >= 400
        ) throw new RuntimeTransferError('Server route staging proof failed', 503, 'route-stage-proof-failed');
        for (const domain of new Set(operation.routes.map((route) => route.domain))) {
          await ingressAuthority.switchDomain(domain, 'foxos');
          operation.switchedDomains.push(domain);
          persistOperation(operation);
        }
        const connectHost = await ingressAuthority.hostIngressAddress();
        for (let sample = 0; sample < 5; sample += 1) {
          const proof = await ingressAuthority.httpsProbe({
            hostname: primaryRoute.domain,
            connectHost,
            requestPath: primaryRoute.path,
            expectedRouteId: primaryRoute.routeId
          });
          if (
            proof.tlsValid !== true || proof.expectedRoute !== true ||
            proof.candidateIdentity !== operationId ||
            proof.statusCode < 200 || proof.statusCode >= 400
          ) throw new RuntimeTransferError('Public traffic proof failed', 503, 'public-traffic-proof-failed');
        }
      }

      operation.status = 'server-runtime-adopted';
      operation.trafficProof = {
        healthy: true,
        tlsValid: plan.routes.length ? true : null,
        candidateServing: plan.routes.length ? true : null,
        unavailableSamples: 0,
        zeroDowntime: true
      };
      operation.completedAt = now();
      persistOperation(operation);
      prune(operationsRoot);
      return operation;
    } catch (error) {
      let rollbackFailed = false;
      for (const domain of [...operation.switchedDomains].reverse()) {
        try { await ingressAuthority.switchDomain(domain, 'legacy'); } catch { rollbackFailed = true; }
      }
      if (operation.routes.length) {
        try { await ingressAuthority.removeRoutes(operation.routes.map((route) => route.routeId)); } catch { rollbackFailed = true; }
      }
      if (operation.network.connectedByOperation) {
        try {
          await dockerRequest('POST', '/networks/' + encodeURIComponent(routingNetwork) + '/disconnect', {
            Container: plan.primaryContainerId,
            Force: false
          });
        } catch { rollbackFailed = true; }
      }
      operation.status = rollbackFailed ? 'recovery-required' : 'rolled-back-after-failure';
      operation.error = { code: error.code || 'runtime-transfer-failed', message: error.message };
      operation.completedAt = now();
      persistOperation(operation);
      const failure = error instanceof RuntimeTransferError
        ? error
        : new RuntimeTransferError(error.message || 'Runtime transfer failed', 500, error.code || 'runtime-transfer-failed');
      failure.operationId = operationId;
      throw failure;
    }
  }

  function status() {
    const plans = listJson(plansRoot);
    const operations = listJson(operationsRoot);
    return {
      schemaVersion: RUNTIME_TRANSFER_SCHEMA_VERSION,
      mode: 'runtime-transfers',
      plans,
      operations,
      summary: {
        plans: plans.length,
        operations: operations.length,
        completed: operations.filter((operation) => (
          ['server-runtime-adopted', 'server-definition-adopted'].includes(operation.status)
        )).length,
        recoveryRequired: operations.filter((operation) => operation.status === 'recovery-required').length
      }
    };
  }

  ensureDirectory(plansRoot);
  ensureDirectory(operationsRoot);
  return { createPlan, execute, getOperation, getPlan, paths: { root, plansRoot, operationsRoot }, status };
}

module.exports = {
  PREPARE_RUNTIME_TRANSFER_CONFIRMATION,
  RUNTIME_TRANSFER_SCHEMA_VERSION,
  RuntimeTransferError,
  createRuntimeTransferManager
};
