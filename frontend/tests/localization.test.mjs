import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import enUS from '../src/locales/en-US.js';
import trTR from '../src/locales/tr-TR.js';
import {
  DEFAULT_LOCALE_PREFERENCES,
  flattenCatalog,
  normalizeLocalePreferences,
  readLocalePreferences,
  resolvedHour12,
  resolvedLocale,
  resolvedMeasurementSystem,
  resolvedWeekStartsOn,
  translateMessage,
  writeLocalePreferences
} from '../src/utils/locale.js';

const frontendRoot = path.resolve(new URL('..', import.meta.url).pathname);
const sourceRoot = path.join(frontendRoot, 'src');

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const absolute = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(absolute) : [absolute];
});

test('Turkish and English catalogs expose the same complete string key set', () => {
  const turkish = flattenCatalog(trTR);
  const english = flattenCatalog(enUS);
  assert.deepEqual(Object.keys(turkish).sort(), Object.keys(english).sort());
  assert.ok(Object.keys(turkish).length > 1_000);
  for (const [key, value] of Object.entries(turkish)) {
    assert.equal(typeof value, 'string', `Turkish value must be a string: ${key}`);
    assert.equal(typeof english[key], 'string', `English value must be a string: ${key}`);
  }
  assert.equal(translateMessage('en', 'desktop.pageLabel', { page: 2, count: 4 }), 'Desktop page 2 of 4');
  assert.equal(translateMessage('tr', 'desktop.pageLabel', { page: 2, count: 4 }), 'Masaüstü sayfası 2 / 4');
});

test('locale preferences normalize safely and resolve independent regional choices', () => {
  assert.deepEqual(normalizeLocalePreferences({ language: 'xx', region: 'ZZ' }), DEFAULT_LOCALE_PREFERENCES);
  const englishUs = normalizeLocalePreferences({
    language: 'en',
    region: 'US',
    timeZone: 'America/New_York',
    hourCycle: 'h12',
    weekStartsOn: 'regional',
    measurementSystem: 'regional'
  });
  assert.equal(resolvedLocale(englishUs), 'en-US');
  assert.equal(resolvedHour12(englishUs), true);
  assert.equal(resolvedWeekStartsOn(englishUs), 0);
  assert.equal(resolvedMeasurementSystem(englishUs), 'imperial');

  const turkishGb = normalizeLocalePreferences({
    language: 'tr',
    region: 'GB',
    hourCycle: 'h23',
    weekStartsOn: 'regional',
    measurementSystem: 'regional'
  });
  assert.equal(resolvedLocale(turkishGb), 'tr-GB');
  assert.equal(resolvedHour12(turkishGb), false);
  assert.equal(resolvedWeekStartsOn(turkishGb), 1);
  assert.equal(resolvedMeasurementSystem(turkishGb), 'metric');
});

test('locale preferences persist and announce an immediate browser-wide change', () => {
  const values = new Map();
  const events = [];
  const previousWindow = globalThis.window;
  globalThis.window = {
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    dispatchEvent: (event) => events.push(event),
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    }
  };
  try {
    const saved = writeLocalePreferences({
      language: 'en',
      region: 'GB',
      timeZone: 'Europe/London',
      hourCycle: 'h23',
      weekStartsOn: 'monday',
      measurementSystem: 'metric'
    });
    assert.deepEqual(readLocalePreferences(), saved);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'foxos:locale-changed');
    assert.deepEqual(events[0].detail, saved);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('the locale provider owns the shell and Language & Region exposes real controls', () => {
  const main = readFileSync(path.join(sourceRoot, 'main.jsx'), 'utf8');
  const settings = readFileSync(path.join(sourceRoot, 'apps/SettingsApp.jsx'), 'utf8');
  const languageRegion = readFileSync(path.join(sourceRoot, 'apps/LanguageRegionSettings.jsx'), 'utf8');
  assert.match(main, /<LocaleProvider>/);
  assert.match(main, /<AuthProvider>/);
  assert.ok(main.indexOf('<LocaleProvider>') < main.indexOf('<AuthProvider>'));
  assert.match(settings, /<LanguageRegionSettings/);
  assert.match(languageRegion, /LANGUAGE_OPTIONS/);
  assert.match(languageRegion, /REGION_OPTIONS/);
  assert.match(languageRegion, /TIME_ZONE_OPTIONS/);
  assert.match(languageRegion, /updatePreferences/);
  assert.match(languageRegion, /savePreferences/);
  assert.match(languageRegion, /persistPreferences/);
  assert.match(languageRegion, /languageRegion\.previewTitle/);
});

test('visible Turkish copy cannot drift back outside the locale catalogs', () => {
  const technicalAllowlist = new Map([
    ['src/App.jsx', /Masaüstü/],
    ['src/apps/FilesApp.jsx', /Masaüstü|İndirilenler|Çöp Kutusu/],
    ['src/apps/NotificationSettings.jsx', /TELEGRAM BAĞLANTISINI KALDIR/],
    ['src/components/Dock.jsx', /Masaüstü|Çöp Kutusu/],
    ['src/components/SpotlightSearch.jsx', /Masaüstü|Çöp Kutusu/],
    ['src/utils/applicationUpdates.js', /UYGULAMA GÜNCELLEMESİNİ (?:UYGULA|GERİ AL)/],
    ['src/utils/desktopShortcuts.js', /Masaüstü/],
    ['src/utils/spotlightSearch.js', /[çğıöşü]/]
  ]);
  const violations = [];
  for (const absolute of walk(sourceRoot)) {
    if (!/\.[cm]?[jt]sx?$/.test(absolute) || absolute.includes(`${path.sep}locales${path.sep}`)) continue;
    const relative = path.relative(frontendRoot, absolute).split(path.sep).join('/');
    const allowed = technicalAllowlist.get(relative);
    readFileSync(absolute, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (!/[ÇĞİÖŞÜçğıöşü]/.test(line)) return;
      if (!allowed || !allowed.test(line)) violations.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(violations, []);
});

test('every visible JSX surface participates in the central locale layer', () => {
  const exemptions = new Set([
    'src/main.jsx',
    'src/components/ApplicationLogo.jsx',
    'src/utils/fileIcons.jsx'
  ]);
  const missing = walk(sourceRoot)
    .filter((absolute) => absolute.endsWith('.jsx'))
    .map((absolute) => path.relative(frontendRoot, absolute).split(path.sep).join('/'))
    .filter((relative) => !relative.startsWith('src/locales/') && !exemptions.has(relative))
    .filter((relative) => !/useI18n/.test(readFileSync(path.join(frontendRoot, relative), 'utf8')));
  assert.deepEqual(missing, []);
});
