import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('Appearance replaces the empty Display tab with device-local working controls', () => {
  const settings = read('../src/apps/SettingsApp.jsx');
  const appearanceSettings = read('../src/apps/AppearanceSettings.jsx');
  const turkish = read('../src/locales/tr-TR.js');

  assert.match(settings, /import AppearanceSettings from '\.\/AppearanceSettings'/);
  assert.match(settings, /activeTab === 'display' && <AppearanceSettings target=\{target\}/);
  assert.match(turkish, /display: 'Görünüm'/);
  assert.match(appearanceSettings, /interfaceScale/);
  assert.match(appearanceSettings, /desktopIconSize/);
  assert.match(appearanceSettings, /desktopGridDensity/);
  assert.match(appearanceSettings, /dockAutoHide/);
  assert.match(appearanceSettings, /rememberWindowLayout/);
  assert.match(appearanceSettings, /maximizeSmallWindows/);
  assert.match(appearanceSettings, /reduceMotion/);
  assert.match(appearanceSettings, /highContrast/);
});

test('appearance preferences normalize and apply through explicit shell variables', () => {
  const appearance = read('../src/utils/appearance.js');
  const css = read('../src/index.css');

  assert.match(appearance, /appearanceShellMetrics/);
  assert.match(appearance, /appearanceDesktopMetrics/);
  assert.match(appearance, /applyAppearanceToDocument/);
  assert.match(appearance, /foxosDockAutoHide/);
  assert.match(css, /--foxos-dock-item-size/);
  assert.match(css, /data-foxos-dock-auto-hide="true"/);
  assert.match(css, /data-foxos-reduce-motion="true"/);
  assert.match(css, /data-foxos-high-contrast="true"/);
});

test('desktop appearance shortcuts open the exact Appearance section', () => {
  const desktop = read('../src/App.jsx');
  assert.match(desktop, /openAppearanceSettings/);
  assert.match(desktop, /openAppearanceSettings\('wallpaper'\)/);
  assert.match(desktop, /tab: 'display'/);
  assert.match(desktop, /section,/);
});

test('window geometry remains a bounded device-local convenience', () => {
  const context = read('../src/contexts/WindowContext.jsx');
  const layout = read('../src/utils/windowLayout.js');

  assert.match(layout, /WINDOW_LAYOUT_STORAGE_KEY = 'foxos_window_layout_v1'/);
  assert.match(layout, /Math\.max\(300/);
  assert.match(layout, /Math\.max\(200/);
  assert.match(context, /readWindowLayout/);
  assert.match(context, /writeWindowLayouts/);
  assert.match(context, /appearance\.rememberWindowLayout/);
});
