const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNotificationManager } = require('./notificationManager');

const UUID = '12345678-1234-1234-1234-1234567890ab';
const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/subscriptions/device-one',
  expirationTime: null,
  keys: { p256dh: 'A'.repeat(65), auth: 'B'.repeat(22) }
};

test('notification hub persists, deduplicates and exposes owner-safe summaries', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-notifications-'));
  let current = new Date('2026-08-13T09:00:00.000Z');
  try {
    const manager = createNotificationManager({
      dataRoot,
      clock: () => current,
      randomUUID: () => UUID
    });
    const first = manager.create({
      source: 'backups',
      category: 'recovery',
      severity: 'warning',
      title: 'Yedekleme gecikti',
      body: 'Son başarılı yedek 18 saat önceydi.',
      dedupeKey: 'backup-late',
      target: { app: 'settings', tab: 'notifications' }
    });
    assert.equal(first.id, 'ntf_123456781234123412341234567890ab');
    assert.equal(fs.statSync(manager.paths.stateFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(manager.paths.stateFile)).mode & 0o777, 0o700);

    current = new Date('2026-08-13T10:00:00.000Z');
    const repeated = manager.create({
      source: 'backups',
      category: 'recovery',
      severity: 'critical',
      title: 'Yedekleme başarısız',
      body: 'Son deneme de tamamlanamadı.',
      dedupeKey: 'backup-late'
    });
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.occurrenceCount, 2);
    assert.equal(manager.list().items.length, 1);
    assert.deepEqual(manager.list().stats, {
      total: 1,
      unread: 1,
      criticalUnread: 1,
      snoozed: 0,
      resolved: 0,
      sources: 1
    });
    assert.deepEqual(manager.sources()[0], {
      id: 'backups',
      total: 1,
      unread: 1,
      latestAt: '2026-08-13T10:00:00.000Z',
      rule: { enabled: true, minimumSeverity: 'info' }
    });
    assert.equal(manager.resolveByDedupeKey({ source: 'backups', dedupeKey: 'backup-late' }).status, 'resolved');

    const reloaded = createNotificationManager({ dataRoot });
    assert.equal(reloaded.list().items[0].title, 'Yedekleme başarısız');
    assert.equal(reloaded.list().items[0].status, 'resolved');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('notification status, snooze, quiet hours and source policies are enforced', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-notifications-'));
  let current = new Date('2026-08-13T23:00:00.000Z');
  let uuidCounter = 0;
  try {
    const manager = createNotificationManager({
      dataRoot,
      clock: () => current,
      randomUUID: () => uuidCounter++ === 0
        ? UUID
        : '22345678-1234-1234-1234-1234567890ab'
    });
    const notification = manager.create({ source: 'calendar', title: 'Toplantı yaklaşıyor' });
    manager.upsertSubscription(SUBSCRIPTION, 'Test Browser');
    manager.updateSettings({
      minimumSeverity: 'info',
      quietHours: {
        enabled: true,
        start: '22:00',
        end: '08:00',
        timezone: 'UTC',
        criticalOverride: true
      },
      sourceRules: { calendar: { enabled: true, minimumSeverity: 'warning' } }
    });
    assert.deepEqual(manager.externalPolicy(notification), { deliver: false, reason: 'below-threshold' });
    assert.deepEqual(manager.pushPolicy(notification), { deliver: false, reason: 'below-threshold' });
    const critical = manager.create({ source: 'system', severity: 'critical', title: 'Disk dolmak üzere' });
    assert.deepEqual(manager.externalPolicy(critical), { deliver: true, reason: null });
    assert.deepEqual(manager.pushPolicy(critical), { deliver: true, reason: null });
    assert.equal(manager.recordDelivery(critical.id, {
      channel: 'telegram', status: 'delivered', deviceCount: 1
    }).channel, 'telegram');

    const snoozed = manager.updateStatus(notification.id, {
      status: 'snoozed',
      snoozedUntil: '2026-08-14T01:00:00.000Z'
    });
    assert.equal(snoozed.status, 'snoozed');
    assert.equal(manager.list({ status: 'snoozed' }).items.length, 1);
    current = new Date('2026-08-14T02:00:00.000Z');
    assert.equal(manager.list({ status: 'unread' }).items.length, 2);
    assert.equal(manager.readAll().changed, 2);
    assert.equal(manager.stats().unread, 0);
    assert.equal(manager.updateStatus(critical.id, { status: 'resolved' }).status, 'resolved');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('push secrets stay private and the local ingest token uses constant-time authentication', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-notifications-'));
  try {
    const manager = createNotificationManager({
      dataRoot,
      randomBytes: () => Buffer.alloc(32, 7)
    });
    manager.upsertSubscription(SUBSCRIPTION, 'Mobile Browser');
    assert.equal(manager.pushDevices().length, 1);
    assert.equal(manager.pushDevices()[0].endpoint, undefined);
    assert.equal(manager.pushDevices()[0].keys, undefined);
    assert.equal(manager.subscriptions()[0].endpoint, SUBSCRIPTION.endpoint);

    const token = manager.ensureIngestToken();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(manager.paths.ingestTokenFile).mode & 0o777, 0o600);
    assert.equal(manager.authenticateIngestToken(token), true);
    assert.equal(manager.authenticateIngestToken('nope'), false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
