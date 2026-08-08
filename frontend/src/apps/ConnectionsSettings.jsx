import React, { useEffect, useState } from 'react';
import {
  Bot,
  Copy,
  ExternalLink,
  HardDrive,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
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
  const [codex, setCodex] = useState(null);
  const [codexLogin, setCodexLogin] = useState(null);
  const [apiToken, setApiToken] = useState('');
  const [editingCloudflare, setEditingCloudflare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [messages, setMessages] = useState({ codex: null, cloudflare: null });
  const codexConnected = Boolean(codex && codex.connected);

  const setMessage = (provider, value) => setMessages((current) => ({ ...current, [provider]: value }));

  const loadConnections = async ({ initial = false } = {}) => {
    if (initial) setLoading(true);
    try {
      const response = await apiFetch('/api/connections');
      const payload = await response.json();
      const nextCloudflare = (payload.connections || []).find((item) => item.id === 'cloudflare') || null;
      const nextCodex = (payload.connections || []).find((item) => item.id === 'codex') || null;
      setCloudflare(nextCloudflare);
      setCodex(nextCodex);
      if (nextCodex && nextCodex.connected) {
        setCodexLogin(null);
        setMessage('codex', { type: 'success', text: 'Codex hesabı bağlandı.' });
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

  useEffect(() => {
    if (!codexLogin || codexConnected) return undefined;
    const timer = window.setInterval(() => {
      loadConnections().catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [codexLogin, codexConnected]);

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

  const openCodex = () => openWindow({
    id: 'codex',
    type: 'codex',
    title: 'Codex',
    width: 900,
    height: 650
  });

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
  const cloudflareConnected = Boolean(cloudflare && cloudflare.connected);
  const showCloudflareForm = !cloudflareConnected || editingCloudflare;
  const codexBusy = Boolean(saving && saving.startsWith('codex'));
  const cloudflareBusy = Boolean(saving && saving.startsWith('cloudflare'));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
        Sunucunun kullanacağı dış hesapları buradan bağlayın. Bağlantılar isteğe bağlıdır; FoxOS bağlı hesap olmadan da çalışır.
      </div>

      <section style={CARD_STYLE}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
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
          </>
        )}

        <Message value={messages.codex} />
      </section>

      <section style={CARD_STYLE}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
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
