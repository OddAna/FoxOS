const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptionStore } = require('./encryptionStore');
const { createNotificationManager } = require('./notificationManager');
const { createTaskManager } = require('./taskManager');
const {
  TelegramRequestError,
  createTelegramNotificationManager
} = require('./telegramNotificationManager');

const BOT_TOKEN = '123456789:' + 'A'.repeat(35);
const BOT = {
  id: 123456789,
  is_bot: true,
  username: 'FoxOSAlertsBot',
  first_name: 'FoxOS Alerts'
};

function fixture({ webhookUrl = '', withTasks = false } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-telegram-notifications-'));
  let current = new Date('2026-08-13T12:00:00.000Z');
  let nextMessageId = 100;
  let nextTaskId = 0;
  const calls = [];
  const updates = [];
  const encryptionStore = createEncryptionStore({
    dataRoot,
    randomBytes: (size) => Buffer.alloc(size, 9)
  });
  const notificationManager = createNotificationManager({
    dataRoot,
    clock: () => current,
    randomUUID: () => '12345678-1234-1234-1234-1234567890ab'
  });
  const taskManager = withTasks ? createTaskManager({
    dataRoot,
    notificationManager,
    clock: () => current,
    randomUUID: () => `22345678-1234-1234-1234-${String(++nextTaskId).padStart(12, '0')}`,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  }) : null;
  const request = async ({ token, method, payload }) => {
    calls.push({ token, method, payload });
    if (method === 'getMe') return BOT;
    if (method === 'getWebhookInfo') return { url: webhookUrl, pending_update_count: 0 };
    if (method === 'setMyCommands') return true;
    if (method === 'getUpdates') return updates.shift() || [];
    if (method === 'answerCallbackQuery' || method === 'editMessageReplyMarkup') return true;
    if (method === 'editMessageText') {
      return {
        message_id: payload.message_id,
        chat: { id: Number(payload.chat_id), type: 'private' },
        text: payload.text
      };
    }
    if (method === 'sendMessage') {
      return {
        message_id: nextMessageId++,
        chat: { id: Number(payload.chat_id), type: 'private' },
        text: payload.text
      };
    }
    throw new Error('Unexpected Telegram method: ' + method);
  };
  const telegram = createTelegramNotificationManager({
    dataRoot,
    encryptionStore,
    notificationManager,
    taskManager,
    request,
    clock: () => current,
    randomBytes: (size) => Buffer.alloc(size, 7),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {}
  });
  return {
    calls,
    cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
    dataRoot,
    notificationManager,
    setCurrent: (value) => { current = new Date(value); },
    telegram,
    taskManager,
    updates
  };
}

async function configureAndPair(instance, { chatId = 741, userId = 741 } = {}) {
  await instance.telegram.configure({ botToken: BOT_TOKEN });
  const pairingStatus = instance.telegram.startPairing();
  const pairingUrl = new URL(pairingStatus.pairing.url);
  const code = pairingUrl.searchParams.get('start');
  instance.updates.push([{
    update_id: 1,
    message: {
      message_id: 1,
      text: '/start ' + code,
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'Burak', username: 'burak' }
    }
  }]);
  await instance.telegram.pollOnce();
  return instance.telegram.status();
}

