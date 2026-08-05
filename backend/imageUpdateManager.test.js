const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CANARY_DIGESTS,
  IMAGE_UPDATE_DISPOSABLE_LABEL,
  IMAGE_UPDATE_NAME,
  PLAN_IMAGE_UPDATE_CONFIRMATION,
  createImageUpdateManager,
  imageUpdateRollbackConfirmation,
  parseCanaryImageReference
} = require('./imageUpdateManager');
const imageUpdateCanary = require('../pilot/image-update-canary.json');

function dockerHarness() {
  const containers = new Map();
  const networks = new Map();
  const pulledImages = new Map();
  const distributionDigests = new Map(Object.entries(CANARY_DIGESTS));
  let nextContainer = 1;
  let nextNetwork = 1;
  let nextPort = 43000;
  let failedRenameTarget = null;

  function imageForReference(reference) {
    const digest = reference.split('@')[1];
    return {
      Id: digest,
      RepoDigests: ['traefik/whoami@' + digest]
    };
  }

  async function dockerRequest(method, requestPath, payload) {
    if (method === 'GET' && requestPath === '/containers/json?all=1') {
      return Array.from(containers.values()).map((container) => ({
        Id: container.Id,
        Names: [container.Name],
        Image: container.Config.Image,
        ImageID: container.Image,
        Labels: container.Config.Labels,
        State: container.State.Status,
        Status: container.State.Status
      }));
    }
    if (method === 'GET' && requestPath.startsWith('/distribution/')) {
      const reference = decodeURIComponent(requestPath.slice('/distribution/'.length, -'/json'.length));
      const tag = reference.slice(reference.lastIndexOf(':') + 1);
      const digest = distributionDigests.get(tag);
      return {
        Descriptor: {
          digest,
          mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
          size: 1076
        },
        Platforms: [
          { os: 'linux', architecture: 'amd64' },
          { os: 'linux', architecture: 'arm64' }
        ]
      };
    }
    if (method === 'POST' && requestPath.startsWith('/images/create?')) {
      const reference = new URL('http://docker' + requestPath).searchParams.get('fromImage');
      pulledImages.set(reference, imageForReference(reference));
      return { status: 'pulled' };
    }
    if (method === 'POST' && requestPath === '/networks/create') {
      const id = String(nextNetwork++).padStart(64, 'n');
      networks.set(id, {
        Id: id,
        Name: payload.Name,
        Labels: payload.Labels,
        Internal: payload.Internal,
        Containers: {}
      });
      return { Id: id };
    }
    if (method === 'GET' && requestPath.startsWith('/networks/')) {
      const network = networks.get(requestPath.slice('/networks/'.length));
      if (!network) throw new Error('network not found');
      return network;
    }
    if (method === 'DELETE' && requestPath.startsWith('/networks/')) {
      networks.delete(requestPath.slice('/networks/'.length));
      return null;
    }
    if (method === 'GET' && requestPath.startsWith('/images/')) {
      const reference = decodeURIComponent(requestPath.slice('/images/'.length, -'/json'.length));
      const image = pulledImages.get(reference);
      if (!image) throw new Error('image not pulled');
      return image;
    }
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      const id = String(nextContainer++).padStart(64, 'c');
      const name = decodeURIComponent(requestPath.split('name=')[1]);
      const privatePort = Object.keys(payload.ExposedPorts)[0];
      const image = pulledImages.get(payload.Image);
      if (!image) throw new Error('immutable image was not pulled');
      containers.set(id, {
        Id: id,
        Name: '/' + name,
        Image: image.Id,
        Config: {
          Image: payload.Image,
          User: payload.User,
          Labels: payload.Labels
        },
        HostConfig: payload.HostConfig,
        Mounts: [],
        NetworkSettings: {
          Networks: Object.fromEntries(Object.keys(payload.NetworkingConfig.EndpointsConfig).map((networkName) => [
            networkName,
            { NetworkID: Array.from(networks.values()).find((network) => network.Name === networkName).Id }
          ])),
          Ports: {
            [privatePort]: [{ HostIp: '127.0.0.1', HostPort: String(nextPort++) }]
          }
        },
        State: { Status: 'created' }
      });
      return { Id: id };
    }
    const match = requestPath.match(/^\/containers\/([a-z0-9]+)(?:\/(.*))?/);
    if (match) {
      const container = containers.get(match[1]);
      if (!container) throw new Error('container not found');
      if (method === 'GET' && (!match[2] || match[2] === 'json')) return container;
      if (method === 'DELETE') {
        for (const network of networks.values()) delete network.Containers[container.Id];
        containers.delete(container.Id);
        return null;
      }
      if (method === 'POST') {
        const action = match[2];
        if (action.startsWith('start')) {
          container.State.Status = 'running';
          for (const endpoint of Object.values(container.NetworkSettings.Networks)) {
            networks.get(endpoint.NetworkID).Containers[container.Id] = { Name: container.Name.slice(1) };
          }
        }
        if (action.startsWith('stop')) {
          container.State.Status = 'exited';
          for (const network of networks.values()) delete network.Containers[container.Id];
        }
        if (action.startsWith('rename?name=')) {
          const target = decodeURIComponent(action.split('name=')[1]);
          if (target === failedRenameTarget) {
            failedRenameTarget = null;
            throw new Error('injected rename failure');
          }
          container.Name = '/' + target;
        }
        return null;
      }
    }
    throw new Error('Unexpected Docker request ' + method + ' ' + requestPath);
  }

  async function probeHttp({ port }) {
    const container = Array.from(containers.values()).find((candidate) => (
      Object.values(candidate.NetworkSettings.Ports).some((bindings) => (
        bindings && Number(bindings[0].HostPort) === port
      ))
    ));
    if (!container || container.State.Status !== 'running') throw new Error('not running');
    return { statusCode: 200, body: 'Hostname: disposable-image-canary\n' };
  }

  return {
    containers,
    networks,
    dockerRequest,
    probeHttp,
    setDistributionDigest(tag, digest) { distributionDigests.set(tag, digest); },
    failNextRenameTo(target) { failedRenameTarget = target; }
  };
}

