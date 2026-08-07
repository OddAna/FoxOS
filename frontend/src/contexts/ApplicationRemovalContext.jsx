/* oxlint-disable react/only-export-components -- context hook and provider intentionally share a module */
import React, { createContext, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { apiFetch } from '../api';
import { useApplicationInventory } from './ApplicationContext';
import { useDialog } from './DialogContext';

const ApplicationRemovalContext = createContext(null);

export const useApplicationRemoval = () => {
  const context = useContext(ApplicationRemovalContext);
  if (!context) throw new Error('Application removal requires ApplicationRemovalProvider');
  return context;
};

export const ApplicationRemovalProvider = ({ children }) => {
  const [state, setState] = useState(null);
  const [includeLinkedServices, setIncludeLinkedServices] = useState(false);
  const [removeData, setRemoveData] = useState(false);
  const [password, setPassword] = useState('');
  const { refreshApplications } = useApplicationInventory();
  const { showDialog } = useDialog();

  const close = () => {
    if (state?.applying) return;
    setState(null);
    setIncludeLinkedServices(false);
    setRemoveData(false);
    setPassword('');
  };

  const openApplicationRemoval = async (application, { onRemoved = null } = {}) => {
    setIncludeLinkedServices(false);
    setRemoveData(false);
    setPassword('');
    setState({ application, onRemoved, loading: true, applying: false, plan: null, error: null });
    try {
      const response = await apiFetch(`/api/applications/${application.id}/removal-plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const payload = await response.json();
      setState((current) => current && current.application.id === application.id
        ? { ...current, loading: false, plan: payload.plan, error: null }
        : current);
    } catch (error) {
      setState((current) => current && current.application.id === application.id
        ? { ...current, loading: false, error: error.message }
        : current);
    }
  };

  const safeVolumes = useMemo(() => {
    const volumes = state?.plan?.persistentData?.namedVolumes || [];
    return volumes.filter((volume) => includeLinkedServices
      ? volume.removableWithLinkedServices
      : volume.removableWithPrimary);
  }, [includeLinkedServices, state]);

  const apply = async () => {
    if (!state?.plan || state.applying || !password) return;
    setState((current) => ({ ...current, applying: true, error: null }));
    try {
      const response = await apiFetch(`/api/application-removal-plans/${state.plan.planId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          includeLinkedServices,
          removeData
        })
      });
      const payload = await response.json();
      const applicationName = state.application.name;
      const onRemoved = state.onRemoved;
      setState(null);
      setPassword('');
      setIncludeLinkedServices(false);
      setRemoveData(false);
      await refreshApplications({ quiet: true });
      if (typeof onRemoved === 'function') await onRemoved();
      showDialog({
        title: 'Uygulama Kaldırıldı',
        message: payload.operation?.message || `"${applicationName}" sunucudan kaldırıldı.`,
        type: 'success'
      });
    } catch (error) {
      setPassword('');
      setState((current) => ({ ...current, applying: false, error: error.message }));
    }
  };

  return (
    <ApplicationRemovalContext.Provider value={{ openApplicationRemoval }}>
      {children}
      {state && createPortal(
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          style={{
            position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 99999999, background: 'rgba(0,0,0,0.35)'
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="application-removal-title"
            style={{
              background: 'rgba(30, 30, 30, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '12px', padding: '24px', width: '440px', maxWidth: '90%',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)', color: '#fff',
              display: 'flex', flexDirection: 'column', gap: '16px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <AlertTriangle size={32} color="#ef4444" />
              <h3 id="application-removal-title" style={{ margin: 0, fontSize: '18px', fontWeight: '600' }}>
                Uygulamayı Kaldır
              </h3>
            </div>

            {state.loading ? (
              <div style={{ color: '#cbd5e1', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Loader2 size={16} className="spin" /> Kaldırılacak parçalar doğrulanıyor…
              </div>
            ) : state.plan ? (
              <>
                <div style={{ fontSize: '14px', color: '#cbd5e1', lineHeight: '1.5' }}>
                  <strong style={{ color: '#fff' }}>{state.application.name}</strong> sunucudan kalıcı olarak kaldırılacak.
                  {state.plan.sameApplicationCopies.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      Aynı uygulamaya ait {state.plan.sameApplicationCopies.length} eski çalışma kopyası da temizlenecek.
                    </div>
                  )}
                </div>

                {state.plan.linkedServices.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', color: '#e2e8f0', fontSize: '14px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={includeLinkedServices}
                      disabled={state.applying}
                      onChange={(event) => {
                        setIncludeLinkedServices(event.target.checked);
                        setRemoveData(false);
                      }}
                      style={{ marginTop: '2px' }}
                    />
                    <span>
                      Bağlı servisleri de kaldır
                      <span style={{ display: 'block', color: '#94a3b8', fontSize: '12px', marginTop: '3px' }}>
                        {state.plan.linkedServices.map((service) => service.name).join(', ')}
                      </span>
                    </span>
                  </label>
                )}

                {state.plan.persistentData.namedVolumes.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', color: '#e2e8f0', fontSize: '14px', cursor: safeVolumes.length ? 'pointer' : 'default', opacity: safeVolumes.length ? 1 : 0.65 }}>
                    <input
                      type="checkbox"
                      checked={removeData}
                      disabled={state.applying || safeVolumes.length === 0}
                      onChange={(event) => setRemoveData(event.target.checked)}
                      style={{ marginTop: '2px' }}
                    />
                    <span>
                      Uygulama verilerini de sil
                      <span style={{ display: 'block', color: removeData ? '#fca5a5' : '#94a3b8', fontSize: '12px', marginTop: '3px' }}>
                        {safeVolumes.length > 0
                          ? `${safeVolumes.map((volume) => volume.name).join(', ')} geri alınamaz biçimde silinir.`
                          : 'Volume başka bir servis tarafından kullanıldığı için korunacak.'}
                      </span>
                    </span>
                  </label>
                )}

                <div style={{ fontSize: '12px', color: '#94a3b8', lineHeight: '1.5' }}>
                  Erişim rotası ve boş uygulama ağı temizlenir. DNS kaydı, Compose kaynak dosyası, bind klasörleri ve imaj önbelleği korunur.
                </div>

                <div>
                  <label htmlFor="application-removal-password" style={{ display: 'block', fontSize: '13px', color: '#cbd5e1', marginBottom: '6px' }}>
                    FoxOS Şifresi
                  </label>
                  <input
                    id="application-removal-password"
                    type="password"
                    autoFocus
                    autoComplete="current-password"
                    value={password}
                    disabled={state.applying}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') apply();
                    }}
                    style={{
                      background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '6px', padding: '10px', color: '#fff', fontSize: '14px',
                      outline: 'none', width: '100%', boxSizing: 'border-box'
                    }}
                  />
                </div>
              </>
            ) : null}

            {state.error && (
              <div role="alert" style={{ color: '#fca5a5', fontSize: '13px', lineHeight: '1.45' }}>
                {state.error}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '4px' }}>
              <button
                type="button"
                onClick={close}
                disabled={state.applying}
                style={{
                  padding: '8px 16px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.2)',
                  background: 'transparent', color: '#fff', cursor: state.applying ? 'default' : 'pointer', fontSize: '14px'
                }}
              >
                {state.plan ? 'Vazgeç' : 'Kapat'}
              </button>
              {state.plan && (
                <button
                  type="button"
                  onClick={apply}
                  disabled={state.applying || !password}
                  style={{
                    padding: '8px 16px', borderRadius: '6px', border: 'none',
                    background: '#ef4444', color: '#fff', cursor: state.applying || !password ? 'default' : 'pointer',
                    fontSize: '14px', fontWeight: 'bold', opacity: state.applying || !password ? 0.55 : 1,
                    display: 'inline-flex', alignItems: 'center', gap: '7px'
                  }}
                >
                  {state.applying && <Loader2 size={14} className="spin" />}
                  {state.applying ? 'Kaldırılıyor…' : 'Uygulamayı Kaldır'}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </ApplicationRemovalContext.Provider>
  );
};
