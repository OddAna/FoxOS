/* oxlint-disable react/only-export-components -- context hook and provider intentionally share a module */
import React, { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Info, CheckCircle, XCircle, Edit3 } from 'lucide-react';

const DialogContext = createContext();

export const useDialog = () => useContext(DialogContext);

export const DialogProvider = ({ children }) => {
  const [dialogs, setDialogs] = useState([]);
  const [inputValues, setInputValues] = useState({});

  // type: 'warning' | 'info' | 'error' | 'success' | 'confirm' | 'prompt'
  const showDialog = ({ title, message, type = 'info', defaultValue = '', confirmText = 'Tamam', cancelText = 'İptal', onConfirm = null }) => {
    const id = Date.now().toString() + Math.random().toString();
    if (type === 'prompt') {
      setInputValues(prev => ({ ...prev, [id]: defaultValue }));
    }
    setDialogs(prev => [...prev, { id, title, message, type, confirmText, cancelText, onConfirm }]);
    return id;
  };

  const closeDialog = (id) => {
    setDialogs(prev => prev.filter(d => d.id !== id));
    setInputValues(prev => {
      const newVals = { ...prev };
      delete newVals[id];
      return newVals;
    });
  };

  const renderIcon = (type) => {
    switch (type) {
      case 'warning':
      case 'confirm':
        return <AlertTriangle size={32} color="#f59e0b" />;
      case 'error':
        return <XCircle size={32} color="#ef4444" />;
      case 'success':
        return <CheckCircle size={32} color="#10b981" />;
      case 'prompt':
        return <Edit3 size={32} color="#0ea5e9" />;
      default:
        return <Info size={32} color="#3b82f6" />;
    }
  };

  return (
    <DialogContext.Provider value={{ showDialog, closeDialog }}>
      {children}
      
      {dialogs.length > 0 && createPortal(
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 99999999,
          pointerEvents: 'none'
        }}>
          {dialogs.map(dialog => (
            <div key={dialog.id} style={{
              pointerEvents: 'auto',
              background: 'rgba(30, 30, 30, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '12px',
              padding: '24px',
              width: '400px',
              maxWidth: '90%',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
              color: '#fff',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              position: 'absolute'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                {renderIcon(dialog.type)}
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600' }}>{dialog.title}</h3>
              </div>
              
              <div style={{ fontSize: '14px', color: '#cbd5e1', lineHeight: '1.5' }}>
                {dialog.message}
              </div>

              {dialog.type === 'prompt' && (
                <input 
                  type="text" 
                  autoFocus
                  value={inputValues[dialog.id] || ''}
                  onChange={(e) => setInputValues(prev => ({ ...prev, [dialog.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (dialog.onConfirm) dialog.onConfirm(inputValues[dialog.id]);
                      closeDialog(dialog.id);
                    }
                  }}
                  style={{
                    background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: '6px', padding: '10px', color: '#fff', fontSize: '14px',
                    outline: 'none', width: '100%', boxSizing: 'border-box'
                  }}
                />
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }}>
                {(dialog.type === 'confirm' || dialog.type === 'warning' || dialog.type === 'prompt') && (
                  <button 
                    onClick={() => closeDialog(dialog.id)}
                    style={{
                      padding: '8px 16px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.2)',
                      background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: '14px'
                    }}
                    onMouseOver={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
                    onMouseOut={(e) => e.target.style.background = 'transparent'}
                  >
                    {dialog.cancelText}
                  </button>
                )}
                
                <button 
                  onClick={() => {
                    if (dialog.onConfirm) {
                      if (dialog.type === 'prompt') {
                        dialog.onConfirm(inputValues[dialog.id]);
                      } else {
                        dialog.onConfirm();
                      }
                    }
                    closeDialog(dialog.id);
                  }}
                  style={{
                    padding: '8px 16px', borderRadius: '6px', border: 'none',
                    background: dialog.type === 'error' || dialog.type === 'warning' ? '#ef4444' : '#3b82f6',
                    color: '#fff', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold'
                  }}
                  onMouseOver={(e) => e.target.style.opacity = '0.9'}
                  onMouseOut={(e) => e.target.style.opacity = '1'}
                >
                  {dialog.confirmText}
                </button>
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}
    </DialogContext.Provider>
  );
};
