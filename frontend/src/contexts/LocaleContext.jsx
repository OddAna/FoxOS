/* oxlint-disable react/only-export-components -- locale hook and provider intentionally share a module */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  LOCALE_CHANGE_EVENT,
  LOCALE_STORAGE_KEY,
  normalizeLocalePreferences,
  readLocalePreferences,
  resolvedHour12,
  resolvedLocale,
  resolvedMeasurementSystem,
  resolvedTimeZone,
  resolvedWeekStartsOn,
  translateMessage,
  writeLocalePreferences
} from '../utils/locale';

const LocaleContext = createContext(null);

export const LocaleProvider = ({ children }) => {
  const [preferences, setPreferences] = useState(readLocalePreferences);

  useEffect(() => {
    const onLocaleChange = (event) => setPreferences(normalizeLocalePreferences(event.detail));
    const onStorage = (event) => {
      if (event.key === LOCALE_STORAGE_KEY) setPreferences(readLocalePreferences());
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, onLocaleChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(LOCALE_CHANGE_EVENT, onLocaleChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = preferences.language;
    document.documentElement.dir = 'ltr';
  }, [preferences.language]);

  const updatePreferences = useCallback((next) => {
    const current = readLocalePreferences();
    return writeLocalePreferences(typeof next === 'function' ? next(current) : next);
  }, []);

  const savePreferences = useCallback(async (next) => {
    const current = readLocalePreferences();
    const normalized = normalizeLocalePreferences(typeof next === 'function' ? next(current) : next);
    const response = await fetch('/api/settings/locale', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localePreferences: normalized })
    });
    const payload = await response.json();
    if (!response.ok || !payload.localePreferences) {
      const error = new Error(payload.error || 'Locale preferences could not be saved');
      error.code = payload.code || 'locale-save-failed';
      throw error;
    }
    return writeLocalePreferences(payload.localePreferences);
  }, []);

  const locale = resolvedLocale(preferences);
  const timeZone = resolvedTimeZone(preferences);
  const hour12 = resolvedHour12(preferences);
  const weekStartsOn = resolvedWeekStartsOn(preferences);
  const measurementSystem = resolvedMeasurementSystem(preferences);
  const t = useCallback((key, values) => translateMessage(preferences.language, key, values), [preferences.language]);
  const formatDate = useCallback((value, options = {}) => new Intl.DateTimeFormat(locale, {
    timeZone,
    ...options
  }).format(value instanceof Date ? value : new Date(value)), [locale, timeZone]);
  const formatTime = useCallback((value, options = {}) => new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    ...(hour12 === undefined ? {} : { hour12 }),
    ...options
  }).format(value instanceof Date ? value : new Date(value)), [hour12, locale, timeZone]);
  const formatNumber = useCallback((value, options = {}) => new Intl.NumberFormat(locale, options).format(value), [locale]);

  const contextValue = useMemo(() => ({
    formatDate,
    formatNumber,
    formatTime,
    hour12,
    locale,
    measurementSystem,
    preferences,
    savePreferences,
    t,
    timeZone,
    updatePreferences,
    weekStartsOn
  }), [formatDate, formatNumber, formatTime, hour12, locale, measurementSystem, preferences, savePreferences, t, timeZone, updatePreferences, weekStartsOn]);

  return <LocaleContext.Provider value={contextValue}>{children}</LocaleContext.Provider>;
};

export const useI18n = () => {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('FoxOS locale context is unavailable');
  return context;
};
