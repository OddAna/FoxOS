const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNotificationManager } = require('./notificationManager');
const { createTaskManager } = require('./taskManager');
const {
  DEFAULT_INTERVAL_MINUTES,
  createCodexChecklistReviewManager
} = require('./codexChecklistReviewManager');

function fixture({ codexOutput = null, sourceFailure = false, configuredSources = ['work-gmail'] } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-codex-review-'));
  let current = new Date('2026-08-13T09:00:00.000Z');
  const clock = () => new Date(current);
  const notifications = createNotificationManager({ dataRoot, clock });
  const tasks = createTaskManager({ dataRoot, notificationManager: notifications, clock });
  const codexCalls = [];
  const sourceCalls = [];
  const codex = {
    async runScheduledReview(request) {
      codexCalls.push(request);
      const ids = request.outputSchema.properties.decisions.items.properties.recordId.enum || [];
      const output = codexOutput || {
        schemaVersion: 1,
        decisions: ids.map((recordId, index) => ({
          recordId,
          action: index === 0 ? 'task' : index === 1 ? 'review' : 'ignore',
          title: index === 0 ? 'Müşteriye geri dön' : index === 1 ? 'Belirsiz talebi incele' : null,
          notes: index < 2 ? 'Codex tarafından anlamsal olarak değerlendirildi.' : null,
          dueAt: null
        }))
      };
      return {
        threadId: 'thr_scheduled_review',
        turnId: 'turn_scheduled_review',
        output: typeof output === 'string' ? output : JSON.stringify(output),
        model: 'gpt-test',
        reasoningEffort: 'medium'
      };
    }
  };
  const sourceAdapter = {
    configured: (source) => configuredSources.includes(source),
    async collect(source, window) {
      sourceCalls.push({ source, window });
      if (sourceFailure) {
        const error = new Error('offline');
        error.code = 'codex-review-source-unavailable';
        throw error;
      }
      return {
        complete: true,
        messages: [
          {
            source,
            messageKey: 'message-1',
            occurredAt: '2026-08-13T10:00:00.000Z',
            direction: 'incoming',
            conversation: 'Müşteri A',
            sender: 'Kişi A',
            subject: 'Durum',
            text: 'Buradaki metin anahtar kelime içermese de gerçek bir görevdir.',
            direct: true,
            ccOnly: false,
            chatKind: 'email',
            hasAttachment: false,
            broadcast: false
          },
          {
            source,
            messageKey: 'message-2',
            occurredAt: '2026-08-13T10:30:00.000Z',
            direction: 'incoming',
            conversation: 'Müşteri B',
            sender: 'Kişi B',
            subject: '',
            text: 'Bu kayıt belirsizdir; kararı Codex verir.',
            direct: true,
            ccOnly: false,
            chatKind: 'email',
            hasAttachment: false,
            broadcast: false
          },
          {
            source,
            messageKey: 'message-3',
            occurredAt: '2026-08-13T11:00:00.000Z',
            direction: 'incoming',
            conversation: 'Müşteri C',
            sender: 'Kişi C',
            subject: '',
            text: 'Codex bu kaydı anlamsal olarak yok sayacak.',
            direct: true,
            ccOnly: false,
            chatKind: 'email',
            hasAttachment: false,
            broadcast: false
          }
        ]
      };
    }
  };
  const timers = [];
  const manager = createCodexChecklistReviewManager({
    dataRoot,
    taskManager: tasks,
    notificationManager: notifications,
    sourceAdapter,
    codexConnectionManager: codex,
    clock,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {}
  });
  manager.start();
  return {
    codexCalls,
    dataRoot,
    manager,
    notifications,
    setTime(value) { current = new Date(value); },
    sourceCalls,
    tasks,
    timers
  };
}

function enable(instance, extra = {}) {
  return instance.manager.updateSettings({
    enabled: true,
    sources: { 'work-gmail': { enabled: true } },
    ...extra
  });
}