test('Telegram configuration is encrypted, rejects an occupied webhook and pairs one private owner', async () => {
  const occupied = fixture({ webhookUrl: 'https://n8n.example.test/webhook/sofia' });
  try {
    await assert.rejects(
      occupied.telegram.configure({ botToken: BOT_TOKEN }),
      (error) => error.code === 'notification-telegram-webhook-in-use'
    );
    assert.equal(fs.existsSync(occupied.telegram.paths.configFile), false);
    assert.equal(fs.existsSync(occupied.telegram.paths.credentialsFile), false);
  } finally {
    occupied.cleanup();
  }

  const instance = fixture();
  try {
    const configured = await instance.telegram.configure({ botToken: BOT_TOKEN });
    assert.equal(configured.configured, true);
    assert.equal(configured.paired, false);
    assert.equal(configured.tokenIncluded, false);
    assert.equal(configured.tokenStoredEncrypted, true);
    assert.equal(configured.bot.username, BOT.username);
    assert.equal(fs.statSync(instance.telegram.paths.configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(instance.telegram.paths.credentialsFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(instance.telegram.paths.configFile, 'utf8').includes(BOT_TOKEN), false);
    assert.equal(fs.readFileSync(instance.telegram.paths.credentialsFile).includes(Buffer.from(BOT_TOKEN)), false);

    const paired = await configureAndPair(instance);
    assert.equal(paired.paired, true);
    assert.equal(paired.owner.displayName, 'Burak');
    assert.equal(paired.owner.username, 'burak');
    assert.equal(paired.pairing, null);
    assert.equal(fs.readFileSync(instance.telegram.paths.configFile, 'utf8').includes('741'), false);
    assert.equal(instance.calls.some((call) => call.method === 'setMyCommands'), true);
    assert.equal(instance.calls.some((call) => (
      call.method === 'sendMessage' && call.payload.text.includes('FoxOS bağlantısı kuruldu')
    )), true);
  } finally {
    instance.cleanup();
  }
});

test('Telegram ignores other chats and accepts only bounded owner commands and callbacks', async () => {
  const instance = fixture();
  try {
    await configureAndPair(instance);
    const notification = instance.notificationManager.create({
      source: 'calendar',
      title: 'Toplantı yaklaşıyor'
    });

    instance.updates.push([{
      update_id: 2,
      message: {
        message_id: 2,
        text: '/oku',
        chat: { id: 999, type: 'private' },
        from: { id: 999, is_bot: false, first_name: 'Başka biri' }
      }
    }]);
    const callsBeforeUnauthorized = instance.calls.length;
    await instance.telegram.pollOnce();
    assert.equal(instance.notificationManager.stats().unread, 1);
    assert.equal(instance.calls.length, callsBeforeUnauthorized + 1);
    assert.equal(instance.calls.at(-1).method, 'getUpdates');

    instance.updates.push([{
      update_id: 3,
      message: {
        message_id: 3,
        text: '/sessiz 2s',
        chat: { id: 741, type: 'private' },
        from: { id: 741, is_bot: false, first_name: 'Burak' }
      }
    }]);
    await instance.telegram.pollOnce();
    assert.equal(instance.telegram.status().pausedUntil, '2026-08-13T14:00:00.000Z');

    instance.updates.push([{
      update_id: 4,
      message: {
        message_id: 4,
        text: '/devam',
        chat: { id: 741, type: 'private' },
        from: { id: 741, is_bot: false, first_name: 'Burak' }
      }
    }, {
      update_id: 5,
      callback_query: {
        id: 'callback-1',
        data: 'fx:x:' + notification.id,
        from: { id: 741, is_bot: false, first_name: 'Burak' },
        message: { message_id: 55, chat: { id: 741, type: 'private' } }
      }
    }]);
    await instance.telegram.pollOnce();
    assert.equal(instance.telegram.status().pausedUntil, null);
    assert.equal(instance.notificationManager.list().items[0].status, 'resolved');
    assert.equal(instance.calls.some((call) => call.method === 'answerCallbackQuery'), true);
  } finally {
    instance.cleanup();
  }
});

test('Telegram delivery follows shared policy, redacts sensitive events and edits deduplicated messages', async () => {
  const instance = fixture();
  try {
    await configureAndPair(instance);
    const sensitive = instance.notificationManager.create({
      source: 'mail',
      severity: 'warning',
      title: 'Gizli müşteri konusu',
      body: 'Bu gövde Telegram’a çıkmamalı.',
      dedupeKey: 'private-thread',
      sensitive: true
    });
    const first = await instance.telegram.deliver(sensitive);
    assert.deepEqual(first, { delivered: 1, skipped: false, reason: null });
    const send = instance.calls.find((call) => (
      call.method === 'sendMessage' && call.payload.reply_markup
    ));
    assert.ok(send);
    assert.equal(send.payload.text.includes('Gizli müşteri konusu'), false);
    assert.equal(send.payload.text.includes('Bu gövde'), false);
    assert.equal(send.payload.text.includes('Ayrıntıları görmek için FoxOS’u açın.'), true);

    const repeated = instance.notificationManager.create({
      source: 'mail',
      severity: 'critical',
      title: 'Yine gizli',
      body: 'Yine çıkmamalı.',
      dedupeKey: 'private-thread',
      sensitive: true
    });
    assert.equal(repeated.id, sensitive.id);
    await instance.telegram.deliver(repeated);
    assert.equal(instance.calls.some((call) => call.method === 'editMessageText'), true);
    assert.equal(instance.calls.filter((call) => call.method === 'sendMessage' && call.payload.reply_markup).length, 1);
    assert.equal(instance.notificationManager.list().items[0].deliveries.at(-1).channel, 'telegram');
    assert.equal(instance.notificationManager.list().items[0].deliveries.at(-1).status, 'delivered');

    instance.telegram.pause(1);
    const paused = instance.notificationManager.create({
      source: 'system',
      title: 'Rutin durum'
    });
    assert.deepEqual(
      await instance.telegram.deliver(paused),
      { delivered: 0, skipped: true, reason: 'paused' }
    );
    assert.equal(instance.notificationManager.list().items[0].deliveries.at(-1).errorCode, 'paused');
  } finally {
    instance.cleanup();
  }
});

test('Telegram checklist reminders can complete or truly snooze the canonical task', async () => {
  const instance = fixture({ withTasks: true });
  try {
    await configureAndPair(instance);
    const created = instance.taskManager.create({
      title: 'Checklist düğmesini dene',
      dueAt: '2026-08-13T12:00:00.000Z',
      timeZone: 'UTC',
      source: 'codex',
      externalKey: 'telegram-checklist-test'
    }).task;
    const reminder = instance.notificationManager.list().items[0];
    await instance.telegram.deliver(reminder);
    const taskDelivery = instance.calls.find((call) => (
      call.method === 'sendMessage' &&
      call.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'fx:t:' + reminder.id
    ));
    assert.ok(taskDelivery);
    assert.equal(taskDelivery.payload.reply_markup.inline_keyboard[0][0].text, '✅ Tamamlandı');

    instance.updates.push([{
      update_id: 8,
      callback_query: {
        id: 'task-complete',
        data: 'fx:t:' + reminder.id,
        from: { id: 741, is_bot: false, first_name: 'Burak' },
        message: { message_id: taskDelivery.payload.message_id || 101, chat: { id: 741, type: 'private' } }
      }
    }]);
    await instance.telegram.pollOnce();
    assert.equal(instance.taskManager.get(created.id).status, 'completed');
    assert.equal(instance.notificationManager.get(reminder.id).status, 'resolved');
    assert.equal(instance.calls.some((call) => (
      call.method === 'answerCallbackQuery' && call.payload.text === 'Görev tamamlandı.'
    )), true);

    instance.taskManager.reopen(created.id);
    const reopenedReminder = instance.notificationManager.list().items.find((item) => item.status !== 'resolved');
    instance.updates.push([{
      update_id: 9,
      callback_query: {
        id: 'task-snooze',
        data: 'fx:q:' + reopenedReminder.id,
        from: { id: 741, is_bot: false, first_name: 'Burak' },
        message: { message_id: 102, chat: { id: 741, type: 'private' } }
      }
    }]);
    await instance.telegram.pollOnce();
    assert.equal(instance.taskManager.get(created.id).dueAt, '2026-08-13T13:00:00.000Z');
    assert.equal(instance.taskManager.get(created.id).reminderSentAt, null);
    assert.equal(instance.notificationManager.get(reopenedReminder.id).status, 'resolved');
  } finally {
    instance.cleanup();
  }
});

test('paired owner can see sensitive task titles and complete an exact task from /gorevler', async () => {
  const instance = fixture({ withTasks: true });
  try {
    await configureAndPair(instance);
    const sensitive = instance.taskManager.create({
      title: 'Müşteri teklifini yanıtla',
      source: 'codex-review-gmail',
      externalKey: 'customer-proposal',
      sensitive: true
    }).task;
    const ordinary = instance.taskManager.create({
      title: 'Sunucu raporunu kontrol et',
      source: 'codex',
      externalKey: 'server-report'
    }).task;

    instance.updates.push([{
      update_id: 10,
      message: {
        message_id: 10,
        text: '/gorevler',
        chat: { id: 741, type: 'private' },
        from: { id: 741, is_bot: false, first_name: 'Burak' }
      }
    }]);
    await instance.telegram.pollOnce();

    const summary = instance.calls.findLast((call) => (
      call.method === 'sendMessage' && call.payload.text.includes('📋 Açık görevler (2)')
    ));
    assert.ok(summary);
    assert.equal(summary.payload.text.includes('Müşteri teklifini yanıtla'), true);
    assert.equal(summary.payload.text.includes('Sunucu raporunu kontrol et'), true);
    assert.equal(summary.payload.text.includes('FoxOS görevi'), false);
    const buttons = summary.payload.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.length, 2);
    assert.equal(buttons.some((button) => button.callback_data === `fx:d:${sensitive.id}`), true);
    assert.equal(buttons.some((button) => button.callback_data === `fx:d:${ordinary.id}`), true);

    instance.updates.push([{
      update_id: 11,
      callback_query: {
        id: 'unauthorized-direct-task-complete',
        data: `fx:d:${sensitive.id}`,
        from: { id: 999, is_bot: false, first_name: 'Başka biri' },
        message: { message_id: 101, chat: { id: 999, type: 'private' } }
      }
    }]);
    await instance.telegram.pollOnce();
    assert.equal(instance.taskManager.get(sensitive.id).status, 'open');

    instance.updates.push([{
      update_id: 12,
      callback_query: {
        id: 'direct-task-complete',
        data: `fx:d:${sensitive.id}`,
        from: { id: 741, is_bot: false, first_name: 'Burak' },
        message: { message_id: 101, chat: { id: 741, type: 'private' } }
      }
    }]);
    await instance.telegram.pollOnce();

    assert.equal(instance.taskManager.get(sensitive.id).status, 'completed');
    assert.equal(instance.taskManager.get(ordinary.id).status, 'open');
    const refresh = instance.calls.findLast((call) => call.method === 'editMessageText');
    assert.ok(refresh);
    assert.equal(refresh.payload.text.includes('Müşteri teklifini yanıtla'), false);
    assert.equal(refresh.payload.text.includes('Sunucu raporunu kontrol et'), true);
    assert.equal(refresh.payload.reply_markup.inline_keyboard.length, 1);
    assert.equal(instance.calls.some((call) => (
      call.method === 'answerCallbackQuery' && call.payload.text === 'Görev tamamlandı.'
    )), true);
  } finally {
    instance.cleanup();
  }
});

test('Telegram provider errors collapse to bounded codes without returning provider text', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-telegram-errors-'));
  try {
    const encryptionStore = createEncryptionStore({ dataRoot });
    const notificationManager = createNotificationManager({ dataRoot });
    const telegram = createTelegramNotificationManager({
      dataRoot,
      encryptionStore,
      notificationManager,
      request: async ({ method }) => {
        if (method === 'getMe') throw new TelegramRequestError(401, 401);
        return { url: '' };
      },
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {}
    });
    await assert.rejects(
      telegram.configure({ botToken: BOT_TOKEN }),
      (error) => error.code === 'telegram-token-rejected' && !error.message.includes(BOT_TOKEN)
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
