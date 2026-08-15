import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppWindow,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cpu,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import packageMetadata from '../../package.json';
import { apiFetch } from '../api';
import { useApplicationInventory } from '../contexts/ApplicationContext';
import { useI18n } from '../contexts/LocaleContext';
import { useWindowManager } from '../contexts/WindowContext';
import './GeneralSettings.css';

const formatUptime = (seconds, t) => {
  if (!Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return t('general.uptimeDays', { days, hours });
  if (hours) return t('general.uptimeHours', { hours, minutes });
  return t('general.uptimeMinutes', { minutes });
};

const FoxMark = () => (
  <svg aria-hidden="true" viewBox="0 0 100 100">
    <path d="m80 16.667h-3.333c-1.833 0-4.58 1.871-6.107 4.16l-8.336 12.506H37.78l-8.34-12.506c-1.523-2.289-4.274-4.16-6.107-4.16H20l-10 49.596c12.666 0 25.335 4.994 35 15 2.761 2.761 7.239 2.761 10 0 8.991-9.189 21.364-14.922 35-15L80 16.667ZM41.667 57.604c-5.209 2.031-11.172-.299-13.33-5.202 5.205-2.031 11.168.293 13.33 5.198v.004Zm12.75 10.814-2.998 2.998a1.998 1.998 0 0 1-2.825 0l-3.005-2.998a2.003 2.003 0 0 1 1.416-3.418h6.003a2 2 0 0 1 1.409 3.418Zm17.25-16.016c-2.158 4.899-8.118 7.229-13.334 5.198 2.162-4.905 8.125-7.229 13.334-5.198Z" />
  </svg>
);

const UpdateRow = ({ icon: Icon, tone, title, version, description, badge, badgeTone = 'neutral', action }) => (
  <article className="general-update-row">
    <span className={`general-update-icon is-${tone}`} aria-hidden="true"><Icon size={18} /></span>
    <div className="general-update-copy">
      <div>
        <strong>{title}</strong>
        <span>{version}</span>
      </div>
      <p>{description}</p>
    </div>
    <span className={`general-update-badge is-${badgeTone}`}>{badge}</span>
    {action}
  </article>
);

const GeneralSettings = ({ onNavigate = () => {} }) => {
  const { applications, loading: applicationsLoading, refreshApplications } = useApplicationInventory();
  const { formatTime, t } = useI18n();
  const { openWindow } = useWindowManager();
  const [system, setSystem] = useState(null);
  const [connections, setConnections] = useState([]);
  const [overviewState, setOverviewState] = useState('loading');
  const [overviewError, setOverviewError] = useState('');
  const [updateCheck, setUpdateCheck] = useState({ state: 'idle', checkedAt: null, results: [] });

  const updateEligibleApplications = useMemo(() => applications.filter((application) => (
    application.capabilities && application.capabilities.checkUpdates
  )), [applications]);
  const installedCliCount = useMemo(() => connections.filter((connection) => (
    ['codex', 'antigravity-cli', 'gemini-cli'].includes(connection.id) && connection.installed
  )).length, [connections]);

  const loadOverview = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setOverviewState('loading');
    else setOverviewState('refreshing');
    try {
      const [systemResponse, connectionsResponse] = await Promise.all([
        apiFetch('/api/system'),
        apiFetch('/api/connections')
      ]);
      const [systemPayload, connectionPayload] = await Promise.all([
        systemResponse.json(),
        connectionsResponse.json()
      ]);
      setSystem(systemPayload);
      setConnections(Array.isArray(connectionPayload.connections) ? connectionPayload.connections : []);
      setOverviewError('');
      setOverviewState('ready');
    } catch (error) {
      setOverviewError(error.message || t('general.overviewError'));
      setOverviewState('error');
    }
  }, [t]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const refreshOverview = async () => {
    await Promise.allSettled([
      loadOverview({ quiet: true }),
      refreshApplications({ quiet: true })
    ]);
  };

  const checkApplicationUpdates = async () => {
    if (!updateEligibleApplications.length || updateCheck.state === 'checking') return;
    setUpdateCheck((current) => ({ ...current, state: 'checking' }));
    const checked = await Promise.allSettled(updateEligibleApplications.map(async (application) => {
      const response = await apiFetch(`/api/applications/${application.id}/update-check`);
      const payload = await response.json();
      return {
        applicationId: application.id,
        name: application.name,
        update: payload.update || null
      };
    }));
    const results = checked.map((result, index) => result.status === 'fulfilled'
      ? result.value
      : {
          applicationId: updateEligibleApplications[index].id,
          name: updateEligibleApplications[index].name,
          error: result.reason && result.reason.message || t('general.checkFailed')
        });
    setUpdateCheck({ state: 'complete', checkedAt: new Date().toISOString(), results });
  };

  const availableUpdates = updateCheck.results.filter((result) => result.update && result.update.updateAvailable === true);
  const failedUpdateChecks = updateCheck.results.filter((result) => result.error);
  const unknownUpdateChecks = updateCheck.results.filter((result) => (
    result.update && result.update.updateAvailable === null
  ));
  const applicationUpdateBadge = updateCheck.state === 'checking'
    ? t('general.checking')
    : availableUpdates.length
      ? t('general.updateCount', { count: availableUpdates.length })
      : updateCheck.state === 'complete' && !failedUpdateChecks.length && !unknownUpdateChecks.length
        ? t('general.allCurrent')
        : updateCheck.state === 'complete'
          ? t('general.resultCount', { count: updateCheck.results.length })
          : t('general.notChecked');
  const applicationUpdateTone = availableUpdates.length
    ? 'warning'
    : updateCheck.state === 'complete' && !failedUpdateChecks.length && !unknownUpdateChecks.length
      ? 'success'
      : 'neutral';

  const checkedAt = updateCheck.checkedAt ? formatTime(updateCheck.checkedAt) : null;
  const isRefreshing = overviewState === 'refreshing';
  const openServerApp = () => openWindow({
    id: 'server',
    type: 'server',
    title: t('common.server'),
    component: null,
    width: 1050,
    height: 680
  });

  return (
    <div className="general-settings">
      <section className="general-hero">
        <div className="general-hero-identity">
          <span className="general-fox-mark"><FoxMark /></span>
          <div>
            <span className="general-kicker"><Sparkles size={12} /> {t('general.kicker')}</span>
            <h3>{t('general.heroTitle')}</h3>
            <p>{t('general.heroDescription')}</p>
          </div>
        </div>
        <div className="general-hero-status">
          <strong>FoxOS <span>v{packageMetadata.version} {t('general.releaseAlpha')}</span></strong>
          <em className={overviewState === 'error' ? 'is-error' : ''}>
            <i aria-hidden="true" /> {overviewState === 'error'
              ? t('general.systemUnavailable')
              : overviewState === 'loading' ? t('general.systemLoading') : t('general.systemRunning')}
          </em>
          <button type="button" onClick={refreshOverview} disabled={isRefreshing}>
            <RefreshCw size={12} className={isRefreshing ? 'is-spinning' : ''} /> {t('common.refresh')}
          </button>
        </div>
      </section>

      {overviewError && (
        <div className="general-feedback is-error" role="status">
          <CircleAlert size={15} /> {overviewError}
          <button type="button" onClick={() => loadOverview()}>{t('common.retry')}</button>
        </div>
      )}

      <section className="general-section general-update-center">
        <header className="general-section-heading">
          <div>
            <span className="general-section-kicker"><ShieldCheck size={13} /> {t('general.updateKicker')}</span>
            <h3>{t('general.updateTitle')}</h3>
            <p>{t('general.updateDescription')}</p>
          </div>
          <button
            type="button"
            className="general-primary-button"
            onClick={checkApplicationUpdates}
            disabled={applicationsLoading || !updateEligibleApplications.length || updateCheck.state === 'checking'}
          >
            {updateCheck.state === 'checking' ? <Loader2 size={14} className="is-spinning" /> : <RefreshCw size={14} />}
            {updateCheck.state === 'checking' ? t('general.checking') : t('general.checkApplications')}
          </button>
        </header>

        <div className="general-update-list">
          <UpdateRow
            icon={FoxMark}
            tone="fox"
            title="FoxOS"
            version={`v${packageMetadata.version} alpha`}
            description={t('general.coreDescription')}
            badge={t('general.manualChannel')}
          />
          <UpdateRow
            icon={AppWindow}
            tone="apps"
            title={t('general.applications')}
            version={t('general.eligibleApplications', { count: updateEligibleApplications.length })}
            description={checkedAt ? t('general.lastCheckToday', { time: checkedAt }) : t('general.compareImages')}
            badge={applicationUpdateBadge}
            badgeTone={applicationUpdateTone}
            action={(
              <button type="button" className="general-row-action" onClick={() => onNavigate('applications')}>
                {t('common.manage')} <ChevronRight size={14} />
              </button>
            )}
          />
          <UpdateRow
            icon={Bot}
            tone="cli"
            title={t('general.aiTools')}
            version={t('general.cliInstalled', { count: installedCliCount })}
            description={t('general.cliDescription')}
            badge={t('common.connections')}
            action={(
              <button type="button" className="general-row-action" onClick={() => onNavigate('connections')}>
                {t('common.open')} <ChevronRight size={14} />
              </button>
            )}
          />
        </div>

        {updateCheck.state === 'complete' && (
          <div className={`general-update-result${availableUpdates.length ? ' is-warning' : failedUpdateChecks.length || unknownUpdateChecks.length ? ' is-neutral' : ' is-success'}`} aria-live="polite">
            {availableUpdates.length ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}
            <span>
              {availableUpdates.length
                ? t('general.updatesFound', { names: availableUpdates.map((result) => result.name).join(', ') })
                : failedUpdateChecks.length || unknownUpdateChecks.length
                  ? t('general.checksUncertain', { count: updateCheck.results.length, uncertain: failedUpdateChecks.length + unknownUpdateChecks.length })
                  : t('general.allAppsCurrent', { count: updateCheck.results.length })}
            </span>
            {availableUpdates.length > 0 && (
              <button type="button" onClick={() => onNavigate('applications')}>{t('general.details')}</button>
            )}
          </div>
        )}
      </section>

      <div className="general-lower-grid">
        <section className="general-section general-system-card">
          <header className="general-section-heading is-compact">
            <div>
              <span className="general-section-kicker"><Server size={13} /> {t('general.serverKicker')}</span>
              <h3>{system && system.hostname || t('general.systemInfo')}</h3>
              <p>{t('general.serverDescription')}</p>
            </div>
          </header>

          <div className="general-system-facts">
            <div><span><Server size={14} /> {t('general.operatingSystem')}</span><strong>{system && system.os || '—'}</strong></div>
            <div><span><Cpu size={14} /> {t('general.architecture')}</span><strong>{system && system.architecture || '—'}</strong></div>
            <div><span><Clock3 size={14} /> {t('general.uptime')}</span><strong>{formatUptime(system && system.uptimeSeconds, t)}</strong></div>
            <div><span><HardDrive size={14} /> {t('general.execution')}</span><strong>{system && system.executionMode || '—'}</strong></div>
          </div>

          <button type="button" className="general-system-link" onClick={openServerApp}>
            <span><ShieldCheck size={15} /> {t('general.openServerDetails')}</span>
            <ChevronRight size={14} />
          </button>
        </section>
      </div>
    </div>
  );
};

export default GeneralSettings;
