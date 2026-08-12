const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { operationalStateForRuntime } = require('./applicationInventory');
const { atomicWriteJson } = require('./resourceRegistry');

const OBSERVABILITY_SCHEMA_VERSION = 2;
const HISTORY_SCHEMA_VERSION = 1;
const METRIC_HISTORY_SCHEMA_VERSION = 1;
const DEFAULT_LOG_TAIL = 160;
const MIN_LOG_TAIL = 20;
const MAX_LOG_TAIL = 500;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_STATS_BYTES = 2 * 1024 * 1024;
const MAX_LOG_LINE_LENGTH = 4096;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_HISTORY_SAMPLES = 1024;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_HEARTBEAT_MS = 15 * 60 * 1000;
const MAX_METRIC_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_METRIC_HISTORY_SAMPLES = 2048;
const MAX_RETURNED_METRIC_SAMPLES = 288;
const METRIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const METRIC_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*\.service$/;
const SYSTEMD_UNLIMITED_VALUE = 2n ** 64n - 1n;

class ApplicationObservabilityError extends Error {
  constructor(message, statusCode = 400, code = 'application-observability-invalid') {
    super(message);
    this.name = 'ApplicationObservabilityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizedLogTail(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LOG_TAIL;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_LOG_TAIL || parsed > MAX_LOG_TAIL) {
    throw new ApplicationObservabilityError(
      `Log satırı ${MIN_LOG_TAIL}-${MAX_LOG_TAIL} arasında olmalıdır.`,
      400,
      'application-observability-tail-invalid'
    );
  }
  return parsed;
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function systemdInteger(value) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  try {
    const parsed = BigInt(normalized);
    if (parsed < 0n || parsed >= SYSTEMD_UNLIMITED_VALUE || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return Number(parsed);
  } catch {
    return null;
  }
}

function systemdBigInt(value) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  try {
    const parsed = BigInt(normalized);
    return parsed >= 0n && parsed < SYSTEMD_UNLIMITED_VALUE ? parsed : null;
  } catch {
    return null;
  }
}

function parseSystemdProperties(value) {
  const properties = {};
  for (const line of String(value || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) continue;
    properties[name] = line.slice(separator + 1).slice(0, 4096);
  }
  return properties;
}

function metricsFromSystemdProperties(properties, collectedAt, cpuPercent = null) {
  if (!properties || typeof properties !== 'object') return null;
  const memoryUsageBytes = systemdInteger(properties.MemoryCurrent);
  const effectiveMemoryLimit = systemdInteger(properties.EffectiveMemoryMax);
  const memoryLimitBytes = effectiveMemoryLimit === null
    ? systemdInteger(properties.MemoryMax)
    : effectiveMemoryLimit;
  const pids = systemdInteger(properties.TasksCurrent);
  const pidsLimit = systemdInteger(properties.TasksMax);
  const networkRxBytes = systemdInteger(properties.IPIngressBytes);
  const networkTxBytes = systemdInteger(properties.IPEgressBytes);
  const blockReadBytes = systemdInteger(properties.IOReadBytes);
  const blockWriteBytes = systemdInteger(properties.IOWriteBytes);
  const hasMetric = [
    memoryUsageBytes,
    memoryLimitBytes,
    pids,
    pidsLimit,
    networkRxBytes,
    networkTxBytes,
    blockReadBytes,
    blockWriteBytes,
    Number.isFinite(cpuPercent) ? cpuPercent : null
  ].some((entry) => entry !== null);
  if (!hasMetric) return null;
  return {
    collectedAt,
    cpuPercent: Number.isFinite(cpuPercent) ? rounded(Math.max(0, cpuPercent)) : null,
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent: memoryUsageBytes !== null && memoryLimitBytes > 0
      ? rounded(memoryUsageBytes / memoryLimitBytes * 100)
      : null,
    networkRxBytes,
    networkTxBytes,
    blockReadBytes,
    blockWriteBytes,
    pids,
    pidsLimit: pidsLimit > 0 ? pidsLimit : null
  };
}

