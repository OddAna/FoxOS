const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { atomicWriteJson } = require('./resourceRegistry');

const NOTIFICATION_SCHEMA_VERSION = 1;
const NOTIFICATION_ID_PATTERN = /^ntf_[a-f0-9]{32}$/;
const SEVERITIES = ['info', 'success', 'warning', 'critical'];
const SEVERITY_RANK = new Map(SEVERITIES.map((severity, index) => [severity, index]));
const STATUSES = new Set(['unread', 'read', 'snoozed', 'resolved']);
const DELIVERY_STATUSES = new Set(['delivered', 'failed', 'pending', 'skipped']);
const MAX_NOTIFICATIONS = 2_000;
const MAX_SUBSCRIPTIONS = 25;

class NotificationError extends Error {
  constructor(message, statusCode = 400, code = 'notification-error') {
    super(message);
    this.name = 'NotificationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function boundedText(value, { label, maximum, required = false, multiline = false }) {
  if (value === undefined || value === null) {
    if (required) throw new NotificationError(`${label} zorunludur.`, 400, 'notification-field-required');
    return '';
  }
  if (typeof value !== 'string') {
    throw new NotificationError(`${label} geçersiz.`, 400, 'notification-field-invalid');
  }
  const text = value.trim();
  if (
    (required && !text) || text.length > maximum || text.includes('\0') ||
    (!multiline && /[\r\n]/.test(text))
  ) {
    throw new NotificationError(`${label} geçersiz.`, 400, 'notification-field-invalid');
  }
  return text;
}

function normalizeSlug(value, label, fallback = null) {
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  const slug = boundedText(candidate, { label, maximum: 64, required: true }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) {
    throw new NotificationError(`${label} geçersiz.`, 400, 'notification-slug-invalid');
  }
  return slug;
}

function normalizeSeverity(value, fallback = 'info') {
  const severity = value === undefined || value === null || value === '' ? fallback : String(value);
  if (!SEVERITY_RANK.has(severity)) {
    throw new NotificationError('Bildirim önceliği geçersiz.', 400, 'notification-severity-invalid');
  }
  return severity;
}

function normalizeTime(value, label) {
  const time = boundedText(value, { label, maximum: 5, required: true });
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new NotificationError(`${label} geçersiz.`, 400, 'notification-time-invalid');
  }
  return time;
}

function normalizeTimezone(value) {
  const timezone = boundedText(value, { label: 'Saat dilimi', maximum: 100, required: true });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new NotificationError('Saat dilimi geçersiz.', 400, 'notification-timezone-invalid');
  }
  return timezone;
}

function defaultSettings() {
  return {
    minimumSeverity: 'info',
    browserPush: { enabled: false },
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '08:00',
      timezone: 'UTC',
      criticalOverride: true
    },
    sourceRules: {}
  };
}

