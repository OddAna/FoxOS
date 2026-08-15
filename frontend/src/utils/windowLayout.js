export const WINDOW_LAYOUT_STORAGE_KEY = 'foxos_window_layout_v1';

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

const normalizeLayout = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const x = finite(source.x);
  const y = finite(source.y);
  const width = finite(source.width);
  const height = finite(source.height);
  if (x === null || y === null || width === null || height === null) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(300, Math.round(width)),
    height: Math.max(200, Math.round(height)),
    isMaximized: source.isMaximized === true
  };
};

const readLayouts = () => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WINDOW_LAYOUT_STORAGE_KEY));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const readWindowLayout = (id) => {
  if (typeof id !== 'string' || !id) return null;
  return normalizeLayout(readLayouts()[id]);
};

export const writeWindowLayouts = (windows) => {
  if (typeof window === 'undefined') return;
  const current = readLayouts();
  const next = { ...current };
  windows.forEach((windowState) => {
    if (!windowState || typeof windowState.id !== 'string') return;
    const normalized = normalizeLayout(windowState);
    if (normalized) next[windowState.id] = normalized;
  });
  try {
    window.localStorage.setItem(WINDOW_LAYOUT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Window geometry is a convenience. A storage quota failure must not block the shell.
  }
};

export const clearWindowLayouts = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(WINDOW_LAYOUT_STORAGE_KEY);
  } catch {
    // Keep the setting usable even when browser storage is unavailable.
  }
};
