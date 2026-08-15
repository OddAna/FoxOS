const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createObservabilityManager,
  normalizeDockerStats,
  parseDockerLogs,
  redactSensitiveText
} = require('./observabilityManager');

function writeHostFixture(hostRoot, { availableKb = 100_000, cpuIdle = 700, rx = 1_000, tx = 2_000 } = {}) {
  fs.mkdirSync(path.join(hostRoot, 'proc/net'), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'proc/stat'), `cpu  100 0 200 ${cpuIdle} 0 0 0 0 0 0\n`);
  fs.writeFileSync(path.join(hostRoot, 'proc/meminfo'), [
    'MemTotal:       1000000 kB',
    `MemAvailable:    ${availableKb} kB`
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(hostRoot, 'proc/loadavg'), '0.25 0.50 0.75 1/100 42\n');
  fs.writeFileSync(path.join(hostRoot, 'proc/uptime'), '3600.00 1200.00\n');
  fs.writeFileSync(path.join(hostRoot, 'proc/net/dev'), [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
    `  eth0: ${rx} 1 0 0 0 0 0 0 ${tx} 1 0 0 0 0 0 0`,
    '    lo: 99 1 0 0 0 0 0 0 99 1 0 0 0 0 0 0'
  ].join('\n') + '\n');
}

function multiplex(stream, value) {
  const body = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function applicationFixture({ state = 'running', healthStatus = 'healthy' } = {}) {
  return {
    id: 'res_' + 'a'.repeat(32),
    name: 'Defter',
    runtime: {
      containerId: 'b'.repeat(64),
      state,
      healthStatus,
      operationalState: state === 'running' && healthStatus === 'healthy' ? 'running' : 'error',
      exitCode: state === 'running' ? null : 2
    }
  };
}

test('Docker statistics and logs expose only bounded, redacted observability fields', () => {
  const stats = normalizeDockerStats({
    read: '2026-08-15T10:00:00.000Z',
    cpu_stats: {
      online_cpus: 2,
      system_cpu_usage: 3_000,
      cpu_usage: { total_usage: 1_000 }
    },
    precpu_stats: {
      system_cpu_usage: 1_000,
      cpu_usage: { total_usage: 500 }
    },
    memory_stats: {
      usage: 600,
      limit: 1_000,
      stats: { inactive_file: 100 }
    },
    networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: 30 },
        { op: 'Write', value: 40 }
      ]
    },
    pids_stats: { current: 5 },
    secret_field: 'must-not-leak'
  });
  assert.equal(stats.cpu.usagePercent, 50);
  assert.equal(stats.memory.usageBytes, 500);
  assert.equal(stats.memory.usagePercent, 50);
  assert.deepEqual(stats.network, { rxBytes: 10, txBytes: 20 });
  assert.deepEqual(stats.blockIo, { readBytes: 30, writeBytes: 40 });
  assert.equal(JSON.stringify(stats).includes('must-not-leak'), false);

  const logs = Buffer.concat([
    multiplex(1, '2026-08-15T10:00:00.000Z listening on 8080\n'),
    multiplex(2, '2026-08-15T10:00:01.000Z ERROR token=very-secret password="also-secret"\n')
  ]);
  const entries = parseDockerLogs(logs);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].level, 'error');
  assert.match(entries[1].message, /token=\[redacted\]/);
  assert.match(entries[1].message, /password=\[redacted\]/);
  assert.equal(JSON.stringify(entries).includes('very-secret'), false);
  assert.equal(parseDockerLogs(logs, { level: 'error', query: 'ERROR' }).length, 1);
  assert.equal(redactSensitiveText('https://alice:secret@example.test').includes('secret'), false);
  assert.equal(redactSensitiveText('Bearer eyJabc.def.ghi').includes('eyJabc'), false);
  assert.equal(redactSensitiveText('Cookie: session=one; refresh=two').includes('refresh=two'), false);
  assert.equal(redactSensitiveText('AWS_SECRET_ACCESS_KEY=must-not-leak').includes('must-not-leak'), false);
  assert.equal(redactSensitiveText('OPENAI_API_KEY=must-not-leak').includes('must-not-leak'), false);
});

