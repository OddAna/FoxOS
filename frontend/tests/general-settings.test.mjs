import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('general settings is a real dashboard with system and update surfaces', () => {
  const settings = read('../src/apps/SettingsApp.jsx');
  const general = read('../src/apps/GeneralSettings.jsx');

  assert.match(settings, /import GeneralSettings from '\.\/GeneralSettings'/);
  assert.match(settings, /<GeneralSettings onNavigate=\{navigateToTab\} \/>/);
  assert.match(general, /\/api\/system/);
  assert.match(general, /t\('general\.updateKicker'\)/);
  assert.match(general, /t\('general\.serverKicker'\)/);
  assert.match(general, /t\('general\.manualChannel'\)/);
  assert.match(general, /openServerApp/);
});

test('application update checks stay read-only until the user opens application management', () => {
  const general = read('../src/apps/GeneralSettings.jsx');

  assert.match(general, /`\/api\/applications\/\$\{application\.id\}\/update-check`/);
  assert.match(general, /onNavigate\('applications'\)/);
  assert.doesNotMatch(general, /update-plans/);
  assert.doesNotMatch(general, /application-update-plans/);
});

test('wallpaper preferences apply live to desktop and optionally to the lock screen', () => {
  const appearance = read('../src/utils/appearance.js');
  const appearanceSettings = read('../src/apps/AppearanceSettings.jsx');
  const desktop = read('../src/App.jsx');
  const lockScreen = read('../src/components/auth/LockScreen.jsx');

  assert.match(appearance, /APPEARANCE_STORAGE_KEY = 'foxos_appearance_v1'/);
  assert.match(appearance, /APPEARANCE_CHANGE_EVENT = 'foxos:appearance-changed'/);
  assert.match(appearance, /WALLPAPER_PRESETS/);
  assert.match(appearance, /useOnLockScreen/);
  assert.match(appearanceSettings, /appearance\.wallpaperTitle/);
  assert.match(appearanceSettings, /appearanceBackground\(appearance\)/);
  assert.match(desktop, /style=\{desktopAppearance\}/);
  assert.match(lockScreen, /appearanceBackground\(appearance, \{ lockScreen: true \}\)/);
});

test('general layout responds to the settings window width', () => {
  const general = read('../src/apps/GeneralSettings.jsx');
  const css = read('../src/apps/GeneralSettings.css');

  assert.match(general, /import '\.\/GeneralSettings\.css'/);
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /@container \(max-width: 720px\)/);
  assert.match(css, /@container \(max-width: 540px\)/);
  assert.match(css, /\.general-lower-grid\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});
