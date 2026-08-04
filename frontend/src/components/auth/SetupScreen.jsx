import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { ChevronRight, Loader2 } from 'lucide-react';
import foxWallpaper from '../../assets/fox-wallpaper.jpg';

const CustomFoxIcon = ({ size = 16, color = "currentColor" }) => (
  <svg height={size} viewBox="0 0 100 100" width={size} xmlns="http://www.w3.org/2000/svg" fill={color} style={{ filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))', marginBottom: '20px' }}>
    <path d="m80 16.667s-1.501 0-3.333 0c-1.833 0-4.58 1.871-6.107 4.16l-8.336 12.506h-24.444l-8.34-12.506c-1.523-2.289-4.274-4.16-6.107-4.16-1.832 0-3.333 0-3.333 0l-10 49.596c12.666 0 25.335 4.994 35 15 2.761 2.761 7.239 2.761 10 0 8.991-9.189 21.364-14.922 35-15zm-38.333 40.937v-.004c-5.209 2.031-11.172-.299-13.33-5.198h-.004v-.007s.004.004.004.007c5.205-2.031 11.168.293 13.33 5.198zm12.75 10.814-2.998 2.998c-.781.781-2.044.781-2.825 0l-3.005-2.998c-.361-.368-.586-.862-.586-1.416 0-1.104.896-2.002 2.002-2.002h6.003c1.106 0 1.995.898 1.995 2.002 0 .554-.221 1.048-.586 1.416zm17.25-16.016h-.004c-2.158 4.899-8.118 7.229-13.33 5.198v.004-.004c2.162-4.905 8.125-7.229 13.33-5.198 0-.003.004-.003.004-.003z"></path>
  </svg>
);

const SetupScreen = () => {
  const { setup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSetup = async (e) => {
    e.preventDefault();
    if (!username || password.length < 10) {
      setError('Bir kullanıcı adı ve en az 10 karakterli bir şifre girin.');
      return;
    }
    setLoading(true);
    setError(null);
    const result = await setup(username, password);
    if (!result.success) {
      setError(result.error || 'Kurulum sırasında bir hata oluştu.');
      setLoading(false);
    }
  };

  return (
    <div style={{
      width: '100vw', height: '100vh',
      backgroundImage: `url(${foxWallpaper})`,
      backgroundSize: 'cover', backgroundPosition: 'center',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff',
      position: 'relative'
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(20px)'
      }} />
      
      <div style={{
        position: 'relative', zIndex: 1,
        background: 'rgba(255, 255, 255, 0.05)',
        backdropFilter: 'blur(30px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '24px', padding: '40px',
        width: '400px', maxWidth: '90%',
        textAlign: 'center',
        boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
      }}>
        <CustomFoxIcon size={80} color="#fff" />
        <h1 style={{ margin: '0 0 10px 0', fontSize: '24px', fontWeight: '600' }}>FoxOS'e Hoş Geldiniz</h1>
        <p style={{ margin: '0 0 30px 0', fontSize: '14px', color: '#ccc' }}>Lütfen başlangıç için bir hesap oluşturun.</p>

        <form onSubmit={handleSetup} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <input
            type="text"
            placeholder="Kullanıcı Adı"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{
              background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)',
              padding: '14px 16px', borderRadius: '12px', color: '#fff', fontSize: '14px',
              outline: 'none', transition: 'border-color 0.2s'
            }}
            onFocus={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.4)'}
            onBlur={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
          />
          <input
            type="password"
            placeholder="Şifre (en az 10 karakter)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)',
              padding: '14px 16px', borderRadius: '12px', color: '#fff', fontSize: '14px',
              outline: 'none', transition: 'border-color 0.2s'
            }}
            onFocus={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.4)'}
            onBlur={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
          />

          {error && <div style={{ color: '#ff5f56', fontSize: '13px', textAlign: 'left' }}>{error}</div>}

          <button
            type="submit"
            disabled={loading}
            style={{
              background: '#fff', color: '#000', border: 'none',
              padding: '14px', borderRadius: '12px', fontSize: '15px', fontWeight: 'bold',
              cursor: loading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              marginTop: '10px', opacity: loading ? 0.7 : 1
            }}
          >
            {loading ? <Loader2 size={18} className="spin" /> : 'Kurulumu Tamamla'}
            {!loading && <ChevronRight size={18} />}
          </button>
        </form>
      </div>
    </div>
  );
};

export default SetupScreen;
