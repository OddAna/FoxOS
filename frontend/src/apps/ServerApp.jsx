import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Box,
  CircleStop,
  Cpu,
  HardDrive,
  MemoryStick,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck
} from 'lucide-react';
import { useI18n } from '../contexts/LocaleContext';

const formatBytes = (bytes, formatNumber) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${formatNumber(bytes / (1024 ** unit), { maximumFractionDigits: unit > 1 ? 1 : 0 })} ${units[unit]}`;
};

const formatUptime = (seconds, t) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [
    days ? t('serverApp.uptimeDays', { count: days }) : null,
    hours ? t('serverApp.uptimeHours', { count: hours }) : null,
    t('serverApp.uptimeMinutes', { count: minutes })
  ].filter(Boolean).join(' ');
};

const percentage = (used, total) => total > 0 ? Math.round((used / total) * 100) : 0;

const cardStyle = {
  background: 'rgba(255,255,255,0.055)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '14px',
  padding: '16px'
};

const actionButtonStyle = {
  border: '1px solid rgba(255,255,255,0.15)',
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  borderRadius: '8px',
  padding: '7px 10px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  cursor: 'pointer',
  fontSize: '12px'
};

const MetricCard = ({ icon: Icon, label, value, detail, progress }) => (
  <div style={cardStyle}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '9px', color: '#9ca3af', fontSize: '12px', marginBottom: '10px' }}>
      <Icon size={16} />
      <span>{label}</span>
    </div>
    <div style={{ fontSize: '19px', fontWeight: 650, marginBottom: '4px' }}>{value}</div>
    <div style={{ color: '#8b93a1', fontSize: '12px' }}>{detail}</div>
    {Number.isFinite(progress) && (
      <div style={{ height: '5px', background: 'rgba(255,255,255,0.08)', borderRadius: '999px', marginTop: '12px', overflow: 'hidden' }}>
        <div style={{ width: Math.min(progress, 100) + '%', height: '100%', background: progress > 85 ? '#ff5f56' : '#38bdf8', borderRadius: '999px' }} />
      </div>
    )}
  </div>
);

const ServerApp = () => {
  const { formatNumber, t } = useI18n();
  const [system, setSystem] = useState(null);
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [activeAction, setActiveAction] = useState('');

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);

    try {
      const [systemResponse, containersResponse] = await Promise.all([
        fetch('/api/system'),
        fetch('/api/containers')
      ]);
      const systemData = await systemResponse.json();
      const containersData = await containersResponse.json();

      if (!systemResponse.ok) throw new Error(systemData.error || t('serverApp.systemError'));
      if (!containersResponse.ok) throw new Error(containersData.error || t('serverApp.dockerError'));

      setSystem(systemData);
      setContainers(containersData);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const runContainerAction = async (container, action) => {
    const actionKey = container.id + ':' + action;
    setActiveAction(actionKey);
    try {
      const response = await fetch('/api/containers/' + container.id + '/' + action, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('serverApp.containerActionError'));
      await load(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActiveAction('');
    }
  };

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#a3a3a3', background: 'rgba(16,18,22,0.96)' }}>
        <RefreshCw size={22} className="spin" />
      </div>
    );
  }

  const memoryUsage = system ? percentage(system.memory.used, system.memory.total) : 0;
  const diskUsage = system ? percentage(system.disk.used, system.disk.total) : 0;
  const runningCount = containers.filter((container) => container.state === 'running').length;

  return (
    <div className="server-app" style={{ height: '100%', overflowY: 'auto', color: '#fff', background: 'rgba(16,18,22,0.96)', padding: '24px', boxSizing: 'border-box' }}>
      <div className="server-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '22px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Server size={24} color="#38bdf8" />
            <h1 style={{ margin: 0, fontSize: '23px' }}>{system?.hostname || t('common.server')}</h1>
          </div>
          <div style={{ marginTop: '6px', color: '#8b93a1', fontSize: '13px' }}>{system?.os} · {system?.kernel}</div>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing}
          style={{ ...actionButtonStyle, opacity: refreshing ? 0.6 : 1 }}
        >
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {t('common.refresh')}
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(255,95,86,0.12)', border: '1px solid rgba(255,95,86,0.35)', color: '#ffaaa5', borderRadius: '10px', padding: '10px 12px', marginBottom: '16px', fontSize: '13px' }}>
          {error}
        </div>
      )}

      <div className="server-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        <MetricCard icon={Activity} label={t('serverApp.uptime')} value={formatUptime(system?.uptimeSeconds || 0, t)} detail={t('serverApp.load', { value: (system?.loadAverage || []).join(' / ') })} />
        <MetricCard icon={MemoryStick} label={t('serverApp.memory')} value={`${formatNumber(memoryUsage)}%`} detail={`${formatBytes(system?.memory.used, formatNumber)} / ${formatBytes(system?.memory.total, formatNumber)}`} progress={memoryUsage} />
        <MetricCard icon={HardDrive} label={t('serverApp.disk')} value={`${formatNumber(diskUsage)}%`} detail={`${formatBytes(system?.disk.used, formatNumber)} / ${formatBytes(system?.disk.total, formatNumber)}`} progress={diskUsage} />
        <MetricCard icon={Cpu} label={t('serverApp.architecture')} value={system?.architecture || '—'} detail={t('serverApp.execution', { mode: system?.executionMode || '—' })} />
      </div>

      <div className="server-section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
          <Box size={19} color="#38bdf8" />
          <h2 style={{ fontSize: '17px', margin: 0 }}>{t('serverApp.containers')}</h2>
        </div>
        <span style={{ color: '#8b93a1', fontSize: '12px' }}>{t('serverApp.containerSummary', { running: formatNumber(runningCount), total: formatNumber(containers.length) })}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
        {containers.length === 0 && (
          <div style={{ ...cardStyle, color: '#8b93a1', textAlign: 'center' }}>{t('serverApp.noContainers')}</div>
        )}

        {containers.map((container) => {
          const isRunning = container.state === 'running';
          const isBusy = activeAction.startsWith(container.id + ':');
          const portText = container.ports
            .filter((port) => port.public)
            .map((port) => port.public + ':' + port.private + '/' + port.type)
            .join(', ');

          return (
            <div key={container.id} className="server-container-row" style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', flex: '0 0 auto', background: isRunning ? '#27c93f' : '#6b7280', boxShadow: isRunning ? '0 0 12px rgba(39,201,63,0.45)' : 'none' }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <strong style={{ fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{container.name}</strong>
                  {container.protected && <ShieldCheck size={14} color="#38bdf8" aria-label={t('serverApp.protected')} />}
                </div>
                <div style={{ color: '#8b93a1', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '3px' }}>
                  {container.image} · {container.status}{portText ? ' · ' + portText : ''}
                </div>
              </div>

              {!container.protected && (
                <div className="server-container-actions" style={{ display: 'flex', gap: '6px' }}>
                  {!isRunning && (
                    <button type="button" disabled={isBusy} onClick={() => runContainerAction(container, 'start')} style={actionButtonStyle}>
                      <Play size={13} /> {t('applications.start')}
                    </button>
                  )}
                  {isRunning && (
                    <>
                      <button type="button" disabled={isBusy} onClick={() => runContainerAction(container, 'restart')} style={actionButtonStyle}>
                        <RotateCw size={13} /> {t('applications.restart')}
                      </button>
                      <button type="button" disabled={isBusy} onClick={() => runContainerAction(container, 'stop')} style={{ ...actionButtonStyle, color: '#ffaaa5' }}>
                        <CircleStop size={13} /> {t('applications.stop')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ServerApp;
