import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CalendarDays,
  ChevronRight,
  Copy,
  ExternalLink,
  HardDrive,
  Link2,
  Loader2,
  Mail,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Unplug
} from 'lucide-react';
import { apiFetch } from '../api';
import { useDialog } from '../contexts/DialogContext';
import { useI18n } from '../contexts/LocaleContext';
import { useWindowManager } from '../contexts/WindowContext';
import cloudflareLogo from '../assets/cloudflare-logo.svg';
import './ConnectionsSettings.css';

const CARD_STYLE = {
  padding: '20px',
  background: 'rgba(15,16,22,0.58)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '16px'
};

const PRIMARY_BUTTON_STYLE = {
  background: '#0ea5e9',
  color: '#fff',
  border: 'none',
  padding: '9px 14px',
  borderRadius: '8px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  fontSize: '13px',
  fontWeight: 'bold'
};

const SECONDARY_BUTTON_STYLE = {
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.16)',
  padding: '9px 14px',
  borderRadius: '8px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  fontSize: '13px'
};

const Message = ({ value }) => value ? (
  <div aria-live="polite" className={`connection-message is-${value.type || 'success'}`}>
    {value.text}
  </div>
) : null;

const Status = ({ connected, readyLabel, idleLabel }) => {
  const { t } = useI18n();
  return (
    <div className={`connection-status${connected ? ' is-connected' : ''}`}>
      <span aria-hidden="true" />
      {connected ? readyLabel || t('connections.status.connected') : idleLabel || t('connections.status.disconnected')}
    </div>
  );
};

const ConnectionNavItem = ({ id, active, icon, tone, title, description, connected, status, onSelect }) => (
  <button
    type="button"
    className={`connection-nav-item${active ? ' is-active' : ''}`}
    aria-current={active ? 'page' : undefined}
    aria-controls={active ? `connection-panel-${id}` : undefined}
    onClick={() => onSelect(id)}
  >
    <span className={`connection-nav-icon is-${tone}`} aria-hidden="true">{icon}</span>
    <span className="connection-nav-copy">
      <strong>{title}</strong>
      <small>{description}</small>
    </span>
    <span className={`connection-nav-state${connected ? ' is-connected' : ''}`}>
      <i aria-hidden="true" />
      {status}
    </span>
    <ChevronRight className="connection-nav-chevron" size={14} aria-hidden="true" />
  </button>
);

