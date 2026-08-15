const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_LOCALE_PREFERENCES,
  createLocalePreferencesRecord,
  publicLocalePreferences,
  validateLocalePreferences
} = require('./localePreferences');

test('locale preferences accept the bounded first-run choices', () => {
  const preferences = {
    language: 'en',
    region: 'GB',
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    weekStartsOn: 'monday',
    measurementSystem: 'metric'
  };
  assert.deepEqual(validateLocalePreferences(preferences), {
    ok: true,
    code: null,
    preferences
  });
  const record = createLocalePreferencesRecord(preferences, { now: '2026-08-15T12:00:00.000Z' });
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.updatedAt, '2026-08-15T12:00:00.000Z');
  assert.deepEqual(publicLocalePreferences({ localePreferences: record }), preferences);
});

test('locale preferences default only when explicitly allowed and reject unknown values', () => {
  assert.deepEqual(
    validateLocalePreferences(undefined, { defaultWhenMissing: true }).preferences,
    DEFAULT_LOCALE_PREFERENCES
  );
  assert.equal(validateLocalePreferences(undefined).ok, false);
  assert.equal(validateLocalePreferences({ ...DEFAULT_LOCALE_PREFERENCES, region: 'ZZ' }).code, 'locale-region-invalid');
  assert.equal(publicLocalePreferences({ localePreferences: { schemaVersion: 2, ...DEFAULT_LOCALE_PREFERENCES } }), null);
});
