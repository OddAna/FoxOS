import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, RefreshCw } from 'lucide-react';
import { apiFetch } from '../api';
import { useI18n } from '../contexts/LocaleContext';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function periodLabel(window, t) {
  if (window.period === 'weekly') return t('cliUsage.weekly');
  if (window.period === 'five-hour') return t('cliUsage.fiveHours');
  if (window.periodLabel) return window.periodLabel;
  if (Number.isInteger(window.durationMinutes)) {
    if (window.durationMinutes % (24 * 60) === 0) return t('cliUsage.days', { count: window.durationMinutes / (24 * 60) });
    if (window.durationMinutes % 60 === 0) return t('cliUsage.hours', { count: window.durationMinutes / 60 });
    return t('cliUsage.minutes', { count: window.durationMinutes });
  }
  return t('cliUsage.period');
}

function resetLabel(value, t, formatDate) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return t('cliUsage.unknownReset');
  return t('cliUsage.resetsAt', {
    date: formatDate(date, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  });
}

function fetchedLabel(value, t, formatDate) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return t('cliUsage.neverUpdated');
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return t('cliUsage.justUpdated');
  if (minutes < 60) return t('cliUsage.updatedMinutesAgo', { count: minutes });
  return t('cliUsage.updatedAt', {
    date: formatDate(timestamp, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  });
}

function statusLabel(provider, t) {
  if (provider.status === 'not-installed') return t('cliUsage.notInstalled');
  if (provider.status === 'not-connected') return t('cliUsage.notConnected');
  if (provider.status === 'unavailable') return t('cliUsage.unavailable');
  return '';
}

function severityClass(remainingPercent) {
  if (remainingPercent <= 20) return ' is-critical';
  if (remainingPercent <= 40) return ' is-low';
  return '';
}

function UsageProvider({ provider }) {
  const { formatDate, t } = useI18n();
  const groups = useMemo(() => {
    const result = [];
    const byName = new Map();
    for (const window of provider.windows || []) {
      const name = window.group || provider.name;
      if (!byName.has(name)) {
        const group = { name, windows: [] };
        byName.set(name, group);
        result.push(group);
      }
      byName.get(name).windows.push(window);
    }
    return result;
  }, [provider]);

  return (
    <article className={`cli-usage-provider${provider.status === 'ready' ? ' is-ready' : ''}`}>
      <header>
        <strong>{provider.name}</strong>
        <span>{provider.status === 'ready' ? t('cliUsage.connected') : statusLabel(provider, t)}</span>
      </header>
      {provider.status !== 'ready' ? (
        <div className="cli-usage-provider-empty">{statusLabel(provider, t)}</div>
      ) : groups.map((group) => (
        <section className="cli-usage-group" key={group.name}>
          <h3>{group.name}</h3>
          {group.windows.map((window) => (
            <div className={`cli-usage-window${severityClass(window.remainingPercent)}`} key={window.id}>
              <div className="cli-usage-window-copy">
                <span>{periodLabel(window, t)}</span>
                <small>{resetLabel(window.resetsAt, t, formatDate)}</small>
              </div>
              <strong>%{window.remainingPercent}</strong>
              <div className="cli-usage-meter" aria-hidden="true">
                <span style={{ width: `${window.remainingPercent}%` }} />
              </div>
            </div>
          ))}
        </section>
      ))}
    </article>
  );
}

const CliUsageMenu = () => {
  const { formatDate, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef(null);
  const popoverRef = useRef(null);

  const load = useCallback(async ({ force = false, quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    if (force) setRefreshing(true);
    try {
      const response = await apiFetch(force ? '/api/cli-usage/refresh' : '/api/cli-usage', {
        ...(force ? { method: 'POST' } : {})
      });
      const payload = await response.json();
      setUsage(payload);
      setError('');
    } catch (requestError) {
      setError(requestError.message || t('cliUsage.loadError'));
    } finally {
      if (!quiet) setLoading(false);
      if (force) setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    load();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') load({ quiet: true });
    };
    document.addEventListener('visibilitychange', handleVisibility);
    const timer = window.setInterval(() => load({ quiet: true }), POLL_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeWithEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeWithEscape);
    };
  }, [open]);

  const remaining = Number.isInteger(usage?.summary?.minimumRemainingPercent)
    ? usage.summary.minimumRemainingPercent
    : null;
  const triggerLabel = remaining === null
    ? t('cliUsage.trigger')
    : t('cliUsage.triggerRemaining', { percent: remaining });

  return (
    <div className="cli-usage-menu" ref={rootRef}>
      <button
        type="button"
        className={`topbar-item topbar-cli-usage-trigger${remaining === null ? '' : severityClass(remaining)}`}
        title={triggerLabel}
        aria-label={triggerLabel}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
          if (!open) load({ quiet: true });
        }}
      >
        <Gauge size={15} aria-hidden="true" />
        <span aria-live="polite">{remaining === null ? '–' : `%${remaining}`}</span>
      </button>

      {open && createPortal(
        <section
          className="cli-usage-popover"
          ref={popoverRef}
          aria-label={t('cliUsage.label')}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="cli-usage-popover-header">
            <div>
              <strong>{t('cliUsage.title')}</strong>
              <span>{fetchedLabel(usage?.fetchedAt, t, formatDate)}</span>
            </div>
            <button
              type="button"
              onClick={() => load({ force: true, quiet: true })}
              disabled={refreshing}
              title={t('cliUsage.refreshTitle')}
              aria-label={t('cliUsage.refreshTitle')}
            >
              <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" />
              <span>{t('cliUsage.refresh')}</span>
            </button>
          </header>
          <div className="cli-usage-popover-body">
            {loading && !usage && <div className="cli-usage-empty">{t('cliUsage.loading')}</div>}
            {!loading && !usage && error && <div className="cli-usage-empty is-error">{error}</div>}
            {usage && error && <div className="cli-usage-inline-error">{error}</div>}
            {(usage?.providers || []).map((provider) => (
              <UsageProvider provider={provider} key={provider.id} />
            ))}
            {usage && !(usage.providers || []).length && (
              <div className="cli-usage-empty">{t('cliUsage.empty')}</div>
            )}
          </div>
        </section>,
        document.body
      )}
    </div>
  );
};

export default CliUsageMenu;
