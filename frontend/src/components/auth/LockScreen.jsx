import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import { ArrowLeft, ArrowRight, Fingerprint, KeyRound, Loader2 } from 'lucide-react';
import { appearanceBackground, useAppearance } from '../../utils/appearance';

const CustomFoxIcon = ({ size = 16, color = "currentColor" }) => (
  <svg height={size} viewBox="0 0 100 100" width={size} xmlns="http://www.w3.org/2000/svg" fill={color} style={{ margin: 'auto' }}>
    <path d="m80 16.667s-1.501 0-3.333 0c-1.833 0-4.58 1.871-6.107 4.16l-8.336 12.506h-24.444l-8.34-12.506c-1.523-2.289-4.274-4.16-6.107-4.16-1.832 0-3.333 0-3.333 0l-10 49.596c12.666 0 25.335 4.994 35 15 2.761 2.761 7.239 2.761 10 0 8.991-9.189 21.364-14.922 35-15zm-38.333 40.937v-.004c-5.209 2.031-11.172-.299-13.33-5.198h-.004v-.007s.004.004.004.007c5.205-2.031 11.168.293 13.33 5.198zm12.75 10.814-2.998 2.998c-.781.781-2.044.781-2.825 0l-3.005-2.998c-.361-.368-.586-.862-.586-1.416 0-1.104.896-2.002 2.002-2.002h6.003c1.106 0 1.995.898 1.995 2.002 0 .554-.221 1.048-.586 1.416zm17.25-16.016h-.004c-2.158 4.899-8.118 7.229-13.33 5.198v.004-.004c2.162-4.905 8.125-7.229 13.33-5.198 0-.003.004-.003.004-.003z"></path>
  </svg>
);

