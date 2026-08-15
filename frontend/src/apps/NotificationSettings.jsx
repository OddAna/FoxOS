import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  BellRing,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  KeyRound,
  Link2,
  ListChecks,
  MessageCircle,
  MonitorSmartphone,
  PauseCircle,
  PlayCircle,
  Radio,
  RefreshCw,
  Send,
  ServerCog,
  ShieldCheck,
  Smartphone,
  Trash2,
  X
} from 'lucide-react';
import { apiFetch } from '../api';
import { useI18n } from '../contexts/LocaleContext';
import {
  browserPushCapability,
  currentBrowserPushState,
  disableBrowserPush,
  enableBrowserPush
} from '../utils/webPush';

const SEVERITIES = [
  { id: 'info', labelKey: 'notifications.severity.info' },
  { id: 'success', labelKey: 'notifications.severity.success' },
  { id: 'warning', labelKey: 'notifications.severity.warning' },
  { id: 'critical', labelKey: 'notifications.severity.critical' }
];

const EMPTY_SETTINGS = {
  minimumSeverity: 'info',
  browserPush: { enabled: false },
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '08:00',
    timezone: 'UTC',
    criticalOverride: true
  },
  sourceRules: {}
};

const EMPTY_TELEGRAM = {
  configured: false,
  paired: false,
  enabled: false,
  polling: false,
  bot: null,
  owner: null,
  pairing: null,
  pausedUntil: null,
  lastErrorCode: null,
  tokenStoredEncrypted: false,
  tokenIncluded: false
};

const EMPTY_CODEX_REVIEW = {
  enabled: false,
  running: false,
  intervalMinutes: 120,
  decisionAuthority: 'codex',
  fallback: 'none',
  nextRunAt: null,
  lastRunAt: null,
  lastSuccessfulRunAt: null,
  lastResult: null,
  lastModel: null,
  lastReasoningEffort: null,
  codex: { ready: false, connected: false, fullServer: false },
  sources: []
};

const TELEGRAM_DISCONNECT_CONFIRMATION = 'TELEGRAM BAĞLANTISINI KALDIR';

function sourceName(source, t, locale) {
  const names = {
    foxos: 'FoxOS',
    system: t('notifications.sources.system'),
    calendar: t('notifications.sources.calendar'),
    weather: t('notifications.sources.weather'),
    backups: t('notifications.sources.backups'),
    mail: t('notifications.sources.mail'),
    codex: 'Codex'
  };
  return names[source] || source.replaceAll('-', ' ').replace(/(^|\s)\S/g, (value) => value.toLocaleUpperCase(locale));
}

function statusLabel(status, t) {
  if (status === 'delivered') return t('notifications.delivery.delivered');
  if (status === 'failed') return t('notifications.delivery.failed');
  if (status === 'skipped') return t('notifications.delivery.skipped');
  if (status === 'pending') return t('notifications.delivery.pending');
  return status;
}

function deliveryChannelLabel(channel) {
  if (channel === 'in-app') return 'FoxOS';
  if (channel === 'web-push') return 'Web Push';
  if (channel === 'telegram') return 'Telegram';
  return channel;
}

function telegramErrorLabel(code, t) {
  const labels = {
    'telegram-bot-blocked': t('notifications.errors.botBlocked'),
    'telegram-polling-conflict': t('notifications.errors.pollingConflict'),
    'telegram-rate-limited': t('notifications.errors.rateLimited'),
    'telegram-token-rejected': t('notifications.errors.tokenRejected'),
    'notification-telegram-timeout': t('notifications.errors.timeout'),
    'notification-telegram-unavailable': t('notifications.errors.unavailable')
  };
  return labels[code] || (code ? t('notifications.errors.genericTelegram') : '');
}

