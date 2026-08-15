const LOCALE_PREFERENCES_SCHEMA_VERSION = 1;

const LOCALE_PREFERENCE_OPTIONS = Object.freeze({
  language: Object.freeze(['tr', 'en']),
  region: Object.freeze(['TR', 'US', 'GB', 'DE', 'FR']),
  timeZone: Object.freeze([
    'browser',
    'Europe/Istanbul',
    'UTC',
    'Europe/London',
    'Europe/Berlin',
    'America/New_York',
    'America/Los_Angeles'
  ]),
  hourCycle: Object.freeze(['regional', 'h12', 'h23']),
  weekStartsOn: Object.freeze(['regional', 'monday', 'sunday']),
  measurementSystem: Object.freeze(['regional', 'metric', 'imperial'])
});

const DEFAULT_LOCALE_PREFERENCES = Object.freeze({
  language: 'tr',
  region: 'TR',
  timeZone: 'browser',
  hourCycle: 'regional',
  weekStartsOn: 'regional',
  measurementSystem: 'regional'
});

function validateLocalePreferences(value, { defaultWhenMissing = false } = {}) {
  if ((value === undefined || value === null) && defaultWhenMissing) {
    return { ok: true, code: null, preferences: { ...DEFAULT_LOCALE_PREFERENCES } };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'locale-preferences-invalid', preferences: null };
  }

  const preferences = {};
  for (const [field, allowed] of Object.entries(LOCALE_PREFERENCE_OPTIONS)) {
    if (typeof value[field] !== 'string' || !allowed.includes(value[field])) {
      return { ok: false, code: `locale-${field}-invalid`, preferences: null };
    }
    preferences[field] = value[field];
  }
  return { ok: true, code: null, preferences };
}

function createLocalePreferencesRecord(value, { now = new Date().toISOString() } = {}) {
  const validation = validateLocalePreferences(value);
  if (!validation.ok) {
    const error = new TypeError('Locale preferences are invalid');
    error.code = validation.code;
    throw error;
  }
  return {
    schemaVersion: LOCALE_PREFERENCES_SCHEMA_VERSION,
    ...validation.preferences,
    updatedAt: now
  };
}

function publicLocalePreferences(authRecord) {
  const stored = authRecord && authRecord.localePreferences;
  if (!stored || stored.schemaVersion !== LOCALE_PREFERENCES_SCHEMA_VERSION) return null;
  const validation = validateLocalePreferences(stored);
  return validation.ok ? validation.preferences : null;
}

module.exports = {
  DEFAULT_LOCALE_PREFERENCES,
  LOCALE_PREFERENCES_SCHEMA_VERSION,
  LOCALE_PREFERENCE_OPTIONS,
  createLocalePreferencesRecord,
  publicLocalePreferences,
  validateLocalePreferences
};
