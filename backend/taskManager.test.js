const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNotificationManager } = require('./notificationManager');
const { createTaskManager } = require('./taskManager');

const TASK_UUID = '12345678-1234-1234-1234-1234567890ab';

function fixture() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-tasks-'));
  let current = new Date('2026-08-13T12:00:00.000Z');
  let notificationCounter = 0;
  const notifications = createNotificationManager({
    dataRoot,
    clock: () => current,
    randomUUID: () => notificationCounter++ === 0
      ? '22345678-1234-1234-1234-1234567890ab'
      : '32345678-1234-1234-1234-1234567890ab'
  });
  const tasks = createTaskManager({
    dataRoot,
    notificationManager: notifications,
    clock: () => current,
    randomUUID: () => TASK_UUID,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {}
  });
  return {
    cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
    dataRoot,
    notifications,
    setCurrent: (value) => { current = new Date(value); },
    tasks
  };
}

test('checklist persists tasks, emits due reminders and resolves them on completion', () => {
  const instance = fixture();
  try {
    const created = instance.tasks.create({
      title: 'Teklifi gönder',
      notes: 'Son sürümü ekle.',
      dueAt: '2026-08-13T15:00:00+03:00',
      timeZone: 'Europe/Istanbul',
      source: 'codex',
      externalKey: 'proposal-2026-08-13'
    });
    assert.equal(created.created, true);
    assert.equal(created.task.id, 'tsk_123456781234123412341234567890ab');
    assert.equal(created.task.reminderSentAt, '2026-08-13T12:00:00.000Z');
    assert.equal(instance.tasks.list({ status: 'open' }).items.length, 1);
    assert.deepEqual(instance.tasks.stats(), { total: 1, open: 1, overdue: 0, completed: 0 });
    assert.equal(fs.statSync(instance.tasks.paths.stateFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(instance.tasks.paths.stateFile)).mode & 0o777, 0o700);

    const reminder = instance.notifications.list().items[0];
    assert.equal(reminder.source, 'checklist');
    assert.equal(reminder.category, 'task-reminder');
    assert.equal(reminder.dedupeKey, created.task.id);
    assert.deepEqual(reminder.target, { app: 'checklist', tab: null, date: null });

    const completed = instance.tasks.complete(created.task.id);
    assert.equal(completed.changed, true);
    assert.equal(completed.task.status, 'completed');
    assert.equal(instance.notifications.list().items[0].status, 'resolved');
    assert.deepEqual(instance.tasks.stats(), { total: 1, open: 0, overdue: 0, completed: 1 });

    const reloaded = createTaskManager({
      dataRoot: instance.dataRoot,
      notificationManager: instance.notifications,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {}
    });
    assert.equal(reloaded.get(created.task.id).status, 'completed');
    assert.equal(reloaded.complete(created.task.id).changed, false);
  } finally {
    instance.cleanup();
  }
});

test('task upserts stay deduplicated and snooze schedules a fresh reminder', () => {
  const instance = fixture();
  try {
    const first = instance.tasks.create({
      title: 'Müşteri notunu kontrol et',
      dueAt: '2026-08-13T11:59:00.000Z',
      timeZone: 'UTC',
      source: 'gmail',
      externalKey: 'thread-safe-key',
      sensitive: true
    });
    const firstReminder = instance.notifications.list().items[0];
    assert.equal(firstReminder.sensitive, true);

    const repeated = instance.tasks.create({
      title: 'Müşteri notunu yeniden kontrol et',
      dueAt: '2026-08-13T13:00:00.000Z',
      timeZone: 'UTC',
      source: 'gmail',
      externalKey: 'thread-safe-key',
      sensitive: true
    });
    assert.equal(repeated.created, false);
    assert.equal(repeated.task.id, first.task.id);
    assert.equal(instance.tasks.list().items.length, 1);
    assert.equal(repeated.task.reminderSentAt, null);
    assert.equal(instance.notifications.list().items[0].status, 'resolved');

    instance.setCurrent('2026-08-13T13:00:00.000Z');
    assert.equal(instance.tasks.dispatchDueReminders().reminded, 1);
    const activeReminder = instance.notifications.list().items.find((item) => item.status !== 'resolved');
    assert.ok(activeReminder);
    assert.notEqual(activeReminder.id, firstReminder.id);

    const snoozed = instance.tasks.snooze(first.task.id, {
      until: '2026-08-13T14:00:00.000Z'
    });
    assert.equal(snoozed.task.dueAt, '2026-08-13T14:00:00.000Z');
    assert.equal(snoozed.task.reminderSentAt, null);
    assert.equal(instance.notifications.list().items.find((item) => item.id === activeReminder.id).status, 'resolved');

    instance.setCurrent('2026-08-13T14:00:00.000Z');
    assert.equal(instance.tasks.dispatchDueReminders().reminded, 1);
    assert.equal(instance.tasks.list().items[0].reminderSentAt, '2026-08-13T14:00:00.000Z');
    assert.throws(
      () => instance.tasks.snooze(first.task.id, { until: '2026-08-13T13:00:00.000Z' }),
      (error) => error.code === 'task-snooze-invalid'
    );
  } finally {
    instance.cleanup();
  }
});
