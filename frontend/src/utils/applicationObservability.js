export const formatBytes = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  const digits = amount >= 100 || index === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toLocaleString('tr-TR', { maximumFractionDigits: digits })} ${units[index]}`;
};

export const formatPercent = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  const percent = Number(value);
  if (!Number.isFinite(percent)) return '—';
  return `%${percent.toLocaleString('tr-TR', { maximumFractionDigits: percent >= 10 ? 1 : 2 })}`;
};

export const formatCount = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value).toLocaleString('tr-TR')
    : '—'
);

export const metricTrend = (samples, field, floorMaximum = 0, maxPoints = 96) => {
  const entries = (Array.isArray(samples) ? samples : []).flatMap((sample) => {
    const value = sample && sample[field];
    const timestamp = sample && Date.parse(sample.collectedAt);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isFinite(timestamp)
      ? [{ collectedAt: sample.collectedAt, value }]
      : [];
  }).slice(-maxPoints);
  if (!entries.length) {
    return { count: 0, points: '', minimum: null, maximum: null, latest: null };
  }
  const values = entries.map((entry) => entry.value);
  const maximum = Math.max(...values);
  const scaleMaximum = Math.max(1, floorMaximum, maximum);
  const pointCoordinates = entries.map((entry, index) => {
    const x = entries.length === 1 ? 50 : index / (entries.length - 1) * 100;
    const y = 31 - Math.min(1, entry.value / scaleMaximum) * 29;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const points = entries.length === 1
    ? `0.00,${pointCoordinates[0].split(',')[1]} 100.00,${pointCoordinates[0].split(',')[1]}`
    : pointCoordinates.join(' ');
  return {
    count: entries.length,
    points,
    minimum: Math.min(...values),
    maximum,
    latest: entries.at(-1)
  };
};

export const healthStateLabel = (sample) => {
  if (!sample) return 'Bilinmiyor';
  if (sample.healthStatus === 'unhealthy' || sample.operationalState === 'error') return 'Hata';
  if (sample.healthStatus === 'starting' || sample.operationalState === 'transitioning') return 'Hazırlanıyor';
  if (sample.operationalState === 'running') return sample.healthStatus === 'healthy' ? 'Sağlıklı' : 'Çalışıyor';
  if (sample.operationalState === 'stopped') return 'Durduruldu';
  return 'Bilinmiyor';
};

export const healthStateTone = (sample) => {
  if (!sample) return 'unknown';
  if (sample.healthStatus === 'unhealthy' || sample.operationalState === 'error') return 'critical';
  if (sample.healthStatus === 'starting' || sample.operationalState === 'transitioning') return 'warning';
  if (sample.operationalState === 'running') return 'healthy';
  if (sample.operationalState === 'stopped') return 'stopped';
  return 'unknown';
};

export const formatObservedTime = (value, includeDate = false) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('tr-TR', includeDate
    ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }
  ).format(date);
};
