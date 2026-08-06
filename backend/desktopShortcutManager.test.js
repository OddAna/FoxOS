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
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).schemaVersion, 2);
});