function metricsFromStats(stats, details, collectedAt = null) {
  if (!stats || typeof stats !== 'object') return null;
  const cpuStats = stats.cpu_stats || {};
  const previousCpuStats = stats.precpu_stats || {};
  const cpuUsage = cpuStats.cpu_usage || {};
  const previousCpuUsage = previousCpuStats.cpu_usage || {};
  const cpuDelta = finiteNumber(cpuUsage.total_usage) - finiteNumber(previousCpuUsage.total_usage);
  const systemDelta = finiteNumber(cpuStats.system_cpu_usage) - finiteNumber(previousCpuStats.system_cpu_usage);
  const onlineCpus = Math.max(
    1,
    finiteNumber(cpuStats.online_cpus) ||
      (Array.isArray(cpuUsage.percpu_usage) ? cpuUsage.percpu_usage.length : 0) ||
      1
  );
  const cpuPercent = cpuDelta > 0 && systemDelta > 0
    ? cpuDelta / systemDelta * onlineCpus * 100
    : 0;

  const memory = stats.memory_stats || {};
  const memoryDetails = memory.stats || {};
  const memoryCache = finiteNumber(
    memoryDetails.inactive_file === undefined ? memoryDetails.cache : memoryDetails.inactive_file
  );
  const rawMemoryUsage = finiteNumber(memory.usage);
  const memoryUsageBytes = Math.max(0, rawMemoryUsage - Math.min(rawMemoryUsage, memoryCache));
  const configuredMemoryLimit = finiteNumber(
    details && details.HostConfig && details.HostConfig.Memory
  );
  const memoryLimitBytes = configuredMemoryLimit > 0 ? configuredMemoryLimit : 0;
  const memoryPercent = memoryLimitBytes > 0 ? memoryUsageBytes / memoryLimitBytes * 100 : 0;

  let networkRxBytes = 0;
  let networkTxBytes = 0;
  for (const network of Object.values(stats.networks || {})) {
    networkRxBytes += Math.max(0, finiteNumber(network && network.rx_bytes));
    networkTxBytes += Math.max(0, finiteNumber(network && network.tx_bytes));
  }

  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  const ioEntries = stats.blkio_stats && stats.blkio_stats.io_service_bytes_recursive;
  for (const entry of Array.isArray(ioEntries) ? ioEntries : []) {
    const operation = String(entry && entry.op || '').toLowerCase();
    if (operation === 'read') blockReadBytes += Math.max(0, finiteNumber(entry.value));
    if (operation === 'write') blockWriteBytes += Math.max(0, finiteNumber(entry.value));
  }

  const pids = Math.max(0, finiteNumber(stats.pids_stats && stats.pids_stats.current));
  const configuredPidsLimit = finiteNumber(details && details.HostConfig && details.HostConfig.PidsLimit);

  return {
    collectedAt: collectedAt || (
      typeof stats.read === 'string' && Number.isFinite(Date.parse(stats.read))
        ? stats.read
        : new Date().toISOString()
    ),
    cpuPercent: rounded(Math.max(0, cpuPercent)),
    memoryUsageBytes: Math.round(memoryUsageBytes),
    memoryLimitBytes: Math.round(memoryLimitBytes),
    memoryPercent: rounded(Math.max(0, memoryPercent)),
    networkRxBytes: Math.round(networkRxBytes),
    networkTxBytes: Math.round(networkTxBytes),
    blockReadBytes: Math.round(blockReadBytes),
    blockWriteBytes: Math.round(blockWriteBytes),
    pids: Math.round(pids),
    pidsLimit: configuredPidsLimit > 0 ? Math.round(configuredPidsLimit) : null
  };
}

function stripUnsafeLogCharacters(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�')
    .slice(0, MAX_LOG_LINE_LENGTH);
}

function redactLogLine(value, knownSensitiveValues = []) {
  let text = stripUnsafeLogCharacters(value);
  let redactionCount = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      redactionCount += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };

  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(text)) {
    return { text: '[REDACTED PRIVATE KEY]', redactionCount: 1 };
  }
  for (const sensitiveValue of [...new Set(knownSensitiveValues)]
    .filter((entry) => typeof entry === 'string' && entry.length >= 4)
    .sort((left, right) => right.length - left.length)) {
    if (!text.includes(sensitiveValue)) continue;
    redactionCount += text.split(sensitiveValue).length - 1;
    text = text.split(sensitiveValue).join('[REDACTED]');
  }
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]');
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]');
  replace(
    /\b((?:[a-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|session|cookie|credential|private[_-]?key)(?:[_-][a-z0-9]+)*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (match, label, separator) => `${label}${separator}[REDACTED]`
  );
  replace(
    /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi,
    (match, prefix, credential, suffix) => `${prefix}[REDACTED]${suffix}`
  );
  replace(/\b[A-Za-z0-9+/_-]{64,}={0,2}(?![A-Za-z0-9+/_=-])/g, '[REDACTED LONG VALUE]');

  return { text, redactionCount };
}

function rawDockerLogFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return [];
  const frames = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const headerValid = [0, 1, 2].includes(streamType) &&
      buffer[offset + 1] === 0 && buffer[offset + 2] === 0 && buffer[offset + 3] === 0;
    if (!headerValid) return [{ stream: 'combined', body: buffer.toString('utf8') }];
    const length = buffer.readUInt32BE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + length;
    if (bodyEnd > buffer.length) return [{ stream: 'combined', body: buffer.toString('utf8') }];
    frames.push({
      stream: streamType === 2 ? 'stderr' : 'stdout',
      body: buffer.subarray(bodyStart, bodyEnd).toString('utf8')
    });
    offset = bodyEnd;
  }
  if (offset !== buffer.length || !frames.length) {
    return [{ stream: 'combined', body: buffer.toString('utf8') }];
  }
  return frames;
}

