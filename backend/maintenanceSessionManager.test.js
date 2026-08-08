const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMaintenanceSessionManager } = require('./maintenanceSessionManager');

test('a local maintenance grant is owner-only, short-lived and consumed exactly once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-maintenance-session-'));
  let current = new Date('2026-08-07T11:00:00.000Z');
  const manager = createMaintenanceSessionManager({
    dataRoot: root,
    clock: () => current,
    randomBytes: () => Buffer.alloc(32, 7)
  });
  try {
    const grant = manager.issue();
    assert.equal(fs.statSync(manager.paths.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(manager.paths.grantFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(manager.paths.grantFile, 'utf8').includes(grant.token), false);
    assert.equal(manager.consume(grant.token).consumed, true);
    assert.throws(() => manager.consume(grant.token), (error) => error.code === 'maintenance-grant-unavailable');

    const expired = manager.issue();
    current = new Date('2026-08-07T11:06:00.000Z');
    assert.throws(() => manager.consume(expired.token), (error) => error.code === 'maintenance-grant-invalid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
