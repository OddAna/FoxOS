const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { atomicWriteJson } = require('./resourceRegistry');

const TASK_SCHEMA_VERSION = 1;
const TASK_ID_PATTERN = /^tsk_[a-f0-9]{32}$/;
const NOTIFICATION_ID_PATTERN = /^ntf_[a-f0-9]{32}$/;
const TASK_STATUSES = new Set(['open', 'completed']);
const MAX_TASKS = 2_000;
const MAX_REMINDERS_PER_PASS = 100;
const DEFAULT_REMINDER_INTERVAL_MS = 30_000;

class TaskError extends Error {
  constructor(message, statusCode = 400, code = 'task-error') {
    super(message);
    this.name = 'TaskError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function boundedText(value, { label, maximum, required = false, multiline = false }) {
  if (value === undefined || value === null) {
    if (required) throw new TaskError(`${label} zorunludur.`, 400, 'task-field-required');
    return '';
  }
  if (typeof value !== 'string') {
    throw new TaskError(`${label} geçersiz.`, 400, 'task-field-invalid');
  }
  const text = value.trim();
  if (
    (required && !text) || text.length > maximum || text.includes('\0') ||
    (!multiline && /[\r\n]/.test(text))
  ) {
    throw new TaskError(`${label} geçersiz.`, 400, 'task-field-invalid');
  }
  return text;
}

function normalizeSlug(value, fallback = 'owner') {
  const slug = boundedText(value === undefined || value === null || value === '' ? fallback : value, {
    label: 'Görev kaynağı', maximum: 64, required: true
  }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) {
    throw new TaskError('Görev kaynağı geçersiz.', 400, 'task-source-invalid');
  }
  return slug;
}

function normalizeTimestamp(value, label, { optional = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw new TaskError(`${label} zorunludur.`, 400, 'task-time-required');
  }
  const text = boundedText(value, { label, maximum: 40, required: true });
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new TaskError(`${label} geçersiz.`, 400, 'task-time-invalid');
  }
  return new Date(parsed).toISOString();
}

function normalizeTimezone(value, fallback = 'UTC') {
  const timezone = boundedText(value === undefined || value === null || value === '' ? fallback : value, {
    label: 'Görev saat dilimi', maximum: 100, required: true
  });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new TaskError('Görev saat dilimi geçersiz.', 400, 'task-timezone-invalid');
  }
  return timezone;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function optionalTimestamp(value) {
  return value === null || value === undefined || validTimestamp(value);
}

function taskInput(input, base = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TaskError('Görev bilgileri geçersiz.', 400, 'task-invalid');
  }
  const has = (key) => Object.hasOwn(input, key);
  const sensitive = has('sensitive') ? input.sensitive : base ? base.sensitive : false;
  if (typeof sensitive !== 'boolean') {
    throw new TaskError('Görev gizlilik ayarı geçersiz.', 400, 'task-sensitive-invalid');
  }
  return {
    title: has('title')
      ? boundedText(input.title, { label: 'Görev başlığı', maximum: 240, required: true })
      : base && base.title,
    notes: has('notes')
      ? boundedText(input.notes, { label: 'Görev notu', maximum: 4_000, multiline: true })
      : base ? base.notes : '',
    dueAt: has('dueAt')
      ? normalizeTimestamp(input.dueAt, 'Görev zamanı')
      : base ? base.dueAt : null,
    timeZone: has('timeZone')
      ? normalizeTimezone(input.timeZone)
      : base ? base.timeZone : 'UTC',
    source: has('source')
      ? normalizeSlug(input.source)
      : base ? base.source : 'owner',
    externalKey: has('externalKey')
      ? boundedText(input.externalKey, {
        label: 'Görev tekilleştirme anahtarı', maximum: 180
      }) || null
      : base ? base.externalKey : null,
    sensitive
  };
}

function publicTask(task) {
  return { ...task };
}

function clipped(value, maximum) {
  const text = String(value || '');
  if (text.length <= maximum) return text;
  return text.slice(0, Math.max(0, maximum - 1)).trimEnd() + '…';
}

