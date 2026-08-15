import React from 'react';
import { Check, LockKeyhole, MapPin, Radar, ShieldCheck, Sparkles } from 'lucide-react';
import foxWallpaper from '../../assets/fox-wallpaper.jpg';
import { useI18n } from '../../contexts/LocaleContext';
import './SetupWizard.css';

const SETUP_STEPS = Object.freeze([
  { id: 'welcome', labelKey: 'auth.setupSteps.welcome', Icon: Sparkles },
  { id: 'account', labelKey: 'auth.setupSteps.account', Icon: LockKeyhole },
  { id: 'region', labelKey: 'auth.setupSteps.region', Icon: MapPin },
  { id: 'server', labelKey: 'auth.setupSteps.server', Icon: Radar }
]);

export const FoxSetupMark = ({ size = 54 }) => (
  <svg
    aria-hidden="true"
    className="foxos-setup-mark"
    height={size}
    viewBox="0 0 100 100"
    width={size}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="m80 16.667s-1.501 0-3.333 0c-1.833 0-4.58 1.871-6.107 4.16l-8.336 12.506h-24.444l-8.34-12.506c-1.523-2.289-4.274-4.16-6.107-4.16-1.832 0-3.333 0-3.333 0l-10 49.596c12.666 0 25.335 4.994 35 15 2.761 2.761 7.239 2.761 10 0 8.991-9.189 21.364-14.922 35-15zm-38.333 40.937v-.004c-5.209 2.031-11.172-.299-13.33-5.198h-.004v-.007s.004.004.004.007c5.205-2.031 11.168.293 13.33 5.198zm12.75 10.814-2.998 2.998c-.781.781-2.044.781-2.825 0l-3.005-2.998c-.361-.368-.586-.862-.586-1.416 0-1.104.896-2.002 2.002-2.002h6.003c1.106 0 1.995.898 1.995 2.002 0 .554-.221 1.048-.586 1.416zm17.25-16.016h-.004c-2.158 4.899-8.118 7.229-13.33 5.198v.004-.004c2.162-4.905 8.125-7.229 13.33-5.198 0-.003.004-.003.004-.003z" />
  </svg>
);

const SetupShell = ({ children, currentStep, description, eyebrow, footer, title, wide = false }) => {
  const { t } = useI18n();
  const boundedStep = Math.min(Math.max(Number(currentStep) || 1, 1), SETUP_STEPS.length);

  return (
    <div
      className="auth-screen foxos-setup-screen"
      style={{ backgroundImage: `url(${foxWallpaper})` }}
    >
      <div className="foxos-setup-backdrop" />
      <div className={`foxos-setup-shell${wide ? ' is-wide' : ''}`}>
        <aside className="foxos-setup-sidebar">
          <div className="foxos-setup-brand">
            <span className="foxos-setup-brand-mark"><FoxSetupMark /></span>
            <div><strong>FoxOS</strong><span>{t('auth.setupAssistant')}</span></div>
          </div>

          <ol className="foxos-setup-progress" aria-label={t('auth.setupProgress')}>
            {SETUP_STEPS.map(({ id, labelKey, Icon }, index) => {
              const stepNumber = index + 1;
              const complete = stepNumber < boundedStep;
              const active = stepNumber === boundedStep;
              return (
                <li
                  className={`${complete ? 'is-complete' : ''}${active ? ' is-active' : ''}`}
                  key={id}
                  aria-current={active ? 'step' : undefined}
                >
                  <span>{complete ? <Check size={15} /> : <Icon size={15} />}</span>
                  <div><small>{t('auth.stepNumber', { number: stepNumber })}</small><strong>{t(labelKey)}</strong></div>
                </li>
              );
            })}
          </ol>

          <div className="foxos-setup-local-note">
            <ShieldCheck size={16} />
            <span><strong>{t('auth.localSetupTitle')}</strong>{t('auth.localSetupDescription')}</span>
          </div>
        </aside>

        <section className="foxos-setup-stage">
          <header className="foxos-setup-stage-header">
            <div>
              <span className="foxos-setup-eyebrow">{eyebrow}</span>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
            <span className="foxos-setup-step-count">
              {t('auth.stepCount', { current: boundedStep, total: SETUP_STEPS.length })}
            </span>
          </header>
          <main className="foxos-setup-stage-content" data-settings-content>{children}</main>
          {footer && <footer className="foxos-setup-stage-footer">{footer}</footer>}
        </section>
      </div>
    </div>
  );
};

export default SetupShell;
