const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEPLOYMENT_NAME,
  PLAN_CONFIRMATION,
  createGitSourceAdapter,
  createSourceDeploymentManager,
  deploymentConfirmation,
  inspectContext,
  isPrivateAddress,
  parseBuildOutput,
  rollbackConfirmation,
  sanitizeBuildLog,
  validateDockerfile,
  validateGitRef,
  validateRepositoryUrl
} = require('./sourceDeploymentManager');

const PINNED_NODE = 'node:22-alpine@sha256:' + 'a'.repeat(64);

function sourceAdapter() {
  return {
    async inspect(source) {
      const marker = source.contextPath.endsWith('v2') ? 'v2' : source.contextPath.endsWith('bad') ? 'bad' : 'v1';
      return {
        commit: marker === 'v1' ? '1'.repeat(40) : marker === 'v2' ? '2'.repeat(40) : '3'.repeat(40),
        refType: 'branch',
        contextDigest: 'sha256:' + marker.padEnd(64, '0'),
        dockerfileDigest: 'sha256:' + marker.padEnd(64, 'f'),
        fileCount: 2,
        totalBytes: 200
      };
    },
    async archive(source) {
      return Buffer.from('context:' + source.contextPath);
    }
  };
}

function dockerHarness() {
  const containers = new Map();
  const imageBodies = new Map();
  let nextContainer = 1;
  let nextPort = 41000;
  let lastImageId = null;

  function summary(container) {
    return {
      Id: container.Id,
      Names: ['/' + container.Name],
      Labels: container.Config.Labels,
      State: container.State.Status,
      Status: container.State.Status
    };
  }

  async function dockerBuildRequest(requestPath, archive) {
    const marker = archive.toString('utf8').split(':').pop();
    lastImageId = 'sha256:' + (marker.endsWith('v2') ? '2' : marker.endsWith('bad') ? '3' : '1').repeat(64);
    imageBodies.set(lastImageId, marker.endsWith('v2') ? 'FoxOS canary v2' : marker.endsWith('bad') ? 'wrong marker' : 'FoxOS canary v1');
    return Buffer.from(
      JSON.stringify({ stream: 'Step 1/2\n' }) + '\n' +
      JSON.stringify({ aux: { ID: lastImageId } }) + '\n'
    );
  }

  async function dockerRequest(method, requestPath, payload = null) {
    if (method === 'GET' && requestPath === '/containers/json?all=1') {
      return Array.from(containers.values()).map(summary);
    }
    if (method === 'GET' && requestPath.startsWith('/images/')) {
      return { Id: lastImageId };
    }
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      const id = String(nextContainer++).padStart(64, 'c');
      const name = decodeURIComponent(requestPath.split('name=')[1]);
      const privatePort = Number(Object.keys(payload.HostConfig.PortBindings)[0].split('/')[0]);
      const hostPort = nextPort++;
      containers.set(id, {
        Id: id,
        Name: name,
        Config: { Image: payload.Image, Labels: payload.Labels },
        HostConfig: {
          PortBindings: { [privatePort + '/tcp']: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] }
        },
        NetworkSettings: {
          Ports: { [privatePort + '/tcp']: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] }
        },
        State: { Status: 'created' },
        body: imageBodies.get(payload.Image)
      });
      return { Id: id };
    }

    const containerMatch = requestPath.match(/^\/containers\/([a-z0-9]+)(?:\/(.*))?/);
    if (containerMatch) {
      const container = containers.get(containerMatch[1]);
      if (!container) throw new Error('container not found');
      if (method === 'GET' && (!containerMatch[2] || containerMatch[2] === 'json')) return container;
      if (method === 'DELETE') {
        containers.delete(container.Id);
        return null;
      }
      if (method === 'POST' && containerMatch[2]) {
        const action = containerMatch[2];
        if (action.startsWith('start')) container.State.Status = 'running';
        if (action.startsWith('stop')) container.State.Status = 'exited';
        if (action.startsWith('rename?name=')) container.Name = decodeURIComponent(action.split('name=')[1]);
        return null;
      }
    }
    throw new Error('Unexpected Docker request ' + method + ' ' + requestPath);
  }

  async function probeHttp({ port }) {
    const container = Array.from(containers.values()).find((candidate) => (
      Number(candidate.NetworkSettings.Ports[Object.keys(candidate.NetworkSettings.Ports)[0]][0].HostPort) === port
    ));
    if (!container || container.State.Status !== 'running') throw new Error('not running');
    return { statusCode: 200, body: container.body };
  }

  return { containers, dockerBuildRequest, dockerRequest, probeHttp };
}

