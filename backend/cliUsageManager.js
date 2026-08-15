const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_PROVIDERS = 8;
const MAX_WINDOWS_PER_PROVIDER = 16;

function boundedLabel(value, maximum = 120) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizedPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizedDurationMinutes(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && numeric <= 366 * 24 * 60
    ? numeric
    : null;
}

function normalizedResetAt(value, { seconds = false } = {}) {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (seconds ? numeric * 1000 : numeric)
    : Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  return year >= 2020 && year <= 2100 ? date.toISOString() : null;
}

function periodForDuration(durationMinutes) {
  if (durationMinutes === 5 * 60) return 'five-hour';
  if (durationMinutes === 7 * 24 * 60) return 'weekly';
  return 'custom';
}

function safeId(value, fallback) {
  const normalized = String(value || '').toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function codexWindow(snapshotKey, snapshot, laneName, lane, index) {
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) return null;
  const usedPercent = normalizedPercent(lane.usedPercent);
  if (usedPercent === null) return null;
  const durationMinutes = normalizedDurationMinutes(lane.windowDurationMins);
  const advertisedName = boundedLabel(snapshot.limitName);
  const group = advertisedName || 'Codex';
  return {
    id: `${safeId(group, `codex-${index + 1}`)}-${laneName}-${index + 1}`,
    group,
    period: periodForDuration(durationMinutes),
    periodLabel: null,
    durationMinutes,
    remainingPercent: 100 - usedPercent,
    resetsAt: normalizedResetAt(lane.resetsAt, { seconds: true })
  };
}

function normalizeCodexRateLimits(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const byLimitId = payload.rateLimitsByLimitId;
  let snapshots = byLimitId && typeof byLimitId === 'object' && !Array.isArray(byLimitId)
    ? Object.entries(byLimitId).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    : [];
  if (!snapshots.length && payload.rateLimits && typeof payload.rateLimits === 'object') {
    snapshots = [[payload.rateLimits.limitId || 'codex', payload.rateLimits]];
  }
  snapshots.sort(([left], [right]) => {
    if (left === 'codex') return -1;
    if (right === 'codex') return 1;
    return left.localeCompare(right, 'en');
  });

  const windows = [];
  for (const [key, snapshot] of snapshots.slice(0, MAX_WINDOWS_PER_PROVIDER)) {
    const primary = codexWindow(key, snapshot, 'primary', snapshot.primary, windows.length);
    const secondary = codexWindow(key, snapshot, 'secondary', snapshot.secondary, windows.length + 1);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    if (windows.length >= MAX_WINDOWS_PER_PROVIDER) break;
  }
  return windows.slice(0, MAX_WINDOWS_PER_PROVIDER);
}

function antigravityGroupLabel(value) {
  const label = boundedLabel(value);
  if (/^gemini models$/i.test(label)) return 'Gemini modelleri';
  if (/^claude and gpt models$/i.test(label)) return 'Claude ve GPT modelleri';
  return label;
}

function antigravityPeriod(value) {
  const label = boundedLabel(value, 80);
  if (/weekly/i.test(label)) return { period: 'weekly', periodLabel: null, durationMinutes: 7 * 24 * 60 };
  if (/five\s+hour/i.test(label)) return { period: 'five-hour', periodLabel: null, durationMinutes: 5 * 60 };
  return { period: 'custom', periodLabel: label || null, durationMinutes: null };
}

function normalizeAntigravityUsage(payload) {
  const response = typeof payload === 'string'
    ? payload
    : payload && typeof payload.response === 'string'
      ? payload.response
      : '';
  if (!response || response.length > 32 * 1024) return [];

  const windows = [];
  for (const line of response.split(/\r?\n/).slice(0, MAX_WINDOWS_PER_PROVIDER * 2)) {
    const columns = line.split('\t').map((entry) => entry.trim());
    if (columns.length !== 4) continue;
    const group = antigravityGroupLabel(columns[0]);
    const percentMatch = columns[2].match(/^(\d{1,3})%$/);
    const remainingPercent = percentMatch ? normalizedPercent(percentMatch[1]) : null;
    if (!group || remainingPercent === null) continue;
    const period = antigravityPeriod(columns[1]);
    windows.push({
      id: `${safeId(group, 'antigravity')}-${period.period}-${windows.length + 1}`,
      group,
      ...period,
      remainingPercent,
      resetsAt: normalizedResetAt(columns[3])
    });
    if (windows.length >= MAX_WINDOWS_PER_PROVIDER) break;
  }
  return windows;
}

