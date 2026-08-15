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
import { useI18n } from '../contexts/LocaleContext';

const resultIcon = (icon) => (
  <span className="spotlight-result-icon" aria-hidden="true">{icon}</span>
);

const applicationStateLabel = (application, t) => {
  const state = application.runtime?.operationalState || application.runtime?.state;
  if (state === 'running') return t('spotlight.applicationStateRunning');
  if (state === 'paused') return t('spotlight.applicationStatePaused');
  if (state === 'starting') return t('spotlight.applicationStateStarting');
  return t('spotlight.applicationStateStopped');
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
  const { t } = useI18n();
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
    title: t('common.settings'),
    component: null,
    width: 1000,
    height: 680,
    navigation: { tab, requestId: Date.now() }
  }), [onOpenWindow, t]);

  const items = useMemo(() => [
    {
      id: 'system-server',
      title: t('common.server'),
      subtitle: t('spotlight.serverSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['host', 'docker', 'container', 'cpu', 'ram', 'disk'],
      icon: resultIcon(<Gauge size={20} />),
      featured: true,
      priority: 10,
      run: openSystemWindow({ id: 'server', type: 'server', title: t('common.server'), component: null, width: 1050, height: 680 })
    },
    {
      id: 'settings-applications',
      title: t('spotlight.applicationManager'),
      subtitle: t('spotlight.applicationsSubtitle'),
      category: t('spotlight.categorySettings'),
      keywords: ['uygulamalar', 'servisler', 'containers', 'docker'],
      icon: resultIcon(<Box size={20} />),
      featured: true,
      priority: 20,
      run: openSettings('applications')
    },
    {
      id: 'system-files',
      title: t('common.files'),
      subtitle: t('spotlight.filesSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['finder', 'belgeler', 'resimler', 'masaustu', 'server files'],
      icon: resultIcon(<FolderOpen size={20} />),
      featured: true,
      priority: 30,
      run: openSystemWindow({ id: 'files', type: 'files', title: t('common.files'), component: null, initialPath: 'Masaüstü', width: 900, height: 600 })
    },
    {
      id: 'system-codex',
      title: 'Codex',
      subtitle: t('spotlight.codexSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['ai', 'yapay zeka', 'asistan', 'chat'],
      icon: resultIcon(<Bot size={20} />),
      featured: true,
      priority: 40,
      run: openSystemWindow({ id: 'codex', type: 'codex', title: 'Codex', component: null, width: 900, height: 650 })
    },
    {
      id: 'system-calendar',
      title: t('spotlight.calendar'),
      subtitle: t('spotlight.calendarSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['calendar', 'etkinlik', 'randevu', 'ajanda', 'tarih'],
      icon: resultIcon(<CalendarDays size={20} />),
      featured: true,
      priority: 35,
      run: () => onOpenWindow({
        id: 'calendar',
        type: 'calendar',
        title: t('common.calendar'),
        component: null,
        width: 920,
        height: 640,
        navigation: { requestId: Date.now() }
      })
    },
    {
      id: 'system-weather',
      title: t('common.weather'),
      subtitle: t('spotlight.weatherSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['weather', 'hava', 'sicaklik', 'yagmur', 'tahmin', 'sehir'],
      icon: resultIcon(<CloudSun size={20} />),
      featured: true,
      priority: 36,
      run: openSystemWindow({ id: 'weather', type: 'weather', title: t('common.weather'), component: null, width: 780, height: 590 })
    },
    {
      id: 'system-terminal',
      title: 'Terminal',
      subtitle: t('spotlight.terminalSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['shell', 'komut', 'console', 'pty'],
      icon: resultIcon(<Terminal size={20} />),
      featured: true,
      priority: 50,
      run: openSystemWindow({ id: 'terminal', type: 'terminal', title: 'Terminal', component: null, width: 700, height: 450 })
    },
    {
      id: 'system-store',
      title: t('spotlight.store'),
      subtitle: t('spotlight.storeSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['store', 'app store', 'uygulama kur'],
      icon: resultIcon(<Box size={20} />),
      featured: true,
      priority: 60,
      run: openSystemWindow({ id: 'store', type: 'store', title: t('spotlight.store'), component: null, width: 1200, height: 750 })
    },
    {
      id: 'system-settings',
      title: t('common.settings'),
      subtitle: t('spotlight.settingsSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['settings', 'genel', 'tercihler'],
      icon: resultIcon(<Settings size={20} />),
      featured: true,
      priority: 70,
      run: openSettings('general')
    },
    {
      id: 'settings-connections',
      title: t('common.connections'),
      subtitle: t('spotlight.connectionsSubtitle'),
      category: t('spotlight.categorySettings'),
      keywords: ['connections', 'hesaplar', 'entegrasyonlar'],
      icon: resultIcon(<Link2 size={20} />),
      priority: 80,
      run: openSettings('connections')
    },
    {
      id: 'settings-migration',
      title: t('spotlight.serverMigration'),
      subtitle: t('spotlight.migrationSubtitle'),
      category: t('spotlight.categorySettings'),
      keywords: ['migration', 'tasima', 'kaynaklar', 'coolify'],
      icon: resultIcon(<Server size={20} />),
      priority: 90,
      run: openSettings('migration')
    },
    {
      id: 'system-trash',
      title: t('dock.trash'),
      subtitle: t('spotlight.trashSubtitle'),
      category: t('spotlight.categoryFoxos'),
      keywords: ['trash', 'silinenler'],
      icon: resultIcon(<Trash2 size={20} />),
      priority: 100,
      run: openSystemWindow({ id: 'trash', type: 'files', title: t('dock.trash'), component: null, initialPath: 'Çöp Kutusu', width: 900, height: 600 })
    },
    ...applications.map((application, index) => ({
      id: `application-${application.id}`,
      title: application.name,
      subtitle: `${applicationStateLabel(application, t)} · ${t('spotlight.serverApplication')}`,
      category: t('spotlight.categoryApplications'),
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
      subtitle: `${file.parentPath || '/'} · ${file.type === 'folder' ? t('spotlight.folder') : t('spotlight.file')}`,
      category: t('spotlight.categoryFiles'),
      keywords: [file.path, file.ext, file.type, 'dosya', 'klasor'],
      icon: resultIcon(file.type === 'folder' ? <Folder size={20} /> : <File size={20} />),
      priority: 300 + index,
      run: () => onOpenFileResult(file)
    })),
    {
      id: 'action-refresh',
      title: t('spotlight.refreshDesktop'),
      subtitle: t('spotlight.refreshDesktopSubtitle'),
      category: t('spotlight.categoryActions'),
      keywords: ['refresh', 'yenile', 'guncelle'],
      icon: resultIcon(<RefreshCw size={20} />),
      priority: 400,
      run: onRefreshDesktop
    },
    {
      id: 'action-lock',
      title: t('spotlight.lockScreen'),
      subtitle: t('spotlight.lockScreenSubtitle'),
      category: t('spotlight.categoryActions'),
      keywords: ['lock', 'cikis', 'oturum'],
      icon: resultIcon(<Lock size={20} />),
      priority: 410,
      run: onLock
    }
  ], [applications, fileResults, onLock, onOpenApplication, onOpenFileResult, onOpenWindow, onRefreshDesktop, openSettings, openSystemWindow, t]);

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
        setFileSearchError(error.message || t('spotlight.fileSearchError'));
      } finally {
        if (!controller.signal.aborted) setFileSearchLoading(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [isOpen, query, t]);

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
        aria-label={t('spotlight.dialogLabel')}
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
            placeholder={t('spotlight.placeholder')}
            aria-label={t('shell.search')}
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
              <span>{t('spotlight.searchingFoxosFiles')}</span>
            </div>
          ) : (
            <div className="spotlight-empty">
              <Search size={22} aria-hidden="true" />
              <span>{fileSearchError || t('spotlight.noResults', { query })}</span>
            </div>
          )}
        </div>

        <footer className="spotlight-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('spotlight.select')}</span>
          <span><kbd>Enter</kbd> {t('spotlight.open')}</span>
          <span>{fileSearchLoading
            ? t('spotlight.searchingFiles')
            : query
              ? t('spotlight.resultCount', { count: results.length })
              : t('spotlight.quickAccess')}</span>
        </footer>
      </section>
    </div>
  );
};

export default SpotlightSearch;
