import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { weatherTemperatureFromPayload } from '../src/utils/weatherStatus.js';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('weather app uses server-proxied location and forecast APIs with attribution', () => {
  const weather = read('../src/apps/WeatherApp.jsx');
  assert.match(weather, /\/api\/weather\/locations\?q=/);
  assert.match(weather, /\/api\/weather\/location/);
  assert.match(weather, /\/api\/weather\?refresh=1/);
  assert.match(weather, /weatherApp\.attribution/);
  assert.match(weather, /measurementSystem === 'imperial'/);
  assert.match(weather, /value \* 0\.621371/);
});

test('menu weather temperature is rounded only for a configured forecast', () => {
  assert.equal(weatherTemperatureFromPayload({ configured: true, current: { temperature: 23.6 } }), 24);
  assert.equal(weatherTemperatureFromPayload({ configured: false, current: { temperature: 23.6 } }), null);
  assert.equal(weatherTemperatureFromPayload({ configured: true, current: { temperature: null } }), null);
});

test('weather app is available from the window renderer, menu bar and Spotlight', () => {
  const app = read('../src/App.jsx');
  const dock = read('../src/components/Dock.jsx');
  const topBar = read('../src/components/TopBar.jsx');
  const weather = read('../src/apps/WeatherApp.jsx');
  const spotlight = read('../src/components/SpotlightSearch.jsx');
  assert.match(app, /case 'weather': return <WeatherApp/);
  assert.doesNotMatch(dock, /app-weather/);
  assert.match(topBar, /topbar-weather-trigger/);
  assert.match(topBar, /type: 'weather'/);
  assert.match(topBar, /apiFetch\('\/api\/weather'\)/);
  assert.match(topBar, /measurementSystem === 'imperial'/);
  assert.match(topBar, /shell\.openWeatherTemperature/);
  assert.match(weather, /publishWeatherUpdate\(payload\)/);
  assert.match(spotlight, /id: 'system-weather'/);
});