function planInput(contextPath, expectedBody) {
  return {
    repository: 'https://example.com/foxos/canary.git',
    ref: 'develop',
    contextPath,
    dockerfile: 'Dockerfile',
    privatePort: 8080,
    healthPath: '/',
    expectedBody,
    confirmation: PLAN_CONFIRMATION
  };
}

test('public source validation rejects credentials, unsafe refs, private addresses and unpinned bases', () => {
  assert.equal(validateRepositoryUrl('https://example.com/team/app.git'), 'https://example.com/team/app.git');
  assert.throws(() => validateRepositoryUrl('https://user:pass@example.com/app.git'), /credential-free/);
  assert.throws(() => validateRepositoryUrl('http://example.com/app.git'), /credential-free/);
  assert.equal(validateGitRef('release/v0.0.1'), 'release/v0.0.1');
  assert.throws(() => validateGitRef('../main'), /invalid/);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('192.0.2.2'), false);
  assert.doesNotThrow(() => validateDockerfile(Buffer.from('FROM ' + PINNED_NODE + '\n')));
  assert.throws(() => validateDockerfile(Buffer.from('FROM node:22-alpine\n')), /pinned/);
  assert.throws(() => validateDockerfile(Buffer.from('FROM ' + PINNED_NODE + '\nADD archive.tar /a\n')), /outside the first/);
});