function normalizeSettings(input, base = defaultSettings()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NotificationError('Bildirim ayarları geçersiz.', 400, 'notification-settings-invalid');
  }
  const browserPushInput = input.browserPush === undefined ? base.browserPush : input.browserPush;
  const quietHoursInput = input.quietHours === undefined ? base.quietHours : input.quietHours;
  const sourceRulesInput = input.sourceRules === undefined ? base.sourceRules : input.sourceRules;
  if (!browserPushInput || typeof browserPushInput !== 'object' || Array.isArray(browserPushInput)) {
    throw new NotificationError('Tarayıcı bildirim ayarı geçersiz.', 400, 'notification-settings-invalid');
  }
  if (!quietHoursInput || typeof quietHoursInput !== 'object' || Array.isArray(quietHoursInput)) {
    throw new NotificationError('Sessiz saat ayarı geçersiz.', 400, 'notification-settings-invalid');
  }
  if (!sourceRulesInput || typeof sourceRulesInput !== 'object' || Array.isArray(sourceRulesInput)) {
    throw new NotificationError('Bildirim kaynağı kuralları geçersiz.', 400, 'notification-settings-invalid');
  }
  const browserPushEnabled = browserPushInput.enabled === undefined
    ? base.browserPush.enabled
    : browserPushInput.enabled;
  const quietHoursEnabled = quietHoursInput.enabled === undefined
    ? base.quietHours.enabled
    : quietHoursInput.enabled;
  const criticalOverride = quietHoursInput.criticalOverride === undefined
    ? base.quietHours.criticalOverride
    : quietHoursInput.criticalOverride;
  if (
    typeof browserPushEnabled !== 'boolean' || typeof quietHoursEnabled !== 'boolean' ||
    typeof criticalOverride !== 'boolean'
  ) {
    throw new NotificationError('Bildirim ayarları geçersiz.', 400, 'notification-settings-invalid');
  }

  const sourceRules = {};
  const entries = Object.entries(sourceRulesInput);
  if (entries.length > 100) {
    throw new NotificationError('Bildirim kaynağı sınırı aşıldı.', 400, 'notification-source-limit');
  }
  for (const [source, rule] of entries) {
    const normalizedSource = normalizeSlug(source, 'Bildirim kaynağı');
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new NotificationError('Bildirim kaynağı kuralı geçersiz.', 400, 'notification-source-rule-invalid');
    }
    const enabled = rule.enabled === undefined ? true : rule.enabled;
    if (typeof enabled !== 'boolean') {
      throw new NotificationError('Bildirim kaynağı kuralı geçersiz.', 400, 'notification-source-rule-invalid');
    }
    sourceRules[normalizedSource] = {
      enabled,
      minimumSeverity: normalizeSeverity(rule.minimumSeverity, 'info')
    };
  }

  return {
    minimumSeverity: normalizeSeverity(input.minimumSeverity, base.minimumSeverity),
    browserPush: { enabled: browserPushEnabled },
    quietHours: {
      enabled: quietHoursEnabled,
      start: normalizeTime(quietHoursInput.start ?? base.quietHours.start, 'Sessiz saat başlangıcı'),
      end: normalizeTime(quietHoursInput.end ?? base.quietHours.end, 'Sessiz saat bitişi'),
      timezone: normalizeTimezone(quietHoursInput.timezone ?? base.quietHours.timezone),
      criticalOverride
    },
    sourceRules
  };
}

function normalizeTarget(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NotificationError('Bildirim hedefi geçersiz.', 400, 'notification-target-invalid');
  }
  const app = normalizeSlug(value.app, 'Bildirim hedefi');
  const tab = value.tab === undefined || value.tab === null || value.tab === ''
    ? null
    : normalizeSlug(value.tab, 'Bildirim hedef sekmesi');
  const date = value.date === undefined || value.date === null || value.date === ''
    ? null
    : boundedText(value.date, { label: 'Bildirim hedef tarihi', maximum: 10, required: true });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new NotificationError('Bildirim hedef tarihi geçersiz.', 400, 'notification-target-invalid');
  }
  return { app, tab, date };
}

function normalizeNotificationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NotificationError('Bildirim bilgileri geçersiz.', 400, 'notification-invalid');
  }
  const sensitive = input.sensitive === undefined ? false : input.sensitive;
  if (typeof sensitive !== 'boolean') {
    throw new NotificationError('Bildirim gizlilik ayarı geçersiz.', 400, 'notification-sensitive-invalid');
  }
  return {
    source: normalizeSlug(input.source, 'Bildirim kaynağı', 'foxos'),
    category: normalizeSlug(input.category, 'Bildirim kategorisi', 'system'),
    severity: normalizeSeverity(input.severity),
    title: boundedText(input.title, { label: 'Bildirim başlığı', maximum: 140, required: true }),
    body: boundedText(input.body, { label: 'Bildirim metni', maximum: 2_000, multiline: true }),
    dedupeKey: boundedText(input.dedupeKey, { label: 'Tekilleştirme anahtarı', maximum: 180 }) || null,
    threadId: boundedText(input.threadId, { label: 'Bildirim zinciri', maximum: 180 }) || null,
    target: normalizeTarget(input.target),
    sensitive
  };
}

