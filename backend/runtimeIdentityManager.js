const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');
const { localRuntimeImageReference } = require('./productionStatelessMigrationAdapter');

const COMPLETED_STATUS = 'traffic-on-foxos-source-preserved';
const OPERATION_ID_PATTERN = /^smop_[a-f0-9]{32}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

class RuntimeIdentityError extends Error {
  constructor(message, code = 'runtime-identity-error') {
    super(message);
    this.name = 'RuntimeIdentityError';
    this.code = code;
  }
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

function containerName(details) {
  return String(details && details.Name || '').replace(/^\//, '');
}

function definedObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function clonedHostConfig(hostConfig) {
  return definedObject({
    Binds: hostConfig.Binds,
    Mounts: hostConfig.Mounts,
    NetworkMode: hostConfig.NetworkMode,
    RestartPolicy: hostConfig.RestartPolicy,
    AutoRemove: hostConfig.AutoRemove,
    VolumeDriver: hostConfig.VolumeDriver,
    PortBindings: hostConfig.PortBindings,
    Privileged: hostConfig.Privileged,
    ReadonlyRootfs: hostConfig.ReadonlyRootfs,
    CapAdd: hostConfig.CapAdd,
    CapDrop: hostConfig.CapDrop,
    SecurityOpt: hostConfig.SecurityOpt,
    Memory: hostConfig.Memory,
    MemorySwap: hostConfig.MemorySwap,
    MemoryReservation: hostConfig.MemoryReservation,
    NanoCpus: hostConfig.NanoCpus,
    CpuShares: hostConfig.CpuShares,
    CpusetCpus: hostConfig.CpusetCpus,
    PidsLimit: hostConfig.PidsLimit,
    Ulimits: hostConfig.Ulimits,
    OomKillDisable: hostConfig.OomKillDisable,
    ShmSize: hostConfig.ShmSize,
    Tmpfs: hostConfig.Tmpfs,
    Dns: hostConfig.Dns,
    DnsOptions: hostConfig.DnsOptions,
    DnsSearch: hostConfig.DnsSearch,
    ExtraHosts: hostConfig.ExtraHosts,
    GroupAdd: hostConfig.GroupAdd,
    Sysctls: hostConfig.Sysctls,
    Init: hostConfig.Init,
    LogConfig: hostConfig.LogConfig
  });
}

function clonedContainerPayload(details, imageReference, initialNetwork, aliases) {
  const config = details.Config || {};
  const labels = {
    ...(config.Labels || {}),
    'com.foxos.image.reference': imageReference
  };
  return definedObject({
    Image: imageReference,
    Entrypoint: config.Entrypoint,
    Cmd: config.Cmd,
    WorkingDir: config.WorkingDir,
    User: config.User,
    Env: config.Env,
    Labels: labels,
    ExposedPorts: config.ExposedPorts,
    Healthcheck: config.Healthcheck,
    StopSignal: config.StopSignal,
    StopTimeout: config.StopTimeout,
    Tty: config.Tty,
    OpenStdin: config.OpenStdin,
    StdinOnce: config.StdinOnce,
    HostConfig: clonedHostConfig(details.HostConfig || {}),
    NetworkingConfig: {
      EndpointsConfig: {
        [initialNetwork]: { Aliases: aliases }
      }
    }
  });
}

function networkAttachments(details) {
  return Object.entries(details.NetworkSettings && details.NetworkSettings.Networks || {})
    .map(([name, network]) => ({
      name,
      aliases: Array.from(new Set((network && network.Aliases || []).filter(Boolean)))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function replacementName(name) {
  const suffix = '-previous-' + crypto.randomBytes(4).toString('hex');
  return name.slice(0, Math.max(1, 63 - suffix.length)).replace(/-+$/g, '') + suffix;
}

function createRuntimeIdentityManager({
  dataRoot,
  dockerRequest,
  dockerExec,
  ingressAuthority,
  routingNetwork = 'foxos-routing',
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  readinessAttempts = 60,
  clock = () => new Date()
}) {
  if (
    !dataRoot || typeof dockerRequest !== 'function' || typeof dockerExec !== 'function' ||
    !ingressAuthority || typeof ingressAuthority.httpsProbe !== 'function' ||
    typeof ingressAuthority.hostIngressAddress !== 'function' ||
    typeof ingressAuthority.inspectOwnedInfrastructure !== 'function' ||
    typeof ingressAuthority.refreshOperationRuntime !== 'function'
  ) {
    throw new Error('Runtime identity manager requires data, Docker and ingress adapters');
  }

  const migrationRoot = path.join(dataRoot, 'stateless-migrations', 'operations');
  const adapterRoot = path.join(dataRoot, 'production-stateless-adapter', 'operations');

  function now() {
    return new Date(clock()).toISOString();
  }

  function operationFile(operationId) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) {
      throw new RuntimeIdentityError('Invalid stateless migration operation ID', 'invalid-operation-id');
    }
    return path.join(migrationRoot, operationId + '.json');
  }

  function adapterFile(operationId) {
    if (!OPERATION_ID_PATTERN.test(String(operationId || ''))) {
      throw new RuntimeIdentityError('Invalid stateless migration operation ID', 'invalid-operation-id');
    }
    return path.join(adapterRoot, operationId + '.json');
  }

  function completedOperations() {
    return listJson(migrationRoot).filter((operation) => (
      operation && operation.status === COMPLETED_STATUS &&
      OPERATION_ID_PATTERN.test(String(operation.operationId || '')) &&
      operation.candidate && CONTAINER_ID_PATTERN.test(String(operation.candidate.containerId || ''))
    ));
  }

  function targetsFor(operation) {
    const adapterState = readJson(adapterFile(operation.operationId));
    if (!adapterState || adapterState.operationId !== operation.operationId) {
      throw new RuntimeIdentityError('Production adapter state is missing', 'adapter-state-not-found');
    }
    if (adapterState.candidate && adapterState.candidate.containerId !== operation.candidate.containerId) {
      throw new RuntimeIdentityError('Candidate identity differs between transaction records', 'candidate-state-mismatch');
    }
    const route = (adapterState.routes || []).find((entry) => (
      entry && entry.routeId && entry.domain && Number.isInteger(entry.privatePort)
    )) || null;
    const health = adapterState.health || {
      privatePort: operation.candidate.privatePort ||
        adapterState.candidate && adapterState.candidate.privatePort ||
        route && route.privatePort,
      path: operation.route && operation.route.path || route && route.path || '/'
    };
    const dependencies = (adapterState.dependencies || []).map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => (
        entry && CONTAINER_ID_PATTERN.test(String(entry.bridgeContainerId || ''))
      )).map(({ entry, index }) => ({
      kind: 'dependency',
      operationId: operation.operationId,
      containerId: entry.bridgeContainerId,
      dependencyIndex: index,
      route,
      health
    }));
    return [...dependencies, {
      kind: 'candidate',
      operationId: operation.operationId,
      containerId: operation.candidate.containerId,
      route,
      health
    }];
  }

  async function waitForRuntime(target, containerId) {
    let last = null;
    let gatewayContainerId = null;
    if (target.kind === 'candidate') {
      const infrastructure = await ingressAuthority.inspectOwnedInfrastructure();
      gatewayContainerId = infrastructure && infrastructure.gateway && infrastructure.gateway.Id;
      if (!CONTAINER_ID_PATTERN.test(String(gatewayContainerId || ''))) {
        throw new RuntimeIdentityError('Routing gateway identity is unavailable', 'gateway-identity-unavailable');
      }
    }
    for (let attempt = 1; attempt <= readinessAttempts; attempt += 1) {
      const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
      const running = Boolean(details.State && details.State.Running);
      if (target.kind === 'dependency') {
        const health = details.State && details.State.Health && details.State.Health.Status;
        last = { running, health: health || null, attempt };
        if (running && (!details.Config.Healthcheck || health === 'healthy')) return last;
      } else {
        const health = target.health || {};
        const routingAttachment = details.NetworkSettings && details.NetworkSettings.Networks &&
          details.NetworkSettings.Networks[routingNetwork];
        const runtimeAddress = String(routingAttachment && routingAttachment.IPAddress || '').split('/')[0];
        const url = net.isIP(runtimeAddress) === 4
          ? 'http://' + runtimeAddress + ':' + health.privatePort + (health.path || '/')
          : null;
        let result = null;
        try {
          if (!url) throw new Error('routing address unavailable');
          result = await dockerExec(gatewayContainerId, [
            'wget', '--server-response', '--output-document=/dev/null', '--timeout=2', url
          ], { timeoutMs: 5000, maxResponseBytes: 64 * 1024 });
        } catch { /* retry inside the bounded readiness loop */ }
        const match = result && String(result.output || '').match(/HTTP\/1\.[01]\s+([0-9]{3})/i);
        const statusCode = match
          ? Number.parseInt(match[1], 10)
          : result && result.exitCode === 0 ? 200 : null;
        last = {
          running,
          runtimeAddress: net.isIP(runtimeAddress) === 4 ? runtimeAddress : null,
          statusCode,
          probeExitCode: result && result.exitCode,
          attempt
        };
        if (running && Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 400) return last;
      }
      if (!running && details.State && details.State.Status === 'exited') break;
      await wait(500);
    }
    throw new RuntimeIdentityError(
      'Replacement runtime did not become healthy: ' + JSON.stringify(last),
      'replacement-health-failed'
    );
  }

  async function verifyPublicRoute(target) {
    if (!target.route) return { verified: true, samples: 0 };
    const connectHost = await ingressAuthority.hostIngressAddress();
    const requestPath = target.health && target.health.path || target.route.path || '/';
    const proofs = [];
    let consecutiveHealthy = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      let proof;
      try {
        proof = await ingressAuthority.httpsProbe({
          hostname: target.route.domain,
          connectHost,
          requestPath,
          expectedRouteId: target.route.routeId
        });
      } catch (error) {
        proof = { error: error.code || 'probe-failed' };
      }
      proofs.push(proof);
      const healthy = proof.tlsValid === true && proof.expectedRoute === true &&
        proof.statusCode >= 200 && proof.statusCode < 400 &&
        proof.candidateIdentity === target.operationId;
      consecutiveHealthy = healthy ? consecutiveHealthy + 1 : 0;
      if (consecutiveHealthy >= 5) return { verified: true, samples: proofs.length };
      if (attempt < 39) await wait(500);
    }
    throw new RuntimeIdentityError('Public route proof failed after runtime replacement', 'public-route-proof-failed');
  }

  function persistTarget(target, replacementId, imageId, imageReference) {
    const adapterState = readJson(adapterFile(target.operationId));
    const originalAdapterState = JSON.parse(JSON.stringify(adapterState));
    if (target.kind === 'candidate') {
      const operation = readJson(operationFile(target.operationId));
      if (!operation || operation.status !== COMPLETED_STATUS) {
        throw new RuntimeIdentityError('Completed migration record changed during reconciliation', 'operation-state-changed');
      }
      operation.candidate = {
        ...operation.candidate,
        containerId: replacementId,
        imageId,
        imageDigest: imageId,
        imageReference
      };
      operation.runtimeIdentityReconciledAt = now();
      adapterState.candidate = {
        ...adapterState.candidate,
        containerId: replacementId,
        imageId,
        imageReference
      };
      adapterState.updatedAt = now();
      atomicWriteJson(adapterFile(target.operationId), adapterState);
      try {
        atomicWriteJson(operationFile(target.operationId), operation);
      } catch (error) {
        atomicWriteJson(adapterFile(target.operationId), originalAdapterState);
        throw error;
      }
      return;
    } else {
      const dependency = adapterState.dependencies[target.dependencyIndex];
      if (!dependency || dependency.bridgeContainerId !== target.containerId) {
        throw new RuntimeIdentityError('Dependency bridge state changed during reconciliation', 'dependency-state-changed');
      }
      dependency.bridgeContainerId = replacementId;
      dependency.imageReference = imageReference;
      dependency.runtimeIdentityReconciledAt = now();
    }
    adapterState.updatedAt = now();
    atomicWriteJson(adapterFile(target.operationId), adapterState);
  }

  async function removeReplacement(containerId) {
    try {
      const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
      if (details.State && details.State.Running) {
        await dockerRequest('POST', '/containers/' + containerId + '/stop?t=10');
      }
      await dockerRequest('DELETE', '/containers/' + containerId + '?v=1&force=0');
    } catch (error) {
      if (!/No such container/i.test(String(error.message || ''))) throw error;
    }
  }

  async function reconcileTarget(target) {
    const current = await dockerRequest('GET', '/containers/' + target.containerId + '/json');
    const labels = current.Config && current.Config.Labels || {};
    const expectedTemporaryKind = target.kind === 'candidate'
      ? 'stateless-migration-candidate'
      : 'stateless-dependency-bridge';
    if (
      current.Id !== target.containerId || labels['com.foxos.stateless-migration.id'] !== target.operationId ||
      labels['com.foxos.temporary'] !== expectedTemporaryKind ||
      !current.State || current.State.Running !== true || !IMAGE_ID_PATTERN.test(String(current.Image || ''))
    ) {
      throw new RuntimeIdentityError('Managed runtime ownership or state proof failed', 'runtime-proof-failed');
    }
    if ((current.Mounts || []).length > 0) {
      throw new RuntimeIdentityError('Runtime with mounts cannot use stateless identity reconciliation', 'runtime-mounts-present');
    }
    const name = containerName(current);
    const imageReference = localRuntimeImageReference(name);
    if (current.Config.Image === imageReference) {
      persistTarget(target, current.Id, current.Image, imageReference);
      return { kind: target.kind, name, containerId: current.Id, imageReference, changed: false };
    }

    const networks = networkAttachments(current);
    const initialNetwork = String(current.HostConfig && current.HostConfig.NetworkMode || '');
    if (!networks.some((network) => network.name === initialNetwork)) {
      throw new RuntimeIdentityError('Runtime primary network cannot be reproduced exactly', 'primary-network-unavailable');
    }
    const proofAlias = (name.slice(0, 42).replace(/-+$/g, '') + '-proof-' + crypto.randomBytes(4).toString('hex'))
      .replace(/[^a-z0-9-]/g, '-');
    const renamedCurrent = replacementName(name);
    let replacementId = null;
    let currentRenamed = false;
    let currentStopped = false;
    let routeRuntimeRefreshed = false;
    let stateCommitted = false;
    try {
      await dockerRequest(
        'POST',
        '/images/' + encodeURIComponent(current.Image) + '/tag?repo=' +
          encodeURIComponent(imageReference.slice(0, -':current'.length)) + '&tag=current'
      );
      await dockerRequest('POST', '/containers/' + current.Id + '/rename?name=' + encodeURIComponent(renamedCurrent));
      currentRenamed = true;
      const initialAttachment = networks.find((network) => network.name === initialNetwork);
      const initialAliases = initialNetwork === routingNetwork
        ? [proofAlias]
        : initialAttachment.aliases;
      const payload = clonedContainerPayload(current, imageReference, initialNetwork, initialAliases);
      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(name),
        payload
      );
      replacementId = created.Id;
      for (const network of networks.filter((entry) => entry.name !== initialNetwork)) {
        await dockerRequest('POST', '/networks/' + encodeURIComponent(network.name) + '/connect', {
          Container: replacementId,
          EndpointConfig: {
            Aliases: network.name === routingNetwork ? [proofAlias] : network.aliases
          }
        });
      }
      await dockerRequest('POST', '/containers/' + replacementId + '/start');
      let readiness = await waitForRuntime(target, replacementId);
      const routingAttachment = networks.find((network) => network.name === routingNetwork);
      if (!routingAttachment) {
        throw new RuntimeIdentityError('Runtime routing network cannot be reproduced exactly', 'routing-network-unavailable');
      }
      await dockerRequest('POST', '/networks/' + encodeURIComponent(routingNetwork) + '/disconnect', {
        Container: replacementId,
        Force: false
      });
      await dockerRequest('POST', '/networks/' + encodeURIComponent(routingNetwork) + '/connect', {
        Container: replacementId,
        EndpointConfig: {
          Aliases: Array.from(new Set([...routingAttachment.aliases, proofAlias]))
        }
      });
      readiness = await waitForRuntime(target, replacementId);
      const replacement = await dockerRequest('GET', '/containers/' + replacementId + '/json');
      if (replacement.Image !== current.Image || !replacement.Config || replacement.Config.Image !== imageReference) {
        throw new RuntimeIdentityError('Replacement image identity proof failed', 'replacement-image-proof-failed');
      }
      if (target.kind === 'candidate' && target.route) {
        await ingressAuthority.refreshOperationRuntime(target.operationId, replacement.Id);
        routeRuntimeRefreshed = true;
      }
      await dockerRequest('POST', '/containers/' + current.Id + '/stop?t=10');
      currentStopped = true;
      const publicRoute = await verifyPublicRoute(target);
      persistTarget(target, replacement.Id, replacement.Image, imageReference);
      stateCommitted = true;
      await dockerRequest('DELETE', '/containers/' + current.Id + '?v=1&force=1');
      return {
        kind: target.kind,
        name,
        previousContainerId: current.Id,
        containerId: replacement.Id,
        imageReference,
        changed: true,
        readiness,
        publicRoute
      };
    } catch (error) {
      if (stateCommitted) throw error;
      if (currentStopped) {
        try { await dockerRequest('POST', '/containers/' + current.Id + '/start'); } catch { /* retain original failure */ }
      }
      if (routeRuntimeRefreshed) {
        try { await ingressAuthority.refreshOperationRuntime(target.operationId, current.Id); } catch { /* retain original failure */ }
      }
      if (replacementId) {
        try { await removeReplacement(replacementId); } catch { /* retain original failure */ }
      }
      if (currentRenamed) {
        try {
          await dockerRequest('POST', '/containers/' + current.Id + '/rename?name=' + encodeURIComponent(name));
        } catch { /* retain original failure */ }
      }
      throw error;
    }
  }

  async function reconcileOperation(operationId) {
    const operation = completedOperations().find((entry) => entry.operationId === operationId);
    if (!operation) {
      throw new RuntimeIdentityError('Completed stateless migration was not found', 'completed-operation-not-found');
    }
    const results = [];
    for (const target of targetsFor(operation)) results.push(await reconcileTarget(target));
    return { operationId, results };
  }

  async function reconcileAll() {
    const results = [];
    for (const operation of completedOperations()) results.push(await reconcileOperation(operation.operationId));
    return { reconciledAt: now(), operations: results };
  }

  return { completedOperations, reconcileAll, reconcileOperation, reconcileTarget, targetsFor };
}

module.exports = {
  COMPLETED_STATUS,
  RuntimeIdentityError,
  clonedContainerPayload,
  createRuntimeIdentityManager,
  networkAttachments
};