const NotificationSettings = () => {
  const { formatDate, formatNumber, formatTime, locale, t, timeZone } = useI18n();
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [sources, setSources] = useState([]);
  const [push, setPush] = useState({ enabled: false, deviceCount: 0, devices: [] });
  const [telegram, setTelegram] = useState(EMPTY_TELEGRAM);
  const [codexReview, setCodexReview] = useState(EMPTY_CODEX_REVIEW);
  const [telegramReviewChats, setTelegramReviewChats] = useState([]);
  const [telegramReviewDraft, setTelegramReviewDraft] = useState([]);
  const [telegramReviewQuery, setTelegramReviewQuery] = useState('');
  const [telegramReviewScopeOpen, setTelegramReviewScopeOpen] = useState(false);
  const [telegramReviewLoading, setTelegramReviewLoading] = useState(false);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramPanelOpen, setTelegramPanelOpen] = useState(false);
  const [browserState, setBrowserState] = useState(() => ({
    ...browserPushCapability(),
    subscribed: false,
    permission: typeof Notification === 'undefined' ? 'default' : Notification.permission
  }));
  const [notifications, setNotifications] = useState([]);
  const [stats, setStats] = useState({ unread: 0, criticalUnread: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const telegramReviewSource = useMemo(
    () => (codexReview.sources || []).find((source) => source.id === 'telegram') || null,
    [codexReview.sources]
  );
  const visibleTelegramReviewChats = useMemo(() => {
    const query = telegramReviewQuery.trim().toLocaleLowerCase(locale);
    if (!query) return telegramReviewChats;
    return telegramReviewChats.filter((chat) => (
      chat.title.toLocaleLowerCase(locale).includes(query) || chat.kind.includes(query)
    ));
  }, [locale, telegramReviewChats, telegramReviewQuery]);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const [settingsResponse, notificationsResponse, currentPushState] = await Promise.all([
        apiFetch('/api/notifications/settings'),
        apiFetch('/api/notifications?limit=20'),
        currentBrowserPushState().catch(() => ({
          ...browserPushCapability(), subscribed: false, permission: 'default'
        }))
      ]);
      const settingsPayload = await settingsResponse.json();
      const notificationPayload = await notificationsResponse.json();
      setSettings(settingsPayload.settings || EMPTY_SETTINGS);
      setSources(Array.isArray(settingsPayload.sources) ? settingsPayload.sources : []);
      setPush(settingsPayload.push || { enabled: false, deviceCount: 0, devices: [] });
      setTelegram(settingsPayload.telegram || EMPTY_TELEGRAM);
      setCodexReview(settingsPayload.codexReview || EMPTY_CODEX_REVIEW);
      setNotifications(Array.isArray(notificationPayload.items) ? notificationPayload.items : []);
      setStats(notificationPayload.stats || { unread: 0, criticalUnread: 0 });
      setBrowserState(currentPushState);
      setError('');
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.load'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!telegram.configured || telegram.paired || !telegram.pairing) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await apiFetch('/api/notifications/telegram');
        const next = await response.json();
        if (next.paired) setMessage(t('notifications.feedback.telegramPaired'));
        setTelegram(next);
      } catch {
        // The normal screen feedback remains authoritative; pairing can be retried.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [t, telegram.configured, telegram.paired, telegram.pairing]);

  useEffect(() => {
    if (!codexReview.enabled) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const response = await apiFetch('/api/tasks/codex-review');
        const payload = await response.json();
        setCodexReview(payload.codexReview || EMPTY_CODEX_REVIEW);
      } catch {
        // The regular settings feedback remains authoritative.
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [codexReview.enabled]);

  const saveSettings = async () => {
    setBusy('settings');
    setMessage('');
    setError('');
    try {
      const response = await apiFetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settings,
          quietHours: { ...settings.quietHours, timezone: timeZone }
        })
      });
      const payload = await response.json();
      setSettings(payload.settings);
      setSources(payload.sources || []);
      setPush(payload.push);
      setMessage(t('notifications.feedback.saved'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.save'));
    } finally {
      setBusy('');
    }
  };

  const connectThisBrowser = async () => {
    setBusy('push');
    setMessage('');
    setError('');
    try {
      await enableBrowserPush(t);
      await load({ quiet: true });
      setMessage(t('notifications.feedback.deviceConnected'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.connectDevice'));
    } finally {
      setBusy('');
    }
  };

  const disconnectThisBrowser = async () => {
    setBusy('push');
    setMessage('');
    setError('');
    try {
      await disableBrowserPush(t);
      await load({ quiet: true });
      setMessage(t('notifications.feedback.deviceDisconnected'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.disconnectDevice'));
    } finally {
      setBusy('');
    }
  };

  const configureTelegram = async () => {
    if (!telegramToken.trim()) {
      setError(t('notifications.errors.botTokenRequired'));
      return;
    }
    setBusy('telegram-configure');
    setMessage('');
    setError('');
    try {
      const configureResponse = await apiFetch('/api/notifications/telegram/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: telegramToken.trim() })
      });
      const configuredPayload = await configureResponse.json();
      setTelegram(configuredPayload.telegram || EMPTY_TELEGRAM);
      setTelegramToken('');
      const pairingResponse = await apiFetch('/api/notifications/telegram/pair', { method: 'POST' });
      const pairingPayload = await pairingResponse.json();
      setTelegram(pairingPayload.telegram || configuredPayload.telegram || EMPTY_TELEGRAM);
      setMessage(t('notifications.feedback.botVerified'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.connectTelegram'));
    } finally {
      setBusy('');
    }
  };

  const startTelegramPairing = async () => {
    setBusy('telegram-pair');
    setMessage('');
    setError('');
    try {
      const response = await apiFetch('/api/notifications/telegram/pair', { method: 'POST' });
      const payload = await response.json();
      setTelegram(payload.telegram || EMPTY_TELEGRAM);
      setMessage(t('notifications.feedback.pairingOpen'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.pairTelegram'));
    } finally {
      setBusy('');
    }
  };

  const setTelegramEnabled = async (enabled) => {
    setBusy('telegram-enabled');
    setMessage('');
    setError('');
    try {
      const response = await apiFetch('/api/notifications/telegram', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const payload = await response.json();
      setTelegram(payload.telegram || EMPTY_TELEGRAM);
      setMessage(enabled ? t('notifications.feedback.telegramEnabled') : t('notifications.feedback.telegramDisabled'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.telegramSetting'));
    } finally {
      setBusy('');
    }
  };

  const pauseTelegram = async (hours = null) => {
    setBusy('telegram-pause');
    setMessage('');
    setError('');
    try {
      const response = await apiFetch('/api/notifications/telegram/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours })
      });
      const payload = await response.json();
      setTelegram(payload.telegram || EMPTY_TELEGRAM);
      setMessage(hours
        ? t('notifications.feedback.telegramPaused', { hours: formatNumber(hours) })
        : t('notifications.feedback.telegramResumed'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.telegramPause'));
    } finally {
      setBusy('');
    }
  };

  const disconnectTelegram = async () => {
    if (!window.confirm(t('notifications.confirmTelegram'))) return;
    setBusy('telegram-disconnect');
    setMessage('');
    setError('');
    try {
      const response = await apiFetch('/api/notifications/telegram', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: TELEGRAM_DISCONNECT_CONFIRMATION })
      });
      const payload = await response.json();
      setTelegram(payload.telegram || EMPTY_TELEGRAM);
      setTelegramToken('');
      setTelegramPanelOpen(false);
      setMessage(t('notifications.feedback.telegramRemoved'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.disconnectTelegram'));
    } finally {
      setBusy('');
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setMessage('');
    setError('');
    try {
      await apiFetch('/api/notifications/test', { method: 'POST' });
      await load({ quiet: true });
      setMessage(t('notifications.feedback.testSent'));
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.test'));
    } finally {
      setBusy('');
    }
  };

  const updateCodexReview = async (change, successMessage) => {
    setBusy('codex-review');
    setMessage('');
    setError('');
    try {
      const response = await apiFetch('/api/tasks/codex-review', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change)
      });
      const payload = await response.json();
      setCodexReview(payload.codexReview || EMPTY_CODEX_REVIEW);
      setMessage(successMessage);
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.codexSetting'));
    } finally {
      setBusy('');
    }
  };

  const runCodexReview = async () => {
    setBusy('codex-review-run');
    setMessage('');
    setError('');
    try {
      const response = await apiFetch('/api/tasks/codex-review/run', { method: 'POST' });
      const payload = await response.json();
      setCodexReview(payload.codexReview || EMPTY_CODEX_REVIEW);
      const result = payload.result || {};
      setMessage(t('notifications.feedback.codexCompleted', {
        created: formatNumber(result.created || 0),
        review: formatNumber(result.review || 0),
        ignored: formatNumber(result.ignored || 0)
      }));
      await load({ quiet: true });
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.codexRun'));
    } finally {
      setBusy('');
    }
  };

  const toggleTelegramReviewScope = async () => {
    if (telegramReviewScopeOpen) {
      setTelegramReviewScopeOpen(false);
      return;
    }
    setTelegramReviewScopeOpen(true);
    setTelegramReviewLoading(true);
    setTelegramReviewQuery('');
    setError('');
    try {
      const response = await apiFetch('/api/tasks/codex-review/telegram-chats');
      const payload = await response.json();
      setTelegramReviewChats(Array.isArray(payload.items) ? payload.items : []);
      setTelegramReviewDraft(
        Array.isArray(telegramReviewSource?.selectedChatRefs)
          ? telegramReviewSource.selectedChatRefs
          : []
      );
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.telegramChats'));
    } finally {
      setTelegramReviewLoading(false);
    }
  };

  const toggleTelegramReviewChat = (chatRef) => {
    setTelegramReviewDraft((current) => (
      current.includes(chatRef)
        ? current.filter((entry) => entry !== chatRef)
        : [...current, chatRef]
    ));
  };

  const saveTelegramReviewScope = async () => {
    setBusy('codex-review-telegram-scope');
    setMessage('');
    setError('');
    try {
      const response = await apiFetch('/api/tasks/codex-review', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: {
            telegram: {
              enabled: telegramReviewDraft.length > 0,
              chatRefs: telegramReviewDraft
            }
          }
        })
      });
      const payload = await response.json();
      setCodexReview(payload.codexReview || EMPTY_CODEX_REVIEW);
      setMessage(
        telegramReviewDraft.length
          ? t('notifications.feedback.telegramScope', { count: formatNumber(telegramReviewDraft.length) })
          : t('notifications.feedback.telegramScopeDisabled')
      );
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.saveTelegramChats'));
    } finally {
      setBusy('');
    }
  };

  const updateNotification = async (notification, status, extra = {}) => {
    setBusy(notification.id);
    setError('');
    try {
      await apiFetch(`/api/notifications/${encodeURIComponent(notification.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...extra })
      });
      await load({ quiet: true });
    } catch (requestError) {
      setError(requestError.message || t('notifications.errors.update'));
    } finally {
      setBusy('');
    }
  };

  const updateSourceRule = (sourceId, change) => {
    const existing = settings.sourceRules[sourceId] || { enabled: true, minimumSeverity: 'info' };
    setSettings((current) => ({
      ...current,
      sourceRules: {
        ...current.sourceRules,
        [sourceId]: { ...existing, ...change }
      }
    }));
  };

  if (loading) return <div className="notification-settings-state">{t('notifications.loading')}</div>;

  return (
    <div className="notification-settings">
      <div className="notification-settings-intro">
        <div>
          <span className="notification-settings-kicker"><Radio size={13} /> {t('notifications.kicker')}</span>
          <h3>{t('notifications.title')}</h3>
          <p>{t('notifications.description')}</p>
        </div>
        <div className="notification-settings-summary">
          <strong>{stats.unread}</strong>
          <span>{t('notifications.unread')}</span>
          {stats.criticalUnread > 0 && <em>{t('notifications.criticalCount', { count: formatNumber(stats.criticalUnread) })}</em>}
        </div>
      </div>

      {(message || error) && (
        <div className={`notification-settings-feedback${error ? ' is-error' : ''}`}>
          {error ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}
          <span>{error || message}</span>
          <button type="button" aria-label={t('notifications.closeMessage')} onClick={() => { setError(''); setMessage(''); }}>
            <X size={14} />
          </button>
        </div>
      )}

      <section className="notification-settings-section">
        <div className="notification-section-heading">
          <div><h3>{t('notifications.channels.title')}</h3><p>{t('notifications.channels.description')}</p></div>
          <button type="button" className="notification-test-button" disabled={Boolean(busy)} onClick={sendTest}>
            <Send size={14} /> {busy === 'test' ? t('notifications.channels.sending') : t('notifications.channels.sendTest')}
          </button>
        </div>
        <div className="notification-channel-grid">
          <article className="notification-channel-card is-active">
            <span className="notification-channel-icon"><Bell size={20} /></span>
            <div><strong>FoxOS</strong><span>{t('notifications.channels.foxosDescription')}</span></div>
            <em><Check size={12} /> {t('notifications.channels.active')}</em>
          </article>
          <article className={`notification-channel-card${browserState.subscribed ? ' is-active' : ''}`}>
            <span className="notification-channel-icon"><MonitorSmartphone size={20} /></span>
            <div>
              <strong>{t('notifications.channels.thisDevice')}</strong>
              <span>
                {!browserState.supported
                  ? t(browserState.reasonKey)
                  : browserState.subscribed
                    ? t('notifications.channels.deviceActive')
                    : t('notifications.channels.deviceInactive')}
              </span>
            </div>
            <button
              type="button"
              disabled={!browserState.supported || busy === 'push'}
              onClick={browserState.subscribed ? disconnectThisBrowser : connectThisBrowser}
            >
              {busy === 'push'
                ? t('notifications.channels.wait')
                : browserState.subscribed
                  ? t('notifications.channels.removeDevice')
                  : t('notifications.channels.connectDevice')}
            </button>
          </article>
          <article className="notification-channel-card">
            <span className="notification-channel-icon"><ServerCog size={20} /></span>
            <div>
              <strong>{t('notifications.channels.localAgent')}</strong>
              <span>{t('notifications.channels.localAgentDescription')}</span>
            </div>
            <em><ShieldCheck size={12} /> {t('notifications.channels.ready')}</em>
          </article>
          <article className={`notification-channel-card${telegram.paired && telegram.enabled ? ' is-active' : ''}`}>
            <span className="notification-channel-icon"><Bot size={20} /></span>
            <div>
              <strong>Telegram</strong>
              <span>
                {!telegram.configured
                  ? t('notifications.channels.telegramConnect')
                  : !telegram.paired
                    ? t('notifications.channels.telegramPairWaiting', { bot: telegram.bot?.username || 'bot' })
                    : telegram.pausedUntil
                      ? t('notifications.channels.telegramPaused', { time: formatDate(telegram.pausedUntil, { dateStyle: 'short', timeStyle: 'short' }) })
                      : telegram.enabled
                        ? t('notifications.channels.telegramEnabled', { bot: telegram.bot?.username || 'bot' })
                        : t('notifications.channels.telegramDisabled')}
              </span>
            </div>
            <button
              type="button"
              disabled={busy.startsWith('telegram-')}
              onClick={() => setTelegramPanelOpen((current) => !current)}
            >
              {telegramPanelOpen
                ? t('notifications.channels.close')
                : telegram.configured
                  ? t('notifications.channels.manage')
                  : t('notifications.channels.connect')}
            </button>
          </article>
        </div>
        {telegramPanelOpen && (
          <div className="notification-telegram-panel">
            <div className="notification-telegram-heading">
              <span className="notification-channel-icon"><Bot size={19} /></span>
              <div>
                <strong>{t('notifications.telegram.title')}</strong>
                <span>{t('notifications.telegram.description')}</span>
              </div>
              {telegram.paired && <em><Check size={12} /> {t('notifications.telegram.privateMatched')}</em>}
            </div>

            {!telegram.configured ? (
              <div className="notification-telegram-setup">
                <ol>
                  <li>{t('notifications.telegram.setupStep1Before')} <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> {t('notifications.telegram.setupStep1After')} <code>/newbot</code> {t('notifications.telegram.setupStep1End')}</li>
                  <li>{t('notifications.telegram.setupStep2')}</li>
                  <li>{t('notifications.telegram.setupStep3')}</li>
                </ol>
                <label className="notification-telegram-token">
                  <span><KeyRound size={14} /> {t('notifications.telegram.botToken')}</span>
                  <div>
                    <input
                      type="password"
                      value={telegramToken}
                      autoComplete="off"
                      spellCheck="false"
                      placeholder="123456789:AA…"
                      onChange={(event) => setTelegramToken(event.target.value)}
                    />
                    <button type="button" disabled={busy === 'telegram-configure'} onClick={configureTelegram}>
                      {busy === 'telegram-configure' ? t('notifications.telegram.verifying') : t('notifications.telegram.verifyBot')}
                    </button>
                  </div>
                </label>
              </div>
            ) : (
              <div className="notification-telegram-connected">
                <div className="notification-telegram-facts">
                  <span><strong>{t('notifications.telegram.bot')}</strong><a href={`https://t.me/${telegram.bot?.username}`} target="_blank" rel="noreferrer">@{telegram.bot?.username}</a></span>
                  <span><strong>{t('notifications.telegram.key')}</strong><em><ShieldCheck size={12} /> {t('notifications.telegram.encryptedHidden')}</em></span>
                  <span><strong>{t('notifications.telegram.chat')}</strong><em>{telegram.paired ? telegram.owner?.displayName || t('notifications.telegram.privateChat') : t('notifications.telegram.notPaired')}</em></span>
                  <span><strong>{t('notifications.telegram.listener')}</strong><em>{telegram.polling ? t('notifications.telegram.running') : t('notifications.telegram.waiting')}</em></span>
                </div>

                {!telegram.paired && (
                  <div className="notification-telegram-pairing">
                    <p>{t('notifications.telegram.pairingPrivacy')}</p>
                    <div>
                      <button type="button" disabled={busy === 'telegram-pair'} onClick={startTelegramPairing}>
                        <Link2 size={14} /> {telegram.pairing ? t('notifications.telegram.newCode') : t('notifications.telegram.startPairing')}
                      </button>
                      {telegram.pairing && (
                        <a href={telegram.pairing.url} target="_blank" rel="noreferrer">
                          {t('notifications.telegram.open')} <ExternalLink size={13} />
                        </a>
                      )}
                    </div>
                    {telegram.pairing && <small>{t('notifications.telegram.codeExpires', { time: formatTime(telegram.pairing.expiresAt) })}</small>}
                  </div>
                )}

                {telegram.paired && (
                  <div className="notification-telegram-controls">
                    <label className="notification-switch-row">
                      <span><Send size={15} /><span><strong>{t('notifications.telegram.delivery')}</strong><small>{t('notifications.telegram.deliveryDescription')}</small></span></span>
                      <input
                        type="checkbox"
                        checked={telegram.enabled}
                        disabled={busy === 'telegram-enabled'}
                        onChange={(event) => setTelegramEnabled(event.target.checked)}
                      />
                    </label>
                    <div>
                      {telegram.pausedUntil ? (
                        <button type="button" disabled={busy === 'telegram-pause'} onClick={() => pauseTelegram(null)}>
                          <PlayCircle size={14} /> {t('notifications.telegram.resume')}
                        </button>
                      ) : (
                        <>
                          {[1, 8, 24].map((hours) => (
                            <button type="button" key={hours} disabled={busy === 'telegram-pause'} onClick={() => pauseTelegram(hours)}><PauseCircle size={14} /> {t('notifications.telegram.hours', { hours: formatNumber(hours) })}</button>
                          ))}
                        </>
                      )}
                      <button type="button" className="is-danger" disabled={busy === 'telegram-disconnect'} onClick={disconnectTelegram}>
                        <Trash2 size={14} /> {t('notifications.telegram.remove')}
                      </button>
                    </div>
                    <small>{t('notifications.telegram.commandsBefore')} <code>/bildirimler</code>, <code>/gorevler</code>, <code>/sessiz 2s</code>, <code>/devam</code> {t('notifications.telegram.commandsMiddle')} <code>/gorevler</code> {t('notifications.telegram.commandsAfter')}</small>
                  </div>
                )}

                {telegram.lastErrorCode && (
                  <div className="notification-telegram-error"><CircleAlert size={14} /> {telegramErrorLabel(telegram.lastErrorCode, t)}</div>
                )}
              </div>
            )}
          </div>
        )}
        {push.deviceCount > 0 && (
          <div className="notification-device-note">
            <Smartphone size={14} /> {t('notifications.channels.devicesConnected', { count: formatNumber(push.deviceCount) })}
          </div>
        )}
      </section>

      <section className="notification-settings-section codex-review-section">
        <div className="notification-section-heading">
          <div>
            <h3>{t('notifications.review.title')}</h3>
            <p>{t('notifications.review.description')}</p>
          </div>
          <label className="notification-switch-row codex-review-switch">
            <span><ListChecks size={16} /><span><strong>{t('notifications.review.scheduled')}</strong><small>{codexReview.enabled ? t('notifications.review.enabled') : t('notifications.review.disabled')}</small></span></span>
            <input
              type="checkbox"
              checked={codexReview.enabled}
              disabled={busy === 'codex-review'}
              onChange={(event) => updateCodexReview(
                { enabled: event.target.checked },
                event.target.checked
                  ? t('notifications.feedback.codexEnabled')
                  : t('notifications.feedback.codexDisabled')
              )}
            />
          </label>
        </div>

        <div className="codex-review-controls">
          <label>
            <span>{t('notifications.review.interval')}</span>
            <input
              key={codexReview.intervalMinutes}
              type="number"
              min="0.25"
              max="168"
              step="0.25"
              defaultValue={Number((codexReview.intervalMinutes / 60).toFixed(2))}
              disabled={!codexReview.enabled || busy === 'codex-review'}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
              onBlur={(event) => {
                const hours = Number(event.target.value);
                const minutes = Math.round(hours * 60);
                if (!Number.isFinite(hours) || minutes < 15 || minutes > 10_080 || minutes === codexReview.intervalMinutes) return;
                updateCodexReview(
                  { intervalMinutes: minutes },
                  t('notifications.feedback.codexInterval', { hours: formatNumber(hours) })
                );
              }}
            />
          </label>
          <button
            type="button"
            disabled={!codexReview.enabled || !codexReview.codex?.ready || busy === 'codex-review-run' || codexReview.running}
            onClick={runCodexReview}
          >
            <RefreshCw size={14} className={codexReview.running ? 'is-spinning' : ''} />
            {codexReview.running || busy === 'codex-review-run' ? t('notifications.review.running') : t('notifications.review.runNow')}
          </button>
          <div className="codex-review-last-run">
            <strong>{t('notifications.review.lastRun')}</strong>
            <span>{codexReview.lastRunAt ? formatDate(codexReview.lastRunAt, { dateStyle: 'short', timeStyle: 'short' }) : t('notifications.review.neverRun')}</span>
          </div>
          <div className="codex-review-last-run">
            <strong>{t('notifications.review.decisionEngine')}</strong>
            <span>{codexReview.codex?.ready
              ? t('notifications.review.codexReady', { model: codexReview.lastModel ? ` · ${codexReview.lastModel}` : '' })
              : t('notifications.review.codexRequired')}</span>
          </div>
        </div>

        <div className="codex-review-sources">
          {(codexReview.sources || []).map((source) => (
            <article className={source.healthy ? 'is-healthy' : 'is-warning'} key={source.id}>
              <span className="codex-review-source-dot" />
              <div>
                <strong>{source.label}</strong>
                <span>
                  {!source.configured
                    ? t('notifications.review.noConnection')
                    : source.id === 'telegram' && !source.scopeReady
                      ? t('notifications.review.noScope')
                    : !source.enabled
                      ? t('notifications.review.sourceDisabled')
                      : source.id === 'telegram'
                        ? t('notifications.review.telegramStats', {
                          chats: formatNumber(source.selectedChatCount || 0),
                          tasks: formatNumber(source.lastTasks || 0),
                          reviews: formatNumber(source.lastReviews || 0)
                        })
                      : source.consecutiveFailures > 0
                        ? t('notifications.review.failures', { count: formatNumber(source.consecutiveFailures) })
                        : source.lastSuccessAt
                          ? t('notifications.review.sourceStats', {
                            messages: formatNumber(source.lastScanned || 0),
                            tasks: formatNumber(source.lastTasks || 0),
                            reviews: formatNumber(source.lastReviews || 0)
                          })
                          : t('notifications.review.sourceReady')}
                </span>
              </div>
            </article>
          ))}
        </div>

        {telegramReviewSource?.configured && (
          <div className="codex-review-telegram-scope">
            <div className="codex-review-telegram-scope-heading">
              <span className="notification-source-mark"><MessageCircle size={17} /></span>
              <div>
                <strong>{t('notifications.review.telegramChats')}</strong>
                <span>{t('notifications.review.telegramChatsDescription')}</span>
              </div>
              <button type="button" onClick={toggleTelegramReviewScope}>
                {telegramReviewScopeOpen ? t('notifications.review.close') : t('notifications.review.selectChats')}
              </button>
            </div>
            {telegramReviewScopeOpen && (
              <div className="codex-review-telegram-scope-panel">
                <div className="codex-review-telegram-scope-toolbar">
                  <input
                    type="search"
                    value={telegramReviewQuery}
                    placeholder={t('notifications.review.searchChats')}
                    aria-label={t('notifications.review.searchChatsLabel')}
                    onChange={(event) => setTelegramReviewQuery(event.target.value)}
                  />
                  <span>{t('notifications.review.selected', { count: formatNumber(telegramReviewDraft.length) })}</span>
                </div>
                {telegramReviewLoading ? (
                  <div className="codex-review-telegram-scope-empty">{t('notifications.review.loadingChats')}</div>
                ) : visibleTelegramReviewChats.length ? (
                  <div className="codex-review-telegram-chat-list">
                    {visibleTelegramReviewChats.map((chat) => (
                      <label key={chat.chatRef}>
                        <input
                          type="checkbox"
                          checked={telegramReviewDraft.includes(chat.chatRef)}
                          onChange={() => toggleTelegramReviewChat(chat.chatRef)}
                        />
                        <span>
                          <strong>{chat.title}</strong>
                          <small>{chat.kind === 'direct' ? t('notifications.review.direct') : t('notifications.review.group')}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="codex-review-telegram-scope-empty">{t('notifications.review.noChats')}</div>
                )}
                <div className="codex-review-telegram-scope-actions">
                  <span>{t('notifications.review.noAutoCommunity')}</span>
                  <button
                    type="button"
                    disabled={telegramReviewLoading || busy === 'codex-review-telegram-scope'}
                    onClick={saveTelegramReviewScope}
                  >
                    {busy === 'codex-review-telegram-scope' ? t('notifications.review.saving') : t('notifications.review.saveSelection')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="codex-review-note">
          <ShieldCheck size={14} />
          <span>{t('notifications.review.noteBefore')} <strong>{t('notifications.review.noteStrong')}</strong> {t('notifications.review.noteAfter')}</span>
        </div>
      </section>

      <section className="notification-settings-section">
        <div className="notification-section-heading">
          <div><h3>{t('notifications.rules.title')}</h3><p>{t('notifications.rules.description')}</p></div>
          <button type="button" className="notification-save-button" disabled={Boolean(busy)} onClick={saveSettings}>
            {busy === 'settings' ? t('notifications.rules.saving') : t('notifications.rules.save')}
          </button>
        </div>
        <div className="notification-rule-grid">
          <label className="notification-field">
            <span>{t('notifications.rules.minimum')}</span>
            <select
              value={settings.minimumSeverity}
              onChange={(event) => setSettings((current) => ({ ...current, minimumSeverity: event.target.value }))}
            >
              {SEVERITIES.map((severity) => <option key={severity.id} value={severity.id}>{t(severity.labelKey)}</option>)}
            </select>
          </label>
          <div className="notification-quiet-card">
            <label className="notification-switch-row">
              <span><Clock3 size={16} /><span><strong>{t('notifications.rules.quietHours')}</strong><small>{timeZone}</small></span></span>
              <input
                type="checkbox"
                checked={settings.quietHours.enabled}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  quietHours: { ...current.quietHours, enabled: event.target.checked }
                }))}
              />
            </label>
            <div className="notification-time-fields">
              <label><span>{t('notifications.rules.start')}</span><input type="time" value={settings.quietHours.start} onChange={(event) => setSettings((current) => ({ ...current, quietHours: { ...current.quietHours, start: event.target.value } }))} /></label>
              <label><span>{t('notifications.rules.end')}</span><input type="time" value={settings.quietHours.end} onChange={(event) => setSettings((current) => ({ ...current, quietHours: { ...current.quietHours, end: event.target.value } }))} /></label>
            </div>
            <label className="notification-checkbox-row">
              <input type="checkbox" checked={settings.quietHours.criticalOverride} onChange={(event) => setSettings((current) => ({ ...current, quietHours: { ...current.quietHours, criticalOverride: event.target.checked } }))} />
              {t('notifications.rules.criticalOverride')}
            </label>
          </div>
        </div>
      </section>

      <section className="notification-settings-section">
        <div className="notification-section-heading">
          <div><h3>{t('notifications.sourceRules.title')}</h3><p>{t('notifications.sourceRules.description')}</p></div>
        </div>
        {sources.length === 0 ? (
          <div className="notification-settings-empty">{t('notifications.sourceRules.empty')}</div>
        ) : (
          <div className="notification-source-list">
            {sources.map((source) => {
              const rule = settings.sourceRules[source.id] || source.rule || { enabled: true, minimumSeverity: 'info' };
              return (
                <div className="notification-source-row" key={source.id}>
                  <span className="notification-source-mark"><BellRing size={15} /></span>
                  <div><strong>{sourceName(source.id, t, locale)}</strong><span>{t('notifications.sourceRules.stats', { total: formatNumber(source.total), unread: formatNumber(source.unread) })}</span></div>
                  <select value={rule.minimumSeverity} disabled={!rule.enabled} onChange={(event) => updateSourceRule(source.id, { minimumSeverity: event.target.value })}>
                    {SEVERITIES.map((severity) => <option key={severity.id} value={severity.id}>{t(severity.labelKey)}</option>)}
                  </select>
                  <label className="notification-source-toggle">
                    <input type="checkbox" checked={rule.enabled} onChange={(event) => updateSourceRule(source.id, { enabled: event.target.checked })} />
                    <span>{rule.enabled ? t('notifications.sourceRules.send') : t('notifications.sourceRules.silent')}</span>
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="notification-settings-section">
        <div className="notification-section-heading">
          <div><h3>{t('notifications.history.title')}</h3><p>{t('notifications.history.description')}</p></div>
        </div>
        {notifications.length === 0 ? (
          <div className="notification-settings-empty">{t('notifications.history.empty')}</div>
        ) : (
          <div className="notification-history-list">
            {notifications.map((notification) => (
              <article className={`notification-history-row severity-${notification.severity}`} key={notification.id}>
                <span className="notification-history-icon">
                  {notification.severity === 'critical' || notification.severity === 'warning'
                    ? <CircleAlert size={16} />
                    : notification.severity === 'success' ? <CheckCircle2 size={16} /> : <Bell size={16} />}
                </span>
                <div className="notification-history-copy">
                  <strong>{notification.title}{notification.occurrenceCount > 1 && <em> ×{notification.occurrenceCount}</em>}</strong>
                  {notification.body && <p>{notification.body}</p>}
                  <span>{sourceName(notification.source, t, locale)} · {formatDate(notification.lastOccurredAt, { dateStyle: 'short', timeStyle: 'short' })}</span>
                  <div className="notification-deliveries">
                    {notification.deliveries.slice(-3).map((delivery, index) => (
                      <small className={`is-${delivery.status}`} key={`${delivery.channel}-${delivery.attemptedAt}-${index}`}>
                        {deliveryChannelLabel(delivery.channel)}: {statusLabel(delivery.status, t)}
                      </small>
                    ))}
                  </div>
                </div>
                <div className="notification-history-actions">
                  {notification.status === 'unread' && <button type="button" disabled={busy === notification.id} onClick={() => updateNotification(notification, 'read')}><Check size={13} /> {t('notifications.history.read')}</button>}
                  {!['snoozed', 'resolved'].includes(notification.status) && <button type="button" disabled={busy === notification.id} onClick={() => updateNotification(notification, 'snoozed', { snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() })}><Clock3 size={13} /> {t('notifications.history.snooze')}</button>}
                  {notification.status !== 'resolved' && <button type="button" disabled={busy === notification.id} onClick={() => updateNotification(notification, 'resolved')}><CheckCircle2 size={13} /> {t('notifications.history.resolved')}</button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="notification-adapter-note">
        <ExternalLink size={15} />
        <span>{t('notifications.adapterNote')}</span>
      </div>
    </div>
  );
};

export default NotificationSettings;
