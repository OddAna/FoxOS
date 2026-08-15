const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNotificationManager } = require('./notificationManager');
const { createWebPushManager } = require('./webPushManager');

const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/subscriptions/device-one',
  expirationTime: null,
  keys: { p256dh: 'A'.repeat(65), auth: 'B'.repeat(22) }
};

test('web push provisions owner-only VAPID keys and delivers redacted sensitive notifications', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-web-push-'));
  const calls = { details: [], sends: [] };
  try {
    const notifications = createNotificationManager({ dataRoot });
    const webPush = {
      generateVAPIDKeys: () => ({ publicKey: 'P'.repeat(65), privateKey: 'S'.repeat(44) }),
      setVapidDetails: (...args) => calls.details.push(args),
      sendNotification: async (...args) => calls.sends.push(args)
    };
    const manager = createWebPushManager({ dataRoot, notificationManager: notifications, webPush });
    assert.equal(manager.status().publicKey, 'P'.repeat(65));
    assert.equal(fs.statSync(manager.paths.configFile).mode & 0o777, 0o600);
    manager.subscribe(SUBSCRIPTION, 'Mobile Browser');

    const notification = notifications.create({
      source: 'mail',
      severity: 'warning',
      title: 'Gizli müşteri mesajı',
      body: 'Bu metin push içine girmemeli.',
      sensitive: true
    });
    const result = await manager.deliver(notification);
    assert.deepEqual(result, { delivered: 1, failed: 0, skipped: false, reason: null });
    assert.equal(calls.details.length, 1);
    assert.equal(calls.sends.length, 1);
    const payload = JSON.parse(calls.sends[0][1]);
    assert.equal(payload.title, 'FoxOS bildirimi');
    assert.equal(payload.body, 'Ayrıntıları görmek için FoxOS’u açın.');
    assert.equal(JSON.stringify(payload).includes('müşteri'), false);
    const receipt = notifications.list().items[0].deliveries.at(-1);
    assert.equal(receipt.channel, 'web-push');
    assert.equal(receipt.status, 'delivered');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('web push removes expired subscriptions without exposing provider errors', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-web-push-'));
  try {
    const notifications = createNotificationManager({ dataRoot });
    const webPush = {
      generateVAPIDKeys: () => ({ publicKey: 'P'.repeat(65), privateKey: 'S'.repeat(44) }),
      setVapidDetails: () => {},
      sendNotification: async () => {
        const error = new Error('provider secret response');
        error.statusCode = 410;
        throw error;
      }
    };
    const manager = createWebPushManager({ dataRoot, notificationManager: notifications, webPush });
    manager.subscribe(SUBSCRIPTION, 'Old Browser');
    const notification = notifications.create({ title: 'Test' });
    assert.deepEqual(await manager.deliver(notification), {
      delivered: 0,
      failed: 1,
      skipped: false,
      reason: null
    });
    assert.equal(manager.status().deviceCount, 0);
    assert.equal(JSON.stringify(notifications.list().items[0]).includes('provider secret response'), false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
