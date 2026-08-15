import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  Fingerprint,
  KeyRound,
  Laptop,
  Loader2,
  LockKeyhole,
  LogOut,
  MonitorSmartphone,
  MoreHorizontal,
  RefreshCw,
  Shield,
  ShieldCheck,
  Smartphone,
  Tablet,
  Trash2,
  UserRoundCheck,
  X
} from 'lucide-react';
import { apiFetch } from '../api';
import { useI18n } from '../contexts/LocaleContext';
import './SecuritySettings.css';

const EVENT_KEYS = {
  'owner-created': 'ownerCreated',
  'login-succeeded': 'loginSucceeded',
  'login-failed': 'loginFailed',
  logout: 'logout',
  'password-changed': 'passwordChanged',
  'password-recovered': 'passwordRecovered',
  'password-upgraded': 'passwordUpgraded',
  'passkey-added': 'passkeyAdded',
  'passkey-used': 'passkeyUsed',
  'passkey-renamed': 'passkeyRenamed',
  'passkey-removed': 'passkeyRemoved',
  'recovery-codes-created': 'recoveryCodesCreated',
  'session-revoked': 'sessionRevoked',
  'sessions-revoked': 'sessionsRevoked'
};

const ERROR_KEYS = {
  'current-password-invalid': 'currentPassword',
  'password-too-short': 'passwordPolicy',
  'password-too-long': 'passwordPolicy',
  'password-common': 'passwordPolicy',
  'password-too-common': 'passwordPolicy',
  'password-contains-username': 'passwordPolicy',
  'password-contextual': 'passwordPolicy',
  'passkey-name-required': 'passkeyName',
  'passkey-https-required': 'passkeyHttps',
  'passkey-origin-untrusted': 'passkeyHttps',
  'passkey-origin-unavailable': 'passkeyHttps',
  'recovery-not-configured': 'recoveryUnavailable',
  'session-not-found': 'sessionNotFound',
  'security-password-rate-limited': 'rateLimited'
};

const errorText = (error, t) => {
  const key = ERROR_KEYS[error && error.code];
  if (key) return t(`security.errors.${key}`);
  if (error && ['AbortError', 'NotAllowedError'].includes(error.name)) {
    return t('security.errors.passkeyCancelled');
  }
  return t('security.errors.generic');
};

const Feedback = ({ value, onClose }) => value ? (
  <div className={`security-feedback is-${value.type}`} role="status">
    {value.type === 'error' ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}
    <span>{value.text}</span>
    <button type="button" aria-label={value.closeLabel} onClick={onClose}><X size={13} /></button>
  </div>
) : null;

const SectionHeading = ({ kicker, title, description, action }) => (
  <header className="security-section-heading">
    <div>
      {kicker && <span className="security-section-kicker">{kicker}</span>}
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
    {action}
  </header>
);

