const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDockerClient } = require('./dockerClient');
const { defaultHostProbe } = require('./sourceDeploymentManager');
const {
  PREPARE_STATELESS_MIGRATION_CONFIRMATION,
  createStatelessMigrationManager
} = require('./statelessMigrationManager');
const {
  LAB_IMAGE_DIGEST,
  LAB_IMAGE_REFERENCE,
  LAB_LABEL,
  LAB_RESOURCE_ID,
  LAB_RESOURCE_NAME,
  LAB_RUN_LABEL,
  createStatelessMigrationLabAdapter
} = require('./statelessMigrationLabAdapter');

const RUN_CONFIRMATION = 'RUN DISPOSABLE STATELESS LAB';

function hash(value, length = 12) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createLabApprovalVerifier() {
  const consumed = new Set();
  return async ({ kind, planId, resourceId, evidenceFingerprint, approval }) => {
    const expected = kind === 'stateless-migration-apply'
      ? 'APPLY DISPOSABLE STATELESS LAB ' + planId
      : 'ROLLBACK DISPOSABLE STATELESS LAB ' + planId;
    const key = kind + ':' + String(approval && approval.nonce || '');
    const valid = approval && approval.confirmation === expected &&
      /^lab-approval-[a-f0-9]{24}$/.test(String(approval.nonce || '')) && !consumed.has(key);
    if (valid) consumed.add(key);
    const approvedAt = new Date();
    return {
      approved: Boolean(valid),
      source: 'foxos-ui',
      kind,
      planId,
      resourceId,
      evidenceFingerprint,
      oneTime: true,
      consumed: Boolean(valid),
      grantId: approval && approval.nonce,
      approvedAt: approvedAt.toISOString(),
      expiresAt: new Date(approvedAt.getTime() + 2 * 60 * 1000).toISOString(),
      provider: 'disposable-lab-ui-emulator'
    };
  };
}

function approval(kind, planId) {
  return {
    confirmation: (kind === 'apply' ? 'APPLY' : 'ROLLBACK') + ' DISPOSABLE STATELESS LAB ' + planId,
    nonce: 'lab-approval-' + crypto.randomBytes(12).toString('hex')
  };
}

async function pullLabImage(dockerRequest) {
  await dockerRequest('POST', '/images/create?fromImage=' + encodeURIComponent(LAB_IMAGE_REFERENCE));
  const image = await dockerRequest('GET', '/images/' + encodeURIComponent(LAB_IMAGE_REFERENCE) + '/json');
  assert(/^sha256:[a-f0-9]{64}$/.test(String(image && image.Id || '')), 'Disposable lab image ID is missing');
  assert((image.RepoDigests || []).includes(LAB_IMAGE_REFERENCE), 'Disposable lab image digest drifted');
  return image.Id;
}

async function cleanupRun(dockerRequest, runId) {
  const filter = encodeURIComponent(JSON.stringify({ label: [LAB_RUN_LABEL + '=' + runId] }));
  const containers = await dockerRequest('GET', '/containers/json?all=1&filters=' + filter);
  for (const container of containers || []) {
    const details = await dockerRequest('GET', '/containers/' + container.Id + '/json');
    const itemLabels = details.Config && details.Config.Labels || {};
    assert(itemLabels[LAB_LABEL] === 'true', 'Refusing to clean a non-lab container');
    assert(itemLabels[LAB_RUN_LABEL] === runId, 'Refusing to clean a foreign lab container');
    assert(itemLabels['com.foxos.resource.id'] === LAB_RESOURCE_ID, 'Refusing to clean another resource');
    await dockerRequest('DELETE', '/containers/' + container.Id + '?force=1&v=0');
  }
  const networks = await dockerRequest('GET', '/networks?filters=' + filter);
  for (const network of networks || []) {
    const itemLabels = network.Labels || {};
    assert(itemLabels[LAB_LABEL] === 'true', 'Refusing to clean a non-lab network');
    assert(itemLabels[LAB_RUN_LABEL] === runId, 'Refusing to clean a foreign lab network');
    assert(itemLabels['com.foxos.resource.id'] === LAB_RESOURCE_ID, 'Refusing to clean another network');
    await dockerRequest('DELETE', '/networks/' + network.Id);
  }
}

