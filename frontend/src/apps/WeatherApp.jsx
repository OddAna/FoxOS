import { useCallback, useEffect, useState } from 'react';
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSun,
  Droplets,
  MapPin,
  RefreshCw,
  Search,
  Snowflake,
  Sun,
  Sunrise,
  Sunset,
  Umbrella,
  Wind
} from 'lucide-react';
import { apiFetch } from '../api';
import { publishWeatherUpdate } from '../utils/weatherStatus';
import { useI18n } from '../contexts/LocaleContext';
import './WeatherApp.css';

const weatherDetails = (code, isDay = true) => {
  const value = Number(code);
  if (value === 0) return { labelKey: 'weatherApp.conditions.clear', Icon: Sun };
  if ([1, 2].includes(value)) return { labelKey: 'weatherApp.conditions.partlyCloudy', Icon: CloudSun };
  if (value === 3) return { labelKey: 'weatherApp.conditions.overcast', Icon: Cloud };
  if ([45, 48].includes(value)) return { labelKey: 'weatherApp.conditions.fog', Icon: CloudFog };
  if ([51, 53, 55, 56, 57].includes(value)) return { labelKey: 'weatherApp.conditions.drizzle', Icon: CloudDrizzle };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return { labelKey: 'weatherApp.conditions.rain', Icon: CloudRain };
  if ([71, 73, 75, 77, 85, 86].includes(value)) return { labelKey: 'weatherApp.conditions.snow', Icon: Snowflake };
  if ([95, 96, 99].includes(value)) return { labelKey: 'weatherApp.conditions.thunderstorm', Icon: CloudLightning };
  return { labelKey: isDay ? 'weatherApp.conditions.weather' : 'weatherApp.conditions.night', Icon: CloudSun };
};

const rounded = (value, formatNumber, suffix = '', maximumFractionDigits = 0) => Number.isFinite(value)
  ? `${formatNumber(value, { maximumFractionDigits })}${suffix}`
  : '—';

const locationLabel = (location) => [
  location.name,
  location.admin1 && location.admin1 !== location.name ? location.admin1 : '',
  location.country
].filter(Boolean).join(', ');

const dayLabel = (date, index, t, formatDate) => {
  if (index === 0) return t('weatherApp.today');
  return formatDate(`${date}T12:00:00`, { weekday: 'short', day: 'numeric' });
};

const WeatherIcon = ({ code, isDay = true, size = 28 }) => {
  const { Icon } = weatherDetails(code, isDay);
  return <Icon size={size} strokeWidth={1.55} aria-hidden="true" />;
};

