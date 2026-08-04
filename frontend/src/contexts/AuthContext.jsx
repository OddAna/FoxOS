/* oxlint-disable react/only-export-components -- context hook and provider intentionally share a module */
import React, { createContext, useState, useContext, useEffect } from 'react';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [authState, setAuthState] = useState('loading'); // 'loading', 'needs_setup', 'locked', 'authenticated'
  const [username, setUsername] = useState(null);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data.isSetup) {
        setUsername(data.username);
        setAuthState(data.authenticated ? 'authenticated' : 'locked');
      } else {
        setAuthState('needs_setup');
      }
    } catch (err) {
      console.error('Auth check failed:', err);
      setAuthState('locked');
    }
  };

  const setup = async (user, pass) => {
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();
      if (data.success) {
        setUsername(data.username);
        setAuthState('authenticated');
        return { success: true };
      } else {
        return { success: false, error: data.error };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const login = async (pass) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
      });
      const data = await res.json();
      if (data.success) {
        setUsername(data.username);
        setAuthState('authenticated');
        return { success: true };
      } else {
        return { success: false, error: data.error };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.error('Logout failed:', err);
    }
    setAuthState('locked');
  };

  return (
    <AuthContext.Provider value={{ authState, username, setup, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};