test('real Codex is the only decision authority and uncertain work becomes review', async () => {
  const instance = fixture();
  try {
    const initial = instance.manager.status();
    assert.equal(initial.intervalMinutes, DEFAULT_INTERVAL_MINUTES);
    assert.equal(initial.decisionAuthority, 'codex');
    assert.equal(initial.fallback, 'none');
    enable(instance, { intervalMinutes: 90 });
    assert.equal(instance.timers.at(-1).delay, 90 * 60_000);

    instance.setTime('2026-08-13T12:00:00.000Z');
    const result = await instance.manager.runNow();
    assert.deepEqual(
      { scanned: result.scanned, task: result.task, review: result.review, ignored: result.ignored },
      { scanned: 3, task: 1, review: 1, ignored: 1 }
    );
    assert.equal(result.created, 2);
    assert.equal(instance.codexCalls.length, 1);
    assert.match(instance.codexCalls[0].prompt, /untrusted message data/i);
    assert.match(instance.codexCalls[0].prompt, /anahtar kelime içermese/);
    assert.match(instance.codexCalls[0].prompt, /Ignore general conversation, community chatter/);
    assert.match(instance.codexCalls[0].prompt, /make sense without opening the source message/);

    const open = instance.tasks.list({ status: 'open' }).items;
    assert.equal(open.length, 2);
    assert.ok(open.some((task) => task.title === 'Müşteriye geri dön'));
    assert.ok(open.some((task) => task.title === 'Kontrol et: Belirsiz talebi incele'));
    assert.ok(open.every((task) => task.source === 'codex-review-work-gmail'));
    assert.ok(open.every((task) => task.sensitive === true));

    const stateText = fs.readFileSync(instance.manager.paths.stateFile, 'utf8');
    assert.doesNotMatch(stateText, /anahtar kelime içermese|Belirsiz talebi/);
    assert.equal(fs.statSync(instance.manager.paths.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(instance.manager.paths.settingsFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(instance.manager.paths.stateFile).mode & 0o777, 0o600);
    const report = instance.notifications.list({ source: 'codex-review' }).items
      .find((item) => item.category === 'scheduled-report');
    assert.ok(report);
    assert.match(report.body, /Codex 3 yeni iletiyi inceledi/);
    assert.equal(instance.manager.status().lastModel, 'gpt-test');
  } finally {
    instance.manager.stop();
  }
});

test('telegram review requires and forwards only explicitly selected work chats', async () => {
  const instance = fixture({ configuredSources: ['telegram'] });
  try {
    assert.throws(
      () => instance.manager.updateSettings({
        enabled: true,
        sources: { telegram: { enabled: true, chatRefs: [] } }
      }),
      (error) => error.code === 'codex-review-no-source'
    );

    const enabled = instance.manager.updateSettings({
      enabled: true,
      sources: {
        telegram: {
          enabled: true,
          chatRefs: ['tg_customer1', 'tg_project02']
        }
      }
    });
    const telegram = enabled.sources.find((source) => source.id === 'telegram');
    assert.equal(telegram.scopeReady, true);
    assert.equal(telegram.selectedChatCount, 2);
    assert.deepEqual(telegram.selectedChatRefs, ['tg_customer1', 'tg_project02']);

    instance.setTime('2026-08-13T12:00:00.000Z');
    await instance.manager.runNow();
    assert.equal(instance.sourceCalls.length, 1);
    assert.equal(instance.sourceCalls[0].source, 'telegram');
    assert.deepEqual(instance.sourceCalls[0].window.chatRefs, ['tg_customer1', 'tg_project02']);
  } finally {
    instance.manager.stop();
  }
});

test('invalid Codex output advances no cursor and never falls back to local classification', async () => {
  const instance = fixture({ codexOutput: '{invalid-json' });
  try {
    const enabled = enable(instance);
    const baseline = enabled.sources.find((source) => source.id === 'work-gmail').cursorAt;
    instance.setTime('2026-08-13T12:00:00.000Z');
    await assert.rejects(
      instance.manager.runNow(),
      (error) => error.code === 'codex-review-codex-failed'
    );
    assert.equal(instance.tasks.list({ status: 'open' }).items.length, 0);
    assert.equal(
      instance.manager.status().sources.find((source) => source.id === 'work-gmail').cursorAt,
      baseline
    );
    const warning = instance.notifications.list({ source: 'codex-review' }).items
      .find((item) => item.dedupeKey === 'health:codex');
    assert.ok(warning);
    assert.match(warning.body, /kural tabanlı bir yedek kullanılmadı/);
  } finally {
    instance.manager.stop();
  }
});

test('a source failure prevents the Codex turn and keeps every cursor at its baseline', async () => {
  const instance = fixture({ sourceFailure: true });
  try {
    const enabled = enable(instance);
    const baseline = enabled.sources.find((source) => source.id === 'work-gmail').cursorAt;
    instance.setTime('2026-08-13T12:00:00.000Z');
    await assert.rejects(
      instance.manager.runNow(),
      (error) => error.code === 'codex-review-source-failed'
    );
    assert.equal(instance.codexCalls.length, 0);
    assert.equal(
      instance.manager.status().sources.find((source) => source.id === 'work-gmail').cursorAt,
      baseline
    );
  } finally {
    instance.manager.stop();
  }
});
