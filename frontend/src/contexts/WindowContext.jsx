/* oxlint-disable react/only-export-components -- context hook and provider intentionally share a module */
import React, { createContext, useEffect, useState, useContext } from 'react';
import { activateExistingWindow, focusWindowById, topWindowZIndex } from '../utils/windowState';
import { appearanceShellMetrics, useAppearance } from '../utils/appearance';
import { clearWindowLayouts, readWindowLayout, writeWindowLayouts } from '../utils/windowLayout';

const WindowContext = createContext();

export const useWindowManager = () => useContext(WindowContext);

import { useDialog } from './DialogContext';
import { useI18n } from './LocaleContext';

export const WindowProvider = ({ children }) => {
  const { t } = useI18n();
  const { appearance } = useAppearance();
  const [windows, setWindows] = useState([]);
  const [focusedWindowId, setFocusedWindowId] = useState(null);
  const dialog = useDialog();

  useEffect(() => {
    if (!appearance.rememberWindowLayout) {
      clearWindowLayouts();
      return;
    }
    writeWindowLayouts(windows);
  }, [appearance.rememberWindowLayout, windows]);

  const openWindow = (appConfig) => {
    setFocusedWindowId(appConfig.id);
    setWindows(prev => {
      const activated = activateExistingWindow(prev, appConfig);
      if (activated) return activated;

      const shellMetrics = appearanceShellMetrics(appearance);
      const isSmallViewport = window.innerWidth <= 720;
      const topbarHeight = isSmallViewport ? 40 : shellMetrics.topbarHeight;
      const dockReserve = isSmallViewport ? shellMetrics.mobileDockReserve : shellMetrics.dockReserve;
      const availableWidth = Math.max(280, window.innerWidth - 16);
      const availableHeight = Math.max(240, window.innerHeight - topbarHeight - dockReserve - 16);
      const savedLayout = appearance.rememberWindowLayout ? readWindowLayout(appConfig.id) : null;
      const defaultWidth = Math.min(savedLayout?.width || appConfig.width || 800, availableWidth);
      const defaultHeight = Math.min(savedLayout?.height || appConfig.height || 600, availableHeight);
      const minimumY = isSmallViewport ? 8 : 30;
      const centeredX = Math.max(0, (window.innerWidth - defaultWidth) / 2) + (prev.length * 20);
      const centeredY = Math.max(minimumY, (availableHeight - defaultHeight) / 2) + (prev.length * 20);

      const newWindow = {
        ...appConfig,
        x: Math.min(Math.max(0, savedLayout?.x ?? centeredX), Math.max(0, window.innerWidth - defaultWidth)),
        y: Math.min(Math.max(minimumY, savedLayout?.y ?? centeredY), Math.max(minimumY, availableHeight - defaultHeight)),
        width: defaultWidth,
        height: defaultHeight,
        isMinimized: false,
        isMaximized: savedLayout?.isMaximized === true,
        zIndex: topWindowZIndex(prev) + 1
      };
      return [...prev, newWindow];
    });
  };

  const closeWindow = (id) => {
    const win = windows.find(w => w.id === id);
    if (win && ['terminal', 'codex'].includes(win.type) && dialog) {
      dialog.showDialog({
        title: win.type === 'codex' ? t('contextErrors.closeCodexTitle') : t('contextErrors.closeTerminalTitle'),
        message: win.type === 'codex'
          ? t('contextErrors.closeCodexMessage')
          : t('contextErrors.closeTerminalMessage'),
        type: 'warning',
        confirmText: t('contextErrors.confirmClose'),
        cancelText: t('common.cancel'),
        onConfirm: () => {
          setWindows(prev => prev.filter(w => w.id !== id));
          setFocusedWindowId(current => current === id ? null : current);
        }
      });
      return;
    }

    setWindows(prev => prev.filter(w => w.id !== id));
    setFocusedWindowId(current => current === id ? null : current);
  };

  const minimizeWindow = (id) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, isMinimized: true } : w));
    setFocusedWindowId(current => current === id ? null : current);
  };

  const maximizeWindow = (id) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, isMaximized: !w.isMaximized } : w));
  };

  const focusWindow = (id) => {
    setFocusedWindowId(id);
    setWindows(prev => focusWindowById(prev, id));
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
