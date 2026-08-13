import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeSpotlightText,
  searchSpotlightItems
} from '../src/utils/spotlightSearch.js';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const items = [
  { id: 'server', title: 'Sunucu', subtitle: 'Host durumu', keywords: ['docker'], featured: true, priority: 10 },
  { id: 'apps', title: 'Uygulama Yöneticisi', subtitle: 'Servisleri yönet', keywords: ['containers'], featured: true, priority: 20 },
  { id: 'trash', title: 'Çöp Kutusu', subtitle: 'Silinen dosyalar', keywords: ['trash'], priority: 30 },
  { id: 'n8n', title: 'n8n', subtitle: 'Çalışıyor · Sunucu uygulaması', keywords: ['automation'], priority: 200 }
];

test('Spotlight search normalizes Turkish characters and ASCII input', () => {
  assert.equal(normalizeSpotlightText('Çöp Kutusu / Uygulama Yöneticisi'), 'cop kutusu uygulama yoneticisi');
  assert.equal(searchSpotlightItems(items, 'uygulama yoneticisi')[0].id, 'apps');
  assert.equal(searchSpotlightItems(items, 'cop kutusu')[0].id, 'trash');
});

test('Spotlight search ranks exact application names and keeps featured defaults bounded', () => {
  assert.equal(searchSpotlightItems(items, 'n8n')[0].id, 'n8n');
  assert.deepEqual(searchSpotlightItems(items, '', 2).map((item) => item.id), ['server', 'apps']);
  assert.deepEqual(searchSpotlightItems(items, 'host docker').map((item) => item.id), ['server']);
  assert.deepEqual(searchSpotlightItems(items, 'bulunmayan'), []);
});

test('FoxOS shell exposes a real Spotlight trigger, shortcut and actionable sources', () => {
  const topBar = read('../src/components/TopBar.jsx');
  const spotlight = read('../src/components/SpotlightSearch.jsx');
  const desktop = read('../src/App.jsx');

  assert.match(topBar, /topbar-search-trigger/);
  assert.match(topBar, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(topBar, /event\.code === 'Space'/);
  assert.match(spotlight, /role="dialog"/);
  assert.match(spotlight, /role="listbox"/);
  assert.match(spotlight, /onOpenApplication\(application\)/);
  assert.match(spotlight, /onOpenDesktopFile\(file\)/);
  assert.match(desktop, /onOpenApplication=\{handleOpenApplication\}/);
  assert.match(desktop, /onOpenDesktopFile=\{handleFileDoubleClick\}/);
});
