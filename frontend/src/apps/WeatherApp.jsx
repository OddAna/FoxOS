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
import './WeatherApp.css';

const weatherDetails = (code, isDay = true) => {
  const value = Number(code);
  if (value === 0) return { label: 'Açık', Icon: Sun };
  if ([1, 2].includes(value)) return { label: 'Parçalı bulutlu', Icon: CloudSun };
  if (value === 3) return { label: 'Kapalı', Icon: Cloud };
  if ([45, 48].includes(value)) return { label: 'Sisli', Icon: CloudFog };
  if ([51, 53, 55, 56, 57].includes(value)) return { label: 'Çisenti', Icon: CloudDrizzle };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return { label: 'Yağmurlu', Icon: CloudRain };
  if ([71, 73, 75, 77, 85, 86].includes(value)) return { label: 'Karlı', Icon: Snowflake };
  if ([95, 96, 99].includes(value)) return { label: 'Gök gürültülü', Icon: CloudLightning };
  return { label: isDay ? 'Hava durumu' : 'Gece', Icon: CloudSun };
};

const rounded = (value, suffix = '') => Number.isFinite(value) ? `${Math.round(value)}${suffix}` : '—';

const locationLabel = (location) => [
  location.name,
  location.admin1 && location.admin1 !== location.name ? location.admin1 : '',
  location.country
].filter(Boolean).join(', ');

const dayLabel = (date, index) => {
  if (index === 0) return 'Bugün';
  return new Date(`${date}T12:00:00`).toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric' });
};

const clockLabel = (value) => typeof value === 'string' && value.includes('T') ? value.slice(-5) : '—';

const WeatherIcon = ({ code, isDay = true, size = 28 }) => {
  const { Icon } = weatherDetails(code, isDay);
  return <Icon size={size} strokeWidth={1.55} aria-hidden="true" />;
};

const WeatherApp = () => {
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
      setLocationMode(payload.configured !== true);
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Hava durumu yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, []);

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
      setError(requestError.message || 'Konum aranamadı.');
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
      setWeather(null);
      setLocationQuery('');
      setLocationResults([]);
      await loadWeather({ force: true });
    } catch (requestError) {
      setError(requestError.message || 'Konum kaydedilemedi.');
    } finally {
      setSavingLocation(false);
    }
  };

  if (loading && !weather) {
    return (
      <div className="weather-app weather-loading">
        <RefreshCw size={24} className="spin" />
        <span>Hava durumu yükleniyor…</span>
      </div>
    );
  }

  if (locationMode || weather?.configured !== true) {
    return (
      <div className="weather-app">
        <header className="weather-toolbar">
          <div className="weather-toolbar-title"><CloudSun size={21} /> <strong>Hava Durumu</strong></div>
          {weather?.configured === true && (
            <button type="button" className="weather-secondary-button" onClick={() => setLocationMode(false)}>Vazgeç</button>
          )}
        </header>
        <main className="weather-location-picker">
          <div className="weather-location-intro">
            <span className="weather-location-icon"><MapPin size={27} /></span>
            <h2>Şehrini seç</h2>
            <p>Anlık hava durumu ve yedi günlük tahmin için şehir veya ilçe ara.</p>
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
              placeholder="Örn. İstanbul, Berlin"
              aria-label="Şehir veya ilçe ara"
              minLength={2}
              maxLength={80}
              autoFocus
            />
            <button type="submit" disabled={locationQuery.trim().length < 2 || searching}>
              {searching ? 'Aranıyor…' : 'Ara'}
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
                {locationSearchComplete ? 'Bu arama için konum bulunamadı.' : 'Aramak için Enter’a bas.'}
              </p>
            )}
          </div>
        </main>
      </div>
    );
  }

  const currentDetails = weatherDetails(weather.current.weatherCode, weather.current.isDay);
  const CurrentIcon = currentDetails.Icon;

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
          <button type="button" className="weather-secondary-button" onClick={() => setLocationMode(true)}>Konumu Değiştir</button>
          <button type="button" className="weather-icon-button" onClick={() => loadWeather({ force: true })} disabled={loading} aria-label="Hava durumunu yenile">
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
              <div className="weather-temperature">{rounded(weather.current.temperature, '°')}</div>
              <strong>{currentDetails.label}</strong>
              <span>Hissedilen {rounded(weather.current.apparentTemperature, '°')}</span>
            </div>
          </div>
          <div className="weather-current-metrics">
            <div><Droplets size={18} /><span>Nem<strong>{rounded(weather.current.relativeHumidity, '%')}</strong></span></div>
            <div><Wind size={18} /><span>Rüzgâr<strong>{rounded(weather.current.windSpeed, ' km/sa')}</strong></span></div>
            <div><Umbrella size={18} /><span>Yağış<strong>{rounded(weather.current.precipitation, ' mm')}</strong></span></div>
          </div>
        </section>

        <section className="weather-forecast" aria-label="Yedi günlük tahmin">
          <div className="weather-section-heading">
            <h2>7 Günlük Tahmin</h2>
            <span>{locationLabel(weather.location)}</span>
          </div>
          <div className="weather-days">
            {weather.daily.map((day, index) => (
              <article key={day.date} className="weather-day">
                <strong>{dayLabel(day.date, index)}</strong>
                <WeatherIcon code={day.weatherCode} size={27} />
                <span className="weather-day-condition">{weatherDetails(day.weatherCode).label}</span>
                <span className="weather-day-rain"><Droplets size={12} /> {rounded(day.precipitationProbability, '%')}</span>
                <span className="weather-day-temperatures"><b>{rounded(day.temperatureMax, '°')}</b> {rounded(day.temperatureMin, '°')}</span>
              </article>
            ))}
          </div>
        </section>

        {weather.daily[0] && (
          <section className="weather-sun-times">
            <div><Sunrise size={19} /><span>Gün doğumu<strong>{clockLabel(weather.daily[0].sunrise)}</strong></span></div>
            <div><Sunset size={19} /><span>Gün batımı<strong>{clockLabel(weather.daily[0].sunset)}</strong></span></div>
          </section>
        )}
      </main>

      <footer className="weather-footer">
        <span>{new Date(weather.fetchedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} itibarıyla</span>
        <a href={weather.attributionUrl} target="_blank" rel="noreferrer">Tahmin verisi: Open-Meteo</a>
      </footer>
    </div>
  );
};

export default WeatherApp;
