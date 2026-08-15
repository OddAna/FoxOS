import React from 'react';
import { Bot, Settings, Terminal, Gauge, FolderOpen, Trash2, Box } from 'lucide-react';
import { useWindowManager } from '../contexts/WindowContext';
import { useI18n } from '../contexts/LocaleContext';

const Dock = () => {
  const { openWindow, windows } = useWindowManager();
  const { t } = useI18n();

  const handleOpenServer = () => {
    openWindow({
      id: 'server',
      type: 'server',
      title: t('common.server'),
      component: null,
      width: 1050,
      height: 680
    });
  };

  const handleOpenSettings = () => {
    openWindow({
      id: 'settings',
      type: 'settings',
      title: t('common.settings'),
      component: null,
      width: 800,
      height: 550
    });
  };

  const handleOpenStore = () => {
    openWindow({
      id: 'store',
      type: 'store',
      title: t('common.appStore'),
      component: null,
      width: 1200,
      height: 750
    });
  };

  const handleOpenFiles = (initialPath = 'Masaüstü') => {
    openWindow({
      id: initialPath === 'Çöp Kutusu' ? 'trash' : 'files',
      type: 'files',
      title: initialPath === 'Çöp Kutusu' ? t('dock.trash') : t('common.files'),
      component: null,
      initialPath: initialPath,
      width: 900,
      height: 600
    });
  };

  const handleOpenTerminal = () => {
    openWindow({
      id: 'terminal',
      type: 'terminal',
      title: t('common.terminal'),
      component: null, // component rendered by App.jsx
      width: 700,
      height: 450
    });
  };

  const handleOpenCodex = () => {
    openWindow({
      id: 'codex',
      type: 'codex',
      title: t('common.codex'),
      component: null,
      width: 900,
      height: 650
    });
  };

  const isAppOpen = (id) => windows.some(w => w.id === id);

  return (
    <div className="dock-container">
      <div className="dock glass">
        <div className="dock-item-wrapper">
          <div className="dock-item app-server" title={t('common.server')} onClick={handleOpenServer}>
            <Gauge size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('server') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-settings" title={t('common.settings')} onClick={handleOpenSettings}>
            <Settings size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('settings') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-terminal" title={t('common.terminal')} onClick={handleOpenTerminal}>
            <Terminal size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('terminal') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-codex" title={t('common.codex')} onClick={handleOpenCodex}>
            <Bot size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('codex') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-store" title={t('dock.store')} onClick={handleOpenStore}>
            <Box size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('store') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-files" title={t('common.files')} onClick={() => handleOpenFiles('Masaüstü')}>
            <FolderOpen size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('files') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-trash" title={t('dock.trash')} onClick={() => handleOpenFiles('Çöp Kutusu')}>
            <Trash2 size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('trash') ? 'active' : ''}`}></div>
        </div>

      </div>
    </div>
  );
};

export default Dock;
