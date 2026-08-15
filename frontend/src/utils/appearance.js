import { useCallback, useEffect, useState } from 'react';
import foxWallpaper from '../assets/fox-wallpaper.jpg';

export const APPEARANCE_STORAGE_KEY = 'foxos_appearance_v1';
export const APPEARANCE_CHANGE_EVENT = 'foxos:appearance-changed';

export const DEFAULT_APPEARANCE = Object.freeze({
  wallpaperId: 'fox',
  customWallpaper: null,
  dim: 8,
  useOnLockScreen: true,
  interfaceScale: 'auto',
  desktopIconSize: 'medium',
  desktopGridDensity: 'standard',
  snapToGrid: true,
  dockSize: 'medium',
  dockAutoHide: false,
  rememberWindowLayout: true,
  maximizeSmallWindows: true,
  reduceMotion: false,
  highContrast: false,
  textSize: 'standard'
});

export const INTERFACE_SCALE_OPTIONS = Object.freeze(['auto', 90, 100, 110, 125]);
export const DESKTOP_ICON_SIZE_OPTIONS = Object.freeze(['small', 'medium', 'large']);
export const DESKTOP_GRID_DENSITY_OPTIONS = Object.freeze(['compact', 'standard', 'spacious']);
export const DOCK_SIZE_OPTIONS = Object.freeze(['small', 'medium', 'large']);
export const TEXT_SIZE_OPTIONS = Object.freeze(['standard', 'large']);

export const WALLPAPER_PRESETS = Object.freeze([
  {
    id: 'fox',
    nameKey: 'wallpapers.fox.name',
    descriptionKey: 'wallpapers.fox.description',
    backgroundImage: `url(${JSON.stringify(foxWallpaper)})`,
    backgroundColor: '#101117'
  },
  {
    id: 'aurora',
    nameKey: 'wallpapers.aurora.name',
    descriptionKey: 'wallpapers.aurora.description',
    backgroundImage: 'radial-gradient(circle at 16% 18%, rgba(116, 91, 255, 0.96), transparent 34%), radial-gradient(circle at 82% 78%, rgba(12, 181, 185, 0.84), transparent 40%), linear-gradient(145deg, #070a19 0%, #151330 52%, #071d27 100%)',
    backgroundColor: '#080b1b'
  },
  {
    id: 'midnight',
    nameKey: 'wallpapers.midnight.name',
    descriptionKey: 'wallpapers.midnight.description',
    backgroundImage: 'radial-gradient(circle at 70% 20%, rgba(29, 78, 216, 0.72), transparent 36%), radial-gradient(circle at 18% 86%, rgba(14, 116, 144, 0.58), transparent 38%), linear-gradient(150deg, #030712 0%, #0b1732 54%, #020617 100%)',
    backgroundColor: '#030712'
  },
  {
    id: 'ember',
    nameKey: 'wallpapers.ember.name',
    descriptionKey: 'wallpapers.ember.description',
    backgroundImage: 'radial-gradient(circle at 76% 20%, rgba(249, 115, 22, 0.72), transparent 35%), radial-gradient(circle at 18% 82%, rgba(190, 24, 93, 0.5), transparent 38%), linear-gradient(145deg, #17070a 0%, #2a0d19 48%, #12090f 100%)',
    backgroundColor: '#17070a'
  }
]);

const CUSTOM_IMAGE_PATTERN = /^data:image\/(?:avif|jpeg|png|webp);base64,/i;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const enumValue = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

export const resolvedInterfaceScale = (value) => {
  const requested = value && typeof value === 'object' ? value.interfaceScale : value;
  if (requested === 'auto') return 100;
  const parsed = Number(requested);
  return INTERFACE_SCALE_OPTIONS.includes(parsed) ? parsed : 100;
};

