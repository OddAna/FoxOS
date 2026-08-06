import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  Code,
  Compass,
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
  Settings,
  Square,
  Terminal,
  Trash2,
  Wrench
} from 'lucide-react';
import { useDialog } from '../contexts/DialogContext';
import { useWindowManager } from '../contexts/WindowContext';
import { useApplicationInventory } from '../contexts/ApplicationContext';
import { apiFetch } from '../api';
import ApplicationLogo from '../components/ApplicationLogo';

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
const decorateApp = (app) => ({
  ...app,
  developer: app.publisher,
  appType: 'webapp',
  ...APP_VISUALS[app.id]
});

const AppStoreApp = () => {
  const [activeCategory, setActiveCategory] = useState('kesfet');
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState({});
  const [uninstalling, setUninstalling] = useState({});
  const [actionRunning, setActionRunning] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMenu, setActiveMenu] = useState(null);
  const { showDialog } = useDialog();
  const { openWindow } = useWindowManager();
  const {
    applications: inventoryApplications,
    refreshApplications,
    runApplicationAction
  } = useApplicationInventory();

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
      await refreshApplications({ quiet: true });
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

  const runAction = async (event, app, action) => {
    event.stopPropagation();
    setActiveMenu(null);
    setActionRunning((current) => ({ ...current, [app.id]: action }));
    try {
      const inventoryApplication = inventoryApplications.find((application) => (
        application.runtime && application.runtime.containerId === app.containerId
      ));
      if (inventoryApplication) {
        await runApplicationAction(inventoryApplication, action);
      } else {
        const actionPath = app.managedByFoxOS
          ? `/api/apps/${app.id}/${action}`
          : `/api/containers/${app.containerId}/${action}`;
        await apiFetch(actionPath, { method: 'POST' });
        await refreshApplications({ quiet: true });
      }
      await loadApps({ quiet: true });
    } catch (error) {
      showDialog({ title: 'İşlem Hatası', message: error.message, type: 'error' });
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
          await refreshApplications({ quiet: true });
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
    openWindow({
      id: 'settings',
      type: 'settings',
      title: 'Ayarlar',
      component: null,
      width: 1000,
      height: 680,
      navigation: {
        tab: 'applications',
        containerId: app.containerId,
        requestId: Date.now()
      }
    });
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

  const renderServiceMenu = (app, suffix) => (
    <>
      <div
        style={{
          width: suffix === 'featured' ? '10px' : '8px',
          height: suffix === 'featured' ? '10px' : '8px',
          borderRadius: '50%',
          background: actionRunning[app.id] ? '#ffbd2e' : app.state === 'running' ? '#27c93f' : '#ff5f56',
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
                <ApplicationLogo app={featuredApp} size={80} />
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
                    <div style={{ width: '60px', height: '60px', flex: '0 0 60px', borderRadius: '14px', background: 'rgba(255,255,255,0.9)', padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ApplicationLogo app={app} /></div>
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
