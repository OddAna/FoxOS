import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Check,
  Code,
  Compass,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileText,
  Film,
  Globe,
  Loader2,
  MoreVertical,
  Play,
  RotateCw,
  Search,
  Save,
  Server,
  Settings,
  Square,
  Terminal,
  Trash2,
  Wrench
} from 'lucide-react';
import { useDialog } from '../contexts/DialogContext';
import { apiFetch } from '../api';

const CATEGORIES = [
  { id: 'kesfet', name: 'Keşfet', icon: <Compass size={18} /> },
  { id: 'gelistirici', name: 'Geliştirici Araçları', icon: <Code size={18} /> },
  { id: 'diller', name: 'Programlama Dilleri', icon: <Terminal size={18} /> },
  { id: 'veritabani', name: 'Veritabanları', icon: <Database size={18} /> },
  { id: 'devops', name: 'DevOps', icon: <Terminal size={18} /> },
  { id: 'guncellemeler', name: 'Güncellemeler', icon: <RotateCw size={18} /> },
  { id: 'medya', name: 'Medya ve Eğlence', icon: <Film size={18} /> },
  { id: 'webapp', name: 'Web Uygulamaları', icon: <Globe size={18} /> }
];

const APP_VISUALS = {
  'uptime-kuma': {
    featured: true,
    banner: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
    icon: <Activity size={38} color="#10b981" />
  },
  dozzle: { icon: <Terminal size={38} color="#3b82f6" /> },
  'it-tools': { icon: <Wrench size={38} color="#f59e0b" /> },
  'stirling-pdf': { icon: <FileText size={38} color="#ef4444" /> }
};
const DEFAULT_APP_LOGO = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/docker.svg';

const decorateApp = (app) => ({
  ...app,
  developer: app.publisher,
  appType: 'webapp',
  ...APP_VISUALS[app.id]
});

const copyText = async (value) => {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Adres kopyalanamadı');
};

const AppLogo = ({ app, size = 40 }) => {
  const [sourceIndex, setSourceIndex] = useState(0);
  const logoSources = [app.logoUrl, DEFAULT_APP_LOGO].filter((source, index, sources) => (
    source && sources.indexOf(source) === index
  ));

  useEffect(() => {
    setSourceIndex(0);
  }, [app.logoUrl]);

  if (logoSources[sourceIndex]) {
    return (
      <img
        src={logoSources[sourceIndex]}
        alt={`${app.name} logosu`}
        onError={() => setSourceIndex((current) => current + 1)}
        style={{ width: size, height: size, objectFit: 'contain', display: 'block' }}
      />
    );
  }

  return app.icon || <Server size={size} color="#0ea5e9" />;
};

