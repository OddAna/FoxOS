const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');
const { NotificationError } = require('./notificationManager');

const TELEGRAM_SCHEMA_VERSION = 1;
const TELEGRAM_DISCONNECT_CONFIRMATION = 'TELEGRAM BAĞLANTISINI KALDIR';
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_NOTIFICATION_MESSAGES = 200;
const MAX_RESPONSE_BYTES = 512 * 1024;
const NOTIFICATION_ID_PATTERN = /^ntf_[a-f0-9]{32}$/;
const TASK_ID_PATTERN = /^tsk_[a-f0-9]{32}$/;
const BOT_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,200}$/;
const BOT_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
const DELIVERY_EMOJI = Object.freeze({
  info: '🔔',
  success: '✅',
  warning: '⚠️',
  critical: '🚨'
});
const BOT_COMMANDS = Object.freeze([
  { command: 'bildirimler', description: 'Okunmamış bildirimleri göster' },
  { command: 'gorevler', description: 'Açık checklist görevlerini göster' },
  { command: 'sessiz', description: 'Telegram bildirimlerini saat olarak sustur' },
  { command: 'devam', description: 'Telegram bildirimlerini yeniden başlat' },
  { command: 'oku', description: 'Tüm bildirimleri okundu işaretle' },
  { command: 'yardim', description: 'Kullanılabilir komutları göster' }
]);

class TelegramRequestError extends Error {
  constructor(statusCode, providerCode = null, retryAfter = null) {
    super('Telegram Bot API request failed');
    this.name = 'TelegramRequestError';
    this.statusCode = Number(statusCode) || 502;
    this.providerCode = Number(providerCode) || null;
    this.retryAfter = Number(retryAfter) || null;
  }
}

