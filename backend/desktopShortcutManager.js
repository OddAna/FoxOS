const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const DESKTOP_SHORTCUT_SCHEMA_VERSION = 1;
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
      hiddenApplicationIds: []
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
    if (
      value.schemaVersion !== DESKTOP_SHORTCUT_SCHEMA_VERSION ||
      !Array.isArray(value.hiddenApplicationIds) ||
      value.hiddenApplicationIds.some((id) => !APPLICATION_ID_PATTERN.test(String(id)))
    ) {
      throw new DesktopShortcutError(
        'Masaüstü kısayol tercihleri okunamadı.',
        503,
        'desktop-shortcut-state-invalid'
      );
    }
    return value;
  }

  function isVisible(applicationId) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) return true;
    return !state().hiddenApplicationIds.includes(applicationId);
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
    if (visible) hidden.delete(applicationId);
    else hidden.add(applicationId);
    const updated = {
      schemaVersion: DESKTOP_SHORTCUT_SCHEMA_VERSION,
      updatedAt: now(),
      hiddenApplicationIds: [...hidden].sort()
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
