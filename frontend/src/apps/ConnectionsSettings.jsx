import React, { useEffect, useState } from 'react';
import {
  Cloud,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug
} from 'lucide-react';
import { apiFetch } from '../api';
import { useDialog } from '../contexts/DialogContext';

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

const ConnectionsSettings = () => {
  const { showDialog } = useDialog();
  const [connection, setConnection] = useState(null);
  const [apiToken, setApiToken] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const loadConnections = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await apiFetch('/api/connections');
      const payload = await response.json();
      setConnection((payload.connections || []).find((item) => item.id === 'cloudflare') || null);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConnections();
  }, []);

  const connectCloudflare = async (event) => {
    event.preventDefault();
    if (!apiToken.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await apiFetch('/api/connections/cloudflare', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: apiToken.trim() })
      });
      const payload = await response.json();
      setConnection(payload.connection);
      setApiToken('');
      setEditing(false);
      setMessage({
        type: 'success',
        text: 'Cloudflare bağlandı. Erişim linklerinde gerekli DNS kayıtları artık onaylanan işlemle otomatik yönetilecek.'
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const verifyCloudflare = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await apiFetch('/api/connections/cloudflare/verify', { method: 'POST' });
      const payload = await response.json();
      setConnection(payload.connection);
      setMessage({ type: 'success', text: 'Cloudflare tokenı, DNS bölgeleri ve sunucu IPv4 adresi yeniden doğrulandı.' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
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
        setSaving(true);
        setMessage(null);
        try {
          const response = await apiFetch('/api/connections/cloudflare', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'DISCONNECT CLOUDFLARE' })
          });
          const payload = await response.json();
          setConnection(payload.connection);
          setEditing(false);
          setApiToken('');
          setMessage({ type: 'success', text: 'Cloudflare bağlantısı kesildi. Mevcut DNS kayıtları korundu.' });
        } catch (error) {
          setMessage({ type: 'error', text: error.message });
        } finally {
          setSaving(false);
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

  const connected = Boolean(connection && connection.connected);
  const showForm = !connected || editing;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
        Sunucunun kullanacağı dış hesapları buradan bağlayın. Bağlantılar isteğe bağlıdır; FoxOS bağlı hesap olmadan da çalışır. Gelecekte diğer sağlayıcılar da bu bölümde yer alacak.
      </div>

      <section style={CARD_STYLE}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Cloud size={21} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#fff' }}>Cloudflare</h3>
              <div style={{ marginTop: '4px', color: '#888', fontSize: '12px', lineHeight: 1.4 }}>
                Erişim linkleri için DNS kayıtlarını sunucu adına yönetir.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: connected ? '#75da85' : '#888', fontSize: '12px', whiteSpace: 'nowrap' }}>
            <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: connected ? '#27c93f' : '#111', border: connected ? 'none' : '1px solid rgba(255,255,255,0.2)' }} />
            {connected ? 'Bağlı' : 'Bağlı değil'}
          </div>
        </div>

        {connected && !editing && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px', wordBreak: 'break-word' }}>
              <div style={{ color: '#888' }}>DNS bölgeleri</div>
              <div>{connection.zones.join(', ')}</div>
              <div style={{ color: '#888' }}>Sunucu IPv4</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>{connection.publicIpv4}</div>
              <div style={{ color: '#888' }}>Gerekli yetkiler</div>
              <div>{connection.permissions.join(', ')}</div>
              <div style={{ color: '#888' }}>Token</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}><ShieldCheck size={14} color="#75da85" /> Sunucuda şifreli saklanıyor</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button type="button" onClick={verifyCloudflare} disabled={saving} style={{ ...SECONDARY_BUTTON_STYLE, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.5 : 1 }}>
                {saving ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Bağlantıyı Kontrol Et
              </button>
              <button type="button" onClick={() => { setEditing(true); setMessage(null); }} disabled={saving} style={{ ...SECONDARY_BUTTON_STYLE, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.5 : 1 }}>
                <Link2 size={15} /> Tokenı Değiştir
              </button>
              <button type="button" onClick={disconnectCloudflare} disabled={saving} style={{ background: 'transparent', color: '#aaa', border: '1px solid rgba(255,255,255,0.12)', padding: '9px 14px', borderRadius: '8px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
                <Unplug size={15} /> Bağlantıyı Kes
              </button>
            </div>
          </>
        )}

        {showForm && (
          <form onSubmit={connectCloudflare}>
            <div style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.5, marginBottom: '12px' }}>
              Token yalnız <strong>Zone Read</strong> ve <strong>DNS Edit</strong> izinlerine sahip olmalı. FoxOS tokenı hiçbir API yanıtında geri göstermez.
            </div>
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#7dd3fc', fontSize: '12px', marginBottom: '12px', textDecoration: 'none' }}>
              Cloudflare API Token sayfasını aç <ExternalLink size={13} />
            </a>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <input
                type="password"
                value={apiToken}
                onChange={(event) => { setApiToken(event.target.value); setMessage(null); }}
                disabled={saving}
                placeholder="Cloudflare API Token"
                autoComplete="new-password"
                spellCheck={false}
                style={{ flex: '1 1 300px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}
              />
              <button type="submit" disabled={saving || !apiToken.trim()} style={{ ...PRIMARY_BUTTON_STYLE, cursor: saving || !apiToken.trim() ? 'not-allowed' : 'pointer', opacity: saving || !apiToken.trim() ? 0.5 : 1 }}>
                {saving ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />} {connected ? 'Yeni Tokenı Bağla' : 'Bağla'}
              </button>
              {connected && (
                <button type="button" onClick={() => { setEditing(false); setApiToken(''); setMessage(null); }} disabled={saving} style={{ ...SECONDARY_BUTTON_STYLE, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.5 : 1 }}>
                  Vazgeç
                </button>
              )}
            </div>
          </form>
        )}

        {message && (
          <div aria-live="polite" style={{ marginTop: '14px', padding: '10px 12px', borderRadius: '8px', background: message.type === 'error' ? 'rgba(255,95,86,0.12)' : 'rgba(39,201,63,0.12)', border: `1px solid ${message.type === 'error' ? 'rgba(255,95,86,0.35)' : 'rgba(39,201,63,0.35)'}`, color: message.type === 'error' ? '#ff8a84' : '#75da85', fontSize: '13px', lineHeight: 1.5 }}>
            {message.text}
          </div>
        )}
      </section>
    </div>
  );
};

export default ConnectionsSettings;
