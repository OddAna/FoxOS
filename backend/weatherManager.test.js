const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWeatherManager } = require('./weatherManager');

const location = {
  id: 745044,
  name: 'İstanbul',
  latitude: 41.01384,
  longitude: 28.94966,
  timezone: 'Europe/Istanbul',
  country: 'Türkiye',
  country_code: 'TR',
  admin1: 'İstanbul'
};

const forecastPayload = {
  timezone: 'Europe/Istanbul',
  current: {
    time: '2026-08-13T12:00',
    temperature_2m: 27.4,
    relative_humidity_2m: 55,
    apparent_temperature: 28.1,
    precipitation: null,
    weather_code: 1,
    is_day: 1,
    wind_speed_10m: 12.3
  },
  daily: {
    time: ['2026-08-13', '2026-08-14'],
    weather_code: [1, 61],
    temperature_2m_max: [29, 26],
    temperature_2m_min: [21, 20],
    precipitation_probability_max: [5, 65],
    sunrise: ['2026-08-13T06:10', '2026-08-14T06:11'],
    sunset: ['2026-08-13T20:04', '2026-08-14T20:03']
  }
};

test('weather geocoding uses the fixed provider endpoint and returns allowlisted location fields', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-weather-'));
  const requested = [];
  try {
    const manager = createWeatherManager({
      dataRoot,
      requestJson: async (url) => {
        requested.push(new URL(url));
        return { results: [location, { name: '', latitude: 0, longitude: 0, timezone: 'UTC' }] };
      }
    });
    const results = await manager.searchLocations('İstanbul');
    assert.equal(requested[0].origin, 'https://geocoding-api.open-meteo.com');
    assert.equal(requested[0].pathname, '/v1/search');
    assert.equal(requested[0].searchParams.get('language'), 'tr');
    assert.equal(requested[0].searchParams.get('count'), '8');
    assert.deepEqual(results, [{
      id: 745044,
      name: 'İstanbul',
      latitude: 41.01384,
      longitude: 28.94966,
      timezone: 'Europe/Istanbul',
      country: 'Türkiye',
      countryCode: 'TR',
      admin1: 'İstanbul'
    }]);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('weather location persists owner-only and forecasts are normalized and cached', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-weather-'));
  const requested = [];
  try {
    const manager = createWeatherManager({
      dataRoot,
      clock: () => new Date('2026-08-13T09:00:00.000Z'),
      requestJson: async (url) => {
        requested.push(new URL(url));
        return forecastPayload;
      }
    });
    assert.deepEqual(await manager.forecast(), {
      configured: false,
      provider: 'open-meteo',
      location: null,
      forecast: null
    });
    manager.saveLocation(location);
    assert.equal(fs.statSync(manager.paths.configFile).mode & 0o777, 0o600);
    const first = await manager.forecast();
    const second = await manager.forecast();
    assert.equal(requested.length, 1);
    assert.deepEqual(second, first);
    assert.equal(requested[0].origin, 'https://api.open-meteo.com');
    assert.equal(requested[0].searchParams.get('timezone'), 'auto');
    assert.match(requested[0].searchParams.get('current'), /weather_code/);
    assert.equal(first.current.temperature, 27.4);
    assert.equal(first.current.precipitation, null);
    assert.equal(first.daily[1].precipitationProbability, 65);
    assert.equal(first.location.countryCode, 'TR');
    await manager.forecast({ force: true });
    assert.equal(requested.length, 2);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('weather manager rejects unsafe locations and malformed provider responses', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-weather-'));
  try {
    const manager = createWeatherManager({ dataRoot, requestJson: async () => ({ daily: {} }) });
    assert.throws(
      () => manager.saveLocation({ ...location, latitude: 900 }),
      (error) => error.code === 'weather-location-invalid'
    );
    assert.throws(
      () => manager.saveLocation({ ...location, timezone: '../../etc/passwd' }),
      (error) => error.code === 'weather-location-invalid'
    );
    assert.throws(
      () => manager.saveLocation({ ...location, country_code: 42 }),
      (error) => error.code === 'weather-location-invalid'
    );
    manager.saveLocation(location);
    await assert.rejects(manager.forecast(), (error) => error.code === 'weather-provider-invalid-response');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
