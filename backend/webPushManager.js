const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');
const { NotificationError } = require('./notificationManager');

const WEB_PUSH_SCHEMA_VERSION = 1;

function createWebPushManager({
  dataRoot,
  notificationManager,
  webPush = require('web-push'),
  clock = () => new Date(),
  subject = process.env.FOXOS_WEB_PUSH_SUBJECT || 'mailto:notifications@foxos.local'
}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new TypeError('Web Push manager requires an absolute data root');
  }
  if (!notificationManager || typeof notificationManager.subscriptions !== 'function') {
    throw new TypeError('Web Push manager requires a notification manager');
  }
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\//.test(subject)) {
    throw new TypeError('Web Push VAPID subject must be a mailto or HTTPS URL');
  }
  const configFile = path.join(dataRoot, 'notifications', 'web-push.json');
  let configuredKey = null;

  function now() {
    return new Date(clock()).toISOString();
  }

  function ensureConfig() {
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new NotificationError('Web Push anahtarı okunamadı.', 503, 'notification-web-push-config-invalid');
      }
      const keys = webPush.generateVAPIDKeys();
      config = {
        schemaVersion: WEB_PUSH_SCHEMA_VERSION,
        createdAt: now(),
        publicKey: keys.publicKey,
        privateKey: keys.privateKey
      };
      atomicWriteJson(configFile, config);
    }
    if (
      !config || config.schemaVersion !== WEB_PUSH_SCHEMA_VERSION ||
      typeof config.publicKey !== 'string' || !/^[A-Za-z0-9_-]{40,200}$/.test(config.publicKey) ||
      typeof config.privateKey !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(config.privateKey)
    ) {
      throw new NotificationError('Web Push anahtarı okunamadı.', 503, 'notification-web-push-config-invalid');
    }
    if (configuredKey !== config.publicKey) {
      webPush.setVapidDetails(subject, config.publicKey, config.privateKey);
      configuredKey = config.publicKey;
    }
    return config;
  }

  function status() {
    const config = ensureConfig();
    const settings = notificationManager.settings();
    const devices = notificationManager.pushDevices();
    return {
      supported: true,
      enabled: settings.browserPush.enabled,
      publicKey: config.publicKey,
      deviceCount: devices.length,
      devices
    };
  }

  function subscribe(subscription, userAgent) {
    ensureConfig();
    const device = notificationManager.upsertSubscription(subscription, userAgent);
    return { device, status: status() };
  }

  function unsubscribe(endpoint) {
    const result = notificationManager.removeSubscription(endpoint);
    return { ...result, status: status() };
  }

  async function deliver(notification) {
    const policy = notificationManager.pushPolicy(notification);
    if (!policy.deliver) {
      if (!['disabled', 'no-devices'].includes(policy.reason)) {
        notificationManager.recordDelivery(notification.id, {
          channel: 'web-push',
          status: 'skipped',
          deviceCount: 0,
          errorCode: policy.reason
        });
      }
      return { delivered: 0, failed: 0, skipped: true, reason: policy.reason };
    }
    ensureConfig();
    const subscriptions = notificationManager.subscriptions();
    const payload = JSON.stringify({
      id: notification.id,
      title: notification.sensitive ? 'FoxOS bildirimi' : notification.title,
      body: notification.sensitive ? 'Ayrıntıları görmek için FoxOS’u açın.' : notification.body,
      severity: notification.severity,
      tag: notification.dedupeKey || notification.id,
      target: notification.target || null,
      url: '/'
    });
    const results = await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification({
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime,
          keys: subscription.keys
        }, payload, {
          TTL: notification.severity === 'critical' ? 86_400 : 21_600,
          urgency: notification.severity === 'critical' ? 'high' : 'normal'
        });
        return { delivered: true };
      } catch (error) {
        const statusCode = Number(error && error.statusCode);
        if (statusCode === 404 || statusCode === 410) {
          notificationManager.removeSubscriptionById(subscription.id);
          return { delivered: false, expired: true };
        }
        return { delivered: false, expired: false };
      }
    }));
    const delivered = results.filter((result) => result.delivered).length;
    const failed = results.length - delivered;
    notificationManager.recordDelivery(notification.id, {
      channel: 'web-push',
      status: delivered > 0 ? 'delivered' : 'failed',
      deviceCount: delivered,
      errorCode: delivered > 0 ? null : 'delivery-failed'
    });
    return { delivered, failed, skipped: false, reason: null };
  }

  return {
    deliver,
    paths: { configFile },
    status,
    subscribe,
    unsubscribe
  };
}

module.exports = {
  WEB_PUSH_SCHEMA_VERSION,
  createWebPushManager
};
