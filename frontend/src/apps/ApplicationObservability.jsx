import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Gauge,
  HardDrive,
  Loader2,
  Network,
  RefreshCw,
  ScrollText
} from 'lucide-react';
import { apiFetch } from '../api';
import {
  formatBytes,
  formatObservedTime,
  formatPercent,
  healthStateLabel,
  healthStateTone
} from '../utils/applicationObservability';
import './ApplicationObservability.css';

const METRIC_REFRESH_MS = 15000;

const metricCards = (metrics) => [
  {
    id: 'cpu',
    icon: Cpu,
    label: 'CPU',
    value: formatPercent(metrics.cpuPercent),
    detail: 'Anlık container kullanımı'
  },
  {
    id: 'memory',
    icon: Gauge,
    label: 'Bellek',
    value: formatBytes(metrics.memoryUsageBytes),
    detail: metrics.memoryLimitBytes > 0
      ? `${formatPercent(metrics.memoryPercent)} · ${formatBytes(metrics.memoryLimitBytes)} limit`
      : 'Limit bildirilmedi'
  },
  {
    id: 'pids',
    icon: Activity,
    label: 'Process',
    value: metrics.pids.toLocaleString('tr-TR'),
    detail: metrics.pidsLimit ? `${metrics.pidsLimit.toLocaleString('tr-TR')} PID limit` : 'PID limiti yok'
  },
  {
    id: 'network',
    icon: Network,
    label: 'Ağ',
    value: `↓ ${formatBytes(metrics.networkRxBytes)}`,
    detail: `↑ ${formatBytes(metrics.networkTxBytes)}`
  },
  {
    id: 'disk',
    icon: HardDrive,
    label: 'Disk I/O',
    value: `↓ ${formatBytes(metrics.blockReadBytes)}`,
    detail: `↑ ${formatBytes(metrics.blockWriteBytes)}`
  }
];

const ApplicationObservability = ({ application }) => {
  const [observability, setObservability] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const requestSequence = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await apiFetch(
        `/api/applications/${encodeURIComponent(application.id)}/observability?tail=160`
      );
      const payload = await response.json();
      if (requestSequence.current !== sequence) return;
      setObservability(payload.observability);
      setError(null);
    } catch (loadError) {
      if (requestSequence.current === sequence) setError(loadError.message);
    } finally {
      if (requestSequence.current === sequence) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [application.id]);

  useEffect(() => {
    setObservability(null);
    setError(null);
    load().catch(() => {});
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') load({ quiet: true }).catch(() => {});
    }, METRIC_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      requestSequence.current += 1;
    };
  }, [load]);

  const health = observability && observability.health;
  const history = observability && observability.history || [];
  const metrics = observability && observability.metrics && observability.metrics.sample;
  const logs = observability && observability.logs;
  const alerts = observability && observability.alerts || [];
  const tone = healthStateTone(health);

  return (
    <section className="application-observability" data-application-observability>
      <div className="application-observability-heading">
        <div>
          <h3>Gözlem</h3>
          <p>Salt-okunur sağlık, kaynak kullanımı ve sunucu tarafında filtrelenen container logları.</p>
        </div>
        <button
          type="button"
          onClick={() => load({ quiet: true })}
          disabled={loading || refreshing}
          aria-label="Gözlem verisini yenile"
        >
          <RefreshCw size={14} className={loading || refreshing ? 'spin' : ''} />
          Yenile
        </button>
      </div>

      {loading && !observability ? (
        <div className="application-observability-placeholder">
          <Loader2 size={18} className="spin" /> Gözlem verisi okunuyor...
        </div>
      ) : error && !observability ? (
        <div className="application-observability-error" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => load()}>Tekrar Dene</button>
        </div>
      ) : observability ? (
        <>
          {error && (
            <div className="application-observability-stale" role="status">
              Son yenileme başarısız oldu; önceki doğrulanmış gözlem korunuyor: {error}
            </div>
          )}

          <div className="application-health-summary">
            <div className={`application-health-state is-${tone}`}>
              <span aria-hidden="true" />
              <strong>{healthStateLabel(health)}</strong>
            </div>
            <div className="application-health-facts">
              <span>Son gözlem {formatObservedTime(observability.generatedAt)}</span>
              {Number.isInteger(health && health.restartCount) && (
                <span>{health.restartCount} yeniden başlatma</span>
              )}
              {Number.isInteger(health && health.exitCode) && health.operationalState !== 'running' && (
                <span>Çıkış kodu {health.exitCode}</span>
              )}
            </div>
          </div>

          <div className="application-alerts" aria-live="polite">
            {alerts.length ? alerts.map((alert) => (
              <div key={alert.code} className={`application-alert is-${alert.severity}`}>
                <AlertTriangle size={16} />
                <div><strong>{alert.title}</strong><span>{alert.message}</span></div>
              </div>
            )) : (
              <div className="application-alert is-clear">
                <CheckCircle2 size={16} />
                <div><strong>Aktif uyarı yok</strong><span>Son gözlemde eylem gerektiren bir durum bulunmadı.</span></div>
              </div>
            )}
          </div>

          {metrics ? (
            <div className="application-metric-grid">
              {metricCards(metrics).map((metric) => {
                const Icon = metric.icon;
                return (
                  <div className="application-metric-card" key={metric.id}>
                    <div className="application-metric-label"><Icon size={15} /> {metric.label}</div>
                    <strong>{metric.value}</strong>
                    <span>{metric.detail}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="application-observability-note">
              {observability.metrics && observability.metrics.reason || observability.reason}
            </div>
          )}

          <div className="application-observability-block">
            <div className="application-observability-block-title">
              <Activity size={15} />
              <div><strong>Sağlık geçmişi</strong><span>Değişimler ve 15 dakikalık doğrulama noktaları</span></div>
            </div>
            {history.length ? (
              <div className="application-health-timeline" aria-label="Uygulama sağlık geçmişi">
                {history.slice(-96).map((sample, index) => (
                  <span
                    key={`${sample.observedAt}-${index}`}
                    className={`is-${healthStateTone(sample)}`}
                    title={`${formatObservedTime(sample.observedAt, true)} · ${healthStateLabel(sample)}`}
                  />
                ))}
              </div>
            ) : (
              <div className="application-observability-empty">Henüz sağlık geçmişi oluşmadı.</div>
            )}
          </div>

          <div className="application-observability-block">
            <div className="application-observability-block-title">
              <ScrollText size={15} />
              <div>
                <strong>Son container logları</strong>
                <span>En fazla 160 satır · bilinen ve yaygın kimlik bilgisi desenleri yanıttan önce gizlenir</span>
              </div>
            </div>
            {logs && logs.available && logs.lines.length ? (
              <div className="application-log-view" role="log" aria-live="off">
                {logs.lines.map((line, index) => (
                  <div className={`application-log-line is-${line.stream}`} key={`${line.timestamp || 'line'}-${index}`}>
                    <time>{line.timestamp ? formatObservedTime(line.timestamp) : '—'}</time>
                    <span>{line.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="application-observability-empty">
                {logs && logs.reason || 'Gösterilecek container logu bulunamadı.'}
              </div>
            )}
            {logs && (logs.redacted || logs.truncated) && (
              <div className="application-log-notice">
                {logs.redacted ? `${logs.redactionCount} hassas değer gizlendi.` : ''}
                {logs.redacted && logs.truncated ? ' ' : ''}
                {logs.truncated ? 'Çıktı güvenli görüntüleme sınırında kesildi.' : ''}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
};

export default ApplicationObservability;
