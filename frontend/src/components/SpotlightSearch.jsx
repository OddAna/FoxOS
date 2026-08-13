import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Box,
  CalendarDays,
  CloudSun,
  File,
  Folder,
  FolderOpen,
  Gauge,
  Link2,
  Lock,
  RefreshCw,
  Search,
  Server,
  Settings,
  Terminal,
  Trash2
} from 'lucide-react';
import ApplicationLogo from './ApplicationLogo';
import { apiFetch } from '../api';
import { normalizeSpotlightText, searchSpotlightItems } from '../utils/spotlightSearch';

const resultIcon = (icon) => (
  <span className="spotlight-result-icon" aria-hidden="true">{icon}</span>
);

const applicationStateLabel = (application) => {
  const state = application.runtime?.operationalState || application.runtime?.state;
  if (state === 'running') return 'Çalışıyor';
  if (state === 'paused') return 'Duraklatıldı';
  if (state === 'starting') return 'Başlatılıyor';
  return 'Kapalı';
};

const SpotlightSearch = ({
  applications,
  isOpen,
  onClose,
  onLock,
  onOpenApplication,
  onOpenFileResult,
  onOpenWindow,
  onRefreshDesktop
}) => {
  const inputRef = useRef(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileResults, setFileResults] = useState([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState('');

  const openSystemWindow = useCallback((config) => () => onOpenWindow(config), [onOpenWindow]);
  const openSettings = useCallback((tab) => () => onOpenWindow({
    id: 'settings',
    type: 'settings',
    title: 'Ayarlar',
    component: null,
    width: 1000,
    height: 680,
    navigation: { tab, requestId: Date.now() }
  }), [onOpenWindow]);

  const items = useMemo(() => [
    {
      id: 'system-server',
      title: 'Sunucu',
      subtitle: 'Host durumu ve containerlar',
      category: 'FoxOS',
      keywords: ['host', 'docker', 'container', 'cpu', 'ram', 'disk'],
      icon: resultIcon(<Gauge size={20} />),
      featured: true,
      priority: 10,
      run: openSystemWindow({ id: 'server', type: 'server', title: 'Sunucu', component: null, width: 1050, height: 680 })
    },
    {
      id: 'settings-applications',
      title: 'Uygulama Yöneticisi',
      subtitle: 'Uygulamaları ve servisleri yönet',
      category: 'Ayarlar',
      keywords: ['uygulamalar', 'servisler', 'containers', 'docker'],
      icon: resultIcon(<Box size={20} />),
      featured: true,
      priority: 20,
      run: openSettings('applications')
    },
    {
      id: 'system-files',
      title: 'Dosyalar',
      subtitle: 'Sunucu dosyalarını aç',
      category: 'FoxOS',
      keywords: ['finder', 'belgeler', 'resimler', 'masaustu', 'server files'],
      icon: resultIcon(<FolderOpen size={20} />),
      featured: true,
      priority: 30,
      run: openSystemWindow({ id: 'files', type: 'files', title: 'Dosyalar', component: null, initialPath: 'Masaüstü', width: 900, height: 600 })
    },
    {
      id: 'system-codex',
      title: 'Codex',
      subtitle: 'Sunucu asistanını aç',
      category: 'FoxOS',
      keywords: ['ai', 'yapay zeka', 'asistan', 'chat'],
      icon: resultIcon(<Bot size={20} />),
      featured: true,
      priority: 40,
      run: openSystemWindow({ id: 'codex', type: 'codex', title: 'Codex', component: null, width: 900, height: 650 })
    },
    {
      id: 'system-calendar',
      title: 'Takvim',
      subtitle: 'Etkinlikleri görüntüle ve düzenle',
      category: 'FoxOS',
      keywords: ['calendar', 'etkinlik', 'randevu', 'ajanda', 'tarih'],
      icon: resultIcon(<CalendarDays size={20} />),
      featured: true,
      priority: 35,
      run: () => onOpenWindow({
        id: 'calendar',
        type: 'calendar',
        title: 'Takvim',
        component: null,
        width: 920,
        height: 640,
        navigation: { requestId: Date.now() }
      })
    },
    {
      id: 'system-weather',
      title: 'Hava Durumu',
      subtitle: 'Anlık hava ve 7 günlük tahmin',
      category: 'FoxOS',
      keywords: ['weather', 'hava', 'sicaklik', 'yagmur', 'tahmin', 'sehir'],
      icon: resultIcon(<CloudSun size={20} />),
      featured: true,
      priority: 36,
      run: openSystemWindow({ id: 'weather', type: 'weather', title: 'Hava Durumu', component: null, width: 780, height: 590 })
    },
    {
      id: 'system-terminal',
      title: 'Terminal',
      subtitle: 'Host terminalini aç',
      category: 'FoxOS',
      keywords: ['shell', 'komut', 'console', 'pty'],
      icon: resultIcon(<Terminal size={20} />),
      featured: true,
      priority: 50,
      run: openSystemWindow({ id: 'terminal', type: 'terminal', title: 'Terminal', component: null, width: 700, height: 450 })
    },
    {
      id: 'system-store',
      title: 'Mağaza',
      subtitle: 'FoxOS uygulama mağazasını aç',
      category: 'FoxOS',
      keywords: ['store', 'app store', 'uygulama kur'],
      icon: resultIcon(<Box size={20} />),
      featured: true,
      priority: 60,
      run: openSystemWindow({ id: 'store', type: 'store', title: 'Mağaza', component: null, width: 1200, height: 750 })
    },
    {
      id: 'system-settings',
      title: 'Ayarlar',
      subtitle: 'FoxOS ayarlarını aç',
      category: 'FoxOS',
      keywords: ['settings', 'genel', 'tercihler'],
      icon: resultIcon(<Settings size={20} />),
      featured: true,
      priority: 70,
      run: openSettings('general')
    },
    {
      id: 'settings-connections',
      title: 'Bağlantılar',
      subtitle: 'Codex, Gemini, Antigravity ve Cloudflare',
      category: 'Ayarlar',
      keywords: ['connections', 'hesaplar', 'entegrasyonlar'],
      icon: resultIcon(<Link2 size={20} />),
      priority: 80,
      run: openSettings('connections')
    },
    {
      id: 'settings-migration',
      title: 'Sunucu Geçişi',
      subtitle: 'Mevcut kaynakları incele ve geçir',
      category: 'Ayarlar',
      keywords: ['migration', 'tasima', 'kaynaklar', 'coolify'],
      icon: resultIcon(<Server size={20} />),
      priority: 90,
      run: openSettings('migration')
    },
    {
      id: 'system-trash',
      title: 'Çöp Kutusu',
      subtitle: 'Silinen dosyaları görüntüle',
      category: 'FoxOS',
      keywords: ['trash', 'silinenler'],
      icon: resultIcon(<Trash2 size={20} />),
      priority: 100,
      run: openSystemWindow({ id: 'trash', type: 'files', title: 'Çöp Kutusu', component: null, initialPath: 'Çöp Kutusu', width: 900, height: 600 })
    },
    ...applications.map((application, index) => ({
      id: `application-${application.id}`,
      title: application.name,
      subtitle: `${applicationStateLabel(application)} · Sunucu uygulaması`,
      category: 'Uygulamalar',
      keywords: [application.id, application.image, application.externalUrl, 'uygulama'],
      icon: (
        <span className="spotlight-result-icon is-application" aria-hidden="true">
          <ApplicationLogo app={application} size={24} />
        </span>
      ),
      priority: 200 + index,
      run: () => onOpenApplication(application)
    })),
    ...fileResults.map((file, index) => ({
      id: `file-${file.id}`,
      title: file.name,
      subtitle: `${file.parentPath || '/'} · ${file.type === 'folder' ? 'Klasör' : 'Dosya'}`,
      category: 'Dosyalar',
      keywords: [file.path, file.ext, file.type, 'dosya', 'klasor'],
      icon: resultIcon(file.type === 'folder' ? <Folder size={20} /> : <File size={20} />),
      priority: 300 + index,
      run: () => onOpenFileResult(file)
    })),
    {
      id: 'action-refresh',
      title: 'Masaüstünü Yenile',
      subtitle: 'Dosya ve uygulama listesini güncelle',
      category: 'Eylemler',
      keywords: ['refresh', 'yenile', 'guncelle'],
      icon: resultIcon(<RefreshCw size={20} />),
      priority: 400,
      run: onRefreshDesktop
    },
    {
      id: 'action-lock',
      title: 'Ekranı Kilitle',
      subtitle: 'FoxOS oturumunu kilitle',
      category: 'Eylemler',
      keywords: ['lock', 'cikis', 'oturum'],
      icon: resultIcon(<Lock size={20} />),
      priority: 410,
      run: onLock
    }
  ], [applications, fileResults, onLock, onOpenApplication, onOpenFileResult, onOpenWindow, onRefreshDesktop, openSettings, openSystemWindow]);

  const results = useMemo(() => searchSpotlightItems(items, query, 12), [items, query]);
  const activeIndex = results.length ? Math.min(selectedIndex, results.length - 1) : 0;

  useEffect(() => {
    if (!isOpen) return undefined;
    setQuery('');
    setSelectedIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const normalizedQuery = normalizeSpotlightText(query);
    if (!isOpen || normalizedQuery.length < 2) {
      setFileResults([]);
      setFileSearchLoading(false);
      setFileSearchError('');
      return undefined;
    }

    const controller = new AbortController();
    setFileSearchLoading(true);
    setFileSearchError('');
    const timeout = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/api/file-search?q=${encodeURIComponent(query)}&limit=20`, {
          signal: controller.signal
        });
        const payload = await response.json();
        setFileResults(Array.isArray(payload.items) ? payload.items : []);
      } catch (error) {
        if (error.name === 'AbortError') return;
        setFileResults([]);
        setFileSearchError(error.message || 'Dosya araması tamamlanamadı.');
      } finally {
        if (!controller.signal.aborted) setFileSearchLoading(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [isOpen, query]);

  if (!isOpen) return null;

  const runItem = (item) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => results.length ? (current + 1) % results.length : 0);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) => results.length ? (current - 1 + results.length) % results.length : 0);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runItem(results[activeIndex]);
    }
  };

  return (
    <div className="spotlight-layer" role="presentation" onPointerDown={onClose}>
      <section
        className="spotlight-panel"
        role="dialog"
        aria-modal="true"
        aria-label="FoxOS Arama"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="spotlight-input-row">
          <Search size={24} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Uygulama, ayar veya dosya ara"
            aria-label="FoxOS’ta ara"
            aria-controls="spotlight-results"
            aria-activedescendant={results[activeIndex] ? `spotlight-option-${results[activeIndex].id}` : undefined}
            aria-autocomplete="list"
            aria-expanded="true"
            role="combobox"
            autoComplete="off"
            spellCheck="false"
          />
          <kbd>Esc</kbd>
        </div>

        <div id="spotlight-results" className="spotlight-results" role="listbox">
          {results.length ? results.map((item, index) => (
            <button
              id={`spotlight-option-${item.id}`}
              key={item.id}
              type="button"
              className={`spotlight-result${index === activeIndex ? ' is-selected' : ''}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => runItem(item)}
            >
              {item.icon}
              <span className="spotlight-result-copy">
                <strong>{item.title}</strong>
                <span>{item.subtitle}</span>
              </span>
              <span className="spotlight-result-category">{item.category}</span>
            </button>
          )) : fileSearchLoading ? (
            <div className="spotlight-empty">
              <RefreshCw size={22} className="spin" aria-hidden="true" />
              <span>FoxOS dosyaları aranıyor…</span>
            </div>
          ) : (
            <div className="spotlight-empty">
              <Search size={22} aria-hidden="true" />
              <span>{fileSearchError || `“${query}” için sonuç bulunamadı.`}</span>
            </div>
          )}
        </div>

        <footer className="spotlight-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> seç</span>
          <span><kbd>Enter</kbd> aç</span>
          <span>{fileSearchLoading ? 'Dosyalar aranıyor…' : query ? `${results.length} sonuç` : 'Hızlı Erişim'}</span>
        </footer>
      </section>
    </div>
  );
};

export default SpotlightSearch;
