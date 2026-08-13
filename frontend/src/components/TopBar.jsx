import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useWindowManager } from '../contexts/WindowContext';
import { CloudSun, Lock, Search } from 'lucide-react';
import SpotlightSearch from './SpotlightSearch';

const CustomFoxIcon = ({ size = 16, color = "currentColor" }) => (
  <svg height={size} viewBox="0 0 100 100" width={size} xmlns="http://www.w3.org/2000/svg" fill={color}>
    <path d="m80 16.667s-1.501 0-3.333 0c-1.833 0-4.58 1.871-6.107 4.16l-8.336 12.506h-24.444l-8.34-12.506c-1.523-2.289-4.274-4.16-6.107-4.16-1.832 0-3.333 0-3.333 0l-10 49.596c12.666 0 25.335 4.994 35 15 2.761 2.761 7.239 2.761 10 0 8.991-9.189 21.364-14.922 35-15zm-38.333 40.937v-.004c-5.209 2.031-11.172-.299-13.33-5.198h-.004v-.007s.004.004.004.007c5.205-2.031 11.168.293 13.33 5.198zm12.75 10.814-2.998 2.998c-.781.781-2.044.781-2.825 0l-3.005-2.998c-.361-.368-.586-.862-.586-1.416 0-1.104.896-2.002 2.002-2.002h6.003c1.106 0 1.995.898 1.995 2.002 0 .554-.221 1.048-.586 1.416zm17.25-16.016h-.004c-2.158 4.899-8.118 7.229-13.33 5.198v.004-.004c2.162-4.905 8.125-7.229 13.33-5.198 0-.003.004-.003.004-.003z"></path>
  </svg>
);

const TopBar = ({
  applications = [],
  onOpenApplication,
  onOpenFileResult,
  onRefreshDesktop
}) => {
  const { logout } = useAuth();
  const { openWindow } = useWindowManager();
  const [time, setTime] = useState(new Date());
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSpotlightOpen, setIsSpotlightOpen] = useState(false);

  useEffect(() => {
    const handleGlobalClick = () => setIsMenuOpen(false);
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleShortcut = (event) => {
      const commandK = (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase('tr-TR') === 'k';
      const controlSpace = event.ctrlKey && !event.metaKey && event.code === 'Space';
      if (!commandK && !controlSpace) return;
      event.preventDefault();
      setIsMenuOpen(false);
      setIsSpotlightOpen((current) => !current);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const shortcutLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘K'
    : 'Ctrl K';

  const formatDate = (date) => {
    return date.toLocaleDateString('tr-TR', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const formatTime = (date) => {
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  };

  const openCalendar = (event) => {
    event.stopPropagation();
    setIsMenuOpen(false);
    const year = time.getFullYear();
    const month = String(time.getMonth() + 1).padStart(2, '0');
    const day = String(time.getDate()).padStart(2, '0');
    openWindow({
      id: 'calendar',
      type: 'calendar',
      title: 'Takvim',
      component: null,
      width: 920,
      height: 640,
      navigation: { date: `${year}-${month}-${day}`, requestId: Date.now() }
    });
  };

  const openWeather = (event) => {
    event.stopPropagation();
    setIsMenuOpen(false);
    openWindow({
      id: 'weather',
      type: 'weather',
      title: 'Hava Durumu',
      component: null,
      width: 780,
      height: 590
    });
  };

  return (
    <div className="topbar">
      <div className="topbar-left">
        <span 
          className="topbar-item brand" 
          onClick={(e) => { e.stopPropagation(); setIsMenuOpen(!isMenuOpen); }}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', position: 'relative' }}
        >
          <CustomFoxIcon size={16} /> FoxOS
          
          {isMenuOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: '4px',
              background: 'rgba(30, 30, 35, 0.95)', backdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
              padding: '4px', minWidth: '160px', boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
              zIndex: 100000
            }}>
              <div 
                onClick={logout}
                style={{
                  padding: '8px 12px', fontSize: '13px', cursor: 'pointer', borderRadius: '4px',
                  display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'normal'
                }}
                className="menu-item"
              >
                <Lock size={14} /> Ekranı Kilitle
              </div>
            </div>
          )}
        </span>
      </div>
      <div className="topbar-right">
        <button
          type="button"
          className="topbar-search-trigger"
          title={`FoxOS’ta ara (${shortcutLabel})`}
          aria-label={`FoxOS’ta ara, ${shortcutLabel}`}
          aria-expanded={isSpotlightOpen}
          onClick={(event) => {
            event.stopPropagation();
            setIsMenuOpen(false);
            setIsSpotlightOpen(true);
          }}
        >
          <Search size={14} aria-hidden="true" />
          <span className="topbar-search-label">Ara</span>
          <kbd>{shortcutLabel}</kbd>
        </button>
        <button
          type="button"
          className="topbar-item topbar-weather-trigger"
          title="Hava durumunu aç"
          aria-label="Hava durumunu aç"
          onClick={openWeather}
        >
          <CloudSun size={15} aria-hidden="true" />
          <span className="topbar-weather-label">Hava</span>
        </button>
        <button
          type="button"
          className="topbar-item topbar-clock-trigger"
          title="Takvimi aç"
          aria-label={`${formatDate(time)} ${formatTime(time)}, takvimi aç`}
          onClick={openCalendar}
        >
          <span className="topbar-date">{formatDate(time)} </span>
          <span className="topbar-time">{formatTime(time)}</span>
        </button>
      </div>
      <SpotlightSearch
        applications={applications}
        isOpen={isSpotlightOpen}
        onClose={() => setIsSpotlightOpen(false)}
        onLock={logout}
        onOpenApplication={onOpenApplication}
        onOpenFileResult={onOpenFileResult}
        onOpenWindow={openWindow}
        onRefreshDesktop={onRefreshDesktop}
      />
    </div>
  );
};

export default TopBar;