export const normalizeAppearance = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const customWallpaper = typeof source.customWallpaper === 'string' && CUSTOM_IMAGE_PATTERN.test(source.customWallpaper)
    ? source.customWallpaper
    : null;
  const knownPreset = WALLPAPER_PRESETS.some((preset) => preset.id === source.wallpaperId);
  const wallpaperId = source.wallpaperId === 'custom' && customWallpaper
    ? 'custom'
    : knownPreset ? source.wallpaperId : DEFAULT_APPEARANCE.wallpaperId;
  const parsedDim = Number(source.dim);
  const parsedScale = source.interfaceScale === 'auto' ? 'auto' : Number(source.interfaceScale);

  return {
    wallpaperId,
    customWallpaper,
    dim: Number.isFinite(parsedDim) ? clamp(Math.round(parsedDim), 0, 45) : DEFAULT_APPEARANCE.dim,
    useOnLockScreen: source.useOnLockScreen !== false,
    interfaceScale: INTERFACE_SCALE_OPTIONS.includes(parsedScale) ? parsedScale : DEFAULT_APPEARANCE.interfaceScale,
    desktopIconSize: enumValue(source.desktopIconSize, DESKTOP_ICON_SIZE_OPTIONS, DEFAULT_APPEARANCE.desktopIconSize),
    desktopGridDensity: enumValue(source.desktopGridDensity, DESKTOP_GRID_DENSITY_OPTIONS, DEFAULT_APPEARANCE.desktopGridDensity),
    snapToGrid: source.snapToGrid !== false,
    dockSize: enumValue(source.dockSize, DOCK_SIZE_OPTIONS, DEFAULT_APPEARANCE.dockSize),
    dockAutoHide: source.dockAutoHide === true,
    rememberWindowLayout: source.rememberWindowLayout !== false,
    maximizeSmallWindows: source.maximizeSmallWindows !== false,
    reduceMotion: source.reduceMotion === true,
    highContrast: source.highContrast === true,
    textSize: enumValue(source.textSize, TEXT_SIZE_OPTIONS, DEFAULT_APPEARANCE.textSize)
  };
};

export const appearanceShellMetrics = (value) => {
  const appearance = normalizeAppearance(value);
  const interfaceFactor = resolvedInterfaceScale(appearance) / 100;
  const textFactor = appearance.textSize === 'large' ? 1.12 : 1;
  const combinedTextFactor = interfaceFactor * textFactor;
  const dockItemSize = { small: 38, medium: 44, large: 52 }[appearance.dockSize];
  const dockIconSize = { small: 22, medium: 26, large: 31 }[appearance.dockSize];

  return {
    interfaceFactor,
    combinedTextFactor,
    topbarHeight: Math.round(30 * interfaceFactor),
    windowHeaderHeight: Math.round(38 * interfaceFactor),
    windowControlSize: Math.round(12 * interfaceFactor),
    settingsSidebarWidth: Math.round(200 * interfaceFactor),
    settingsContentPadding: Math.round(32 * interfaceFactor),
    dockItemSize,
    dockIconSize,
    dockReserve: appearance.dockAutoHide ? 26 : dockItemSize + 36,
    mobileDockReserve: dockItemSize + 28
  };
};

export const appearanceDesktopMetrics = (value) => {
  const appearance = normalizeAppearance(value);
  const iconSize = { small: 40, medium: 48, large: 58 }[appearance.desktopIconSize];
  const labelSize = { small: 11, medium: 12, large: 13 }[appearance.desktopIconSize]
    + (appearance.textSize === 'large' ? 1 : 0);
  return {
    iconSize,
    logoSize: Math.round(iconSize * 2 / 3),
    labelSize,
    statusSize: Math.max(11, Math.round(iconSize * 0.29)),
    iconRadius: Math.max(9, Math.round(iconSize * 0.21)),
    iconPadding: Math.max(6, Math.round(iconSize / 6)),
    cellTarget: { compact: 86, standard: 100, spacious: 118 }[appearance.desktopGridDensity]
  };
};

