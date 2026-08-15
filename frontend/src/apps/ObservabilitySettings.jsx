import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BellRing,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  ShieldCheck,
  Thermometer
} from 'lucide-react';
import { apiFetch } from '../api';
import { useI18n } from '../contexts/LocaleContext';
import './ObservabilitySettings.css';

const formatBytes = (value, formatNumber) => {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${formatNumber(size, { maximumFractionDigits: size >= 100 ? 0 : 1 })} ${units[unit]}`;
};

const percentText = (value, formatNumber) => Number.isFinite(value)
  ? `${formatNumber(value, { maximumFractionDigits: 1 })}%`
  : '—';

const Sparkline = ({ values, label }) => {
  const points = useMemo(() => {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return '';
    const minimum = Math.min(...finite);
    const maximum = Math.max(...finite);
    const range = Math.max(1, maximum - minimum);
    return finite.map((value, index) => {
      const x = index / (finite.length - 1) * 100;
      const y = 28 - (value - minimum) / range * 24;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
  }, [values]);

  return (
    <svg className="observability-sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={label}>
      <path d="M0 29.5H100" />
      {points && <polyline points={points} />}
    </svg>
  );
};

const MetricCard = ({ icon: Icon, label, value, detail, values, chartLabel, tone = 'blue' }) => (
  <article className={`observability-metric is-${tone}`}>
    <header><span><Icon size={16} /></span><strong>{label}</strong></header>
    <div className="observability-metric-value">{value}</div>
    <small>{detail}</small>
    <Sparkline values={values} label={chartLabel} />
  </article>
);

const stateLabel = (value, t) => ({
  running: t('observability.stateRunning'),
  stopped: t('observability.stateStopped'),
  transitioning: t('observability.stateTransitioning'),
  error: t('observability.stateError'),
  healthy: t('observability.stateHealthy'),
  unhealthy: t('observability.stateUnhealthy'),
  starting: t('observability.stateStarting'),
  'previous-runtime': t('observability.stateUnknown'),
  'new-runtime': t('observability.stateUnknown')
}[value] || value || t('observability.stateUnknown'));

const eventLabel = (event, t) => ({
  'state-changed': t('observability.stateChanged'),
  'health-changed': t('observability.healthChanged'),
  'runtime-replaced': t('observability.runtimeReplaced')
}[event.type] || t('observability.stateChanged'));

const ObservabilitySettings = () => {
  const { formatDate, formatNumber, formatTime, t } = useI18n();
  const [overview, setOverview] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  const loadOverview = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setState('loading');
    try {
      const response = await apiFetch('/api/observability/overview');
      setOverview(await response.json());
      setError('');
      setState('ready');
    } catch (requestError) {
      setError(requestError.message || t('observability.loadError'));
      setState('error');
    }
  }, [t]);

  useEffect(() => {
    loadOverview();
    const timer = window.setInterval(() => loadOverview({ quiet: true }), 30_000);
    return () => window.clearInterval(timer);
  }, [loadOverview]);

  const refresh = async () => {
    setState('refreshing');
    try {
      const response = await apiFetch('/api/observability/refresh', { method: 'POST' });
      setOverview(await response.json());
      setError('');
      setState('ready');
    } catch (requestError) {
      setError(requestError.message || t('observability.loadError'));
      setState('error');
    }
  };

  const downloadDiagnostics = async () => {
    setDownloading(true);
    try {
      const response = await apiFetch('/api/observability/diagnostics');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `foxos-redacted-diagnostics-${Date.now()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setError('');
    } catch (requestError) {
      setError(requestError.message || t('observability.downloadError'));
    } finally {
      setDownloading(false);
    }
  };

  const current = overview && overview.current;
  const history = overview && Array.isArray(overview.history) ? overview.history : [];
  const applications = overview && overview.applications || {
    total: 0, running: 0, stopped: 0, transitioning: 0, error: 0
  };
  const activeAlerts = overview && Array.isArray(overview.activeAlerts) ? overview.activeAlerts : [];
  const recentEvents = overview && Array.isArray(overview.recentEvents) ? overview.recentEvents : [];
  const updated = overview && overview.updatedAt
    ? t('observability.updated', { time: formatTime(overview.updatedAt) })
    : t('observability.neverUpdated');
  const metricHistory = (reader) => history.map(reader).filter(Number.isFinite);

  return (
    <div className="observability-settings" data-observability-settings>
      <section className="observability-hero">
        <div className="observability-hero-mark"><Activity size={28} /></div>
        <div className="observability-hero-copy">
          <span><ShieldCheck size={12} /> {t('observability.kicker')}</span>
          <h3>{t('observability.title')}</h3>
          <p>{t('observability.description')}</p>
          <em><i /> {t('observability.readOnly')} · {t('observability.localOnly')}</em>
        </div>
        <div className="observability-hero-actions">
          <small>{updated}</small>
          <button type="button" onClick={refresh} disabled={state === 'refreshing'}>
            {state === 'refreshing' ? <Loader2 size={13} className="is-spinning" /> : <RefreshCw size={13} />}
            {state === 'refreshing' ? t('observability.refreshing') : t('observability.refresh')}
          </button>
          <button type="button" onClick={downloadDiagnostics} disabled={downloading}>
            {downloading ? <Loader2 size={13} className="is-spinning" /> : <Download size={13} />}
            {downloading ? t('observability.downloading') : t('observability.download')}
          </button>
        </div>
      </section>

      {error && (
        <div className="observability-feedback" role="status">
          <CircleAlert size={15} /> <span>{error}</span>
          <button type="button" onClick={() => loadOverview()}>{t('common.retry')}</button>
        </div>
      )}

      {state === 'loading' && !overview ? (
        <div className="observability-loading"><Loader2 size={18} className="is-spinning" /> {t('observability.loading')}</div>
      ) : (
        <>
          <section className="observability-section">
            <header className="observability-section-heading">
              <div><h3>{t('observability.metricSection')}</h3><p>{t('observability.metricDescription')}</p></div>
            </header>
            <div className="observability-metric-grid">
              <MetricCard
                icon={Cpu}
                label={t('observability.cpu')}
                value={percentText(current && current.cpu && current.cpu.usagePercent, formatNumber)}
                detail={t('observability.readOnly')}
                values={metricHistory((sample) => sample.cpu && sample.cpu.usagePercent)}
                chartLabel={t('observability.chartLabel', { metric: t('observability.cpu') })}
              />
              <MetricCard
                icon={MemoryStick}
                label={t('observability.memory')}
                value={percentText(current && current.memory && current.memory.usagePercent, formatNumber)}
                detail={current && current.memory ? formatBytes(current.memory.usedBytes, formatNumber) : t('observability.unavailable')}
                values={metricHistory((sample) => sample.memory && sample.memory.usagePercent)}
                chartLabel={t('observability.chartLabel', { metric: t('observability.memory') })}
                tone="violet"
              />
              <MetricCard
                icon={HardDrive}
                label={t('observability.disk')}
                value={percentText(current && current.disk && current.disk.usagePercent, formatNumber)}
                detail={current && current.disk ? formatBytes(current.disk.availableBytes, formatNumber) : t('observability.unavailable')}
                values={metricHistory((sample) => sample.disk && sample.disk.usagePercent)}
                chartLabel={t('observability.chartLabel', { metric: t('observability.disk') })}
                tone="amber"
              />
              <MetricCard
                icon={Gauge}
                label={t('observability.load')}
                value={Number.isFinite(current && current.load && current.load.one)
                  ? formatNumber(current.load.one, { maximumFractionDigits: 2 }) : '—'}
                detail={t('observability.oneMinute')}
                values={metricHistory((sample) => sample.load && sample.load.one)}
                chartLabel={t('observability.chartLabel', { metric: t('observability.load') })}
                tone="teal"
              />
              <MetricCard
                icon={Thermometer}
                label={t('observability.temperature')}
                value={Number.isFinite(current && current.temperature && current.temperature.celsius)
                  ? `${formatNumber(current.temperature.celsius, { maximumFractionDigits: 1 })} °C` : '—'}
                detail={current && current.temperature ? t('observability.readOnly') : t('observability.unavailable')}
                values={metricHistory((sample) => sample.temperature && sample.temperature.celsius)}
                chartLabel={t('observability.chartLabel', { metric: t('observability.temperature') })}
                tone="rose"
              />
              <MetricCard
                icon={Network}
                label={t('observability.network')}
                value={current && current.network
                  ? `${formatBytes(current.network.rxBytesPerSecond, formatNumber)}/s` : '—'}
                detail={current && current.network
                  ? `${t('observability.receive')} · ${t('observability.transmit')} ${formatBytes(current.network.txBytesPerSecond, formatNumber)}/s`
                  : t('observability.unavailable')}
                values={metricHistory((sample) => sample.network && sample.network.rxBytesPerSecond)}
                chartLabel={t('observability.chartLabel', { metric: t('observability.network') })}
                tone="green"
              />
            </div>
          </section>

          <div className="observability-two-column">
            <section className="observability-section">
              <header className="observability-section-heading">
                <div><h3>{t('observability.applicationsTitle')}</h3><p>{t('observability.applicationsDescription')}</p></div>
              </header>
              <div className="observability-app-counts">
                {[
                  ['total', applications.total],
                  ['running', applications.running],
                  ['stopped', applications.stopped],
                  ['transitioning', applications.transitioning],
                  ['error', applications.error]
                ].map(([key, value]) => (
                  <div key={key} className={`is-${key}`}><strong>{formatNumber(value)}</strong><span>{t(`observability.${key}`)}</span></div>
                ))}
              </div>
            </section>

            <section className="observability-section">
              <header className="observability-section-heading">
                <div><h3>{t('observability.alertsTitle')}</h3><p>{t('observability.alertsDescription')}</p></div>
                <span className={`observability-alert-count${activeAlerts.length ? ' has-alerts' : ''}`}>
                  <BellRing size={13} /> {formatNumber(activeAlerts.length)}
                </span>
              </header>
              {activeAlerts.length ? (
                <div className="observability-alert-list">
                  {activeAlerts.map((alert) => (
                    <article key={alert.dedupeKey} className={`is-${alert.severity}`}>
                      <CircleAlert size={15} />
                      <div>
                        <strong>{alert.scope === 'application'
                          ? t('observability.alertApplication', { name: alert.applicationName || t('observability.stateUnknown') })
                          : alert.kind === 'disk' ? t('observability.alertDisk') : t('observability.alertMemory')}</strong>
                        <span>{Number.isFinite(alert.value)
                          ? t('observability.alertValue', { value: formatNumber(alert.value, { maximumFractionDigits: 1 }) })
                          : alert.severity === 'critical' ? t('observability.severityCritical') : t('observability.severityWarning')}</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="observability-empty is-success"><CheckCircle2 size={16} /> {t('observability.noAlerts')}</div>
              )}
            </section>
          </div>

          <section className="observability-section">
            <header className="observability-section-heading">
              <div><h3>{t('observability.eventsTitle')}</h3><p>{t('observability.eventsDescription')}</p></div>
            </header>
            {recentEvents.length ? (
              <div className="observability-event-list">
                {recentEvents.map((event) => (
                  <article key={event.id}>
                    <span className="observability-event-dot" />
                    <div><strong>{event.applicationName}</strong><span>{eventLabel(event, t)}</span></div>
                    <em>{event.type === 'runtime-replaced'
                      ? t('observability.runtimeReplaced')
                      : t('observability.fromTo', {
                        from: stateLabel(event.previousValue, t),
                        to: stateLabel(event.currentValue, t)
                      })}</em>
                    <time dateTime={event.occurredAt}>{formatDate(event.occurredAt, { dateStyle: 'short', timeStyle: 'short' })}</time>
                  </article>
                ))}
              </div>
            ) : (
              <div className="observability-empty"><Activity size={16} /> {t('observability.noEvents')}</div>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default ObservabilitySettings;
