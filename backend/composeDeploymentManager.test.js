const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  COMPOSE_DEPLOYMENT_NAME,
  COMPOSE_DISPOSABLE_LABEL,
  PLAN_COMPOSE_CONFIRMATION,
  composeCancelConfirmation,
  composeRollbackConfirmation,
  createComposeDeploymentManager,
  parseComposeManifest
} = require('./composeDeploymentManager');

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex');
}

function manifest(version = 'v1') {
  return Buffer.from(`
name: foxos-compose-lab
services:
  api:
    build:
      context: api
      dockerfile: Dockerfile
    expose:
      - "9090"
  web:
    build:
      context: web
      dockerfile: Dockerfile
    depends_on:
      - api
    expose:
      - "8080"
`);
}

function sourceAdapter() {
  const commit = 'a'.repeat(40);
  return {
    async read(source) {
      const version = source.filePath.includes('v2') ? 'v2' : source.filePath.includes('bad') ? 'bad' : 'v1';
      const content = manifest(version);
      return {
        commit,
        refType: 'branch',
        filePath: source.filePath,
        fileDigest: digest(content),
        fileBytes: content.length,
        content
      };
    },
    async inspect(source) {
      return {
        commit,
        refType: 'branch',
        contextDigest: digest('context:' + source.contextPath),
        dockerfileDigest: digest('dockerfile:' + source.contextPath),
        fileCount: 2,
        totalBytes: 100
      };
    },
    async archive(source) {
      return Buffer.from(source.contextPath);
    }
  };
}

