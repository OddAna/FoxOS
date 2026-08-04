const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PILOT_LABEL,
  createAdoptionManager,
  planDraftConfirmation,
  tarContentDigest,
  unresolvedEnvironmentNames
} = require('./adoptionManager');

const RESOURCE_ID = 'res_' + '1'.repeat(32);
const SOURCE_ID = 'a'.repeat(64);
const TARGET_ID = 'b'.repeat(64);
const VERIFY_ID = 'c'.repeat(64);
const IMAGE_ID = 'sha256:' + 'd'.repeat(64);
const IMAGE_DIGEST = 'example/hello@sha256:' + 'e'.repeat(64);

function tarArchive(name, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

function resource(overrides = {}) {
  return {
    schemaVersion: 1,
    id: RESOURCE_ID,
    kind: 'container',
    name: 'foxos-adoption-lab',
    role: 'application',
    ownership: 'observed',
    provider: 'docker-compose',
    protected: false,
    provenance: {
      imported: false,
      safeLabels: {
        [PILOT_LABEL]: 'true',
        'com.docker.compose.project': 'foxos-adoption-lab',
        'com.docker.compose.service': 'web'
      },
      project: 'foxos-adoption-lab',
      service: 'web'
    },
    runtime: {
      engine: 'docker',
      containerId: SOURCE_ID,
      image: 'example/hello:0.0.1',
      imageId: IMAGE_ID,
      state: 'running',
      status: 'Up 1 minute (healthy)',
      restartPolicy: 'unless-stopped',
      health: { configured: true, status: 'healthy' },
      environmentVariableCount: 1,
      inspection: 'complete'
    },
    ports: [{ privatePort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 18088 }],
    routes: [],
    mounts: [{
      type: 'volume',
      name: 'foxos-adoption-lab-data',
      source: null,
      destination: '/data',
      readOnly: true
    }],
    networks: [{ name: 'foxos-adoption-lab_default', driver: 'bridge', ipAddress: null, gateway: null }],
    adoption: { stage: 'observed', eligible: true, ready: false, blockers: [] },
    ...overrides
  };
}

function sourceDetails(state = 'running') {
  return {
    Image: IMAGE_ID,
    Config: {
      Image: 'example/hello:0.0.1',
      Labels: {
        [PILOT_LABEL]: 'true',
        'com.docker.compose.project': 'foxos-adoption-lab',
        'com.docker.compose.service': 'web'
      },
      Env: ['BASE=true'],
      Cmd: ['hello'],
      Entrypoint: ['/entrypoint'],
      User: '65532',
      WorkingDir: '/app',
      Healthcheck: { Test: ['CMD', 'health'] }
    },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '18088' }] },
      Privileged: false,
      Devices: [],
      CapAdd: [],
      Memory: 0,
      NanoCpus: 0
    },
    State: { Status: state, Health: { Status: state === 'running' ? 'healthy' : 'none' } }
  };
}

function imageDetails() {
  return {
    Id: IMAGE_ID,
    RepoDigests: [IMAGE_DIGEST],
    Config: {
      Env: ['BASE=true'],
      Cmd: ['hello'],
      Entrypoint: ['/entrypoint'],
      User: '65532',
      WorkingDir: '/app'
    }
  };
}