function logLinesFromDockerBuffer(buffer, tail, knownSensitiveValues = []) {
  const lines = [];
  let redactionCount = 0;
  let insidePrivateKey = false;
  for (const frame of rawDockerLogFrames(buffer)) {
    for (const rawLine of frame.body.split(/\r?\n/)) {
      if (!rawLine) continue;
      const timestampMatch = rawLine.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s(.*)$/s);
      const message = timestampMatch ? timestampMatch[2] : rawLine;
      const beginsPrivateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(message);
      const endsPrivateKey = /-----END [A-Z0-9 ]*PRIVATE KEY-----/i.test(message);
      const redactPrivateKeyMaterial = insidePrivateKey || beginsPrivateKey;
      const redacted = redactPrivateKeyMaterial
        ? { text: '[REDACTED PRIVATE KEY MATERIAL]', redactionCount: 1 }
        : redactLogLine(message, knownSensitiveValues);
      if (beginsPrivateKey && !endsPrivateKey) insidePrivateKey = true;
      if (insidePrivateKey && endsPrivateKey) insidePrivateKey = false;
      redactionCount += redacted.redactionCount;
      lines.push({
        timestamp: timestampMatch ? timestampMatch[1] : null,
        stream: frame.stream,
        message: redacted.text
      });
    }
  }
  const truncated = lines.length > tail || (Buffer.isBuffer(buffer) && buffer.length >= MAX_LOG_BYTES);
  return {
    lines: lines.slice(-tail),
    truncated,
    redacted: redactionCount > 0,
    redactionCount
  };
}

