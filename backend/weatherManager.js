const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const WEATHER_CONFIG_SCHEMA_VERSION = 1;
const GEOCODING_API_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_API_URL = 'https://api.open-meteo.com/v1/forecast';
const ALLOWED_API_ORIGINS = new Set([
  'https://geocoding-api.open-meteo.com',
  'https://api.open-meteo.com'
]);

class WeatherError extends Error {
  constructor(message, statusCode = 400, code = 'weather-error') {
    super(message);
    this.name = 'WeatherError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function boundedString(value, maximum, { required = false } = {}) {
  if (value === null || value === undefined) return required ? null : '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if ((required && !text) || text.length > maximum || text.includes('\0')) return null;
  return text;
}

function validTimezone(value) {
  const timezone = boundedString(value, 100, { required: true });
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return null;
  }
}

function normalizeLocation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WeatherError('Konum bilgisi geçersiz.', 400, 'weather-location-invalid');
  }
  const name = boundedString(input.name, 120, { required: true });
  const country = boundedString(input.country, 120);
  const admin1 = boundedString(input.admin1, 120);
  const countryCodeValue = boundedString(input.countryCode ?? input.country_code, 2);
  const countryCode = countryCodeValue?.toUpperCase();
  const timezone = validTimezone(input.timezone);
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const id = input.id === null || input.id === undefined ? null : Number(input.id);
  if (
    !name || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    !timezone || (countryCode && !/^[A-Z]{2}$/.test(countryCode)) ||
    (id !== null && (!Number.isSafeInteger(id) || id <= 0)) ||
    country === null || admin1 === null || countryCodeValue === null
  ) {
    throw new WeatherError('Konum bilgisi geçersiz.', 400, 'weather-location-invalid');
  }
  return {
    id,
    name,
    latitude,
    longitude,
    timezone,
    country: country || '',
    countryCode: countryCode || '',
    admin1: admin1 || ''
  };
}

