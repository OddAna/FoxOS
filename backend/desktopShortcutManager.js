const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const DESKTOP_SHORTCUT_SCHEMA_VERSION = 2;
const APPLICATION_ID_PATTERN = /^(?:app|res)_[a-f0-9]{24,64}$/;

class DesktopShortcutError extends Error {
  constructor(message, statusCode = 400, code = 'desktop-shortcut-error') {
    super(message);
    this.name = 'DesktopShortcutError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function createDesktopShortcutManager({ dataRoot, clock = () => new Date() }) {
  if (!dataRoot) throw new Error('Desktop shortcut manager requires a data root');

  const stateFile = path.join(dataRoot, 'desktop-shortcuts', 'state.json');

  function now() {
    return new Date(clock()).toISOString();
  }

  function emptyState() {
    return {
      schemaVersion: DESKTOP_SHORTCUT_SCHEMA_VERSION,
      updatedAt: null,
      hiddenApplicationIds: [],
      visibleApplicationIds: []
    };
  }

  function state() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    const legacy = value.schemaVersion === 1;
    const hiddenApplicationIds = value.hiddenApplicationIds;
    const visibleApplicationIds = legacy ? [] : value.visibleApplicationIds;
    if (
      (!legacy && value.schemaVersion !== DESKTOP_SHORTCUT_SCHEMA_VERSION) ||
      !Array.isArray(hiddenApplicationIds) || !Array.isArray(visibleApplicationIds) ||
      [...hiddenApplicationIds, ...visibleApplicationIds]
        .some((id) => !APPLICATION_ID_PATTERN.test(String(id)))
    ) {
      throw new DesktopShortcutError(
        'Masaüstü kısayol tercihleri okunamadı.',
        503,
        'desktop-shortcut-state-invalid'
      );
    }
    return {
      schemaVersion: DESKTOP_SHORTCUT_SCHEMA_VERSION,
      updatedAt: value.updatedAt || null,
      hiddenApplicationIds: [...new Set(hiddenApplicationIds)].sort(),
      visibleApplicationIds: [...new Set(visibleApplicationIds)].sort()
    };
  }

  function isVisible(applicationId, defaultVisible = true) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) return defaultVisible;
    const current = state();
    if (current.visibleApplicationIds.includes(applicationId)) return true;
    if (current.hiddenApplicationIds.includes(applicationId)) return false;
    return defaultVisible;
  }

  function setVisible(applicationId, visible) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) {
      throw new DesktopShortcutError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    if (typeof visible !== 'boolean') {
      throw new DesktopShortcutError('Kısayol görünürlüğü true veya false olmalıdır.', 400, 'invalid-shortcut-visibility');
    }

    const current = state();
    const hidden = new Set(current.hiddenApplicationIds);
    const shown = new Set(current.visibleApplicationIds);
    if (visible) {
      hidden.delete(applicationId);
      shown.add(applicationId);
    } else {
      shown.delete(applicationId);
      hidden.add(applicationId);
    }
    const updated = {
      schemaVersion: DESKTOP_SHORTCUT_SCHEMA_VERSION,
      updatedAt: now(),
      hiddenApplicationIds: [...hidden].sort(),
      visibleApplicationIds: [...shown].sort()
    };
    atomicWriteJson(stateFile, updated);
    return {
      applicationId,
      visible,
      updatedAt: updated.updatedAt
    };
  }

  return {
    isVisible,
    paths: { stateFile },
    setVisible,
    state
  };
}

module.exports = {
  APPLICATION_ID_PATTERN,
  DESKTOP_SHORTCUT_SCHEMA_VERSION,
  DesktopShortcutError,
  createDesktopShortcutManager
};