const ConnectionsSettings = () => {
  const { showDialog } = useDialog();
  const { formatDate, formatTime, t } = useI18n();
  const { openWindow } = useWindowManager();
  const [cloudflare, setCloudflare] = useState(null);
  const [calendarConnection, setCalendarConnection] = useState(null);
  const [codex, setCodex] = useState(null);
  const [antigravity, setAntigravity] = useState(null);
  const [gemini, setGemini] = useState(null);
  const [codexLogin, setCodexLogin] = useState(null);
  const [antigravityLogin, setAntigravityLogin] = useState(null);
  const [antigravityCode, setAntigravityCode] = useState('');
  const [codexMemoryFolderUrl, setCodexMemoryFolderUrl] = useState('');
  const [editingCodexMemory, setEditingCodexMemory] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [editingGemini, setEditingGemini] = useState(false);
  const [apiToken, setApiToken] = useState('');
  const [editingCloudflare, setEditingCloudflare] = useState(false);
  const [calendarCredentials, setCalendarCredentials] = useState({
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' }
  });
  const [editingCalendarProvider, setEditingCalendarProvider] = useState({ google: false, microsoft: false });
  const calendarOauthPollRef = useRef(null);
  const calendarOauthPopupRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [activeConnection, setActiveConnection] = useState('calendar');
  const [messages, setMessages] = useState({ calendar: null, codex: null, antigravity: null, gemini: null, cloudflare: null });
  const codexConnected = Boolean(codex && codex.connected);
  const antigravityConnected = Boolean(antigravity && antigravity.connected);
  const geminiConnected = Boolean(gemini && gemini.connected);

  const setMessage = useCallback((provider, value) => setMessages((current) => ({ ...current, [provider]: value })), []);

  const loadConnections = useCallback(async ({ initial = false } = {}) => {
    if (initial) setLoading(true);
    try {
      const response = await apiFetch('/api/connections');
      const payload = await response.json();
      const nextCloudflare = (payload.connections || []).find((item) => item.id === 'cloudflare') || null;
      const nextCalendar = (payload.connections || []).find((item) => item.id === 'calendar-accounts') || null;
      const nextCodex = (payload.connections || []).find((item) => item.id === 'codex') || null;
      const nextAntigravity = (payload.connections || []).find((item) => item.id === 'antigravity-cli') || null;
      const nextGemini = (payload.connections || []).find((item) => item.id === 'gemini-cli') || null;
      setCloudflare(nextCloudflare);
      setCalendarConnection(nextCalendar);
      setCodex(nextCodex);
      setAntigravity(nextAntigravity);
      setGemini(nextGemini);
      if (initial) {
        const firstConnected = [
          ['calendar', nextCalendar],
          ['codex', nextCodex],
          ['antigravity', nextAntigravity],
          ['gemini', nextGemini],
          ['cloudflare', nextCloudflare]
        ].find(([, connection]) => connection?.connected);
        setActiveConnection(firstConnected?.[0] || 'calendar');
      }
      if (nextCodex && nextCodex.connected) {
        setCodexLogin(null);
        setMessage('codex', { type: 'success', text: t('connections.codex.accountConnected') });
      }
      if (nextAntigravity && nextAntigravity.connected) {
        setAntigravityLogin(null);
        setAntigravityCode('');
      }
    } catch (error) {
      setMessage('codex', { type: 'error', text: error.message });
    } finally {
      if (initial) setLoading(false);
    }
  }, [setMessage, t]);

  useEffect(() => {
    loadConnections({ initial: true });
  }, [loadConnections]);

  useEffect(() => () => {
    if (calendarOauthPollRef.current) window.clearInterval(calendarOauthPollRef.current);
  }, []);

  useEffect(() => {
    if (!codexLogin || codexConnected) return undefined;
    const timer = window.setInterval(() => {
      loadConnections().catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [codexConnected, codexLogin, loadConnections]);

  const refreshCalendarConnection = async () => {
    const response = await apiFetch('/api/connections/calendar');
    const payload = await response.json();
    setCalendarConnection(payload.connection);
    return payload.connection;
  };

  const updateCalendarCredential = (providerId, field, value) => {
    setCalendarCredentials((current) => ({
      ...current,
      [providerId]: { ...current[providerId], [field]: value }
    }));
    setMessage('calendar', null);
  };

  const saveCalendarProvider = async (event, providerId) => {
    event.preventDefault();
    const credentials = calendarCredentials[providerId];
    setSaving(`calendar-${providerId}-configure`);
    setMessage('calendar', null);
    try {
      const response = await apiFetch(`/api/connections/calendar/providers/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials)
      });
      const payload = await response.json();
      setCalendarConnection(payload.connection);
      setCalendarCredentials((current) => ({
        ...current,
        [providerId]: { clientId: '', clientSecret: '' }
      }));
      setEditingCalendarProvider((current) => ({ ...current, [providerId]: false }));
      setMessage('calendar', {
        type: 'success',
        text: t('connections.calendar.providerSaved', { provider: providerId === 'google' ? 'Google' : 'Microsoft' })
      });
    } catch (error) {
      setMessage('calendar', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const startCalendarAuthorization = async (providerId) => {
    const previousIds = new Set((calendarConnection?.accounts || []).map((account) => account.id));
    const previousSync = new Map((calendarConnection?.accounts || []).map((account) => [account.id, account.lastSyncedAt]));
    const reconnectingIds = new Set((calendarConnection?.accounts || [])
      .filter((account) => account.provider === providerId && account.needsReconnect)
      .map((account) => account.id));
    const popup = window.open('about:blank', `foxos-calendar-${providerId}`, 'popup,width=640,height=760');
    calendarOauthPopupRef.current = popup;
    if (popup) {
      popup.document.title = t('connections.calendar.popupTitle');
      popup.document.body.style.cssText = 'margin:0;background:#111318;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh';
      popup.document.body.textContent = t('connections.calendar.popupPreparing');
    }
    setSaving(`calendar-${providerId}-authorize`);
    setMessage('calendar', null);
    try {
      const response = await apiFetch(`/api/connections/calendar/providers/${providerId}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const payload = await response.json();
      if (popup) popup.location.assign(payload.authorization.authorizationUrl);
      else window.location.assign(payload.authorization.authorizationUrl);
      setMessage('calendar', {
        type: 'info',
        text: t('connections.calendar.authorizeInfo')
      });

      if (calendarOauthPollRef.current) window.clearInterval(calendarOauthPollRef.current);
      const expiresAt = Date.now() + 10 * 60 * 1000;
      let polling = false;
      calendarOauthPollRef.current = window.setInterval(async () => {
        if (polling) return;
        if (Date.now() >= expiresAt) {
          window.clearInterval(calendarOauthPollRef.current);
          calendarOauthPollRef.current = null;
          return;
        }
        polling = true;
        try {
          const connection = await refreshCalendarConnection();
          const added = (connection.accounts || []).find((account) => !previousIds.has(account.id));
          const reconnected = !added && (connection.accounts || []).some((account) => (
            (reconnectingIds.has(account.id) && !account.needsReconnect) ||
            (account.provider === providerId && previousSync.has(account.id) && previousSync.get(account.id) !== account.lastSyncedAt)
          ));
          if (added || reconnected) {
            window.clearInterval(calendarOauthPollRef.current);
            calendarOauthPollRef.current = null;
            try { calendarOauthPopupRef.current?.close(); } catch { /* Popup may already be closed. */ }
            setMessage('calendar', {
              type: 'success',
              text: t('connections.calendar.accountAdded', { account: added?.email || t('connections.calendar.accountFallback') })
            });
          }
        } catch {
          // The owner may still be completing consent in the other window.
        } finally {
          polling = false;
        }
      }, 1_500);
    } catch (error) {
      try { popup?.close(); } catch { /* Ignore popup cleanup failures. */ }
      setMessage('calendar', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectCalendarAccount = (account) => {
    showDialog({
      title: t('connections.calendar.disconnectTitle'),
      message: t('connections.calendar.disconnectMessage', { email: account.email }),
      type: 'confirm',
      confirmText: t('connections.calendar.disconnectConfirm'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving(`calendar-account-${account.id}`);
        setMessage('calendar', null);
        try {
          const response = await apiFetch(`/api/connections/calendar/accounts/${encodeURIComponent(account.id)}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'DISCONNECT CALENDAR ACCOUNT' })
          });
          const payload = await response.json();
          setCalendarConnection(payload.connection);
          setMessage('calendar', { type: 'success', text: t('connections.calendar.disconnected', { email: account.email }) });
        } catch (error) {
          setMessage('calendar', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const removeCalendarProvider = (provider) => {
    showDialog({
      title: t('connections.calendar.removeProviderTitle'),
      message: t('connections.calendar.removeProviderMessage', { provider: provider.name }),
      type: 'confirm',
      confirmText: t('connections.calendar.removeProviderConfirm'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving(`calendar-${provider.id}-remove`);
        setMessage('calendar', null);
        try {
          const response = await apiFetch(`/api/connections/calendar/providers/${provider.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'REMOVE CALENDAR OAUTH APP' })
          });
          const payload = await response.json();
          setCalendarConnection(payload.connection);
          setEditingCalendarProvider((current) => ({ ...current, [provider.id]: false }));
          setMessage('calendar', { type: 'success', text: t('connections.calendar.providerRemoved', { provider: provider.name }) });
        } catch (error) {
          setMessage('calendar', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const openCalendar = () => openWindow({
    id: 'calendar',
    type: 'calendar',
    title: t('common.calendar'),
    component: null,
    width: 980,
    height: 650
  });

  const installCodex = () => {
    showDialog({
      title: t('connections.codex.installTitle'),
      message: t('connections.codex.installMessage'),
      type: 'warning',
      confirmText: t('connections.common.installServer'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('codex-install');
        setMessage('codex', null);
        try {
          const response = await apiFetch('/api/connections/codex/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'INSTALL CODEX ON SERVER' })
          });
          const payload = await response.json();
          setCodex(payload.connection);
          setMessage('codex', {
            type: 'success',
            text: payload.version
              ? t('connections.common.installedVersion', { name: 'Codex CLI', version: payload.version })
              : t('connections.common.installedNoVersion', { name: 'Codex CLI' })
          });
        } catch (error) {
          setMessage('codex', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const startCodexLogin = async () => {
    setSaving('codex-login');
    setMessage('codex', null);
    try {
      const response = await apiFetch('/api/connections/codex/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const payload = await response.json();
      setCodexLogin(payload.login);
      setMessage('codex', { type: 'info', text: t('connections.codex.loginInfo') });
    } catch (error) {
      setMessage('codex', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const cancelCodexLogin = async () => {
    if (!codexLogin) return;
    setSaving('codex-login-cancel');
    try {
      await apiFetch('/api/connections/codex/login/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: codexLogin.loginId })
      });
      setCodexLogin(null);
      setMessage('codex', { type: 'info', text: t('connections.codex.loginCancelled') });
    } catch (error) {
      setMessage('codex', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const enableFullServer = () => {
    showDialog({
      title: t('connections.codex.fullServerTitle'),
      message: t('connections.codex.fullServerMessage'),
      type: 'warning',
      confirmText: t('connections.common.enableFullServer'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('codex-profile');
        setMessage('codex', null);
        try {
          const response = await apiFetch('/api/connections/codex/access-profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accessProfile: 'full-server',
              confirmation: 'ENABLE CODEX FULL SERVER'
            })
          });
          const payload = await response.json();
          setCodex(payload.connection);
          setMessage('codex', { type: 'success', text: t('connections.codex.fullServerEnabled') });
        } catch (error) {
          setMessage('codex', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const setCodexReadOnly = async () => {
    setSaving('codex-profile');
    setMessage('codex', null);
    try {
      const response = await apiFetch('/api/connections/codex/access-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessProfile: 'read-only' })
      });
      const payload = await response.json();
      setCodex(payload.connection);
      setMessage('codex', { type: 'success', text: t('connections.codex.readOnlyEnabled') });
    } catch (error) {
      setMessage('codex', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectCodex = () => {
    showDialog({
      title: t('connections.codex.disconnectTitle'),
      message: t('connections.codex.disconnectMessage'),
      type: 'confirm',
      confirmText: t('connections.common.disconnect'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('codex-disconnect');
        setMessage('codex', null);
        try {
          const response = await apiFetch('/api/connections/codex', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'DISCONNECT CODEX' })
          });
          const payload = await response.json();
          setCodex(payload.connection);
          setCodexLogin(null);
          setMessage('codex', { type: 'success', text: t('connections.codex.disconnected') });
        } catch (error) {
          setMessage('codex', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const updateCodexMemory = async ({ enabled, folderUrl = null }) => {
    setSaving('codex-memory');
    setMessage('codex', null);
    try {
      const response = await apiFetch('/api/connections/codex/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          ...(folderUrl ? { folderUrl, label: 'Drive memory' } : {})
        })
      });
      const payload = await response.json();
      setCodex(payload.connection);
      setCodexMemoryFolderUrl('');
      setEditingCodexMemory(false);
      setMessage('codex', {
        type: 'success',
        text: enabled
          ? t('connections.codex.memoryEnabled')
          : t('connections.codex.memoryDisabled')
      });
    } catch (error) {
      setMessage('codex', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const configureCodexMemory = (event) => {
    event.preventDefault();
    const folderUrl = codexMemoryFolderUrl.trim();
    if (!folderUrl) return;
    updateCodexMemory({ enabled: true, folderUrl });
  };

  const openCodex = () => openWindow({
    id: 'codex',
    type: 'codex',
    title: 'Codex',
    width: 900,
    height: 650
  });

  const installAntigravity = () => {
    showDialog({
      title: t('connections.antigravity.installTitle'),
      message: t('connections.antigravity.installMessage'),
      type: 'warning',
      confirmText: t('connections.common.installServer'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('antigravity-install');
        setMessage('antigravity', null);
        try {
          const response = await apiFetch('/api/connections/antigravity/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'INSTALL ANTIGRAVITY CLI ON SERVER' })
          });
          const payload = await response.json();
          setAntigravity(payload.connection);
          setMessage('antigravity', {
            type: 'success',
            text: payload.version
              ? t('connections.common.installedVersion', { name: 'Antigravity CLI', version: payload.version })
              : t('connections.common.installedNoVersion', { name: 'Antigravity CLI' })
          });
        } catch (error) {
          setMessage('antigravity', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const startAntigravityLogin = async () => {
    setSaving('antigravity-login');
    setMessage('antigravity', null);
    try {
      const response = await apiFetch('/api/connections/antigravity/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const payload = await response.json();
      setAntigravityLogin(payload.login);
      setAntigravityCode('');
      setMessage('antigravity', { type: 'info', text: t('connections.antigravity.loginInfo') });
    } catch (error) {
      setMessage('antigravity', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const completeAntigravityLogin = async (event) => {
    event.preventDefault();
    const authorizationCode = antigravityCode.trim();
    if (!antigravityLogin || !authorizationCode) return;
    setSaving('antigravity-login-complete');
    setMessage('antigravity', null);
    try {
      const response = await apiFetch('/api/connections/antigravity/login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: antigravityLogin.loginId, authorizationCode })
      });
      const payload = await response.json();
      setAntigravity(payload.connection);
      setAntigravityLogin(null);
      setAntigravityCode('');
      setMessage('antigravity', { type: 'success', text: t('connections.antigravity.connected') });
    } catch (error) {
      setMessage('antigravity', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const cancelAntigravityLogin = async () => {
    if (!antigravityLogin) return;
    setSaving('antigravity-login-cancel');
    try {
      await apiFetch('/api/connections/antigravity/login/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: antigravityLogin.loginId })
      });
      setAntigravityLogin(null);
      setAntigravityCode('');
      setMessage('antigravity', { type: 'info', text: t('connections.antigravity.loginCancelled') });
    } catch (error) {
      setMessage('antigravity', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const enableAntigravityFullServer = () => {
    showDialog({
      title: t('connections.antigravity.fullServerTitle'),
      message: t('connections.antigravity.fullServerMessage'),
      type: 'warning',
      confirmText: t('connections.common.enableFullServer'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('antigravity-profile');
        setMessage('antigravity', null);
        try {
          const response = await apiFetch('/api/connections/antigravity/access-profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accessProfile: 'full-server',
              confirmation: 'ENABLE ANTIGRAVITY FULL SERVER'
            })
          });
          const payload = await response.json();
          setAntigravity(payload.connection);
          setMessage('antigravity', { type: 'success', text: t('connections.antigravity.fullServerEnabled') });
        } catch (error) {
          setMessage('antigravity', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const setAntigravityReadOnly = async () => {
    setSaving('antigravity-profile');
    setMessage('antigravity', null);
    try {
      const response = await apiFetch('/api/connections/antigravity/access-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessProfile: 'read-only' })
      });
      const payload = await response.json();
      setAntigravity(payload.connection);
      setMessage('antigravity', { type: 'success', text: t('connections.antigravity.readOnlyEnabled') });
    } catch (error) {
      setMessage('antigravity', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const verifyAntigravity = async () => {
    setSaving('antigravity-verify');
    setMessage('antigravity', null);
    try {
      const response = await apiFetch('/api/connections/antigravity/verify', { method: 'POST' });
      const payload = await response.json();
      setAntigravity(payload.connection);
      setMessage('antigravity', {
        type: payload.connection.connected ? 'success' : 'error',
        text: payload.connection.connected
          ? t('connections.antigravity.verified')
          : t('connections.antigravity.notConnected')
      });
    } catch (error) {
      setMessage('antigravity', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectAntigravity = () => {
    showDialog({
      title: t('connections.antigravity.disconnectTitle'),
      message: t('connections.antigravity.disconnectMessage'),
      type: 'confirm',
      confirmText: t('connections.common.disconnect'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('antigravity-disconnect');
        setMessage('antigravity', null);
        try {
          const response = await apiFetch('/api/connections/antigravity', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'DISCONNECT ANTIGRAVITY CLI' })
          });
          const payload = await response.json();
          setAntigravity(payload.connection);
          setAntigravityLogin(null);
          setAntigravityCode('');
          setMessage('antigravity', { type: 'success', text: t('connections.antigravity.disconnected') });
        } catch (error) {
          setMessage('antigravity', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const installGemini = () => {
    showDialog({
      title: t('connections.gemini.installTitle'),
      message: t('connections.gemini.installMessage'),
      type: 'warning',
      confirmText: t('connections.common.installServer'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('gemini-install');
        setMessage('gemini', null);
        try {
          const response = await apiFetch('/api/connections/gemini/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'INSTALL GEMINI CLI ON SERVER' })
          });
          const payload = await response.json();
          setGemini(payload.connection);
          setMessage('gemini', {
            type: 'success',
            text: payload.version
              ? t('connections.common.installedVersion', { name: 'Gemini CLI', version: payload.version })
              : t('connections.common.installedNoVersion', { name: 'Gemini CLI' })
          });
        } catch (error) {
          setMessage('gemini', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const connectGemini = async (event) => {
    event.preventDefault();
    const apiKey = geminiApiKey.trim();
    if (!apiKey) return;
    setSaving('gemini-connect');
    setMessage('gemini', null);
    try {
      const response = await apiFetch('/api/connections/gemini', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey })
      });
      const payload = await response.json();
      setGemini(payload.connection);
      setGeminiApiKey('');
      setEditingGemini(false);
      setMessage('gemini', { type: 'success', text: t('connections.gemini.connected') });
    } catch (error) {
      setMessage('gemini', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const verifyGemini = async () => {
    setSaving('gemini-verify');
    setMessage('gemini', null);
    try {
      const response = await apiFetch('/api/connections/gemini/verify', { method: 'POST' });
      const payload = await response.json();
      setGemini(payload.connection);
      setMessage('gemini', { type: 'success', text: t('connections.gemini.verified') });
    } catch (error) {
      setMessage('gemini', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectGemini = () => {
    showDialog({
      title: t('connections.gemini.disconnectTitle'),
      message: t('connections.gemini.disconnectMessage'),
      type: 'confirm',
      confirmText: t('connections.common.disconnect'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('gemini-disconnect');
        setMessage('gemini', null);
        try {
          const response = await apiFetch('/api/connections/gemini', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'DISCONNECT GEMINI CLI' })
          });
          const payload = await response.json();
          setGemini(payload.connection);
          setGeminiApiKey('');
          setEditingGemini(false);
          setMessage('gemini', { type: 'success', text: t('connections.gemini.disconnected') });
        } catch (error) {
          setMessage('gemini', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  const connectCloudflare = async (event) => {
    event.preventDefault();
    if (!apiToken.trim()) return;
    setSaving('cloudflare-connect');
    setMessage('cloudflare', null);
    try {
      const response = await apiFetch('/api/connections/cloudflare', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: apiToken.trim() })
      });
      const payload = await response.json();
      setCloudflare(payload.connection);
      setApiToken('');
      setEditingCloudflare(false);
      setMessage('cloudflare', { type: 'success', text: t('connections.cloudflare.connected') });
    } catch (error) {
      setMessage('cloudflare', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const verifyCloudflare = async () => {
    setSaving('cloudflare-verify');
    setMessage('cloudflare', null);
    try {
      const response = await apiFetch('/api/connections/cloudflare/verify', { method: 'POST' });
      const payload = await response.json();
      setCloudflare(payload.connection);
      setMessage('cloudflare', { type: 'success', text: t('connections.cloudflare.verified') });
    } catch (error) {
      setMessage('cloudflare', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectCloudflare = () => {
    showDialog({
      title: t('connections.cloudflare.disconnectTitle'),
      message: t('connections.cloudflare.disconnectMessage'),
      type: 'confirm',
      confirmText: t('connections.common.disconnect'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setSaving('cloudflare-disconnect');
        setMessage('cloudflare', null);
        try {
          const response = await apiFetch('/api/connections/cloudflare', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'DISCONNECT CLOUDFLARE' })
          });
          const payload = await response.json();
          setCloudflare(payload.connection);
          setEditingCloudflare(false);
          setApiToken('');
          setMessage('cloudflare', { type: 'success', text: t('connections.cloudflare.disconnected') });
        } catch (error) {
          setMessage('cloudflare', { type: 'error', text: error.message });
        } finally {
          setSaving(null);
        }
      }
    });
  };

  if (loading) {
    return (
      <div className="connections-loading">
        <span><Loader2 size={15} className="spin" /> {t('connections.loading')}</span>
      </div>
    );
  }

  const codexInstalled = Boolean(codex && codex.installed);
  const calendarConnected = Boolean(calendarConnection && calendarConnection.connected);
  const antigravityInstalled = Boolean(antigravity && antigravity.installed);
  const geminiInstalled = Boolean(gemini && gemini.installed);
  const cloudflareConnected = Boolean(cloudflare && cloudflare.connected);
  const showGeminiForm = geminiInstalled && (!geminiConnected || editingGemini);
  const showCloudflareForm = !cloudflareConnected || editingCloudflare;
  const codexBusy = Boolean(saving && saving.startsWith('codex'));
  const antigravityBusy = Boolean(saving && saving.startsWith('antigravity'));
  const geminiBusy = Boolean(saving && saving.startsWith('gemini'));
  const cloudflareBusy = Boolean(saving && saving.startsWith('cloudflare'));
  const calendarBusy = Boolean(saving && saving.startsWith('calendar'));
  const connectedCount = [
    calendarConnected,
    codexConnected,
    antigravityConnected,
    geminiConnected,
    cloudflareConnected
  ].filter(Boolean).length;

  return (
    <div className="connections-settings">
      <header className="connections-hero">
        <div className="connections-hero-copy">
          <span className="connections-kicker"><Link2 size={12} /> {t('connections.kicker')}</span>
          <h3>{t('connections.title')}</h3>
          <p>{t('connections.description')}</p>
        </div>
        <div className={`connections-summary${connectedCount ? '' : ' is-empty'}`} aria-label={t('connections.summaryLabel', { count: connectedCount })}>
          <strong>{connectedCount}</strong>
          <span>{t('connections.summaryTotal')}</span>
          <em>{connectedCount ? t('connections.summaryActive') : t('connections.summaryEmpty')}</em>
        </div>
      </header>

      <div className="connections-workspace">
        <nav className="connections-directory" aria-label={t('connections.servicesLabel')}>
          <div className="connection-nav-group">
            <div className="connection-nav-label">{t('connections.groups.accounts')}</div>
            <ConnectionNavItem
              id="calendar"
              active={activeConnection === 'calendar'}
              icon={<CalendarDays size={18} />}
              tone="calendar"
              title={t('connections.nav.calendarTitle')}
              description={t('connections.nav.calendarDescription')}
              connected={calendarConnected}
              status={calendarConnected
                ? t('connections.counts.accounts', { count: calendarConnection?.accountCount || 0 })
                : t('connections.status.disconnected')}
              onSelect={setActiveConnection}
            />
          </div>

          <div className="connection-nav-group">
            <div className="connection-nav-label">{t('connections.groups.ai')}</div>
            <ConnectionNavItem
              id="codex"
              active={activeConnection === 'codex'}
              icon={<Bot size={18} />}
              tone="codex"
              title="Codex"
              description={t('connections.nav.codexDescription')}
              connected={codexConnected}
              status={codexConnected
                ? codex?.fullServer ? 'Full Server' : t('connections.status.connected')
                : codexInstalled ? t('connections.status.installed') : t('connections.status.notInstalled')}
              onSelect={setActiveConnection}
            />
            <ConnectionNavItem
              id="antigravity"
              active={activeConnection === 'antigravity'}
              icon={<Sparkles size={18} />}
              tone="antigravity"
              title="Antigravity"
              description={t('connections.nav.antigravityDescription')}
              connected={antigravityConnected}
              status={antigravityConnected
                ? antigravity?.fullServer ? 'Full Server' : t('connections.status.connected')
                : antigravityInstalled ? t('connections.status.installed') : t('connections.status.notInstalled')}
              onSelect={setActiveConnection}
            />
            <ConnectionNavItem
              id="gemini"
              active={activeConnection === 'gemini'}
              icon={<Sparkles size={18} />}
              tone="gemini"
              title="Gemini CLI"
              description={t('connections.nav.geminiDescription')}
              connected={geminiConnected}
              status={geminiConnected
                ? t('connections.status.connected')
                : geminiInstalled ? t('connections.status.installed') : t('connections.status.notInstalled')}
              onSelect={setActiveConnection}
            />
          </div>

          <div className="connection-nav-group">
            <div className="connection-nav-label">{t('connections.groups.infrastructure')}</div>
            <ConnectionNavItem
              id="cloudflare"
              active={activeConnection === 'cloudflare'}
              icon={<img src={cloudflareLogo} alt="" />}
              tone="cloudflare"
              title="Cloudflare"
              description={t('connections.nav.cloudflareDescription')}
              connected={cloudflareConnected}
              status={cloudflareConnected ? t('connections.status.connected') : t('connections.status.disconnected')}
              onSelect={setActiveConnection}
            />
          </div>

          <div className="connections-directory-note">
            <ShieldCheck size={14} aria-hidden="true" />
            <span>{t('connections.common.encryptedNote')}</span>
          </div>
        </nav>

        <div className="connections-detail" aria-label={t('connections.selectedDetail')}>
      {activeConnection === 'calendar' && (
      <section id="connection-panel-calendar" className="connection-detail-panel" style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '46px', height: '38px', borderRadius: '10px', background: 'linear-gradient(135deg, #2563eb 0%, #0ea5e9 55%, #22c55e 100%)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <CalendarDays size={22} color="#fff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>{t('connections.calendar.title')}</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                {t('connections.calendar.description')}
              </div>
            </div>
          </div>
          <Status
            connected={calendarConnected}
            readyLabel={t('connections.counts.accountsConnected', { count: calendarConnection?.accountCount || 0 })}
            idleLabel={t('connections.status.accountDisconnected')}
          />
        </div>

        <div style={{ color: '#aaa', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' }}>
          {t('connections.calendar.privacy')}
        </div>

        {(calendarConnection?.accounts || []).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {(calendarConnection.accounts || []).map((account) => (
              <div key={account.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', padding: '10px 11px', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '9px', background: 'rgba(0,0,0,0.16)' }}>
                <div style={{ width: '30px', height: '30px', display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: '8px', background: account.provider === 'google' ? 'linear-gradient(135deg,#4285f4,#34a853)' : 'linear-gradient(135deg,#0078d4,#00a4ef)' }}>
                  <Mail size={15} color="#fff" />
                </div>
                <div style={{ flex: '1 1 230px', minWidth: 0 }}>
                  <div style={{ color: '#fff', fontSize: '13px', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis' }}>{account.email}</div>
                  <div style={{ color: account.needsReconnect ? '#f6c453' : '#888', fontSize: '11px', marginTop: '2px' }}>
                    {account.providerName} · {t('connections.counts.calendars', { count: account.calendars.length })}{account.needsReconnect ? ` · ${t('connections.calendar.reconnectRequired')}` : ''}
                  </div>
                </div>
                {account.needsReconnect && (
                  <button type="button" onClick={() => startCalendarAuthorization(account.provider)} disabled={calendarBusy} style={{ ...PRIMARY_BUTTON_STYLE, padding: '7px 10px', cursor: calendarBusy ? 'wait' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                    <Link2 size={14} /> {t('connections.calendar.reconnect')}
                  </button>
                )}
                <button type="button" onClick={() => disconnectCalendarAccount(account)} disabled={calendarBusy} style={{ ...SECONDARY_BUTTON_STYLE, padding: '7px 10px', cursor: calendarBusy ? 'not-allowed' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                  <Unplug size={14} /> {t('connections.calendar.separate')}
                </button>
              </div>
            ))}
            <button type="button" onClick={openCalendar} disabled={calendarBusy} style={{ ...PRIMARY_BUTTON_STYLE, alignSelf: 'flex-start', marginTop: '2px', cursor: calendarBusy ? 'wait' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
              <CalendarDays size={15} /> {t('connections.calendar.open')}
            </button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {(calendarConnection?.providers || []).map((provider) => {
            const credentials = calendarCredentials[provider.id];
            const editing = editingCalendarProvider[provider.id];
            const showForm = !provider.configured || editing;
            const providerLabel = provider.id === 'google' ? 'Google' : 'Microsoft';
            const providerConsoleUrl = provider.id === 'google'
              ? 'https://console.cloud.google.com/apis/credentials'
              : 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';
            const canSave = credentials.clientId.trim() && (provider.configured || credentials.clientSecret.trim());
            return (
              <div key={provider.id} style={{ padding: '13px', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '10px', background: 'rgba(255,255,255,0.025)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: showForm ? '11px' : 0 }}>
                  <div>
                    <div style={{ color: '#fff', fontSize: '13px', fontWeight: 700 }}>{provider.name}</div>
                    <div style={{ color: '#888', fontSize: '11px', marginTop: '3px' }}>
                      {provider.configured
                        ? t('connections.counts.providerReady', { count: provider.accountCount })
                        : t('connections.calendar.configureFirst')}
                    </div>
                  </div>
                  <Status connected={provider.configured} readyLabel={t('connections.status.ready')} idleLabel={t('connections.status.notConfigured')} />
                </div>

                {showForm ? (
                  <form onSubmit={(event) => saveCalendarProvider(event, provider.id)}>
                    <div style={{ color: '#aaa', fontSize: '12px', lineHeight: 1.5, marginBottom: '10px' }}>
                      {provider.id === 'google'
                        ? t('connections.calendar.googleInstructions')
                        : t('connections.calendar.microsoftInstructions')}
                      {' '}{t('connections.calendar.redirectInstructions')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', padding: '9px 10px', borderRadius: '8px', background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.09)' }}>
                      <code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: '#cbd5e1', fontSize: '11px' }}>{provider.callbackUrl}</code>
                      <button type="button" onClick={() => navigator.clipboard?.writeText(provider.callbackUrl)} style={{ ...SECONDARY_BUTTON_STYLE, flexShrink: 0, padding: '6px 8px', cursor: 'pointer' }} aria-label={t('connections.calendar.copyRedirect')}><Copy size={13} /></button>
                    </div>
                    <a href={providerConsoleUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', marginBottom: '11px', textDecoration: 'none' }}>
                      {t('connections.calendar.openRegistrations', { provider: providerLabel })} <ExternalLink size={13} />
                    </a>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1fr)', gap: '9px', marginBottom: '10px' }} className="calendar-oauth-fields">
                      <input
                        type="text"
                        value={credentials.clientId}
                        onChange={(event) => updateCalendarCredential(provider.id, 'clientId', event.target.value)}
                        disabled={calendarBusy}
                        placeholder={`${providerLabel} OAuth Client ID`}
                        autoComplete="off"
                        spellCheck={false}
                        style={{ minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '12px' }}
                      />
                      <input
                        type="password"
                        value={credentials.clientSecret}
                        onChange={(event) => updateCalendarCredential(provider.id, 'clientSecret', event.target.value)}
                        disabled={calendarBusy}
                        placeholder={provider.configured ? t('connections.calendar.clientSecretOptional') : `${providerLabel} OAuth Client Secret`}
                        autoComplete="new-password"
                        spellCheck={false}
                        style={{ minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '12px' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      <button type="submit" disabled={calendarBusy || !canSave} style={{ ...PRIMARY_BUTTON_STYLE, cursor: calendarBusy || !canSave ? 'not-allowed' : 'pointer', opacity: calendarBusy || !canSave ? 0.5 : 1 }}>
                        {saving === `calendar-${provider.id}-configure` ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} {t('connections.calendar.saveOauth')}
                      </button>
                      {editing && (
                        <button type="button" onClick={() => { setEditingCalendarProvider((current) => ({ ...current, [provider.id]: false })); setMessage('calendar', null); }} disabled={calendarBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: calendarBusy ? 'not-allowed' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>{t('common.cancel')}</button>
                      )}
                    </div>
                  </form>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '11px' }}>
                    <button type="button" onClick={() => startCalendarAuthorization(provider.id)} disabled={calendarBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: calendarBusy ? 'wait' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                      {saving === `calendar-${provider.id}-authorize` ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {t('connections.calendar.addAccount', { provider: providerLabel })}
                    </button>
                    <button type="button" onClick={() => setEditingCalendarProvider((current) => ({ ...current, [provider.id]: true }))} disabled={calendarBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: calendarBusy ? 'not-allowed' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                      {t('connections.calendar.changeOauth')}
                    </button>
                    {provider.accountCount === 0 && (
                      <button type="button" onClick={() => removeCalendarProvider(provider)} disabled={calendarBusy} style={{ ...SECONDARY_BUTTON_STYLE, color: '#aaa', cursor: calendarBusy ? 'not-allowed' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                        {t('connections.calendar.removeSetting')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <Message value={messages.calendar} />
      </section>
      )}

      {activeConnection === 'codex' && (
      <section id="connection-panel-codex" className="connection-detail-panel" style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '46px', height: '38px', borderRadius: '10px', background: '#111', border: '1px solid rgba(255,255,255,0.13)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Bot size={23} color="#fff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Codex</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                {t('connections.codex.description')}
              </div>
            </div>
          </div>
          <Status connected={codexConnected} idleLabel={codexInstalled ? t('connections.status.accountDisconnected') : t('connections.status.notInstalled')} />
        </div>

        {!codexInstalled && (
          <>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              {t('connections.codex.optionalInstall')}
            </div>
            <button type="button" onClick={installCodex} disabled={codexBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>
              {saving === 'codex-install' ? <Loader2 size={15} className="spin" /> : <HardDrive size={15} />} {t('connections.common.installServer')}
            </button>
          </>
        )}

        {codexInstalled && !codexConnected && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>{t('connections.common.cliVersion')}</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{codex.version || t('connections.status.unknown')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.access')}</div>
              <div>{t('connections.codex.accessUntilConnected')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.credentials')}</div>
              <div>{t('connections.codex.credentialsManaged')}</div>
            </div>
            {!codexLogin ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                <button type="button" onClick={startCodexLogin} disabled={codexBusy || !codex.runtimeReady} style={{ ...PRIMARY_BUTTON_STYLE, cursor: codexBusy || !codex.runtimeReady ? 'not-allowed' : 'pointer', opacity: codexBusy || !codex.runtimeReady ? 0.5 : 1 }}>
                  {saving === 'codex-login' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {t('connections.codex.connectChatGpt')}
                </button>
                <button type="button" onClick={installCodex} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>
                  <RefreshCw size={15} /> {t('connections.common.updateCli')}
                </button>
              </div>
            ) : (
              <div style={{ padding: '13px', borderRadius: '10px', border: '1px solid rgba(14,165,233,0.3)', background: 'rgba(14,165,233,0.08)' }}>
                <div style={{ color: '#aaa', fontSize: '12px', marginBottom: '8px' }}>{t('connections.codex.verificationCode')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
                  <code style={{ color: '#fff', background: 'rgba(0,0,0,0.3)', borderRadius: '7px', padding: '8px 11px', fontSize: '15px', letterSpacing: '0.08em' }}>{codexLogin.userCode}</code>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(codexLogin.userCode)} style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}><Copy size={14} /> {t('connections.common.copy')}</button>
                  <a href={codexLogin.verificationUrl} target="_blank" rel="noreferrer" style={{ ...PRIMARY_BUTTON_STYLE, textDecoration: 'none' }}>{t('connections.codex.verifyOpenAi')} <ExternalLink size={14} /></a>
                  <button type="button" onClick={cancelCodexLogin} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>{t('common.cancel')}</button>
                </div>
              </div>
            )}
          </>
        )}

        {codexConnected && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>{t('connections.codex.account')}</div>
              <div>{codex.email || t('connections.codex.accountFallback')}</div>
              <div style={{ color: '#888' }}>{t('connections.codex.plan')}</div>
              <div>{codex.planType || t('connections.codex.planFallback')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.cliVersion')}</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{codex.version || t('connections.status.unknown')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.accessProfile')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: codex.fullServer ? '#f6c453' : '#aaa' }}>
                {codex.fullServer ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
                {codex.fullServer ? t('connections.common.fullServerRoot') : t('connections.common.readOnlyProfile')}
              </div>
              <div style={{ color: '#888' }}>{t('connections.codex.workingDirectory')}</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>/</div>
              <div style={{ color: '#888' }}>{t('connections.codex.memory')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: codex.memoryEnabled ? '#75da85' : '#aaa' }}>
                <HardDrive size={14} />
                {codex.memoryConfigured
                  ? codex.memoryEnabled
                    ? t('connections.codex.memoryAutomatic', { label: t('connections.codex.memoryLabel') })
                    : t('connections.codex.configuredDisabled')
                  : t('connections.codex.notConfigured')}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {codex.fullServer ? (
                <>
                  <button type="button" onClick={openCodex} disabled={codexBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}><Play size={15} /> {t('connections.codex.open')}</button>
                  <button type="button" onClick={setCodexReadOnly} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>{t('connections.common.readOnly')}</button>
                </>
              ) : (
                <button type="button" onClick={enableFullServer} disabled={codexBusy} style={{ ...PRIMARY_BUTTON_STYLE, background: '#b7791f', cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>
                  {saving === 'codex-profile' ? <Loader2 size={15} className="spin" /> : <ShieldAlert size={15} />} {t('connections.common.enableFullServer')}
                </button>
              )}
              <button type="button" onClick={() => loadConnections()} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}><RefreshCw size={15} /> {t('connections.codex.check')}</button>
              <button type="button" onClick={disconnectCodex} disabled={codexBusy} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: codexBusy ? 'not-allowed' : 'pointer', opacity: codexBusy ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><Unplug size={15} /> {t('connections.common.disconnect')}</button>
            </div>

            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.09)' }}>
              {!codex.memoryConfigured || editingCodexMemory ? (
                <form onSubmit={configureCodexMemory}>
                  <div style={{ color: '#aaa', fontSize: '12px', lineHeight: 1.5, marginBottom: '10px' }}>
                    {t('connections.codex.memoryDescription')}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                    <input
                      type="url"
                      value={codexMemoryFolderUrl}
                      onChange={(event) => { setCodexMemoryFolderUrl(event.target.value); setMessage('codex', null); }}
                      disabled={codexBusy}
                      placeholder={t('connections.codex.memoryUrl')}
                      autoComplete="off"
                      spellCheck={false}
                      style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}
                    />
                    <button type="submit" disabled={codexBusy || !codexMemoryFolderUrl.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: codexBusy || !codexMemoryFolderUrl.trim() ? 'not-allowed' : 'pointer', opacity: codexBusy || !codexMemoryFolderUrl.trim() ? 0.5 : 1 }}>
                      {saving === 'codex-memory' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {t('connections.codex.connectMemory')}
                    </button>
                    {codex.memoryConfigured && (
                      <button type="button" onClick={() => { setEditingCodexMemory(false); setCodexMemoryFolderUrl(''); setMessage('codex', null); }} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'not-allowed' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>{t('common.cancel')}</button>
                    )}
                  </div>
                </form>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
                  <div style={{ flex: '1 1 260px', color: '#aaa', fontSize: '12px', lineHeight: 1.5 }}>
                    {codex.memoryEnabled
                      ? t('connections.codex.memoryActiveDescription')
                      : t('connections.codex.memoryInactiveDescription')}
                  </div>
                  <button type="button" onClick={() => updateCodexMemory({ enabled: !codex.memoryEnabled })} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'not-allowed' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>
                    {saving === 'codex-memory' && <Loader2 size={15} className="spin" />} {codex.memoryEnabled ? t('connections.codex.disableMemory') : t('connections.codex.enableMemory')}
                  </button>
                  <button type="button" onClick={() => { setEditingCodexMemory(true); setMessage('codex', null); }} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'not-allowed' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}><Link2 size={15} /> {t('connections.codex.changeFolder')}</button>
                </div>
              )}
            </div>
          </>
        )}

        <Message value={messages.codex} />
      </section>
      )}

      {activeConnection === 'antigravity' && (
      <section id="connection-panel-antigravity" className="connection-detail-panel" style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '46px', height: '38px', borderRadius: '10px', background: 'linear-gradient(135deg, #0f172a 0%, #2563eb 45%, #a855f7 100%)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Sparkles size={22} color="#fff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Antigravity CLI</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                {t('connections.antigravity.descriptionBefore')} <strong style={{ color: '#aaa' }}>agy</strong> {t('connections.antigravity.descriptionAfter')}
              </div>
            </div>
          </div>
          <Status connected={antigravityConnected} idleLabel={antigravityInstalled ? t('connections.status.googleDisconnected') : t('connections.status.notInstalled')} />
        </div>

        {!antigravityInstalled && (
          <>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              {t('connections.antigravity.optionalInstall')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
              <button type="button" onClick={installAntigravity} disabled={antigravityBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>
                {saving === 'antigravity-install' ? <Loader2 size={15} className="spin" /> : <HardDrive size={15} />} {t('connections.common.installServer')}
              </button>
              <a href="https://antigravity.google/docs/cli/install" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', textDecoration: 'none' }}>{t('connections.antigravity.officialDocs')} <ExternalLink size={13} /></a>
            </div>
          </>
        )}

        {antigravityInstalled && !antigravityConnected && !antigravityLogin && (
          <>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              {t('connections.antigravity.loginDescription')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button type="button" onClick={startAntigravityLogin} disabled={antigravityBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>
                {saving === 'antigravity-login' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {t('connections.antigravity.connectGoogle')}
              </button>
              <button type="button" onClick={installAntigravity} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}><RefreshCw size={15} /> {t('connections.common.updateCli')}</button>
            </div>
          </>
        )}

        {antigravityInstalled && !antigravityConnected && antigravityLogin && (
          <form onSubmit={completeAntigravityLogin}>
            <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.24)', marginBottom: '12px' }}>
              <div style={{ color: '#ddd', fontSize: '13px', lineHeight: 1.55, marginBottom: '10px' }}>
                {t('connections.antigravity.loginSteps')}
              </div>
              <a href={antigravityLogin.verificationUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', color: '#7dd3fc', fontSize: '13px', fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: '3px' }}>
                {t('connections.antigravity.verifyGoogle')} <ExternalLink size={14} />
              </a>
              <div style={{ color: '#888', fontSize: '11px', marginTop: '8px' }}>
                {antigravityLogin.expiresAt
                  ? t('connections.antigravity.expiresAt', { time: formatTime(antigravityLogin.expiresAt) })
                  : t('connections.antigravity.expires')}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <input
                type="text"
                value={antigravityCode}
                onChange={(event) => { setAntigravityCode(event.target.value); setMessage('antigravity', null); }}
                disabled={antigravityBusy}
                placeholder={t('connections.antigravity.verificationCode')}
                autoComplete="one-time-code"
                spellCheck={false}
                style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              />
              <button type="submit" disabled={antigravityBusy || !antigravityCode.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: antigravityBusy || !antigravityCode.trim() ? 'not-allowed' : 'pointer', opacity: antigravityBusy || !antigravityCode.trim() ? 0.5 : 1 }}>
                {saving === 'antigravity-login-complete' ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} {t('connections.antigravity.verifyCode')}
              </button>
              <button type="button" onClick={cancelAntigravityLogin} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'not-allowed' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>{t('connections.common.cancelAction')}</button>
            </div>
          </form>
        )}

        {antigravityConnected && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>{t('connections.common.cliVersion')}</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{antigravity.version || t('connections.status.unknown')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.authentication')}</div>
              <div>{t('connections.antigravity.authenticationManaged')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.accessProfile')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: antigravity.fullServer ? '#f6c453' : '#75da85', fontWeight: 700 }}>
                {antigravity.fullServer ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
                {antigravity.fullServer ? t('connections.antigravity.fullServerProfile') : t('connections.antigravity.readOnlyProfile')}
              </div>
              <div style={{ color: '#888' }}>{t('connections.antigravity.workspace')}</div>
              <div>{antigravity.fullServer ? t('connections.antigravity.fullWorkspace') : t('connections.antigravity.restrictedWorkspace')}</div>
              <div style={{ color: '#888' }}>{t('connections.antigravity.approvals')}</div>
              <div>{antigravity.fullServer ? t('connections.antigravity.noApprovals') : t('connections.antigravity.strictApprovals')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.lastVerification')}</div>
              <div>{antigravity.lastVerifiedAt ? formatDate(antigravity.lastVerifiedAt, { dateStyle: 'short', timeStyle: 'short' }) : t('connections.status.never')}</div>
            </div>

            {!antigravity.profileApplied && (
              <div style={{ color: '#f6c453', fontSize: '12px', lineHeight: 1.5, marginBottom: '12px' }}>
                {t('connections.antigravity.profileMismatch')}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {antigravity.fullServer ? (
                <button type="button" onClick={setAntigravityReadOnly} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}><ShieldCheck size={15} /> {t('connections.common.readOnly')}</button>
              ) : (
                <button type="button" onClick={enableAntigravityFullServer} disabled={antigravityBusy} style={{ ...PRIMARY_BUTTON_STYLE, background: '#b7791f', cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>
                  {saving === 'antigravity-profile' ? <Loader2 size={15} className="spin" /> : <ShieldAlert size={15} />} {t('connections.common.enableFullServer')}
                </button>
              )}
              <button type="button" onClick={verifyAntigravity} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>{saving === 'antigravity-verify' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} {t('connections.common.checkConnection')}</button>
              <button type="button" onClick={installAntigravity} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}><RefreshCw size={15} /> {t('connections.common.updateCli')}</button>
              <button type="button" onClick={disconnectAntigravity} disabled={antigravityBusy} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: antigravityBusy ? 'not-allowed' : 'pointer', opacity: antigravityBusy ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><Unplug size={15} /> {t('connections.common.disconnect')}</button>
            </div>
          </>
        )}

        <Message value={messages.antigravity} />
      </section>
      )}

      {activeConnection === 'gemini' && (
      <section id="connection-panel-gemini" className="connection-detail-panel" style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '46px', height: '38px', borderRadius: '10px', background: 'linear-gradient(135deg, #4285f4 0%, #9b72cb 52%, #d96570 100%)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Sparkles size={22} color="#fff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Gemini CLI</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                {t('connections.gemini.description')}
              </div>
            </div>
          </div>
          <Status connected={geminiConnected} idleLabel={geminiInstalled ? t('connections.status.apiKeyDisconnected') : t('connections.status.notInstalled')} />
        </div>

        {!geminiInstalled && (
          <>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              {t('connections.gemini.optionalInstall')}
            </div>
            <button type="button" onClick={installGemini} disabled={geminiBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: geminiBusy ? 'wait' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}>
              {saving === 'gemini-install' ? <Loader2 size={15} className="spin" /> : <HardDrive size={15} />} {t('connections.common.installServer')}
            </button>
          </>
        )}

        {geminiConnected && !editingGemini && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>{t('connections.common.cliVersion')}</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{gemini.version || t('connections.status.unknown')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.authentication')}</div>
              <div>{t('connections.gemini.authenticationValue')}</div>
              <div style={{ color: '#888' }}>{t('connections.gemini.apiKey')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}><ShieldCheck size={14} color="#75da85" /> {t('connections.common.encryptedOnServer')}</div>
              <div style={{ color: '#888' }}>{t('connections.common.lastVerification')}</div>
              <div>{gemini.lastVerifiedAt ? formatDate(gemini.lastVerifiedAt, { dateStyle: 'short', timeStyle: 'short' }) : t('connections.status.never')}</div>
              <div style={{ color: '#888' }}>{t('connections.gemini.serverAccess')}</div>
              <div>{t('connections.gemini.noCommandAccess')}</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button type="button" onClick={verifyGemini} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'wait' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}>{saving === 'gemini-verify' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} {t('connections.common.checkConnection')}</button>
              <button type="button" onClick={installGemini} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'wait' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}><RefreshCw size={15} /> {t('connections.common.updateCli')}</button>
              <button type="button" onClick={() => { setEditingGemini(true); setMessage('gemini', null); }} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'not-allowed' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}><Link2 size={15} /> {t('connections.gemini.changeKey')}</button>
              <button type="button" onClick={disconnectGemini} disabled={geminiBusy} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: geminiBusy ? 'not-allowed' : 'pointer', opacity: geminiBusy ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><Unplug size={15} /> {t('connections.common.disconnect')}</button>
            </div>
          </>
        )}

        {showGeminiForm && (
          <form onSubmit={connectGemini}>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '10px' }}>
              {t('connections.gemini.headlessDescription')}
            </div>
            <div style={{ color: '#f6c453', fontSize: '12px', lineHeight: 1.5, marginBottom: '10px' }}>
              {t('connections.gemini.transitionWarning')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginBottom: '12px' }}>
              <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', textDecoration: 'none' }}>{t('connections.gemini.openApiKey')} <ExternalLink size={13} /></a>
              <a href="https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#aaa', fontSize: '12px', textDecoration: 'none' }}>{t('connections.gemini.transitionNews')} <ExternalLink size={13} /></a>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <input
                type="password"
                value={geminiApiKey}
                onChange={(event) => { setGeminiApiKey(event.target.value); setMessage('gemini', null); }}
                disabled={geminiBusy}
                placeholder={t('connections.gemini.apiKeyPlaceholder')}
                autoComplete="new-password"
                spellCheck={false}
                style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}
              />
              <button type="submit" disabled={geminiBusy || !geminiApiKey.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: geminiBusy || !geminiApiKey.trim() ? 'not-allowed' : 'pointer', opacity: geminiBusy || !geminiApiKey.trim() ? 0.5 : 1 }}>
                {saving === 'gemini-connect' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {geminiConnected ? t('connections.gemini.connectNewKey') : t('connections.gemini.connect')}
              </button>
              <button type="button" onClick={installGemini} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'wait' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}><RefreshCw size={15} /> {t('connections.common.updateCli')}</button>
              {geminiConnected && <button type="button" onClick={() => { setEditingGemini(false); setGeminiApiKey(''); setMessage('gemini', null); }} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'not-allowed' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}>{t('common.cancel')}</button>}
            </div>
          </form>
        )}

        <Message value={messages.gemini} />
      </section>
      )}

      {activeConnection === 'cloudflare' && (
      <section id="connection-panel-cloudflare" className="connection-detail-panel" style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '88px', height: '38px', padding: '0 7px', boxSizing: 'border-box', borderRadius: '10px', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <img src={cloudflareLogo} alt="Cloudflare" style={{ display: 'block', width: '74px', height: 'auto' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Cloudflare</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>{t('connections.cloudflare.description')}</div>
            </div>
          </div>
          <Status connected={cloudflareConnected} />
        </div>

        {cloudflareConnected && !editingCloudflare && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>{t('connections.cloudflare.zones')}</div>
              <div>{cloudflare.zones.join(', ')}</div>
              <div style={{ color: '#888' }}>{t('connections.cloudflare.serverIpv4')}</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{cloudflare.publicIpv4}</div>
              <div style={{ color: '#888' }}>{t('connections.cloudflare.permissions')}</div>
              <div>{cloudflare.permissions.join(', ')}</div>
              <div style={{ color: '#888' }}>{t('connections.cloudflare.token')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}><ShieldCheck size={14} color="#75da85" /> {t('connections.common.encryptedOnServer')}</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button type="button" onClick={verifyCloudflare} disabled={cloudflareBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: cloudflareBusy ? 'wait' : 'pointer', opacity: cloudflareBusy ? 0.5 : 1 }}>{saving === 'cloudflare-verify' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} {t('connections.common.checkConnection')}</button>
              <button type="button" onClick={() => { setEditingCloudflare(true); setMessage('cloudflare', null); }} disabled={cloudflareBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: cloudflareBusy ? 'not-allowed' : 'pointer', opacity: cloudflareBusy ? 0.5 : 1 }}><Link2 size={15} /> {t('connections.cloudflare.changeToken')}</button>
              <button type="button" onClick={disconnectCloudflare} disabled={cloudflareBusy} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: cloudflareBusy ? 'not-allowed' : 'pointer', opacity: cloudflareBusy ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><Unplug size={15} /> {t('connections.common.disconnect')}</button>
            </div>
          </>
        )}

        {showCloudflareForm && (
          <form onSubmit={connectCloudflare}>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              {t('connections.cloudflare.tokenDescriptionBefore')} <strong>Zone Read</strong> {t('connections.cloudflare.tokenDescriptionMiddle')} <strong>DNS Edit</strong> {t('connections.cloudflare.tokenDescriptionAfter')}
            </div>
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', marginBottom: '12px', textDecoration: 'none' }}>{t('connections.cloudflare.openTokenPage')} <ExternalLink size={13} /></a>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <input type="password" value={apiToken} onChange={(event) => { setApiToken(event.target.value); setMessage('cloudflare', null); }} disabled={cloudflareBusy} placeholder="Cloudflare API Token" autoComplete="new-password" spellCheck={false} style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }} />
              <button type="submit" disabled={cloudflareBusy || !apiToken.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: cloudflareBusy || !apiToken.trim() ? 'not-allowed' : 'pointer', opacity: cloudflareBusy || !apiToken.trim() ? 0.5 : 1 }}>{saving === 'cloudflare-connect' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {cloudflareConnected ? t('connections.cloudflare.connectNewToken') : t('connections.cloudflare.connect')}</button>
              {cloudflareConnected && <button type="button" onClick={() => { setEditingCloudflare(false); setApiToken(''); setMessage('cloudflare', null); }} disabled={cloudflareBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: cloudflareBusy ? 'not-allowed' : 'pointer', opacity: cloudflareBusy ? 0.5 : 1 }}>{t('common.cancel')}</button>}
            </div>
          </form>
        )}

        <Message value={messages.cloudflare} />
      </section>
      )}
        </div>
      </div>
    </div>
  );
};

export default ConnectionsSettings;
