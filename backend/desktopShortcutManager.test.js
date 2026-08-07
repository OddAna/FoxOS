const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDesktopShortcutManager } = require('./desktopShortcutManager');

test('desktop shortcut visibility defaults to visible and persists hidden choices', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shortcuts-'));
  const applicationId = 'res_' + 'a'.repeat(32);
  const manager = createDesktopShortcutManager({
    dataRoot,
    clock: () => new Date('2026-08-07T10:00:00.000Z')
  });

  assert.equal(manager.isVisible(applicationId), true);
  assert.deepEqual(manager.setVisible(applicationId, false), {
    applicationId,
    visible: false,
    updatedAt: '2026-08-07T10:00:00.000Z'
  });
  assert.equal(manager.isVisible(applicationId), false);
  assert.equal(fs.statSync(manager.paths.stateFile).mode & 0o777, 0o600);

  const reloaded = createDesktopShortcutManager({ dataRoot });
  assert.equal(reloaded.isVisible(applicationId), false);
  reloaded.setVisible(applicationId, true);
  assert.equal(reloaded.isVisible(applicationId), true);
});

test('desktop shortcut manager rejects invalid application IDs and visibility values', () => {
  const manager = createDesktopShortcutManager({
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shortcuts-'))
  });
  assert.throws(() => manager.setVisible('../bad', false), /kimliği geçersiz/);
  assert.throws(() => manager.setVisible('app_' + 'b'.repeat(32), 'false'), /true veya false/);
});

test('inactive applications default hidden but can be explicitly added to the desktop', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shortcuts-'));
  const applicationId = 'res_' + 'c'.repeat(32);
  const manager = createDesktopShortcutManager({ dataRoot });

  assert.equal(manager.isVisible(applicationId, false), false);
  manager.setVisible(applicationId, true);
  assert.equal(manager.isVisible(applicationId, false), true);
  manager.setVisible(applicationId, false);
  assert.equal(manager.isVisible(applicationId, true), false);
});

test('schema v1 shortcut state is read without losing existing hidden choices', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shortcuts-'));
  const stateFile = path.join(dataRoot, 'desktop-shortcuts', 'state.json');
  const hiddenId = 'res_' + 'd'.repeat(32);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-08-07T10:00:00.000Z',
    hiddenApplicationIds: [hiddenId]
  }));

  const manager = createDesktopShortcutManager({ dataRoot });
  assert.equal(manager.isVisible(hiddenId, true), false);
  assert.deepEqual(manager.state().visibleApplicationIds, []);
  manager.setVisible(hiddenId, true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).schemaVersion, 3);
});

test('schema v2 shortcut state upgrades without moving existing shortcuts', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shortcuts-'));
  const stateFile = path.join(dataRoot, 'desktop-shortcuts', 'state.json');
  const visibleId = 'res_' + 'e'.repeat(32);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    schemaVersion: 2,
    updatedAt: '2026-08-07T10:00:00.000Z',
    hiddenApplicationIds: [],
    visibleApplicationIds: [visibleId]
  }));

  const manager = createDesktopShortcutManager({ dataRoot });
  assert.equal(manager.location(visibleId), '/Masaüstü');
  manager.setLocation(visibleId, '/Masaüstü/Projeler');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.schemaVersion, 3);
  assert.equal(saved.applicationLocations[visibleId], '/Masaüstü/Projeler');
});

test('desktop shortcuts persist folder locations and return cleanly to the desktop root', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shortcuts-'));
  const applicationId = 'res_' + 'f'.repeat(32);
  const manager = createDesktopShortcutManager({
    dataRoot,
    clock: () => new Date('2026-08-07T11:00:00.000Z')
  });

  assert.equal(manager.location(applicationId), '/Masaüstü');
  assert.deepEqual(manager.setLocation(applicationId, 'Masaüstü/Müşteri Projeleri'), {
    applicationId,
    path: '/Masaüstü/Müşteri Projeleri',
    updatedAt: '2026-08-07T11:00:00.000Z'
  });
  assert.equal(manager.location(applicationId), '/Masaüstü/Müşteri Projeleri');

  manager.setLocation(applicationId, '/Masaüstü');
  assert.equal(manager.location(applicationId), '/Masaüstü');
  assert.equal(manager.state().applicationLocations[applicationId], undefined);
});

test('renaming or removing a desktop folder keeps contained application shortcuts reachable', () => {
  const manager = createDesktopShortcutManager({
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shortcuts-'))
  });
  const firstId = 'res_' + '1'.repeat(32);
  const secondId = 'res_' + '2'.repeat(32);
  const unrelatedId = 'res_' + '3'.repeat(32);
  manager.setLocation(firstId, '/Masaüstü/Eski');
  manager.setLocation(secondId, '/Masaüstü/Eski/Alt');
  manager.setLocation(unrelatedId, '/Masaüstü/Başka');

  assert.deepEqual(manager.relocateDirectory('/Masaüstü/Eski', '/Masaüstü/Yeni'), {
    moved: 2,
    source: '/Masaüstü/Eski',
    target: '/Masaüstü/Yeni'
  });
  assert.equal(manager.location(firstId), '/Masaüstü/Yeni');
  assert.equal(manager.location(secondId), '/Masaüstü/Yeni/Alt');
  assert.equal(manager.location(unrelatedId), '/Masaüstü/Başka');

  assert.deepEqual(manager.releaseDirectory('/Masaüstü/Yeni'), {
    released: 2,
    source: '/Masaüstü/Yeni',
    target: '/Masaüstü'
  });
  assert.equal(manager.location(firstId), '/Masaüstü');
  assert.equal(manager.location(secondId), '/Masaüstü');
  assert.equal(manager.location(unrelatedId), '/Masaüstü/Başka');
});

test('desktop shortcut manager rejects locations outside the desktop hierarchy', () => {
  const manager = createDesktopShortcutManager({
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-shortcuts-'))
  });
  const applicationId = 'res_' + '4'.repeat(32);

  assert.throws(
    () => manager.setLocation(applicationId, '/Belgeler'),
    (error) => error.code === 'invalid-shortcut-location'
  );
  assert.throws(
    () => manager.setLocation(applicationId, '/Masaüstü/../Belgeler'),
    (error) => error.code === 'invalid-shortcut-location'
  );
});
