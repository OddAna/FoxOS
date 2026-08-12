const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ApplicationObservabilityError,
  createApplicationObservabilityManager,
  logLinesFromDockerBuffer,
  metricsFromStats,
  normalizedLogTail,
  redactLogLine
} = require('./applicationObservabilityManager');

const containerId = 'a'.repeat(64);

function dockerFrame(streamType, text) {
  const body = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function application(state = 'running', healthStatus = 'healthy') {
  return {
    id: 'res_' + '1'.repeat(32),
    name: 'Example App',
    installation: { state: 'runtime-present' },
    runtime: {
      containerId,
      state,
      status: state === 'running' ? 'Up 5 minutes (healthy)' : 'Exited (1)',
      healthStatus,
      exitCode: state === 'running' ? null : 1,
      operationalState: state === 'running' ? 'running' : 'error'
    }
  };
}

function fixture({ currentApplication = application() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-observability-'));
  let now = Date.parse('2026-08-12T12:00:00.000Z');
  const details = {
    Id: containerId,
    RestartCount: 4,
    Config: { Env: ['API_TOKEN=must-not-leak'], Labels: {} },
    HostConfig: { PidsLimit: 100, Memory: 1000 },
    State: {
      Status: currentApplication.runtime.state,
      Health: currentApplication.runtime.healthStatus
        ? { Status: currentApplication.runtime.healthStatus }
        : null,
      ExitCode: currentApplication.runtime.exitCode || 0,
      OOMKilled: false,
      StartedAt: '2026-08-12T11:55:00.000Z',
      FinishedAt: '0001-01-01T00:00:00Z'
    }
  };
  const stats = {
    read: '2026-08-12T12:00:00.000Z',
    cpu_stats: {
      cpu_usage: { total_usage: 300, percpu_usage: [150, 150] },
      system_cpu_usage: 2000,
      online_cpus: 2
    },
    precpu_stats: {
      cpu_usage: { total_usage: 200 },
      system_cpu_usage: 1000
    },
    memory_stats: {
      usage: 950,
      limit: 1000,
      stats: { inactive_file: 50 }
    },
    networks: {
      eth0: { rx_bytes: 1000, tx_bytes: 2000 },
      foxos: { rx_bytes: 3000, tx_bytes: 4000 }
    },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: 4096 },
        { op: 'Write', value: 8192 }
      ]
    },
    pids_stats: { current: 90 }
  };
  const rawLogs = Buffer.concat([
    dockerFrame(1, '2026-08-12T11:59:58.000000000Z ready\n'),
    dockerFrame(2, '2026-08-12T11:59:59.000000000Z API_TOKEN=must-not-leak\n')
  ]);
  const dockerRequests = [];
  const manager = createApplicationObservabilityManager({
    dataRoot: root,
    clock: () => now,
    getApplicationInventory: async () => ({ applications: [currentApplication] }),
    dockerRequest: async (method, requestPath) => {
      dockerRequests.push({ method, requestPath });
      if (requestPath.endsWith('/json')) return details;
      if (requestPath.includes('/stats?')) return stats;
      throw new Error('unexpected Docker JSON request');
    },
    dockerRawRequest: async (method, requestPath, payload, options) => {
      dockerRequests.push({ method, requestPath, payload, options });
      return rawLogs;
    }
  });
  return {
    details,
    dockerRequests,
    manager,
    root,
    setNow(value) { now = value; }
  };
}

test('Docker observability returns bounded redacted logs, live metrics, history and actionable alerts', async () => {
  const testFixture = fixture();
  const result = await testFixture.manager.observe(application().id, { tail: 120 });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.available, true);
  assert.equal(result.health.operationalState, 'running');
  assert.equal(result.health.restartCount, 4);
  assert.equal(result.metrics.available, true);
  assert.equal(result.metrics.sample.cpuPercent, 20);
  assert.equal(result.metrics.sample.memoryUsageBytes, 900);
  assert.equal(result.metrics.sample.memoryPercent, 90);
  assert.equal(result.metrics.sample.networkRxBytes, 4000);
  assert.equal(result.metrics.sample.networkTxBytes, 6000);
  assert.equal(result.metrics.sample.blockReadBytes, 4096);
  assert.equal(result.metrics.sample.blockWriteBytes, 8192);
  assert.equal(result.metrics.sample.pids, 90);
  assert.equal(result.logs.lines.length, 2);
  assert.equal(result.logs.lines[0].message, 'ready');
  assert.equal(result.logs.lines[1].stream, 'stderr');
  assert.equal(result.logs.lines[1].message, 'API_TOKEN=[REDACTED]');
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(result.logs.redacted, true);
  assert.equal(result.alerts.some((alert) => alert.code === 'memory-pressure'), true);
  assert.equal(result.alerts.some((alert) => alert.code === 'pid-pressure'), true);
  assert.equal(result.alerts.some((alert) => alert.code === 'container-restarts'), true);

  testFixture.setNow(Date.parse('2026-08-12T12:05:00.000Z'));
  testFixture.manager.recordInventory({ applications: [application()] });
  assert.equal(testFixture.manager.readHistory(application().id).length, 1);

  const historyFile = path.join(testFixture.root, 'observability', 'health-history');
  assert.equal(fs.statSync(historyFile).mode & 0o777, 0o700);
  const recordPath = path.join(historyFile, fs.readdirSync(historyFile)[0]);
  assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
});