function normalizeSubscription(input, { userAgent = '', createdAt }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NotificationError('Push aboneliği geçersiz.', 400, 'notification-push-subscription-invalid');
  }
  const endpoint = boundedText(input.endpoint, {
    label: 'Push aboneliği', maximum: 2_048, required: true
  });
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new NotificationError('Push aboneliği geçersiz.', 400, 'notification-push-subscription-invalid');
  }
  const keys = input.keys;
  const p256dh = keys && boundedText(keys.p256dh, {
    label: 'Push şifreleme anahtarı', maximum: 256, required: true
  });
  const auth = keys && boundedText(keys.auth, {
    label: 'Push doğrulama anahtarı', maximum: 128, required: true
  });
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh || '') || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth || '')
  ) {
    throw new NotificationError('Push aboneliği geçersiz.', 400, 'notification-push-subscription-invalid');
  }
  const expirationTime = input.expirationTime === null || input.expirationTime === undefined
    ? null
    : Number(input.expirationTime);
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= 0)) {
    throw new NotificationError('Push aboneliği geçersiz.', 400, 'notification-push-subscription-invalid');
  }
  return {
    id: 'push_' + crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 32),
    endpoint,
    expirationTime,
    keys: { p256dh, auth },
    userAgent: boundedText(userAgent, { label: 'Tarayıcı bilgisi', maximum: 300 }),
    createdAt,
    updatedAt: createdAt
  };
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function publicNotification(notification, nowMs = Date.now()) {
  const snoozeExpired = notification.status === 'snoozed' && Date.parse(notification.snoozedUntil) <= nowMs;
  return {
    ...notification,
    status: snoozeExpired ? 'unread' : notification.status,
    snoozedUntil: snoozeExpired ? null : notification.snoozedUntil
  };
}