function planInput(tag, expectedBody = 'Hostname:') {
  return {
    image: 'traefik/whoami:' + tag,
    healthPath: '/',
    expectedBody,
    confirmation: PLAN_IMAGE_UPDATE_CONFIRMATION
  };
}

function createManager(dataRoot, docker, initialCounter = 0) {
  let counter = initialCounter;
  return createImageUpdateManager({
    dataRoot,
    dockerRequest: docker.dockerRequest,
    probeHttp: docker.probeHttp,
    randomUUID: () => (++counter).toString(16).padStart(32, '0'),
    wait: async () => {}
  });
}

test('image-update references are restricted to the reviewed canary repository and tags', () => {
  assert.equal(imageUpdateCanary.repository, 'traefik/whoami');
  assert.deepEqual(imageUpdateCanary.reviewedTags, CANARY_DIGESTS);
  assert.deepEqual(parseCanaryImageReference('docker.io/traefik/whoami:v1.10.3'), {
    repository: 'traefik/whoami',
    tag: 'v1.10.3',
    tagReference: 'traefik/whoami:v1.10.3',
    reviewedDigest: CANARY_DIGESTS['v1.10.3']
  });
  assert.throws(() => parseCanaryImageReference('traefik/whoami:latest'), /reviewed canary set/);
  assert.throws(() => parseCanaryImageReference('example.com/private/app:v1'), /accepts only/);
  assert.throws(() => parseCanaryImageReference('traefik/whoami@sha256:' + 'a'.repeat(64)), /reviewed tag/);
});

