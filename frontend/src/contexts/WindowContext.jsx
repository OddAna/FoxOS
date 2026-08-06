/* oxlint-disable react/only-export-components -- context hook and provider intentionally share a module */
import React, { createContext, useState, useContext } from 'react';

const WindowContext = createContext();

export const useWindowManager = () => useContext(WindowContext);

import { useDialog } from './DialogContext';

export const WindowProvider = ({ children }) => {
  const [windows, setWindows] = useState([]);
  const [focusedWindowId, setFocusedWindowId] = useState(null);
  const dialog = useDialog();

  const openWindow = (appConfig) => {
    setWindows(prev => {
      const existing = prev.find(w => w.id === appConfig.id);
      if (existing) {
        focusWindow(appConfig.id);
        return prev.map(w => w.id === appConfig.id ? {
          ...w,
          isMinimized: false,
          ...(appConfig.navigation ? { navigation: appConfig.navigation } : {})
        } : w);
      }
      
      const availableWidth = Math.max(280, window.innerWidth - 16);
      const availableHeight = Math.max(240, window.innerHeight - 116);
      const defaultWidth = Math.min(appConfig.width || 800, availableWidth);
      const defaultHeight = Math.min(appConfig.height || 600, availableHeight);
      
      const maxZ = prev.length > 0 ? Math.max(...prev.map(w => w.zIndex)) : 100;
      
      const newWindow = {
        ...appConfig,
        x: Math.min(
          Math.max(0, (window.innerWidth - defaultWidth) / 2) + (prev.length * 20),
          Math.max(0, window.innerWidth - defaultWidth)
        ),
        y: Math.min(
          Math.max(30, (window.innerHeight - defaultHeight) / 2 - 60) + (prev.length * 20),
          Math.max(30, window.innerHeight - defaultHeight - 85)
        ),
        width: defaultWidth,
        height: defaultHeight,
        isMinimized: false,
        isMaximized: false,
        zIndex: maxZ + 1
      };
      setFocusedWindowId(newWindow.id);
      return [...prev, newWindow];
    });
  };

  const closeWindow = (id) => {
    const win = windows.find(w => w.id === id);
    if (win && win.type === 'terminal' && dialog) {
      dialog.showDialog({
        title: 'Terminali Kapat',
        message: 'Arka planda çalışan bir işlem olabilir. Terminali kapatmak istediğinize emin misiniz?',
        type: 'warning',
        confirmText: 'Evet, Kapat',
        cancelText: 'Vazgeç',
        onConfirm: () => {
          setWindows(prev => prev.filter(w => w.id !== id));
          if (focusedWindowId === id) setFocusedWindowId(null);
        }
      });
      return;
    }

    setWindows(prev => prev.filter(w => w.id !== id));
    if (focusedWindowId === id) setFocusedWindowId(null);
  };

  const minimizeWindow = (id) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, isMinimized: true } : w));
  };

  const maximizeWindow = (id) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, isMaximized: !w.isMaximized } : w));
  };

  const focusWindow = (id) => {
    setFocusedWindowId(id);
    setWindows(prev => {
      const maxZ = Math.max(...prev.map(w => w.zIndex), 100);
      return prev.map(w => w.id === id ? { ...w, zIndex: maxZ + 1 } : w);
    });
  };

  const updateWindowPosition = (id, x, y) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, x, y } : w));
  };

  const updateWindowDimensions = (id, x, y, width, height) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, x, y, width, height } : w));
  };

  return (
    <WindowContext.Provider value={{
      windows,
      focusedWindowId,
      openWindow,
      closeWindow,
      minimizeWindow,
      maximizeWindow,
      focusWindow,
      updateWindowPosition,
      updateWindowDimensions
    }}>
      {children}
    </WindowContext.Provider>
  );
};