function createNotificationManager({
  dataRoot,
  clock = () => new Date(),
  randomUUID = crypto.randomUUID,
  randomBytes = crypto.randomBytes
}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new TypeError('Notification manager requires an absolute data root');
  }
  const stateFile = path.join(dataRoot, 'notifications', 'state.json');
  const ingestTokenFile = path.join(dataRoot, 'notifications', 'ingest-token.json');
  const events = new EventEmitter();
  events.setMaxListeners(100);

  function nowDate() {
    return new Date(clock());
  }

  function now() {
    return nowDate().toISOString();
  }

  function emptyState() {
    return {
      schemaVersion: NOTIFICATION_SCHEMA_VERSION,
      updatedAt: null,
      settings: defaultSettings(),
      notifications: [],
      subscriptions: []
    };
  }

  function readState() {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw new NotificationError('Bildirim verisi okunamadı.', 503, 'notification-state-invalid');
    }
    if (
      !payload || payload.schemaVersion !== NOTIFICATION_SCHEMA_VERSION ||
      !Array.isArray(payload.notifications) || payload.notifications.length > MAX_NOTIFICATIONS ||
      !Array.isArray(payload.subscriptions) || payload.subscriptions.length > MAX_SUBSCRIPTIONS
    ) {
      throw new NotificationError('Bildirim verisi okunamadı.', 503, 'notification-state-invalid');
    }
    let settings;
    try {
      settings = normalizeSettings(payload.settings || {}, defaultSettings());
    } catch {
      throw new NotificationError('Bildirim verisi okunamadı.', 503, 'notification-state-invalid');
    }
    for (const notification of payload.notifications) {
      if (
        !notification || !NOTIFICATION_ID_PATTERN.test(String(notification.id || '')) ||
        !validTimestamp(notification.createdAt) || !validTimestamp(notification.updatedAt) ||
        !validTimestamp(notification.lastOccurredAt) || !STATUSES.has(notification.status) ||
        !Number.isSafeInteger(notification.occurrenceCount) || notification.occurrenceCount < 1 ||
        !Array.isArray(notification.deliveries)
      ) {
        throw new NotificationError('Bildirim verisi okunamadı.', 503, 'notification-state-invalid');
      }
      try {
        normalizeNotificationInput(notification);
      } catch {
        throw new NotificationError('Bildirim verisi okunamadı.', 503, 'notification-state-invalid');
      }
    }
    for (const subscription of payload.subscriptions) {
      try {
        const normalized = normalizeSubscription(subscription, {
          userAgent: subscription.userAgent,
          createdAt: subscription.createdAt
        });
        if (normalized.id !== subscription.id || !validTimestamp(subscription.updatedAt)) throw new Error('invalid');
      } catch {
        throw new NotificationError('Bildirim verisi okunamadı.', 503, 'notification-state-invalid');
      }
    }
    return {
      schemaVersion: NOTIFICATION_SCHEMA_VERSION,
      updatedAt: payload.updatedAt || null,
      settings,
      notifications: payload.notifications,
      subscriptions: payload.subscriptions
    };
  }

  function persist(nextState, changeType = 'changed') {
    const updatedAt = now();
    const notifications = [...nextState.notifications]
      .sort((left, right) => right.lastOccurredAt.localeCompare(left.lastOccurredAt))
      .slice(0, MAX_NOTIFICATIONS);
    atomicWriteJson(stateFile, {
      schemaVersion: NOTIFICATION_SCHEMA_VERSION,
      updatedAt,
      settings: nextState.settings,
      notifications,
      subscriptions: nextState.subscriptions
    });
    events.emit('change', { type: changeType, updatedAt });
    return { ...nextState, notifications, updatedAt };
  }

  function statsFrom(current) {
    const nowMs = nowDate().getTime();
    const visible = current.notifications.map((notification) => publicNotification(notification, nowMs));
    const unread = visible.filter((notification) => notification.status === 'unread');
    return {
      total: visible.length,
      unread: unread.length,
      criticalUnread: unread.filter((notification) => notification.severity === 'critical').length,
      snoozed: visible.filter((notification) => notification.status === 'snoozed').length,
      resolved: visible.filter((notification) => notification.status === 'resolved').length,
      sources: new Set(visible.map((notification) => notification.source)).size
    };
  }

  function stats() {
    return statsFrom(readState());
  }

  function list({ status = 'all', limit = 50, source = null } = {}) {
    if (!['all', ...STATUSES].includes(status)) {
      throw new NotificationError('Bildirim durumu geçersiz.', 400, 'notification-status-invalid');
    }
    const boundedLimit = Number(limit);
    if (!Number.isSafeInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 200) {
      throw new NotificationError('Bildirim liste sınırı geçersiz.', 400, 'notification-limit-invalid');
    }
    const normalizedSource = source ? normalizeSlug(source, 'Bildirim kaynağı') : null;
    const current = readState();
    const nowMs = nowDate().getTime();
    const items = current.notifications
      .map((notification) => publicNotification(notification, nowMs))
      .filter((notification) => status === 'all' || notification.status === status)
      .filter((notification) => !normalizedSource || notification.source === normalizedSource)
      .slice(0, boundedLimit);
    return { items, stats: statsFrom(current), updatedAt: current.updatedAt };
  }

  function get(notificationId) {
    if (!NOTIFICATION_ID_PATTERN.test(String(notificationId || ''))) {
      throw new NotificationError('Bildirim kimliği geçersiz.', 400, 'notification-id-invalid');
    }
    const notification = readState().notifications.find((entry) => entry.id === notificationId);
    if (!notification) throw new NotificationError('Bildirim bulunamadı.', 404, 'notification-not-found');
    return publicNotification(notification, nowDate().getTime());
  }

  function create(input) {
    const normalized = normalizeNotificationInput(input);
    const current = readState();
    const timestamp = now();
    const existing = normalized.dedupeKey
      ? current.notifications.find((notification) => (
        notification.source === normalized.source &&
        notification.dedupeKey === normalized.dedupeKey &&
        notification.status !== 'resolved'
      ))
      : null;
    let notification;
    let nextNotifications;
    if (existing) {
      notification = {
        ...existing,
        ...normalized,
        status: 'unread',
        readAt: null,
        resolvedAt: null,
        snoozedUntil: null,
        occurrenceCount: existing.occurrenceCount + 1,
        lastOccurredAt: timestamp,
        updatedAt: timestamp,
        deliveries: [
          ...existing.deliveries.slice(-19),
          { channel: 'in-app', status: 'delivered', attemptedAt: timestamp, deliveredAt: timestamp }
        ]
      };
      nextNotifications = current.notifications.map((entry) => entry.id === existing.id ? notification : entry);
    } else {
      notification = {
        id: 'ntf_' + randomUUID().replace(/-/g, '').toLowerCase(),
        ...normalized,
        status: 'unread',
        occurrenceCount: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOccurredAt: timestamp,
        readAt: null,
        resolvedAt: null,
        snoozedUntil: null,
        deliveries: [
          { channel: 'in-app', status: 'delivered', attemptedAt: timestamp, deliveredAt: timestamp }
        ]
      };
      nextNotifications = [notification, ...current.notifications];
    }
    persist({ ...current, notifications: nextNotifications }, existing ? 'notification-updated' : 'notification-created');
    events.emit('notification', notification);
    return notification;
  }

  function updateStatus(notificationId, input) {
    if (!NOTIFICATION_ID_PATTERN.test(String(notificationId || ''))) {
      throw new NotificationError('Bildirim kimliği geçersiz.', 400, 'notification-id-invalid');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || !STATUSES.has(input.status)) {
      throw new NotificationError('Bildirim durumu geçersiz.', 400, 'notification-status-invalid');
    }
    const current = readState();
    const existing = current.notifications.find((notification) => notification.id === notificationId);
    if (!existing) throw new NotificationError('Bildirim bulunamadı.', 404, 'notification-not-found');
    const timestamp = now();
    let snoozedUntil = null;
    if (input.status === 'snoozed') {
      snoozedUntil = boundedText(input.snoozedUntil, {
        label: 'Erteleme zamanı', maximum: 40, required: true
      });
      const snoozeMs = Date.parse(snoozedUntil);
      const nowMs = nowDate().getTime();
      if (!Number.isFinite(snoozeMs) || snoozeMs <= nowMs || snoozeMs > nowMs + 30 * 86_400_000) {
        throw new NotificationError('Erteleme zamanı geçersiz.', 400, 'notification-snooze-invalid');
      }
      snoozedUntil = new Date(snoozeMs).toISOString();
    }
    const updated = {
      ...existing,
      status: input.status,
      updatedAt: timestamp,
      readAt: input.status === 'read' || input.status === 'resolved' ? timestamp : null,
      resolvedAt: input.status === 'resolved' ? timestamp : null,
      snoozedUntil
    };
    persist({
      ...current,
      notifications: current.notifications.map((notification) => notification.id === notificationId ? updated : notification)
    }, 'notification-status');
    const visible = publicNotification(updated, nowDate().getTime());
    events.emit('status', visible);
    return visible;
  }

  function resolveByDedupeKey(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new NotificationError('Bildirim çözüm bilgisi geçersiz.', 400, 'notification-resolve-invalid');
    }
    const source = normalizeSlug(input.source, 'Bildirim kaynağı');
    const dedupeKey = boundedText(input.dedupeKey, {
      label: 'Tekilleştirme anahtarı', maximum: 180, required: true
    });
    const existing = readState().notifications.find((notification) => (
      notification.source === source && notification.dedupeKey === dedupeKey && notification.status !== 'resolved'
    ));
    if (!existing) throw new NotificationError('Bildirim bulunamadı.', 404, 'notification-not-found');
    return updateStatus(existing.id, { status: 'resolved' });
  }

  function readAll() {
    const current = readState();
    const timestamp = now();
    let changed = 0;
    const notifications = current.notifications.map((notification) => {
      const visible = publicNotification(notification, nowDate().getTime());
      if (visible.status !== 'unread') return notification;
      changed += 1;
      return { ...notification, status: 'read', readAt: timestamp, snoozedUntil: null, updatedAt: timestamp };
    });
    if (changed) persist({ ...current, notifications }, 'notifications-read');
    return { changed, stats: changed ? statsFrom({ ...current, notifications }) : statsFrom(current) };
  }

  function updateSettings(input) {
    const current = readState();
    const settings = normalizeSettings(input, current.settings);
    persist({ ...current, settings }, 'settings-updated');
    return settings;
  }

  function settings() {
    return readState().settings;
  }

  function sources() {
    const current = readState();
    const summaries = new Map();
    const nowMs = nowDate().getTime();
    for (const raw of current.notifications) {
      const notification = publicNotification(raw, nowMs);
      const summary = summaries.get(notification.source) || {
        id: notification.source,
        total: 0,
        unread: 0,
        latestAt: notification.lastOccurredAt
      };
      summary.total += 1;
      if (notification.status === 'unread') summary.unread += 1;
      if (notification.lastOccurredAt > summary.latestAt) summary.latestAt = notification.lastOccurredAt;
      summaries.set(notification.source, summary);
    }
    return [...summaries.values()]
      .map((summary) => ({
        ...summary,
        rule: current.settings.sourceRules[summary.id] || { enabled: true, minimumSeverity: 'info' }
      }))
      .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
  }

  function upsertSubscription(input, userAgent = '') {
    const current = readState();
    const timestamp = now();
    const normalized = normalizeSubscription(input, { userAgent, createdAt: timestamp });
    const existing = current.subscriptions.find((subscription) => subscription.id === normalized.id);
    const subscription = existing
      ? { ...normalized, createdAt: existing.createdAt, updatedAt: timestamp }
      : normalized;
    const subscriptions = [
      subscription,
      ...current.subscriptions.filter((entry) => entry.id !== subscription.id)
    ];
    if (subscriptions.length > MAX_SUBSCRIPTIONS) {
      throw new NotificationError('Push cihazı sınırına ulaşıldı.', 409, 'notification-push-subscription-limit');
    }
    const settings = {
      ...current.settings,
      browserPush: { enabled: true }
    };
    persist({ ...current, settings, subscriptions }, 'push-subscribed');
    return { id: subscription.id, createdAt: subscription.createdAt, updatedAt: subscription.updatedAt };
  }

  function removeSubscription(endpoint) {
    const current = readState();
    const normalizedEndpoint = boundedText(endpoint, {
      label: 'Push aboneliği', maximum: 2_048, required: true
    });
    const subscriptions = current.subscriptions.filter((subscription) => subscription.endpoint !== normalizedEndpoint);
    const removed = current.subscriptions.length - subscriptions.length;
    const settings = subscriptions.length === 0
      ? { ...current.settings, browserPush: { enabled: false } }
      : current.settings;
    if (removed) persist({ ...current, settings, subscriptions }, 'push-unsubscribed');
    return { removed };
  }

  function removeSubscriptionById(subscriptionId) {
    const current = readState();
    const subscriptions = current.subscriptions.filter((subscription) => subscription.id !== subscriptionId);
    if (subscriptions.length === current.subscriptions.length) return { removed: 0 };
    const settings = subscriptions.length === 0
      ? { ...current.settings, browserPush: { enabled: false } }
      : current.settings;
    persist({ ...current, settings, subscriptions }, 'push-unsubscribed');
    return { removed: 1 };
  }

  function subscriptions() {
    return readState().subscriptions.map((subscription) => ({
      id: subscription.id,
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: { ...subscription.keys },
      userAgent: subscription.userAgent,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt
    }));
  }

  function pushDevices() {
    return readState().subscriptions.map((subscription) => ({
      id: subscription.id,
      userAgent: subscription.userAgent,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt
    }));
  }

  function quietHoursActive(settingsValue, date = nowDate()) {
    const quiet = settingsValue.quietHours;
    if (!quiet.enabled) return false;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: quiet.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const current = hour * 60 + minute;
    const [startHour, startMinute] = quiet.start.split(':').map(Number);
    const [endHour, endMinute] = quiet.end.split(':').map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    if (start === end) return true;
    return start < end ? current >= start && current < end : current >= start || current < end;
  }

  function externalPolicy(notification) {
    const current = readState();
    const sourceRule = current.settings.sourceRules[notification.source] || {
      enabled: true,
      minimumSeverity: 'info'
    };
    if (!sourceRule.enabled) return { deliver: false, reason: 'source-muted' };
    const minimumRank = Math.max(
      SEVERITY_RANK.get(current.settings.minimumSeverity),
      SEVERITY_RANK.get(sourceRule.minimumSeverity)
    );
    if (SEVERITY_RANK.get(notification.severity) < minimumRank) {
      return { deliver: false, reason: 'below-threshold' };
    }
    if (
      quietHoursActive(current.settings) &&
      !(notification.severity === 'critical' && current.settings.quietHours.criticalOverride)
    ) {
      return { deliver: false, reason: 'quiet-hours' };
    }
    return { deliver: true, reason: null };
  }

  function pushPolicy(notification) {
    const current = readState();
    if (!current.settings.browserPush.enabled) return { deliver: false, reason: 'disabled' };
    if (!current.subscriptions.length) return { deliver: false, reason: 'no-devices' };
    return externalPolicy(notification);
  }

  function recordDelivery(notificationId, delivery) {
    if (!NOTIFICATION_ID_PATTERN.test(String(notificationId || ''))) return null;
    if (
      !delivery || typeof delivery !== 'object' ||
      !['web-push', 'telegram'].includes(delivery.channel) || !DELIVERY_STATUSES.has(delivery.status)
    ) return null;
    const current = readState();
    const existing = current.notifications.find((notification) => notification.id === notificationId);
    if (!existing) return null;
    const timestamp = now();
    const receipt = {
      channel: delivery.channel,
      status: delivery.status,
      attemptedAt: timestamp,
      deliveredAt: delivery.status === 'delivered' ? timestamp : null,
      deviceCount: Number.isSafeInteger(delivery.deviceCount) ? Math.max(0, delivery.deviceCount) : null,
      errorCode: delivery.errorCode
        ? boundedText(delivery.errorCode, { label: 'Teslimat hatası', maximum: 80 })
        : null
    };
    const updated = {
      ...existing,
      updatedAt: timestamp,
      deliveries: [...existing.deliveries.slice(-19), receipt]
    };
    persist({
      ...current,
      notifications: current.notifications.map((notification) => notification.id === notificationId ? updated : notification)
    }, 'delivery-updated');
    return receipt;
  }

  function ensureIngestToken() {
    try {
      const payload = JSON.parse(fs.readFileSync(ingestTokenFile, 'utf8'));
      if (
        payload && payload.schemaVersion === 1 && typeof payload.token === 'string' &&
        /^[a-f0-9]{64}$/.test(payload.token)
      ) return payload.token;
      throw new Error('invalid');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new NotificationError('Bildirim giriş anahtarı okunamadı.', 503, 'notification-ingest-token-invalid');
      }
    }
    const token = randomBytes(32).toString('hex');
    atomicWriteJson(ingestTokenFile, {
      schemaVersion: 1,
      createdAt: now(),
      token
    });
    return token;
  }

  function authenticateIngestToken(candidate) {
    if (typeof candidate !== 'string') return false;
    const expected = Buffer.from(ensureIngestToken(), 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  return {
    authenticateIngestToken,
    create,
    ensureIngestToken,
    externalPolicy,
    get,
    list,
    onChange: (listener) => {
      events.on('change', listener);
      return () => events.off('change', listener);
    },
    onNotification: (listener) => {
      events.on('notification', listener);
      return () => events.off('notification', listener);
    },
    onStatus: (listener) => {
      events.on('status', listener);
      return () => events.off('status', listener);
    },
    paths: { ingestTokenFile, stateFile },
    pushDevices,
    pushPolicy,
    readAll,
    recordDelivery,
    removeSubscription,
    removeSubscriptionById,
    resolveByDedupeKey,
    settings,
    sources,
    stats,
    subscriptions,
    updateSettings,
    updateStatus,
    upsertSubscription
  };
}

module.exports = {
  MAX_NOTIFICATIONS,
  NOTIFICATION_SCHEMA_VERSION,
  NotificationError,
  SEVERITIES,
  createNotificationManager,
  defaultSettings,
  normalizeNotificationInput,
  normalizeSettings
};