function createCliUsageManager({
  providers,
  clock = () => new Date(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  onError = () => {}
}) {
  if (
    !Array.isArray(providers) || !providers.length || providers.length > MAX_PROVIDERS ||
    !Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 1_000 || cacheTtlMs > 60 * 60 * 1000 ||
    typeof onError !== 'function'
  ) {
    throw new Error('CLI usage manager requires bounded providers and cache settings');
  }
  const normalizedProviders = providers.map((provider) => {
    const id = provider && typeof provider.id === 'string' ? provider.id.trim() : '';
    const name = boundedLabel(provider && provider.name);
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(id) || !name ||
      typeof provider.connection !== 'function' || typeof provider.read !== 'function' ||
      typeof provider.normalize !== 'function'
    ) {
      throw new Error('CLI usage provider is invalid');
    }
    return { ...provider, id, name };
  });
  let cache = null;
  let pending = null;

  function now() {
    const value = new Date(clock());
    if (!Number.isFinite(value.getTime())) throw new Error('CLI usage clock is invalid');
    return value;
  }

  async function loadProvider(provider) {
    let connection;
    try {
      connection = await provider.connection();
    } catch (error) {
      onError(provider.id, error);
      return {
        id: provider.id,
        name: provider.name,
        installed: false,
        connected: false,
        status: 'unavailable',
        windows: []
      };
    }
    const installed = connection && connection.installed === true;
    const connected = connection && connection.connected === true;
    if (!installed || !connected) {
      return {
        id: provider.id,
        name: provider.name,
        installed,
        connected,
        status: installed ? 'not-connected' : 'not-installed',
        windows: []
      };
    }
    try {
      const windows = provider.normalize(await provider.read());
      if (!Array.isArray(windows) || windows.length > MAX_WINDOWS_PER_PROVIDER) {
        throw new Error('CLI usage provider returned invalid windows');
      }
      return {
        id: provider.id,
        name: provider.name,
        installed: true,
        connected: true,
        status: windows.length ? 'ready' : 'unavailable',
        windows
      };
    } catch (error) {
      onError(provider.id, error);
      return {
        id: provider.id,
        name: provider.name,
        installed: true,
        connected: true,
        status: 'unavailable',
        windows: []
      };
    }
  }

  async function refresh() {
    const fetchedAt = now();
    const results = await Promise.all(normalizedProviders.map(loadProvider));
    const remaining = results.flatMap((provider) => provider.windows)
      .map((window) => window.remainingPercent)
      .filter((value) => Number.isInteger(value));
    const payload = {
      schemaVersion: 1,
      fetchedAt: fetchedAt.toISOString(),
      summary: {
        minimumRemainingPercent: remaining.length ? Math.min(...remaining) : null,
        installedProviderCount: results.filter((provider) => provider.installed).length,
        availableProviderCount: results.filter((provider) => provider.status === 'ready').length,
        windowCount: remaining.length
      },
      providers: results
    };
    cache = { payload, expiresAt: fetchedAt.getTime() + cacheTtlMs };
    return payload;
  }

  async function status({ force = false } = {}) {
    const timestamp = now().getTime();
    if (!force && cache && timestamp < cache.expiresAt) return cache.payload;
    if (pending) return pending;
    pending = refresh();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  return {
    invalidate: () => { cache = null; },
    status
  };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  createCliUsageManager,
  normalizeAntigravityUsage,
  normalizeCodexRateLimits
};
