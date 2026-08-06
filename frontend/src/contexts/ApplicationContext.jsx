/* oxlint-disable react/only-export-components -- context hook and provider intentionally share a module */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../api';

const ApplicationContext = createContext(null);

export const useApplicationInventory = () => {
  const context = useContext(ApplicationContext);
  if (!context) throw new Error('Application inventory requires ApplicationProvider');
  return context;
};

export const ApplicationProvider = ({ children }) => {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actions, setActions] = useState({});
  const requestSequence = useRef(0);
  const pendingActions = useRef(new Set());

  const refreshApplications = useCallback(async ({ quiet = false } = {}) => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    if (!quiet) setLoading(true);

    try {
      const response = await apiFetch('/api/applications');
      const payload = await response.json();
      if (requestSequence.current === sequence) {
        setApplications(payload.applications || []);
        setError(null);
      }
      return payload.applications || [];
    } catch (requestError) {
      if (requestSequence.current === sequence) setError(requestError.message);
      throw requestError;
    } finally {
      if (!quiet && requestSequence.current === sequence) setLoading(false);
    }
  }, []);

  const runApplicationAction = useCallback(async (application, action) => {
    const allowed = application.capabilities && application.capabilities[action];
    const containerId = application.runtime && application.runtime.containerId;
    if (!allowed || !containerId) throw new Error('Bu işlem uygulama için kullanılamıyor');
    if (pendingActions.current.has(application.id)) throw new Error('Uygulamada başka bir işlem sürüyor');

    pendingActions.current.add(application.id);
    setActions((current) => ({ ...current, [application.id]: action }));
    try {
      await apiFetch(`/api/containers/${containerId}/${action}`, { method: 'POST' });
      await refreshApplications({ quiet: true });
    } catch (actionError) {
      try {
        await refreshApplications({ quiet: true });
      } catch {
        // Preserve the action error; the last successful inventory stays visible.
      }
      throw actionError;
    } finally {
      pendingActions.current.delete(application.id);
      setActions((current) => ({ ...current, [application.id]: null }));
    }
  }, [refreshApplications]);

  const setDesktopShortcut = useCallback(async (application, visible) => {
    if (!application || typeof visible !== 'boolean') {
      throw new Error('Masaüstü kısayol işlemi geçersiz');
    }
    await apiFetch(`/api/applications/${application.id}/desktop-shortcut`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible })
    });
    await refreshApplications({ quiet: true });
  }, [refreshApplications]);

  useEffect(() => {
    refreshApplications().catch(() => {});
    const refreshTimer = window.setInterval(() => {
      refreshApplications({ quiet: true }).catch(() => {});
    }, 15000);
    return () => window.clearInterval(refreshTimer);
  }, [refreshApplications]);

  const value = useMemo(() => ({
    actions,
    applications,
    error,
    loading,
    refreshApplications,
    runApplicationAction,
    setDesktopShortcut
  }), [actions, applications, error, loading, refreshApplications, runApplicationAction, setDesktopShortcut]);

  return <ApplicationContext.Provider value={value}>{children}</ApplicationContext.Provider>;
};