function boundedString(value, label, maximum, { required = true } = {}) {
  if (typeof value !== 'string') {
    throw new NotificationError(`${label} geçersiz.`, 400, 'notification-telegram-field-invalid');
  }
  const result = value.trim();
  if ((required && !result) || result.length > maximum || result.includes('\0')) {
    throw new NotificationError(`${label} geçersiz.`, 400, 'notification-telegram-field-invalid');
  }
  return result;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function optionalTimestamp(value) {
  return value === null || value === undefined || validTimestamp(value);
}

function safeDisplayText(value, maximum, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replaceAll('\0', '').trim().slice(0, maximum) || fallback;
}

function safeErrorCode(error, fallback = 'telegram-request-failed') {
  if (error instanceof TelegramRequestError) {
    if (error.statusCode === 401) return 'telegram-token-rejected';
    if (error.statusCode === 403) return 'telegram-bot-blocked';
    if (error.statusCode === 409) return 'telegram-polling-conflict';
    if (error.statusCode === 429) return 'telegram-rate-limited';
    if (error.statusCode === 400) return 'telegram-request-rejected';
    return 'telegram-provider-failed';
  }
  if (error && typeof error.code === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(error.code)) {
    return error.code;
  }
  return fallback;
}

async function defaultTelegramRequest({ token, method, payload = {}, timeoutMs = 15_000, signal = null }) {
  if (!BOT_TOKEN_PATTERN.test(String(token || ''))) {
    throw new NotificationError('Telegram bot anahtarı geçersiz.', 400, 'notification-telegram-token-invalid');
  }
  if (!/^[A-Za-z][A-Za-z0-9]{1,63}$/.test(String(method || ''))) {
    throw new TypeError('Telegram method is invalid');
  }
  const target = new URL(`https://api.telegram.org/bot${token}/${method}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });
  let response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new NotificationError('Telegram bağlantısı zaman aşımına uğradı.', 503, 'notification-telegram-timeout');
    }
    throw new NotificationError('Telegram’a bağlanılamadı.', 503, 'notification-telegram-unavailable');
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abort);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new NotificationError('Telegram yanıtı güvenli sınırı aştı.', 502, 'notification-telegram-response-too-large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new NotificationError('Telegram yanıtı güvenli sınırı aştı.', 502, 'notification-telegram-response-too-large');
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new NotificationError('Telegram geçersiz yanıt verdi.', 502, 'notification-telegram-response-invalid');
  }
  if (!response.ok || !envelope || envelope.ok !== true) {
    throw new TelegramRequestError(
      response.status,
      envelope && envelope.error_code,
      envelope && envelope.parameters && envelope.parameters.retry_after
    );
  }
  return envelope.result;
}

function createTelegramNotificationManager({
  dataRoot,
  encryptionStore,
  notificationManager,
  taskManager = null,
  request = defaultTelegramRequest,
  clock = () => new Date(),
  randomBytes = crypto.randomBytes,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  if (
    typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) ||
    !encryptionStore || typeof encryptionStore.encryptBuffer !== 'function' ||
    !notificationManager || typeof notificationManager.recordDelivery !== 'function' ||
    (taskManager && (
      typeof taskManager.complete !== 'function' || typeof taskManager.get !== 'function' ||
      typeof taskManager.list !== 'function' || typeof taskManager.snooze !== 'function'
    )) ||
    typeof request !== 'function'
  ) {
    throw new TypeError('Telegram notification manager requires data, encryption, notification and network adapters');
  }

  const root = path.join(dataRoot, 'notifications', 'telegram');
  const configFile = path.join(root, 'config.json');
  const credentialsFile = path.join(root, 'credentials.foxosenc');
  const credentialContext = {
    purpose: 'foxos-notification-telegram-credentials',
    schemaVersion: TELEGRAM_SCHEMA_VERSION
  };
  let pairing = null;
  let running = false;
  let pollTimer = null;
  let pollAbort = null;
  let runtimeLastPollAt = null;
  let runtimeErrorCode = null;
  let nextPollDelayMs = 250;

  function nowDate() {
    return new Date(clock());
  }

  function now() {
    return nowDate().toISOString();
  }

  function fileExists(target) {
    try {
      return fs.statSync(target).isFile();
    } catch {
      return false;
    }
  }

  function removeFileIfPresent(target) {
    try {
      fs.unlinkSync(target);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  function readConfig() {
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new NotificationError('Telegram bağlantı ayarı okunamadı.', 503, 'notification-telegram-config-invalid');
    }
    const messages = config && config.notificationMessages;
    if (
      !config || config.schemaVersion !== TELEGRAM_SCHEMA_VERSION ||
      !config.bot || typeof config.bot.id !== 'string' || !config.bot.id ||
      !BOT_USERNAME_PATTERN.test(String(config.bot.username || '')) ||
      typeof config.bot.firstName !== 'string' || config.bot.firstName.length > 100 ||
      typeof config.tokenFingerprint !== 'string' ||
      typeof config.enabled !== 'boolean' ||
      !validTimestamp(config.configuredAt) || !validTimestamp(config.updatedAt) ||
      !optionalTimestamp(config.pairedAt) || !optionalTimestamp(config.pausedUntil) ||
      !optionalTimestamp(config.lastDeliveredAt) ||
      !Number.isSafeInteger(config.lastUpdateId) || config.lastUpdateId < 0 ||
      (config.lastErrorCode !== null && config.lastErrorCode !== undefined &&
        !/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(config.lastErrorCode))) ||
      !messages || typeof messages !== 'object' || Array.isArray(messages) ||
      Object.keys(messages).length > MAX_NOTIFICATION_MESSAGES
    ) {
      throw new NotificationError('Telegram bağlantı ayarı okunamadı.', 503, 'notification-telegram-config-invalid');
    }
    for (const [notificationId, message] of Object.entries(messages)) {
      if (
        !NOTIFICATION_ID_PATTERN.test(notificationId) || !message ||
        !Number.isSafeInteger(message.messageId) || message.messageId < 1 ||
        !validTimestamp(message.updatedAt)
      ) {
        throw new NotificationError('Telegram bağlantı ayarı okunamadı.', 503, 'notification-telegram-config-invalid');
      }
    }
    if (config.pairDisplay !== null && config.pairDisplay !== undefined) {
      if (
        !config.pairDisplay || typeof config.pairDisplay !== 'object' ||
        typeof config.pairDisplay.displayName !== 'string' || config.pairDisplay.displayName.length > 160 ||
        (config.pairDisplay.username !== null &&
          !/^[A-Za-z0-9_]{1,64}$/.test(String(config.pairDisplay.username || '')))
      ) {
        throw new NotificationError('Telegram bağlantı ayarı okunamadı.', 503, 'notification-telegram-config-invalid');
      }
    }
    return config;
  }

  function readCredentials(config = readConfig()) {
    if (!config || !fileExists(credentialsFile)) {
      throw new NotificationError('Telegram bot anahtarı bulunamadı.', 409, 'notification-telegram-not-configured');
    }
    try {
      const credentials = JSON.parse(encryptionStore.decryptBuffer(
        fs.readFileSync(credentialsFile),
        credentialContext
      ).toString('utf8'));
      if (
        !credentials || credentials.schemaVersion !== TELEGRAM_SCHEMA_VERSION ||
        !BOT_TOKEN_PATTERN.test(String(credentials.token || '')) ||
        encryptionStore.fingerprint(credentials.token) !== config.tokenFingerprint ||
        (credentials.pair !== null && (
          !credentials.pair || typeof credentials.pair.chatId !== 'string' ||
          !/^-?\d{1,24}$/.test(credentials.pair.chatId) ||
          typeof credentials.pair.userId !== 'string' || !/^\d{1,24}$/.test(credentials.pair.userId)
        ))
      ) {
        throw new Error('invalid');
      }
      return credentials;
    } catch (error) {
      if (error instanceof NotificationError) throw error;
      throw new NotificationError('Telegram bot anahtarı çözülemedi.', 503, 'notification-telegram-credentials-invalid');
    }
  }

  function writeState(config, credentials) {
    const previousConfig = fileExists(configFile) ? fs.readFileSync(configFile) : null;
    const previousCredentials = fileExists(credentialsFile) ? fs.readFileSync(credentialsFile) : null;
    try {
      encryptionStore.atomicWriteBuffer(
        credentialsFile,
        encryptionStore.encryptBuffer(Buffer.from(JSON.stringify(credentials), 'utf8'), credentialContext)
      );
      atomicWriteJson(configFile, config);
    } catch (error) {
      if (previousCredentials) encryptionStore.atomicWriteBuffer(credentialsFile, previousCredentials);
      else removeFileIfPresent(credentialsFile);
      if (previousConfig) encryptionStore.atomicWriteBuffer(configFile, previousConfig);
      else removeFileIfPresent(configFile);
      throw error;
    }
  }

  function writeConfig(config) {
    atomicWriteJson(configFile, config);
  }

  function activePairing(config = readConfig()) {
    if (!pairing) return null;
    if (pairing.expiresAtMs <= nowDate().getTime()) {
      pairing = null;
      return null;
    }
    return {
      expiresAt: new Date(pairing.expiresAtMs).toISOString(),
      url: `https://t.me/${config.bot.username}?start=${pairing.code}`
    };
  }

  function normalizedPausedUntil(config) {
    if (!config.pausedUntil) return null;
    return Date.parse(config.pausedUntil) > nowDate().getTime() ? config.pausedUntil : null;
  }

  function publicStatus(config = readConfig()) {
    if (!config) {
      return {
        supported: true,
        configured: false,
        paired: false,
        enabled: false,
        polling: false,
        bot: null,
        owner: null,
        pairing: null,
        pausedUntil: null,
        lastDeliveredAt: null,
        lastErrorCode: runtimeErrorCode,
        tokenStoredEncrypted: false,
        tokenIncluded: false
      };
    }
    let paired = false;
    let credentialErrorCode = null;
    try {
      paired = Boolean(readCredentials(config).pair);
    } catch (error) {
      // The public state reports the credential problem without exposing it.
      credentialErrorCode = safeErrorCode(error, 'notification-telegram-credentials-invalid');
    }
    return {
      supported: true,
      configured: true,
      paired,
      enabled: config.enabled,
      polling: running,
      bot: {
        username: config.bot.username,
        firstName: config.bot.firstName
      },
      owner: paired && config.pairDisplay ? { ...config.pairDisplay } : null,
      pairing: activePairing(config),
      pausedUntil: normalizedPausedUntil(config),
      lastPolledAt: runtimeLastPollAt,
      lastDeliveredAt: config.lastDeliveredAt || null,
      lastErrorCode: runtimeErrorCode || credentialErrorCode || config.lastErrorCode || null,
      tokenStoredEncrypted: fileExists(credentialsFile),
      tokenIncluded: false
    };
  }

  function status() {
    return publicStatus();
  }

  async function call(token, method, payload = {}, timeoutMs = 15_000) {
    const controller = new AbortController();
    pollAbort = controller;
    try {
      return await request({ token, method, payload, timeoutMs, signal: controller.signal });
    } finally {
      if (pollAbort === controller) pollAbort = null;
    }
  }

  async function configure(input) {
    const token = boundedString(input && input.botToken, 'Telegram bot anahtarı', 256);
    if (!BOT_TOKEN_PATTERN.test(token)) {
      throw new NotificationError('Telegram bot anahtarı geçersiz.', 400, 'notification-telegram-token-invalid');
    }
    let bot;
    let webhook;
    try {
      [bot, webhook] = await Promise.all([
        request({ token, method: 'getMe', payload: {}, timeoutMs: 15_000 }),
        request({ token, method: 'getWebhookInfo', payload: {}, timeoutMs: 15_000 })
      ]);
    } catch (error) {
      const code = safeErrorCode(error, 'notification-telegram-connection-failed');
      throw new NotificationError(
        code === 'telegram-token-rejected'
          ? 'Telegram bot anahtarı kabul edilmedi.'
          : 'Telegram botu doğrulanamadı.',
        code === 'telegram-token-rejected' ? 400 : 502,
        code
      );
    }
    if (
      !bot || bot.is_bot !== true || !Number.isSafeInteger(bot.id) ||
      !BOT_USERNAME_PATTERN.test(String(bot.username || ''))
    ) {
      throw new NotificationError('Telegram bot kimliği geçersiz.', 502, 'notification-telegram-bot-invalid');
    }
    if (webhook && typeof webhook.url === 'string' && webhook.url.trim()) {
      throw new NotificationError(
        'Bu bot başka bir webhook tarafından kullanılıyor. FoxOS için ayrı bir bot oluşturun.',
        409,
        'notification-telegram-webhook-in-use'
      );
    }
    try {
      await request({
        token,
        method: 'setMyCommands',
        payload: { commands: BOT_COMMANDS },
        timeoutMs: 15_000
      });
    } catch (error) {
      throw new NotificationError(
        'Telegram bot komutları hazırlanamadı.',
        502,
        safeErrorCode(error, 'notification-telegram-command-setup-failed')
      );
    }

    const existingConfig = readConfig();
    let existingCredentials = null;
    try {
      if (existingConfig) existingCredentials = readCredentials(existingConfig);
    } catch {
      existingCredentials = null;
    }
    const tokenFingerprint = encryptionStore.fingerprint(token);
    const preservePair = Boolean(
      existingConfig && existingCredentials && existingConfig.tokenFingerprint === tokenFingerprint
    );
    const timestamp = now();
    const config = {
      schemaVersion: TELEGRAM_SCHEMA_VERSION,
      bot: {
        id: String(bot.id),
        username: String(bot.username),
        firstName: safeDisplayText(bot.first_name, 100, String(bot.username))
      },
      tokenFingerprint,
      enabled: preservePair ? existingConfig.enabled : true,
      configuredAt: preservePair ? existingConfig.configuredAt : timestamp,
      updatedAt: timestamp,
      pairedAt: preservePair ? existingConfig.pairedAt : null,
      pairDisplay: preservePair ? existingConfig.pairDisplay : null,
      pausedUntil: preservePair ? normalizedPausedUntil(existingConfig) : null,
      lastUpdateId: preservePair ? existingConfig.lastUpdateId : 0,
      lastDeliveredAt: preservePair ? existingConfig.lastDeliveredAt : null,
      lastErrorCode: null,
      notificationMessages: preservePair ? existingConfig.notificationMessages : {}
    };
    const credentials = {
      schemaVersion: TELEGRAM_SCHEMA_VERSION,
      token,
      pair: preservePair ? existingCredentials.pair : null
    };
    stop();
    writeState(config, credentials);
    pairing = null;
    runtimeErrorCode = null;
    start();
    return publicStatus(config);
  }

  function startPairing() {
    const config = readConfig();
    readCredentials(config);
    const code = randomBytes(24).toString('base64url');
    pairing = {
      code,
      expiresAtMs: nowDate().getTime() + PAIRING_TTL_MS
    };
    start();
    return publicStatus(config);
  }

  function setEnabled(value) {
    if (typeof value !== 'boolean') {
      throw new NotificationError('Telegram kanal ayarı geçersiz.', 400, 'notification-telegram-enabled-invalid');
    }
    const config = readConfig();
    readCredentials(config);
    const next = { ...config, enabled: value, updatedAt: now() };
    writeConfig(next);
    return publicStatus(next);
  }

  function pause(hours = null) {
    const config = readConfig();
    const credentials = readCredentials(config);
    if (!credentials.pair) {
      throw new NotificationError('Önce Telegram özel sohbetini eşleştirin.', 409, 'notification-telegram-not-paired');
    }
    let pausedUntil = null;
    if (hours !== null && hours !== undefined) {
      const amount = Number(hours);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 168) {
        throw new NotificationError('Telegram en fazla 168 saat susturulabilir.', 400, 'notification-telegram-pause-invalid');
      }
      pausedUntil = new Date(nowDate().getTime() + amount * 60 * 60 * 1000).toISOString();
    }
    const next = { ...config, pausedUntil, updatedAt: now() };
    writeConfig(next);
    return publicStatus(next);
  }

  function disconnect(confirmation) {
    if (confirmation !== TELEGRAM_DISCONNECT_CONFIRMATION) {
      throw new NotificationError(
        'Telegram bağlantısını kaldırmak için tam onay gerekir.',
        400,
        'notification-telegram-disconnect-confirmation-required'
      );
    }
    const previousConfig = fileExists(configFile) ? fs.readFileSync(configFile) : null;
    const previousCredentials = fileExists(credentialsFile) ? fs.readFileSync(credentialsFile) : null;
    stop();
    try {
      removeFileIfPresent(credentialsFile);
      removeFileIfPresent(configFile);
    } catch (error) {
      if (previousCredentials) encryptionStore.atomicWriteBuffer(credentialsFile, previousCredentials);
      if (previousConfig) encryptionStore.atomicWriteBuffer(configFile, previousConfig);
      throw error;
    }
    pairing = null;
    runtimeErrorCode = null;
    return publicStatus(null);
  }

  function ownerMatches(credentials, chatId, userId) {
    return Boolean(
      credentials.pair &&
      credentials.pair.chatId === String(chatId) &&
      credentials.pair.userId === String(userId)
    );
  }

  function commandFrom(text) {
    const match = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
    if (!match) return null;
    return { name: match[1].toLocaleLowerCase('en-US'), argument: (match[2] || '').trim() };
  }

  function helpText() {
    return [
      'FoxOS Bildirim Botu',
      '',
      '/bildirimler — okunmamış bildirimleri göster',
      '/gorevler — açık checklist görevlerini göster',
      '/sessiz 2s — Telegram teslimatını 2 saat sustur',
      '/devam — teslimatı yeniden başlat',
      '/oku — tüm bildirimleri okundu işaretle',
      '/yardim — bu komutları göster',
      '',
      'Bu bot serbest metinle AI görevi başlatmaz; bildirim ve kontrol kanalıdır.'
    ].join('\n');
  }

  function notificationText(notification) {
    if (notification.sensitive) {
      return `${DELIVERY_EMOJI[notification.severity] || '🔔'} FoxOS bildirimi\n\nAyrıntıları görmek için FoxOS’u açın.`;
    }
    const lines = [
      `${DELIVERY_EMOJI[notification.severity] || '🔔'} ${notification.title}`
    ];
    if (notification.body) lines.push('', notification.body);
    lines.push('', `Kaynak: ${notification.source}`);
    if (notification.occurrenceCount > 1) lines.push(`Tekrar: ${notification.occurrenceCount}`);
    return lines.join('\n').slice(0, 4_000);
  }

  function isTaskReminder(notification) {
    return Boolean(
      taskManager && notification && notification.source === 'checklist' &&
      notification.category === 'task-reminder' && TASK_ID_PATTERN.test(String(notification.dedupeKey || ''))
    );
  }

  function callbackKeyboard(notification) {
    if (isTaskReminder(notification)) {
      return {
        inline_keyboard: [[
          { text: '✅ Tamamlandı', callback_data: `fx:t:${notification.id}` },
          { text: '⏰ 1 saat ertele', callback_data: `fx:q:${notification.id}` }
        ]]
      };
    }
    return {
      inline_keyboard: [[
        { text: 'Okundu', callback_data: `fx:r:${notification.id}` },
        { text: '1 saat ertele', callback_data: `fx:s:${notification.id}` },
        { text: 'Çözüldü', callback_data: `fx:x:${notification.id}` }
      ]]
    };
  }

  function unreadSummary() {
    const items = notificationManager.list({ status: 'unread', limit: 5 }).items;
    if (!items.length) return 'Okunmamış FoxOS bildirimi yok.';
    const lines = [`Okunmamış bildirimler (${items.length}${items.length === 5 ? '+' : ''})`];
    for (const item of items) {
      lines.push(`\n${DELIVERY_EMOJI[item.severity] || '🔔'} ${item.sensitive ? 'FoxOS bildirimi' : item.title}`);
    }
    lines.push('\nAyrıntılar ve tüm geçmiş FoxOS Bildirim Merkezi’nde.');
    return lines.join('\n');
  }

  function openTaskSummary() {
    if (!taskManager) {
      return {
        text: 'FoxOS checklist bu kurulumda kullanılamıyor.',
        replyMarkup: null
      };
    }
    const result = taskManager.list({ status: 'open', limit: 10 });
    if (!result.items.length) {
      return { text: 'Açık checklist görevi yok.', replyMarkup: null };
    }
    const lines = [`📋 Açık görevler (${result.stats.open}${result.stats.open > 10 ? '+' : ''})`];
    const keyboard = [];
    for (const [index, task] of result.items.entries()) {
      const number = index + 1;
      // Only the exact paired owner can request this summary. Keep notes out of
      // Telegram, but retain the title that makes the checklist identifiable.
      const title = safeDisplayText(task.title, 240, 'İsimsiz görev');
      let due = '';
      if (task.dueAt) {
        due = ' · ' + new Date(task.dueAt).toLocaleString('tr-TR', {
          timeZone: task.timeZone,
          dateStyle: 'short',
          timeStyle: 'short'
        });
      }
      lines.push(`\n${number}. ☐ ${title}${due}`);
      keyboard.push([{
        text: `✅ ${number}. Tamamla`,
        callback_data: `fx:d:${task.id}`
      }]);
    }
    if (result.stats.open > result.items.length) {
      lines.push(`\nFoxOS’ta ${result.stats.open - result.items.length} görev daha var.`);
    }
    lines.push('\nBitirdiğin görevi aşağıdaki numaralı düğmeyle işaretleyebilirsin.');
    return {
      text: lines.join('\n').slice(0, 4_000),
      replyMarkup: { inline_keyboard: keyboard }
    };
  }

  async function sendText(token, chatId, text, extra = {}) {
    const result = await request({
      token,
      method: 'sendMessage',
      payload: {
        chat_id: chatId,
        text: String(text).slice(0, 4_000),
        disable_web_page_preview: true,
        ...extra
      },
      timeoutMs: 15_000
    });
    if (
      !result || !Number.isSafeInteger(result.message_id) ||
      !result.chat || String(result.chat.id) !== String(chatId)
    ) {
      throw new NotificationError('Telegram teslimatı doğrulanamadı.', 502, 'notification-telegram-delivery-unproven');
    }
    return result;
  }

  async function pairFromMessage(config, credentials, message, command) {
    const active = activePairing(config);
    const chat = message && message.chat;
    const from = message && message.from;
    if (
      !active || !command || command.name !== 'start' || command.argument !== pairing.code ||
      !chat || chat.type !== 'private' || !from || from.is_bot === true ||
      String(chat.id) !== String(from.id)
    ) return false;

    const timestamp = now();
    const displayName = safeDisplayText(
      [from.first_name, from.last_name].filter((value) => typeof value === 'string').join(' '),
      160,
      'Telegram sahibi'
    );
    const nextConfig = {
      ...config,
      pairedAt: timestamp,
      pairDisplay: {
        displayName,
        username: typeof from.username === 'string'
          ? safeDisplayText(from.username, 64, null)
          : null
      },
      updatedAt: timestamp,
      lastErrorCode: null
    };
    const nextCredentials = {
      ...credentials,
      pair: { chatId: String(chat.id), userId: String(from.id) }
    };
    writeState(nextConfig, nextCredentials);
    pairing = null;
    runtimeErrorCode = null;
    await sendText(
      credentials.token,
      String(chat.id),
      'FoxOS bağlantısı kuruldu. Bundan sonra kurallarınıza uyan bildirimler bu özel sohbete gelir.\n\n' + helpText()
    );
    return true;
  }

  async function handleOwnerCommand(config, credentials, message, command) {
    if (!command) {
      await sendText(credentials.token, credentials.pair.chatId, helpText());
      return;
    }
    if (command.name === 'bildirimler') {
      await sendText(credentials.token, credentials.pair.chatId, unreadSummary());
      return;
    }
    if (command.name === 'gorevler') {
      const summary = openTaskSummary();
      await sendText(credentials.token, credentials.pair.chatId, summary.text, {
        ...(summary.replyMarkup ? { reply_markup: summary.replyMarkup } : {})
      });
      return;
    }
    if (command.name === 'sessiz') {
      const match = /^(\d{1,3})(?:\s*(?:s|saat|h))?$/i.exec(command.argument);
      if (!match) {
        await sendText(credentials.token, credentials.pair.chatId, 'Örnek kullanım: /sessiz 2s (1–168 saat)');
        return;
      }
      const amount = Number(match[1]);
      try {
        const result = pause(amount);
        const timezone = notificationManager.settings().quietHours.timezone;
        await sendText(
          credentials.token,
          credentials.pair.chatId,
          `Telegram bildirimleri ${amount} saat susturuldu.\nYeniden başlatmak için /devam yazın.\nBitiş: ${new Date(result.pausedUntil).toLocaleString('tr-TR', { timeZone: timezone })} (${timezone})`
        );
      } catch (error) {
        await sendText(credentials.token, credentials.pair.chatId, error.message);
      }
      return;
    }
    if (command.name === 'devam') {
      pause(null);
      await sendText(credentials.token, credentials.pair.chatId, 'Telegram bildirimleri yeniden açıldı.');
      return;
    }
    if (command.name === 'oku') {
      const result = notificationManager.readAll();
      await sendText(
        credentials.token,
        credentials.pair.chatId,
        result.changed ? `${result.changed} bildirim okundu işaretlendi.` : 'Okunmamış bildirim yok.'
      );
      return;
    }
    if (command.name === 'yardim' || command.name === 'start') {
      await sendText(credentials.token, credentials.pair.chatId, helpText());
      return;
    }
    await sendText(credentials.token, credentials.pair.chatId, helpText());
  }

  async function handleMessage(config, credentials, message) {
    if (!message || !message.chat || !message.from || message.from.is_bot === true) return;
    const command = commandFrom(message.text);
    if (!credentials.pair) {
      await pairFromMessage(config, credentials, message, command);
      return;
    }
    if (!ownerMatches(credentials, message.chat.id, message.from.id)) return;
    await handleOwnerCommand(config, credentials, message, command);
  }

  async function handleCallback(config, credentials, callback) {
    if (
      !credentials.pair || !callback || typeof callback.id !== 'string' ||
      !callback.from || !callback.message || !callback.message.chat ||
      !ownerMatches(credentials, callback.message.chat.id, callback.from.id)
    ) return;
    const callbackData = String(callback.data || '');
    const match = /^fx:([rsxtq]):(ntf_[a-f0-9]{32})$/.exec(callbackData);
    const directTaskMatch = /^fx:d:(tsk_[a-f0-9]{32})$/.exec(callbackData);
    let answer = 'Geçersiz işlem.';
    if (match || directTaskMatch) {
      try {
        if (directTaskMatch) {
          const result = taskManager.complete(directTaskMatch[1]);
          answer = result.changed ? 'Görev tamamlandı.' : 'Görev zaten tamamlanmış.';
          const summary = openTaskSummary();
          try {
            await request({
              token: credentials.token,
              method: 'editMessageText',
              payload: {
                chat_id: credentials.pair.chatId,
                message_id: callback.message.message_id,
                text: summary.text,
                disable_web_page_preview: true,
                reply_markup: summary.replyMarkup || { inline_keyboard: [] }
              },
              timeoutMs: 15_000
            });
          } catch {
            // The canonical task is complete even if Telegram cannot refresh
            // the older summary message.
          }
        } else {
          const action = match[1];
          if (action === 't' || action === 'q') {
            const notification = notificationManager.get(match[2]);
            if (!isTaskReminder(notification)) {
              throw new NotificationError('Görev bildirimi bulunamadı.', 404, 'task-reminder-not-found');
            }
            if (action === 't') taskManager.complete(notification.dedupeKey);
            if (action === 'q') taskManager.snooze(notification.dedupeKey, {
              until: new Date(nowDate().getTime() + 60 * 60 * 1000).toISOString()
            });
            answer = action === 't' ? 'Görev tamamlandı.' : 'Görev 1 saat ertelendi.';
          }
          if (action === 'r') notificationManager.updateStatus(match[2], { status: 'read' });
          if (action === 's') notificationManager.updateStatus(match[2], {
            status: 'snoozed',
            snoozedUntil: new Date(nowDate().getTime() + 60 * 60 * 1000).toISOString()
          });
          if (action === 'x') notificationManager.updateStatus(match[2], { status: 'resolved' });
          if (action === 'r') answer = 'Okundu.';
          if (action === 's') answer = '1 saat ertelendi.';
          if (action === 'x') answer = 'Çözüldü.';
          try {
            await request({
              token: credentials.token,
              method: 'editMessageReplyMarkup',
              payload: {
                chat_id: credentials.pair.chatId,
                message_id: callback.message.message_id,
                reply_markup: { inline_keyboard: [] }
              },
              timeoutMs: 15_000
            });
          } catch {
            // The local action is authoritative even if the old Telegram keyboard cannot be removed.
          }
        }
      } catch (error) {
        if (error && error.code === 'notification-not-found') answer = 'Bu bildirim artık bulunamadı.';
        else if (error && error.code === 'task-not-found') answer = 'Bu görev artık bulunamadı.';
        else answer = 'İşlem uygulanamadı.';
      }
    }
    try {
      await request({
        token: credentials.token,
        method: 'answerCallbackQuery',
        payload: { callback_query_id: callback.id, text: answer, cache_time: 0 },
        timeoutMs: 15_000
      });
    } catch {
      // Telegram's transient callback toast is not local action authority.
    }
  }

  async function processUpdate(update) {
    const config = readConfig();
    if (!config) return;
    const credentials = readCredentials(config);
    if (update && update.message) await handleMessage(config, credentials, update.message);
    if (update && update.callback_query) await handleCallback(config, credentials, update.callback_query);
  }

  async function pollOnce() {
    const config = readConfig();
    if (!config) return { processed: 0, configured: false };
    const credentials = readCredentials(config);
    const updates = await call(credentials.token, 'getUpdates', {
      offset: config.lastUpdateId + 1,
      limit: 50,
      timeout: 25,
      allowed_updates: ['message', 'callback_query']
    }, 35_000);
    if (!Array.isArray(updates) || updates.length > 100) {
      throw new NotificationError('Telegram güncelleme yanıtı geçersiz.', 502, 'notification-telegram-updates-invalid');
    }
    let lastUpdateId = config.lastUpdateId;
    let processed = 0;
    for (const update of updates) {
      if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) continue;
      if (update.update_id <= lastUpdateId) continue;
      await processUpdate(update);
      lastUpdateId = update.update_id;
      processed += 1;
    }
    if (lastUpdateId !== config.lastUpdateId) {
      const latest = readConfig();
      if (latest) writeConfig({ ...latest, lastUpdateId, updatedAt: now() });
    }
    runtimeLastPollAt = now();
    runtimeErrorCode = null;
    nextPollDelayMs = 250;
    return { processed, configured: true };
  }

  function schedulePoll(delay = nextPollDelayMs) {
    if (!running || pollTimer) return;
    pollTimer = setTimer(async () => {
      pollTimer = null;
      try {
        await pollOnce();
      } catch (error) {
        runtimeErrorCode = safeErrorCode(error, 'notification-telegram-poll-failed');
        nextPollDelayMs = runtimeErrorCode === 'telegram-polling-conflict' ? 30_000 : 5_000;
      } finally {
        schedulePoll(nextPollDelayMs);
      }
    }, delay);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function start() {
    if (running) return publicStatus();
    if (!readConfig()) return publicStatus(null);
    running = true;
    nextPollDelayMs = 0;
    schedulePoll(0);
    return publicStatus();
  }

  function stop() {
    running = false;
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
    if (pollAbort) pollAbort.abort();
    pollAbort = null;
  }

  async function reconcileCommands() {
    const config = readConfig();
    if (!config) return { updated: false, reason: 'not-configured' };
    const credentials = readCredentials(config);
    try {
      await request({
        token: credentials.token,
        method: 'setMyCommands',
        payload: { commands: BOT_COMMANDS },
        timeoutMs: 15_000
      });
      return { updated: true, reason: null };
    } catch (error) {
      throw new NotificationError(
        'Telegram bot komutları güncellenemedi.',
        502,
        safeErrorCode(error, 'notification-telegram-command-setup-failed')
      );
    }
  }

  async function syncStatus(notification) {
    if (
      !notification || !NOTIFICATION_ID_PATTERN.test(String(notification.id || '')) ||
      !['read', 'snoozed', 'resolved'].includes(notification.status)
    ) return { updated: false, reason: 'not-applicable' };
    const config = readConfig();
    if (!config) return { updated: false, reason: 'not-configured' };
    const previous = config.notificationMessages[notification.id];
    if (!previous) return { updated: false, reason: 'message-not-found' };
    const credentials = readCredentials(config);
    if (!credentials.pair) return { updated: false, reason: 'not-paired' };
    try {
      await request({
        token: credentials.token,
        method: 'editMessageReplyMarkup',
        payload: {
          chat_id: credentials.pair.chatId,
          message_id: previous.messageId,
          reply_markup: { inline_keyboard: [] }
        },
        timeoutMs: 15_000
      });
      return { updated: true, reason: null };
    } catch (error) {
      return { updated: false, reason: safeErrorCode(error, 'telegram-message-sync-failed') };
    }
  }

  function trimNotificationMessages(messages) {
    return Object.fromEntries(Object.entries(messages)
      .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
      .slice(0, MAX_NOTIFICATION_MESSAGES));
  }

  async function deliver(notification) {
    let config = readConfig();
    if (!config) return { delivered: 0, skipped: true, reason: 'not-configured' };
    let credentials;
    try {
      credentials = readCredentials(config);
    } catch (error) {
      return { delivered: 0, skipped: true, reason: safeErrorCode(error, 'credentials-unavailable') };
    }
    if (!config.enabled) return { delivered: 0, skipped: true, reason: 'disabled' };
    if (!credentials.pair) return { delivered: 0, skipped: true, reason: 'not-paired' };
    const pausedUntil = normalizedPausedUntil(config);
    if (pausedUntil) {
      notificationManager.recordDelivery(notification.id, {
        channel: 'telegram', status: 'skipped', deviceCount: 0, errorCode: 'paused'
      });
      return { delivered: 0, skipped: true, reason: 'paused' };
    }
    if (config.pausedUntil) {
      config = { ...config, pausedUntil: null, updatedAt: now() };
      writeConfig(config);
    }
    const policy = notificationManager.externalPolicy(notification);
    if (!policy.deliver) {
      notificationManager.recordDelivery(notification.id, {
        channel: 'telegram', status: 'skipped', deviceCount: 0, errorCode: policy.reason
      });
      return { delivered: 0, skipped: true, reason: policy.reason };
    }

    const text = notificationText(notification);
    const previous = config.notificationMessages[notification.id];
    let result;
    try {
      if (previous) {
        try {
          result = await request({
            token: credentials.token,
            method: 'editMessageText',
            payload: {
              chat_id: credentials.pair.chatId,
              message_id: previous.messageId,
              text,
              disable_web_page_preview: true,
              reply_markup: callbackKeyboard(notification)
            },
            timeoutMs: 15_000
          });
        } catch (error) {
          if (!(error instanceof TelegramRequestError) || error.statusCode !== 400) throw error;
        }
      }
      if (!result) {
        result = await sendText(credentials.token, credentials.pair.chatId, text, {
          reply_markup: callbackKeyboard(notification)
        });
      }
      if (
        !result || !Number.isSafeInteger(result.message_id) ||
        !result.chat || String(result.chat.id) !== credentials.pair.chatId
      ) {
        throw new NotificationError('Telegram teslimatı doğrulanamadı.', 502, 'notification-telegram-delivery-unproven');
      }
      const timestamp = now();
      const latest = readConfig();
      if (latest) {
        writeConfig({
          ...latest,
          updatedAt: timestamp,
          lastDeliveredAt: timestamp,
          lastErrorCode: null,
          notificationMessages: trimNotificationMessages({
            ...latest.notificationMessages,
            [notification.id]: { messageId: result.message_id, updatedAt: timestamp }
          })
        });
      }
      runtimeErrorCode = null;
      notificationManager.recordDelivery(notification.id, {
        channel: 'telegram', status: 'delivered', deviceCount: 1
      });
      return { delivered: 1, skipped: false, reason: null };
    } catch (error) {
      const errorCode = safeErrorCode(error, 'telegram-delivery-failed');
      const latest = readConfig();
      if (latest) writeConfig({ ...latest, updatedAt: now(), lastErrorCode: errorCode });
      runtimeErrorCode = errorCode;
      notificationManager.recordDelivery(notification.id, {
        channel: 'telegram', status: 'failed', deviceCount: 0, errorCode
      });
      return { delivered: 0, skipped: false, reason: errorCode };
    }
  }

  return {
    configure,
    deliver,
    disconnect,
    paths: { configFile, credentialsFile, root },
    pause,
    pollOnce,
    reconcileCommands,
    setEnabled,
    start,
    startPairing,
    status,
    stop,
    syncStatus
  };
}

module.exports = {
  BOT_COMMANDS,
  PAIRING_TTL_MS,
  TELEGRAM_DISCONNECT_CONFIRMATION,
  TELEGRAM_SCHEMA_VERSION,
  TelegramRequestError,
  createTelegramNotificationManager,
  defaultTelegramRequest
};