const AppStoreApp = () => {
  const [activeCategory, setActiveCategory] = useState('kesfet');
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState({});
  const [uninstalling, setUninstalling] = useState({});
  const [actionRunning, setActionRunning] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMenu, setActiveMenu] = useState(null);
  const [settingsAppId, setSettingsAppId] = useState(null);
  const [settingsAppSnapshot, setSettingsAppSnapshot] = useState(null);
  const [containerSettings, setContainerSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [restartPolicy, setRestartPolicy] = useState('no');
  const [settingsMessage, setSettingsMessage] = useState(null);
  const { showDialog } = useDialog();

  const loadApps = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await apiFetch('/api/apps');
      const payload = await response.json();
      setApps((payload.apps || []).map(decorateApp));
    } catch (error) {
      if (!quiet) {
        showDialog({ title: 'Mağaza Hatası', message: error.message, type: 'error' });
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [showDialog]);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  useEffect(() => {
    const refreshTimer = window.setInterval(() => loadApps({ quiet: true }), 15000);
    return () => window.clearInterval(refreshTimer);
  }, [loadApps]);

  useEffect(() => {
    const closeMenu = (event) => {
      if (event.target.closest?.('[data-app-menu]')) return;
      setActiveMenu(null);
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('contextmenu', closeMenu, { capture: true });
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('contextmenu', closeMenu, { capture: true });
    };
  }, []);

  useEffect(() => {
    const containerId = settingsAppSnapshot && settingsAppSnapshot.containerId;
    if (!settingsAppId || !containerId) return undefined;

    let active = true;
    setSettingsLoading(true);
    setSettingsMessage(null);
    apiFetch(`/api/containers/${containerId}/settings`)
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setContainerSettings(payload.settings);
        setRestartPolicy(payload.settings.restartPolicy);
      })
      .catch((error) => {
        if (active) setSettingsMessage({ type: 'error', text: error.message });
      })
      .finally(() => {
        if (active) setSettingsLoading(false);
      });

    return () => { active = false; };
  }, [settingsAppId, settingsAppSnapshot]);

  const handleInstall = async (event, app) => {
    event.stopPropagation();
    setInstalling((current) => ({ ...current, [app.id]: true }));
    try {
      await apiFetch(`/api/apps/${app.id}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostPort: app.defaultPort, bindAddress: '127.0.0.1' })
      });
      await loadApps({ quiet: true });
      showDialog({
        title: 'Yüklendi',
        message: `${app.name} sunucuya kuruldu. Uygulama portu güvenlik için yalnızca sunucunun kendisine bağlandı.`,
        type: 'success'
      });
    } catch (error) {
      showDialog({ title: 'Kurulum Hatası', message: error.message, type: 'error' });
    } finally {
      setInstalling((current) => ({ ...current, [app.id]: false }));
    }
  };

  const runAction = async (event, app, action, { inline = false } = {}) => {
    event.stopPropagation();
    setActiveMenu(null);
    setActionRunning((current) => ({ ...current, [app.id]: action }));
    if (inline) setSettingsMessage(null);
    try {
      const actionPath = app.managedByFoxOS
        ? `/api/apps/${app.id}/${action}`
        : `/api/containers/${app.containerId}/${action}`;
      await apiFetch(actionPath, { method: 'POST' });
      await loadApps({ quiet: true });
      if (inline) {
        const labels = { start: 'başlatıldı', stop: 'durduruldu', restart: 'yeniden başlatıldı' };
        setSettingsMessage({ type: 'success', text: `${app.name} ${labels[action]}.` });
      }
    } catch (error) {
      if (inline) {
        setSettingsMessage({ type: 'error', text: error.message });
      } else {
        showDialog({ title: 'İşlem Hatası', message: error.message, type: 'error' });
      }
    } finally {
      setActionRunning((current) => ({ ...current, [app.id]: null }));
    }
  };

  const handleUninstall = (event, app) => {
    event.stopPropagation();
    setActiveMenu(null);
    showDialog({
      title: `${app.name} Kaldırılsın mı?`,
      message: 'Uygulama containerı kaldırılacak. Kalıcı uygulama verileri korunacak.',
      type: 'warning',
      confirmText: 'Kaldır',
      onConfirm: async () => {
        setUninstalling((current) => ({ ...current, [app.id]: true }));
        try {
          await apiFetch(`/api/apps/${app.id}?removeData=false`, { method: 'DELETE' });
          await loadApps({ quiet: true });
        } catch (error) {
          showDialog({ title: 'Kaldırma Hatası', message: error.message, type: 'error' });
        } finally {
          setUninstalling((current) => ({ ...current, [app.id]: false }));
        }
      }
    });
  };

  const handleOpenApp = (event, app) => {
    event.stopPropagation();
    if (app.state !== 'running') {
      showDialog({ title: 'Servis Kapalı', message: 'Bu uygulamayı açmak için önce servisi başlatın.', type: 'warning' });
      return;
    }
    if (app.externalUrl) {
      window.open(app.externalUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    if (!app.hostPort) {
      showDialog({ title: 'Port Bulunamadı', message: 'Docker yayın portu okunamadı.', type: 'error' });
      return;
    }

    const localFoxOS = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
    if (app.bindAddress === '127.0.0.1' && !localFoxOS) {
      showDialog({
        title: 'Özel Erişim',
        message: `Bu uygulama güvenlik için 127.0.0.1:${app.hostPort} üzerinde çalışıyor. Aynı portu SSH tüneliyle açın.`,
        type: 'info'
      });
      return;
    }

    const hostname = app.bindAddress === '127.0.0.1' ? '127.0.0.1' : window.location.hostname;
    window.open(`http://${hostname}:${app.hostPort}`, '_blank', 'noopener,noreferrer');
  };

  const handleSettings = (event, app) => {
    event.stopPropagation();
    setActiveMenu(null);
    setSettingsAppId(app.id);
    setSettingsAppSnapshot(app);
    setContainerSettings(null);
    setSettingsMessage(null);
  };

  const closeSettings = () => {
    setSettingsAppId(null);
    setSettingsAppSnapshot(null);
    setContainerSettings(null);
    setSettingsMessage(null);
  };

  const saveContainerSettings = async () => {
    if (!settingsAppSnapshot || !settingsAppSnapshot.containerId) return;
    setSettingsSaving(true);
    setSettingsMessage(null);
    try {
      const response = await apiFetch(`/api/containers/${settingsAppSnapshot.containerId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restartPolicy })
      });
      const payload = await response.json();
      setContainerSettings(payload.settings);
      setRestartPolicy(payload.settings.restartPolicy);
      setSettingsMessage({ type: 'success', text: 'Ayar kaydedildi.' });
    } catch (error) {
      setSettingsMessage({ type: 'error', text: error.message });
    } finally {
      setSettingsSaving(false);
    }
  };

  const displayedApps = useMemo(() => {
    if (searchQuery) {
      const query = searchQuery.toLocaleLowerCase('tr-TR');
      return apps.filter((app) => `${app.name} ${app.description}`.toLocaleLowerCase('tr-TR').includes(query));
    }

    const filters = {
      gelistirici: (app) => app.category === 'Utilities',
      diller: () => false,
      veritabani: () => false,
      devops: (app) => ['Monitoring', 'Docker'].includes(app.category),
      guncellemeler: (app) => app.installed,
      medya: (app) => app.category === 'Documents',
      webapp: () => true
    };
    return activeCategory === 'kesfet' ? apps : apps.filter(filters[activeCategory] || (() => true));
  }, [activeCategory, apps, searchQuery]);

  const featuredApp = apps.find((app) => app.featured);
  const settingsApp = settingsAppId
    ? apps.find((app) => app.id === settingsAppId) || settingsAppSnapshot
    : null;

  const settingsAccessUrl = settingsApp ? (() => {
    if (settingsApp.externalUrl) return settingsApp.externalUrl;
    const configuredPort = containerSettings && containerSettings.ports && containerSettings.ports[0];
    const hostPort = settingsApp.hostPort || (configuredPort && configuredPort.hostPort);
    if (!hostPort) return null;
    const bindAddress = settingsApp.bindAddress || (configuredPort && configuredPort.hostIp);
    const hostname = bindAddress === '127.0.0.1' ? '127.0.0.1' : window.location.hostname;
    return `http://${hostname}:${hostPort}`;
  })() : null;

  const managementSource = settingsApp
    ? settingsApp.managedByFoxOS
      ? 'FoxOS'
      : settingsApp.installationSource === 'coolify' ? 'Coolify' : 'Docker'
    : null;

  const renderServiceMenu = (app, suffix) => (
    <>
      <div
        style={{
          width: suffix === 'featured' ? '10px' : '8px',
          height: suffix === 'featured' ? '10px' : '8px',
          borderRadius: '50%',
          background: app.state === 'running' ? '#27c93f' : actionRunning[app.id] ? '#ffbd2e' : '#ff5f56',
          boxShadow: '0 2px 5px rgba(0,0,0,0.5)'
        }}
        title={`Durum: ${app.state}`}
      />
      <button
        type="button"
        data-app-menu
        aria-label={`${app.name} seçenekleri`}
        title={`${app.name} seçenekleri`}
        onClick={(event) => {
          event.stopPropagation();
          const menuId = `${app.id}-${suffix}`;
          setActiveMenu(activeMenu === menuId ? null : menuId);
        }}
        style={{
          background: 'transparent', color: suffix === 'featured' ? '#fff' : '#888',
          border: '1px solid rgba(255,255,255,0.2)', padding: suffix === 'featured' ? '6px' : '4px',
          borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}
      >
        <MoreVertical size={suffix === 'featured' ? 16 : 14} />
      </button>
      {activeMenu === `${app.id}-${suffix}` && (
        <div data-app-menu style={{ position: 'absolute', top: suffix === 'featured' ? '100%' : 'auto', bottom: suffix === 'featured' ? 'auto' : '100%', right: suffix === 'featured' ? '90px' : '70px', background: 'rgba(30, 30, 35, 0.95)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '4px', zIndex: 10, minWidth: '150px', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
          <div onClick={(event) => handleOpenApp(event, app)} style={{ padding: '8px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px' }} className="menu-item"><ExternalLink size={14} /> Aç</div>
          {app.state === 'running' ? (
            <div onClick={(event) => runAction(event, app, 'stop')} style={{ padding: '8px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px' }} className="menu-item"><Square size={14} /> Durdur</div>
          ) : (
            <div onClick={(event) => runAction(event, app, 'start')} style={{ padding: '8px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px' }} className="menu-item"><Play size={14} /> Başlat</div>
          )}
          <div onClick={(event) => runAction(event, app, 'restart')} style={{ padding: '8px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px' }} className="menu-item"><RotateCw size={14} /> Yeniden Başlat</div>
          <div onClick={(event) => handleSettings(event, app)} style={{ padding: '8px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px' }} className="menu-item"><Settings size={14} /> Ayarlar</div>
          {app.managedByFoxOS && (
            <>
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
              <div onClick={(event) => handleUninstall(event, app)} style={{ padding: '8px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px', color: '#ff5f56' }} className="menu-item"><Trash2 size={14} /> Sil</div>
            </>
          )}
        </div>
      )}
    </>
  );

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', color: '#fff', background: 'rgba(20, 20, 25, 0.95)', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
      <div style={{ width: '220px', flex: '0 0 220px', background: 'rgba(255,255,255,0.03)', borderRight: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', paddingTop: '20px' }}>
        <div style={{ padding: '0 15px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.08)', borderRadius: '8px', padding: '6px 10px' }}>
            <Search size={16} color="#888" style={{ marginRight: '8px' }} />
            <input
              type="text"
              placeholder="Ara..."
              value={searchQuery}
              onChange={(event) => {
                closeSettings();
                setSearchQuery(event.target.value);
              }}
              style={{ background: 'transparent', border: 'none', color: '#fff', outline: 'none', width: '100%', fontSize: '13px' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '0 10px' }}>
          <div style={{ fontSize: '11px', color: '#888', fontWeight: 'bold', padding: '8px 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Kategoriler</div>
          {CATEGORIES.map((category) => (
            <div
              key={category.id}
              onClick={() => {
                closeSettings();
                setActiveCategory(category.id);
                setSearchQuery('');
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '6px', cursor: 'pointer',
                background: activeCategory === category.id && !searchQuery ? '#0ea5e9' : 'transparent',
                color: activeCategory === category.id && !searchQuery ? '#fff' : '#ccc',
                transition: 'background 0.2s', fontSize: '14px'
              }}
            >
              {category.icon}
              {category.name}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '0 0 40px 0' }}>
        {settingsApp ? (
          <div style={{ padding: '30px 40px' }}>
            <button
              type="button"
              onClick={closeSettings}
              style={{ background: 'transparent', color: '#aaa', border: 'none', padding: '0', marginBottom: '24px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}
            >
              <ArrowLeft size={16} /> Mağazaya Dön
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '18px', paddingBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ width: '72px', height: '72px', flex: '0 0 72px', borderRadius: '16px', background: 'rgba(255,255,255,0.9)', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AppLogo app={settingsApp} size={48} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h1 style={{ margin: '0 0 6px 0', fontSize: '28px', fontWeight: 'bold' }}>{settingsApp.name}</h1>
                <div style={{ color: '#888', fontSize: '13px' }}>{settingsApp.developer}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: settingsApp.state === 'running' ? '#27c93f' : '#ff5f56', fontSize: '13px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'currentColor' }} />
                {settingsApp.state === 'running' ? 'Çalışıyor' : 'Durduruldu'}
              </div>
            </div>

            {settingsMessage && (
              <div style={{ marginTop: '20px', padding: '10px 12px', borderRadius: '8px', background: settingsMessage.type === 'error' ? 'rgba(255,95,86,0.12)' : 'rgba(39,201,63,0.12)', border: `1px solid ${settingsMessage.type === 'error' ? 'rgba(255,95,86,0.35)' : 'rgba(39,201,63,0.35)'}`, color: settingsMessage.type === 'error' ? '#ff8a84' : '#75da85', fontSize: '13px' }}>
                {settingsMessage.text}
              </div>
            )}

            <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <h2 style={{ margin: '0 0 14px 0', fontSize: '16px' }}>Kontroller</h2>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                <button type="button" onClick={(event) => handleOpenApp(event, settingsApp)} disabled={settingsApp.state !== 'running'} style={{ background: '#0ea5e9', color: '#fff', border: 'none', padding: '9px 14px', borderRadius: '8px', cursor: settingsApp.state === 'running' ? 'pointer' : 'not-allowed', opacity: settingsApp.state === 'running' ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 'bold' }}>
                  <ExternalLink size={15} /> Aç
                </button>
                {settingsApp.state === 'running' ? (
                  <button type="button" onClick={(event) => runAction(event, settingsApp, 'stop', { inline: true })} disabled={Boolean(actionRunning[settingsApp.id])} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: actionRunning[settingsApp.id] ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
                    {actionRunning[settingsApp.id] === 'stop' ? <Loader2 size={15} className="spin" /> : <Square size={15} />} Durdur
                  </button>
                ) : (
                  <button type="button" onClick={(event) => runAction(event, settingsApp, 'start', { inline: true })} disabled={Boolean(actionRunning[settingsApp.id])} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: actionRunning[settingsApp.id] ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
                    {actionRunning[settingsApp.id] === 'start' ? <Loader2 size={15} className="spin" /> : <Play size={15} />} Başlat
                  </button>
                )}
                <button type="button" onClick={(event) => runAction(event, settingsApp, 'restart', { inline: true })} disabled={Boolean(actionRunning[settingsApp.id])} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: actionRunning[settingsApp.id] ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
                  {actionRunning[settingsApp.id] === 'restart' ? <Loader2 size={15} className="spin" /> : <RotateCw size={15} />} Yeniden Başlat
                </button>
              </div>
            </section>

            <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Erişim</h2>
              <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px' }}>Uygulamanın yayınlanmış adresi.</div>
              {settingsAccessUrl ? (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                  <div style={{ flex: 1, minWidth: 0, padding: '9px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#ccc', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{settingsAccessUrl}</div>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await copyText(settingsAccessUrl);
                        setSettingsMessage({ type: 'success', text: 'Erişim adresi kopyalandı.' });
                      } catch (error) {
                        setSettingsMessage({ type: 'error', text: error.message });
                      }
                    }}
                    style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}
                  >
                    <Copy size={14} /> Kopyala
                  </button>
                </div>
              ) : (
                <div style={{ color: '#888', fontSize: '13px' }}>Bu container için yayınlanmış bir web adresi bulunamadı.</div>
              )}
            </section>

            <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Otomatik Başlatma</h2>
              <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px' }}>Sunucu veya Docker yeniden başladığında containerın davranışı.</div>
              {settingsLoading ? (
                <div style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}><Loader2 size={15} className="spin" /> Ayarlar okunuyor...</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                  <select value={restartPolicy} onChange={(event) => setRestartPolicy(event.target.value)} style={{ minWidth: '210px', background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}>
                    <option value="no">Kapalı</option>
                    <option value="unless-stopped">Elle durdurulana kadar</option>
                    <option value="always">Her zaman</option>
                  </select>
                  <button type="button" onClick={saveContainerSettings} disabled={settingsSaving || !containerSettings} style={{ background: '#0ea5e9', color: '#fff', border: 'none', padding: '9px 14px', borderRadius: '8px', cursor: settingsSaving || !containerSettings ? 'not-allowed' : 'pointer', opacity: settingsSaving || !containerSettings ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 'bold' }}>
                    {settingsSaving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Kaydet
                  </button>
                </div>
              )}
            </section>

            <section style={{ padding: '26px 0 0 0' }}>
              <h2 style={{ margin: '0 0 14px 0', fontSize: '16px' }}>Container</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', wordBreak: 'break-word' }}>
                <div style={{ color: '#888' }}>Instance</div><div>{settingsApp.instanceName || settingsApp.containerName}</div>
                <div style={{ color: '#888' }}>Container</div><div>{settingsApp.containerName}</div>
                <div style={{ color: '#888' }}>İmaj</div><div>{settingsApp.image}</div>
                <div style={{ color: '#888' }}>Yönetim</div><div>{managementSource}</div>
                <div style={{ color: '#888' }}>Durum</div><div>{settingsApp.status || settingsApp.state}</div>
                {containerSettings && containerSettings.ports.length > 0 && (
                  <><div style={{ color: '#888' }}>Portlar</div><div>{containerSettings.ports.map((port) => `${port.hostIp}:${port.hostPort} → ${port.privatePort}`).join(', ')}</div></>
                )}
                {containerSettings && containerSettings.mounts.length > 0 && (
                  <><div style={{ color: '#888' }}>Depolama</div><div>{containerSettings.mounts.map((mount) => `${mount.name || mount.source} → ${mount.destination}${mount.readOnly ? ' (salt okunur)' : ''}`).join(', ')}</div></>
                )}
              </div>
            </section>
          </div>
        ) : (
          <>
        {activeCategory === 'kesfet' && !searchQuery && featuredApp && (
          <div style={{ padding: '30px 40px 10px 40px' }}>
            <div style={{ fontSize: '12px', color: '#888', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>Öne Çıkan</div>
            <div style={{ background: featuredApp.banner, borderRadius: '16px', padding: '30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.3)', position: 'relative', overflow: 'hidden' }}>
              <div style={{ zIndex: 1, maxWidth: '70%' }}>
                <h1 style={{ margin: '0 0 10px 0', fontSize: '32px', fontWeight: 'bold' }}>{featuredApp.name}</h1>
                <p style={{ margin: '0 0 20px 0', fontSize: '16px', opacity: 0.9, lineHeight: '1.5' }}>{featuredApp.description}</p>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', position: 'relative' }}>
                  {featuredApp.installed && featuredApp.canManage && renderServiceMenu(featuredApp, 'featured')}
                  {featuredApp.installed ? (
                    <button type="button" onClick={(event) => handleOpenApp(event, featuredApp)} disabled={uninstalling[featuredApp.id]} style={{ background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', padding: '8px 24px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold', cursor: uninstalling[featuredApp.id] ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', opacity: uninstalling[featuredApp.id] ? 0.7 : 1 }}>
                      {uninstalling[featuredApp.id] ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
                      {uninstalling[featuredApp.id] ? 'Kaldırılıyor...' : 'Aç'}
                    </button>
                  ) : (
                    <button type="button" onClick={(event) => handleInstall(event, featuredApp)} disabled={installing[featuredApp.id]} style={{ background: '#fff', color: '#000', border: 'none', padding: '8px 24px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold', cursor: installing[featuredApp.id] ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      {installing[featuredApp.id] ? <Loader2 size={16} className="spin" /> : <Download size={16} />} {installing[featuredApp.id] ? 'Bekle...' : 'Yükle'}
                    </button>
                  )}
                </div>
              </div>
              <div style={{ width: '120px', height: '120px', background: 'rgba(255,255,255,0.9)', padding: '20px', borderRadius: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 20px 40px rgba(0,0,0,0.2)', zIndex: 1 }}>
                <AppLogo app={featuredApp} size={80} />
              </div>
            </div>
          </div>
        )}

        {activeCategory === 'guncellemeler' && (
          <div style={{ padding: '30px 40px 10px 40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ margin: '0 0 8px 0', fontSize: '28px', fontWeight: 'bold' }}>Güncellemeler</h1>
              <div style={{ fontSize: '14px', color: '#888' }}>Yüklü uygulamaların canlı durumu Docker üzerinden okunuyor.</div>
            </div>
            <button type="button" onClick={() => loadApps()} disabled={loading} style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', padding: '8px 16px', borderRadius: '8px', cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 'bold' }}>
              <RotateCw size={14} className={loading ? 'spin' : ''} /> Yenile
            </button>
          </div>
        )}

        <div style={{ padding: '20px 40px' }}>
          {loading ? (
            <div style={{ padding: '40px', color: '#888', textAlign: 'center' }}><Loader2 size={20} className="spin" /> Katalog yükleniyor...</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
              {displayedApps.map((app) => (
                <div key={app.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '20px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
                    <div style={{ width: '60px', height: '60px', flex: '0 0 60px', borderRadius: '14px', background: 'rgba(255,255,255,0.9)', padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><AppLogo app={app} /></div>
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 'bold' }}>{app.name}</h3>
                      <div style={{ fontSize: '12px', color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.developer}</div>
                    </div>
                  </div>
                  <p style={{ margin: '0 0 20px 0', fontSize: '13px', color: '#aaa', lineHeight: '1.5', flex: 1 }}>{app.description}</p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '16px' }}>
                    <span style={{ fontSize: '11px', background: 'rgba(255,255,255,0.1)', padding: '4px 8px', borderRadius: '4px', color: '#ccc' }}>{app.category}</span>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', position: 'relative' }}>
                      {app.installed && app.canManage && renderServiceMenu(app, 'grid')}
                      {app.installed ? (
                        <button type="button" onClick={(event) => handleOpenApp(event, app)} disabled={uninstalling[app.id]} style={{ background: 'transparent', color: '#0ea5e9', border: '1px solid #0ea5e9', padding: '6px 16px', borderRadius: '16px', fontSize: '13px', fontWeight: 'bold', cursor: uninstalling[app.id] ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px', opacity: uninstalling[app.id] ? 0.7 : 1 }}>
                          {uninstalling[app.id] ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {uninstalling[app.id] ? 'Kaldırılıyor...' : 'Aç'}
                        </button>
                      ) : installing[app.id] ? (
                        <button type="button" disabled style={{ background: 'rgba(255,255,255,0.1)', color: '#888', border: 'none', padding: '6px 16px', borderRadius: '16px', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}><Loader2 size={14} className="spin" /> Bekle...</button>
                      ) : (
                        <button type="button" onClick={(event) => handleInstall(event, app)} style={{ background: 'rgba(255,255,255,0.9)', color: '#000', border: 'none', padding: '6px 16px', borderRadius: '16px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}><Download size={14} /> Yükle</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        .menu-item:hover { background: rgba(14, 165, 233, 0.8); }
      `}</style>
    </div>
  );
};

export default AppStoreApp;
