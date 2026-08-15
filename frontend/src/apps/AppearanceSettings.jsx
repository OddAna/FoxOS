import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Accessibility,
  AppWindow,
  Check,
  CheckCircle2,
  CircleAlert,
  Eye,
  Grid3X3,
  Image as ImageIcon,
  Monitor,
  MonitorCog,
  Move,
  PanelBottom,
  RotateCcw,
  Scaling,
  Smartphone,
  Type,
  Upload
} from 'lucide-react';
import { useI18n } from '../contexts/LocaleContext';
import {
  appearanceBackground,
  DEFAULT_APPEARANCE,
  resolvedInterfaceScale,
  useAppearance,
  WALLPAPER_PRESETS
} from '../utils/appearance';
import { clearWindowLayouts } from '../utils/windowLayout';
import './AppearanceSettings.css';

const MAX_CUSTOM_WALLPAPER_BYTES = 2.5 * 1024 * 1024;
const ACCEPTED_WALLPAPER_TYPES = new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp']);

const deviceSnapshot = () => {
  const screenWidth = Math.round(window.screen?.width || window.innerWidth);
  const screenHeight = Math.round(window.screen?.height || window.innerHeight);
  const viewportWidth = Math.round(window.visualViewport?.width || window.innerWidth);
  const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight);
  return {
    screenWidth,
    screenHeight,
    viewportWidth,
    viewportHeight,
    pixelRatio: Number(window.devicePixelRatio || 1),
    touch: Number(navigator.maxTouchPoints || 0) > 0,
    orientation: screenWidth >= screenHeight ? 'landscape' : 'portrait'
  };
};

const ScopeBadge = ({ children }) => <span className="appearance-scope-badge">{children}</span>;

const OptionGroup = ({ ariaLabel, options, value, onChange }) => (
  <div className="appearance-option-group" role="radiogroup" aria-label={ariaLabel}>
    {options.map((option) => (
      <button
        type="button"
        role="radio"
        aria-checked={value === option.value}
        className={value === option.value ? 'is-selected' : ''}
        key={String(option.value)}
        onClick={() => onChange(option.value)}
      >
        {option.label}
        {option.note && <small>{option.note}</small>}
      </button>
    ))}
  </div>
);