function createTaskManager({
  dataRoot,
  notificationManager,
  clock = () => new Date(),
  randomUUID = crypto.randomUUID,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  reminderIntervalMs = DEFAULT_REMINDER_INTERVAL_MS,
  onError = () => {}
}) {
  if (
    typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) ||
    !notificationManager || typeof notificationManager.create !== 'function' ||
    typeof notificationManager.resolveByDedupeKey !== 'function' ||
    typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function' ||
    !Number.isSafeInteger(reminderIntervalMs) || reminderIntervalMs < 1_000
  ) {
    throw new TypeError('Task manager requires data, notification and timer adapters');
  }

  const stateFile = path.join(dataRoot, 'tasks', 'state.json');
  const events = new EventEmitter();
  events.setMaxListeners(100);
  let reminderTimer = null;
  let running = false;

  function nowDate() {
    return new Date(clock());
  }

  function now() {
    return nowDate().toISOString();
  }

  function emptyState() {
    return {
      schemaVersion: TASK_SCHEMA_VERSION,
      updatedAt: null,
      tasks: []
    };
  }

  function readState() {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw new TaskError('Görev verisi okunamadı.', 503, 'task-state-invalid');
    }
    if (
      !payload || payload.schemaVersion !== TASK_SCHEMA_VERSION ||
      !Array.isArray(payload.tasks) || payload.tasks.length > MAX_TASKS
    ) {
      throw new TaskError('Görev verisi okunamadı.', 503, 'task-state-invalid');
    }
    for (const task of payload.tasks) {
      if (
        !task || !TASK_ID_PATTERN.test(String(task.id || '')) ||
        !TASK_STATUSES.has(task.status) ||
        !validTimestamp(task.createdAt) || !validTimestamp(task.updatedAt) ||
        !optionalTimestamp(task.completedAt) || !optionalTimestamp(task.reminderSentAt) ||
        (task.reminderNotificationId !== null && task.reminderNotificationId !== undefined &&
          !NOTIFICATION_ID_PATTERN.test(String(task.reminderNotificationId))) ||
        (task.status === 'completed') !== Boolean(task.completedAt)
      ) {
        throw new TaskError('Görev verisi okunamadı.', 503, 'task-state-invalid');
      }
      try {
        taskInput(task);
      } catch {
        throw new TaskError('Görev verisi okunamadı.', 503, 'task-state-invalid');
      }
    }
    return {
      schemaVersion: TASK_SCHEMA_VERSION,
      updatedAt: payload.updatedAt || null,
      tasks: payload.tasks
    };
  }

  function sorted(tasks) {
    return [...tasks].sort((left, right) => {
      if (left.status !== right.status) return left.status === 'open' ? -1 : 1;
      if (left.status === 'completed') return right.updatedAt.localeCompare(left.updatedAt);
      if (left.dueAt && right.dueAt) return left.dueAt.localeCompare(right.dueAt);
      if (left.dueAt) return -1;
      if (right.dueAt) return 1;
      return right.createdAt.localeCompare(left.createdAt);
    });
  }

  function statsFrom(current) {
    const currentMs = nowDate().getTime();
    const open = current.tasks.filter((task) => task.status === 'open');
    return {
      total: current.tasks.length,
      open: open.length,
      overdue: open.filter((task) => task.dueAt && Date.parse(task.dueAt) < currentMs).length,
      completed: current.tasks.length - open.length
    };
  }

  function persist(nextState, changeType = 'tasks-changed') {
    const updatedAt = now();
    const tasks = sorted(nextState.tasks).slice(0, MAX_TASKS);
    atomicWriteJson(stateFile, {
      schemaVersion: TASK_SCHEMA_VERSION,
      updatedAt,
      tasks
    });
    events.emit('change', { type: changeType, updatedAt });
    return { ...nextState, tasks, updatedAt };
  }

  function get(taskId) {
    if (!TASK_ID_PATTERN.test(String(taskId || ''))) {
      throw new TaskError('Görev kimliği geçersiz.', 400, 'task-id-invalid');
    }
    const task = readState().tasks.find((entry) => entry.id === taskId);
    if (!task) throw new TaskError('Görev bulunamadı.', 404, 'task-not-found');
    return publicTask(task);
  }

  function list({ status = 'all', limit = 100 } = {}) {
    if (!['all', ...TASK_STATUSES].includes(status)) {
      throw new TaskError('Görev durumu geçersiz.', 400, 'task-status-invalid');
    }
    const boundedLimit = Number(limit);
    if (!Number.isSafeInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 500) {
      throw new TaskError('Görev liste sınırı geçersiz.', 400, 'task-limit-invalid');
    }
    const current = readState();
    const items = sorted(current.tasks)
      .filter((task) => status === 'all' || task.status === status)
      .slice(0, boundedLimit)
      .map(publicTask);
    return { items, stats: statsFrom(current), updatedAt: current.updatedAt };
  }

  function resolveReminder(taskId) {
    try {
      notificationManager.resolveByDedupeKey({ source: 'checklist', dedupeKey: taskId });
    } catch (error) {
      if (error && error.code !== 'notification-not-found') onError(error);
    }
  }

  function reminderBody(task) {
    const formatted = new Intl.DateTimeFormat('tr-TR', {
      timeZone: task.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(task.dueAt));
    const parts = [`Zaman: ${formatted} (${task.timeZone})`];
    if (task.notes) parts.push('', clipped(task.notes, 1_800));
    return parts.join('\n');
  }

  function dispatchDueReminders() {
    let reminded = 0;
    const dueIds = readState().tasks
      .filter((task) => (
        task.status === 'open' && task.dueAt && !task.reminderSentAt &&
        Date.parse(task.dueAt) <= nowDate().getTime()
      ))
      .slice(0, MAX_REMINDERS_PER_PASS)
      .map((task) => task.id);

    for (const taskId of dueIds) {
      const current = readState();
      const task = current.tasks.find((entry) => entry.id === taskId);
      if (
        !task || task.status !== 'open' || !task.dueAt || task.reminderSentAt ||
        Date.parse(task.dueAt) > nowDate().getTime()
      ) continue;
      const notification = notificationManager.create({
        source: 'checklist',
        category: 'task-reminder',
        severity: 'info',
        title: clipped(`Görev zamanı: ${task.title}`, 140),
        body: reminderBody(task),
        dedupeKey: task.id,
        threadId: task.id,
        target: { app: 'checklist' },
        sensitive: task.sensitive
      });
      const timestamp = now();
      const updated = {
        ...task,
        reminderSentAt: timestamp,
        reminderNotificationId: notification.id,
        updatedAt: timestamp
      };
      persist({
        ...current,
        tasks: current.tasks.map((entry) => entry.id === task.id ? updated : entry)
      }, 'task-reminded');
      reminded += 1;
    }
    return { reminded };
  }

  function create(input) {
    const normalized = taskInput(input);
    if (!normalized.title) {
      throw new TaskError('Görev başlığı zorunludur.', 400, 'task-field-required');
    }
    const current = readState();
    const timestamp = now();
    const existing = normalized.externalKey
      ? current.tasks.find((task) => (
        task.source === normalized.source && task.externalKey === normalized.externalKey
      ))
      : null;
    let task;
    let created = false;
    if (existing) {
      const dueChanged = existing.dueAt !== normalized.dueAt;
      task = {
        ...existing,
        ...normalized,
        updatedAt: timestamp,
        reminderSentAt: dueChanged && existing.status === 'open' ? null : existing.reminderSentAt,
        reminderNotificationId: dueChanged && existing.status === 'open'
          ? null
          : existing.reminderNotificationId
      };
      persist({
        ...current,
        tasks: current.tasks.map((entry) => entry.id === task.id ? task : entry)
      }, 'task-updated');
      if (dueChanged && existing.status === 'open') resolveReminder(existing.id);
    } else {
      if (current.tasks.length >= MAX_TASKS) {
        throw new TaskError('Görev sınırına ulaşıldı.', 409, 'task-limit-reached');
      }
      task = {
        id: 'tsk_' + randomUUID().replace(/-/g, '').toLowerCase(),
        ...normalized,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        reminderSentAt: null,
        reminderNotificationId: null
      };
      persist({ ...current, tasks: [task, ...current.tasks] }, 'task-created');
      created = true;
    }
    dispatchDueReminders();
    return { task: get(task.id), created };
  }

  function update(taskId, input) {
    const current = readState();
    const existing = get(taskId);
    const normalized = taskInput(input, existing);
    if (!normalized.title) {
      throw new TaskError('Görev başlığı zorunludur.', 400, 'task-field-required');
    }
    const dueChanged = existing.dueAt !== normalized.dueAt;
    const timestamp = now();
    const task = {
      ...existing,
      ...normalized,
      updatedAt: timestamp,
      reminderSentAt: dueChanged && existing.status === 'open' ? null : existing.reminderSentAt,
      reminderNotificationId: dueChanged && existing.status === 'open'
        ? null
        : existing.reminderNotificationId
    };
    persist({
      ...current,
      tasks: current.tasks.map((entry) => entry.id === task.id ? task : entry)
    }, 'task-updated');
    if (dueChanged && existing.status === 'open') resolveReminder(existing.id);
    dispatchDueReminders();
    return { task: get(task.id), changed: true };
  }

  function complete(taskId) {
    const current = readState();
    const existing = get(taskId);
    if (existing.status === 'completed') return { task: existing, changed: false };
    const timestamp = now();
    const task = {
      ...existing,
      status: 'completed',
      completedAt: timestamp,
      updatedAt: timestamp
    };
    persist({
      ...current,
      tasks: current.tasks.map((entry) => entry.id === task.id ? task : entry)
    }, 'task-completed');
    resolveReminder(task.id);
    return { task: publicTask(task), changed: true };
  }

  function reopen(taskId) {
    const current = readState();
    const existing = get(taskId);
    if (existing.status === 'open') return { task: existing, changed: false };
    const timestamp = now();
    const task = {
      ...existing,
      status: 'open',
      completedAt: null,
      reminderSentAt: null,
      reminderNotificationId: null,
      updatedAt: timestamp
    };
    persist({
      ...current,
      tasks: current.tasks.map((entry) => entry.id === task.id ? task : entry)
    }, 'task-reopened');
    dispatchDueReminders();
    return { task: get(task.id), changed: true };
  }

  function snooze(taskId, input) {
    const current = readState();
    const existing = get(taskId);
    if (existing.status !== 'open') {
      throw new TaskError('Yalnız açık görev ertelenebilir.', 409, 'task-not-open');
    }
    const dueAt = normalizeTimestamp(input && input.until, 'Yeni görev zamanı', { optional: false });
    const dueMs = Date.parse(dueAt);
    const currentMs = nowDate().getTime();
    if (dueMs <= currentMs || dueMs > currentMs + 30 * 86_400_000) {
      throw new TaskError('Yeni görev zamanı geçersiz.', 400, 'task-snooze-invalid');
    }
    const timestamp = now();
    const task = {
      ...existing,
      dueAt,
      reminderSentAt: null,
      reminderNotificationId: null,
      updatedAt: timestamp
    };
    persist({
      ...current,
      tasks: current.tasks.map((entry) => entry.id === task.id ? task : entry)
    }, 'task-snoozed');
    resolveReminder(task.id);
    return { task: publicTask(task), changed: true };
  }

  function stats() {
    return statsFrom(readState());
  }

  function runReminderPass() {
    try {
      dispatchDueReminders();
    } catch (error) {
      onError(error);
    }
  }

  function start() {
    if (running) return { running: true };
    running = true;
    runReminderPass();
    reminderTimer = setIntervalFn(runReminderPass, reminderIntervalMs);
    if (reminderTimer && typeof reminderTimer.unref === 'function') reminderTimer.unref();
    return { running: true };
  }

  function stop() {
    running = false;
    if (reminderTimer) clearIntervalFn(reminderTimer);
    reminderTimer = null;
  }

  return {
    complete,
    create,
    dispatchDueReminders,
    get,
    list,
    onChange: (listener) => {
      events.on('change', listener);
      return () => events.off('change', listener);
    },
    paths: { stateFile },
    reopen,
    snooze,
    start,
    stats,
    stop,
    update
  };
}

module.exports = {
  DEFAULT_REMINDER_INTERVAL_MS,
  TASK_ID_PATTERN,
  TASK_SCHEMA_VERSION,
  TaskError,
  createTaskManager
};