const SecuritySettings = () => {
  const { formatDate, formatTime, t } = useI18n();
  const [activeView, setActiveView] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [showPasskeyForm, setShowPasskeyForm] = useState(false);
  const [passkeyDraft, setPasskeyDraft] = useState({
    name: '',
    preferredAuthenticatorType: 'localDevice',
    currentPassword: ''
  });
  const [managedPasskeyId, setManagedPasskeyId] = useState(null);
  const [managedPasskey, setManagedPasskey] = useState({ name: '', currentPassword: '' });
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState({ currentPassword: '', newPassword: '', confirmation: '' });
  const [showRecoveryForm, setShowRecoveryForm] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);

  const dateTime = useCallback((value) => {
    if (!value) return t('security.common.unknown');
    return `${formatDate(value, { dateStyle: 'medium' })} · ${formatTime(value)}`;
  }, [formatDate, formatTime, t]);

  const loadOverview = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await apiFetch('/api/security/overview');
      const payload = await response.json();
      setOverview(payload);
      setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
      setEvents(Array.isArray(payload.events) ? payload.events : []);
      return payload;
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [t]);

  const loadSessions = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setBusy('sessions-load');
    try {
      const response = await apiFetch('/api/security/sessions');
      const payload = await response.json();
      setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      if (!quiet) setBusy('');
    }
  }, [t]);

  const loadEvents = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setBusy('events-load');
    try {
      const response = await apiFetch('/api/security/events?limit=100');
      const payload = await response.json();
      setEvents(Array.isArray(payload.events) ? payload.events : []);
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      if (!quiet) setBusy('');
    }
  }, [t]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (activeView === 'sessions') loadSessions({ quiet: true });
    if (activeView === 'activity') loadEvents({ quiet: true });
  }, [activeView, loadEvents, loadSessions]);

  const security = overview && overview.security;
  const posture = overview && overview.posture;
  const minimumPasswordLength = overview && overview.passwordPolicy
    ? overview.passwordPolicy.minimumLength
    : 15;
  const passkeys = security && Array.isArray(security.passkeys) ? security.passkeys : [];
  const readyCount = posture
    ? [posture.passkeyReady, posture.recoveryReady, posture.secureTransport].filter(Boolean).length
    : 0;
  const currentSession = useMemo(() => sessions.find((session) => session.current) || sessions[0] || null, [sessions]);
  const navigation = [
    { id: 'overview', icon: ShieldCheck, title: t('security.nav.overview'), description: t('security.nav.overviewDescription') },
    { id: 'sign-in', icon: KeyRound, title: t('security.nav.signIn'), description: t('security.nav.signInDescription') },
    { id: 'sessions', icon: MonitorSmartphone, title: t('security.nav.sessions'), description: t('security.nav.sessionsDescription') },
    { id: 'activity', icon: Activity, title: t('security.nav.activity'), description: t('security.nav.activityDescription') }
  ];

  const clientName = (client) => {
    const browser = client && client.browser && !client.browser.startsWith('Unknown') ? client.browser : null;
    const osName = client && client.os && !client.os.startsWith('Unknown') ? client.os : null;
    return [browser, osName].filter(Boolean).join(' · ') || t('security.activity.unknownClient');
  };

  const networkName = (client) => client && client.network === 'local'
    ? t('security.activity.localNetwork')
    : client && client.network || t('security.common.unknown');

  const sessionMethod = (method) => t(`security.sessions.methods.${method || 'password'}`);
  const deviceLabel = (device) => t(`security.sessions.devices.${['mobile', 'tablet'].includes(device) ? device : 'desktop'}`);
  const DeviceIcon = ({ device, size = 18 }) => device === 'mobile'
    ? <Smartphone size={size} />
    : device === 'tablet' ? <Tablet size={size} /> : <Laptop size={size} />;

  const refreshAll = async () => {
    setBusy('refresh');
    await Promise.all([loadOverview({ quiet: true }), loadSessions({ quiet: true }), loadEvents({ quiet: true })]);
    setBusy('');
  };

  const addPasskey = async (event) => {
    event.preventDefault();
    if (!passkeyDraft.name.trim()) {
      setFeedback({ type: 'error', text: t('security.errors.passkeyName'), closeLabel: t('common.close') });
      return;
    }
    if (typeof window.PublicKeyCredential === 'undefined') {
      setFeedback({ type: 'error', text: t('security.errors.passkeyUnsupported'), closeLabel: t('common.close') });
      return;
    }
    setBusy('passkey-add');
    setFeedback(null);
    try {
      const optionsResponse = await apiFetch('/api/security/passkeys/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(passkeyDraft)
      });
      const optionsPayload = await optionsResponse.json();
      const credential = await startRegistration({ optionsJSON: optionsPayload.options });
      await apiFetch('/api/security/passkeys/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ceremonyId: optionsPayload.ceremonyId, response: credential })
      });
      setPasskeyDraft({ name: '', preferredAuthenticatorType: 'localDevice', currentPassword: '' });
      setShowPasskeyForm(false);
      setFeedback({ type: 'success', text: t('security.passkeys.added'), closeLabel: t('common.close') });
      await loadOverview({ quiet: true });
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      setBusy('');
    }
  };

  const openPasskeyManager = (passkey) => {
    if (managedPasskeyId === passkey.id) {
      setManagedPasskeyId(null);
      return;
    }
    setManagedPasskeyId(passkey.id);
    setManagedPasskey({ name: passkey.name, currentPassword: '' });
  };

  const updatePasskey = async (event, passkeyId) => {
    event.preventDefault();
    setBusy(`passkey-update-${passkeyId}`);
    setFeedback(null);
    try {
      await apiFetch(`/api/security/passkeys/${encodeURIComponent(passkeyId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(managedPasskey)
      });
      setManagedPasskeyId(null);
      setFeedback({ type: 'success', text: t('security.passkeys.renamed'), closeLabel: t('common.close') });
      await loadOverview({ quiet: true });
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      setBusy('');
    }
  };

  const removePasskey = async (passkeyId) => {
    setBusy(`passkey-remove-${passkeyId}`);
    setFeedback(null);
    try {
      await apiFetch(`/api/security/passkeys/${encodeURIComponent(passkeyId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: managedPasskey.currentPassword })
      });
      setManagedPasskeyId(null);
      setFeedback({ type: 'success', text: t('security.passkeys.removed'), closeLabel: t('common.close') });
      await loadOverview({ quiet: true });
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      setBusy('');
    }
  };

  const rotateRecoveryCodes = async (event) => {
    event.preventDefault();
    setBusy('recovery');
    setFeedback(null);
    try {
      const response = await apiFetch('/api/security/recovery-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: recoveryPassword })
      });
      const payload = await response.json();
      setRecoveryCodes(Array.isArray(payload.codes) ? payload.codes : []);
      setRecoveryPassword('');
      setShowRecoveryForm(false);
      setFeedback({ type: 'success', text: t('security.recovery.created'), closeLabel: t('common.close') });
      await loadOverview({ quiet: true });
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      setBusy('');
    }
  };

  const recoveryText = () => [
    t('security.recovery.fileTitle'),
    t('security.recovery.fileNote'),
    '',
    ...recoveryCodes
  ].join('\n');

  const copyRecoveryCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryText());
      setFeedback({ type: 'success', text: t('security.common.copied'), closeLabel: t('common.close') });
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    }
  };

  const downloadRecoveryCodes = () => {
    const blob = new Blob([recoveryText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'foxos-recovery-codes.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const changePassword = async (event) => {
    event.preventDefault();
    if (passwordDraft.newPassword.length < minimumPasswordLength) {
      setFeedback({
        type: 'error',
        text: t('security.errors.passwordLength', { count: minimumPasswordLength }),
        closeLabel: t('common.close')
      });
      return;
    }
    if (passwordDraft.newPassword !== passwordDraft.confirmation) {
      setFeedback({ type: 'error', text: t('security.errors.passwordMismatch'), closeLabel: t('common.close') });
      return;
    }
    setBusy('password');
    setFeedback(null);
    try {
      await apiFetch('/api/security/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: passwordDraft.currentPassword,
          newPassword: passwordDraft.newPassword
        })
      });
      setPasswordDraft({ currentPassword: '', newPassword: '', confirmation: '' });
      setShowPasswordForm(false);
      setFeedback({ type: 'success', text: t('security.password.changed'), closeLabel: t('common.close') });
      await refreshAll();
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      setBusy('');
    }
  };

  const revokeSession = async (sessionId) => {
    setBusy(`session-${sessionId}`);
    setFeedback(null);
    try {
      await apiFetch(`/api/security/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      setFeedback({ type: 'success', text: t('security.sessions.revoked'), closeLabel: t('common.close') });
      await Promise.all([loadSessions({ quiet: true }), loadOverview({ quiet: true }), loadEvents({ quiet: true })]);
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      setBusy('');
    }
  };

  const revokeOtherSessions = async () => {
    setBusy('sessions-revoke-others');
    setFeedback(null);
    try {
      const response = await apiFetch('/api/security/sessions/revoke-others', { method: 'POST' });
      const payload = await response.json();
      setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
      setFeedback({
        type: 'success',
        text: t('security.sessions.revokedOthers', { count: payload.revoked || 0 }),
        closeLabel: t('common.close')
      });
      await Promise.all([loadOverview({ quiet: true }), loadEvents({ quiet: true })]);
    } catch (error) {
      setFeedback({ type: 'error', text: errorText(error, t), closeLabel: t('common.close') });
    } finally {
      setBusy('');
    }
  };

  const renderSession = (session, compact = false) => (
    <article className={`security-session-row${session.current ? ' is-current' : ''}${compact ? ' is-compact' : ''}`} key={session.id}>
      <span className="security-session-icon" aria-hidden="true"><DeviceIcon device={session.client && session.client.device} /></span>
      <div className="security-session-copy">
        <div>
          <strong>{clientName(session.client)}</strong>
          {session.current && <em>{t('security.common.current')}</em>}
        </div>
        <p>{deviceLabel(session.client && session.client.device)} · {networkName(session.client)}</p>
        <small>{t('security.sessions.lastSeen', { date: dateTime(session.lastSeenAt) })}</small>
      </div>
      <span className="security-method-badge"><KeyRound size={10} /> {sessionMethod(session.authMethod)}</span>
      {!compact && (session.current
        ? <span className="security-current-help">{t('security.sessions.currentHelp')}</span>
        : (
          <button
            type="button"
            className="security-danger-button"
            onClick={() => revokeSession(session.id)}
            disabled={busy === `session-${session.id}`}
          >
            {busy === `session-${session.id}` ? <Loader2 className="is-spinning" size={13} /> : <LogOut size={13} />}
            {t('security.sessions.revoke')}
          </button>
        ))}
    </article>
  );

  const renderOverview = () => {
    const recommendation = !posture.passkeyReady
      ? t('security.overview.recommendationPasskey')
      : !posture.recoveryReady
        ? t('security.overview.recommendationRecovery')
        : t('security.overview.recommendationComplete');
    const readiness = [
      {
        id: 'passkey',
        icon: Fingerprint,
        ready: posture.passkeyReady,
        title: t('security.overview.passkeyTitle'),
        description: posture.passkeyReady
          ? t('security.overview.passkeyReady', { count: passkeys.length })
          : t('security.overview.passkeyMissing')
      },
      {
        id: 'recovery',
        icon: KeyRound,
        ready: posture.recoveryReady,
        title: t('security.overview.recoveryTitle'),
        description: security.recovery.needsRotation
          ? t('security.overview.recoveryRotate', { count: security.recovery.availableCodes })
          : security.recovery.configured
            ? t('security.overview.recoveryReady', { count: security.recovery.availableCodes })
            : t('security.overview.recoveryMissing')
      },
      {
        id: 'transport',
        icon: LockKeyhole,
        ready: posture.secureTransport,
        title: t('security.overview.transportTitle'),
        description: posture.secureTransport
          ? t('security.overview.transportReady')
          : t('security.overview.transportMissing')
      }
    ];

    return (
      <div className="security-view" data-security-view="overview">
        <section className="security-panel">
          <SectionHeading title={t('security.overview.title')} description={t('security.overview.description')} />
          <div className="security-readiness-grid">
            {readiness.map((item) => {
              const Icon = item.icon;
              return (
                <article className={`security-readiness-card is-${item.ready ? 'ready' : 'attention'}`} key={item.id}>
                  <span aria-hidden="true"><Icon size={19} /></span>
                  <div><strong>{item.title}</strong><p>{item.description}</p></div>
                  <em>{item.ready ? <Check size={11} /> : <AlertTriangle size={11} />}{item.ready ? t('security.common.ready') : t('security.common.attention')}</em>
                </article>
              );
            })}
          </div>
        </section>

        <section className={`security-recommendation${posture.attentionRequired ? ' is-attention' : ''}`}>
          <span aria-hidden="true">{posture.attentionRequired ? <Shield size={21} /> : <ShieldCheck size={21} />}</span>
          <div>
            <strong>{t('security.overview.recommendationTitle')}</strong>
            <p>{recommendation}</p>
          </div>
          <button type="button" onClick={() => setActiveView('sign-in')}>
            {t('security.overview.openSignIn')} <ChevronRight size={13} />
          </button>
        </section>

        <section className="security-panel">
          <SectionHeading
            title={t('security.overview.currentSessionTitle')}
            description={t('security.overview.currentSessionDescription')}
            action={<button type="button" className="security-text-button" onClick={() => setActiveView('sessions')}>{t('security.overview.allSessions')} <ChevronRight size={12} /></button>}
          />
          {currentSession && renderSession(currentSession, true)}
        </section>
      </div>
    );
  };

  const renderSignIn = () => (
    <div className="security-view" data-security-view="sign-in">
      <section className="security-panel">
        <SectionHeading
          kicker={t('security.signIn.title')}
          title={t('security.passkeys.title')}
          description={t('security.passkeys.description')}
          action={(
            <button type="button" className="security-primary-button" onClick={() => setShowPasskeyForm((value) => !value)}>
              {showPasskeyForm ? <X size={13} /> : <Fingerprint size={14} />}
              {showPasskeyForm ? t('security.passkeys.cancel') : t('security.passkeys.add')}
            </button>
          )}
        />

        {showPasskeyForm && (
          <form className="security-action-form" onSubmit={addPasskey}>
            <div className="security-form-intro"><Fingerprint size={18} /><span><strong>{t('security.passkeys.add')}</strong><small>{t('security.passkeys.verifyDescription')}</small></span></div>
            <label>
              <span>{t('security.passkeys.name')}</span>
              <input value={passkeyDraft.name} maxLength={64} placeholder={t('security.passkeys.namePlaceholder')} onChange={(event) => setPasskeyDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <fieldset>
              <legend>{t('security.passkeys.type')}</legend>
              <div className="security-authenticator-grid">
                {[
                  ['localDevice', Smartphone, 'localDevice', 'localDeviceDescription'],
                  ['securityKey', KeyRound, 'securityKey', 'securityKeyDescription'],
                  ['remoteDevice', MonitorSmartphone, 'remoteDevice', 'remoteDeviceDescription']
                ].map(([id, Icon, titleKey, descriptionKey]) => (
                  <label className={passkeyDraft.preferredAuthenticatorType === id ? 'is-selected' : ''} key={id}>
                    <input type="radio" name="authenticator-type" value={id} checked={passkeyDraft.preferredAuthenticatorType === id} onChange={(event) => setPasskeyDraft((current) => ({ ...current, preferredAuthenticatorType: event.target.value }))} />
                    <Icon size={16} /><span><strong>{t(`security.passkeys.${titleKey}`)}</strong><small>{t(`security.passkeys.${descriptionKey}`)}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="security-form-footer">
              <label><span>{t('security.common.confirmPassword')}</span><input type="password" autoComplete="current-password" value={passkeyDraft.currentPassword} onChange={(event) => setPasskeyDraft((current) => ({ ...current, currentPassword: event.target.value }))} /></label>
              <button type="submit" className="security-primary-button" disabled={busy === 'passkey-add' || !passkeyDraft.currentPassword}>
                {busy === 'passkey-add' ? <Loader2 className="is-spinning" size={14} /> : <Fingerprint size={14} />}
                {busy === 'passkey-add' ? t('security.common.working') : t('security.passkeys.start')}
              </button>
            </div>
          </form>
        )}

        <div className="security-passkey-list">
          {!passkeys.length && !showPasskeyForm && (
            <div className="security-empty-state"><Fingerprint size={23} /><div><strong>{t('security.passkeys.emptyTitle')}</strong><p>{t('security.passkeys.emptyDescription')}</p></div></div>
          )}
          {passkeys.map((passkey) => (
            <article className="security-passkey-row" key={passkey.id}>
              <div className="security-passkey-main">
                <span aria-hidden="true"><Fingerprint size={18} /></span>
                <div>
                  <strong>{passkey.name || t('security.passkeys.unknownDevice')}</strong>
                  <p>{t('security.passkeys.created', { date: dateTime(passkey.createdAt) })} · {passkey.lastUsedAt ? t('security.passkeys.lastUsed', { date: dateTime(passkey.lastUsedAt) }) : t('security.common.never')}</p>
                </div>
                <em>{passkey.backedUp ? t('security.passkeys.backedUp') : t('security.passkeys.deviceBound')}</em>
                <button type="button" className="security-icon-button" aria-label={t('security.passkeys.manage')} onClick={() => openPasskeyManager(passkey)}><MoreHorizontal size={16} /></button>
              </div>
              {managedPasskeyId === passkey.id && (
                <form className="security-passkey-manager" onSubmit={(event) => updatePasskey(event, passkey.id)}>
                  <label><span>{t('security.passkeys.name')}</span><input value={managedPasskey.name} maxLength={64} onChange={(event) => setManagedPasskey((current) => ({ ...current, name: event.target.value }))} /></label>
                  <label><span>{t('security.common.confirmPassword')}</span><input type="password" autoComplete="current-password" value={managedPasskey.currentPassword} onChange={(event) => setManagedPasskey((current) => ({ ...current, currentPassword: event.target.value }))} /></label>
                  <div>
                    <button type="submit" className="security-secondary-button" disabled={!managedPasskey.currentPassword || busy.startsWith('passkey-')}><Check size={13} /> {t('security.passkeys.rename')}</button>
                    <button type="button" className="security-danger-button" disabled={!managedPasskey.currentPassword || busy.startsWith('passkey-')} onClick={() => removePasskey(passkey.id)}><Trash2 size={13} /> {t('security.passkeys.remove')}</button>
                  </div>
                  <p><AlertTriangle size={12} /> {t('security.passkeys.removeWarning')}</p>
                </form>
              )}
            </article>
          ))}
        </div>
      </section>

      <div className="security-signin-grid">
        <section className="security-panel security-method-card">
          <SectionHeading title={t('security.password.title')} description={t('security.password.description')} />
          <div className="security-method-status">
            <span className="is-ready"><LockKeyhole size={16} /></span>
            <div><strong>{security.password.modern ? t('security.password.modern') : t('security.password.legacy')}</strong><small>{t('security.password.updated', { date: dateTime(security.password.updatedAt) })}</small></div>
          </div>
          <button type="button" className="security-secondary-button is-full" onClick={() => setShowPasswordForm((value) => !value)}>{showPasswordForm ? <X size={13} /> : <KeyRound size={13} />}{showPasswordForm ? t('common.cancel') : t('security.password.change')}</button>
          {showPasswordForm && (
            <form className="security-stack-form" onSubmit={changePassword}>
              <label><span>{t('security.password.current')}</span><input type="password" autoComplete="current-password" value={passwordDraft.currentPassword} onChange={(event) => setPasswordDraft((current) => ({ ...current, currentPassword: event.target.value }))} /></label>
              <label><span>{t('security.password.new')}</span><input type="password" autoComplete="new-password" value={passwordDraft.newPassword} onChange={(event) => setPasswordDraft((current) => ({ ...current, newPassword: event.target.value }))} /></label>
              <label><span>{t('security.password.confirm')}</span><input type="password" autoComplete="new-password" value={passwordDraft.confirmation} onChange={(event) => setPasswordDraft((current) => ({ ...current, confirmation: event.target.value }))} /></label>
              <small>{t('security.password.rule', { count: minimumPasswordLength })}</small>
              <p><AlertTriangle size={12} /> {t('security.password.sessionWarning')}</p>
              <button type="submit" className="security-primary-button" disabled={busy === 'password'}>{busy === 'password' ? <Loader2 className="is-spinning" size={14} /> : <LockKeyhole size={14} />}{busy === 'password' ? t('security.common.working') : t('security.password.save')}</button>
            </form>
          )}
        </section>

        <section className="security-panel security-method-card">
          <SectionHeading title={t('security.recovery.title')} description={t('security.recovery.description')} />
          <div className="security-method-status">
            <span className={security.recovery.configured && !security.recovery.needsRotation ? 'is-ready' : 'is-attention'}><KeyRound size={16} /></span>
            <div>
              <strong>{security.recovery.configured ? t('security.recovery.available', { count: security.recovery.availableCodes }) : t('security.common.notConfigured')}</strong>
              <small>{security.recovery.needsRotation ? t('security.recovery.rotationNeeded') : security.recovery.generatedAt ? dateTime(security.recovery.generatedAt) : t('security.overview.recoveryMissing')}</small>
            </div>
          </div>
          <button type="button" className="security-secondary-button is-full" onClick={() => setShowRecoveryForm((value) => !value)}>{showRecoveryForm ? <X size={13} /> : <KeyRound size={13} />}{showRecoveryForm ? t('common.cancel') : security.recovery.configured ? t('security.recovery.regenerate') : t('security.recovery.generate')}</button>
          {showRecoveryForm && (
            <form className="security-stack-form" onSubmit={rotateRecoveryCodes}>
              <p className="is-warning"><AlertTriangle size={12} /> {t('security.recovery.warning')}</p>
              <label><span>{t('security.common.confirmPassword')}</span><input type="password" autoComplete="current-password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} /></label>
              <small>{t('security.recovery.verifyDescription')}</small>
              <button type="submit" className="security-primary-button" disabled={busy === 'recovery' || !recoveryPassword}>{busy === 'recovery' ? <Loader2 className="is-spinning" size={14} /> : <KeyRound size={14} />}{busy === 'recovery' ? t('security.common.working') : security.recovery.configured ? t('security.recovery.regenerate') : t('security.recovery.generate')}</button>
            </form>
          )}
        </section>
      </div>

      {recoveryCodes.length > 0 && (
        <section className="security-recovery-vault">
          <div className="security-vault-heading"><span><ShieldCheck size={20} /></span><div><strong>{t('security.recovery.oneTimeTitle')}</strong><p>{t('security.recovery.oneTimeDescription')}</p></div></div>
          <div className="security-code-grid">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div>
          <p className="security-storage-advice"><LockKeyhole size={13} /> {t('security.recovery.storageAdvice')}</p>
          <div className="security-vault-actions">
            <button type="button" className="security-primary-button" onClick={copyRecoveryCodes}><Copy size={13} /> {t('security.common.copy')}</button>
            <button type="button" className="security-secondary-button" onClick={downloadRecoveryCodes}><Download size={13} /> {t('security.common.download')}</button>
            <button type="button" className="security-text-button" onClick={() => setRecoveryCodes([])}>{t('security.common.close')}</button>
          </div>
        </section>
      )}
    </div>
  );

  const renderSessions = () => (
    <div className="security-view" data-security-view="sessions">
      <section className="security-panel">
        <SectionHeading
          title={t('security.sessions.title')}
          description={t('security.sessions.description')}
          action={sessions.length > 1 ? (
            <button type="button" className="security-danger-button" onClick={revokeOtherSessions} disabled={busy === 'sessions-revoke-others'}>
              {busy === 'sessions-revoke-others' ? <Loader2 className="is-spinning" size={13} /> : <LogOut size={13} />}
              {t('security.sessions.revokeOthers')}
            </button>
          ) : null}
        />
        <div className="security-session-summary"><MonitorSmartphone size={15} /><span>{t('security.sessions.count', { count: sessions.length })}</span><button type="button" aria-label={t('common.refresh')} onClick={() => loadSessions()} disabled={busy === 'sessions-load'}><RefreshCw className={busy === 'sessions-load' ? 'is-spinning' : ''} size={13} /></button></div>
        <div className="security-session-list">
          {sessions.length ? sessions.map((session) => renderSession(session)) : <div className="security-empty-state"><MonitorSmartphone size={23} /><div><strong>{t('security.sessions.empty')}</strong></div></div>}
        </div>
      </section>
    </div>
  );

  const renderActivity = () => (
    <div className="security-view" data-security-view="activity">
      <section className="security-panel">
        <SectionHeading
          title={t('security.activity.title')}
          description={t('security.activity.description')}
          action={<button type="button" className="security-secondary-button" onClick={() => loadEvents()} disabled={busy === 'events-load'}><RefreshCw className={busy === 'events-load' ? 'is-spinning' : ''} size={13} /> {t('security.activity.refresh')}</button>}
        />
        <div className="security-event-list">
          {!events.length && <div className="security-empty-state"><Activity size={23} /><div><strong>{t('security.activity.empty')}</strong></div></div>}
          {events.map((event) => {
            const eventKey = EVENT_KEYS[event.type] || 'unknown';
            return (
              <article className={`security-event-row is-${event.success ? 'success' : 'failed'}`} key={event.id}>
                <span aria-hidden="true">{event.success ? <UserRoundCheck size={17} /> : <CircleAlert size={17} />}</span>
                <div>
                  <strong>{t(`security.events.${eventKey}`)}</strong>
                  <p>{t('security.activity.from', { client: clientName(event.client), network: networkName(event.client) })}</p>
                  {event.detail && <small>{event.detail}</small>}
                </div>
                {event.method && <em>{sessionMethod(event.method)}</em>}
                <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );

  if (loading && !overview) {
    return <div className="security-loading"><Loader2 className="is-spinning" size={18} /> {t('security.loading')}</div>;
  }

  if (!overview || !security || !posture) {
    return (
      <div className="security-loading is-error">
        <CircleAlert size={18} /> {t('security.loadError')}
        <button type="button" onClick={() => loadOverview()}>{t('common.retry')}</button>
      </div>
    );
  }

  return (
    <div className="security-settings">
      <section className={`security-hero${posture.attentionRequired ? ' is-attention' : ''}`}>
        <div className="security-hero-copy">
          <span className="security-hero-mark"><ShieldCheck size={28} /></span>
          <div>
            <span className="security-kicker">{t('security.kicker')}</span>
            <h3>{t('security.heroTitle')}</h3>
            <p>{t('security.heroDescription')}</p>
          </div>
        </div>
        <div className="security-posture">
          <strong>{readyCount}<small>/3</small></strong>
          <span>{posture.attentionRequired ? t('security.postureNeedsAttention') : t('security.postureStrong')}</span>
          <em>{t('security.postureSummary', { ready: readyCount, total: 3 })}</em>
          <button type="button" aria-label={t('security.refresh')} onClick={refreshAll} disabled={busy === 'refresh'}><RefreshCw className={busy === 'refresh' ? 'is-spinning' : ''} size={12} /> {t('common.refresh')}</button>
        </div>
      </section>

      <Feedback value={feedback} onClose={() => setFeedback(null)} />

      <nav className="security-navigation" aria-label={t('security.kicker')}>
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <button type="button" key={item.id} className={activeView === item.id ? 'is-active' : ''} aria-current={activeView === item.id ? 'page' : undefined} onClick={() => setActiveView(item.id)}>
              <span aria-hidden="true"><Icon size={16} /></span>
              <div><strong>{item.title}</strong><small>{item.description}</small></div>
            </button>
          );
        })}
      </nav>

      {activeView === 'overview' && renderOverview()}
      {activeView === 'sign-in' && renderSignIn()}
      {activeView === 'sessions' && renderSessions()}
      {activeView === 'activity' && renderActivity()}
    </div>
  );
};

export default SecuritySettings;