const SwitchRow = ({ checked, description, icon: Icon, label, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className="appearance-switch-row"
    onClick={() => onChange(!checked)}
  >
    <span className="appearance-switch-icon"><Icon size={15} /></span>
    <span className="appearance-switch-copy">
      <strong>{label}</strong>
      <small>{description}</small>
    </span>
    <i className={checked ? 'is-on' : ''} aria-hidden="true"><b /></i>
  </button>
);

const AppearanceSettings = ({ target }) => {
  const { t } = useI18n();
  const { appearance, updateAppearance } = useAppearance();
  const fileInputRef = useRef(null);
  const [feedback, setFeedback] = useState(null);
  const [device, setDevice] = useState(deviceSnapshot);

  useEffect(() => {
    const refresh = () => setDevice(deviceSnapshot());
    window.addEventListener('resize', refresh);
    window.addEventListener('orientationchange', refresh);
    window.visualViewport?.addEventListener('resize', refresh);
    return () => {
      window.removeEventListener('resize', refresh);
      window.removeEventListener('orientationchange', refresh);
      window.visualViewport?.removeEventListener('resize', refresh);
    };
  }, []);

  useEffect(() => {
    if (!target?.section) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`appearance-${target.section}`)?.scrollIntoView({
        behavior: appearance.reduceMotion ? 'auto' : 'smooth',
        block: 'start'
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [appearance.reduceMotion, target?.requestId, target?.section]);

  const savePreference = (patch, { clearLayouts = false } = {}) => {
    try {
      updateAppearance((current) => ({ ...current, ...patch }));
      if (clearLayouts) clearWindowLayouts();
      setFeedback({ type: 'success', text: t('appearance.saved') });
    } catch (error) {
      setFeedback({
        type: 'error',
        text: error.code === 'appearance-storage-failed'
          ? t('appearance.storageError')
          : error.message || t('appearance.saveError')
      });
    }
  };

  const uploadWallpaper = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ACCEPTED_WALLPAPER_TYPES.has(file.type)) {
      setFeedback({ type: 'error', text: t('appearance.wallpaperFormatError') });
      return;
    }
    if (file.size > MAX_CUSTOM_WALLPAPER_BYTES) {
      setFeedback({ type: 'error', text: t('appearance.wallpaperSizeError') });
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setFeedback({ type: 'error', text: t('appearance.wallpaperReadError') });
    reader.onload = () => savePreference({ wallpaperId: 'custom', customWallpaper: String(reader.result || '') });
    reader.readAsDataURL(file);
  };

  const currentWallpaper = appearance.wallpaperId === 'custom'
    ? { nameKey: 'appearance.custom', descriptionKey: 'appearance.customDescription' }
    : WALLPAPER_PRESETS.find((preset) => preset.id === appearance.wallpaperId) || WALLPAPER_PRESETS[0];
  const pixelRatio = Number.isInteger(device.pixelRatio) ? String(device.pixelRatio) : device.pixelRatio.toFixed(2);
  const resolvedScale = resolvedInterfaceScale(appearance);

  const scaleOptions = useMemo(() => [
    { value: 'auto', label: t('appearance.scaleAuto'), note: `${resolvedScale}%` },
    ...[90, 100, 110, 125].map((value) => ({ value, label: `${value}%` }))
  ], [resolvedScale, t]);
  const sizeOptions = useMemo(() => [
    { value: 'small', label: t('appearance.small') },
    { value: 'medium', label: t('appearance.medium') },
    { value: 'large', label: t('appearance.large') }
  ], [t]);
  const densityOptions = useMemo(() => [
    { value: 'compact', label: t('appearance.compact') },
    { value: 'standard', label: t('appearance.standard') },
    { value: 'spacious', label: t('appearance.spacious') }
  ], [t]);

  return (
    <div className="appearance-settings">
      <section className="appearance-device-card" id="appearance-device">
        <div className="appearance-device-copy">
          <span className="appearance-kicker"><Monitor size={13} /> {t('appearance.deviceKicker')}</span>
          <h3>{t('appearance.deviceTitle')}</h3>
          <p>{t('appearance.deviceDescription')}</p>
          <ScopeBadge>{t('appearance.thisDevice')}</ScopeBadge>
        </div>
        <div className="appearance-device-visual" aria-hidden="true">
          <Monitor size={42} />
          {device.touch && <Smartphone size={18} />}
        </div>
        <div className="appearance-device-facts">
          <span><small>{t('appearance.screen')}</small><strong>{device.screenWidth} × {device.screenHeight}</strong></span>
          <span><small>{t('appearance.workspace')}</small><strong>{device.viewportWidth} × {device.viewportHeight}</strong></span>
          <span><small>{t('appearance.pixelRatio')}</small><strong>{pixelRatio}×</strong></span>
          <span><small>{t('appearance.input')}</small><strong>{device.touch ? t('appearance.touch') : t('appearance.pointer')}</strong></span>
        </div>
      </section>

      {feedback && (
        <div className={`appearance-feedback is-${feedback.type}`} aria-live="polite">
          {feedback.type === 'success' ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
          {feedback.text}
        </div>
      )}

      <section className="appearance-section" id="appearance-scale">
        <header className="appearance-section-heading">
          <span className="appearance-section-icon"><Scaling size={17} /></span>
          <div>
            <h3>{t('appearance.scaleTitle')}</h3>
            <p>{t('appearance.scaleDescription')}</p>
          </div>
          <ScopeBadge>{t('appearance.thisDevice')}</ScopeBadge>
        </header>
        <OptionGroup
          ariaLabel={t('appearance.scaleTitle')}
          options={scaleOptions}
          value={appearance.interfaceScale}
          onChange={(interfaceScale) => savePreference({ interfaceScale })}
        />
      </section>

      <section className="appearance-section appearance-wallpaper-section" id="appearance-wallpaper">
        <header className="appearance-section-heading">
          <span className="appearance-section-icon"><ImageIcon size={17} /></span>
          <div>
            <h3>{t('appearance.wallpaperTitle')}</h3>
            <p>{t('appearance.wallpaperDescription')}</p>
          </div>
          <ScopeBadge>{t('appearance.thisDevice')}</ScopeBadge>
        </header>

        <div className="appearance-wallpaper-layout">
          <div className="appearance-wallpaper-preview" style={appearanceBackground(appearance)}>
            <div className="appearance-preview-menubar"><span>FoxOS</span><span>● ● ●</span></div>
            <div className="appearance-preview-title">
              <strong>{t(currentWallpaper.nameKey)}</strong>
              <span>{t(currentWallpaper.descriptionKey)}</span>
            </div>
            <div className="appearance-preview-dock" aria-hidden="true"><i /><i /><i /><i /></div>
          </div>

          <div className="appearance-wallpaper-controls">
            <div className="appearance-wallpaper-choices" role="radiogroup" aria-label={t('appearance.wallpaperOptions')}>
              {WALLPAPER_PRESETS.map((preset) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={appearance.wallpaperId === preset.id}
                  className={appearance.wallpaperId === preset.id ? 'is-selected' : ''}
                  key={preset.id}
                  onClick={() => savePreference({ wallpaperId: preset.id })}
                >
                  <span style={{ backgroundImage: preset.backgroundImage, backgroundColor: preset.backgroundColor }}>
                    {appearance.wallpaperId === preset.id && <Check size={13} />}
                  </span>
                  <small>{t(preset.nameKey)}</small>
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={appearance.wallpaperId === 'custom'}
                className={appearance.wallpaperId === 'custom' ? 'is-selected' : ''}
                onClick={() => fileInputRef.current?.click()}
              >
                <span
                  className="is-upload"
                  style={appearance.customWallpaper ? { backgroundImage: `url(${JSON.stringify(appearance.customWallpaper)})` } : undefined}
                >
                  {appearance.wallpaperId === 'custom' ? <Check size={13} /> : <Upload size={14} />}
                </span>
                <small>{t('appearance.custom')}</small>
              </button>
              <input
                ref={fileInputRef}
                className="appearance-wallpaper-input"
                type="file"
                accept="image/avif,image/jpeg,image/png,image/webp"
                onChange={uploadWallpaper}
              />
            </div>
            <label className="appearance-range-row">
              <span><MonitorCog size={14} /> {t('appearance.dim')} <strong>%{appearance.dim}</strong></span>
              <input
                type="range"
                min="0"
                max="45"
                step="1"
                value={appearance.dim}
                onChange={(event) => savePreference({ dim: Number(event.target.value) })}
              />
            </label>
            <SwitchRow
              checked={appearance.useOnLockScreen}
              description={t('appearance.lockScreenDescription')}
              icon={Eye}
              label={t('appearance.useOnLockScreen')}
              onChange={(useOnLockScreen) => savePreference({ useOnLockScreen })}
            />
          </div>
        </div>
      </section>

      <div className="appearance-two-column">
        <section className="appearance-section" id="appearance-desktop">
          <header className="appearance-section-heading">
            <span className="appearance-section-icon"><Grid3X3 size={17} /></span>
            <div><h3>{t('appearance.desktopTitle')}</h3><p>{t('appearance.desktopDescription')}</p></div>
            <ScopeBadge>{t('appearance.thisDevice')}</ScopeBadge>
          </header>
          <div className="appearance-field">
            <label>{t('appearance.iconSize')}</label>
            <OptionGroup ariaLabel={t('appearance.iconSize')} options={sizeOptions} value={appearance.desktopIconSize} onChange={(desktopIconSize) => savePreference({ desktopIconSize })} />
          </div>
          <div className="appearance-field">
            <label>{t('appearance.gridDensity')}</label>
            <OptionGroup ariaLabel={t('appearance.gridDensity')} options={densityOptions} value={appearance.desktopGridDensity} onChange={(desktopGridDensity) => savePreference({ desktopGridDensity })} />
          </div>
          <SwitchRow
            checked={appearance.snapToGrid}
            description={t('appearance.snapDescription')}
            icon={Move}
            label={t('appearance.snapToGrid')}
            onChange={(snapToGrid) => savePreference({ snapToGrid })}
          />
        </section>

        <section className="appearance-section" id="appearance-dock">
          <header className="appearance-section-heading">
            <span className="appearance-section-icon"><PanelBottom size={17} /></span>
            <div><h3>{t('appearance.dockTitle')}</h3><p>{t('appearance.dockDescription')}</p></div>
            <ScopeBadge>{t('appearance.thisDevice')}</ScopeBadge>
          </header>
          <div className="appearance-field">
            <label>{t('appearance.dockSize')}</label>
            <OptionGroup ariaLabel={t('appearance.dockSize')} options={sizeOptions} value={appearance.dockSize} onChange={(dockSize) => savePreference({ dockSize })} />
          </div>
          <SwitchRow
            checked={appearance.dockAutoHide}
            description={t('appearance.autoHideDescription')}
            icon={PanelBottom}
            label={t('appearance.autoHideDock')}
            onChange={(dockAutoHide) => savePreference({ dockAutoHide })}
          />
        </section>
      </div>

      <div className="appearance-two-column">
        <section className="appearance-section" id="appearance-windows">
          <header className="appearance-section-heading">
            <span className="appearance-section-icon"><AppWindow size={17} /></span>
            <div><h3>{t('appearance.windowsTitle')}</h3><p>{t('appearance.windowsDescription')}</p></div>
            <ScopeBadge>{t('appearance.thisDevice')}</ScopeBadge>
          </header>
          <SwitchRow
            checked={appearance.rememberWindowLayout}
            description={t('appearance.rememberWindowsDescription')}
            icon={AppWindow}
            label={t('appearance.rememberWindows')}
            onChange={(rememberWindowLayout) => savePreference({ rememberWindowLayout }, { clearLayouts: !rememberWindowLayout })}
          />
          <SwitchRow
            checked={appearance.maximizeSmallWindows}
            description={t('appearance.maximizeSmallDescription')}
            icon={Smartphone}
            label={t('appearance.maximizeSmallWindows')}
            onChange={(maximizeSmallWindows) => savePreference({ maximizeSmallWindows })}
          />
        </section>

        <section className="appearance-section" id="appearance-accessibility">
          <header className="appearance-section-heading">
            <span className="appearance-section-icon"><Accessibility size={17} /></span>
            <div><h3>{t('appearance.accessibilityTitle')}</h3><p>{t('appearance.accessibilityDescription')}</p></div>
            <ScopeBadge>{t('appearance.thisDevice')}</ScopeBadge>
          </header>
          <div className="appearance-field">
            <label>{t('appearance.textSize')}</label>
            <OptionGroup
              ariaLabel={t('appearance.textSize')}
              options={[
                { value: 'standard', label: t('appearance.standard') },
                { value: 'large', label: t('appearance.largeText') }
              ]}
              value={appearance.textSize}
              onChange={(textSize) => savePreference({ textSize })}
            />
          </div>
          <SwitchRow checked={appearance.reduceMotion} description={t('appearance.reduceMotionDescription')} icon={Move} label={t('appearance.reduceMotion')} onChange={(reduceMotion) => savePreference({ reduceMotion })} />
          <SwitchRow checked={appearance.highContrast} description={t('appearance.highContrastDescription')} icon={Type} label={t('appearance.highContrast')} onChange={(highContrast) => savePreference({ highContrast })} />
        </section>
      </div>

      <footer className="appearance-footer">
        <div>
          <strong>{t('appearance.deviceOnlyTitle')}</strong>
          <span>{t('appearance.deviceOnlyDescription')}</span>
        </div>
        <button
          type="button"
          onClick={() => savePreference({ ...DEFAULT_APPEARANCE }, { clearLayouts: true })}
        >
          <RotateCcw size={14} /> {t('appearance.reset')}
        </button>
      </footer>

    </div>
  );
};

export default AppearanceSettings;
