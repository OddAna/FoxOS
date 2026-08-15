/* oxlint-disable react/only-export-components -- context hook and provider intentionally share a module */
import React, { createContext, useCallback, useState, useContext, useEffect } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { AUTH_REQUIRED_EVENT } from '../api';
import { useI18n } from './LocaleContext';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const { t, updatePreferences } = useI18n();
  const [authState, setAuthState] = useState('loading'); // 'loading', 'needs_setup', 'needs_onboarding', 'locked', 'authenticated'
  const [username, setUsername] = useState(null);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);

  const applyLocalePreferences = useCallback((data) => {
    if (data && data.localePreferences) updatePreferences(data.localePreferences);
  }, [updatePreferences]);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      applyLocalePreferences(data);
      setPasskeyAvailable(data.passkeyAvailable === true);
      setRecoveryAvailable(data.recoveryAvailable === true);
      if (data.isSetup) {
        setUsername(data.username);
        setAuthState(data.authenticated
          ? data.onboardingRequired ? 'needs_onboarding' : 'authenticated'
          : 'locked');
      } else {
        setAuthState('needs_setup');
      }
    } catch (err) {
      console.error('Auth check failed:', err);
      setAuthState('locked');
    }
  }, [applyLocalePreferences]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    const handleAuthenticationRequired = () => setAuthState('locked');
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthenticationRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthenticationRequired);
  }, []);

  const setup = async (user, pass, localePreferences) => {
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass, localePreferences })
      });
      const data = await res.json();
      if (data.success) {
        applyLocalePreferences(data);
        setUsername(data.username);
        setPasskeyAvailable(false);
        setRecoveryAvailable(false);
        setAuthState(data.onboardingRequired ? 'needs_onboarding' : 'authenticated');
        return { success: true };
      } else {
        return { success: false, error: data.error, code: data.code };
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
        applyLocalePreferences(data);
        setUsername(data.username);
        setAuthState(data.onboardingRequired ? 'needs_onboarding' : 'authenticated');
        return { success: true };
      } else {
        return { success: false, error: data.error };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const loginWithPasskey = async () => {
    if (typeof window.PublicKeyCredential === 'undefined') {
      return { success: false, code: 'passkey-unsupported' };
    }
    try {
      const optionsResponse = await fetch('/api/auth/passkey/options', { method: 'POST' });
      const optionsPayload = await optionsResponse.json();
      if (!optionsResponse.ok) {
        return { success: false, error: optionsPayload.error, code: optionsPayload.code };
      }
      const credential = await startAuthentication({ optionsJSON: optionsPayload.options });
      const verificationResponse = await fetch('/api/auth/passkey/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ceremonyId: optionsPayload.ceremonyId, response: credential })
      });
      const data = await verificationResponse.json();
      if (!verificationResponse.ok || !data.success) {
        return { success: false, error: data.error, code: data.code };
      }
      applyLocalePreferences(data);
      setUsername(data.username);
      setAuthState(data.onboardingRequired ? 'needs_onboarding' : 'authenticated');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message, code: err.name };
    }
  };

  const recoverPassword = async (code, newPassword) => {
    try {
      const response = await fetch('/api/auth/recovery/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, newPassword })
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        return { success: false, error: data.error, code: data.code };
      }
      applyLocalePreferences(data);
      setUsername(data.username);
      setRecoveryAvailable(true);
      setAuthState(data.onboardingRequired ? 'needs_onboarding' : 'authenticated');
      return { success: true, recoveryCodesNeedRotation: data.recoveryCodesNeedRotation === true };
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

  const completeOnboarding = async (resolution) => {
    try {
      const res = await fetch('/api/setup/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolution,
          confirmation: 'COMPLETE INITIAL SETUP'
        })
      });
      const data = await res.json();
      if (res.status === 401) {
        setAuthState('locked');
      }
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || t('auth.onboardingError') };
      }
      setAuthState('authenticated');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  return (
    <AuthContext.Provider value={{
      authState,
      username,
      passkeyAvailable,
      recoveryAvailable,
      setup,
      login,
      loginWithPasskey,
      recoverPassword,
      logout,
      completeOnboarding
    }}>
      {children}
    </AuthContext.Provider>
  );
};
