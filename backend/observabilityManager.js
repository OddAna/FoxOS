const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const OBSERVABILITY_SCHEMA_VERSION = 1;
const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_MAX_HOST_SAMPLES = 1_440;
const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_MAX_APPLICATIONS = 2_000;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_LENGTH = 4_096;
const LOG_LEVELS = new Set(['all', 'error', 'warning', 'info', 'debug']);

class ObservabilityError extends Error {
  constructor(message, statusCode = 400, code = 'observability-error') {
    super(message);
    this.name = 'ObservabilityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rounded(value, digits = 1) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function percent(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return rounded(Math.max(0, Math.min(100, used / total * 100)));
}

function boundedName(value, fallback = 'Uygulama') {
  const text = String(value || '').replace(/[\0\r\n]/g, ' ').trim();
  return (text || fallback).slice(0, 160);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function runtimeTimestamp(value) {
  return validTimestamp(value) && Date.parse(value) > Date.parse('2000-01-01T00:00:00.000Z') ? value : null;
}

function emptyState() {
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    updatedAt: null,
    hostSamples: [],
    applications: [],
    events: [],
    alerts: []
  };
}

function parseCpuStat(text) {
  const line = String(text || '').split(/\r?\n/).find((candidate) => candidate.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = (values[3] || 0) + (values[4] || 0);
  return { total, idle };
}

function cpuUsage(current, previous = null) {
  if (!current || current.total <= 0) return null;
  if (previous && current.total > previous.total && current.idle >= previous.idle) {
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    return percent(total - idle, total);
  }
  return percent(current.total - current.idle, current.total);
}

function parseMeminfo(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  const totalBytes = finiteNumber(values.MemTotal);
  const availableBytes = finiteNumber(values.MemAvailable);
  if (totalBytes === null || availableBytes === null || totalBytes <= 0) return null;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return { totalBytes, availableBytes, usedBytes, usagePercent: percent(usedBytes, totalBytes) };
}

function parseLoadavg(text) {
  const values = String(text || '').trim().split(/\s+/).slice(0, 3).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return null;
  return { one: rounded(values[0], 2), five: rounded(values[1], 2), fifteen: rounded(values[2], 2) };
}

function parseNetworkDev(text) {
  if (typeof text !== 'string' || !text.includes('|')) return null;
  let rxBytes = 0;
  let txBytes = 0;
  let interfaces = 0;
  for (const line of String(text || '').split(/\r?\n/).slice(2)) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match || match[1].trim() === 'lo') continue;
    const values = match[2].trim().split(/\s+/).map(Number);
    if (values.length < 9 || !Number.isFinite(values[0]) || !Number.isFinite(values[8])) continue;
    rxBytes += values[0];
    txBytes += values[8];
    interfaces += 1;
  }
  return { rxBytes, txBytes, interfaces };
}

function networkRates(current, previous, elapsedSeconds) {
  if (!current) return null;
  const validPrevious = previous && elapsedSeconds > 0 &&
    current.rxBytes >= previous.rxBytes && current.txBytes >= previous.txBytes;
  return {
    ...current,
    rxBytesPerSecond: validPrevious ? Math.round((current.rxBytes - previous.rxBytes) / elapsedSeconds) : null,
    txBytesPerSecond: validPrevious ? Math.round((current.txBytes - previous.txBytes) / elapsedSeconds) : null
  };
}

function normalizeDockerStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const cpu = stats.cpu_stats || {};
  const previousCpu = stats.precpu_stats || {};
  const cpuTotal = finiteNumber(cpu.cpu_usage && cpu.cpu_usage.total_usage, 0);
  const previousCpuTotal = finiteNumber(previousCpu.cpu_usage && previousCpu.cpu_usage.total_usage, 0);
  const systemTotal = finiteNumber(cpu.system_cpu_usage, 0);
  const previousSystemTotal = finiteNumber(previousCpu.system_cpu_usage, 0);
  const onlineCpus = Math.min(4_096, finiteNumber(cpu.online_cpus) ||
    (cpu.cpu_usage && Array.isArray(cpu.cpu_usage.percpu_usage) ? cpu.cpu_usage.percpu_usage.length : 1));
  const cpuDelta = cpuTotal - previousCpuTotal;
  const systemDelta = systemTotal - previousSystemTotal;
  const cpuPercent = cpuDelta > 0 && systemDelta > 0
    ? rounded(Math.max(0, cpuDelta / systemDelta * onlineCpus * 100))
    : null;

  const memoryStats = stats.memory_stats || {};
  const memoryLimitBytes = finiteNumber(memoryStats.limit);
  const inactiveFile = finiteNumber(
    memoryStats.stats && (memoryStats.stats.inactive_file ?? memoryStats.stats.total_inactive_file),
    0
  );
  const rawMemoryUsage = finiteNumber(memoryStats.usage);
  const memoryUsageBytes = rawMemoryUsage === null ? null : Math.max(0, rawMemoryUsage - inactiveFile);

  let rxBytes = 0;
  let txBytes = 0;
  for (const network of Object.values(stats.networks || {})) {
    rxBytes += finiteNumber(network && network.rx_bytes, 0);
    txBytes += finiteNumber(network && network.tx_bytes, 0);
  }

  let readBytes = 0;
  let writeBytes = 0;
  const ioEntries = stats.blkio_stats && stats.blkio_stats.io_service_bytes_recursive || [];
  for (const entry of Array.isArray(ioEntries) ? ioEntries : []) {
    const operation = String(entry && entry.op || '').toLowerCase();
    if (operation === 'read') readBytes += finiteNumber(entry.value, 0);
    if (operation === 'write') writeBytes += finiteNumber(entry.value, 0);
  }

  return {
    readAt: validTimestamp(stats.read) ? stats.read : null,
    cpu: { usagePercent: cpuPercent, onlineCpus: Math.max(1, Math.round(onlineCpus || 1)) },
    memory: {
      usageBytes: memoryUsageBytes,
      limitBytes: memoryLimitBytes,
      usagePercent: percent(memoryUsageBytes, memoryLimitBytes)
    },
    network: { rxBytes, txBytes },
    blockIo: { readBytes, writeBytes },
    pids: { current: finiteNumber(stats.pids_stats && stats.pids_stats.current) }
  };
}

function stripUnsafeControls(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gi, '');
}

function redactSensitiveText(value) {
  let text = stripUnsafeControls(value);
  text = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[redacted-private-key]');
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]');
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
  text = text.replace(/(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]*/gi, '$1[redacted]');
  text = text.replace(/(["']?[A-Za-z0-9_.-]*(?:authorization|cookie|set-cookie|password|passwd|pwd|secret|token|api[_ -]?key|client[_ -]?secret|private[_ -]?key|access[_ -]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi, '$1[redacted]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]');
  return text;
}

function dockerLogFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  const frames = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const reserved = buffer[offset + 1] === 0 && buffer[offset + 2] === 0 && buffer[offset + 3] === 0;
    const length = buffer.readUInt32BE(offset + 4);
    if (![0, 1, 2].includes(streamType) || !reserved || offset + 8 + length > buffer.length) {
      return [{ stream: 'combined', text: buffer.toString('utf8') }];
    }
    frames.push({
      stream: streamType === 2 ? 'stderr' : streamType === 1 ? 'stdout' : 'combined',
      text: buffer.subarray(offset + 8, offset + 8 + length).toString('utf8')
    });
    offset += 8 + length;
  }
  if (offset !== buffer.length) return [{ stream: 'combined', text: buffer.toString('utf8') }];
  return frames;
}

function logLevel(message, stream = 'combined') {
  if (/\b(?:error|fatal|panic|exception|critical|failed)\b/i.test(message)) return 'error';
  if (/\b(?:warn(?:ing)?|deprecated|deprecation)\b/i.test(message)) return 'warning';
  if (/\b(?:debug|trace|verbose)\b/i.test(message)) return 'debug';
  if (stream === 'stderr') return 'error';
  return 'info';
}

