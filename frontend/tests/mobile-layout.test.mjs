import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mobileDesktopLayout, paginateDesktopItems } from '../src/utils/mobileDesktopLayout.js';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('the shell uses the dynamic viewport and device safe areas', () => {
  const html = read('../index.html');
  const css = read('../src/index.css');

  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /@supports \(height: 100dvh\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('the mobile lock-screen blur covers the complete viewport', () => {
  const lockScreen = read('../src/components/auth/LockScreen.jsx');
  const css = read('../src/index.css');

  assert.match(lockScreen, /className="lock-screen-backdrop"/);
  assert.match(lockScreen, /position: 'absolute', inset: 0/);
  assert.match(lockScreen, /WebkitBackdropFilter: 'blur\(30px\)'/);
  assert.doesNotMatch(lockScreen, /className="lock-card"/);
  assert.match(css, /\.lock-screen-backdrop\s*\{\s*inset: 0 !important;\s*width: auto !important;\s*height: auto !important;\s*\}/);
  assert.doesNotMatch(css, /\.lock-card\s*\{/);
});

test('mobile windows fill the usable desktop without drag or resize handles', () => {
  const desktop = read('../src/App.jsx');
  const windowComponent = read('../src/components/Window.jsx');

  assert.match(desktop, /className="window-layer"/);
  assert.match(desktop, /isMobileViewport/);
  assert.match(windowComponent, /isMobileWindow \? '100%'/);
  assert.match(windowComponent, /!win\.isMaximized && !isMobileWindow/);
});

test('mobile desktop icons paginate into stable iPhone-style grid pages', () => {
  const desktop = read('../src/App.jsx');
  const css = read('../src/index.css');
  const layout = mobileDesktopLayout({ width: 390, height: 844, itemCount: 50 });
  const pages = paginateDesktopItems(Array.from({ length: 50 }, (_, index) => index), layout.itemsPerPage);

  assert.deepEqual(layout, { columns: 4, rows: 6, itemsPerPage: 24, pageCount: 3 });
  assert.deepEqual(pages.map((page) => page.length), [24, 24, 2]);
  assert.match(desktop, /className={`desktop-grid\$\{isMobileViewport \? ' is-mobile' : ''\}`}/);
  assert.match(desktop, /data-mobile-desktop-page/);
  assert.match(desktop, /isMobileViewport \|\| e\.pointerType === 'touch'/);
  assert.match(css, /scroll-snap-type: x mandatory/);
  assert.match(css, /grid-template-columns: repeat\(var\(--mobile-desktop-columns\)/);
});

test('fixed desktop sidebars and grids expose responsive hooks', () => {
  const settings = read('../src/apps/SettingsApp.jsx');
  const files = read('../src/apps/FilesApp.jsx');
  const store = read('../src/apps/AppStoreApp.jsx');
  const server = read('../src/apps/ServerApp.jsx');
  const css = read('../src/index.css');

  assert.match(settings, /className="settings-sidebar"/);
  assert.match(files, /className="files-toolbar"/);
  assert.match(store, /className="store-grid"/);
  assert.match(server, /className="server-metrics"/);
  assert.match(css, /\.store-grid\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('Codex starts with a closed mobile drawer and provides a dismiss backdrop', () => {
  const app = read('../src/apps/CodexApp.jsx');
  const css = read('../src/apps/CodexApp.css');

  assert.match(app, /useState\(\(\) => !mobileViewport\(\)\)/);
  assert.match(app, /className="codex-sidebar-backdrop"/);
  assert.match(css, /\.codex-sidebar-backdrop\s*\{/);
  assert.match(css, /width: min\(86vw, 300px\)/);
});
