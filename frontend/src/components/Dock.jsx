import React from 'react';
import { Settings, Terminal, Gauge, FolderOpen, Trash2, Store } from 'lucide-react';
import { useWindowManager } from '../contexts/WindowContext';

const Dock = () => {
  const { openWindow, windows } = useWindowManager();

  const handleOpenServer = () => {
    openWindow({
      id: 'server',
      type: 'server',
      title: 'Sunucu',
      component: null,
      width: 1050,
      height: 680
    });
  };

  const handleOpenSettings = () => {
    openWindow({
      id: 'settings',
      type: 'settings',
      title: 'Ayarlar',
      component: null,
      width: 800,
      height: 550
    });
  };

  const handleOpenAppStore = () => {
    openWindow({
      id: 'app-store',
      type: 'app-store',
      title: 'App Store',
      component: null,
      width: 1040,
      height: 700
    });
  };

  const handleOpenFiles = (initialPath = 'Masaüstü') => {
    openWindow({
      id: initialPath === 'Çöp Kutusu' ? 'trash' : 'files',
      type: 'files',
      title: initialPath === 'Çöp Kutusu' ? 'Çöp Kutusu' : 'Dosyalar',
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
      title: 'Terminal',
      component: null, // component rendered by App.jsx
      width: 700,
      height: 450
    });
  };

  const isAppOpen = (id) => windows.some(w => w.id === id);

  return (
    <div className="dock-container">
      <div className="dock glass">
        <div className="dock-item-wrapper">
          <div className="dock-item app-server" title="Sunucu" onClick={handleOpenServer}>
            <Gauge size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('server') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-store" title="App Store" onClick={handleOpenAppStore}>
            <Store size={26} color="#ffbd66" strokeWidth={1.6} />
          </div>
          <div className={`dock-indicator ${isAppOpen('app-store') ? 'active' : ''}`}></div>
        </div>
        
        <div className="dock-item-wrapper">
          <div className="dock-item app-settings" title="Ayarlar" onClick={handleOpenSettings}>
            <Settings size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('settings') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-terminal" title="Terminal" onClick={handleOpenTerminal}>
            <Terminal size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('terminal') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-files" title="Dosyalar" onClick={() => handleOpenFiles('Masaüstü')}>
            <FolderOpen size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('files') ? 'active' : ''}`}></div>
        </div>

        <div className="dock-item-wrapper">
          <div className="dock-item app-trash" title="Çöp Kutusu" onClick={() => handleOpenFiles('Çöp Kutusu')}>
            <Trash2 size={26} color="#ffffff" strokeWidth={1.5} />
          </div>
          <div className={`dock-indicator ${isAppOpen('trash') ? 'active' : ''}`}></div>
        </div>

      </div>
    </div>
  );
};

export default Dock;