function parseDockerLogs(buffer, { level = 'all', query = '' } = {}) {
  if (!LOG_LEVELS.has(level)) {
    throw new ObservabilityError('Log düzeyi geçersiz.', 400, 'observability-log-level-invalid');
  }
  if (typeof query !== 'string' || query.length > 100 || query.includes('\0')) {
    throw new ObservabilityError('Log araması geçersiz.', 400, 'observability-log-query-invalid');
  }
  const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');
  const entries = [];
  for (const frame of dockerLogFrames(buffer)) {
    for (const rawLine of frame.text.split(/\r?\n/)) {
      if (!rawLine) continue;
      const timestampMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/.exec(rawLine);
      const timestamp = timestampMatch && validTimestamp(timestampMatch[1]) ? timestampMatch[1] : null;
      const redacted = redactSensitiveText(timestampMatch ? timestampMatch[2] : rawLine)
        .slice(0, MAX_LOG_LINE_LENGTH);
      const entryLevel = logLevel(redacted, frame.stream);
      if (level !== 'all' && entryLevel !== level) continue;
      if (normalizedQuery && !redacted.toLocaleLowerCase('tr-TR').includes(normalizedQuery)) continue;
      entries.push({ timestamp, stream: frame.stream, level: entryLevel, message: redacted });
      if (entries.length >= MAX_LOG_LINES) return entries;
    }
  }
  return entries;
}

function downsample(samples, maximum = 240) {
  if (samples.length <= maximum) return samples;
  const result = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(index * (samples.length - 1) / (maximum - 1));
    result.push(samples[sourceIndex]);
  }
  return result;
}