const WeatherApp = () => {
  const { formatDate, formatNumber, formatTime, measurementSystem, t } = useI18n();
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [locationMode, setLocationMode] = useState(false);
  const [locationQuery, setLocationQuery] = useState('');
  const [locationResults, setLocationResults] = useState([]);
  const [locationSearchComplete, setLocationSearchComplete] = useState(false);
  const [searching, setSearching] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);

  const loadWeather = useCallback(async ({ force = false } = {}) => {
    setLoading(true);
    try {
      const response = await apiFetch(force ? '/api/weather?refresh=1' : '/api/weather');
      const payload = await response.json();
      setWeather(payload);
      publishWeatherUpdate(payload);
      setLocationMode(payload.configured !== true);
      setError('');
    } catch (requestError) {
      setError(requestError.message || t('weatherApp.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadWeather();
  }, [loadWeather]);

  const searchLocations = async (event) => {
    event.preventDefault();
    if (locationQuery.trim().length < 2 || searching) return;
    setSearching(true);
    setLocationSearchComplete(false);
    setError('');
    try {
      const response = await apiFetch(`/api/weather/locations?q=${encodeURIComponent(locationQuery.trim())}`);
      const payload = await response.json();
      setLocationResults(Array.isArray(payload.locations) ? payload.locations : []);
    } catch (requestError) {
      setLocationResults([]);
      setError(requestError.message || t('weatherApp.searchError'));
    } finally {
      setSearching(false);
      setLocationSearchComplete(true);
    }
  };

  const chooseLocation = async (location) => {
    if (savingLocation) return;
    setSavingLocation(true);
    setError('');
    try {
      await apiFetch('/api/weather/location', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(location)
      });
      publishWeatherUpdate(null);
      setWeather(null);
      setLocationQuery('');
      setLocationResults([]);
      await loadWeather({ force: true });
    } catch (requestError) {
      setError(requestError.message || t('weatherApp.saveError'));
    } finally {
      setSavingLocation(false);
    }
  };

  if (loading && !weather) {
    return (
      <div className="weather-app weather-loading">
        <RefreshCw size={24} className="spin" />
        <span>{t('weatherApp.loading')}</span>
      </div>
    );
  }

  if (locationMode || weather?.configured !== true) {
    return (
      <div className="weather-app">
        <header className="weather-toolbar">
          <div className="weather-toolbar-title"><CloudSun size={21} /> <strong>{t('weatherApp.title')}</strong></div>
          {weather?.configured === true && (
            <button type="button" className="weather-secondary-button" onClick={() => setLocationMode(false)}>{t('common.cancel')}</button>
          )}
        </header>
        <main className="weather-location-picker">
          <div className="weather-location-intro">
            <span className="weather-location-icon"><MapPin size={27} /></span>
            <h2>{t('weatherApp.selectCity')}</h2>
            <p>{t('weatherApp.selectDescription')}</p>
          </div>
          <form className="weather-location-search" onSubmit={searchLocations}>
            <Search size={18} aria-hidden="true" />
            <input
              value={locationQuery}
              onChange={(event) => {
                setLocationQuery(event.target.value);
                setLocationResults([]);
                setLocationSearchComplete(false);
              }}
              placeholder={t('weatherApp.locationPlaceholder')}
              aria-label={t('weatherApp.locationSearchLabel')}
              minLength={2}
              maxLength={80}
              autoFocus
            />
            <button type="submit" disabled={locationQuery.trim().length < 2 || searching}>
              {t(searching ? 'weatherApp.searching' : 'common.search')}
            </button>
          </form>
          {error && <div className="weather-error" role="alert">{error}</div>}
          <div className="weather-location-results">
            {locationResults.map((location) => (
              <button
                type="button"
                key={`${location.id || 'coordinate'}-${location.latitude}-${location.longitude}`}
                onClick={() => chooseLocation(location)}
                disabled={savingLocation}
              >
                <MapPin size={17} />
                <span><strong>{location.name}</strong><small>{[location.admin1, location.country].filter(Boolean).join(', ')}</small></span>
                <span className="weather-location-timezone">{location.timezone}</span>
              </button>
            ))}
            {!searching && locationQuery && locationResults.length === 0 && !error && (
              <p className="weather-location-hint">
                {t(locationSearchComplete ? 'weatherApp.noLocation' : 'weatherApp.pressEnter')}
              </p>
            )}
          </div>
        </main>
      </div>
    );
  }

  const currentDetails = weatherDetails(weather.current.weatherCode, weather.current.isDay);
  const CurrentIcon = currentDetails.Icon;
  const temperatureLabel = (value) => rounded(
    measurementSystem === 'imperial' ? (value * 9 / 5) + 32 : value,
    formatNumber,
    measurementSystem === 'imperial' ? '°F' : '°C'
  );
  const windLabel = (value) => t(
    measurementSystem === 'imperial' ? 'weatherApp.windImperial' : 'weatherApp.windMetric',
    { value: rounded(measurementSystem === 'imperial' ? value * 0.621371 : value, formatNumber) }
  );
  const precipitationLabel = (value) => t(
    measurementSystem === 'imperial' ? 'weatherApp.precipitationImperial' : 'weatherApp.precipitationMetric',
    { value: rounded(measurementSystem === 'imperial' ? value / 25.4 : value, formatNumber, '', measurementSystem === 'imperial' ? 2 : 1) }
  );
  const clockLabel = (value) => {
    if (typeof value !== 'string' || !value.includes('T')) return '—';
    const [hour, minute] = value.slice(-5).split(':').map(Number);
    return formatTime(new Date(Date.UTC(2000, 0, 1, hour, minute)), { timeZone: 'UTC' });
  };

  return (
    <div className="weather-app">
      <header className="weather-toolbar">
        <div className="weather-toolbar-title">
          <MapPin size={18} />
          <div>
            <strong>{weather.location.name}</strong>
            <span>{[weather.location.admin1, weather.location.country].filter((part, index, list) => part && list.indexOf(part) === index && part !== weather.location.name).join(', ')}</span>
          </div>
        </div>
        <div className="weather-toolbar-actions">
          <button type="button" className="weather-secondary-button" onClick={() => setLocationMode(true)}>{t('weatherApp.changeLocation')}</button>
          <button type="button" className="weather-icon-button" onClick={() => loadWeather({ force: true })} disabled={loading} aria-label={t('weatherApp.refreshLabel')}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {error && <div className="weather-error" role="alert">{error}</div>}

      <main className="weather-content">
        <section className="weather-current">
          <div className="weather-current-primary">
            <CurrentIcon size={88} strokeWidth={1.15} aria-hidden="true" />
            <div>
              <div className="weather-temperature">{temperatureLabel(weather.current.temperature)}</div>
              <strong>{t(currentDetails.labelKey)}</strong>
              <span>{t('weatherApp.feelsLike', { temperature: temperatureLabel(weather.current.apparentTemperature) })}</span>
            </div>
          </div>
          <div className="weather-current-metrics">
            <div><Droplets size={18} /><span>{t('weatherApp.humidity')}<strong>{rounded(weather.current.relativeHumidity, formatNumber, '%')}</strong></span></div>
            <div><Wind size={18} /><span>{t('weatherApp.wind')}<strong>{windLabel(weather.current.windSpeed)}</strong></span></div>
            <div><Umbrella size={18} /><span>{t('weatherApp.precipitation')}<strong>{precipitationLabel(weather.current.precipitation)}</strong></span></div>
          </div>
        </section>

        <section className="weather-forecast" aria-label={t('weatherApp.forecastLabel')}>
          <div className="weather-section-heading">
            <h2>{t('weatherApp.forecastTitle')}</h2>
            <span>{locationLabel(weather.location)}</span>
          </div>
          <div className="weather-days">
            {weather.daily.map((day, index) => (
              <article key={day.date} className="weather-day">
                <strong>{dayLabel(day.date, index, t, formatDate)}</strong>
                <WeatherIcon code={day.weatherCode} size={27} />
                <span className="weather-day-condition">{t(weatherDetails(day.weatherCode).labelKey)}</span>
                <span className="weather-day-rain"><Droplets size={12} /> {rounded(day.precipitationProbability, formatNumber, '%')}</span>
                <span className="weather-day-temperatures"><b>{temperatureLabel(day.temperatureMax)}</b> {temperatureLabel(day.temperatureMin)}</span>
              </article>
            ))}
          </div>
        </section>

        {weather.daily[0] && (
          <section className="weather-sun-times">
            <div><Sunrise size={19} /><span>{t('weatherApp.sunrise')}<strong>{clockLabel(weather.daily[0].sunrise)}</strong></span></div>
            <div><Sunset size={19} /><span>{t('weatherApp.sunset')}<strong>{clockLabel(weather.daily[0].sunset)}</strong></span></div>
          </section>
        )}
      </main>

      <footer className="weather-footer">
        <span>{t('weatherApp.asOf', { time: formatTime(weather.fetchedAt) })}</span>
        <a href={weather.attributionUrl} target="_blank" rel="noreferrer">{t('weatherApp.attribution')}</a>
      </footer>
    </div>
  );
};

export default WeatherApp;
