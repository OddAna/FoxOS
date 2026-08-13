import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  CalendarDays,
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
import { useWindowManager } from '../contexts/WindowContext';
import cloudflareLogo from '../assets/cloudflare-logo.svg';

const CARD_STYLE = {
  padding: '16px',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '12px'
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
  <div aria-live="polite" style={{ marginTop: '14px', padding: '10px 12px', borderRadius: '8px', background: value.type === 'error' ? 'rgba(255,95,86,0.12)' : value.type === 'info' ? 'rgba(14,165,233,0.1)' : 'rgba(39,201,63,0.12)', border: `1px solid ${value.type === 'error' ? 'rgba(255,95,86,0.35)' : value.type === 'info' ? 'rgba(14,165,233,0.3)' : 'rgba(39,201,63,0.35)'}`, color: value.type === 'error' ? '#ff8a84' : value.type === 'info' ? '#7dd3fc' : '#75da85', fontSize: '13px', lineHeight: 1.5 }}>
    {value.text}
  </div>
) : null;

const Status = ({ connected, readyLabel = 'Bağlı', idleLabel = 'Bağlı değil' }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: connected ? '#75da85' : '#888', fontSize: '12px', whiteSpace: 'nowrap' }}>
    <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: connected ? '#27c93f' : '#111', border: connected ? 'none' : '1px solid rgba(255,255,255,0.2)' }} />
    {connected ? readyLabel : idleLabel}
  </div>
);

