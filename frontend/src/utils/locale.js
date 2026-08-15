import enUS from '../locales/en-US.js';
import trTR from '../locales/tr-TR.js';

export const LOCALE_STORAGE_KEY = 'foxos_locale_v1';
export const LOCALE_CHANGE_EVENT = 'foxos:locale-changed';

export const LANGUAGE_OPTIONS = Object.freeze([
  { id: 'tr', locale: 'tr-TR', labelKey: 'languageRegion.turkish', nativeLabelKey: 'languageRegion.nativeTurkish' },
  { id: 'en', locale: 'en-US', labelKey: 'languageRegion.english', nativeLabelKey: 'languageRegion.nativeEnglish' }
]);

export const REGION_OPTIONS = Object.freeze(['TR', 'US', 'GB', 'DE', 'FR']);
export const TIME_ZONE_OPTIONS = Object.freeze([
  'browser',
  'Europe/Istanbul',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles'
]);

export const DEFAULT_LOCALE_PREFERENCES = Object.freeze({
  language: 'tr',
  region: 'TR',
  timeZone: 'browser',
  hourCycle: 'regional',
  weekStartsOn: 'regional',
  measurementSystem: 'regional'
});

export const catalogs = Object.freeze({ tr: trTR, en: enUS });

const pathValue = (object, path) => path.split('.').reduce((value, segment) => (
  value && Object.hasOwn(value, segment) ? value[segment] : undefined
), object);

export const interpolate = (message, values = {}) => String(message).replace(/{{\s*([\w.-]+)\s*}}/g, (match, key) => (
  Object.hasOwn(values, key) ? String(values[key]) : match
));

export const translateMessage = (language, key, values) => {
  const catalog = catalogs[language] || catalogs.tr;
  const message = pathValue(catalog, key) ?? pathValue(catalogs.tr, key) ?? key;
  return interpolate(message, values);
};

export const normalizeLocalePreferences = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  return {
    language: LANGUAGE_OPTIONS.some((option) => option.id === source.language) ? source.language : DEFAULT_LOCALE_PREFERENCES.language,
    region: REGION_OPTIONS.includes(source.region) ? source.region : DEFAULT_LOCALE_PREFERENCES.region,
    timeZone: TIME_ZONE_OPTIONS.includes(source.timeZone) ? source.timeZone : DEFAULT_LOCALE_PREFERENCES.timeZone,
    hourCycle: ['regional', 'h12', 'h23'].includes(source.hourCycle) ? source.hourCycle : DEFAULT_LOCALE_PREFERENCES.hourCycle,
    weekStartsOn: ['regional', 'monday', 'sunday'].includes(source.weekStartsOn) ? source.weekStartsOn : DEFAULT_LOCALE_PREFERENCES.weekStartsOn,
    measurementSystem: ['regional', 'metric', 'imperial'].includes(source.measurementSystem)
      ? source.measurementSystem
      : DEFAULT_LOCALE_PREFERENCES.measurementSystem
  };
};

export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const resolvedLocale = (preferences) => `${preferences.language}-${preferences.region}`;
export const resolvedTimeZone = (preferences) => preferences.timeZone === 'browser'
  ? browserTimeZone()
  : preferences.timeZone;

export const resolvedHour12 = (preferences) => preferences.hourCycle === 'regional'
  ? undefined
  : preferences.hourCycle === 'h12';

export const resolvedWeekStartsOn = (preferences) => {
  if (preferences.weekStartsOn === 'monday') return 1;
  if (preferences.weekStartsOn === 'sunday') return 0;
  return ['US'].includes(preferences.region) ? 0 : 1;
};

export const resolvedMeasurementSystem = (preferences) => {
  if (preferences.measurementSystem !== 'regional') return preferences.measurementSystem;
  return preferences.region === 'US' ? 'imperial' : 'metric';
};

export const readLocalePreferences = () => {
  if (typeof window === 'undefined') return { ...DEFAULT_LOCALE_PREFERENCES };
  try {
    return normalizeLocalePreferences(JSON.parse(window.localStorage.getItem(LOCALE_STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_LOCALE_PREFERENCES };
  }
};

export const writeLocalePreferences = (value) => {
  const normalized = normalizeLocalePreferences(value);
  if (typeof window === 'undefined') return normalized;
  window.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify(normalized));
  if (typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(LOCALE_CHANGE_EVENT, { detail: normalized }));
  }
  return normalized;
};

export const flattenCatalog = (catalog, prefix = '') => Object.entries(catalog).reduce((result, [key, value]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  if (value && typeof value === 'object') Object.assign(result, flattenCatalog(value, path));
  else result[path] = value;
  return result;
}, {});
