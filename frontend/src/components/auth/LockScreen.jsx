import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { ArrowRight, Loader2 } from 'lucide-react';
import foxWallpaper from '../../assets/fox-wallpaper.jpg';

const CustomFoxIcon = ({ size = 16, color = "currentColor" }) => (
  <svg height={size} viewBox="0 0 100 100" width={size} xmlns="http://www.w3.org/2000/svg" fill={color} style={{ margin: 'auto' }}>
    <path d="m80 16.667s-1.501 0-3.333 0c-1.833 0-4.58 1.871-6.107 4.16l-8.336 12.506h-24.444l-8.34-12.506c-1.523-2.289-4.274-4.16-6.107-4.16-1.832 0-3.333 0-3.333 0l-10 49.596c12.666 0 25.335 4.994 35 15 2.761 2.761 7.239 2.761 10 0 8.991-9.189 21.364-14.922 35-15zm-38.333 40.937v-.004c-5.209 2.031-11.172-.299-13.33-5.198h-.004v-.007s.004.004.004.007c5.205-2.031 11.168.293 13.33 5.198zm12.75 10.814-2.998 2.998c-.781.781-2.044.781-2.825 0l-3.005-2.998c-.361-.368-.586-.862-.586-1.416 0-1.104.896-2.002 2.002-2.002h6.003c1.106 0 1.995.898 1.995 2.002 0 .554-.221 1.048-.586 1.416zm17.25-16.016h-.004c-2.158 4.899-8.118 7.229-13.33 5.198v.004-.004c2.162-4.905 8.125-7.229 13.33-5.198 0-.003.004-.003.004-.003z"></path>
  </svg>
);

const LockScreen = () => {
  const { username, login } = useAuth();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    // Focus password input on mount
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    setError(false);
    const result = await login(password);
    if (!result.success) {
      setError(true);
      setLoading(false);
      setPassword('');
      if (inputRef.current) inputRef.current.focus();
    }
  };

  return (
    <div style={{
      width: '100vw', height: '100vh',
      backgroundImage: `url(${foxWallpaper})`,
      backgroundSize: 'cover', backgroundPosition: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      color: '#fff',
      position: 'relative'
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(30px)'
      }} />
      
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        width: '300px', maxWidth: '90%'
      }}>
        {/* User Avatar */}
        <div style={{
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
          {username || 'Kullanıcı'}
        </h2>

        {/* Password Form */}
        <form onSubmit={handleLogin} style={{ width: '100%', position: 'relative' }}>
          <input
            ref={inputRef}
            type="password"
            placeholder="Şifre Girin"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(255,255,255,0.2)', border: `1px solid ${error ? '#ff5f56' : 'rgba(255,255,255,0.4)'}`,
              padding: '12px 40px 12px 16px', borderRadius: '20px', color: '#fff', fontSize: '15px',
              outline: 'none', transition: 'all 0.2s', backdropFilter: 'blur(10px)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
            }}
            onFocus={(e) => e.target.style.background = 'rgba(255,255,255,0.3)'}
            onBlur={(e) => e.target.style.background = 'rgba(255,255,255,0.2)'}
          />
          <button
            type="submit"
            disabled={loading || !password}
            style={{
              position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)',
              background: 'transparent', color: '#fff', border: 'none',
              padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: (loading || !password) ? 'default' : 'pointer',
              opacity: (loading || !password) ? 0.5 : 1
            }}
          >
            {loading ? <Loader2 size={20} className="spin" /> : <ArrowRight size={20} />}
          </button>
        </form>

        {error && (
           <div style={{ color: '#ff5f56', fontSize: '13px', marginTop: '12px', animation: 'shake 0.4s' }}>
             Parola yanlış. Tekrar deneyin.
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