function createHarness({ resourceOverride = {}, failTargetHealth = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-adoption-test-'));
  const calls = [];
  const archive = tarArchive('data/example.txt', 'foxos disposable backup\n');
  let currentSourceState = 'running';
  let sourceName = 'foxos-adoption-lab';
  let targetExists = false;
  let targetPayload = null;
  const currentResource = resource(resourceOverride);
  const snapshot = {
    snapshotId: 'snap_' + '2'.repeat(32),
    resources: [currentResource],
    relationships: [],
    conflicts: []
  };
  const registry = {
    scan: async () => snapshot
  };

  async function dockerRequest(method, requestPath, payload = null) {
    calls.push({ method, requestPath, payload });
    if (method === 'GET' && requestPath === '/containers/' + SOURCE_ID + '/json') {
      return sourceDetails(currentSourceState);
    }
    if (method === 'GET' && requestPath === '/images/' + encodeURIComponent(IMAGE_ID) + '/json') {
      return imageDetails();
    }
    if (method === 'POST' && requestPath === '/volumes/create') return { Name: payload.Name };
    if (method === 'DELETE' && requestPath.startsWith('/volumes/foxos-adoption-verify-')) return null;
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=foxos-adoption-verify-')) {
      return { Id: VERIFY_ID };
    }
    if (method === 'DELETE' && requestPath === '/containers/' + VERIFY_ID + '?force=1&v=0') return null;
    if (method === 'POST' && requestPath === '/containers/' + SOURCE_ID + '/stop?t=10') {
      currentSourceState = 'exited';
      return null;
    }
    if (method === 'POST' && requestPath.startsWith('/containers/' + SOURCE_ID + '/rename?name=')) {
      sourceName = decodeURIComponent(requestPath.split('name=')[1]);
      return null;
    }
    if (method === 'POST' && requestPath === '/containers/create?name=foxos-adoption-lab') {
      targetExists = true;
      targetPayload = payload;
      return { Id: TARGET_ID };
    }
    if (method === 'POST' && requestPath === '/containers/' + TARGET_ID + '/start') return null;
    if (method === 'GET' && requestPath === '/containers/' + TARGET_ID + '/json' && targetExists) {
      return {
        Config: { Labels: targetPayload.Labels, Healthcheck: targetPayload.Healthcheck },
        State: {
          Status: failTargetHealth ? 'exited' : 'running',
          Health: { Status: failTargetHealth ? 'unhealthy' : 'healthy' }
        }
      };
    }
    if (method === 'DELETE' && requestPath === '/containers/' + TARGET_ID + '?force=1&v=0') {
      targetExists = false;
      return null;
    }
    if (method === 'POST' && requestPath === '/containers/' + SOURCE_ID + '/start') {
      currentSourceState = 'running';
      return null;
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  }

  async function dockerArchiveRequest(method, requestPath) {
    calls.push({ method, requestPath, archive: true });
    if (method === 'GET' || method === 'PUT') return archive;
    throw new Error('Unexpected Docker archive request: ' + method + ' ' + requestPath);
  }

  const manager = createAdoptionManager({
    dataRoot: root,
    dockerRequest,
    dockerArchiveRequest,
    resourceRegistry: registry,
    clock: () => new Date('2026-08-04T12:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000099',
    wait: async () => {}
  });
  return {
    archive,
    calls,
    currentResource,
    manager,
    root,
    runtime: () => ({ currentSourceState, sourceName, targetExists, targetPayload })
  };
}

test('manifest planning is deterministic, read-only and persists no secret values', async () => {
  const harness = createHarness();
  try {
    const confirmation = planDraftConfirmation(RESOURCE_ID);
    const first = await harness.manager.createPlan(RESOURCE_ID, {
      confirmation,
      healthPrivatePort: 80,
      healthPath: '/'
    });
    const second = await harness.manager.createPlan(RESOURCE_ID, {
      confirmation,
      healthPrivatePort: 80,
      healthPath: '/'
    });

    assert.equal(first.status, 'ready');
    assert.equal(first.planId, second.planId);
    assert.equal(first.manifest.revision, second.manifest.revision);
    assert.equal(first.manifest.desired.runtime.image.reference, IMAGE_DIGEST);
    assert.deepEqual(first.manifest.desired.environment, {
      ordinary: [],
      secretRefs: [],
      unresolvedNames: []
    });
    assert.equal(first.guarantees.runtimeMutated, false);
    assert.equal(harness.calls.every((call) => call.method === 'GET'), true);
    const persisted = fs.readdirSync(harness.manager.paths.plansRoot)
      .map((file) => fs.readFileSync(path.join(harness.manager.paths.plansRoot, file), 'utf8'))
      .join('\n');
    assert.equal(persisted.includes('BASE=true'), false);
    assert.equal(fs.statSync(harness.manager.paths.adoptionRoot).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('pilot rejects provider-managed and unlabeled resources before Docker mutation', async () => {
  for (const resourceOverride of [
    { provider: 'coolify' },
    { provenance: { ...resource().provenance, safeLabels: {} } }
  ]) {
    const harness = createHarness({ resourceOverride });
    try {
      await assert.rejects(
        harness.manager.createPlan(RESOURCE_ID, {
          confirmation: planDraftConfirmation(RESOURCE_ID),
          healthPrivatePort: 80,
          healthPath: '/'
        }),
        (error) => ['pilot-provider-blocked', 'disposable-label-required'].includes(error.code)
      );
      assert.equal(harness.calls.length, 0);
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test('apply proves backup restore and rollback restores the original source', async () => {
  const harness = createHarness();
  try {
    const plan = await harness.manager.createPlan(RESOURCE_ID, {
      confirmation: planDraftConfirmation(RESOURCE_ID),
      healthPrivatePort: 80,
      healthPath: '/'
    });
    const operation = await harness.manager.applyPlan(plan.planId, plan.confirmation);

    assert.equal(operation.status, 'applied');
    assert.equal(operation.backups[0].restoreProof.verified, true);
    assert.equal(operation.backups[0].contentDigest, operation.backups[0].restoreProof.restoredDigest);
    assert.equal(harness.runtime().targetExists, true);
    assert.match(harness.runtime().sourceName, /^foxos-adoption-lab-foxos-rollback-/);
    assert.equal(harness.runtime().targetPayload.Image, IMAGE_DIGEST);
    assert.equal(harness.runtime().targetPayload.Labels['com.foxos.resource.id'], RESOURCE_ID);
    assert.deepEqual(harness.runtime().targetPayload.HostConfig.SecurityOpt, ['no-new-privileges:true']);
    const backupFile = path.join(harness.manager.paths.adoptionRoot, operation.backups[0].archiveFile);
    assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);

    const rolledBack = await harness.manager.rollbackOperation(operation.operationId, operation.rollback.confirmation);
    assert.equal(rolledBack.status, 'rolled-back');
    assert.equal(rolledBack.rollback.proof.health, 'healthy');
    assert.deepEqual(harness.runtime(), {
      currentSourceState: 'running',
      sourceName: 'foxos-adoption-lab',
      targetExists: false,
      targetPayload: harness.runtime().targetPayload
    });
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('failed target verification attempts automatic source restoration', async () => {
  const harness = createHarness({ failTargetHealth: true });
  try {
    const plan = await harness.manager.createPlan(RESOURCE_ID, {
      confirmation: planDraftConfirmation(RESOURCE_ID),
      healthPrivatePort: 80,
      healthPath: '/'
    });
    await assert.rejects(
      harness.manager.applyPlan(plan.planId, plan.confirmation),
      (error) => error.code === 'health-verification-failed'
    );
    assert.equal(harness.runtime().currentSourceState, 'running');
    assert.equal(harness.runtime().sourceName, 'foxos-adoption-lab');
    assert.equal(harness.runtime().targetExists, false);
    assert.equal(harness.manager.status().operations[0].status, 'failed-automatic-rollback-attempted');
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('environment comparison stores names only and backup digest rejects unsafe paths', () => {
  assert.deepEqual(
    unresolvedEnvironmentNames(['BASE=true', 'API_TOKEN=secret-value'], ['BASE=true']),
    ['API_TOKEN']
  );
  assert.match(tarContentDigest(tarArchive('data/example.txt', 'same content')), /^sha256:[a-f0-9]{64}$/);
  assert.throws(
    () => tarContentDigest(tarArchive('../escape.txt', 'unsafe')),
    (error) => error.code === 'unsafe-backup-archive'
  );
});