async function defaultRequestJson(url) {
  const target = url instanceof URL ? url : new URL(url);
  if (!ALLOWED_API_ORIGINS.has(target.origin)) {
    throw new WeatherError('Hava durumu sağlayıcısı geçersiz.', 500, 'weather-provider-invalid');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    let response;
    try {
      response = await fetch(target, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
    } catch (error) {
      throw new WeatherError(
        error.name === 'AbortError'
          ? 'Hava durumu servisi zaman aşımına uğradı.'
          : 'Hava durumu servisine bağlanılamadı.',
        503,
        'weather-provider-unavailable'
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > 1_000_000) {
      await response.body?.cancel().catch(() => {});
      throw new WeatherError('Hava durumu yanıtı çok büyük.', 502, 'weather-provider-invalid-response');
    }
    let text;
    try {
      const reader = response.body?.getReader();
      if (!reader) {
        text = await response.text();
      } else {
        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 1_000_000) {
            await reader.cancel().catch(() => {});
            throw new WeatherError('Hava durumu yanıtı çok büyük.', 502, 'weather-provider-invalid-response');
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        text = new TextDecoder().decode(bytes);
      }
    } catch (error) {
      if (error instanceof WeatherError) throw error;
      if (error.name === 'AbortError') {
        throw new WeatherError(
          'Hava durumu servisi zaman aşımına uğradı.',
          503,
          'weather-provider-unavailable'
        );
      }
      throw new WeatherError('Hava durumu yanıtı okunamadı.', 502, 'weather-provider-invalid-response');
    }
    if (text.length > 1_000_000) {
      throw new WeatherError('Hava durumu yanıtı çok büyük.', 502, 'weather-provider-invalid-response');
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WeatherError('Hava durumu servisi geçersiz yanıt verdi.', 502, 'weather-provider-invalid-response');
    }
    if (!response.ok || payload?.error === true) {
      throw new WeatherError('Hava durumu servisi isteği tamamlayamadı.', 502, 'weather-provider-error');
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function createWeatherManager({
  dataRoot,
  requestJson = defaultRequestJson,
  clock = () => new Date(),
  forecastCacheMs = 10 * 60 * 1_000,
  geocodingCacheMs = 10 * 60 * 1_000
}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new TypeError('Weather manager requires an absolute data root');
  }
  if (typeof requestJson !== 'function') throw new TypeError('Weather manager requires a request function');
  const configFile = path.join(dataRoot, 'weather', 'config.json');
  let forecastCache = null;
  const geocodingCache = new Map();

  function nowDate() {
    return new Date(clock());
  }

  function readLocation() {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new WeatherError('Hava durumu ayarı okunamadı.', 503, 'weather-config-invalid');
    }
    if (!payload || payload.schemaVersion !== WEATHER_CONFIG_SCHEMA_VERSION || !payload.location) {
      throw new WeatherError('Hava durumu ayarı okunamadı.', 503, 'weather-config-invalid');
    }
    try {
      return normalizeLocation(payload.location);
    } catch {
      throw new WeatherError('Hava durumu ayarı okunamadı.', 503, 'weather-config-invalid');
    }
  }

  function saveLocation(input) {
    const location = normalizeLocation(input);
    atomicWriteJson(configFile, {
      schemaVersion: WEATHER_CONFIG_SCHEMA_VERSION,
      provider: 'open-meteo',
      updatedAt: nowDate().toISOString(),
      location
    });
    forecastCache = null;
    return location;
  }

  async function searchLocations(query) {
    if (typeof query !== 'string' || query.includes('\0')) {
      throw new WeatherError('Konum araması geçersiz.', 400, 'weather-location-query-invalid');
    }
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2 || normalizedQuery.length > 80) {
      throw new WeatherError('Konum araması 2–80 karakter olmalıdır.', 400, 'weather-location-query-invalid');
    }
    const cacheKey = normalizedQuery.toLocaleLowerCase('tr-TR');
    const cached = geocodingCache.get(cacheKey);
    const nowMs = nowDate().getTime();
    if (cached && nowMs - cached.cachedAt < geocodingCacheMs) return cached.locations;

    const url = new URL(GEOCODING_API_URL);
    url.searchParams.set('name', normalizedQuery);
    url.searchParams.set('count', '8');
    url.searchParams.set('language', 'tr');
    url.searchParams.set('format', 'json');
    const payload = await requestJson(url);
    const locations = (Array.isArray(payload?.results) ? payload.results : [])
      .slice(0, 8)
      .map((result) => {
        try {
          return normalizeLocation(result);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    geocodingCache.set(cacheKey, { cachedAt: nowMs, locations });
    while (geocodingCache.size > 50) geocodingCache.delete(geocodingCache.keys().next().value);
    return locations;
  }

  function normalizeForecast(payload, location) {
    const current = payload?.current;
    const daily = payload?.daily;
    if (!current || typeof current !== 'object' || !daily || !Array.isArray(daily.time)) {
      throw new WeatherError('Hava durumu servisi eksik yanıt verdi.', 502, 'weather-provider-invalid-response');
    }
    const dayCount = Math.min(7, daily.time.length);
    const days = Array.from({ length: dayCount }, (_, index) => ({
      date: String(daily.time[index] || ''),
      weatherCode: optionalNumber(daily.weather_code?.[index]),
      temperatureMax: optionalNumber(daily.temperature_2m_max?.[index]),
      temperatureMin: optionalNumber(daily.temperature_2m_min?.[index]),
      precipitationProbability: optionalNumber(daily.precipitation_probability_max?.[index]),
      sunrise: typeof daily.sunrise?.[index] === 'string' ? daily.sunrise[index] : null,
      sunset: typeof daily.sunset?.[index] === 'string' ? daily.sunset[index] : null
    })).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
    if (days.length === 0 || typeof current.time !== 'string') {
      throw new WeatherError('Hava durumu servisi eksik yanıt verdi.', 502, 'weather-provider-invalid-response');
    }

    return {
      configured: true,
      provider: 'open-meteo',
      attributionUrl: 'https://open-meteo.com/',
      fetchedAt: nowDate().toISOString(),
      timezone: validTimezone(payload.timezone) || location.timezone,
      location,
      current: {
        time: current.time,
        temperature: optionalNumber(current.temperature_2m),
        apparentTemperature: optionalNumber(current.apparent_temperature),
        relativeHumidity: optionalNumber(current.relative_humidity_2m),
        precipitation: optionalNumber(current.precipitation),
        weatherCode: optionalNumber(current.weather_code),
        isDay: Number(current.is_day) === 1,
        windSpeed: optionalNumber(current.wind_speed_10m)
      },
      daily: days,
      units: {
        temperature: '°C',
        precipitation: 'mm',
        windSpeed: 'km/sa',
        humidity: '%'
      }
    };
  }

  async function forecast({ force = false } = {}) {
    const location = readLocation();
    if (!location) {
      return { configured: false, provider: 'open-meteo', location: null, forecast: null };
    }
    const cacheKey = `${location.latitude}:${location.longitude}:${location.timezone}`;
    const nowMs = nowDate().getTime();
    if (
      !force && forecastCache && forecastCache.key === cacheKey &&
      nowMs - forecastCache.cachedAt < forecastCacheMs
    ) {
      return forecastCache.value;
    }

    const url = new URL(FORECAST_API_URL);
    url.searchParams.set('latitude', String(location.latitude));
    url.searchParams.set('longitude', String(location.longitude));
    url.searchParams.set(
      'current',
      'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,is_day,wind_speed_10m'
    );
    url.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset'
    );
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '7');
    const payload = await requestJson(url);
    const normalized = normalizeForecast(payload, location);
    forecastCache = { key: cacheKey, cachedAt: nowMs, value: normalized };
    return normalized;
  }

  return {
    forecast,
    location: readLocation,
    paths: { configFile },
    saveLocation,
    searchLocations
  };
}

module.exports = {
  FORECAST_API_URL,
  GEOCODING_API_URL,
  WEATHER_CONFIG_SCHEMA_VERSION,
  WeatherError,
  createWeatherManager,
  normalizeLocation
};
