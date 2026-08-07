const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const DESKTOP_SHORTCUT_SCHEMA_VERSION = 3;
const APPLICATION_ID_PATTERN = /^(?:app|res)_[a-f0-9]{24,64}$/;
const DESKTOP_ROOT = '/Masaüstü';

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
      visibleApplicationIds: [],
      applicationLocations: {}
    };
  }

  function normalizeLocation(value) {
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new DesktopShortcutError('Masaüstü klasörü geçersiz.', 400, 'invalid-shortcut-location');
    }
    const slashPath = value.trim().replace(/\\/g, '/');
    const segments = slashPath.split('/').filter(Boolean);
    if (
      segments[0] !== DESKTOP_ROOT.slice(1) ||
      segments.some((segment) => segment === '.' || segment === '..')
    ) {
      throw new DesktopShortcutError(
        'Uygulama kısayolu yalnız Masaüstü içindeki bir klasöre taşınabilir.',
        400,
        'invalid-shortcut-location'
      );
    }
    return '/' + segments.join('/');
  }

  function writeState(value) {
    const updated = {
      schemaVersion: DESKTOP_SHORTCUT_SCHEMA_VERSION,
      updatedAt: now(),
      hiddenApplicationIds: [...new Set(value.hiddenApplicationIds)].sort(),
      visibleApplicationIds: [...new Set(value.visibleApplicationIds)].sort(),
      applicationLocations: Object.fromEntries(
        Object.entries(value.applicationLocations || {}).sort(([left], [right]) => left.localeCompare(right))
      )
    };
    atomicWriteJson(stateFile, updated);
    return updated;
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
    const withoutLocations = value.schemaVersion === 1 || value.schemaVersion === 2;
    const hiddenApplicationIds = value.hiddenApplicationIds;
    const visibleApplicationIds = legacy ? [] : value.visibleApplicationIds;
    const applicationLocations = withoutLocations ? {} : value.applicationLocations;
    if (
      ![1, 2, DESKTOP_SHORTCUT_SCHEMA_VERSION].includes(value.schemaVersion) ||
      !Array.isArray(hiddenApplicationIds) || !Array.isArray(visibleApplicationIds) ||
      !applicationLocations || Array.isArray(applicationLocations) || typeof applicationLocations !== 'object' ||
      [...hiddenApplicationIds, ...visibleApplicationIds]
        .some((id) => !APPLICATION_ID_PATTERN.test(String(id))) ||
      Object.entries(applicationLocations).some(([id, location]) => (
        !APPLICATION_ID_PATTERN.test(String(id)) || normalizeLocation(location) !== location
      ))
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
      visibleApplicationIds: [...new Set(visibleApplicationIds)].sort(),
      applicationLocations: { ...applicationLocations }
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
    const updated = writeState({
      ...current,
      hiddenApplicationIds: [...hidden],
      visibleApplicationIds: [...shown]
    });
    return {
      applicationId,
      visible,
      updatedAt: updated.updatedAt
    };
  }

  function location(applicationId) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) return DESKTOP_ROOT;
    return state().applicationLocations[applicationId] || DESKTOP_ROOT;
  }

  function setLocation(applicationId, requestedLocation) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) {
      throw new DesktopShortcutError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    const shortcutLocation = normalizeLocation(requestedLocation);
    const current = state();
    const applicationLocations = { ...current.applicationLocations };
    if (shortcutLocation === DESKTOP_ROOT) delete applicationLocations[applicationId];
    else applicationLocations[applicationId] = shortcutLocation;
    const updated = writeState({ ...current, applicationLocations });
    return { applicationId, path: shortcutLocation, updatedAt: updated.updatedAt };
  }

  function forget(applicationId) {
    if (!APPLICATION_ID_PATTERN.test(String(applicationId || ''))) {
      throw new DesktopShortcutError('Uygulama kimliği geçersiz.', 400, 'invalid-application-id');
    }
    const current = state();
    const hiddenApplicationIds = current.hiddenApplicationIds.filter((id) => id !== applicationId);
    const visibleApplicationIds = current.visibleApplicationIds.filter((id) => id !== applicationId);
    const applicationLocations = { ...current.applicationLocations };
    delete applicationLocations[applicationId];
    const changed =
      hiddenApplicationIds.length !== current.hiddenApplicationIds.length ||
      visibleApplicationIds.length !== current.visibleApplicationIds.length ||
      Object.keys(applicationLocations).length !== Object.keys(current.applicationLocations).length;
    if (changed) {
      writeState({ ...current, hiddenApplicationIds, visibleApplicationIds, applicationLocations });
    }
    return { applicationId, forgotten: changed };
  }

  function relocateDirectory(sourceLocation, targetLocation) {
    const source = normalizeLocation(sourceLocation);
    const target = normalizeLocation(targetLocation);
    if (source === DESKTOP_ROOT) {
      throw new DesktopShortcutError('Masaüstü kökü taşınamaz.', 400, 'desktop-root-location-protected');
    }
    const current = state();
    let moved = 0;
    const applicationLocations = Object.fromEntries(
      Object.entries(current.applicationLocations).map(([applicationId, applicationLocation]) => {
        if (applicationLocation !== source && !applicationLocation.startsWith(source + '/')) {
          return [applicationId, applicationLocation];
        }
        moved += 1;
        return [applicationId, target + applicationLocation.slice(source.length)];
      })
    );
    if (moved > 0) writeState({ ...current, applicationLocations });
    return { moved, source, target };
  }

  function releaseDirectory(sourceLocation) {
    const source = normalizeLocation(sourceLocation);
    if (source === DESKTOP_ROOT) {
      throw new DesktopShortcutError('Masaüstü kökü bırakılamaz.', 400, 'desktop-root-location-protected');
    }
    const current = state();
    let released = 0;
    const applicationLocations = { ...current.applicationLocations };
    Object.entries(applicationLocations).forEach(([applicationId, applicationLocation]) => {
      if (applicationLocation === source || applicationLocation.startsWith(source + '/')) {
        delete applicationLocations[applicationId];
        released += 1;
      }
    });
    if (released > 0) writeState({ ...current, applicationLocations });
    return { released, source, target: DESKTOP_ROOT };
  }

  return {
    forget,
    isVisible,
    location,
    normalizeLocation,
    paths: { stateFile },
    releaseDirectory,
    relocateDirectory,
    setLocation,
    setVisible,
    state
  };
}

module.exports = {
  APPLICATION_ID_PATTERN,
  DESKTOP_ROOT,
  DESKTOP_SHORTCUT_SCHEMA_VERSION,
  DesktopShortcutError,
  createDesktopShortcutManager
};