const LockScreen = () => {
  const { username, login, loginWithPasskey, passkeyAvailable, recoverPassword, recoveryAvailable } = useAuth();
  const { t } = useI18n();
  const { appearance } = useAppearance();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState('password');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    // Avoid opening the software keyboard before the user asks for it on touch devices.
    if (inputRef.current && !window.matchMedia('(pointer: coarse)').matches) {
      inputRef.current.focus();
    }
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!password) return;
    setLoading('password');
    setError('');
    const result = await login(password);
    if (!result.success) {
      setError(t('auth.wrongPassword'));
      setLoading('');
      setPassword('');
      if (inputRef.current) inputRef.current.focus();
    }
  };

  const handlePasskey = async () => {
    setLoading('passkey');
    setError('');
    const result = await loginWithPasskey();
    if (!result.success) {
      setError(t('auth.passkeyError'));
      setLoading('');
    }
  };

  const handleRecovery = async (event) => {
    event.preventDefault();
    if (!recoveryCode.trim() || newPassword.length < 15) return;
    setLoading('recovery');
    setError('');
    const result = await recoverPassword(recoveryCode, newPassword);
    if (!result.success) {
      setError(t('auth.recoveryError'));
      setLoading('');
    }
  };

  return (
    <div className="auth-screen lock-screen" style={{
      width: '100vw', height: '100vh',
      ...appearanceBackground(appearance, { lockScreen: true }),
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      color: '#fff',
      position: 'relative'
    }}>
      <div className="lock-screen-backdrop" aria-hidden="true" style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.3)',
        backdropFilter: 'blur(30px)', WebkitBackdropFilter: 'blur(30px)'
      }} />
      
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        width: mode === 'recovery' ? '360px' : '300px', maxWidth: '90%', transition: 'width 180ms ease'
      }}>
        {/* User Avatar */}
        <div className="lock-avatar" style={{
          width: '120px', height: '120px', borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)', border: '2px solid rgba(255,255,255,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: '20px', overflow: 'hidden',
          boxShadow: '0 10px 30px rgba(0,0,0,0.3)'
        }}>
          <CustomFoxIcon size={80} color="#fff" />
        </div>
        
        {/* Username */}
        <h2 style={{ margin: '0 0 30px 0', fontSize: '28px', fontWeight: '500', textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>
          {username || t('auth.userFallback')}
        </h2>

        {mode === 'password' ? (
          <>
            {/* Password Form */}
            <form onSubmit={handleLogin} style={{ width: '100%', position: 'relative' }}>
              <input
                ref={inputRef}
                type="password"
                autoComplete="current-password"
                placeholder={t('auth.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{
                  boxSizing: 'border-box', width: '100%',
                  background: 'rgba(255,255,255,0.2)', border: `1px solid ${error ? '#ff5f56' : 'rgba(255,255,255,0.4)'}`,
                  padding: '12px 40px 12px 16px', borderRadius: '20px', color: '#fff', fontSize: '16px',
                  outline: 'none', transition: 'all 0.2s', backdropFilter: 'blur(10px)',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
                }}
                onFocus={(e) => e.target.style.background = 'rgba(255,255,255,0.3)'}
                onBlur={(e) => e.target.style.background = 'rgba(255,255,255,0.2)'}
              />
              <button
                type="submit"
                aria-label={t('auth.passwordPlaceholder')}
                disabled={Boolean(loading) || !password}
                style={{
                  position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', color: '#fff', border: 'none',
                  padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: (loading || !password) ? 'default' : 'pointer',
                  opacity: (loading || !password) ? 0.5 : 1
                }}
              >
                {loading === 'password' ? <Loader2 size={20} className="spin" /> : <ArrowRight size={20} />}
              </button>
            </form>

            {passkeyAvailable && (
              <button
                type="button"
                onClick={handlePasskey}
                disabled={Boolean(loading)}
                style={{
                  width: '100%', minHeight: '40px', marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  border: '1px solid rgba(255,255,255,0.22)', borderRadius: '20px', background: 'rgba(0,0,0,0.16)', color: '#fff',
                  fontSize: '13px', fontWeight: 600, cursor: loading ? 'wait' : 'pointer', backdropFilter: 'blur(10px)'
                }}
              >
                {loading === 'passkey' ? <Loader2 size={17} className="spin" /> : <Fingerprint size={17} />}
                {loading === 'passkey' ? t('auth.passkeyWorking') : t('auth.passkeySignIn')}
              </button>
            )}

            {recoveryAvailable && (
              <button
                type="button"
                onClick={() => { setMode('recovery'); setError(''); }}
                disabled={Boolean(loading)}
                style={{ marginTop: '13px', padding: '5px 8px', border: 0, background: 'transparent', color: 'rgba(255,255,255,0.68)', fontSize: '12px', cursor: 'pointer' }}
              >
                {t('auth.recoveryLink')}
              </button>
            )}
          </>
        ) : (
          <form onSubmit={handleRecovery} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '3px', textAlign: 'left' }}>
              <span style={{ width: '36px', height: '36px', display: 'grid', placeItems: 'center', flex: '0 0 auto', borderRadius: '10px', background: 'rgba(255,255,255,0.12)' }}><KeyRound size={18} /></span>
              <span><strong style={{ display: 'block', fontSize: '14px' }}>{t('auth.recoveryTitle')}</strong><small style={{ display: 'block', marginTop: '3px', color: 'rgba(255,255,255,0.62)', fontSize: '11px', lineHeight: 1.35 }}>{t('auth.recoveryDescription')}</small></span>
            </div>
            <input
              type="text"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              placeholder={t('auth.recoveryCode')}
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              style={{ boxSizing: 'border-box', width: '100%', padding: '11px 13px', border: `1px solid ${error ? '#ff5f56' : 'rgba(255,255,255,0.28)'}`, borderRadius: '12px', background: 'rgba(0,0,0,0.2)', color: '#fff', fontSize: '14px', outline: 'none' }}
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder={t('auth.newPassword')}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              style={{ boxSizing: 'border-box', width: '100%', padding: '11px 13px', border: `1px solid ${error ? '#ff5f56' : 'rgba(255,255,255,0.28)'}`, borderRadius: '12px', background: 'rgba(0,0,0,0.2)', color: '#fff', fontSize: '14px', outline: 'none' }}
            />
            <button
              type="submit"
              disabled={Boolean(loading) || !recoveryCode.trim() || newPassword.length < 15}
              style={{ minHeight: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '12px', background: 'rgba(255,255,255,0.92)', color: '#111', fontSize: '13px', fontWeight: 700, cursor: loading ? 'wait' : 'pointer', opacity: (!recoveryCode.trim() || newPassword.length < 15) ? 0.55 : 1 }}
            >
              {loading === 'recovery' ? <Loader2 size={17} className="spin" /> : <ArrowRight size={17} />}
              {t('auth.recoverAccount')}
            </button>
            <button type="button" onClick={() => { setMode('password'); setError(''); }} style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px', padding: '5px 8px', border: 0, background: 'transparent', color: 'rgba(255,255,255,0.7)', fontSize: '12px', cursor: 'pointer' }}><ArrowLeft size={13} /> {t('auth.backToPassword')}</button>
          </form>
        )}

        {error && (
           <div style={{ color: '#ff5f56', fontSize: '13px', marginTop: '12px', animation: 'shake 0.4s' }}>
             {error}
           </div>
        )}
      </div>
      <style>{`
        @keyframes shake {
          0% { transform: translateX(0); }
          25% { transform: translateX(-5px); }
          50% { transform: translateX(5px); }
          75% { transform: translateX(-5px); }
          100% { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
};

export default LockScreen;
