import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Box,
  CircleStop,
  ExternalLink,
  FileText,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  TerminalSquare,
  Trash2,
  Wrench
} from 'lucide-react';
import { apiFetch } from '../api';
import './AppStoreApp.css';

const APP_ICONS = {
  activity: Activity,
  logs: TerminalSquare,
  tools: Wrench,
  document: FileText
};

const stateLabel = (app) => {
  if (!app.installed) return 'Kurulmadı';
  if (app.state === 'running') return 'Çalışıyor';
  if (app.state === 'exited') return 'Durduruldu';
  return app.state || 'Bilinmiyor';
};

const AppStoreApp = () => {
  const [apps, setApps] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Tümü');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [hostPort, setHostPort] = useState('');
  const [bindAddress, setBindAddress] = useState('127.0.0.1');
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [removeData, setRemoveData] = useState(false);

  const loadApps = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await apiFetch('/api/apps');
      const payload = await response.json();
      setApps(payload.apps || []);
      setSelectedId((current) => current || payload.apps?.[0]?.id || null);
      setNotice(null);
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  const selectedApp = apps.find((app) => app.id === selectedId) || null;

  useEffect(() => {
    if (!selectedApp) return;
    setHostPort(String(selectedApp.hostPort || selectedApp.defaultPort));
    setBindAddress(selectedApp.bindAddress || '127.0.0.1');
    setConfirmRemoval(false);
    setRemoveData(false);
  }, [selectedApp?.id]); // oxlint-disable-line react-hooks/exhaustive-deps

  const categories = useMemo(
    () => ['Tümü', ...new Set(apps.map((app) => app.category))],
    [apps]
  );

  const visibleApps = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');
    return apps.filter((app) => {
      const inCategory = category === 'Tümü' || app.category === category;
      const searchable = `${app.name} ${app.summary} ${app.publisher}`.toLocaleLowerCase('tr-TR');
      return inCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [apps, category, query]);

  const refreshAndSelect = async (appId) => {
    await loadApps({ quiet: true });
    setSelectedId(appId);
  };

  const install = async () => {
    if (!selectedApp) return;
    setBusy('install');
    setNotice({ type: 'info', message: 'İmaj indiriliyor ve uygulama sunucuda hazırlanıyor…' });
    try {
      await apiFetch(`/api/apps/${selectedApp.id}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostPort, bindAddress })
      });
      await refreshAndSelect(selectedApp.id);
      setNotice({ type: 'success', message: `${selectedApp.name} kuruldu ve başlatıldı.` });
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    } finally {
      setBusy('');
    }
  };

  const runAction = async (action) => {
    if (!selectedApp) return;
    setBusy(action);
    setNotice(null);
    try {
      await apiFetch(`/api/apps/${selectedApp.id}/${action}`, { method: 'POST' });
      await refreshAndSelect(selectedApp.id);
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    } finally {
      setBusy('');
    }
  };

  const uninstall = async () => {
    if (!selectedApp) return;
    setBusy('remove');
    try {
      await apiFetch(`/api/apps/${selectedApp.id}?removeData=${removeData}`, { method: 'DELETE' });
      await refreshAndSelect(selectedApp.id);
      setConfirmRemoval(false);
      setNotice({
        type: 'success',
        message: removeData ? 'Uygulama ve kalıcı verileri kaldırıldı.' : 'Uygulama kaldırıldı; kalıcı verileri korundu.'
      });
    } catch (error) {
      setNotice({ type: 'error', message: error.message });
    } finally {
      setBusy('');
    }
  };

  const openApplication = () => {
    if (!selectedApp?.hostPort) return;
    const hostname = selectedApp.bindAddress === '127.0.0.1'
      ? '127.0.0.1'
      : window.location.hostname;
    window.open(`http://${hostname}:${selectedApp.hostPort}`, '_blank', 'noopener,noreferrer');
  };

  const installedCount = apps.filter((app) => app.installed).length;
  const runningCount = apps.filter((app) => app.state === 'running').length;

  return (
    <div className="app-store-shell">
      <header className="app-store-header">
        <div className="app-store-heading">
          <div className="app-store-mark"><Store size={22} /></div>
          <div>
            <span className="app-store-kicker">FOXOS CURATED CATALOG</span>
            <h1>App Store</h1>
          </div>
        </div>
        <div className="app-store-stats" aria-label="Uygulama durumu">
          <span><strong>{installedCount}</strong> kurulu</span>
          <span><i className="status-dot" /> <strong>{runningCount}</strong> çalışıyor</span>
          <button type="button" onClick={() => loadApps()} title="Yenile" disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      <div className="app-store-toolbar">
        <label className="app-store-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Uygulama ara"
          />
        </label>
        <div className="app-store-categories">
          {categories.map((item) => (
            <button
              type="button"
              key={item}
              className={category === item ? 'active' : ''}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      {notice && <div className={`app-store-notice ${notice.type}`}>{notice.message}</div>}

      <main className="app-store-main">
        <section className="app-store-library" aria-label="Uygulama kataloğu">
          {loading ? (
            <div className="app-store-empty"><LoaderCircle className="spin" /> Katalog okunuyor…</div>
          ) : visibleApps.length === 0 ? (
            <div className="app-store-empty">Aramanızla eşleşen uygulama yok.</div>
          ) : (
            <div className="app-store-grid">
              {visibleApps.map((app) => {
                const Icon = APP_ICONS[app.icon] || Box;
                return (
                  <button
                    type="button"
                    key={app.id}
                    onClick={() => setSelectedId(app.id)}
                    className={`app-card ${selectedId === app.id ? 'selected' : ''}`}
                    style={{ '--app-accent': app.accent }}
                  >
                    <div className="app-card-icon"><Icon size={24} /></div>
                    <div className="app-card-copy">
                      <div className="app-card-title-row">
                        <h2>{app.name}</h2>
                        <span className={`app-state ${app.state}`}>{stateLabel(app)}</span>
                      </div>
                      <p>{app.summary}</p>
                      <span className="app-card-meta">{app.publisher} · {app.category}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <aside className="app-store-detail" style={{ '--app-accent': selectedApp?.accent || '#8ba9ff' }}>
          {selectedApp ? (
            <>
              <div className="detail-accent" />
              <div className="detail-heading">
                {React.createElement(APP_ICONS[selectedApp.icon] || Box, { size: 27 })}
                <div>
                  <span>{selectedApp.category}</span>
                  <h2>{selectedApp.name}</h2>
                </div>
              </div>
              <p className="detail-description">{selectedApp.description}</p>
              <a className="detail-source" href={selectedApp.docsUrl} target="_blank" rel="noreferrer">
                Proje kaynağı <ExternalLink size={13} />
              </a>

              <div className="detail-image">
                <span>CONTAINER IMAGE</span>
                <code>{selectedApp.image}</code>
              </div>

              {selectedApp.installed ? (
                <div className="installed-panel">
                  <div className="installed-status">
                    <span className={`large-state ${selectedApp.state}`}><i /> {stateLabel(selectedApp)}</span>
                    <small>{selectedApp.status}</small>
                  </div>
                  <div className="installed-address">
                    <span>Bağlantı</span>
                    <strong>{selectedApp.bindAddress}:{selectedApp.hostPort || '—'}</strong>
                  </div>
                  <div className="action-grid">
                    {selectedApp.state === 'running' ? (
                      <>
                        <button type="button" className="primary" onClick={openApplication} disabled={!selectedApp.hostPort}>
                          <ExternalLink size={15} /> Aç
                        </button>
                        <button type="button" onClick={() => runAction('restart')} disabled={Boolean(busy)}>
                          <RefreshCw size={15} className={busy === 'restart' ? 'spin' : ''} /> Yeniden başlat
                        </button>
                        <button type="button" onClick={() => runAction('stop')} disabled={Boolean(busy)}>
                          <CircleStop size={15} /> Durdur
                        </button>
                      </>
                    ) : (
                      <button type="button" className="primary" onClick={() => runAction('start')} disabled={Boolean(busy)}>
                        <Play size={15} /> Başlat
                      </button>
                    )}
                    <button type="button" className="danger-quiet" onClick={() => setConfirmRemoval(true)} disabled={Boolean(busy)}>
                      <Trash2 size={15} /> Kaldır
                    </button>
                  </div>

                  {confirmRemoval && (
                    <div className="remove-confirm">
                      <strong>{selectedApp.name} kaldırılsın mı?</strong>
                      {(selectedApp.volumes || []).length > 0 && (
                        <label>
                          <input type="checkbox" checked={removeData} onChange={(event) => setRemoveData(event.target.checked)} />
                          Kalıcı uygulama verisini de sil
                        </label>
                      )}
                      <p>{removeData ? 'Bu uygulama verisi geri alınamaz.' : 'Kalıcı volume korunacak; yeniden kurulumda kullanılabilir.'}</p>
                      <div>
                        <button type="button" onClick={() => setConfirmRemoval(false)}>Vazgeç</button>
                        <button type="button" className="danger" onClick={uninstall} disabled={busy === 'remove'}>
                          {busy === 'remove' && <LoaderCircle size={14} className="spin" />} Kaldır
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="install-panel">
                  <label>
                    <span>Sunucu portu</span>
                    <input
                      type="number"
                      min="1024"
                      max="65535"
                      value={hostPort}
                      onChange={(event) => setHostPort(event.target.value)}
                    />
                  </label>
                  <fieldset>
                    <legend>Ağ erişimi</legend>
                    <button
                      type="button"
                      className={bindAddress === '127.0.0.1' ? 'active' : ''}
                      onClick={() => setBindAddress('127.0.0.1')}
                    >
                      <ShieldCheck size={15} /> Özel
                    </button>
                    <button
                      type="button"
                      className={bindAddress === '0.0.0.0' ? 'active public' : ''}
                      onClick={() => setBindAddress('0.0.0.0')}
                    >
                      Herkese açık
                    </button>
                  </fieldset>
                  <p className={`exposure-note ${bindAddress === '0.0.0.0' ? 'warning' : ''}`}>
                    {bindAddress === '0.0.0.0'
                      ? 'Bu port güvenlik duvarı izin veriyorsa internetten erişilebilir olur.'
                      : 'Yalnızca sunucunun kendisinden veya SSH tüneli üzerinden erişilir.'}
                  </p>
                  {selectedApp.risk && <p className="risk-note">{selectedApp.risk}</p>}
                  <button type="button" className="install-button" onClick={install} disabled={Boolean(busy)}>
                    {busy === 'install' ? <LoaderCircle size={17} className="spin" /> : <Box size={17} />}
                    {busy === 'install' ? 'Kuruluyor…' : 'Sunucuya kur'}
                  </button>
                </div>
              )}

              <ul className="detail-notes">
                {(selectedApp.notes || []).map((note) => <li key={note}>{note}</li>)}
              </ul>
            </>
          ) : (
            <div className="app-store-empty">Detayları görmek için bir uygulama seçin.</div>
          )}
        </aside>
      </main>
    </div>
  );
};

export default AppStoreApp;