async function createSource(dockerRequest, runId, suffix, sourceImageId) {
  const networkName = 'foxos-stateless-lab-' + suffix;
  const sourceIdentity = 'foxos-stateless-lab-source-' + suffix;
  const candidateIdentity = 'foxos-stateless-lab-candidate-' + suffix;
  const routeName = 'foxos-stateless-lab-' + suffix;
  const domain = 'lab-' + suffix + '.foxos.invalid';
  const routePath = '/_foxos/migrations/stateless-lab/' + suffix + '/';
  const commonLabels = {
    'com.foxos.resource.id': LAB_RESOURCE_ID,
    [LAB_LABEL]: 'true',
    [LAB_RUN_LABEL]: runId
  };
  const network = await dockerRequest('POST', '/networks/create', {
    Name: networkName,
    CheckDuplicate: true,
    Internal: false,
    Attachable: false,
    Labels: { ...commonLabels, 'com.foxos.managed': 'true' }
  });
  let source = null;
  try {
    const created = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(sourceIdentity), {
      Image: sourceImageId,
      Hostname: sourceIdentity,
      User: '65532:65532',
      Labels: {
        ...commonLabels,
        'com.foxos.source': 'true',
        'com.foxos.observed-provider': 'disposable-lab'
      },
      ExposedPorts: { '80/tcp': {} },
      HostConfig: {
        NetworkMode: networkName,
        PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
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
        EndpointsConfig: { [networkName]: { Aliases: [sourceIdentity] } }
      }
    });
    source = created.Id;
    await dockerRequest('POST', '/containers/' + source + '/start');
    const details = await dockerRequest('GET', '/containers/' + source + '/json');
    const gateway = await dockerRequest('GET', '/containers/' + os.hostname() + '/json');
    const planEvidence = {
      source: {
        type: 'immutable-oci',
        containerId: source,
        imageId: sourceImageId,
        imageDigest: LAB_IMAGE_DIGEST,
        provider: 'disposable-lab'
      },
      runtime: {
        privatePort: 80,
        writableMounts: 0,
        hostAccess: false,
        privileged: false,
        constrained: true
      },
      health: { path: '/', expectedIdentity: sourceIdentity },
      route: {
        owner: 'foxos',
        domain,
        path: routePath,
        tlsMode: 'operation-pinned-self-signed',
        unavailableSamplesAllowed: 0
      }
    };
    return {
      resourceId: LAB_RESOURCE_ID,
      resourceName: LAB_RESOURCE_NAME,
      runId,
      sourceContainerId: source,
      sourceImageId,
      gatewayImageId: gateway.Image,
      networkId: network.Id,
      networkName,
      sourceIdentity,
      candidateIdentity,
      routeName,
      domain,
      path: routePath,
      planEvidence,
      sourceDetails: details
    };
  } catch (error) {
    if (source) {
      try { await dockerRequest('DELETE', '/containers/' + source + '?force=1&v=0'); } catch { /* exact lab cleanup */ }
    }
    try { await dockerRequest('DELETE', '/networks/' + network.Id); } catch { /* exact lab cleanup */ }
    throw error;
  }
}

function serverPlan(spec) {
  const sourceSnapshotId = 'snapshot_' + hash(spec.sourceContainerId, 24);
  const planId = 'mplan_' + hash(JSON.stringify(spec.planEvidence), 32);
  return {
    schemaVersion: 1,
    mode: 'read-only-server-migration-plan',
    planId,
    sourceSnapshotId,
    resources: [{
      resourceId: LAB_RESOURCE_ID,
      name: LAB_RESOURCE_NAME,
      observedProvider: 'disposable-lab',
      observedOwnership: 'provider-owned',
      protected: false,
      migrationRequired: true,
      strategy: 'blue-green-atomic-route',
      classification: {
        workloadRole: 'application',
        stateClass: 'stateless',
        authorityClass: 'provider-owned',
        revision: 'classification_' + hash(spec.sourceContainerId, 24)
      },
      evidence: spec.planEvidence,
      dependencies: [],
      conflicts: [],
      blockers: {
        authority: [],
        evidence: [],
        implementation: [
          { code: 'migration-apply-transaction-not-implemented', section: 'migration' },
          { code: 'zero-downtime-blue-green-apply-not-implemented', section: 'availability' },
          { code: 'general-domain-route-cutover-not-implemented', section: 'route' }
        ]
      },
      readiness: { evidenceComplete: true, applyImplemented: false }
    }]
  };
}