function journalTimestamp(value) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d{10,20}$/.test(normalized)) return null;
  try {
    const milliseconds = Number(BigInt(normalized) / 1000n);
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

function logLinesFromJournal(value, tail, commandTruncated = false) {
  const lines = [];
  let redactionCount = 0;
  let insidePrivateKey = false;
  let invalidEntries = 0;
  const rawEntries = String(value || '').split(/\r?\n/).filter(Boolean);
  for (const rawEntry of rawEntries) {
    let entry;
    try {
      entry = JSON.parse(rawEntry);
    } catch {
      invalidEntries += 1;
      continue;
    }
    if (!entry || typeof entry.MESSAGE !== 'string') {
      invalidEntries += 1;
      continue;
    }
    const beginsPrivateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(entry.MESSAGE);
    const endsPrivateKey = /-----END [A-Z0-9 ]*PRIVATE KEY-----/i.test(entry.MESSAGE);
    const redactPrivateKeyMaterial = insidePrivateKey || beginsPrivateKey;
    const redacted = redactPrivateKeyMaterial
      ? { text: '[REDACTED PRIVATE KEY MATERIAL]', redactionCount: 1 }
      : redactLogLine(entry.MESSAGE);
    if (beginsPrivateKey && !endsPrivateKey) insidePrivateKey = true;
    if (insidePrivateKey && endsPrivateKey) insidePrivateKey = false;
    redactionCount += redacted.redactionCount;
    const priority = Number(entry.PRIORITY);
    lines.push({
      timestamp: journalTimestamp(entry.__REALTIME_TIMESTAMP),
      stream: Number.isInteger(priority) && priority <= 3 ? 'stderr' : 'journal',
      priority: Number.isInteger(priority) && priority >= 0 && priority <= 7 ? priority : null,
      message: redacted.text
    });
  }
  return {
    lines: lines.slice(-tail),
    truncated: commandTruncated || lines.length > tail,
    omittedEntries: invalidEntries,
    redacted: redactionCount > 0,
    redactionCount
  };
}

function sensitiveValuesFromDetails(details) {
  const values = [];
  const sensitiveName = /(?:^|[_-])(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key)(?:$|[_-])/i;
  for (const entry of details && details.Config && details.Config.Env || []) {
    const separator = typeof entry === 'string' ? entry.indexOf('=') : -1;
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (sensitiveName.test(name) && value.length >= 4 && value.length <= 8192) values.push(value);
  }
  for (const [name, rawValue] of Object.entries(
    details && details.Config && details.Config.Labels || {}
  )) {
    const value = typeof rawValue === 'string' ? rawValue : '';
    if (sensitiveName.test(name) && value.length >= 4 && value.length <= 8192) values.push(value);
  }
  return values;
}

function healthSample(application, details, observedAt) {
  const state = details && details.State || {};
  const runtime = application.runtime || {};
  const runtimeState = String(state.Status || runtime.state || 'unknown').toLowerCase();
  const healthStatus = state.Health && state.Health.Status || runtime.healthStatus || null;
  const canonicalOperationalState = ['running', 'stopped', 'transitioning', 'error']
    .includes(runtime.operationalState) ? runtime.operationalState : null;
  const operationalState = !details && canonicalOperationalState
    ? canonicalOperationalState
    : operationalStateForRuntime({
        state: runtimeState,
        status: runtime.status,
        healthStatus,
        intentionalStop: canonicalOperationalState === 'stopped'
      });
  return {
    observedAt,
    operationalState,
    state: runtimeState,
    healthStatus: healthStatus || null,
    restartCount: Number.isInteger(details && details.RestartCount) ? details.RestartCount : null,
    exitCode: runtimeState === 'running'
      ? null
      : Number.isInteger(state.ExitCode) ? state.ExitCode : runtime.exitCode,
    oomKilled: details ? state.OOMKilled === true : null,
    startedAt: state.StartedAt || null,
    finishedAt: state.FinishedAt || null
  };
}

function systemdHealthSample(application, properties, observedAt) {
  const runtime = application.runtime || {};
  const activeState = String(properties.ActiveState || runtime.healthStatus || '').toLowerCase();
  const subState = String(properties.SubState || '').toLowerCase();
  let operationalState = runtime.operationalState || 'stopped';
  if (activeState === 'failed' || subState === 'failed') operationalState = 'error';
  else if (activeState === 'active') operationalState = 'running';
  else if (['activating', 'deactivating', 'reloading'].includes(activeState)) {
    operationalState = 'transitioning';
  } else if (activeState) operationalState = 'stopped';
  const restartCount = systemdInteger(properties.NRestarts);
  const exitStatus = systemdInteger(properties.ExecMainStatus);
  const result = String(properties.Result || '').toLowerCase();
  return {
    observedAt,
    operationalState,
    state: operationalState === 'running'
      ? 'running'
      : operationalState === 'transitioning'
        ? activeState
        : activeState === 'failed' ? 'failed' : 'stopped',
    healthStatus: activeState || null,
    restartCount,
    exitCode: operationalState === 'running' ? null : exitStatus,
    oomKilled: /oom/.test(result)
      ? true
      : ['yes', 'no'].includes(String(properties.OOMKilled || '').toLowerCase())
        ? String(properties.OOMKilled).toLowerCase() === 'yes'
        : null,
    startedAt: null,
    finishedAt: null
  };
}

function sampleSignature(sample) {
  return JSON.stringify([
    sample.operationalState,
    sample.state,
    sample.healthStatus,
    sample.restartCount,
    sample.exitCode,
    sample.oomKilled
  ]);
}

function alertsFor(health, metrics, runtimeKind = 'container') {
  const alerts = [];
  const add = (code, severity, title, message) => alerts.push({ code, severity, title, message });
  const isService = runtimeKind === 'systemd';
  const subject = isService ? 'Servis' : 'Container';
  const codePrefix = isService ? 'service' : 'container';
  if (health.oomKilled) {
    add(`${codePrefix}-oom-killed`, 'critical', 'Bellek nedeniyle durduruldu', `${subject} son çalışmasında OOM ile kapandı. Bellek tüketimini ve limitini inceleyin.`);
  }
  if (health.healthStatus === 'unhealthy') {
    add(`${codePrefix}-unhealthy`, 'critical', 'Health check başarısız', 'Uygulama çalışıyor görünse de health check başarısız. Logları ve bağımlılıkları inceleyin.');
  } else if (health.operationalState === 'error') {
    add(`${codePrefix}-error`, 'critical', isService ? 'Servis hata durumunda' : 'Uygulama hata durumunda', 'Çalışma durumu hata gösteriyor. Son logları ve çıkış kodunu inceleyin.');
  } else if (health.state === 'restarting') {
    add(`${codePrefix}-restarting`, 'warning', 'Yeniden başlatma döngüsü', `${subject} yeniden başlatılıyor. Son loglarda başlangıç hatası arayın.`);
  } else if (!['running', 'transitioning'].includes(health.operationalState)) {
    add(`${codePrefix}-not-running`, 'warning', isService ? 'Servis çalışmıyor' : 'Uygulama çalışmıyor', `${subject} şu anda çalışmıyor. Bilinçli olarak durdurulmadıysa logları ve çıkış kodunu inceleyin.`);
  }
  if (Number.isInteger(health.restartCount) && health.restartCount >= 3) {
    add(`${codePrefix}-restarts`, 'warning', 'Tekrarlanan yeniden başlatmalar', `${subject} ${health.restartCount} kez yeniden başladı. Başlangıç kararlılığını inceleyin.`);
  }
  if (metrics) {
    if (metrics.cpuPercent >= 90) {
      add('cpu-pressure', 'warning', 'Yüksek CPU kullanımı', `Anlık CPU kullanımı %${metrics.cpuPercent}. Yükün kalıcı olup olmadığını izleyin.`);
    }
    if (metrics.memoryPercent >= 90) {
      add('memory-pressure', 'critical', 'Bellek limiti yaklaşıyor', `${subject} bellek limitinin %${metrics.memoryPercent} oranını kullanıyor.`);
    } else if (metrics.memoryPercent >= 80) {
      add('memory-pressure', 'warning', 'Bellek kullanımı yüksek', `${subject} bellek limitinin %${metrics.memoryPercent} oranını kullanıyor.`);
    }
    if (metrics.pidsLimit && metrics.pids / metrics.pidsLimit >= 0.85) {
      add('pid-pressure', 'critical', 'PID limiti yaklaşıyor', `${subject} ${metrics.pids}/${metrics.pidsLimit} process kullanıyor.`);
    }
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((left, right) => order[left.severity] - order[right.severity] || left.code.localeCompare(right.code));
}

function createApplicationObservabilityManager({
  dataRoot,
  dockerRequest,
  dockerRawRequest,
  getApplicationInventory,
  getHostServiceSettings = null,
  hostServiceObservation = null,
  clock = () => Date.now()
}) {
  if (!dataRoot || typeof dockerRequest !== 'function' || typeof dockerRawRequest !== 'function') {
    throw new Error('Application observability requires data, Docker JSON and Docker raw readers');
  }
  if (typeof getApplicationInventory !== 'function') {
    throw new Error('Application observability requires the canonical application inventory');
  }
  const historyRoot = path.join(dataRoot, 'observability', 'health-history');
  const metricHistoryRoot = path.join(dataRoot, 'observability', 'metric-history');
  const hostCpuBaselines = new Map();
  const metricHistoryPolicy = {
    minimumIntervalSeconds: METRIC_SAMPLE_INTERVAL_MS / 1000,
    retentionDays: METRIC_RETENTION_MS / (24 * 60 * 60 * 1000),
    maxStoredSamples: MAX_METRIC_HISTORY_SAMPLES,
    maxReturnedSamples: MAX_RETURNED_METRIC_SAMPLES
  };

  function stateFile(root, applicationId) {
    const digest = crypto.createHash('sha256').update(applicationId, 'utf8').digest('hex');
    return path.join(root, digest + '.json');
  }

  function historyFile(applicationId) {
    return stateFile(historyRoot, applicationId);
  }

  function metricHistoryFile(applicationId) {
    return stateFile(metricHistoryRoot, applicationId);
  }

  function readHistory(applicationId) {
    const file = historyFile(applicationId);
    if (!fs.existsSync(file)) return [];
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) throw new Error('invalid history');
      const record = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      if (
        !record || record.schemaVersion !== HISTORY_SCHEMA_VERSION ||
        record.applicationId !== applicationId || !Array.isArray(record.samples)
      ) return [];
      return record.samples.slice(-MAX_HISTORY_SAMPLES).filter((sample) => (
        sample && typeof sample.observedAt === 'string' && typeof sample.operationalState === 'string'
      ));
    } catch {
      return [];
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function recordSample(applicationId, sample) {
    const cutoff = clock() - HISTORY_RETENTION_MS;
    const samples = readHistory(applicationId).filter((entry) => {
      const timestamp = Date.parse(entry.observedAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    const previous = samples.at(-1) || null;
    const normalizedSample = previous ? { ...sample } : sample;
    if (previous) {
      for (const field of ['restartCount', 'oomKilled', 'startedAt', 'finishedAt']) {
        if (normalizedSample[field] === null && previous[field] !== null) {
          normalizedSample[field] = previous[field];
        }
      }
    }
    const previousTime = previous ? Date.parse(previous.observedAt) : 0;
    if (
      previous && sampleSignature(previous) === sampleSignature(normalizedSample) &&
      Number.isFinite(previousTime) && clock() - previousTime < HISTORY_HEARTBEAT_MS
    ) return samples;
    samples.push(normalizedSample);
    const retained = samples.slice(-MAX_HISTORY_SAMPLES);
    atomicWriteJson(historyFile(applicationId), {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      applicationId,
      updatedAt: normalizedSample.observedAt,
      samples: retained
    });
    return retained;
  }

  function safeMetricSample(sample, source) {
    if (!sample || !['docker', 'systemd'].includes(source)) return null;
    if (typeof sample.collectedAt !== 'string' || !Number.isFinite(Date.parse(sample.collectedAt))) {
      return null;
    }
    const normalized = { collectedAt: sample.collectedAt, source };
    const integerFields = [
      'memoryUsageBytes',
      'memoryLimitBytes',
      'networkRxBytes',
      'networkTxBytes',
      'blockReadBytes',
      'blockWriteBytes',
      'pids',
      'pidsLimit'
    ];
    for (const field of ['cpuPercent', 'memoryPercent']) {
      normalized[field] = typeof sample[field] === 'number' && Number.isFinite(sample[field]) && sample[field] >= 0
        ? rounded(sample[field])
        : null;
    }
    for (const field of integerFields) {
      normalized[field] = typeof sample[field] === 'number' && Number.isFinite(sample[field]) && sample[field] >= 0
        ? Math.round(sample[field])
        : null;
    }
    return normalized;
  }

  function readMetricHistory(applicationId) {
    const file = metricHistoryFile(applicationId);
    if (!fs.existsSync(file)) return [];
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_METRIC_HISTORY_BYTES) throw new Error('invalid metric history');
      const record = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      if (
        !record || record.schemaVersion !== METRIC_HISTORY_SCHEMA_VERSION ||
        record.applicationId !== applicationId || !Array.isArray(record.samples)
      ) return [];
      const cutoff = clock() - METRIC_RETENTION_MS;
      return record.samples.slice(-MAX_METRIC_HISTORY_SAMPLES).flatMap((sample) => {
        const normalized = safeMetricSample(sample, sample && sample.source);
        return normalized && Date.parse(normalized.collectedAt) >= cutoff ? [normalized] : [];
      });
    } catch {
      return [];
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function recordMetricSample(applicationId, sample, source) {
    const normalized = safeMetricSample(sample, source);
    if (!normalized) return readMetricHistory(applicationId).slice(-MAX_RETURNED_METRIC_SAMPLES);
    const cutoff = clock() - METRIC_RETENTION_MS;
    const samples = readMetricHistory(applicationId).filter((entry) => {
      const timestamp = Date.parse(entry.collectedAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    const previous = samples.at(-1) || null;
    const previousTime = previous ? Date.parse(previous.collectedAt) : 0;
    if (
      previous && previous.source === normalized.source && Number.isFinite(previousTime) &&
      clock() - previousTime < METRIC_SAMPLE_INTERVAL_MS
    ) return samples.slice(-MAX_RETURNED_METRIC_SAMPLES);
    samples.push(normalized);
    const retained = samples.slice(-MAX_METRIC_HISTORY_SAMPLES);
    atomicWriteJson(metricHistoryFile(applicationId), {
      schemaVersion: METRIC_HISTORY_SCHEMA_VERSION,
      applicationId,
      updatedAt: normalized.collectedAt,
      samples: retained
    });
    return retained.slice(-MAX_RETURNED_METRIC_SAMPLES);
  }

  function metricsResult(applicationId, source, sample, reason) {
    const history = sample
      ? recordMetricSample(applicationId, sample, source)
      : readMetricHistory(applicationId).slice(-MAX_RETURNED_METRIC_SAMPLES);
    return {
      available: Boolean(sample),
      source: sample ? source : null,
      reason: sample ? null : reason,
      sample: sample || null,
      history,
      historyPolicy: metricHistoryPolicy
    };
  }

  function systemdCpuPercent(applicationId, properties, observedAt) {
    const usage = systemdBigInt(properties.CPUUsageNSec);
    const previous = hostCpuBaselines.get(applicationId);
    if (usage === null) {
      hostCpuBaselines.delete(applicationId);
      return null;
    }
    hostCpuBaselines.set(applicationId, { usage, observedAt });
    if (!previous || observedAt <= previous.observedAt || usage < previous.usage) return null;
    const elapsedNanoseconds = (observedAt - previous.observedAt) * 1e6;
    if (!Number.isFinite(elapsedNanoseconds) || elapsedNanoseconds <= 0) return null;
    return Number(usage - previous.usage) / elapsedNanoseconds * 100;
  }

  function recordInventory(inventory) {
    const observedAt = new Date(clock()).toISOString();
    for (const application of inventory && inventory.applications || []) {
      if (!application || typeof application.id !== 'string') continue;
      recordSample(application.id, healthSample(application, null, observedAt));
    }
  }

  function unavailableObservation(application, generatedAt, tail, reason) {
    const health = healthSample(application, null, generatedAt);
    const history = recordSample(application.id, health);
    return {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      generatedAt,
      applicationId: application.id,
      runtime: { engine: application.runtime && application.runtime.engine || null },
      available: false,
      reason,
      health,
      metrics: metricsResult(
        application.id,
        null,
        null,
        'Çalışan bir runtime bulunmadığı için anlık kaynak metriği yok.'
      ),
      logs: {
        available: false,
        source: null,
        reason: 'Çalışan bir runtime bulunmadığı için log kaynağı yok.',
        lines: [],
        truncated: false,
        redacted: false,
        redactionCount: 0,
        tail
      },
      history,
      alerts: alertsFor(health, null)
    };
  }

  async function observeHostService(application, generatedAt, tail) {
    if (typeof getHostServiceSettings !== 'function' || typeof hostServiceObservation !== 'function') {
      return unavailableObservation(
        application,
        generatedAt,
        tail,
        'Sunucu servisi gözlem adaptörü bu kurulumda etkin değil.'
      );
    }
    let settings;
    try {
      settings = getHostServiceSettings(application.id);
    } catch {
      throw new ApplicationObservabilityError(
        'Sunucu servisi çalışma kaydı envanterden sonra değişti. Listeyi yenileyin.',
        409,
        'application-runtime-drift'
      );
    }
    const inventoryUnit = application.runtime && application.runtime.serviceUnit;
    if (
      !settings || settings.resourceId !== application.id ||
      !SYSTEMD_UNIT_PATTERN.test(String(settings.unit || '')) ||
      settings.unit !== inventoryUnit
    ) {
      throw new ApplicationObservabilityError(
        'Sunucu servisi birimi güncel envanterle eşleşmiyor.',
        409,
        'application-runtime-drift'
      );
    }

    const requests = await Promise.allSettled([
      hostServiceObservation('properties', settings.unit, { tail }),
      hostServiceObservation('journal', settings.unit, { tail })
    ]);
    const propertyResult = requests[0].status === 'fulfilled' ? requests[0].value : null;
    const journalResult = requests[1].status === 'fulfilled' ? requests[1].value : null;
    const propertyOutput = propertyResult && propertyResult.success === true &&
      Buffer.byteLength(String(propertyResult.output || ''), 'utf8') <= MAX_STATS_BYTES
      ? String(propertyResult.output || '')
      : null;
    const journalOutput = journalResult && journalResult.success === true &&
      Buffer.byteLength(String(journalResult.output || ''), 'utf8') <= MAX_LOG_BYTES
      ? String(journalResult.output || '')
      : null;
    const properties = propertyOutput === null ? null : parseSystemdProperties(propertyOutput);
    const hasProperties = properties && Object.keys(properties).length > 0;
    const health = hasProperties
      ? systemdHealthSample(application, properties, generatedAt)
      : healthSample(application, null, generatedAt);
    const history = recordSample(application.id, health);
    const cpuPercent = hasProperties
      ? systemdCpuPercent(application.id, properties, clock())
      : null;
    const metrics = hasProperties
      ? metricsFromSystemdProperties(properties, generatedAt, cpuPercent)
      : null;
    const parsedLogs = journalOutput === null
      ? null
      : logLinesFromJournal(journalOutput, tail, journalResult.truncated === true);
    const available = Boolean(hasProperties || parsedLogs);
    return {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      generatedAt,
      applicationId: application.id,
      runtime: { engine: 'systemd' },
      available,
      reason: available ? null : 'systemd gözlem verisi güvenli sorgu sınırları içinde alınamadı.',
      health,
      metrics: metricsResult(
        application.id,
        'systemd',
        metrics,
        hasProperties
          ? 'systemd bu servis için kullanılabilir cgroup sayacı bildirmedi.'
          : 'systemd cgroup sayaçları alınamadı.'
      ),
      logs: parsedLogs
        ? {
            available: true,
            source: 'journal',
            reason: parsedLogs.lines.length ? null : 'Bu servis için journal kaydı bulunmuyor.',
            ...parsedLogs,
            tail
          }
        : {
            available: false,
            source: 'journal',
            reason: journalResult && journalResult.truncated
              ? 'Journal çıktısı güvenli okuma sınırını aştı.'
              : 'Journal kayıtları alınamadı.',
            lines: [],
            truncated: Boolean(journalResult && journalResult.truncated),
            omittedEntries: 0,
            redacted: false,
            redactionCount: 0,
            tail
          },
      history,
      alerts: alertsFor(health, metrics, 'systemd')
    };
  }

  async function observe(applicationId, options = {}) {
    if (typeof applicationId !== 'string' || !applicationId || applicationId.length > 200) {
      throw new ApplicationObservabilityError('Uygulama kimliği geçersiz.');
    }
    const tail = normalizedLogTail(options.tail);
    const inventory = await getApplicationInventory();
    const application = (inventory.applications || []).find((entry) => entry.id === applicationId);
    if (!application) {
      throw new ApplicationObservabilityError(
        'Uygulama artık sunucuda bulunamıyor.',
        404,
        'application-not-found'
      );
    }

    const generatedAt = new Date(clock()).toISOString();
    const containerId = application.runtime && application.runtime.containerId;
    if (application.installation && application.installation.state === 'host-service') {
      return observeHostService(application, generatedAt, tail);
    }
    if (!containerId) {
      return unavailableObservation(
        application,
        generatedAt,
        tail,
        'Çalışan container olmadığı için log ve kaynak metriği bulunmuyor.'
      );
    }
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      throw new ApplicationObservabilityError(
        'Uygulamanın çalışma kimliği güvenli biçimde doğrulanamadı.',
        409,
        'application-runtime-invalid'
      );
    }

    let details;
    try {
      details = await dockerRequest(
        'GET',
        `/containers/${containerId}/json`,
        null,
        { maxResponseBytes: MAX_STATS_BYTES, timeoutMs: 5000 }
      );
    } catch {
      throw new ApplicationObservabilityError(
        'Uygulama çalışma örneği envanterden sonra değişti. Listeyi yenileyin.',
        409,
        'application-runtime-drift'
      );
    }
    if (!details || details.Id !== containerId) {
      throw new ApplicationObservabilityError(
        'Uygulama çalışma örneği envanterle eşleşmiyor.',
        409,
        'application-runtime-drift'
      );
    }

    const health = healthSample(application, details, generatedAt);
    const history = recordSample(application.id, health);
    const requests = await Promise.allSettled([
      health.state === 'running'
        ? dockerRequest(
            'GET',
            `/containers/${containerId}/stats?stream=false&one-shot=true`,
            null,
            { maxResponseBytes: MAX_STATS_BYTES, timeoutMs: 5000 }
          )
        : Promise.reject(new Error('not-running')),
      dockerRawRequest(
        'GET',
        `/containers/${containerId}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
        null,
        { maxResponseBytes: MAX_LOG_BYTES, timeoutMs: 10000 }
      )
    ]);

    const metrics = requests[0].status === 'fulfilled'
      ? metricsFromStats(requests[0].value, details, generatedAt)
      : null;
    const parsedLogs = requests[1].status === 'fulfilled'
      ? logLinesFromDockerBuffer(
          requests[1].value,
          tail,
          sensitiveValuesFromDetails(details)
        )
      : null;

    return {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      generatedAt,
      applicationId: application.id,
      runtime: { engine: 'docker' },
      available: true,
      reason: null,
      health,
      metrics: metricsResult(
        application.id,
        'docker',
        metrics,
        health.state === 'running'
          ? 'Anlık Docker kaynak metriği alınamadı.'
          : 'Uygulama çalışmadığı için anlık kaynak metriği yok.'
      ),
      logs: parsedLogs
        ? { available: true, source: 'docker', reason: null, ...parsedLogs, tail }
        : {
            available: false,
            source: 'docker',
            reason: 'Container log sürücüsü bu kaydı sunmadı.',
            lines: [],
            truncated: false,
            redacted: false,
            redactionCount: 0,
            tail
          },
      history,
      alerts: alertsFor(health, metrics)
    };
  }

  return { observe, readHistory, readMetricHistory, recordInventory };
}

module.exports = {
  ApplicationObservabilityError,
  DEFAULT_LOG_TAIL,
  MAX_LOG_BYTES,
  MAX_LOG_TAIL,
  MAX_METRIC_HISTORY_SAMPLES,
  MAX_RETURNED_METRIC_SAMPLES,
  METRIC_SAMPLE_INTERVAL_MS,
  MIN_LOG_TAIL,
  OBSERVABILITY_SCHEMA_VERSION,
  createApplicationObservabilityManager,
  logLinesFromDockerBuffer,
  logLinesFromJournal,
  metricsFromStats,
  metricsFromSystemdProperties,
  normalizedLogTail,
  parseSystemdProperties,
  redactLogLine
};