test('unchanged health is heartbeat-bounded while state transitions persist immediately', () => {
  const testFixture = fixture();
  const current = application();
  testFixture.manager.recordInventory({ applications: [current] });
  testFixture.setNow(Date.parse('2026-08-12T12:05:00.000Z'));
  testFixture.manager.recordInventory({ applications: [current] });
  assert.equal(testFixture.manager.readHistory(current.id).length, 1);

  current.runtime.state = 'exited';
  current.runtime.status = 'Exited (1)';
  current.runtime.healthStatus = null;
  current.runtime.exitCode = 1;
  current.runtime.operationalState = 'error';
  testFixture.manager.recordInventory({ applications: [current] });
  const history = testFixture.manager.readHistory(current.id);
  assert.equal(history.length, 2);
  assert.equal(history.at(-1).operationalState, 'error');

  testFixture.setNow(Date.parse('2026-08-12T12:21:00.000Z'));
  testFixture.manager.recordInventory({ applications: [current] });
  assert.equal(testFixture.manager.readHistory(current.id).length, 3);
});

test('inactive definitions expose health history without attempting arbitrary Docker reads', async () => {
  const inactive = application('exited', null);
  inactive.runtime.containerId = null;
  inactive.runtime.state = 'stopped';
  inactive.runtime.status = 'Kurulu tanım pasif';
  inactive.runtime.operationalState = 'stopped';
  inactive.installation.state = 'inactive-definition';
  const testFixture = fixture({ currentApplication: inactive });
  const result = await testFixture.manager.observe(inactive.id);

  assert.equal(result.available, false);
  assert.equal(result.logs.available, false);
  assert.equal(result.metrics.available, false);
  assert.equal(result.health.operationalState, 'stopped');
  assert.equal(testFixture.dockerRequests.length, 0);
});

test('application identity and log tail are fail-closed', async () => {
  const testFixture = fixture();
  await assert.rejects(
    testFixture.manager.observe('missing', { tail: 120 }),
    (error) => error instanceof ApplicationObservabilityError && error.code === 'application-not-found'
  );
  assert.throws(() => normalizedLogTail(501), /20-500/);
  assert.equal(normalizedLogTail(undefined), 160);
});

test('Docker log framing falls back to TTY text and strips controls while preserving timestamps', () => {
  const raw = Buffer.from(
    '2026-08-12T12:00:00.000000000Z \u001b[31mfailed\u001b[0m token=secret-value\u0000\n',
    'utf8'
  );
  const parsed = logLinesFromDockerBuffer(raw, 20);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].timestamp, '2026-08-12T12:00:00.000000000Z');
  assert.equal(parsed.lines[0].message, 'failed token=[REDACTED]');
  assert.equal(parsed.redacted, true);
});

test('secret redaction and metric normalization do not return raw credential values', () => {
  const redacted = redactLogLine(
    'Authorization: Bearer abcdefghijklmnop https://owner:password@example.test sk-1234567890abcdefghijkl'
  );
  assert.equal(redacted.text.includes('abcdefghijklmnop'), false);
  assert.equal(redacted.text.includes('password@example'), false);
  assert.equal(redacted.text.includes('sk-1234567890abcdefghijkl'), false);

  const metrics = metricsFromStats({ memory_stats: {}, pids_stats: {} }, { HostConfig: {} });
  assert.equal(metrics.cpuPercent, 0);
  assert.equal(metrics.memoryUsageBytes, 0);
  assert.equal(metrics.pidsLimit, null);
});

test('multi-line private keys and long opaque values are removed from Docker logs', () => {
  const privateMaterial = 'A'.repeat(72);
  const paddedOpaqueValue = 'c'.repeat(64) + '==';
  const raw = Buffer.from([
    '2026-08-12T12:00:00Z -----BEGIN PRIVATE KEY-----',
    `2026-08-12T12:00:01Z ${privateMaterial}`,
    '2026-08-12T12:00:02Z -----END PRIVATE KEY-----',
    `2026-08-12T12:00:03Z opaque=${'b'.repeat(80)}`,
    `2026-08-12T12:00:04Z padded=${paddedOpaqueValue}`
  ].join('\n'));
  const parsed = logLinesFromDockerBuffer(raw, 20);
  assert.equal(JSON.stringify(parsed).includes(privateMaterial), false);
  assert.equal(JSON.stringify(parsed).includes('b'.repeat(80)), false);
  assert.equal(JSON.stringify(parsed).includes(paddedOpaqueValue), false);
  assert.deepEqual(parsed.lines.slice(0, 3).map((line) => line.message), [
    '[REDACTED PRIVATE KEY MATERIAL]',
    '[REDACTED PRIVATE KEY MATERIAL]',
    '[REDACTED PRIVATE KEY MATERIAL]'
  ]);
  assert.equal(parsed.lines[3].message, 'opaque=[REDACTED LONG VALUE]');
  assert.equal(parsed.lines[4].message, 'padded=[REDACTED LONG VALUE]');
});