function dockerHarness() {
  const containers = new Map();
  const networks = new Map();
  const images = new Map();
  const imageBodies = new Map();
  let nextContainer = 1;
  let nextNetwork = 1;
  let nextImage = 1;
  let nextPort = 42000;
  let failedRenameTarget = null;

  async function dockerBuildRequest(requestPath, archive) {
    const query = new URL('http://docker' + requestPath).searchParams;
    const tag = query.get('t');
    const imageId = 'sha256:' + String(nextImage++).padStart(64, 'b');
    const context = archive.toString('utf8');
    const version = context.includes('/v2/') ? 'v2' : context.includes('/bad/') ? 'bad' : 'v1';
    const service = context.endsWith('/web') ? 'web' : 'api';
    images.set(tag, imageId);
    imageBodies.set(imageId, service === 'web' ? (
      version === 'bad' ? 'unexpected body' : `FoxOS compose canary ${version} + api-${version}`
    ) : `api-${version}`);
    return Buffer.from(JSON.stringify({ aux: { ID: imageId } }) + '\n');
  }

  async function dockerRequest(method, requestPath, payload) {
    if (method === 'GET' && requestPath === '/containers/json?all=1') {
      return Array.from(containers.values()).map((container) => ({
        Id: container.Id,
        Names: [container.Name],
        Labels: container.Config.Labels,
        State: container.State.Status,
        Image: container.Config.Image
      }));
    }
    if (method === 'POST' && requestPath === '/networks/create') {
      const id = String(nextNetwork++).padStart(64, 'n');
      networks.set(id, { Id: id, Name: payload.Name, Labels: payload.Labels, Internal: payload.Internal });
      return { Id: id };
    }
    if (method === 'DELETE' && requestPath.startsWith('/networks/')) {
      networks.delete(requestPath.slice('/networks/'.length));
      return null;
    }
    if (method === 'GET' && requestPath.startsWith('/images/')) {
      const tag = decodeURIComponent(requestPath.slice('/images/'.length, -'/json'.length));
      return { Id: images.get(tag) };
    }
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      const id = String(nextContainer++).padStart(64, 'c');
      const name = decodeURIComponent(requestPath.split('name=')[1]);
      const portKey = Object.keys(payload.ExposedPorts)[0];
      const bindings = payload.HostConfig.PortBindings[portKey];
      const hostPort = bindings && String(nextPort++);
      containers.set(id, {
        Id: id,
        Name: '/' + name,
        Config: { Image: payload.Image, Labels: payload.Labels },
        HostConfig: payload.HostConfig,
        NetworkSettings: { Ports: { [portKey]: hostPort ? [{ HostIp: '127.0.0.1', HostPort: hostPort }] : null } },
        State: { Status: 'created' },
        body: imageBodies.get(payload.Image)
      });
      return { Id: id };
    }
    const match = requestPath.match(/^\/containers\/([a-z0-9]+)(?:\/(.*))?/);
    if (match) {
      const container = containers.get(match[1]);
      if (!container) throw new Error('container not found');
      if (method === 'GET' && (!match[2] || match[2] === 'json')) return container;
      if (method === 'DELETE') {
        containers.delete(container.Id);
        return null;
      }
      if (method === 'POST') {
        const action = match[2];
        if (action.startsWith('start')) container.State.Status = 'running';
        if (action.startsWith('stop')) container.State.Status = 'exited';
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
    return { statusCode: 200, body: container.body };
  }

  return {
    containers,
    networks,
    dockerBuildRequest,
    dockerRequest,
    probeHttp,
    failNextRenameTo(target) { failedRenameTarget = target; }
  };
}

function planInput(version, expectedBody) {
  return {
    repository: 'https://example.com/foxos/compose-canary.git',
    ref: 'develop',
    manifest: `pilot/${version}/compose.yaml`,
    ingressService: 'web',
    healthPath: '/',
    expectedBody,
    confirmation: PLAN_COMPOSE_CONFIRMATION
  };
}

function createManager(dataRoot, docker, options = {}) {
  let counter = options.counter || 0;
  return createComposeDeploymentManager({
    dataRoot,
    dockerRequest: docker.dockerRequest,
    dockerBuildRequest: docker.dockerBuildRequest,
    sourceAdapter: sourceAdapter(),
    probeHttp: docker.probeHttp,
    randomUUID: () => (++counter).toString(16).padStart(32, '0'),
    wait: async () => {},
    autoStartQueue: false
  });
}

test('strict Compose parser accepts only a bounded connected build graph', () => {
  const graph = parseComposeManifest(manifest(), 'web');
  assert.deepEqual(graph.startOrder, ['api', 'web']);
  assert.equal(graph.services.length, 2);
  assert.equal(graph.services.find((service) => service.name === 'web').privatePort, 8080);
  assert.throws(() => parseComposeManifest(Buffer.from(`
services:
  api:
    image: node:latest
    expose: ["9090"]
  web:
    build: ./web
    depends_on: [api]
    expose: ["8080"]
`), 'web'), /unsupported fields/);
  assert.throws(() => parseComposeManifest(Buffer.from(`
services:
  api:
    build: ./api
    depends_on: [web]
    expose: ["9090"]
  web:
    build: ./web
    depends_on: [api]
    expose: ["8080"]
`), 'web'), /cycle/);
  assert.throws(() => parseComposeManifest(Buffer.from(`
services:
  api: &service
    build: ./api
    expose: ["9090"]
  web:
    <<: *service
    depends_on: [api]
    expose: ["8080"]
`), 'web'), /errors|aliases|unsupported/);
});

test('queued Compose deployments health-gate a graph and roll back the complete previous group', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-compose-state-'));
  const docker = dockerHarness();
  const manager = createManager(dataRoot, docker);

  const plan1 = await manager.createPlan(planInput('v1', 'FoxOS compose canary v1 + api-v1'));
  const job1 = manager.enqueuePlan(plan1.planId, plan1.confirmation);
  await manager.processQueue();
  const completed1 = manager.getJob(job1.jobId);
  assert.equal(completed1.status, 'succeeded');
  const operation1 = manager.getOperation(completed1.operationId);
  assert.equal(operation1.status, 'applied');
  assert.equal(operation1.candidate.services.length, 2);
  assert.equal(operation1.rollback.available, false);

  const plan2 = await manager.createPlan(planInput('v2', 'FoxOS compose canary v2 + api-v2'));
  const job2 = manager.enqueuePlan(plan2.planId, plan2.confirmation);
  await manager.processQueue();
  const operation2 = manager.getOperation(manager.getJob(job2.jobId).operationId);
  assert.equal(operation2.status, 'applied');
  assert.equal(operation2.previous.services.length, 2);
  assert.equal(operation2.rollback.available, true);

  const rolledBack = await manager.rollbackOperation(
    operation2.operationId,
    composeRollbackConfirmation(operation2.operationId)
  );
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal(manager.status().current.revisionId, plan1.revisionId);
  const active = Array.from(docker.containers.values()).filter((container) => (
    container.Name.startsWith('/' + COMPOSE_DEPLOYMENT_NAME + '-') && container.State.Status === 'running'
  ));
  assert.equal(active.length, 2);
  assert.equal(active.every((container) => container.Config.Labels[COMPOSE_DISPOSABLE_LABEL] === 'true'), true);
  assert.equal(docker.networks.size, 2);
  assert.equal(fs.statSync(path.join(dataRoot, 'compose-deployments')).mode & 0o777, 0o700);
  assert.equal(fs.readdirSync(path.join(dataRoot, 'compose-deployments', 'logs')).length, 4);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('queued jobs can be cancelled before start and a failed graph leaves the active group running', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-compose-failure-'));
  const docker = dockerHarness();
  const manager = createManager(dataRoot, docker, { counter: 100 });
  const plan1 = await manager.createPlan(planInput('v1', 'FoxOS compose canary v1 + api-v1'));
  const firstJob = manager.enqueuePlan(plan1.planId, plan1.confirmation);
  await manager.processQueue();
  const firstOperation = manager.getJob(firstJob.jobId).operationId;

  const cancelledPlan = await manager.createPlan(planInput('v2', 'FoxOS compose canary v2 + api-v2'));
  const cancelledJob = manager.enqueuePlan(cancelledPlan.planId, cancelledPlan.confirmation);
  const cancelled = manager.cancelJob(cancelledJob.jobId, composeCancelConfirmation(cancelledJob.jobId));
  assert.equal(cancelled.status, 'cancelled');

  const badPlan = await manager.createPlan(planInput('bad', 'required marker'));
  const badJob = manager.enqueuePlan(badPlan.planId, badPlan.confirmation);
  await manager.processQueue();
  assert.equal(manager.getJob(badJob.jobId).status, 'failed');
  assert.equal(manager.status().current.operationId, firstOperation);
  const active = Array.from(docker.containers.values()).filter((container) => (
    container.Name === '/foxos-compose-lab-api' || container.Name === '/foxos-compose-lab-web'
  ));
  assert.equal(active.length, 2);
  assert.equal(active.every((container) => container.State.Status === 'running'), true);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('a partial candidate promotion removes conflicting names and re-proves the previous group', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-compose-rename-'));
  const docker = dockerHarness();
  const manager = createManager(dataRoot, docker, { counter: 150 });
  const plan1 = await manager.createPlan(planInput('v1', 'FoxOS compose canary v1 + api-v1'));
  const job1 = manager.enqueuePlan(plan1.planId, plan1.confirmation);
  await manager.processQueue();
  const operation1 = manager.getJob(job1.jobId).operationId;

  const plan2 = await manager.createPlan(planInput('v2', 'FoxOS compose canary v2 + api-v2'));
  const job2 = manager.enqueuePlan(plan2.planId, plan2.confirmation);
  docker.failNextRenameTo('foxos-compose-lab-web');
  await manager.processQueue();

  assert.equal(manager.getJob(job2.jobId).status, 'failed');
  assert.equal(manager.status().current.operationId, operation1);
  const failedOperation = manager.status().operations.find((operation) => operation.planId === plan2.planId);
  assert.equal(failedOperation.status, 'failed-previous-restoration-attempted');
  assert.equal(failedOperation.restorationProof.verified, true);
  const active = Array.from(docker.containers.values()).filter((container) => (
    container.Name === '/foxos-compose-lab-api' || container.Name === '/foxos-compose-lab-web'
  ));
  assert.equal(active.length, 2);
  assert.equal(active.every((container) => container.State.Status === 'running'), true);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('the persisted queue lock prevents two managers from applying the same queued job', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-compose-lock-'));
  const docker = dockerHarness();
  const firstManager = createManager(dataRoot, docker, { counter: 175 });
  const plan = await firstManager.createPlan(planInput('v1', 'FoxOS compose canary v1 + api-v1'));
  const job = firstManager.enqueuePlan(plan.planId, plan.confirmation);
  const secondManager = createManager(dataRoot, docker, { counter: 300 });

  await Promise.all([firstManager.processQueue(), secondManager.processQueue()]);
  await secondManager.processQueue();

  assert.equal(firstManager.getJob(job.jobId).status, 'succeeded');
  assert.equal(firstManager.status().operations.length, 1);
  assert.equal(Array.from(docker.containers.values()).length, 2);
  assert.equal(fs.existsSync(path.join(dataRoot, 'compose-deployments', 'queue.lock')), false);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('Compose plan, queue, cancellation and rollback require exact confirmations', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-compose-confirm-'));
  const docker = dockerHarness();
  const manager = createManager(dataRoot, docker, { counter: 200 });
  await assert.rejects(() => manager.createPlan({ ...planInput('v1', 'marker'), confirmation: 'yes' }), /Exact/);
  const plan = await manager.createPlan(planInput('v1', 'FoxOS compose canary v1 + api-v1'));
  assert.throws(() => manager.enqueuePlan(plan.planId, 'yes'), /Exact/);
  const job = manager.enqueuePlan(plan.planId, plan.confirmation);
  assert.throws(() => manager.cancelJob(job.jobId, 'yes'), /Exact/);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