const ConnectionsSettings = () => {
  const { showDialog } = useDialog();
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
  const [messages, setMessages] = useState({ calendar: null, codex: null, antigravity: null, gemini: null, cloudflare: null });
  const codexConnected = Boolean(codex && codex.connected);
  const antigravityConnected = Boolean(antigravity && antigravity.connected);
  const geminiConnected = Boolean(gemini && gemini.connected);

  const setMessage = (provider, value) => setMessages((current) => ({ ...current, [provider]: value }));

  const loadConnections = async ({ initial = false } = {}) => {
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
      if (nextCodex && nextCodex.connected) {
        setCodexLogin(null);
        setMessage('codex', { type: 'success', text: 'Codex hesabı bağlandı.' });
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
  };

  useEffect(() => {
    loadConnections({ initial: true });
  }, []);

  useEffect(() => () => {
    if (calendarOauthPollRef.current) window.clearInterval(calendarOauthPollRef.current);
  }, []);

  useEffect(() => {
    if (!codexLogin || codexConnected) return undefined;
    const timer = window.setInterval(() => {
      loadConnections().catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [codexLogin, codexConnected]);

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
        text: `${providerId === 'google' ? 'Google' : 'Microsoft'} OAuth uygulaması güvenli biçimde kaydedildi. Şimdi hesabınızı ekleyebilirsiniz.`
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
      popup.document.title = 'Takvim hesabı bağlanıyor';
      popup.document.body.style.cssText = 'margin:0;background:#111318;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh';
      popup.document.body.textContent = 'Hesap giriş sayfası hazırlanıyor…';
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
        text: 'Hesap seçme penceresinde takvim iznini onaylayın. Bağlantı tamamlanınca bu ekran otomatik yenilenecek.'
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
              text: `${added?.email || 'Takvim hesabı'} bağlandı. Etkinlikler Takvim uygulamasında görünecek.`
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
      title: 'Takvim Hesabını Ayır',
      message: `${account.email} hesabının FoxOS’taki şifreli yenileme anahtarı silinecek. Sağlayıcıdaki takvim ve etkinlikler silinmez.`,
      type: 'confirm',
      confirmText: 'Hesabı Ayır',
      cancelText: 'Vazgeç',
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
          setMessage('calendar', { type: 'success', text: `${account.email} FoxOS Takvim’den ayrıldı.` });
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
      title: 'OAuth Uygulamasını Kaldır',
      message: `${provider.name} Client ID ve şifreli Client Secret kaydı bu sunucudan silinecek.`,
      type: 'confirm',
      confirmText: 'Ayarı Kaldır',
      cancelText: 'Vazgeç',
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
          setMessage('calendar', { type: 'success', text: `${provider.name} OAuth uygulama ayarı kaldırıldı.` });
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
    title: 'Takvim',
    component: null,
    width: 980,
    height: 650
  });

  const installCodex = () => {
    showDialog({
      title: 'Codex CLI’ı Sunucuya Kur',
      message: 'FoxOS, OpenAI’ın resmî kurucusuyla Codex CLI’ı Linux hostta /var/lib/foxos/codex altına kuracak. Bu adım henüz bir hesap bağlamaz veya Codex’e Full Server yetkisi vermez.',
      type: 'warning',
      confirmText: 'Sunucuya Kur',
      cancelText: 'Vazgeç',
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
          setMessage('codex', { type: 'success', text: `Codex CLI sunucuya kuruldu${payload.version ? `: ${payload.version}` : '.'}` });
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
      setMessage('codex', { type: 'info', text: 'OpenAI sayfasında kodu girip hesabınızla onaylayın. FoxOS bağlantıyı otomatik algılayacak.' });
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
      setMessage('codex', { type: 'info', text: 'Codex hesap bağlantısı iptal edildi.' });
    } catch (error) {
      setMessage('codex', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const enableFullServer = () => {
    showDialog({
      title: 'Codex Full Server Erişimi',
      message: 'Codex sunucu kökünde / çalışacak ve root eşdeğeri erişimle dosyaları, Docker’ı, systemd servislerini, paketleri ve ağ ayarlarını değiştirebilecek. Codex’in istediği güvenilir olmayan komutlar FoxOS onayına düşecek.',
      type: 'warning',
      confirmText: 'Full Server’ı Etkinleştir',
      cancelText: 'Vazgeç',
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
          setMessage('codex', { type: 'success', text: 'Codex Full Server erişimi etkinleştirildi. Çalışma dizini sunucu kökü: /' });
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
      setMessage('codex', { type: 'success', text: 'Codex erişimi salt-okunur profile alındı.' });
    } catch (error) {
      setMessage('codex', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectCodex = () => {
    showDialog({
      title: 'Codex Bağlantısını Kes',
      message: 'Codex hesabı bu sunucudan çıkarılacak ve Full Server yetkisi salt-okunura dönecek. Codex CLI kurulu kalacak.',
      type: 'confirm',
      confirmText: 'Bağlantıyı Kes',
      cancelText: 'Vazgeç',
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
          setMessage('codex', { type: 'success', text: 'Codex hesabı sunucudan çıkarıldı ve Full Server erişimi kapatıldı.' });
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
          ...(folderUrl ? { folderUrl, label: 'Drive hafızası' } : {})
        })
      });
      const payload = await response.json();
      setCodex(payload.connection);
      setCodexMemoryFolderUrl('');
      setEditingCodexMemory(false);
      setMessage('codex', {
        type: 'success',
        text: enabled
          ? 'Drive hafızası açıldı. Yeni ve yeniden açılan konuşmalar hafızayı başlangıçta yükleyecek.'
          : 'Drive hafızası kapatıldı. Sunucudaki klasör kaydı silinmedi.'
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
      title: 'Antigravity CLI’yi Sunucuya Kur',
      message: 'FoxOS, Google’ın resmî Antigravity kurucusunu kullanarak agy komutunu Linux hostta /var/lib/foxos/antigravity altına kuracak veya güncelleyecek. Bu adım hesap bağlamaz ve Full Server yetkisi vermez.',
      type: 'warning',
      confirmText: 'Sunucuya Kur',
      cancelText: 'Vazgeç',
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
          setMessage('antigravity', { type: 'success', text: `Antigravity CLI sunucuya kuruldu${payload.version ? `: ${payload.version}` : '.'}` });
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
      setMessage('antigravity', { type: 'info', text: 'Google bağlantısını açın, hesabınızla onaylayın ve tarayıcıdaki doğrulama kodunu aşağıya yapıştırın.' });
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
      setMessage('antigravity', { type: 'success', text: 'Antigravity Google hesabı bağlandı. Başlangıç profili salt-okunur ve korumalıdır.' });
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
      setMessage('antigravity', { type: 'info', text: 'Antigravity giriş işlemi iptal edildi.' });
    } catch (error) {
      setMessage('antigravity', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const enableAntigravityFullServer = () => {
    showDialog({
      title: 'Antigravity Full Server Erişimi',
      message: 'Antigravity sunucu kökünde / çalışabilecek ve root eşdeğeri erişimle dosyaları, Docker’ı, systemd servislerini, paketleri ve ağ ayarlarını değiştirebilecek. Terminal sandboxı kapanacak; komut, dosya değişikliği ve artifact incelemesi için tek tek onay SORMAYACAK.',
      type: 'warning',
      confirmText: 'Full Server’ı Etkinleştir',
      cancelText: 'Vazgeç',
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
          setMessage('antigravity', { type: 'success', text: 'Antigravity Full Server etkin: sunucu kökü /, terminal sandboxı kapalı ve tek tek onay yok.' });
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
      setMessage('antigravity', { type: 'success', text: 'Antigravity salt-okunur plan moduna alındı; sıkı izinler ve terminal sandboxı açık.' });
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
          ? 'Antigravity hesabı ve kalıcı erişim profili yeniden doğrulandı; model kotası kullanılmadı.'
          : 'Antigravity hesabı bağlı değil. Erişim profili korumalı moda döndü.'
      });
    } catch (error) {
      setMessage('antigravity', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectAntigravity = () => {
    showDialog({
      title: 'Antigravity Bağlantısını Kes',
      message: 'Google oturumu Antigravity CLI’dan çıkarılacak ve Full Server profili kapatılıp salt-okunura dönecek. CLI kurulu kalacak.',
      type: 'confirm',
      confirmText: 'Bağlantıyı Kes',
      cancelText: 'Vazgeç',
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
          setMessage('antigravity', { type: 'success', text: 'Antigravity hesabı çıkarıldı, Full Server kapatıldı ve CLI kurulu bırakıldı.' });
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
      title: 'Gemini CLI’yi Sunucuya Kur',
      message: 'FoxOS, Google’ın resmî kararlı @google/gemini-cli paketini Linux hostta /var/lib/foxos/gemini altına kuracak. Bu adım hesap bağlamaz, API anahtarı oluşturmaz veya sunucu komut erişimi vermez.',
      type: 'warning',
      confirmText: 'Sunucuya Kur',
      cancelText: 'Vazgeç',
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
          setMessage('gemini', { type: 'success', text: `Gemini CLI sunucuya kuruldu${payload.version ? `: ${payload.version}` : '.'}` });
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
      setMessage('gemini', { type: 'success', text: 'Gemini CLI bağlandı. API anahtarı sunucuda şifreli saklanıyor.' });
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
      setMessage('gemini', { type: 'success', text: 'Gemini CLI ve API erişimi yeniden doğrulandı.' });
    } catch (error) {
      setMessage('gemini', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectGemini = () => {
    showDialog({
      title: 'Gemini CLI Bağlantısını Kes',
      message: 'Şifreli Gemini API anahtarı ve yerel bağlantı kaydı silinecek. Gemini CLI kurulu kalacak.',
      type: 'confirm',
      confirmText: 'Bağlantıyı Kes',
      cancelText: 'Vazgeç',
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
          setMessage('gemini', { type: 'success', text: 'Gemini CLI bağlantısı kesildi; CLI kurulu bırakıldı.' });
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
      setMessage('cloudflare', { type: 'success', text: 'Cloudflare bağlandı. Erişim linklerinde gerekli DNS kayıtları artık onaylanan işlemle otomatik yönetilecek.' });
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
      setMessage('cloudflare', { type: 'success', text: 'Cloudflare tokenı, DNS bölgeleri ve sunucu IPv4 adresi yeniden doğrulandı.' });
    } catch (error) {
      setMessage('cloudflare', { type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const disconnectCloudflare = () => {
    showDialog({
      title: 'Cloudflare Bağlantısını Kes',
      message: 'Şifreli API token sunucudan kaldırılacak. Daha önce oluşturulmuş DNS kayıtları silinmeyecek ve çalışan uygulamalar etkilenmeyecek.',
      type: 'confirm',
      confirmText: 'Bağlantıyı Kes',
      cancelText: 'Vazgeç',
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
          setMessage('cloudflare', { type: 'success', text: 'Cloudflare bağlantısı kesildi. Mevcut DNS kayıtları korundu.' });
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
      <div style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Loader2 size={15} className="spin" /> Bağlantılar okunuyor...
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

  return (
    <div className="connections-settings" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
        Sunucunun kullanacağı dış hesapları buradan bağlayın. Bağlantılar isteğe bağlıdır; FoxOS bağlı hesap olmadan da çalışır.
      </div>

      <section style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '46px', height: '38px', borderRadius: '10px', background: 'linear-gradient(135deg, #2563eb 0%, #0ea5e9 55%, #22c55e 100%)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <CalendarDays size={22} color="#fff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Takvim Hesapları</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                Google, Outlook ve Microsoft 365 etkinliklerini FoxOS Takvim’de birleştirir.
              </div>
            </div>
          </div>
          <Status
            connected={calendarConnected}
            readyLabel={`${calendarConnection?.accountCount || 0} hesap bağlı`}
            idleLabel="Hesap bağlı değil"
          />
        </div>

        <div style={{ color: '#aaa', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' }}>
          FoxOS e-posta parolanızı almaz. Her hesap sağlayıcının kendi giriş sayfasında seçilir; yalnız takvim etkinliklerini okuma ve düzenleme izni istenir. Yenileme anahtarları bu sunucuda şifreli saklanır.
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
                    {account.providerName} · {account.calendars.length} takvim{account.needsReconnect ? ' · yeniden bağlantı gerekli' : ''}
                  </div>
                </div>
                {account.needsReconnect && (
                  <button type="button" onClick={() => startCalendarAuthorization(account.provider)} disabled={calendarBusy} style={{ ...PRIMARY_BUTTON_STYLE, padding: '7px 10px', cursor: calendarBusy ? 'wait' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                    <Link2 size={14} /> Yeniden Bağla
                  </button>
                )}
                <button type="button" onClick={() => disconnectCalendarAccount(account)} disabled={calendarBusy} style={{ ...SECONDARY_BUTTON_STYLE, padding: '7px 10px', cursor: calendarBusy ? 'not-allowed' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                  <Unplug size={14} /> Ayır
                </button>
              </div>
            ))}
            <button type="button" onClick={openCalendar} disabled={calendarBusy} style={{ ...PRIMARY_BUTTON_STYLE, alignSelf: 'flex-start', marginTop: '2px', cursor: calendarBusy ? 'wait' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
              <CalendarDays size={15} /> Takvimi Aç
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
                      {provider.configured ? `${provider.accountCount} hesap · OAuth uygulaması hazır` : 'Önce sunucuya ait OAuth uygulamasını tanımlayın'}
                    </div>
                  </div>
                  <Status connected={provider.configured} readyLabel="Hazır" idleLabel="Yapılandırılmadı" />
                </div>

                {showForm ? (
                  <form onSubmit={(event) => saveCalendarProvider(event, provider.id)}>
                    <div style={{ color: '#aaa', fontSize: '12px', lineHeight: 1.5, marginBottom: '10px' }}>
                      {provider.id === 'google'
                        ? 'Google Cloud’da Calendar API’yi açın ve “Web application” OAuth istemcisi oluşturun.'
                        : 'Microsoft Entra’da kişisel Microsoft hesaplarını da destekleyen bir Web uygulaması kaydedin; User.Read ve Calendars.ReadWrite delegated izinlerini ekleyin.'}
                      {' '}Aşağıdaki dönüş adresini yetkili Redirect URI olarak birebir kaydedin.
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', padding: '9px 10px', borderRadius: '8px', background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.09)' }}>
                      <code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: '#cbd5e1', fontSize: '11px' }}>{provider.callbackUrl}</code>
                      <button type="button" onClick={() => navigator.clipboard?.writeText(provider.callbackUrl)} style={{ ...SECONDARY_BUTTON_STYLE, flexShrink: 0, padding: '6px 8px', cursor: 'pointer' }} aria-label="Dönüş adresini kopyala"><Copy size={13} /></button>
                    </div>
                    <a href={providerConsoleUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', marginBottom: '11px', textDecoration: 'none' }}>
                      {providerLabel} uygulama kayıtlarını aç <ExternalLink size={13} />
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
                        placeholder={provider.configured ? 'Client Secret (değişmiyorsa boş)' : `${providerLabel} OAuth Client Secret`}
                        autoComplete="new-password"
                        spellCheck={false}
                        style={{ minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '12px' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      <button type="submit" disabled={calendarBusy || !canSave} style={{ ...PRIMARY_BUTTON_STYLE, cursor: calendarBusy || !canSave ? 'not-allowed' : 'pointer', opacity: calendarBusy || !canSave ? 0.5 : 1 }}>
                        {saving === `calendar-${provider.id}-configure` ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} OAuth Ayarını Kaydet
                      </button>
                      {editing && (
                        <button type="button" onClick={() => { setEditingCalendarProvider((current) => ({ ...current, [provider.id]: false })); setMessage('calendar', null); }} disabled={calendarBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: calendarBusy ? 'not-allowed' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>Vazgeç</button>
                      )}
                    </div>
                  </form>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '11px' }}>
                    <button type="button" onClick={() => startCalendarAuthorization(provider.id)} disabled={calendarBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: calendarBusy ? 'wait' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                      {saving === `calendar-${provider.id}-authorize` ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {providerLabel} Hesabı Ekle
                    </button>
                    <button type="button" onClick={() => setEditingCalendarProvider((current) => ({ ...current, [provider.id]: true }))} disabled={calendarBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: calendarBusy ? 'not-allowed' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                      OAuth Ayarını Değiştir
                    </button>
                    {provider.accountCount === 0 && (
                      <button type="button" onClick={() => removeCalendarProvider(provider)} disabled={calendarBusy} style={{ ...SECONDARY_BUTTON_STYLE, color: '#aaa', cursor: calendarBusy ? 'not-allowed' : 'pointer', opacity: calendarBusy ? 0.5 : 1 }}>
                        Ayarı Kaldır
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

      <section style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '46px', height: '38px', borderRadius: '10px', background: '#111', border: '1px solid rgba(255,255,255,0.13)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Bot size={23} color="#fff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Codex</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                Kendi Codex hesabınızla Linux sunucusunun tamamında çalışır.
              </div>
            </div>
          </div>
          <Status connected={codexConnected} idleLabel={codexInstalled ? 'Hesap bağlı değil' : 'Kurulu değil'} />
        </div>

        {!codexInstalled && (
          <>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              Codex CLI sunucuya isteğe bağlı olarak kurulur. Temel FoxOS kurulumu için gerekli değildir ve kurulum kendiliğinden hesap veya ücretli hizmet oluşturmaz.
            </div>
            <button type="button" onClick={installCodex} disabled={codexBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>
              {saving === 'codex-install' ? <Loader2 size={15} className="spin" /> : <HardDrive size={15} />} Sunucuya Kur
            </button>
          </>
        )}

        {codexInstalled && !codexConnected && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>CLI sürümü</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{codex.version || 'Bilinmiyor'}</div>
              <div style={{ color: '#888' }}>Erişim</div>
              <div>Hesap bağlanana kadar kapalı</div>
              <div style={{ color: '#888' }}>Kimlik bilgileri</div>
              <div>Codex tarafından yönetilir; FoxOS API yanıtına girmez</div>
            </div>
            {!codexLogin ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                <button type="button" onClick={startCodexLogin} disabled={codexBusy || !codex.runtimeReady} style={{ ...PRIMARY_BUTTON_STYLE, cursor: codexBusy || !codex.runtimeReady ? 'not-allowed' : 'pointer', opacity: codexBusy || !codex.runtimeReady ? 0.5 : 1 }}>
                  {saving === 'codex-login' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} ChatGPT ile Bağla
                </button>
                <button type="button" onClick={installCodex} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>
                  <RefreshCw size={15} /> CLI’ı Güncelle
                </button>
              </div>
            ) : (
              <div style={{ padding: '13px', borderRadius: '10px', border: '1px solid rgba(14,165,233,0.3)', background: 'rgba(14,165,233,0.08)' }}>
                <div style={{ color: '#aaa', fontSize: '12px', marginBottom: '8px' }}>OpenAI doğrulama kodu</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
                  <code style={{ color: '#fff', background: 'rgba(0,0,0,0.3)', borderRadius: '7px', padding: '8px 11px', fontSize: '15px', letterSpacing: '0.08em' }}>{codexLogin.userCode}</code>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(codexLogin.userCode)} style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}><Copy size={14} /> Kopyala</button>
                  <a href={codexLogin.verificationUrl} target="_blank" rel="noreferrer" style={{ ...PRIMARY_BUTTON_STYLE, textDecoration: 'none' }}>OpenAI’da Doğrula <ExternalLink size={14} /></a>
                  <button type="button" onClick={cancelCodexLogin} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>Vazgeç</button>
                </div>
              </div>
            )}
          </>
        )}

        {codexConnected && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>Hesap</div>
              <div>{codex.email || 'ChatGPT hesabı'}</div>
              <div style={{ color: '#888' }}>Plan</div>
              <div>{codex.planType || 'Hesap tarafından belirleniyor'}</div>
              <div style={{ color: '#888' }}>CLI sürümü</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{codex.version || 'Bilinmiyor'}</div>
              <div style={{ color: '#888' }}>Erişim profili</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: codex.fullServer ? '#f6c453' : '#aaa' }}>
                {codex.fullServer ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
                {codex.fullServer ? 'Full Server — root eşdeğeri' : 'Salt-okunur'}
              </div>
              <div style={{ color: '#888' }}>Çalışma dizini</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>/</div>
              <div style={{ color: '#888' }}>Drive hafızası</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: codex.memoryEnabled ? '#75da85' : '#aaa' }}>
                <HardDrive size={14} />
                {codex.memoryConfigured
                  ? codex.memoryEnabled
                    ? `${codex.memoryLabel || 'Drive hafızası'} — otomatik`
                    : 'Yapılandırıldı — kapalı'
                  : 'Yapılandırılmadı'}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {codex.fullServer ? (
                <>
                  <button type="button" onClick={openCodex} disabled={codexBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}><Play size={15} /> Codex’i Aç</button>
                  <button type="button" onClick={setCodexReadOnly} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>Salt-okunura Al</button>
                </>
              ) : (
                <button type="button" onClick={enableFullServer} disabled={codexBusy} style={{ ...PRIMARY_BUTTON_STYLE, background: '#b7791f', cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>
                  {saving === 'codex-profile' ? <Loader2 size={15} className="spin" /> : <ShieldAlert size={15} />} Full Server’ı Etkinleştir
                </button>
              )}
              <button type="button" onClick={() => loadConnections()} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'wait' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}><RefreshCw size={15} /> Kontrol Et</button>
              <button type="button" onClick={disconnectCodex} disabled={codexBusy} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: codexBusy ? 'not-allowed' : 'pointer', opacity: codexBusy ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><Unplug size={15} /> Bağlantıyı Kes</button>
            </div>

            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.09)' }}>
              {!codex.memoryConfigured || editingCodexMemory ? (
                <form onSubmit={configureCodexMemory}>
                  <div style={{ color: '#aaa', fontSize: '12px', lineHeight: 1.5, marginBottom: '10px' }}>
                    Özel Drive klasörünü bu sunucuya bağlayın. Adres yalnız sunucuda saklanır; API yanıtlarında ve Git deposunda yer almaz.
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                    <input
                      type="url"
                      value={codexMemoryFolderUrl}
                      onChange={(event) => { setCodexMemoryFolderUrl(event.target.value); setMessage('codex', null); }}
                      disabled={codexBusy}
                      placeholder="Google Drive klasör bağlantısı"
                      autoComplete="off"
                      spellCheck={false}
                      style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}
                    />
                    <button type="submit" disabled={codexBusy || !codexMemoryFolderUrl.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: codexBusy || !codexMemoryFolderUrl.trim() ? 'not-allowed' : 'pointer', opacity: codexBusy || !codexMemoryFolderUrl.trim() ? 0.5 : 1 }}>
                      {saving === 'codex-memory' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} Hafızayı Bağla
                    </button>
                    {codex.memoryConfigured && (
                      <button type="button" onClick={() => { setEditingCodexMemory(false); setCodexMemoryFolderUrl(''); setMessage('codex', null); }} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'not-allowed' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>Vazgeç</button>
                    )}
                  </div>
                </form>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
                  <div style={{ flex: '1 1 260px', color: '#aaa', fontSize: '12px', lineHeight: 1.5 }}>
                    {codex.memoryEnabled
                      ? 'Yeni ve yeniden açılan konuşmalar önce Drive hafızasını yükler.'
                      : 'Klasör kaydı bu sunucuda duruyor; otomatik yükleme kapalı.'}
                  </div>
                  <button type="button" onClick={() => updateCodexMemory({ enabled: !codex.memoryEnabled })} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'not-allowed' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}>
                    {saving === 'codex-memory' && <Loader2 size={15} className="spin" />} {codex.memoryEnabled ? 'Hafızayı Kapat' : 'Hafızayı Aç'}
                  </button>
                  <button type="button" onClick={() => { setEditingCodexMemory(true); setMessage('codex', null); }} disabled={codexBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: codexBusy ? 'not-allowed' : 'pointer', opacity: codexBusy ? 0.5 : 1 }}><Link2 size={15} /> Klasörü Değiştir</button>
                </div>
              )}
            </div>
          </>
        )}

        <Message value={messages.codex} />
      </section>

      <section style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '46px', height: '38px', borderRadius: '10px', background: 'linear-gradient(135deg, #0f172a 0%, #2563eb 45%, #a855f7 100%)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Sparkles size={22} color="#fff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Antigravity CLI</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                Google’ın resmî <strong style={{ color: '#aaa' }}>agy</strong> aracını kendi Google hesabınızla sunucuya bağlar.
              </div>
            </div>
          </div>
          <Status connected={antigravityConnected} idleLabel={antigravityInstalled ? 'Google hesabı bağlı değil' : 'Kurulu değil'} />
        </div>

        {!antigravityInstalled && (
          <>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              Antigravity, Gemini CLI’dan ayrı bir araçtır. Resmî Google kurucusu yalnız bu bağlantıya ayrılmış dizine kurulur; kurulum isteğe bağlıdır ve temel FoxOS çalışmasını etkilemez.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
              <button type="button" onClick={installAntigravity} disabled={antigravityBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>
                {saving === 'antigravity-install' ? <Loader2 size={15} className="spin" /> : <HardDrive size={15} />} Sunucuya Kur
              </button>
              <a href="https://antigravity.google/docs/cli/install" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', textDecoration: 'none' }}>Resmî kurulum belgesi <ExternalLink size={13} /></a>
            </div>
          </>
        )}

        {antigravityInstalled && !antigravityConnected && !antigravityLogin && (
          <>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              Giriş, uzak sunucuya uygun Google OAuth akışını kullanır. FoxOS’ta parola, token veya tarayıcı oturumu saklanmaz; hesabın kalıcılığı CLI tarafından yönetilir.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button type="button" onClick={startAntigravityLogin} disabled={antigravityBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>
                {saving === 'antigravity-login' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} Google Hesabını Bağla
              </button>
              <button type="button" onClick={installAntigravity} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}><RefreshCw size={15} /> CLI’yi Güncelle</button>
            </div>
          </>
        )}

        {antigravityInstalled && !antigravityConnected && antigravityLogin && (
          <form onSubmit={completeAntigravityLogin}>
            <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.24)', marginBottom: '12px' }}>
              <div style={{ color: '#ddd', fontSize: '13px', lineHeight: 1.55, marginBottom: '10px' }}>
                1. Aşağıdaki gerçek bağlantıyı açın. 2. Google hesabınızla onaylayın. 3. Tarayıcıda gösterilen kodu buraya yapıştırın.
              </div>
              <a href={antigravityLogin.verificationUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', color: '#7dd3fc', fontSize: '13px', fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: '3px' }}>
                Google’da Doğrula <ExternalLink size={14} />
              </a>
              <div style={{ color: '#888', fontSize: '11px', marginTop: '8px' }}>
                Bağlantı yaklaşık 60 saniye geçerlidir{antigravityLogin.expiresAt ? ` · Bitiş: ${new Date(antigravityLogin.expiresAt).toLocaleTimeString('tr-TR')}` : ''}.
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <input
                type="text"
                value={antigravityCode}
                onChange={(event) => { setAntigravityCode(event.target.value); setMessage('antigravity', null); }}
                disabled={antigravityBusy}
                placeholder="Google doğrulama kodu"
                autoComplete="one-time-code"
                spellCheck={false}
                style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              />
              <button type="submit" disabled={antigravityBusy || !antigravityCode.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: antigravityBusy || !antigravityCode.trim() ? 'not-allowed' : 'pointer', opacity: antigravityBusy || !antigravityCode.trim() ? 0.5 : 1 }}>
                {saving === 'antigravity-login-complete' ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} Kodu Doğrula
              </button>
              <button type="button" onClick={cancelAntigravityLogin} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'not-allowed' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>İptal Et</button>
            </div>
          </form>
        )}

        {antigravityConnected && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>CLI sürümü</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{antigravity.version || 'Bilinmiyor'}</div>
              <div style={{ color: '#888' }}>Kimlik doğrulama</div>
              <div>Google OAuth · Antigravity tarafından yönetiliyor</div>
              <div style={{ color: '#888' }}>Erişim profili</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: antigravity.fullServer ? '#f6c453' : '#75da85', fontWeight: 700 }}>
                {antigravity.fullServer ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
                {antigravity.fullServer ? 'Full Server — onay sormaz' : 'Salt-okunur — plan + strict'}
              </div>
              <div style={{ color: '#888' }}>Çalışma alanı</div>
              <div>{antigravity.fullServer ? 'Sunucu kökü / · workspace dışı erişim açık' : 'Workspace sınırı · terminal sandboxı açık'}</div>
              <div style={{ color: '#888' }}>Komut ve dosya onayı</div>
              <div>{antigravity.fullServer ? 'Yok · always-proceed' : 'Sıkı izin · strict'}</div>
              <div style={{ color: '#888' }}>Son doğrulama</div>
              <div>{antigravity.lastVerifiedAt ? new Date(antigravity.lastVerifiedAt).toLocaleString('tr-TR') : 'Henüz yok'}</div>
            </div>

            {!antigravity.profileApplied && (
              <div style={{ color: '#f6c453', fontSize: '12px', lineHeight: 1.5, marginBottom: '12px' }}>
                Kalıcı ayar dosyası seçili profille eşleşmiyor. Profili yeniden seçmeden CLI’yi çalıştırmayın.
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {antigravity.fullServer ? (
                <button type="button" onClick={setAntigravityReadOnly} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}><ShieldCheck size={15} /> Salt-okunura Al</button>
              ) : (
                <button type="button" onClick={enableAntigravityFullServer} disabled={antigravityBusy} style={{ ...PRIMARY_BUTTON_STYLE, background: '#b7791f', cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>
                  {saving === 'antigravity-profile' ? <Loader2 size={15} className="spin" /> : <ShieldAlert size={15} />} Full Server’ı Etkinleştir
                </button>
              )}
              <button type="button" onClick={verifyAntigravity} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}>{saving === 'antigravity-verify' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Bağlantıyı Kontrol Et</button>
              <button type="button" onClick={installAntigravity} disabled={antigravityBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: antigravityBusy ? 'wait' : 'pointer', opacity: antigravityBusy ? 0.5 : 1 }}><RefreshCw size={15} /> CLI’yi Güncelle</button>
              <button type="button" onClick={disconnectAntigravity} disabled={antigravityBusy} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: antigravityBusy ? 'not-allowed' : 'pointer', opacity: antigravityBusy ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><Unplug size={15} /> Bağlantıyı Kes</button>
            </div>
          </>
        )}

        <Message value={messages.antigravity} />
      </section>

      <section style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '46px', height: '38px', borderRadius: '10px', background: 'linear-gradient(135deg, #4285f4 0%, #9b72cb 52%, #d96570 100%)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Sparkles size={22} color="#fff" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Gemini CLI</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                Google’ın resmî CLI’sini Gemini API anahtarınızla FoxOS’a bağlar.
              </div>
            </div>
          </div>
          <Status connected={geminiConnected} idleLabel={geminiInstalled ? 'API anahtarı bağlı değil' : 'Kurulu değil'} />
        </div>

        {!geminiInstalled && (
          <>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              Resmî kararlı paket yalnız bu bağlantı için ayrılmış sunucu dizinine kurulur. Kurulum isteğe bağlıdır; hesap, API anahtarı veya ücretli hizmet oluşturmaz ve temel FoxOS çalışmasını etkilemez.
            </div>
            <button type="button" onClick={installGemini} disabled={geminiBusy} style={{ ...PRIMARY_BUTTON_STYLE, cursor: geminiBusy ? 'wait' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}>
              {saving === 'gemini-install' ? <Loader2 size={15} className="spin" /> : <HardDrive size={15} />} Sunucuya Kur
            </button>
          </>
        )}

        {geminiConnected && !editingGemini && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>CLI sürümü</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{gemini.version || 'Bilinmiyor'}</div>
              <div style={{ color: '#888' }}>Kimlik doğrulama</div>
              <div>Gemini API anahtarı</div>
              <div style={{ color: '#888' }}>API anahtarı</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}><ShieldCheck size={14} color="#75da85" /> Sunucuda şifreli saklanıyor</div>
              <div style={{ color: '#888' }}>Son doğrulama</div>
              <div>{gemini.lastVerifiedAt ? new Date(gemini.lastVerifiedAt).toLocaleString('tr-TR') : 'Henüz yok'}</div>
              <div style={{ color: '#888' }}>Sunucu erişimi</div>
              <div>Bağlantı tek başına komut çalıştırma yetkisi vermez</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button type="button" onClick={verifyGemini} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'wait' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}>{saving === 'gemini-verify' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Bağlantıyı Kontrol Et</button>
              <button type="button" onClick={installGemini} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'wait' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}><RefreshCw size={15} /> CLI’yi Güncelle</button>
              <button type="button" onClick={() => { setEditingGemini(true); setMessage('gemini', null); }} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'not-allowed' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}><Link2 size={15} /> API Anahtarını Değiştir</button>
              <button type="button" onClick={disconnectGemini} disabled={geminiBusy} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: geminiBusy ? 'not-allowed' : 'pointer', opacity: geminiBusy ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><Unplug size={15} /> Bağlantıyı Kes</button>
            </div>
          </>
        )}

        {showGeminiForm && (
          <form onSubmit={connectGemini}>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '10px' }}>
              Başsız Linux sunucularında Gemini CLI, API anahtarı veya Vertex AI ister. FoxOS bu ilk sürümde Gemini API anahtarını destekler ve bağlarken küçük, salt-okunur bir CLI isteğiyle doğrular.
            </div>
            <div style={{ color: '#f6c453', fontSize: '12px', lineHeight: 1.5, marginBottom: '10px' }}>
              Bireysel Google AI Pro, Ultra ve ücretsiz hesapların eski Gemini CLI girişi 18 Haziran 2026’da sona erdi. API kullanımı Google hesabınızdaki kota ve ücretlendirmeye tabidir.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginBottom: '12px' }}>
              <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', textDecoration: 'none' }}>Google AI Studio’da API anahtarı aç <ExternalLink size={13} /></a>
              <a href="https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#aaa', fontSize: '12px', textDecoration: 'none' }}>Google’ın geçiş duyurusu <ExternalLink size={13} /></a>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <input
                type="password"
                value={geminiApiKey}
                onChange={(event) => { setGeminiApiKey(event.target.value); setMessage('gemini', null); }}
                disabled={geminiBusy}
                placeholder="Gemini API anahtarı"
                autoComplete="new-password"
                spellCheck={false}
                style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}
              />
              <button type="submit" disabled={geminiBusy || !geminiApiKey.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: geminiBusy || !geminiApiKey.trim() ? 'not-allowed' : 'pointer', opacity: geminiBusy || !geminiApiKey.trim() ? 0.5 : 1 }}>
                {saving === 'gemini-connect' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {geminiConnected ? 'Yeni Anahtarı Bağla' : 'Bağla'}
              </button>
              <button type="button" onClick={installGemini} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'wait' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}><RefreshCw size={15} /> CLI’yi Güncelle</button>
              {geminiConnected && <button type="button" onClick={() => { setEditingGemini(false); setGeminiApiKey(''); setMessage('gemini', null); }} disabled={geminiBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: geminiBusy ? 'not-allowed' : 'pointer', opacity: geminiBusy ? 0.5 : 1 }}>Vazgeç</button>}
            </div>
          </form>
        )}

        <Message value={messages.gemini} />
      </section>

      <section style={CARD_STYLE}>
        <div className="connection-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '88px', height: '38px', padding: '0 7px', boxSizing: 'border-box', borderRadius: '10px', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <img src={cloudflareLogo} alt="Cloudflare" style={{ display: 'block', width: '74px', height: 'auto' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Cloudflare</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>Erişim linkleri için DNS kayıtlarını sunucu adına yönetir.</div>
            </div>
          </div>
          <Status connected={cloudflareConnected} />
        </div>

        {cloudflareConnected && !editingCloudflare && (
          <>
            <div className="connections-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>DNS bölgeleri</div>
              <div>{cloudflare.zones.join(', ')}</div>
              <div style={{ color: '#888' }}>Sunucu IPv4</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{cloudflare.publicIpv4}</div>
              <div style={{ color: '#888' }}>Gerekli yetkiler</div>
              <div>{cloudflare.permissions.join(', ')}</div>
              <div style={{ color: '#888' }}>Token</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}><ShieldCheck size={14} color="#75da85" /> Sunucuda şifreli saklanıyor</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button type="button" onClick={verifyCloudflare} disabled={cloudflareBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: cloudflareBusy ? 'wait' : 'pointer', opacity: cloudflareBusy ? 0.5 : 1 }}>{saving === 'cloudflare-verify' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Bağlantıyı Kontrol Et</button>
              <button type="button" onClick={() => { setEditingCloudflare(true); setMessage('cloudflare', null); }} disabled={cloudflareBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: cloudflareBusy ? 'not-allowed' : 'pointer', opacity: cloudflareBusy ? 0.5 : 1 }}><Link2 size={15} /> Tokenı Değiştir</button>
              <button type="button" onClick={disconnectCloudflare} disabled={cloudflareBusy} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: cloudflareBusy ? 'not-allowed' : 'pointer', opacity: cloudflareBusy ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}><Unplug size={15} /> Bağlantıyı Kes</button>
            </div>
          </>
        )}

        {showCloudflareForm && (
          <form onSubmit={connectCloudflare}>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              Token yalnız <strong>Zone Read</strong> ve <strong>DNS Edit</strong> izinlerine sahip olmalı. FoxOS tokenı hiçbir API yanıtında geri göstermez.
            </div>
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', marginBottom: '12px', textDecoration: 'none' }}>Cloudflare API Token sayfasını aç <ExternalLink size={13} /></a>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <input type="password" value={apiToken} onChange={(event) => { setApiToken(event.target.value); setMessage('cloudflare', null); }} disabled={cloudflareBusy} placeholder="Cloudflare API Token" autoComplete="new-password" spellCheck={false} style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }} />
              <button type="submit" disabled={cloudflareBusy || !apiToken.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: cloudflareBusy || !apiToken.trim() ? 'not-allowed' : 'pointer', opacity: cloudflareBusy || !apiToken.trim() ? 0.5 : 1 }}>{saving === 'cloudflare-connect' ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {cloudflareConnected ? 'Yeni Tokenı Bağla' : 'Bağla'}</button>
              {cloudflareConnected && <button type="button" onClick={() => { setEditingCloudflare(false); setApiToken(''); setMessage('cloudflare', null); }} disabled={cloudflareBusy} style={{ ...SECONDARY_BUTTON_STYLE, cursor: cloudflareBusy ? 'not-allowed' : 'pointer', opacity: cloudflareBusy ? 0.5 : 1 }}>Vazgeç</button>}
            </div>
          </form>
        )}

        <Message value={messages.cloudflare} />
      </section>
    </div>
  );
};

export default ConnectionsSettings;
