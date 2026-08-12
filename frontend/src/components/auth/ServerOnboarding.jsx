import React, { useCallback, useState } from 'react';
import { CheckCircle2, Clock3, Loader2, Server } from 'lucide-react';
import MigrationSettings from '../../apps/MigrationSettings';
import foxWallpaper from '../../assets/fox-wallpaper.jpg';
import { useAuth } from '../../contexts/AuthContext';

const BUTTON_STYLE = {
  borderRadius: '10px',
  padding: '10px 14px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '7px',
  fontSize: '13px',
  fontWeight: 'bold'
};

const ServerOnboarding = () => {
  const { completeOnboarding } = useAuth();
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
      setError(result.error || 'İlk kurulum tamamlanamadı.');
      setFinishing(false);
    }
  };

  return (
    <div
      className="auth-screen onboarding-screen"
      style={{
        width: '100vw',
        height: '100vh',
        padding: '28px',
        backgroundImage: `url(${foxWallpaper})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative'
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(20px)' }} />
      <div
        className="onboarding-card"
        style={{
          position: 'relative',
          zIndex: 1,
          width: 'min(1040px, 100%)',
          height: 'min(860px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'rgba(20,20,24,0.9)',
          backdropFilter: 'blur(30px)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '22px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.52)'
        }}
      >
        <header className="onboarding-header" style={{ padding: '26px 30px 22px', borderBottom: '1px solid rgba(255,255,255,0.09)', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '13px', background: 'rgba(14,165,233,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
            <Server size={22} color="#38bdf8" />
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: '0 0 5px', fontSize: '22px' }}>Sunucunu Hazırla</h1>
            <p style={{ margin: 0, color: '#a1a1aa', fontSize: '13px', lineHeight: 1.5 }}>
              FoxOS önce mevcut kaynakları salt okunur tarar. Uygun uygulamaları şimdi seçip geçirebilir veya bu adımı daha sonra Ayarlar’dan sürdürebilirsin.
            </p>
          </div>
        </header>

        <main data-settings-content style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '26px 30px' }}>
          <MigrationSettings autoScan onScanComplete={handleScanComplete} />
        </main>

        <footer className="onboarding-footer" style={{ padding: '18px 30px', borderTop: '1px solid rgba(255,255,255,0.09)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '18px' }}>
          <div style={{ minWidth: 0, color: error ? '#ff8a84' : '#a1a1aa', fontSize: '12px', lineHeight: 1.45 }}>
            {error || (scanState === 'complete'
              ? 'Tarama tamamlandı. Seçim yapmadan da masaüstüne geçebilirsin.'
              : scanState === 'failed'
                ? 'Tarama tamamlanamadı. Yeniden deneyebilir veya bu adımı erteleyebilirsin.'
                : 'İlk sunucu taraması hazırlanıyor…')}
          </div>
          <div className="onboarding-actions" style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '0 0 auto' }}>
            <button
              type="button"
              onClick={() => finish('deferred')}
              disabled={finishing}
              style={{ ...BUTTON_STYLE, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.07)', color: '#fff', cursor: finishing ? 'wait' : 'pointer', opacity: finishing ? 0.6 : 1 }}
            >
              <Clock3 size={15} /> Şimdilik Geçirme
            </button>
            <button
              type="button"
              onClick={() => finish('reviewed')}
              disabled={finishing || scanState !== 'complete'}
              style={{ ...BUTTON_STYLE, border: 'none', background: '#0ea5e9', color: '#fff', cursor: finishing || scanState !== 'complete' ? 'not-allowed' : 'pointer', opacity: finishing || scanState !== 'complete' ? 0.5 : 1 }}
            >
              {finishing ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
              Masaüstüne Geç
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default ServerOnboarding;
