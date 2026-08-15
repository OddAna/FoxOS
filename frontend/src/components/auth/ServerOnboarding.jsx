import React, { useCallback, useState } from 'react';
import { CheckCircle2, Clock3, Info, Loader2 } from 'lucide-react';
import MigrationSettings from '../../apps/MigrationSettings';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import SetupShell from './SetupShell';

const ServerOnboarding = () => {
  const { completeOnboarding } = useAuth();
  const { t } = useI18n();
  const [scanState, setScanState] = useState('waiting');
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState(null);

  const handleScanComplete = useCallback((result) => {
    setScanState(result.success ? 'complete' : 'failed');
  }, []);

  const finish = async (resolution) => {
    setFinishing(true);
    setError(null);
    const result = await completeOnboarding(resolution);
    if (!result.success) {
      setError(result.error || t('auth.onboardingError'));
      setFinishing(false);
    }
  };

  const status = error || (scanState === 'complete'
    ? t('auth.onboardingScanComplete')
    : scanState === 'failed'
      ? t('auth.onboardingScanFailed')
      : t('auth.onboardingScanning'));

  return (
    <SetupShell
      currentStep={4}
      eyebrow={t('auth.onboardingEyebrow')}
      title={t('auth.onboardingTitle')}
      description={t('auth.onboardingDescription')}
      wide
      footer={(
        <div className="foxos-setup-actions onboarding-actions">
          <span className={error ? 'setup-error' : ''} aria-live="polite">{status}</span>
          <button
            className="foxos-setup-button"
            type="button"
            onClick={() => finish('deferred')}
            disabled={finishing}
          >
            <Clock3 size={15} /> {t('auth.onboardingSkip')}
          </button>
          <button
            className="foxos-setup-button is-primary"
            type="button"
            onClick={() => finish('reviewed')}
            disabled={finishing || scanState !== 'complete'}
          >
            {finishing ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
            {t('auth.onboardingDesktop')}
          </button>
        </div>
      )}
    >
      <div className="setup-server-intro">
        <Info size={16} />
        <span>{t('auth.onboardingSafetyNote')}</span>
      </div>
      <div className="setup-migration-surface">
        <MigrationSettings autoScan onScanComplete={handleScanComplete} />
      </div>
    </SetupShell>
  );
};

export default ServerOnboarding;