function createObservabilityManager({
  dataRoot,
  hostRoot = '/host',
  dockerInspect,
  dockerStats,
  dockerLogs,
  getApplicationInventory,
  notificationManager = null,
  clock = () => new Date(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  maxHostSamples = DEFAULT_MAX_HOST_SAMPLES,
  maxEvents = DEFAULT_MAX_EVENTS,
  maxApplications = DEFAULT_MAX_APPLICATIONS,
  onError = () => {}
}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new TypeError('Observability manager requires an absolute data root');
  }
  if (typeof hostRoot !== 'string' || !path.isAbsolute(hostRoot)) {
    throw new TypeError('Observability manager requires an absolute host root');
  }
  if (
    typeof dockerInspect !== 'function' || typeof dockerStats !== 'function' ||
    typeof dockerLogs !== 'function' || typeof getApplicationInventory !== 'function'
  ) {
    throw new TypeError('Observability manager requires Docker and application inventory readers');
  }
  if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 1_000) {
    throw new TypeError('Observability sample interval is invalid');
  }
  if (!Number.isSafeInteger(maxApplications) || maxApplications < 1 || maxApplications > 10_000) {
    throw new TypeError('Observability application limit is invalid');
  }

  const stateFile = path.join(dataRoot, 'observability', 'state.json');
  let timer = null;
  let sampling = null;
  let previousCpu = null;
  let previousNetwork = null;
  let previousNetworkAt = null;

  function now() {
    return new Date(clock()).toISOString();
  }

  function readState() {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw new ObservabilityError('Gözlem geçmişi okunamadı.', 503, 'observability-state-invalid');
    }
    if (
      !payload || payload.schemaVersion !== OBSERVABILITY_SCHEMA_VERSION ||
      !Array.isArray(payload.hostSamples) || payload.hostSamples.length > maxHostSamples ||
      !Array.isArray(payload.applications) || payload.applications.length > maxApplications ||
      !Array.isArray(payload.events) || payload.events.length > maxEvents ||
      !Array.isArray(payload.alerts) || payload.alerts.length > maxApplications + 2
    ) {
      throw new ObservabilityError('Gözlem geçmişi okunamadı.', 503, 'observability-state-invalid');
    }
    return payload;
  }

  function readFixed(relativePath) {
    try {
      return fs.readFileSync(path.join(hostRoot, relativePath), 'utf8');
    } catch {
      return null;
    }
  }

  function diskSnapshot() {
    try {
      const stats = fs.statfsSync(hostRoot, { bigint: true });
      const totalBytes = Number(stats.bsize * stats.blocks);
      const availableBytes = Number(stats.bsize * stats.bavail);
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      return { totalBytes, availableBytes, usedBytes, usagePercent: percent(usedBytes, totalBytes) };
    } catch {
      return null;
    }
  }

  function temperatureSnapshot() {
    const root = path.join(hostRoot, 'sys/class/thermal');
    try {
      const values = fs.readdirSync(root).filter((name) => /^thermal_zone\d+$/.test(name)).slice(0, 64)
        .map((name) => finiteNumber(readFixed(path.join('sys/class/thermal', name, 'temp'))))
        .filter((value) => value !== null)
        .map((value) => value > 1_000 ? value / 1_000 : value)
        .filter((value) => value > -100 && value < 250);
      return values.length ? { celsius: rounded(Math.max(...values)) } : null;
    } catch {
      return null;
    }
  }

  function hostSnapshot(observedAt) {
    const cpuStat = parseCpuStat(readFixed('proc/stat'));
    const network = parseNetworkDev(readFixed('proc/net/dev'));
    const elapsedSeconds = previousNetworkAt
      ? Math.max(0, (Date.parse(observedAt) - Date.parse(previousNetworkAt)) / 1_000)
      : 0;
    const snapshot = {
      observedAt,
      cpu: { usagePercent: cpuUsage(cpuStat, previousCpu) },
      memory: parseMeminfo(readFixed('proc/meminfo')),
      disk: diskSnapshot(),
      load: parseLoadavg(readFixed('proc/loadavg')),
      network: networkRates(network, previousNetwork, elapsedSeconds),
      uptimeSeconds: rounded(finiteNumber(String(readFixed('proc/uptime') || '').trim().split(/\s+/)[0]), 0),
      temperature: temperatureSnapshot()
    };
    previousCpu = cpuStat;
    previousNetwork = network;
    previousNetworkAt = observedAt;
    return snapshot;
  }

  function normalizedApplications(inventory) {
    const applications = inventory && Array.isArray(inventory.applications) ? inventory.applications : [];
    return applications.map((application) => ({
      id: String(application.id || '').slice(0, 200),
      name: boundedName(application.name),
      operationalState: ['running', 'stopped', 'transitioning', 'error'].includes(
        application.runtime && application.runtime.operationalState
      ) ? application.runtime.operationalState : 'transitioning',
      healthStatus: ['healthy', 'unhealthy', 'starting'].includes(
        application.runtime && application.runtime.healthStatus
      ) ? application.runtime.healthStatus : null,
      containerId: /^[a-f0-9]{64}$/i.test(String(application.runtime && application.runtime.containerId || ''))
        ? application.runtime.containerId : null
    })).filter((application) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(application.id))
      .slice(0, maxApplications);
  }

  function createEvent(application, type, previousValue, currentValue, occurredAt) {
    return {
      id: 'evt_' + crypto.randomBytes(16).toString('hex'),
      applicationId: application.id,
      applicationName: application.name,
      type,
      previousValue: previousValue || null,
      currentValue: currentValue || null,
      occurredAt
    };
  }

  function transitionEvents(previousApplications, currentApplications, observedAt) {
    if (!previousApplications.length) return [];
    const previousById = new Map(previousApplications.map((application) => [application.id, application]));
    const events = [];
    for (const application of currentApplications) {
      const previous = previousById.get(application.id);
      if (!previous) continue;
      if (previous.operationalState !== application.operationalState) {
        events.push(createEvent(application, 'state-changed', previous.operationalState, application.operationalState, observedAt));
      }
      if (previous.healthStatus !== application.healthStatus) {
        events.push(createEvent(application, 'health-changed', previous.healthStatus, application.healthStatus, observedAt));
      }
      if (previous.containerId && application.containerId && previous.containerId !== application.containerId) {
        events.push(createEvent(application, 'runtime-replaced', 'previous-runtime', 'new-runtime', observedAt));
      }
    }
    return events;
  }

  function notificationMissing(error) {
    return error && (error.code === 'notification-not-found' || error.statusCode === 404);
  }

  function notifyAlert(alert, application = null) {
    if (!notificationManager) return true;
    const applicationAlert = alert.scope === 'application';
    try {
      notificationManager.create({
        source: 'observability',
        category: applicationAlert ? 'application-health' : 'host-health',
        severity: alert.severity,
        title: applicationAlert ? 'Uygulama dikkat gerektiriyor' : 'Sunucu kaynağı dikkat gerektiriyor',
        body: applicationAlert
          ? `${boundedName(application && application.name)} uygulamasında hata durumu algılandı.`
          : alert.kind === 'disk'
            ? `Sunucu disk kullanımı %${Math.round(alert.value)} seviyesine ulaştı.`
            : `Sunucu bellek kullanımı %${Math.round(alert.value)} seviyesine ulaştı.`,
        dedupeKey: alert.dedupeKey,
        threadId: alert.dedupeKey,
        target: { app: 'settings', tab: 'observability' },
        sensitive: applicationAlert
      });
      return true;
    } catch {
      onError(new ObservabilityError(
        'Gözlem uyarısı Bildirim Merkezi’ne aktarılamadı.',
        503,
        'observability-notification-delivery-failed'
      ));
      return false;
    }
  }

  function resolveAlert(alert) {
    if (!notificationManager) return true;
    try {
      notificationManager.resolveByDedupeKey({ source: 'observability', dedupeKey: alert.dedupeKey });
      return true;
    } catch (error) {
      if (notificationMissing(error)) return true;
      onError(new ObservabilityError(
        'Gözlem uyarısı Bildirim Merkezi’nde kapatılamadı.',
        503,
        'observability-notification-resolution-failed'
      ));
      return false;
    }
  }

  function evaluateAlert(alertsByKey, definition, active, observedAt, breachCount = 0) {
    const previous = alertsByKey.get(definition.dedupeKey) || null;
    if (active) {
      const shouldNotify = !previous || !previous.active ||
        previous.severity !== definition.severity || previous.notificationPending === true;
      const notificationPending = shouldNotify
        ? !notifyAlert(definition, definition.application)
        : false;
      const next = {
        ...definition,
        active: true,
        breachCount,
        notificationPending,
        resolutionPending: false,
        activatedAt: previous && previous.active ? previous.activatedAt : observedAt,
        resolvedAt: null,
        lastEvaluatedAt: observedAt
      };
      alertsByKey.set(definition.dedupeKey, next);
      return;
    }
    const shouldResolve = previous && (previous.active || previous.resolutionPending === true);
    const resolutionPending = shouldResolve ? !resolveAlert(previous) : false;
    alertsByKey.set(definition.dedupeKey, {
      ...(previous || definition),
      ...definition,
      active: false,
      breachCount,
      notificationPending: false,
      resolutionPending,
      activatedAt: previous && previous.activatedAt || null,
      resolvedAt: previous && previous.active ? observedAt : previous && previous.resolvedAt || null,
      lastEvaluatedAt: observedAt
    });
  }

  function evaluateAlerts(state, host, applications, observedAt) {
    const alertsByKey = new Map(state.alerts.map((alert) => [alert.dedupeKey, alert]));
    const diskValue = host.disk && host.disk.usagePercent;
    evaluateAlert(alertsByKey, {
      dedupeKey: 'host-disk-usage', scope: 'host', kind: 'disk',
      severity: diskValue !== null && diskValue >= 95 ? 'critical' : 'warning', value: diskValue
    }, diskValue !== null && diskValue >= 85, observedAt);

    const previousMemory = alertsByKey.get('host-memory-usage');
    const memoryValue = host.memory && host.memory.usagePercent;
    const memoryBreaching = memoryValue !== null && memoryValue >= 90;
    const memoryBreachCount = memoryBreaching ? (previousMemory && previousMemory.breachCount || 0) + 1 : 0;
    evaluateAlert(alertsByKey, {
      dedupeKey: 'host-memory-usage', scope: 'host', kind: 'memory',
      severity: memoryValue !== null && memoryValue >= 97 ? 'critical' : 'warning', value: memoryValue
    }, memoryBreaching && memoryBreachCount >= 3, observedAt, memoryBreachCount);

    const currentApplicationKeys = new Set();
    for (const application of applications) {
      const identityHash = crypto.createHash('sha256').update(application.id).digest('hex').slice(0, 32);
      const dedupeKey = `application-error-${identityHash}`;
      currentApplicationKeys.add(dedupeKey);
      evaluateAlert(alertsByKey, {
        dedupeKey,
        scope: 'application',
        kind: 'runtime-error',
        severity: 'critical',
        value: null,
        applicationId: application.id,
        applicationName: application.name,
        application
      }, application.operationalState === 'error', observedAt);
    }
    for (const alert of alertsByKey.values()) {
      if (
        alert.scope === 'application' && !currentApplicationKeys.has(alert.dedupeKey) &&
        (alert.active || alert.resolutionPending === true)
      ) {
        evaluateAlert(alertsByKey, { ...alert, application: undefined }, false, observedAt);
      }
    }
    return [...alertsByKey.values()]
      .filter((alert) => (
        alert.scope === 'host' || currentApplicationKeys.has(alert.dedupeKey) ||
        alert.active || alert.resolutionPending === true
      ))
      .map(({ application, ...alert }) => alert)
      .slice(0, maxApplications + 2);
  }

  async function sample() {
    const observedAt = now();
    const state = readState();
    const host = hostSnapshot(observedAt);
    let inventory;
    try {
      inventory = await getApplicationInventory();
    } catch {
      throw new ObservabilityError(
        'Uygulama envanteri gözlem için okunamadı.',
        503,
        'observability-inventory-unavailable'
      );
    }
    const applications = normalizedApplications(inventory);
    const events = transitionEvents(state.applications, applications, observedAt);
    const alerts = evaluateAlerts(state, host, applications, observedAt);
    const next = {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      updatedAt: observedAt,
      hostSamples: [...state.hostSamples, host].slice(-maxHostSamples),
      applications: applications.map((application) => ({ ...application, observedAt })),
      events: [...events, ...state.events].slice(0, maxEvents),
      alerts
    };
    atomicWriteJson(stateFile, next);
    return next;
  }

  function refresh() {
    if (!sampling) {
      sampling = sample().finally(() => { sampling = null; });
    }
    return sampling.then(() => overview());
  }

  function applicationSummary(applications) {
    const summary = { total: applications.length, running: 0, stopped: 0, transitioning: 0, error: 0 };
    for (const application of applications) summary[application.operationalState] += 1;
    return summary;
  }

  function overview() {
    const state = readState();
    return {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      generatedAt: now(),
      updatedAt: state.updatedAt,
      collecting: Boolean(timer),
      readOnly: true,
      sampleIntervalSeconds: sampleIntervalMs / 1_000,
      historyWindowHours: rounded(maxHostSamples * sampleIntervalMs / 3_600_000, 1),
      current: state.hostSamples.at(-1) || null,
      history: downsample(state.hostSamples),
      applications: applicationSummary(state.applications),
      activeAlerts: state.alerts.filter((alert) => alert.active).map((alert) => ({
        dedupeKey: alert.dedupeKey,
        scope: alert.scope,
        kind: alert.kind,
        severity: alert.severity,
        value: alert.value,
        applicationId: alert.applicationId || null,
        applicationName: alert.applicationName || null,
        activatedAt: alert.activatedAt
      })),
      recentEvents: state.events.slice(0, 50)
    };
  }

  async function exactApplication(applicationId) {
    if (typeof applicationId !== 'string' || !applicationId || applicationId.length > 200 || applicationId.includes('\0')) {
      throw new ObservabilityError('Uygulama kimliği geçersiz.', 400, 'observability-application-id-invalid');
    }
    let inventory;
    try {
      inventory = await getApplicationInventory();
    } catch {
      throw new ObservabilityError(
        'Uygulama envanteri gözlem için okunamadı.',
        503,
        'observability-inventory-unavailable'
      );
    }
    const application = inventory.applications.find((candidate) => candidate.id === applicationId);
    if (!application) {
      throw new ObservabilityError('Uygulama bulunamadı.', 404, 'observability-application-not-found');
    }
    return application;
  }

  async function application(applicationId) {
    const selected = await exactApplication(applicationId);
    const containerId = selected.runtime && selected.runtime.containerId;
    const runtimePresent = /^[a-f0-9]{64}$/i.test(String(containerId || ''));
    let inspect = null;
    let metrics = null;
    let metricsError = null;
    if (runtimePresent) {
      try {
        inspect = await dockerInspect(containerId);
      } catch (error) {
        metricsError = 'runtime-unavailable';
      }
      if (String(selected.runtime.state || '').toLowerCase() === 'running') {
        try {
          metrics = normalizeDockerStats(await dockerStats(containerId));
        } catch {
          metricsError = 'metrics-unavailable';
        }
      }
    }
    const state = readState();
    const healthLogs = inspect && inspect.State && inspect.State.Health && Array.isArray(inspect.State.Health.Log)
      ? inspect.State.Health.Log.slice(-10).map((entry) => ({
        startedAt: validTimestamp(entry.Start) ? entry.Start : null,
        finishedAt: validTimestamp(entry.End) ? entry.End : null,
        exitCode: Number.isInteger(entry.ExitCode) ? entry.ExitCode : null,
        output: redactSensitiveText(entry.Output || '').slice(0, MAX_LOG_LINE_LENGTH)
      })) : [];
    return {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      generatedAt: now(),
      readOnly: true,
      application: {
        id: selected.id,
        name: boundedName(selected.name),
        operationalState: selected.runtime && selected.runtime.operationalState || 'transitioning',
        healthStatus: selected.runtime && selected.runtime.healthStatus || null
      },
      runtime: runtimePresent ? {
        state: inspect && inspect.State && inspect.State.Status || selected.runtime.state || null,
        running: Boolean(inspect && inspect.State && inspect.State.Running),
        restartCount: Number.isInteger(inspect && inspect.RestartCount) ? inspect.RestartCount : null,
        oomKilled: Boolean(inspect && inspect.State && inspect.State.OOMKilled),
        exitCode: Number.isInteger(inspect && inspect.State && inspect.State.ExitCode)
          ? inspect.State.ExitCode : selected.runtime.exitCode ?? null,
        startedAt: runtimeTimestamp(inspect && inspect.State && inspect.State.StartedAt),
        finishedAt: runtimeTimestamp(inspect && inspect.State && inspect.State.FinishedAt),
        healthChecks: healthLogs
      } : null,
      metrics,
      metricsError,
      events: state.events.filter((event) => event.applicationId === selected.id).slice(0, 100),
      capabilities: {
        metrics: runtimePresent && String(selected.runtime.state || '').toLowerCase() === 'running',
        logs: runtimePresent,
        events: true,
        diagnostics: true
      }
    };
  }

  async function applicationLogs(applicationId, { tail = 200, level = 'all', query = '' } = {}) {
    const boundedTail = Number(tail);
    if (!Number.isSafeInteger(boundedTail) || boundedTail < 1 || boundedTail > MAX_LOG_LINES) {
      throw new ObservabilityError('Log satırı sınırı geçersiz.', 400, 'observability-log-tail-invalid');
    }
    const selected = await exactApplication(applicationId);
    const containerId = selected.runtime && selected.runtime.containerId;
    if (!/^[a-f0-9]{64}$/i.test(String(containerId || ''))) {
      return { generatedAt: now(), applicationId: selected.id, supported: false, entries: [], redacted: true };
    }
    let buffer;
    try {
      buffer = await dockerLogs(containerId, { tail: boundedTail, timestamps: true });
    } catch {
      throw new ObservabilityError('Uygulama logları şu anda okunamadı.', 503, 'observability-logs-unavailable');
    }
    return {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      generatedAt: now(),
      applicationId: selected.id,
      supported: true,
      redacted: true,
      persisted: false,
      limit: boundedTail,
      entries: parseDockerLogs(buffer, { level, query }).slice(-boundedTail)
    };
  }

  async function diagnostics(applicationId = null) {
    const report = {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      exportType: 'foxos-redacted-observability-diagnostics',
      generatedAt: now(),
      readOnly: true,
      redacted: true,
      overview: overview()
    };
    if (applicationId) {
      report.application = await application(applicationId);
      try {
        report.logs = await applicationLogs(applicationId, { tail: 100 });
      } catch (error) {
        report.logs = { supported: false, entries: [], errorCode: error.code || 'observability-logs-unavailable' };
      }
    }
    return report;
  }

  function start() {
    if (timer) return false;
    refresh().catch(onError);
    timer = setIntervalFn(() => refresh().catch(onError), sampleIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  return {
    application,
    applicationLogs,
    diagnostics,
    overview,
    paths: { stateFile },
    refresh,
    start,
    stop
  };
}

module.exports = {
  DEFAULT_MAX_APPLICATIONS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_HOST_SAMPLES,
  DEFAULT_SAMPLE_INTERVAL_MS,
  MAX_LOG_LINES,
  OBSERVABILITY_SCHEMA_VERSION,
  ObservabilityError,
  createObservabilityManager,
  dockerLogFrames,
  normalizeDockerStats,
  parseCpuStat,
  parseDockerLogs,
  parseMeminfo,
  parseNetworkDev,
  redactSensitiveText
};