test('context inspection is deterministic, bounded and rejects symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-source-context-'));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM ' + PINNED_NODE + '\nCOPY server.js /app/server.js\n');
  fs.writeFileSync(path.join(root, 'server.js'), 'console.log("ok")\n');
  const first = inspectContext(root);
  const second = inspectContext(root);
  assert.deepEqual(first, second);
  assert.equal(first.fileCount, 2);
  fs.symlinkSync('server.js', path.join(root, 'linked.js'));
  assert.throws(() => inspectContext(root), /Symlinks are not allowed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('build output is bounded, redacted and returns the immutable image ID', () => {
  const imageId = 'sha256:' + 'f'.repeat(64);
  const parsed = parseBuildOutput(Buffer.from(
    JSON.stringify({ stream: 'token=should-not-survive\n' }) + '\n' +
    JSON.stringify({ aux: { ID: imageId } }) + '\n'
  ));
  assert.equal(parsed.imageId, imageId);
  assert.doesNotMatch(parsed.log, /should-not-survive/);
  assert.match(parsed.log, /\[redacted\]/);
  assert.doesNotMatch(sanitizeBuildLog('https://user:pass@example.com/repo'), /user:pass/);
});

test('private Git credentials use an ephemeral askpass environment and never enter Git arguments', async () => {
  const credentialValue = 'git-private-token-value';
  const commit = '9'.repeat(40);
  const askPassFiles = [];
  const adapter = createGitSourceAdapter({
    enforceBuildPolicy: false,
    resolveHost: async () => [{ address: '192.0.2.10', family: 4 }],
    resolveCredential: async (reference) => ({
      username: reference.username,
      password: credentialValue
    }),
    runCommand: async (file, args, options) => {
      assert.equal(file, 'git');
      assert.equal(JSON.stringify(args).includes(credentialValue), false);
      assert.equal(options.env.FOXOS_GIT_PASSWORD, credentialValue);
      assert.equal(fs.readFileSync(options.env.GIT_ASKPASS, 'utf8').includes(credentialValue), false);
      askPassFiles.push(options.env.GIT_ASKPASS);
      if (args.includes('ls-remote')) {
        return { stdout: commit + '\trefs/heads/main\n', stderr: '' };
      }
      if (args.includes('clone')) {
        const repositoryRoot = args.at(-1);
        fs.mkdirSync(repositoryRoot, { recursive: true });
        fs.writeFileSync(path.join(repositoryRoot, 'Dockerfile'), 'FROM node:22-alpine\n');
        fs.writeFileSync(path.join(repositoryRoot, 'server.js'), 'console.log("ok")\n');
        return { stdout: '', stderr: '' };
      }
      if (args.includes('rev-parse')) return { stdout: commit + '\n', stderr: '' };
      throw new Error('Unexpected Git command');
    }
  });
  const inspected = await adapter.inspect({
    repository: 'https://example.com/private/site.git',
    ref: 'main',
    contextPath: '.',
    dockerfile: 'Dockerfile',
    credential: { username: 'x-access-token', secretId: 'secret-ref', revision: 'secret-revision' }
  });
  assert.equal(inspected.commit, commit);
  assert.equal(askPassFiles.length, 3);
  assert.equal(askPassFiles.every((file) => !fs.existsSync(file)), true);
});

test('source deployments health-gate candidates, preserve the previous revision and roll back exactly', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-deploy-state-'));
  const docker = dockerHarness();
  let counter = 0;
  const manager = createSourceDeploymentManager({
    dataRoot,
    dockerRequest: docker.dockerRequest,
    dockerBuildRequest: docker.dockerBuildRequest,
    sourceAdapter: sourceAdapter(),
    probeHttp: docker.probeHttp,
    randomUUID: () => (++counter).toString(16).padStart(32, '0'),
    wait: async () => {}
  });

  const plan1 = await manager.createPlan(planInput('pilot/v1', 'FoxOS canary v1'));
  assert.equal(plan1.confirmation, deploymentConfirmation(plan1.planId));
  const operation1 = await manager.applyPlan(plan1.planId, plan1.confirmation);
  assert.equal(operation1.status, 'applied');
  assert.equal(operation1.rollback.available, false);

  const plan2 = await manager.createPlan(planInput('pilot/v2', 'FoxOS canary v2'));
  const operation2 = await manager.applyPlan(plan2.planId, plan2.confirmation);
  assert.equal(operation2.status, 'applied');
  assert.equal(operation2.rollback.available, true);
  assert.equal(operation2.previous.containerId, operation1.candidate.containerId);
  assert.equal(Array.from(docker.containers.values()).find((container) => container.Name === DEPLOYMENT_NAME).body, 'FoxOS canary v2');

  const rolledBack = await manager.rollbackOperation(operation2.operationId, rollbackConfirmation(operation2.operationId));
  assert.equal(rolledBack.status, 'rolled-back');
  const active = Array.from(docker.containers.values()).find((container) => container.Name === DEPLOYMENT_NAME);
  assert.equal(active.Id, operation1.candidate.containerId);
  assert.equal(active.State.Status, 'running');
  assert.equal(active.body, 'FoxOS canary v1');
  assert.equal(manager.status().current.revisionId, plan1.revisionId);
  assert.equal(fs.statSync(path.join(dataRoot, 'deployments')).mode & 0o777, 0o700);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('a failed candidate health proof leaves the active revision running and records no cutover', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-deploy-failure-'));
  const docker = dockerHarness();
  let counter = 100;
  const manager = createSourceDeploymentManager({
    dataRoot,
    dockerRequest: docker.dockerRequest,
    dockerBuildRequest: docker.dockerBuildRequest,
    sourceAdapter: sourceAdapter(),
    probeHttp: docker.probeHttp,
    randomUUID: () => (++counter).toString(16).padStart(32, '0'),
    wait: async () => {}
  });
  const good = await manager.createPlan(planInput('pilot/v1', 'FoxOS canary v1'));
  const applied = await manager.applyPlan(good.planId, good.confirmation);
  const bad = await manager.createPlan(planInput('pilot/bad', 'expected marker'));
  await assert.rejects(() => manager.applyPlan(bad.planId, bad.confirmation), /did not match/);
  const active = Array.from(docker.containers.values()).find((container) => container.Name === DEPLOYMENT_NAME);
  assert.equal(active.Id, applied.candidate.containerId);
  assert.equal(active.State.Status, 'running');
  assert.equal(manager.status().current.revisionId, good.revisionId);
  assert.equal(manager.status().operations.at(-1).status, 'failed-before-cutover');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('exact confirmations are required for plan, apply and rollback', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-deploy-confirm-'));
  const docker = dockerHarness();
  const manager = createSourceDeploymentManager({
    dataRoot,
    dockerRequest: docker.dockerRequest,
    dockerBuildRequest: docker.dockerBuildRequest,
    sourceAdapter: sourceAdapter(),
    probeHttp: docker.probeHttp,
    randomUUID: () => 'f'.repeat(32),
    wait: async () => {}
  });
  await assert.rejects(() => manager.createPlan({ ...planInput('pilot/v1', 'FoxOS canary v1'), confirmation: 'yes' }), /Exact/);
  const plan = await manager.createPlan(planInput('pilot/v1', 'FoxOS canary v1'));
  await assert.rejects(() => manager.applyPlan(plan.planId, 'yes'), /Exact/);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
