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
