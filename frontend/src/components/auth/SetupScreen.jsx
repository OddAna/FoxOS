import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  Eye,
  EyeOff,
  Globe2,
  Info,
  Loader2,
  LockKeyhole,
  Radar,
  ShieldCheck
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import {
  LANGUAGE_OPTIONS,
  REGION_OPTIONS,
  TIME_ZONE_OPTIONS
} from '../../utils/locale';
import SetupShell from './SetupShell';

const SetupScreen = () => {
  const { setup } = useAuth();
  const {
    formatDate,
    formatNumber,
    formatTime,
    measurementSystem,
    preferences,
    t,
    timeZone,
    updatePreferences
  } = useI18n();
  const [step, setStep] = useState(1);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const passwordLengthValid = [...password].length >= 15;
  const normalizedUsername = username.trim().toLocaleLowerCase('en-US');
  const passwordExcludesUsername = normalizedUsername.length < 3 || !password.toLocaleLowerCase('en-US').includes(normalizedUsername);
  const passwordsMatch = password.length > 0 && password === passwordConfirmation;
  const ownerNameValid = username.trim().length > 0 && username.trim().length <= 128;
  const accountReady = ownerNameValid && passwordLengthValid && passwordExcludesUsername && passwordsMatch;
  const connectionProtected = typeof window === 'undefined' || window.isSecureContext === true;

  const preview = useMemo(() => {
    const now = new Date();
    return {
      date: formatDate(now, { dateStyle: 'full' }),
      time: formatTime(now),
      number: formatNumber(1234567.89, { maximumFractionDigits: 2 })
    };
  }, [formatDate, formatNumber, formatTime]);

  const copy = {
    1: {
      eyebrow: t('auth.welcomeEyebrow'),
      title: t('auth.welcomeTitle'),
      description: t('auth.welcomeDescription')
    },
    2: {
      eyebrow: t('auth.ownerEyebrow'),
      title: t('auth.ownerTitle'),
      description: t('auth.ownerDescription')
    },
    3: {
      eyebrow: t('auth.regionEyebrow'),
      title: t('auth.regionTitle'),
      description: t('auth.regionDescription')
    }
  }[step];

  const continueFromAccount = () => {
    if (!accountReady) {
      setError(t('auth.accountValidation'));
      return;
    }
    setError(null);
    setStep(3);
  };

  const handleSetup = async () => {
    if (!accountReady) {
      setError(t('auth.accountValidation'));
      setStep(2);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await setup(username.trim(), password, preferences);
    if (!result.success) {
      setError(result.code && result.code.startsWith('password-')
        ? t('auth.passwordPolicyError')
        : result.code && result.code.startsWith('locale-')
          ? t('auth.localePolicyError')
          : t('auth.setupError'));
      if (result.code && (result.code.startsWith('password-') || result.code === 'username-invalid')) setStep(2);
      setLoading(false);
    }
  };

  const footer = (
    <div className="foxos-setup-actions">
      {error && <span className="setup-error" role="alert">{error}</span>}
      {step > 1 && (
        <button
          className="foxos-setup-button"
          type="button"
          disabled={loading}
          onClick={() => {
            setError(null);
            setStep((current) => current - 1);
          }}
        >
          <ArrowLeft size={15} /> {t('common.back')}
        </button>
      )}
      <button
        className="foxos-setup-button is-primary"
        type="button"
        disabled={loading || (step === 2 && !accountReady)}
        onClick={step === 1
          ? () => setStep(2)
          : step === 2
            ? continueFromAccount
            : handleSetup}
      >
        {loading
          ? <><Loader2 size={15} className="spin" /> {t('auth.setupWorking')}</>
          : <>{step === 1 ? t('auth.startSetup') : step === 2 ? t('common.continue') : t('auth.createOwnerAndScan')}<ArrowRight size={15} /></>}
      </button>
    </div>
  );

  return (
    <SetupShell
      currentStep={step}
      eyebrow={copy.eyebrow}
      title={copy.title}
      description={copy.description}
      footer={footer}
    >
      {step === 1 && (
        <>
          <div className="setup-welcome-grid">
            <div className="setup-trust-card">
              <Database size={18} />
              <strong>{t('auth.serverOwnedTitle')}</strong>
              <span>{t('auth.serverOwnedDescription')}</span>
            </div>
            <div className="setup-trust-card">
              <ShieldCheck size={18} />
              <strong>{t('auth.noAccountTitle')}</strong>
              <span>{t('auth.noAccountDescription')}</span>
            </div>
            <div className="setup-trust-card">
              <Radar size={18} />
              <strong>{t('auth.readOnlyScanTitle')}</strong>
              <span>{t('auth.readOnlyScanDescription')}</span>
            </div>
          </div>

          <span className="setup-section-label">{t('auth.interfaceLanguage')}</span>
          <div className="setup-language-options" role="radiogroup" aria-label={t('auth.interfaceLanguage')}>
            {LANGUAGE_OPTIONS.map((option) => {
              const selected = preferences.language === option.id;
              return (
                <button
                  className={`setup-choice${selected ? ' is-selected' : ''}`}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  key={option.id}
                  onClick={() => updatePreferences((current) => ({ ...current, language: option.id }))}
                >
                  <span className="setup-choice-code">{option.id.toLocaleUpperCase('en-US')}</span>
                  <span className="setup-choice-copy">
                    <strong>{t(option.nativeLabelKey)}</strong>
                    <small>{t('auth.languageSupport')}</small>
                  </span>
                  {selected && <Check size={15} />}
                </button>
              );
            })}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="setup-form-grid">
            <label className="is-wide">
              {t('auth.ownerName')}
              <input
                autoComplete="username"
                autoFocus
                maxLength={128}
                placeholder={t('auth.ownerNamePlaceholder')}
                type="text"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <label>
              {t('auth.passwordLabel')}
              <div className="setup-password-field">
                <input
                  autoComplete="new-password"
                  placeholder={t('auth.passwordRule')}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError(null);
                  }}
                />
                <button
                  className="setup-password-toggle"
                  type="button"
                  aria-label={t(showPassword ? 'auth.hidePassword' : 'auth.showPassword')}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            <label>
              {t('auth.passwordConfirmation')}
              <div className="setup-password-field">
                <input
                  autoComplete="new-password"
                  placeholder={t('auth.passwordConfirmationPlaceholder')}
                  type={showPassword ? 'text' : 'password'}
                  value={passwordConfirmation}
                  onChange={(event) => {
                    setPasswordConfirmation(event.target.value);
                    setError(null);
                  }}
                />
                <span className="setup-password-toggle" aria-hidden="true"><LockKeyhole size={15} /></span>
              </div>
            </label>
          </div>

          <div className="setup-password-checks" aria-live="polite">
            <span className={passwordLengthValid ? 'is-valid' : ''}><Check size={12} /> {t('auth.passwordLengthCheck')}</span>
            <span className={passwordExcludesUsername ? 'is-valid' : ''}><Check size={12} /> {t('auth.passwordUsernameCheck')}</span>
            <span className={passwordsMatch ? 'is-valid' : ''}><Check size={12} /> {t('auth.passwordMatchCheck')}</span>
          </div>

          <div className="setup-connection-note">
            {connectionProtected ? <ShieldCheck size={15} /> : <Info size={15} />}
            <span>{t(connectionProtected ? 'auth.protectedConnection' : 'auth.unprotectedConnection')}</span>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="setup-region-grid">
            <label>
              {t('languageRegion.region')}
              <select
                value={preferences.region}
                onChange={(event) => updatePreferences((current) => ({ ...current, region: event.target.value }))}
              >
                {REGION_OPTIONS.map((region) => (
                  <option value={region} key={region}>{t(`languageRegion.regions.${region}`)}</option>
                ))}
              </select>
            </label>
            <label>
              {t('languageRegion.timeZone')}
              <select
                value={preferences.timeZone}
                onChange={(event) => updatePreferences((current) => ({ ...current, timeZone: event.target.value }))}
              >
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
              {t('languageRegion.clock')}
              <select
                value={preferences.hourCycle}
                onChange={(event) => updatePreferences((current) => ({ ...current, hourCycle: event.target.value }))}
              >
                <option value="regional">{t('languageRegion.automatic')}</option>
                <option value="h23">{t('languageRegion.hour24')}</option>
                <option value="h12">{t('languageRegion.hour12')}</option>
              </select>
            </label>
            <label>
              {t('languageRegion.measurement')}
              <select
                value={preferences.measurementSystem}
                onChange={(event) => updatePreferences((current) => ({ ...current, measurementSystem: event.target.value }))}
              >
                <option value="regional">{t('languageRegion.automatic')} · {measurementSystem === 'metric' ? t('languageRegion.metric') : t('languageRegion.imperial')}</option>
                <option value="metric">{t('languageRegion.metric')}</option>
                <option value="imperial">{t('languageRegion.imperial')}</option>
              </select>
            </label>
          </div>

          <div className="setup-region-preview" aria-label={t('languageRegion.previewTitle')}>
            <div><span>{t('languageRegion.date')}</span><strong>{preview.date}</strong></div>
            <div><span>{t('languageRegion.time')}</span><strong>{preview.time}</strong></div>
            <div><span>{t('languageRegion.number')}</span><strong>{preview.number}</strong></div>
          </div>

          <div className="setup-region-note">
            <Globe2 size={15} />
            <span>{t('auth.hostTimeZoneNote')}</span>
          </div>
        </>
      )}
    </SetupShell>
  );
};

export default SetupScreen;
