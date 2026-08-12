export function topWindowZIndex(windows) {
  return Math.max(100, ...windows.map((windowState) => windowState.zIndex || 0));
}

export function activateExistingWindow(windows, appConfig) {
  if (!windows.some((windowState) => windowState.id === appConfig.id)) return null;
  const nextZIndex = topWindowZIndex(windows) + 1;
  return windows.map((windowState) => windowState.id === appConfig.id ? {
    ...windowState,
    isMinimized: false,
    zIndex: nextZIndex,
    ...(appConfig.navigation ? { navigation: appConfig.navigation } : {})
  } : windowState);
}

export function focusWindowById(windows, id) {
  if (!windows.some((windowState) => windowState.id === id)) return windows;
  const nextZIndex = topWindowZIndex(windows) + 1;
  return windows.map((windowState) => (
    windowState.id === id ? { ...windowState, zIndex: nextZIndex } : windowState
  ));
}