async function runProof(docker, mode) {
  const suffix = crypto.randomBytes(6).toString('hex');
  const runId = 'slab_' + crypto.randomBytes(12).toString('hex');
  const tempRoot = path.join(os.tmpdir(), 'foxos-stateless-migration-' + suffix);
  try {
    const sourceImageId = await pullLabImage(docker.request);
    const spec = await createSource(docker.request, runId, suffix, sourceImageId);
    const wholeServerPlan = serverPlan(spec);
    const adapter = createStatelessMigrationLabAdapter({
      dockerRequest: docker.request,
      dockerExec: docker.exec,
      probeHttp: defaultHostProbe,
      labSpec: spec,
      injectUnavailableAfterSwitch: mode === 'fault'
    });
    const manager = createStatelessMigrationManager({
      dataRoot: tempRoot,
      getServerMigrationPlan: (planId) => planId === wholeServerPlan.planId ? wholeServerPlan : null,
      executionAdapter: adapter,
      approvalVerifier: createLabApprovalVerifier()
    });
    const plan = manager.createPlan({
      serverPlanId: wholeServerPlan.planId,
      resourceId: LAB_RESOURCE_ID,
      confirmation: PREPARE_STATELESS_MIGRATION_CONFIRMATION
    });
    assert(plan.readiness.status === 'backend-ready-ui-approval-required', 'Disposable lab plan is unexpectedly blocked');
    if (mode === 'success') {
      const operation = await manager.execute(plan.planId, approval('apply', plan.planId));
      assert(operation.status === 'traffic-on-foxos-source-preserved', 'Disposable migration did not complete');
      assert(operation.availability.zeroDowntimeProven === true, 'Zero-downtime proof is missing');
      assert(operation.trafficProof.unavailableSamples === 0, 'Disposable migration observed downtime');
      const rolledBack = await manager.rollback(operation.operationId, approval('rollback', plan.planId));
      assert(rolledBack.status === 'rolled-back', 'Disposable rollback did not complete');
      assert(rolledBack.rollback.proof.unavailableSamples === 0, 'Disposable rollback observed downtime');
      return {
        mode,
        planId: plan.planId,
        operationId: operation.operationId,
        status: rolledBack.status,
        zeroDowntimeProven: true,
        unavailableSamples: 0,
        automaticRollback: false,
        sourcePreserved: true
      };
    }
    let failure = null;
    try {
      await manager.execute(plan.planId, approval('apply', plan.planId));
    } catch (error) {
      failure = error;
    }
    assert(failure && failure.code === 'downtime-observed', 'Injected unavailable sample was not detected');
    const operation = manager.status().operations[0];
    assert(operation.status === 'rolled-back-after-failure', 'Automatic rollback did not complete');
    assert(operation.rollback.verified === true, 'Automatic rollback proof is missing');
    assert(operation.cleanup.candidateCleaned === true, 'Candidate cleanup is missing');
    assert(operation.cleanup.stagedRouteCleaned === true, 'Route cleanup is missing');
    return {
      mode,
      planId: plan.planId,
      operationId: operation.operationId,
      status: operation.status,
      zeroDowntimeProven: false,
      unavailableSamples: operation.rollback.proof.unavailableSamples,
      automaticRollback: true,
      sourcePreserved: true,
      detectedFailure: failure.code
    };
  } finally {
    try { await cleanupRun(docker.request, runId); } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'proof' || args[1] !== '--confirm' || args[2] !== RUN_CONFIRMATION || args.length !== 3) {
    throw new Error('Usage: statelessMigrationLabCli.js proof --confirm "' + RUN_CONFIRMATION + '"');
  }
  const docker = createDockerClient(process.env.DOCKER_SOCKET || '/var/run/docker.sock');
  const filter = encodeURIComponent(JSON.stringify({ label: [LAB_LABEL + '=true'] }));
  const before = await docker.request('GET', '/containers/json?all=1&filters=' + filter);
  assert((before || []).length === 0, 'A disposable stateless migration lab object already exists');
  const success = await runProof(docker, 'success');
  const fault = await runProof(docker, 'fault');
  const after = await docker.request('GET', '/containers/json?all=1&filters=' + filter);
  const networks = await docker.request('GET', '/networks?filters=' + filter);
  assert((after || []).length === 0 && (networks || []).length === 0, 'Disposable stateless lab cleanup is incomplete');
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    mode: 'real-docker-stateless-migration-disposable-proof',
    sourceStopped: false,
    providerDetached: false,
    productionGateChanged: false,
    success,
    fault,
    cleanup: { containers: 0, networks: 0, volumes: 0 }
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exit(1);
});
