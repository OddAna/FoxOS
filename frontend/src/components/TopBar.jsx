import React, { useCallback, useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useWindowManager } from '../contexts/WindowContext';
import { CloudSun, Lock, Search } from 'lucide-react';
import { apiFetch } from '../api';
import { WEATHER_UPDATED_EVENT, weatherTemperatureFromPayload } from '../utils/weatherStatus';
import SpotlightSearch from './SpotlightSearch';
import NotificationCenter from './NotificationCenter';
import CliUsageMenu from './CliUsageMenu';
import { useI18n } from '../contexts/LocaleContext';

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
  const { formatDate, formatTime, measurementSystem, t, timeZone } = useI18n();
  const [time, setTime] = useState(new Date());
  const [weatherTemperature, setWeatherTemperature] = useState(null);
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
    let active = true;
    const loadWeather = async () => {
      try {
        const response = await apiFetch('/api/weather');
        const payload = await response.json();
        if (active) setWeatherTemperature(weatherTemperatureFromPayload(payload));
      } catch {
        // Keep the last known value when the optional provider is unavailable.
      }
    };
    const handleWeatherUpdate = (event) => {
      if (!active) return;
      const temperature = event.detail?.temperature;
      setWeatherTemperature(Number.isFinite(temperature) ? temperature : null);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadWeather();
    };

    window.addEventListener(WEATHER_UPDATED_EVENT, handleWeatherUpdate);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    loadWeather();
    const timer = window.setInterval(loadWeather, 10 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(WEATHER_UPDATED_EVENT, handleWeatherUpdate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const handleShortcut = (event) => {
      const commandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
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

  const openCalendar = (event) => {
    event.stopPropagation();
    setIsMenuOpen(false);
    const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(time).map((part) => [part.type, part.value]));
    openWindow({
      id: 'calendar',
      type: 'calendar',
      title: t('common.calendar'),
      component: null,
      width: 920,
      height: 640,
      navigation: { date: `${dateParts.year}-${dateParts.month}-${dateParts.day}`, requestId: Date.now() }
    });
  };

  const openWeather = (event) => {
    event.stopPropagation();
    setIsMenuOpen(false);
    openWindow({
      id: 'weather',
      type: 'weather',
      title: t('common.weather'),
      component: null,
      width: 780,
      height: 590
    });
  };

  const displayedWeatherTemperature = weatherTemperature === null
    ? null
    : measurementSystem === 'imperial'
      ? Math.round((weatherTemperature * 9) / 5 + 32)
      : weatherTemperature;
  const weatherUnit = measurementSystem === 'imperial' ? 'F' : 'C';
  const weatherButtonLabel = displayedWeatherTemperature === null
    ? t('shell.openWeather')
    : t('shell.openWeatherTemperature', { temperature: displayedWeatherTemperature, unit: weatherUnit });

  const openNotificationSettings = useCallback(() => {
    setIsMenuOpen(false);
    setIsSpotlightOpen(false);
    openWindow({
      id: 'settings',
      type: 'settings',
      title: t('common.settings'),
      component: null,
      width: 960,
      height: 680,
      navigation: { tab: 'notifications', requestId: Date.now() }
    });
  }, [openWindow, t]);

  const openNotificationTarget = useCallback((notification) => {
    const target = notification && notification.target;
    if (!target) return;
    setIsMenuOpen(false);
    setIsSpotlightOpen(false);
    if (target.app === 'settings') {
      openWindow({
        id: 'settings', type: 'settings', title: t('common.settings'), component: null,
        width: 960, height: 680,
        navigation: { tab: target.tab || 'notifications', requestId: Date.now() }
      });
      return;
    }
    if (target.app === 'calendar') {
      openWindow({
        id: 'calendar', type: 'calendar', title: t('common.calendar'), component: null,
        width: 920, height: 640,
        navigation: { date: target.date || null, requestId: Date.now() }
      });
      return;
    }
    const builtIn = {
      weather: { title: t('common.weather'), width: 780, height: 590 },
      server: { title: t('common.server'), width: 900, height: 650 },
      files: { title: t('common.files'), width: 900, height: 620 },
      codex: { title: t('common.codex'), width: 980, height: 700 },
      store: { title: t('common.appStore'), width: 980, height: 680 }
    }[target.app];
    if (builtIn) {
      openWindow({ id: target.app, type: target.app, component: null, ...builtIn });
      return;
    }
    const application = applications.find((entry) => entry.id === target.app);
    if (application && onOpenApplication) onOpenApplication(application);
  }, [applications, onOpenApplication, openWindow, t]);

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
                <Lock size={14} /> {t('shell.lockScreen')}
              </div>
            </div>
          )}
        </span>
      </div>
      <div className="topbar-right">
        <button
          type="button"
          className="topbar-search-trigger"
          title={t('shell.searchTitle', { shortcut: shortcutLabel })}
          aria-label={t('shell.searchLabel', { shortcut: shortcutLabel })}
          aria-expanded={isSpotlightOpen}
          onClick={(event) => {
            event.stopPropagation();
            setIsMenuOpen(false);
            setIsSpotlightOpen(true);
          }}
        >
          <Search size={14} aria-hidden="true" />
          <span className="topbar-search-label">{t('common.search')}</span>
          <kbd>{shortcutLabel}</kbd>
        </button>
        <CliUsageMenu />
        <NotificationCenter
          onOpenSettings={openNotificationSettings}
          onOpenTarget={openNotificationTarget}
        />
        <button
          type="button"
          className="topbar-item topbar-weather-trigger"
          title={weatherButtonLabel}
          aria-label={weatherButtonLabel}
          onClick={openWeather}
        >
          {displayedWeatherTemperature === null ? (
            <>
              <CloudSun size={15} aria-hidden="true" />
              <span className="topbar-weather-label">{t('shell.weatherShort')}</span>
            </>
          ) : (
            <span className="topbar-weather-temperature" aria-live="polite">{displayedWeatherTemperature}°</span>
          )}
        </button>
        <button
          type="button"
          className="topbar-item topbar-clock-trigger"
          title={t('shell.openCalendar')}
          aria-label={t('shell.openCalendarLabel', {
            date: formatDate(time, { weekday: 'short', month: 'short', day: 'numeric' }),
            time: formatTime(time)
          })}
          onClick={openCalendar}
        >
          <span className="topbar-date">{formatDate(time, { weekday: 'short', month: 'short', day: 'numeric' })} </span>
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