test('observability sampling records history and transitions, deduplicates alerts and resolves recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-observability-'));
  const dataRoot = path.join(root, 'data');
  const hostRoot = path.join(root, 'host');
  let current = new Date('2026-08-15T10:00:00.000Z');
  let application = applicationFixture();
  const created = [];
  const resolved = [];
  try {
    writeHostFixture(hostRoot);
    const manager = createObservabilityManager({
      dataRoot,
      hostRoot,
      clock: () => current,
      dockerInspect: async () => ({
        RestartCount: 2,
        Config: { Env: ['TOKEN=must-not-leak'], Labels: { secret: 'must-not-leak' } },
        Mounts: [{ Source: '/private/path' }],
        State: {
          Status: 'running', Running: true, OOMKilled: false, ExitCode: 0,
          StartedAt: '2026-08-15T09:00:00.000Z', FinishedAt: '0001-01-01T00:00:00Z',
          Health: {
            Log: [{
              Start: '2026-08-15T09:59:00.000Z', End: '2026-08-15T09:59:01.000Z',
              ExitCode: 0, Output: 'ok token=must-not-leak'
            }]
          }
        }
      }),
      dockerStats: async () => ({
        read: current.toISOString(),
        cpu_stats: { online_cpus: 1, system_cpu_usage: 200, cpu_usage: { total_usage: 100 } },
        precpu_stats: { system_cpu_usage: 100, cpu_usage: { total_usage: 50 } },
        memory_stats: { usage: 500, limit: 1_000, stats: { inactive_file: 0 } },
        networks: {}, blkio_stats: {}, pids_stats: { current: 2 }
      }),
      dockerLogs: async () => multiplex(
        1,
        '2026-08-15T10:00:00.000Z ready password=must-not-leak\n'
      ),
      getApplicationInventory: async () => ({ applications: [application] }),
      notificationManager: {
        create: (notification) => created.push(notification),
        resolveByDedupeKey: (notification) => resolved.push(notification)
      }
    });

    await manager.refresh();
    assert.equal(manager.overview().history.length, 1);
    assert.deepEqual(manager.overview().applications, {
      total: 1, running: 1, stopped: 0, transitioning: 0, error: 0
    });
    assert.equal(manager.overview().recentEvents.length, 0);
    assert.equal(fs.statSync(manager.paths.stateFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(manager.paths.stateFile)).mode & 0o777, 0o700);

    current = new Date('2026-08-15T10:01:00.000Z');
    application = applicationFixture({ state: 'exited', healthStatus: 'unhealthy' });
    writeHostFixture(hostRoot, { cpuIdle: 750, rx: 2_000, tx: 3_000 });
    await manager.refresh();
    assert.equal(manager.overview().recentEvents.some((event) => event.type === 'state-changed'), true);
    assert.equal(created.filter((notification) => notification.category === 'application-health').length, 1);
    const applicationNotification = created.find((notification) => notification.category === 'application-health');
    assert.equal(applicationNotification.source, 'observability');
    assert.equal(applicationNotification.sensitive, true);
    assert.deepEqual(applicationNotification.target, { app: 'settings', tab: 'observability' });

    current = new Date('2026-08-15T10:02:00.000Z');
    writeHostFixture(hostRoot, { cpuIdle: 800, rx: 3_000, tx: 4_000 });
    await manager.refresh();
    assert.equal(created.filter((notification) => notification.category === 'host-health').length, 1);
    assert.equal(created.filter((notification) => notification.category === 'application-health').length, 1);
    assert.equal(manager.overview().activeAlerts.length, 2);

    application = applicationFixture();
    current = new Date('2026-08-15T10:03:00.000Z');
    writeHostFixture(hostRoot, { availableKb: 800_000, cpuIdle: 850 });
    await manager.refresh();
    assert.equal(resolved.length, 2);
    assert.equal(manager.overview().activeAlerts.length, 0);

    const details = await manager.application(application.id);
    assert.equal(details.runtime.restartCount, 2);
    assert.equal(details.metrics.cpu.usagePercent, 50);
    assert.match(details.runtime.healthChecks[0].output, /token=\[redacted\]/);
    assert.equal(JSON.stringify(details).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(details).includes('/private/path'), false);

    const logs = await manager.applicationLogs(application.id, { tail: 100 });
    assert.equal(logs.persisted, false);
    assert.match(logs.entries[0].message, /password=\[redacted\]/);
    assert.equal(JSON.stringify(logs).includes('must-not-leak'), false);

    const diagnostics = await manager.diagnostics(application.id);
    assert.equal(diagnostics.redacted, true);
    assert.equal(JSON.stringify(diagnostics).includes('TOKEN='), false);
    assert.equal(JSON.stringify(diagnostics).includes('/private/path'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applications without an exact runtime expose truthful unsupported log and metric capabilities', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-observability-'));
  const dataRoot = path.join(root, 'data');
  const hostRoot = path.join(root, 'host');
  try {
    writeHostFixture(hostRoot, { availableKb: 900_000 });
    const application = {
      id: 'host-service-example',
      name: 'Host Service',
      runtime: { containerId: null, state: 'running', operationalState: 'running', healthStatus: null }
    };
    const manager = createObservabilityManager({
      dataRoot,
      hostRoot,
      dockerInspect: async () => { throw new Error('must not inspect'); },
      dockerStats: async () => { throw new Error('must not read stats'); },
      dockerLogs: async () => { throw new Error('must not read logs'); },
      getApplicationInventory: async () => ({ applications: [application] })
    });
    await manager.refresh();
    const details = await manager.application(application.id);
    assert.equal(details.runtime, null);
    assert.equal(details.capabilities.metrics, false);
    assert.equal(details.capabilities.logs, false);
    assert.deepEqual((await manager.applicationLogs(application.id)).entries, []);
    await assert.rejects(
      manager.application('missing'),
      (error) => error.code === 'observability-application-not-found' && error.statusCode === 404
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('notification adapter failures never block samples and are retried without exposing provider text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-observability-'));
  const dataRoot = path.join(root, 'data');
  const hostRoot = path.join(root, 'host');
  const errors = [];
  let attempts = 0;
  try {
    writeHostFixture(hostRoot, { availableKb: 900_000 });
    const manager = createObservabilityManager({
      dataRoot,
      hostRoot,
      dockerInspect: async () => ({}),
      dockerStats: async () => ({}),
      dockerLogs: async () => Buffer.alloc(0),
      getApplicationInventory: async () => ({
        applications: [applicationFixture({ state: 'exited', healthStatus: 'unhealthy' })]
      }),
      notificationManager: {
        create: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('provider secret response');
        },
        resolveByDedupeKey: () => {}
      },
      onError: (error) => errors.push({ code: error.code, message: error.message })
    });
    await manager.refresh();
    await manager.refresh();
    const persisted = JSON.parse(fs.readFileSync(manager.paths.stateFile, 'utf8'));
    assert.equal(persisted.hostSamples.length, 2);
    assert.equal(attempts, 2);
    assert.equal(persisted.alerts.find((alert) => alert.scope === 'application').notificationPending, false);
    assert.deepEqual(errors.map((error) => error.code), ['observability-notification-delivery-failed']);
    assert.equal(JSON.stringify(errors).includes('provider secret response'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
