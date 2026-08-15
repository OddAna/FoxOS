import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  Check,
  Clock3,
  Gauge,
  Globe2,
  Hash,
  Languages,
  MapPin,
  RotateCcw,
  Ruler,
  Sparkles,
  Thermometer
} from 'lucide-react';
import { useI18n } from '../contexts/LocaleContext';
import {
  DEFAULT_LOCALE_PREFERENCES,
  LANGUAGE_OPTIONS,
  REGION_OPTIONS,
  TIME_ZONE_OPTIONS
} from '../utils/locale';
import './LanguageRegionSettings.css';

const LanguageRegionSettings = () => {
  const {
    formatDate,
    formatNumber,
    formatTime,
    measurementSystem,
    preferences,
    savePreferences,
    t,
    timeZone,
    updatePreferences,
    weekStartsOn
  } = useI18n();
  const [now, setNow] = useState(() => new Date());
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!saved) return undefined;
    const timer = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(timer);
  }, [saved, preferences]);

  const persistPreferences = async (next) => {
    const previous = preferences;
    setSaving(true);
    setSaveError(false);
    updatePreferences(next);
    try {
      await savePreferences(next);
      setSaved(true);
    } catch {
      updatePreferences(previous);
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field, value) => {
    persistPreferences({ ...preferences, [field]: value });
  };

  const currentLanguage = LANGUAGE_OPTIONS.find((option) => option.id === preferences.language) || LANGUAGE_OPTIONS[0];
  const preview = useMemo(() => ({
    date: formatDate(now, { dateStyle: 'full' }),
    time: formatTime(now),
    number: formatNumber(1234567.89, { maximumFractionDigits: 2 }),
    temperature: measurementSystem === 'imperial' ? '70 °F' : '21 °C',
    distance: measurementSystem === 'imperial' ? '7.7 mi' : '12,4 km'
  }), [formatDate, formatNumber, formatTime, measurementSystem, now]);

  return (
    <div className="language-region-settings">
      <section className="language-region-hero">
        <div className="language-region-hero-copy">
          <span className="language-region-mark" aria-hidden="true"><Globe2 size={27} /></span>
          <div>
            <span className="language-region-kicker"><Sparkles size={12} /> {t('languageRegion.kicker')}</span>
            <h3>{t('languageRegion.heroTitle')}</h3>
            <p>{t('languageRegion.heroDescription')}</p>
          </div>
        </div>
        <div className="language-region-summary">
          <strong>{t(currentLanguage.nativeLabelKey)}</strong>
          <span>{t('languageRegion.activeLanguage')}</span>
          <em><i aria-hidden="true" /> {t('languageRegion.instant')}</em>
        </div>
      </section>

      <section className="language-region-section">
        <header className="language-region-heading">
          <div>
            <span className="language-region-section-kicker"><Languages size={13} /> {t('languageRegion.languageTitle')}</span>
            <p>{t('languageRegion.languageDescription')}</p>
          </div>
          {saving && <span className="language-region-saved" aria-live="polite">{t('languageRegion.saving')}</span>}
          {!saving && saveError && <span className="language-region-saved is-error" role="alert">{t('languageRegion.saveError')}</span>}
          {!saving && !saveError && saved && <span className="language-region-saved" aria-live="polite"><Check size={12} /> {t('languageRegion.saved')}</span>}
        </header>

        <div className="language-options" role="radiogroup" aria-label={t('languageRegion.languageTitle')}>
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = preferences.language === option.id;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                className={selected ? 'is-selected' : ''}
                key={option.id}
                onClick={() => updateField('language', option.id)}
              >
                <span className="language-option-code" aria-hidden="true">{option.id.toLocaleUpperCase('en-US')}</span>
                <span className="language-option-copy">
                  <strong>{t(option.nativeLabelKey)}</strong>
                  <small>{t(option.labelKey)}</small>
                </span>
                <em>{selected ? <Check size={13} /> : null}{t('languageRegion.complete')}</em>
              </button>
            );
          })}
        </div>
      </section>

      <div className="language-region-grid">
        <section className="language-region-section language-region-form-section">
          <header className="language-region-heading">
            <div>
              <span className="language-region-section-kicker"><MapPin size={13} /> {t('languageRegion.regionTitle')}</span>
              <p>{t('languageRegion.regionDescription')}</p>
            </div>
          </header>

          <div className="language-region-fields">
            <label>
              <span><Globe2 size={14} /> {t('languageRegion.region')}</span>
              <select value={preferences.region} onChange={(event) => updateField('region', event.target.value)}>
                {REGION_OPTIONS.map((region) => (
                  <option value={region} key={region}>{t(`languageRegion.regions.${region}`)}</option>
                ))}
              </select>
            </label>

            <label>
              <span><Clock3 size={14} /> {t('languageRegion.timeZone')}</span>
              <select value={preferences.timeZone} onChange={(event) => updateField('timeZone', event.target.value)}>
                {TIME_ZONE_OPTIONS.map((zone) => (
                  <option value={zone} key={zone}>
                    {zone === 'browser'
                      ? `${t('languageRegion.browserTimeZone')} · ${timeZone}`
                      : `${t(`languageRegion.timeZones.${zone}`)} · ${zone}`}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span><Gauge size={14} /> {t('languageRegion.clock')}</span>
              <select value={preferences.hourCycle} onChange={(event) => updateField('hourCycle', event.target.value)}>
                <option value="regional">{t('languageRegion.automatic')}</option>
                <option value="h23">{t('languageRegion.hour24')}</option>
                <option value="h12">{t('languageRegion.hour12')}</option>
              </select>
            </label>

            <label>
              <span><CalendarDays size={14} /> {t('languageRegion.weekStarts')}</span>
              <select value={preferences.weekStartsOn} onChange={(event) => updateField('weekStartsOn', event.target.value)}>
                <option value="regional">{t('languageRegion.automatic')} · {weekStartsOn === 1 ? t('languageRegion.monday') : t('languageRegion.sunday')}</option>
                <option value="monday">{t('languageRegion.monday')}</option>
                <option value="sunday">{t('languageRegion.sunday')}</option>
              </select>
            </label>

            <label className="is-wide">
              <span><Ruler size={14} /> {t('languageRegion.measurement')}</span>
              <select value={preferences.measurementSystem} onChange={(event) => updateField('measurementSystem', event.target.value)}>
                <option value="regional">{t('languageRegion.automatic')} · {measurementSystem === 'metric' ? t('languageRegion.metric') : t('languageRegion.imperial')}</option>
                <option value="metric">{t('languageRegion.metric')}</option>
                <option value="imperial">{t('languageRegion.imperial')}</option>
              </select>
            </label>
          </div>

          <button
            type="button"
            className="language-region-reset"
            onClick={() => {
              persistPreferences({ ...DEFAULT_LOCALE_PREFERENCES });
            }}
            disabled={saving}
          >
            <RotateCcw size={13} /> {t('languageRegion.reset')}
          </button>
        </section>

        <section className="language-region-section language-preview-section">
          <header className="language-region-heading">
            <div>
              <span className="language-region-section-kicker"><Sparkles size={13} /> {t('languageRegion.previewTitle')}</span>
              <p>{t('languageRegion.previewDescription')}</p>
            </div>
          </header>

          <div className="language-preview-clock">
            <strong>{preview.time}</strong>
            <span>{preview.date}</span>
          </div>

          <div className="language-preview-facts">
            <div><span><Hash size={13} /> {t('languageRegion.number')}</span><strong>{preview.number}</strong></div>
            <div><span><Thermometer size={13} /> {t('languageRegion.temperature')}</span><strong>{preview.temperature}</strong></div>
            <div><span><Ruler size={13} /> {t('languageRegion.distance')}</span><strong>{preview.distance}</strong></div>
          </div>

          <p className="language-preview-note">{t('languageRegion.browserStorage')}</p>
        </section>
      </div>
    </div>
  );
};

export default LanguageRegionSettings;
