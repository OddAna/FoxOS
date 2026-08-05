const crypto = require('node:crypto');
const { canonicalJson } = require('./applicationManifestManager');

const LAB_LABEL = 'com.foxos.stateless-migration.disposable';
const LAB_OPERATION_LABEL = 'com.foxos.stateless-migration.operation';
const LAB_ROUTE_LABEL = 'com.foxos.stateless-migration.route';
const LAB_RUN_LABEL = 'com.foxos.stateless-migration.run';
const LAB_RESOURCE_NAME = 'foxos-stateless-migration-lab';
const LAB_RESOURCE_ID = 'res_' + crypto.createHash('sha256').update(LAB_RESOURCE_NAME).digest('hex').slice(0, 32);
const LAB_IMAGE_REPOSITORY = 'traefik/whoami';
const LAB_IMAGE_DIGEST = 'sha256:200689790a0a0ea48ca45992e0450bc26ccab5307375b41c84dfc4f2475937ab';
const LAB_IMAGE_REFERENCE = LAB_IMAGE_REPOSITORY + '@' + LAB_IMAGE_DIGEST;

class StatelessMigrationLabError extends Error {
  constructor(message, statusCode = 409, code = 'stateless-migration-lab-error') {
    super(message);
    this.name = 'StatelessMigrationLabError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function validateLabSpec(spec) {
  if (
    !spec || spec.resourceId !== LAB_RESOURCE_ID || spec.resourceName !== LAB_RESOURCE_NAME ||
    !/^[a-f0-9]{12,64}$/.test(String(spec.sourceContainerId || '')) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(spec.gatewayImageId || '')) ||
    !/^[a-f0-9]{12,64}$/.test(String(spec.networkId || '')) ||
    !/^slab_[a-f0-9]{24}$/.test(String(spec.runId || '')) ||
    !/^foxos-stateless-lab-[a-f0-9]{12}$/.test(String(spec.networkName || '')) ||
    !/^foxos-stateless-lab-source-[a-f0-9]{12}$/.test(String(spec.sourceIdentity || '')) ||
    !/^foxos-stateless-lab-candidate-[a-f0-9]{12}$/.test(String(spec.candidateIdentity || '')) ||
    !/^lab-[a-f0-9]{12}\.foxos\.invalid$/.test(String(spec.domain || '')) ||
    !/^\/_foxos\/migrations\/stateless-lab\/[a-f0-9]{12}\/$/.test(String(spec.path || '')) ||
    !/^foxos-stateless-lab-[a-f0-9]{12}$/.test(String(spec.routeName || ''))
  ) {
    throw new StatelessMigrationLabError('Disposable stateless lab specification is invalid', 400, 'invalid-lab-spec');
  }
  return spec;
}

function publishedPort(details, privatePort) {
  const binding = details && details.NetworkSettings && details.NetworkSettings.Ports &&
    details.NetworkSettings.Ports[privatePort + '/tcp'] &&
    details.NetworkSettings.Ports[privatePort + '/tcp'][0];
  const port = Number.parseInt(binding && binding.HostPort || '', 10);
  if (!binding || binding.HostIp !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StatelessMigrationLabError('Disposable lab runtime is not loopback-only', 409, 'lab-public-port');
  }
  return port;
}

function labels(details) {
  return details && details.Config && details.Config.Labels || {};
}

function assertConstrained(details, expectedNetwork, expectedIdentity) {
  const host = details && details.HostConfig || {};
  const config = details && details.Config || {};
  const security = host.SecurityOpt || [];
  const capDrop = host.CapDrop || [];
  if (
    !details || !details.State || details.State.Status !== 'running' ||
    config.User !== '65532:65532' || config.Hostname !== expectedIdentity ||
    host.Privileged !== false || host.ReadonlyRootfs !== true ||
    !capDrop.includes('ALL') || !security.includes('no-new-privileges:true') ||
    host.Memory !== 128 * 1024 * 1024 || host.NanoCpus !== 500000000 ||
    host.PidsLimit !== 128 || (details.Mounts || []).length !== 0 ||
    host.NetworkMode !== expectedNetwork ||
    !Object.hasOwn(details.NetworkSettings && details.NetworkSettings.Networks || {}, expectedNetwork)
  ) {
    throw new StatelessMigrationLabError('Disposable lab runtime constraints drifted', 409, 'lab-runtime-drift');
  }
}

function sourceRuntimeProof(details) {
  return {
    containerId: details && details.Id,
    startedAt: details && details.State && details.State.StartedAt,
    restartCount: details && details.RestartCount
  };
}

