const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ApplicationObservabilityError,
  METRIC_SAMPLE_INTERVAL_MS,
  createApplicationObservabilityManager,
  logLinesFromDockerBuffer,
  logLinesFromJournal,
  metricsFromStats,
  metricsFromSystemdProperties,
  normalizedLogTail,
  parseSystemdProperties,
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

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.available, true);
  assert.equal(result.runtime.engine, 'docker');
  assert.equal(result.health.operationalState, 'running');
  assert.equal(result.health.restartCount, 4);
  assert.equal(result.metrics.available, true);
  assert.equal(result.metrics.source, 'docker');
  assert.equal(result.metrics.history.length, 1);
  assert.equal(result.metrics.historyPolicy.minimumIntervalSeconds, 300);
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
  const metricHistoryDirectory = path.join(testFixture.root, 'observability', 'metric-history');
  assert.equal(fs.statSync(metricHistoryDirectory).mode & 0o777, 0o700);
  const metricRecordPath = path.join(metricHistoryDirectory, fs.readdirSync(metricHistoryDirectory)[0]);
  assert.equal(fs.statSync(metricRecordPath).mode & 0o777, 0o600);
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

test('metric history persists no more than one sample per controlled interval', async () => {
  const testFixture = fixture();
  await testFixture.manager.observe(application().id);
  testFixture.setNow(Date.parse('2026-08-12T12:04:59.999Z'));
  await testFixture.manager.observe(application().id);
  assert.equal(testFixture.manager.readMetricHistory(application().id).length, 1);

  testFixture.setNow(Date.parse('2026-08-12T12:00:00.000Z') + METRIC_SAMPLE_INTERVAL_MS);
  await testFixture.manager.observe(application().id);
  assert.equal(testFixture.manager.readMetricHistory(application().id).length, 2);
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

test('host services resolve the exact Registry unit before reading bounded systemd metrics and journal logs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-host-observability-'));
  let now = Date.parse('2026-08-12T12:00:00.000Z');
  let cpuUsage = 1_000_000_000n;
  const hostApplication = {
    id: 'res_' + '2'.repeat(32),
    name: 'Example Service',
    installation: { state: 'host-service' },
    runtime: {
      engine: 'systemd',
      serviceUnit: 'example.service',
      state: 'running',
      status: 'active:running',
      healthStatus: 'active',
      operationalState: 'running'
    }
  };
  const observations = [];
  let dockerReads = 0;
  const manager = createApplicationObservabilityManager({
    dataRoot: root,
    clock: () => now,
    getApplicationInventory: async () => ({ applications: [hostApplication] }),
    getHostServiceSettings: (resourceId) => ({
      resourceId,
      engine: 'systemd',
      unit: 'example.service'
    }),
    hostServiceObservation: async (operation, unit, options) => {
      observations.push({ operation, unit, options });
      if (operation === 'properties') {
        return {
          success: true,
          output: [
            'ActiveState=active',
            'SubState=running',
            'Result=success',
            'NRestarts=4',
            'ExecMainStatus=0',
            `CPUUsageNSec=${cpuUsage}`,
            'MemoryCurrent=52428800',
            'EffectiveMemoryMax=104857600',
            'TasksCurrent=12',
            'TasksMax=100',
            'IPIngressBytes=[not set]',
            'IPEgressBytes=[not set]',
            'IOReadBytes=4096',
            'IOWriteBytes=8192'
          ].join('\n')
        };
      }
      return {
        success: true,
        output: [
          JSON.stringify({
            __REALTIME_TIMESTAMP: '1786535998000000',
            PRIORITY: '6',
            MESSAGE: 'ready'
          }),
          JSON.stringify({
            __REALTIME_TIMESTAMP: '1786535999000000',
            PRIORITY: '3',
            MESSAGE: 'api_token=must-not-leak'
          })
        ].join('\n')
      };
    },
    dockerRequest: async () => { dockerReads += 1; throw new Error('Docker must not be read'); },
    dockerRawRequest: async () => { dockerReads += 1; throw new Error('Docker must not be read'); }
  });

  const first = await manager.observe(hostApplication.id, { tail: 120 });
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.runtime.engine, 'systemd');
  assert.equal(first.available, true);
  assert.equal(first.health.operationalState, 'running');
  assert.equal(first.health.restartCount, 4);
  assert.equal(first.metrics.source, 'systemd');
  assert.equal(first.metrics.sample.cpuPercent, null);
  assert.equal(first.metrics.sample.memoryUsageBytes, 52_428_800);
  assert.equal(first.metrics.sample.memoryPercent, 50);
  assert.equal(first.metrics.sample.networkRxBytes, null);
  assert.equal(first.metrics.sample.blockWriteBytes, 8192);
  assert.equal(first.logs.source, 'journal');
  assert.equal(first.logs.lines[0].message, 'ready');
  assert.equal(first.logs.lines[1].stream, 'stderr');
  assert.equal(first.logs.lines[1].message, 'api_token=[REDACTED]');
  assert.equal(JSON.stringify(first).includes('must-not-leak'), false);
  assert.equal(first.alerts.some((alert) => alert.code === 'service-restarts'), true);
  assert.deepEqual(observations.map(({ operation, unit, options }) => ({
    operation,
    unit,
    tail: options.tail
  })), [
    { operation: 'properties', unit: 'example.service', tail: 120 },
    { operation: 'journal', unit: 'example.service', tail: 120 }
  ]);
  assert.equal(dockerReads, 0);

  now += 15_000;
  cpuUsage += 7_500_000_000n;
  const second = await manager.observe(hostApplication.id, { tail: 120 });
  assert.equal(second.metrics.sample.cpuPercent, 50);
  assert.equal(manager.readMetricHistory(hostApplication.id).length, 1);
});