export const applyAppearanceToDocument = (value) => {
  if (typeof document === 'undefined') return;
  const appearance = normalizeAppearance(value);
  const shell = appearanceShellMetrics(appearance);
  const root = document.documentElement;

  root.dataset.foxosInterfaceScale = String(appearance.interfaceScale);
  root.dataset.foxosDesktopIconSize = appearance.desktopIconSize;
  root.dataset.foxosDesktopGridDensity = appearance.desktopGridDensity;
  root.dataset.foxosDockSize = appearance.dockSize;
  root.dataset.foxosDockAutoHide = String(appearance.dockAutoHide);
  root.dataset.foxosReduceMotion = String(appearance.reduceMotion);
  root.dataset.foxosHighContrast = String(appearance.highContrast);
  root.dataset.foxosTextSize = appearance.textSize;
  root.dataset.foxosSmallWindowMode = appearance.maximizeSmallWindows ? 'maximized' : 'floating';
  root.style.setProperty('--foxos-interface-factor', String(shell.interfaceFactor));
  root.style.setProperty('--foxos-shell-font-size', `${(13 * shell.combinedTextFactor).toFixed(2)}px`);
  root.style.setProperty('--foxos-window-title-size', `${(13 * shell.combinedTextFactor).toFixed(2)}px`);
  root.style.setProperty('--foxos-settings-tab-size', `${(13 * shell.combinedTextFactor).toFixed(2)}px`);
  root.style.setProperty('--foxos-settings-title-size', `${(24 * shell.combinedTextFactor).toFixed(2)}px`);
  root.style.setProperty('--foxos-topbar-height-desktop', `${shell.topbarHeight}px`);
  root.style.setProperty('--foxos-window-header-height', `${shell.windowHeaderHeight}px`);
  root.style.setProperty('--foxos-window-control-size', `${shell.windowControlSize}px`);
  root.style.setProperty('--foxos-settings-sidebar-width', `${shell.settingsSidebarWidth}px`);
  root.style.setProperty('--foxos-settings-content-padding', `${shell.settingsContentPadding}px`);
  root.style.setProperty('--foxos-dock-item-size', `${shell.dockItemSize}px`);
  root.style.setProperty('--foxos-dock-icon-size', `${shell.dockIconSize}px`);
  root.style.setProperty('--foxos-dock-reserve-desktop', `${shell.dockReserve}px`);
  root.style.setProperty('--foxos-dock-reserve-mobile', `${shell.mobileDockReserve}px`);
};

export const readAppearance = () => {
  if (typeof window === 'undefined') return { ...DEFAULT_APPEARANCE };
  try {
    return normalizeAppearance(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
};

export const writeAppearance = (value) => {
  const normalized = normalizeAppearance(value);
  if (typeof window === 'undefined') return normalized;

  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalized));
  } catch (error) {
    const storageError = new Error('appearance-storage-failed');
    storageError.code = 'appearance-storage-failed';
    storageError.cause = error;
    throw storageError;
  }

  applyAppearanceToDocument(normalized);

  if (typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT, { detail: normalized }));
  }
  return normalized;
};

export const appearanceBackground = (value, { lockScreen = false } = {}) => {
  const requested = normalizeAppearance(value);
  const appearance = lockScreen && !requested.useOnLockScreen
    ? { ...DEFAULT_APPEARANCE }
    : requested;
  const preset = WALLPAPER_PRESETS.find((candidate) => candidate.id === appearance.wallpaperId)
    || WALLPAPER_PRESETS[0];
  const image = appearance.wallpaperId === 'custom' && appearance.customWallpaper
    ? `url(${JSON.stringify(appearance.customWallpaper)})`
    : preset.backgroundImage;
  const shade = (appearance.dim / 100).toFixed(2);

  return {
    backgroundColor: preset.backgroundColor || '#101117',
    backgroundImage: `linear-gradient(rgba(0, 0, 0, ${shade}), rgba(0, 0, 0, ${shade})), ${image}`,
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    backgroundSize: 'cover'
  };
};

export const useAppearance = () => {
  const [appearance, setAppearance] = useState(readAppearance);

  useEffect(() => {
    applyAppearanceToDocument(appearance);
  }, [appearance]);

  useEffect(() => {
    const onAppearanceChange = (event) => {
      setAppearance(normalizeAppearance(event.detail));
    };
    const onStorage = (event) => {
      if (event.key === APPEARANCE_STORAGE_KEY) setAppearance(readAppearance());
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, onAppearanceChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, onAppearanceChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const updateAppearance = useCallback((next) => {
    const current = readAppearance();
    return writeAppearance(typeof next === 'function' ? next(current) : next);
  }, []);

  return { appearance, updateAppearance };
};