function assertSourceContinuity(details, proof) {
  if (
    !proof || !details || details.Id !== proof.containerId ||
    !details.State || details.State.Status !== 'running' ||
    details.State.StartedAt !== proof.startedAt ||
    details.RestartCount !== proof.restartCount
  ) {
    throw new StatelessMigrationLabError(
      'Disposable source runtime continuity proof failed',
      409,
      'lab-source-continuity-failed'
    );
  }
  return true;
}

function createStatelessMigrationLabAdapter({
  dockerRequest,
  dockerExec,
  probeHttp,
  labSpec,
  injectUnavailableAfterSwitch = false,
  clock = () => new Date(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (typeof dockerRequest !== 'function' || typeof dockerExec !== 'function' || typeof probeHttp !== 'function') {
    throw new Error('Disposable stateless adapter requires Docker request/exec and host probe functions');
  }
  const spec = validateLabSpec(labSpec);
  const runtimes = new Map();

  function now() {
    return new Date(clock()).toISOString();
  }

  async function inspectNetwork() {
    const network = await dockerRequest('GET', '/networks/' + spec.networkId);
    const networkLabels = network && network.Labels || {};
    if (
      network.Name !== spec.networkName || network.Internal !== false ||
      networkLabels[LAB_LABEL] !== 'true' ||
      networkLabels[LAB_RUN_LABEL] !== spec.runId ||
      networkLabels['com.foxos.resource.id'] !== LAB_RESOURCE_ID ||
      networkLabels['com.foxos.managed'] !== 'true'
    ) {
      throw new StatelessMigrationLabError('Disposable lab network identity drifted', 409, 'lab-network-drift');
    }
    return network;
  }

  async function inspectSource() {
    const details = await dockerRequest('GET', '/containers/' + spec.sourceContainerId + '/json');
    const sourceLabels = labels(details);
    if (
      details.Id !== spec.sourceContainerId ||
      sourceLabels[LAB_LABEL] !== 'true' ||
      sourceLabels[LAB_RUN_LABEL] !== spec.runId ||
      sourceLabels['com.foxos.resource.id'] !== LAB_RESOURCE_ID ||
      sourceLabels['com.foxos.source'] !== 'true' ||
      sourceLabels['com.foxos.managed'] === 'true' ||
      String(details.Image || '').toLowerCase() !== String(spec.sourceImageId || '').toLowerCase()
    ) {
      throw new StatelessMigrationLabError('Disposable source identity drifted', 409, 'lab-source-drift');
    }
    assertConstrained(details, spec.networkName, spec.sourceIdentity);
    return details;
  }

  async function assertCandidate(details, operationId) {
    const candidateLabels = labels(details);
    if (
      candidateLabels[LAB_LABEL] !== 'true' ||
      candidateLabels[LAB_RUN_LABEL] !== spec.runId ||
      candidateLabels['com.foxos.managed'] !== 'true' ||
      candidateLabels['com.foxos.resource.id'] !== LAB_RESOURCE_ID ||
      candidateLabels[LAB_OPERATION_LABEL] !== operationId ||
      candidateLabels['com.foxos.candidate'] !== 'true' ||
      String(details.Image || '').toLowerCase() !== String(spec.sourceImageId || '').toLowerCase()
    ) {
      throw new StatelessMigrationLabError('Disposable candidate identity drifted', 409, 'lab-candidate-drift');
    }
    assertConstrained(details, spec.networkName, spec.candidateIdentity);
    return details;
  }

  async function proveIdentity(details, identity, attempts = 30) {
    const port = publishedPort(details, 80);
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await probeHttp({ port, healthPath: '/', timeoutMs: 3000 });
        if (response.statusCode === 200 && response.body.includes('Hostname: ' + identity)) {
          return { healthy: true, status: 'healthy', identity, hostPort: port, checkedAt: now() };
        }
        lastError = new Error('identity did not match');
      } catch (error) {
        lastError = error;
      }
      await wait(100);
    }
    throw new StatelessMigrationLabError(
      lastError && lastError.message || 'Disposable runtime health failed',
      502,
      'lab-health-failed'
    );
  }

  async function gatewayControl(runtime, action) {
    if (!runtime || !runtime.gatewayContainerId) {
      throw new StatelessMigrationLabError('Disposable route gateway is missing', 409, 'lab-route-missing');
    }
    const result = await dockerExec(runtime.gatewayContainerId, [
      'node', '/app/statelessMigrationLabGateway.js', 'control', action
    ], { timeoutMs: 10000, maxResponseBytes: 128 * 1024 });
    if (result.exitCode !== 0) {
      throw new StatelessMigrationLabError('Disposable route gateway control failed', 502, 'lab-route-control-failed');
    }
    const lines = String(result.output || '').trim().split(/\r?\n/).filter(Boolean);
    try {
      return JSON.parse(lines[lines.length - 1]);
    } catch {
      throw new StatelessMigrationLabError('Disposable route gateway returned invalid proof', 502, 'lab-route-proof-invalid');
    }
  }

  async function waitForGateway(runtime, predicate, code) {
    let status = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        status = await gatewayControl(runtime, 'status');
        if (predicate(status)) return status;
      } catch {
        // Gateway startup and route convergence are bounded below.
      }
      await wait(50);
    }
    throw new StatelessMigrationLabError('Disposable route proof timed out', 502, code);
  }

  async function removeOwnedContainer(containerId, operationId, role) {
    if (!containerId) return;
    let details;
    try {
      details = await dockerRequest('GET', '/containers/' + containerId + '/json');
    } catch (error) {
      if (/No such container/i.test(String(error && error.message))) return;
      throw error;
    }
    const ownedLabels = labels(details);
    if (
      ownedLabels[LAB_LABEL] !== 'true' ||
      ownedLabels[LAB_RUN_LABEL] !== spec.runId ||
      ownedLabels['com.foxos.managed'] !== 'true' ||
      ownedLabels['com.foxos.resource.id'] !== LAB_RESOURCE_ID ||
      ownedLabels[LAB_OPERATION_LABEL] !== operationId ||
      ownedLabels['com.foxos.' + role] !== 'true'
    ) {
      throw new StatelessMigrationLabError('Disposable cleanup ownership proof failed', 409, 'lab-cleanup-ownership-failed');
    }
    await dockerRequest('DELETE', '/containers/' + containerId + '?force=1&v=0');
  }

  const adapter = {
    capabilities: {
      candidateRuntime: true,
      healthProof: true,
      stagedRouteTls: true,
      atomicTrafficSwitch: true,
      trafficProbe: true,
      rollback: true,
      sourcePreserved: true,
      sourceStop: false,
      sourceRecreation: false,
      providerDetach: false
    },

    async preflight({ plan, operationId }) {
      if (
        plan.resource.resourceId !== LAB_RESOURCE_ID ||
        plan.resource.name !== LAB_RESOURCE_NAME ||
        canonicalJson(plan.resource.evidence) !== canonicalJson(spec.planEvidence)
      ) {
        throw new StatelessMigrationLabError('Disposable plan evidence drifted', 409, 'lab-plan-drift');
      }
      await inspectNetwork();
      const source = await inspectSource();
      await proveIdentity(source, spec.sourceIdentity);
      runtimes.set(operationId, {
        sourceProof: sourceRuntimeProof(source),
        operationId
      });
      const existingRoutes = await dockerRequest(
        'GET',
        '/containers/json?all=1&filters=' + encodeURIComponent(JSON.stringify({ label: [LAB_ROUTE_LABEL + '=' + spec.routeName] }))
      );
      return {
        evidenceFingerprint: plan.resource.evidenceFingerprint,
        sourceHealthy: true,
        sourceContinuouslyRunning: true,
        routeCollisionFree: (existingRoutes || []).length === 0,
        operationId
      };
    },

    async createCandidate({ plan, operationId }) {
      const runtime = runtimes.get(operationId);
      if (!runtime) throw new StatelessMigrationLabError('Disposable preflight proof is missing');
      await inspectNetwork();
      assertSourceContinuity(await inspectSource(), runtime.sourceProof);
      const name = spec.candidateIdentity;
      const portKey = '80/tcp';
      const created = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(name), {
        Image: spec.sourceImageId,
        Hostname: spec.candidateIdentity,
        User: '65532:65532',
        Labels: {
          'com.foxos.managed': 'true',
          'com.foxos.resource.id': LAB_RESOURCE_ID,
          [LAB_LABEL]: 'true',
          [LAB_RUN_LABEL]: spec.runId,
          [LAB_OPERATION_LABEL]: operationId,
          'com.foxos.candidate': 'true'
        },
        ExposedPorts: { [portKey]: {} },
        HostConfig: {
          NetworkMode: spec.networkName,
          PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '0' }] },
          RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Memory: 128 * 1024 * 1024,
          NanoCpus: 500000000,
          PidsLimit: 128,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' }
        },
        NetworkingConfig: {
          EndpointsConfig: { [spec.networkName]: { Aliases: [spec.candidateIdentity] } }
        }
      });
      try {
        await dockerRequest('POST', '/containers/' + created.Id + '/start');
        const details = await dockerRequest('GET', '/containers/' + created.Id + '/json');
        await assertCandidate(details, operationId);
        Object.assign(runtime, { candidateContainerId: created.Id, gatewayContainerId: null, plan });
        return {
          candidateId: 'candidate_' + hash(operationId),
          containerId: created.Id,
          networkId: spec.networkId,
          networkName: spec.networkName,
          revisionId: 'revision_' + hash(plan.resource.evidenceFingerprint),
          imageId: spec.sourceImageId,
          imageDigest: LAB_IMAGE_DIGEST,
          privatePort: 80,
          owned: true,
          separateFromSource: created.Id !== spec.sourceContainerId,
          sourceTouched: false
        };
      } catch (error) {
        try { await dockerRequest('DELETE', '/containers/' + created.Id + '?force=1&v=0'); } catch { /* exact lab cleanup */ }
        throw error;
      }
    },

    async verifyCandidateHealth({ operationId }) {
      const runtime = runtimes.get(operationId);
      if (!runtime) throw new StatelessMigrationLabError('Disposable candidate runtime is missing');
      assertSourceContinuity(await inspectSource(), runtime.sourceProof);
      const details = await dockerRequest('GET', '/containers/' + runtime.candidateContainerId + '/json');
      await assertCandidate(details, operationId);
      return proveIdentity(details, spec.candidateIdentity);
    },

    async stageRoute({ plan, operationId }) {
      const runtime = runtimes.get(operationId);
      if (!runtime) throw new StatelessMigrationLabError('Disposable candidate runtime is missing');
      const source = await inspectSource();
      assertSourceContinuity(source, runtime.sourceProof);
      const candidate = await dockerRequest('GET', '/containers/' + runtime.candidateContainerId + '/json');
      await assertCandidate(candidate, operationId);
      const gatewayName = 'foxos-stateless-lab-gateway-' + hash(operationId, 12);
      const portKey = '8443/tcp';
      const created = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(gatewayName), {
        Image: spec.gatewayImageId,
        Hostname: gatewayName,
        User: '65532:65532',
        Cmd: ['node', '/app/statelessMigrationLabGateway.js', 'serve'],
        Env: [
          'FOXOS_STATELESS_LAB_DOMAIN=' + spec.domain,
          'FOXOS_STATELESS_LAB_PATH=' + spec.path,
          'FOXOS_STATELESS_LAB_ROUTE=' + spec.routeName,
          'FOXOS_STATELESS_LAB_SOURCE_HOST=' + spec.sourceIdentity,
          'FOXOS_STATELESS_LAB_CANDIDATE_HOST=' + spec.candidateIdentity,
          'FOXOS_STATELESS_LAB_SOURCE_IDENTITY=' + spec.sourceIdentity,
          'FOXOS_STATELESS_LAB_CANDIDATE_IDENTITY=' + spec.candidateIdentity
        ],
        Tty: true,
        Labels: {
          'com.foxos.managed': 'true',
          'com.foxos.resource.id': LAB_RESOURCE_ID,
          [LAB_LABEL]: 'true',
          [LAB_RUN_LABEL]: spec.runId,
          [LAB_OPERATION_LABEL]: operationId,
          [LAB_ROUTE_LABEL]: spec.routeName,
          'com.foxos.route-gateway': 'true'
        },
        ExposedPorts: { [portKey]: {} },
        HostConfig: {
          NetworkMode: spec.networkName,
          PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '0' }] },
          RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Memory: 128 * 1024 * 1024,
          NanoCpus: 500000000,
          PidsLimit: 128,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' }
        },
        NetworkingConfig: {
          EndpointsConfig: { [spec.networkName]: { Aliases: [gatewayName] } }
        }
      });
      runtime.gatewayContainerId = created.Id;
      try {
        await dockerRequest('POST', '/containers/' + created.Id + '/start');
        const status = await waitForGateway(runtime, (value) => (
          value && value.target === 'source' && value.tls && value.tls.hostnameVerified === true &&
          value.stats && value.stats.sourceSamples >= 3 && value.stats.unavailableSamples === 0
        ), 'lab-route-stage-failed');
        const sourceAfter = await inspectSource();
        assertSourceContinuity(sourceAfter, runtime.sourceProof);
        runtime.stagedStats = status.stats;
        runtime.gatewayPort = publishedPort(
          await dockerRequest('GET', '/containers/' + created.Id + '/json'),
          8443
        );
        return {
          routeId: 'route_' + hash(plan.resource.evidenceFingerprint),
          routeRevision: 'route-revision_' + hash(canonicalJson({ domain: spec.domain, path: spec.path })),
          domain: spec.domain,
          path: spec.path,
          alias: gatewayName,
          staged: true,
          active: false,
          collisionFree: true,
          tlsReady: true,
          sourceStillServing: true
        };
      } catch (error) {
        try { await removeOwnedContainer(created.Id, operationId, 'route-gateway'); } catch { /* preserve stage error */ }
        runtime.gatewayContainerId = null;
        throw error;
      }
    },

    async switchTraffic({ operationId }) {
      const runtime = runtimes.get(operationId);
      const before = await gatewayControl(runtime, 'status');
      const result = await gatewayControl(runtime, injectUnavailableAfterSwitch ? 'candidate-with-fault' : 'candidate');
      const source = await inspectSource();
      assertSourceContinuity(source, runtime.sourceProof);
      runtime.switchBaseline = before.stats;
      return {
        switched: result.switched === true && result.target === 'candidate',
        sourceStopped: source.State.Status !== 'running',
        sourceRecreated: source.Id !== spec.sourceContainerId,
        switchedAt: now()
      };
    },

    async verifyTraffic({ operationId }) {
      const runtime = runtimes.get(operationId);
      const baseline = runtime.switchBaseline || { candidateSamples: 0 };
      const status = await waitForGateway(runtime, (value) => (
        value && value.target === 'candidate' && value.stats &&
        value.stats.candidateSamples >= (baseline.candidateSamples || 0) + 5
      ), 'lab-candidate-traffic-timeout');
      const source = await inspectSource();
      assertSourceContinuity(source, runtime.sourceProof);
      return {
        healthy: true,
        tlsValid: status.tls && status.tls.hostnameVerified === true && status.stats.tlsFailures === 0,
        candidateServing: status.stats.lastTarget === 'candidate' && status.stats.lastIdentity === spec.candidateIdentity,
        sourceContinuouslyRunning: source.Id === spec.sourceContainerId && source.State.Status === 'running',
        unavailableSamples: status.stats.unavailableSamples,
        probes: status.stats.samples,
        checkedAt: now(),
        candidateIdentity: spec.candidateIdentity
      };
    },

    async rollbackTraffic({ operationId }) {
      const runtime = runtimes.get(operationId);
      const before = await gatewayControl(runtime, 'status');
      const result = await gatewayControl(runtime, 'source');
      runtime.rollbackBaseline = before.stats;
      return { switched: result.switched === true, target: result.target, rolledBackAt: now() };
    },

    async verifyRollback({ operationId }) {
      const runtime = runtimes.get(operationId);
      const baseline = runtime.rollbackBaseline || { sourceSamples: 0 };
      const status = await waitForGateway(runtime, (value) => (
        value && value.target === 'source' && value.stats &&
        value.stats.sourceSamples >= (baseline.sourceSamples || 0) + 3
      ), 'lab-source-rollback-timeout');
      const source = await inspectSource();
      assertSourceContinuity(source, runtime.sourceProof);
      return {
        sourceServing: status.stats.lastTarget === 'source' && status.stats.lastIdentity === spec.sourceIdentity,
        trafficRestored: source.Id === spec.sourceContainerId && source.State.Status === 'running',
        candidateServing: false,
        unavailableSamples: status.stats.unavailableSamples,
        probes: status.stats.samples,
        checkedAt: now()
      };
    },

    async cleanupStagedRoute({ operationId }) {
      const runtime = runtimes.get(operationId);
      if (!runtime) return;
      await removeOwnedContainer(runtime.gatewayContainerId, operationId, 'route-gateway');
      runtime.gatewayContainerId = null;
    },

    async cleanupCandidate({ operationId }) {
      const runtime = runtimes.get(operationId);
      if (!runtime) return;
      await removeOwnedContainer(runtime.candidateContainerId, operationId, 'candidate');
      runtime.candidateContainerId = null;
    }
  };

  return adapter;
}

module.exports = {
  LAB_IMAGE_DIGEST,
  LAB_IMAGE_REFERENCE,
  LAB_LABEL,
  LAB_OPERATION_LABEL,
  LAB_RESOURCE_ID,
  LAB_RESOURCE_NAME,
  LAB_ROUTE_LABEL,
  LAB_RUN_LABEL,
  StatelessMigrationLabError,
  createStatelessMigrationLabAdapter
};
