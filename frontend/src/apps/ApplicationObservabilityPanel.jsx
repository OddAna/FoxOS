import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Download,
  FileText,
  Gauge,
  HardDrive,
  History,
  Loader2,
  MemoryStick,
  Network,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck
} from 'lucide-react';
import { apiFetch } from '../api';
import { useI18n } from '../contexts/LocaleContext';
import './ApplicationObservabilityPanel.css';

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

const logLevelLabel = (level, t) => ({
  error: t('observability.application.levelError'),
  warning: t('observability.application.levelWarning'),
  info: t('observability.application.levelInfo'),
  debug: t('observability.application.levelDebug')
}[level] || level);

const Metric = ({ icon: Icon, label, value, detail, percent = null, tone = 'blue' }) => (
  <article className={`application-observability-metric is-${tone}`}>
    <header><Icon size={15} /><span>{label}</span></header>
    <strong>{value}</strong>
    <small>{detail}</small>
    {Number.isFinite(percent) && (
      <div className="application-observability-meter"><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>
    )}
  </article>
);

const ApplicationObservabilityPanel = ({ application }) => {
  const { formatDate, formatNumber, formatTime, t } = useI18n();
  const applicationId = application && application.id;
  const [activeTab, setActiveTab] = useState('summary');
  const [details, setDetails] = useState(null);
  const [detailsState, setDetailsState] = useState('loading');
  const [detailsError, setDetailsError] = useState('');
  const [logs, setLogs] = useState(null);
  const [logsState, setLogsState] = useState('idle');
  const [logsError, setLogsError] = useState('');
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('all');
  const [tail, setTail] = useState(200);
  const [appliedFilters, setAppliedFilters] = useState({ query: '', level: 'all', tail: 200 });
  const [live, setLive] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const tabs = useMemo(() => [
    { id: 'summary', icon: Activity, label: t('observability.application.summary') },
    { id: 'metrics', icon: BarChart3, label: t('observability.application.metrics') },
    { id: 'logs', icon: FileText, label: t('observability.application.logs') },
    { id: 'events', icon: History, label: t('observability.application.events') }
  ], [t]);

  const loadDetails = useCallback(async ({ quiet = false } = {}) => {
    if (!applicationId) return;
    if (!quiet) setDetailsState('loading');
    try {
      const response = await apiFetch(`/api/applications/${encodeURIComponent(applicationId)}/observability`);
      setDetails(await response.json());
      setDetailsError('');
      setDetailsState('ready');
    } catch (requestError) {
      setDetailsError(requestError.message || t('observability.application.loadError'));
      setDetailsState('error');
    }
  }, [applicationId, t]);

  useEffect(() => {
    setActiveTab('summary');
    setDetails(null);
    setLogs(null);
    setLive(false);
    setAppliedFilters({ query: '', level: 'all', tail: 200 });
    setQuery('');
    setLevel('all');
    setTail(200);
    loadDetails();
  }, [applicationId, loadDetails]);

  useEffect(() => {
    const timer = window.setInterval(() => loadDetails({ quiet: true }), 30_000);
    return () => window.clearInterval(timer);
  }, [loadDetails]);

  const loadLogs = useCallback(async ({ quiet = false } = {}) => {
    if (!applicationId) return;
    if (!quiet) setLogsState('loading');
    try {
      const params = new URLSearchParams({
        tail: String(appliedFilters.tail),
        level: appliedFilters.level
      });
      if (appliedFilters.query) params.set('query', appliedFilters.query);
      const response = await apiFetch(
        `/api/applications/${encodeURIComponent(applicationId)}/logs?${params.toString()}`
      );
      setLogs(await response.json());
      setLogsError('');
      setLogsState('ready');
    } catch (requestError) {
      setLogsError(requestError.message || t('observability.application.logsError'));
      setLogsState('error');
    }
  }, [applicationId, appliedFilters, t]);

  useEffect(() => {
    if (activeTab === 'logs') loadLogs();
  }, [activeTab, loadLogs]);

  useEffect(() => {
    if (activeTab !== 'logs' || !live) return undefined;
    const timer = window.setInterval(() => loadLogs({ quiet: true }), 5_000);
    return () => window.clearInterval(timer);
  }, [activeTab, live, loadLogs]);

  const applyLogFilters = (event) => {
    event.preventDefault();
    setAppliedFilters({ query: query.trim(), level, tail: Number(tail) });
  };

  const downloadDiagnostics = async () => {
    setDownloading(true);
    try {
      const params = new URLSearchParams({ applicationId });
      const response = await apiFetch(`/api/observability/diagnostics?${params.toString()}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `foxos-application-redacted-diagnostics-${Date.now()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setDetailsError('');
    } catch (requestError) {
      setDetailsError(requestError.message || t('observability.application.diagnosticsError'));
    } finally {
      setDownloading(false);
    }
  };

  if (!application) return null;

  const runtime = details && details.runtime;
  const metrics = details && details.metrics;
  const events = details && Array.isArray(details.events) ? details.events : [];
  const healthChecks = runtime && Array.isArray(runtime.healthChecks) ? runtime.healthChecks : [];

  return (
    <section className="application-observability" data-application-observability>
      <header className="application-observability-heading">
        <div>
          <span><ShieldCheck size={12} /> {t('observability.readOnly')}</span>
          <h3>{t('observability.application.title')}</h3>
          <p>{t('observability.application.description')}</p>
        </div>
        <div className="application-observability-actions">
          <button type="button" onClick={() => loadDetails()} disabled={detailsState === 'loading'} aria-label={t('common.refresh')}>
            {detailsState === 'loading' ? <Loader2 size={14} className="is-spinning" /> : <RefreshCw size={14} />}
          </button>
          <button type="button" onClick={downloadDiagnostics} disabled={downloading}>
            {downloading ? <Loader2 size={13} className="is-spinning" /> : <Download size={13} />}
            {t('observability.application.diagnostics')}
          </button>
        </div>
      </header>

      <nav className="application-observability-tabs" aria-label={t('observability.application.title')}>
        {tabs.map(({ id, icon: Icon, label }) => (
          <button key={id} type="button" className={activeTab === id ? 'is-active' : ''} onClick={() => setActiveTab(id)}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </nav>

      {detailsError && (
        <div className="application-observability-feedback" role="status">
          <CircleAlert size={14} /> <span>{detailsError}</span>
          <button type="button" onClick={() => loadDetails()}>{t('observability.application.retry')}</button>
        </div>
      )}

      {detailsState === 'loading' && !details ? (
        <div className="application-observability-loading"><Loader2 size={16} className="is-spinning" /> {t('observability.application.loading')}</div>
      ) : (
        <>
          {activeTab === 'summary' && (
            <div className="application-observability-summary">
              <div className="application-observability-facts">
                <div><span>{t('observability.application.operationalState')}</span><strong>{stateLabel(details && details.application.operationalState, t)}</strong></div>
                <div><span>{t('observability.application.health')}</span><strong>{stateLabel(details && details.application.healthStatus, t)}</strong></div>
                <div><span>{t('observability.application.restarts')}</span><strong>{Number.isInteger(runtime && runtime.restartCount) ? formatNumber(runtime.restartCount) : t('observability.application.notAvailable')}</strong></div>
                <div><span>{t('observability.application.oomKilled')}</span><strong>{runtime ? runtime.oomKilled ? t('observability.application.yes') : t('observability.application.no') : t('observability.application.notAvailable')}</strong></div>
                <div><span>{t('observability.application.exitCode')}</span><strong>{Number.isInteger(runtime && runtime.exitCode) ? formatNumber(runtime.exitCode) : t('observability.application.notAvailable')}</strong></div>
                <div><span>{t('observability.application.startedAt')}</span><strong>{runtime && runtime.startedAt ? formatDate(runtime.startedAt, { dateStyle: 'short', timeStyle: 'short' }) : t('observability.application.notAvailable')}</strong></div>
              </div>
              <div className="application-observability-health">
                <h4>{t('observability.application.healthChecks')}</h4>
                {healthChecks.length ? healthChecks.map((check, index) => (
                  <article key={`${check.startedAt || 'check'}-${index}`} className={check.exitCode === 0 ? 'is-success' : 'is-error'}>
                    {check.exitCode === 0 ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
                    <code>{check.output || t('observability.application.notAvailable')}</code>
                    <time>{check.finishedAt ? formatTime(check.finishedAt) : t('observability.application.notAvailable')}</time>
                  </article>
                )) : <div className="application-observability-empty">{t('observability.application.noHealthChecks')}</div>}
              </div>
            </div>
          )}

          {activeTab === 'metrics' && (
            metrics ? (
              <div className="application-observability-metrics">
                <Metric icon={Cpu} label={t('observability.cpu')} value={percentText(metrics.cpu && metrics.cpu.usagePercent, formatNumber)} detail={t('observability.readOnly')} percent={metrics.cpu && metrics.cpu.usagePercent} />
                <Metric icon={MemoryStick} label={t('observability.memory')} value={percentText(metrics.memory && metrics.memory.usagePercent, formatNumber)} detail={t('observability.application.memoryLimit', { used: formatBytes(metrics.memory && metrics.memory.usageBytes, formatNumber), limit: formatBytes(metrics.memory && metrics.memory.limitBytes, formatNumber) })} percent={metrics.memory && metrics.memory.usagePercent} tone="violet" />
                <Metric icon={Gauge} label={t('observability.application.pids')} value={Number.isFinite(metrics.pids && metrics.pids.current) ? formatNumber(metrics.pids.current) : '—'} detail={t('observability.readOnly')} tone="teal" />
                <Metric icon={Network} label={t('observability.application.networkReceive')} value={formatBytes(metrics.network && metrics.network.rxBytes, formatNumber)} detail={t('observability.application.networkTransmit') + ' · ' + formatBytes(metrics.network && metrics.network.txBytes, formatNumber)} tone="green" />
                <Metric icon={HardDrive} label={t('observability.application.blockRead')} value={formatBytes(metrics.blockIo && metrics.blockIo.readBytes, formatNumber)} detail={t('observability.application.blockWrite') + ' · ' + formatBytes(metrics.blockIo && metrics.blockIo.writeBytes, formatNumber)} tone="amber" />
              </div>
            ) : (
              <div className="application-observability-empty is-large"><BarChart3 size={16} /> {t('observability.application.metricsUnavailable')}</div>
            )
          )}

          {activeTab === 'logs' && (
            <div className="application-observability-logs">
              <form onSubmit={applyLogFilters} className="application-observability-log-filters">
                <label className="application-observability-search">
                  <Search size={13} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder={t('observability.application.searchPlaceholder')} />
                </label>
                <label><span>{t('observability.application.level')}</span><select value={level} onChange={(event) => setLevel(event.target.value)}>
                  <option value="all">{t('observability.application.allLevels')}</option>
                  <option value="error">{t('observability.application.levelError')}</option>
                  <option value="warning">{t('observability.application.levelWarning')}</option>
                  <option value="info">{t('observability.application.levelInfo')}</option>
                  <option value="debug">{t('observability.application.levelDebug')}</option>
                </select></label>
                <label><span>{t('observability.application.lineLimit')}</span><select value={tail} onChange={(event) => setTail(Number(event.target.value))}>
                  {[100, 200, 500].map((value) => <option key={value} value={value}>{formatNumber(value)}</option>)}
                </select></label>
                <button type="submit"><RefreshCw size={13} /> {t('observability.application.applyFilters')}</button>
                <button type="button" className={live ? 'is-live' : ''} aria-pressed={live} onClick={() => setLive((current) => !current)}>
                  <Radio size={13} /> {t('observability.application.live')}
                </button>
              </form>
              <div className="application-observability-log-note"><ShieldCheck size={12} /> {t('observability.application.logsPrivacy')}</div>
              {logsError && <div className="application-observability-feedback"><CircleAlert size={14} /> {logsError}</div>}
              {logsState === 'loading' && !logs ? (
                <div className="application-observability-loading"><Loader2 size={15} className="is-spinning" /> {t('observability.application.logsLoading')}</div>
              ) : logs && logs.supported === false ? (
                <div className="application-observability-empty is-large"><FileText size={16} /> {t('observability.application.logsUnavailable')}</div>
              ) : logs && logs.entries && logs.entries.length ? (
                <div className="application-observability-log-view" aria-live={live ? 'polite' : 'off'}>
                  {logs.entries.map((entry, index) => (
                    <div key={`${entry.timestamp || 'log'}-${index}`} className={`is-${entry.level}`}>
                      <time>{entry.timestamp ? formatTime(entry.timestamp, { second: '2-digit' }) : '—'}</time>
                      <span>{logLevelLabel(entry.level, t)}</span>
                      <code>{entry.message}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="application-observability-empty is-large"><FileText size={16} /> {t('observability.application.logsEmpty')}</div>
              )}
            </div>
          )}

          {activeTab === 'events' && (
            events.length ? (
              <div className="application-observability-events">
                {events.map((event) => (
                  <article key={event.id}>
                    <i />
                    <div><strong>{eventLabel(event, t)}</strong><span>{event.type === 'runtime-replaced'
                      ? t('observability.runtimeReplaced')
                      : t('observability.fromTo', { from: stateLabel(event.previousValue, t), to: stateLabel(event.currentValue, t) })}</span></div>
                    <time>{formatDate(event.occurredAt, { dateStyle: 'short', timeStyle: 'short' })}</time>
                  </article>
                ))}
              </div>
            ) : (
              <div className="application-observability-empty is-large"><History size={16} /> {t('observability.application.eventsEmpty')}</div>
            )
          )}
        </>
      )}

      <footer><ShieldCheck size={12} /> {t('observability.application.readOnlyNote')}</footer>
    </section>
  );
};

export default ApplicationObservabilityPanel;