test('reviewed image updates resolve digests, health-gate cutover and roll back exactly', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-image-update-'));
  const docker = dockerHarness();
  const manager = createManager(dataRoot, docker);

  const plan1 = await manager.createPlan(planInput('v1.10.3'));
  assert.equal(plan1.image.digest, CANARY_DIGESTS['v1.10.3']);
  const operation1 = await manager.applyPlan(plan1.planId, plan1.confirmation);
  assert.equal(operation1.status, 'applied');
  assert.equal(operation1.rollback.available, false);

  const plan2 = await manager.createPlan(planInput('v1.11.0'));
  assert.equal(plan2.from.revisionId, plan1.revisionId);
  const operation2 = await manager.applyPlan(plan2.planId, plan2.confirmation);
  assert.equal(operation2.status, 'applied');
  assert.equal(operation2.rollback.available, true);
  assert.equal(operation2.previous.image.digest, CANARY_DIGESTS['v1.10.3']);

  const rolledBack = await manager.rollbackOperation(
    operation2.operationId,
    imageUpdateRollbackConfirmation(operation2.operationId)
  );
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(manager.status().current.revisionId, plan1.revisionId);
  assert.equal(manager.status().current.image.digest, CANARY_DIGESTS['v1.10.3']);
  const active = Array.from(docker.containers.values()).filter((container) => (
    container.Name === '/' + IMAGE_UPDATE_NAME && container.State.Status === 'running'
  ));
  assert.equal(active.length, 1);
  assert.equal(active[0].Config.User, '65532:65532');
  assert.equal(active[0].Config.Labels[IMAGE_UPDATE_DISPOSABLE_LABEL], 'true');
  assert.equal(active[0].HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(active[0].HostConfig.CapDrop, ['ALL']);
  assert.equal(active[0].Mounts.length, 0);
  assert.equal(docker.networks.size, 2);
  assert.equal(Array.from(docker.networks.values()).every((network) => network.Internal === false), true);
  assert.equal(fs.statSync(path.join(dataRoot, 'image-updates')).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(dataRoot, 'image-updates', 'operation.lock')), false);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('tag drift is rejected before pull and a failed candidate leaves the active image running', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-image-drift-'));
  const docker = dockerHarness();
  const manager = createManager(dataRoot, docker, 100);
  const plan1 = await manager.createPlan(planInput('v1.10.3'));
  const operation1 = await manager.applyPlan(plan1.planId, plan1.confirmation);

  const stalePlan = await manager.createPlan(planInput('v1.11.0'));
  docker.setDistributionDigest('v1.11.0', 'sha256:' + 'f'.repeat(64));
  await assert.rejects(() => manager.applyPlan(stalePlan.planId, stalePlan.confirmation), /digest changed/);
  assert.equal(manager.status().current.operationId, operation1.operationId);

  docker.setDistributionDigest('v1.11.0', CANARY_DIGESTS['v1.11.0']);
  const badPlan = await manager.createPlan(planInput('v1.11.0', 'missing-marker'));
  await assert.rejects(() => manager.applyPlan(badPlan.planId, badPlan.confirmation), /health proof/);
  assert.equal(manager.status().current.operationId, operation1.operationId);
  const stable = Array.from(docker.containers.values()).find((container) => container.Name === '/' + IMAGE_UPDATE_NAME);
  assert.equal(stable.State.Status, 'running');
  assert.equal(docker.networks.size, 1);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('partial promotion removes the candidate and re-proves the previous image', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-image-restore-'));
  const docker = dockerHarness();
  const manager = createManager(dataRoot, docker, 200);
  const plan1 = await manager.createPlan(planInput('v1.10.3'));
  const operation1 = await manager.applyPlan(plan1.planId, plan1.confirmation);
  const plan2 = await manager.createPlan(planInput('v1.11.0'));
  docker.failNextRenameTo(IMAGE_UPDATE_NAME);

  await assert.rejects(() => manager.applyPlan(plan2.planId, plan2.confirmation), /injected rename failure/);
  assert.equal(manager.status().current.operationId, operation1.operationId);
  const failed = manager.status().operations.find((operation) => operation.planId === plan2.planId);
  assert.equal(failed.status, 'failed-previous-restoration-attempted');
  assert.equal(failed.restorationProof.verified, true);
  const stable = Array.from(docker.containers.values()).filter((container) => container.Name === '/' + IMAGE_UPDATE_NAME);
  assert.equal(stable.length, 1);
  assert.equal(stable[0].State.Status, 'running');
  assert.equal(docker.networks.size, 1);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('planning, apply and rollback require exact confirmations and no-op digests are blocked', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-image-confirm-'));
  const docker = dockerHarness();
  const manager = createManager(dataRoot, docker, 300);
  await assert.rejects(() => manager.createPlan({ ...planInput('v1.10.3'), confirmation: 'yes' }), /Exact/);
  const plan = await manager.createPlan(planInput('v1.10.3'));
  await assert.rejects(() => manager.applyPlan(plan.planId, 'yes'), /Exact/);
  await manager.applyPlan(plan.planId, plan.confirmation);
  await assert.rejects(() => manager.createPlan(planInput('v1.10.3')), /already current/);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('a stale running operation is marked interrupted after an agent restart', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-image-interrupted-'));
  const operationsRoot = path.join(dataRoot, 'image-updates', 'operations');
  fs.mkdirSync(operationsRoot, { recursive: true, mode: 0o700 });
  const operationId = 'iop_' + 'a'.repeat(32);
  fs.writeFileSync(path.join(operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    status: 'running',
    startedAt: '2026-08-04T00:00:00.000Z'
  }));

  const manager = createManager(dataRoot, dockerHarness(), 400);
  const interrupted = manager.status().operations.find((operation) => operation.operationId === operationId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.error.code, 'agent-restarted');
  assert.equal(manager.status().operationLock.active, false);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('read-only planning context does not rewrite a stale image-update operation', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-image-read-only-'));
  const operationsRoot = path.join(dataRoot, 'image-updates', 'operations');
  fs.mkdirSync(operationsRoot, { recursive: true, mode: 0o700 });
  const operationId = 'iop_' + 'b'.repeat(32);
  fs.writeFileSync(path.join(operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    status: 'running',
    startedAt: '2026-08-04T00:00:00.000Z'
  }));

  const manager = createImageUpdateManager({
    dataRoot,
    dockerRequest: dockerHarness().dockerRequest,
    recoverInterruptedOperations: false
  });
  const operation = manager.status().operations.find((entry) => entry.operationId === operationId);
  assert.equal(operation.status, 'running');

  fs.rmSync(dataRoot, { recursive: true, force: true });
});