test('host service unit drift fails before a host or Docker observation can run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-host-observability-drift-'));
  let observations = 0;
  const current = {
    id: 'res_' + '3'.repeat(32),
    installation: { state: 'host-service' },
    runtime: {
      engine: 'systemd',
      serviceUnit: 'stale.service',
      state: 'running',
      operationalState: 'running'
    }
  };
  const manager = createApplicationObservabilityManager({
    dataRoot: root,
    getApplicationInventory: async () => ({ applications: [current] }),
    getHostServiceSettings: () => ({
      resourceId: current.id,
      unit: 'current.service'
    }),
    hostServiceObservation: async () => { observations += 1; },
    dockerRequest: async () => { observations += 1; },
    dockerRawRequest: async () => { observations += 1; }
  });
  await assert.rejects(
    manager.observe(current.id),
    (error) => error instanceof ApplicationObservabilityError && error.code === 'application-runtime-drift'
  );
  assert.equal(observations, 0);
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

test('systemd property and journal parsers retain only bounded operational fields', () => {
  const properties = parseSystemdProperties([
    'ActiveState=active',
    'MemoryCurrent=512',
    'EffectiveMemoryMax=[not set]',
    'MemoryMax=1024',
    'TasksCurrent=7',
    'TasksMax=18446744073709551615',
    'IPIngressBytes=2048',
    'IPEgressBytes=4096',
    'IOReadBytes=8192',
    'IOWriteBytes=16384',
    'invalid-name=value'
  ].join('\n'));
  const metrics = metricsFromSystemdProperties(
    properties,
    '2026-08-12T12:00:00.000Z',
    12.345
  );
  assert.equal(properties['invalid-name'], undefined);
  assert.equal(metrics.cpuPercent, 12.35);
  assert.equal(metrics.memoryPercent, 50);
  assert.equal(metrics.pids, 7);
  assert.equal(metrics.pidsLimit, null);
  assert.equal(metrics.networkRxBytes, 2048);

  const journal = logLinesFromJournal([
    JSON.stringify({
      __REALTIME_TIMESTAMP: '1786536000000000',
      PRIORITY: '6',
      MESSAGE: '\u001b[32mstarted\u001b[0m'
    }),
    JSON.stringify({
      __REALTIME_TIMESTAMP: '1786536001000000',
      PRIORITY: '3',
      MESSAGE: `credential=${'x'.repeat(80)}`
    }),
    JSON.stringify({
      __REALTIME_TIMESTAMP: '1786536002000000',
      PRIORITY: '6',
      MESSAGE: [0, 1, 2]
    })
  ].join('\n'), 20);
  assert.equal(journal.lines.length, 2);
  assert.equal(journal.lines[0].message, 'started');
  assert.equal(journal.lines[1].stream, 'stderr');
  assert.equal(journal.lines[1].message, 'credential=[REDACTED]');
  assert.equal(journal.omittedEntries, 1);
  assert.equal(journal.truncated, false);
  assert.equal(journal.redacted, true);
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
