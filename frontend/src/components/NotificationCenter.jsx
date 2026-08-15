import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  BellRing,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  Clock3,
  Info,
  ListTodo,
  Plus,
  RotateCcw,
  Settings
} from 'lucide-react';
import { apiFetch } from '../api';
import { useI18n } from '../contexts/LocaleContext';

const EMPTY_STATS = { total: 0, unread: 0, criticalUnread: 0, snoozed: 0, resolved: 0, sources: 0 };
const EMPTY_TASK_STATS = { total: 0, open: 0, overdue: 0, completed: 0 };

function relativeTime(value, t, formatDate) {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return t('notificationCenter.now');
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t('notificationCenter.now');
  if (minutes < 60) return t('notificationCenter.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('notificationCenter.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return days < 7
    ? t('notificationCenter.daysAgo', { count: days })
    : formatDate(value, { day: 'numeric', month: 'short' });
}

function taskDueLabel(task, t, formatDate, formatTime) {
  if (!task.dueAt) return t('notificationCenter.noReminder');
  const date = new Date(task.dueAt);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const sameDay = (left, right) => (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
  const time = formatTime(date);
  if (sameDay(date, now)) return t(
    date.getTime() < now.getTime() ? 'notificationCenter.overdueAt' : 'notificationCenter.todayAt',
    { time }
  );
  if (sameDay(date, tomorrow)) return t('notificationCenter.tomorrowAt', { time });
  return formatDate(date, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function taskDateLabel(value, taskTimeZone, t, formatDate, { includeZone = false } = {}) {
  if (!value) return t('notificationCenter.unspecified');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return t('notificationCenter.unspecified');
  const zone = taskTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const formatted = formatDate(date, {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short'
  });
  return includeZone ? `${formatted} · ${zone}` : formatted;
}

function taskSourceLabel(source, t) {
  const normalized = String(source || '').toLocaleLowerCase('en-US');
  if (!normalized || normalized === 'owner') return 'FoxOS';
  if (normalized.includes('google-chat')) return 'Google Chat';
  if (normalized.includes('whatsapp') || normalized.includes('evolution')) return 'WhatsApp';
  if (normalized.includes('telegram')) return 'Telegram';
  if (normalized.includes('gmail') || normalized.includes('mail')) return t('notificationCenter.email');
  if (normalized.includes('codex')) return 'Codex';
  return source;
}

function SeverityIcon({ severity }) {
  if (severity === 'critical' || severity === 'warning') return <CircleAlert size={16} aria-hidden="true" />;
  if (severity === 'success') return <CheckCircle2 size={16} aria-hidden="true" />;
  return <Info size={16} aria-hidden="true" />;
}

function ChecklistRow({ busy, expanded, onExpand, onToggle, task }) {
  const { formatDate, formatTime, t } = useI18n();
  const completed = task.status === 'completed';
  const overdue = !completed && task.dueAt && Date.parse(task.dueAt) < Date.now();
  const detailsId = `checklist-details-${task.id}`;
  return (
    <div className={`checklist-row${completed ? ' is-completed' : ''}${overdue ? ' is-overdue' : ''}${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="checklist-toggle"
        disabled={busy}
        title={t(completed ? 'notificationCenter.reopenTask' : 'notificationCenter.completeTask')}
        aria-label={t(completed ? 'notificationCenter.reopenTaskLabel' : 'notificationCenter.completeTaskLabel', { title: task.title })}
        onClick={() => onToggle(task)}
      >
        {completed ? <RotateCcw size={15} aria-hidden="true" /> : <Circle size={18} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="checklist-summary"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => onExpand(task)}
      >
        <span className="checklist-copy">
          <strong>{task.title}</strong>
          {task.notes && !expanded && <span className="checklist-notes">{task.notes}</span>}
          <span className="checklist-meta">
            <Clock3 size={11} aria-hidden="true" />
            {completed
              ? t('notificationCenter.completedAgo', { time: relativeTime(task.completedAt, t, formatDate) })
              : taskDueLabel(task, t, formatDate, formatTime)}
            {task.source && task.source !== 'owner' && <em>{taskSourceLabel(task.source, t)}</em>}
          </span>
        </span>
        <ChevronDown size={16} className="checklist-disclosure" aria-hidden="true" />
      </button>
      {expanded && (
        <section className="checklist-details" id={detailsId} aria-label={t('notificationCenter.detailsLabel', { title: task.title })}>
          <div className={`checklist-detail-notes${task.notes ? '' : ' is-empty'}`}>
            {task.notes || t('notificationCenter.noNotes')}
          </div>
          <dl className="checklist-detail-facts">
            <div>
              <dt>{t('notificationCenter.source')}</dt>
              <dd>{taskSourceLabel(task.source, t)}</dd>
            </div>
            <div>
              <dt>{t('notificationCenter.reminder')}</dt>
              <dd>{task.dueAt
                ? taskDateLabel(task.dueAt, task.timeZone, t, formatDate, { includeZone: true })
                : t('notificationCenter.notSet')}</dd>
            </div>
            <div>
              <dt>{t('notificationCenter.created')}</dt>
              <dd>{taskDateLabel(task.createdAt, task.timeZone, t, formatDate)}</dd>
            </div>
            <div>
              <dt>{t('notificationCenter.status')}</dt>
              <dd>{completed
                ? t('notificationCenter.completedAt', { date: taskDateLabel(task.completedAt, task.timeZone, t, formatDate) })
                : t(overdue ? 'notificationCenter.overdue' : 'notificationCenter.open')}</dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}

const NotificationCenter = ({ onOpenSettings, onOpenTarget }) => {
  const { formatDate, t, timeZone } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeView, setActiveView] = useState('notifications');
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(EMPTY_STATS);
  const [tasks, setTasks] = useState([]);
  const [taskStats, setTaskStats] = useState(EMPTY_TASK_STATS);
  const [showCompleted, setShowCompleted] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDue, setNewTaskDue] = useState('');
  const [taskBusy, setTaskBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const rootRef = useRef(null);
  const popoverRef = useRef(null);

  const openTasks = useMemo(() => tasks.filter((task) => task.status === 'open'), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((task) => task.status === 'completed'), [tasks]);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const [notificationResponse, taskResponse] = await Promise.all([
        apiFetch('/api/notifications?limit=12'),
        apiFetch('/api/tasks?status=all&limit=100')
      ]);
      const [notificationPayload, taskPayload] = await Promise.all([
        notificationResponse.json(),
        taskResponse.json()
      ]);
      setItems(Array.isArray(notificationPayload.items) ? notificationPayload.items : []);
      setStats(notificationPayload.stats || EMPTY_STATS);
      setTasks(Array.isArray(taskPayload.items) ? taskPayload.items : []);
      setTaskStats(taskPayload.stats || EMPTY_TASK_STATS);
      setError('');
    } catch (requestError) {
      setError(requestError.message || t('notificationCenter.loadError'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
    const stream = new EventSource('/api/notifications/stream');
    const refresh = () => load({ quiet: true });
    stream.addEventListener('ready', refresh);
    stream.addEventListener('change', refresh);
    const visibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      stream.close();
      document.removeEventListener('visibilitychange', visibility);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (
        !rootRef.current?.contains(event.target) &&
        !popoverRef.current?.contains(event.target)
      ) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const handleMessage = (event) => {
      if (event.data?.type !== 'foxos:notification-open') return;
      const target = event.data.target || null;
      if (target?.app === 'checklist') {
        setActiveView('tasks');
        setOpen(true);
      } else {
        onOpenTarget?.({ target });
      }
      load({ quiet: true });
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [load, onOpenTarget]);

  const updateStatus = async (notification, status, extra = {}) => {
    try {
      await apiFetch(`/api/notifications/${encodeURIComponent(notification.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...extra })
      });
      await load({ quiet: true });
    } catch (requestError) {
      setError(requestError.message || t('notificationCenter.updateError'));
    }
  };

  const openNotification = async (notification) => {
    if (notification.status === 'unread') await updateStatus(notification, 'read');
    if (notification.target?.app === 'checklist') {
      setActiveView('tasks');
      return;
    }
    if (notification.target) onOpenTarget?.(notification);
    setOpen(false);
  };

  const readAll = async () => {
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST' });
      await load({ quiet: true });
    } catch (requestError) {
      setError(requestError.message || t('notificationCenter.updateAllError'));
    }
  };

  const createTask = async (event) => {
    event.preventDefault();
    const title = newTaskTitle.trim();
    if (!title) return;
    setTaskBusy('create');
    try {
      await apiFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          dueAt: newTaskDue ? new Date(newTaskDue).toISOString() : null,
          timeZone,
          source: 'owner'
        })
      });
      setNewTaskTitle('');
      setNewTaskDue('');
      await load({ quiet: true });
    } catch (requestError) {
      setError(requestError.message || t('notificationCenter.taskCreateError'));
    } finally {
      setTaskBusy('');
    }
  };

  const toggleTask = async (task) => {
    setTaskBusy(task.id);
    try {
      const action = task.status === 'completed' ? 'reopen' : 'complete';
      await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, { method: 'POST' });
      setExpandedTaskId((current) => current === task.id ? '' : current);
      await load({ quiet: true });
    } catch (requestError) {
      setError(requestError.message || t('notificationCenter.taskUpdateError'));
    } finally {
      setTaskBusy('');
    }
  };

  const expandTask = (task) => {
    setExpandedTaskId((current) => current === task.id ? '' : task.id);
  };

  const viewSubtitle = activeView === 'tasks'
    ? taskStats.open
      ? t(taskStats.overdue ? 'notificationCenter.openTasksOverdue' : 'notificationCenter.openTasks', {
          count: taskStats.open,
          overdue: taskStats.overdue
        })
      : t('notificationCenter.noOpenTasks')
    : stats.unread
      ? t('notificationCenter.unread', { count: stats.unread })
      : t('notificationCenter.allSeen');

  return (
    <div className="notification-center" ref={rootRef}>
      <button
        type="button"
        className="topbar-item topbar-notification-trigger"
        title={t('notificationCenter.title')}
        aria-label={t('notificationCenter.triggerLabel', { unread: stats.unread, open: taskStats.open })}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
          if (!open) load({ quiet: true });
        }}
      >
        {stats.unread ? <BellRing size={15} aria-hidden="true" /> : <Bell size={15} aria-hidden="true" />}
        {stats.unread > 0 && (
          <span className={`notification-badge${stats.criticalUnread ? ' is-critical' : ''}`}>
            {stats.unread > 99 ? '99+' : stats.unread}
          </span>
        )}
      </button>

      {open && createPortal(
        <section
          className="notification-popover"
          ref={popoverRef}
          aria-label={t('notificationCenter.title')}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="notification-popover-header">
            <div>
              <strong>{t(activeView === 'tasks' ? 'notificationCenter.tasks' : 'notificationCenter.notifications')}</strong>
              <span>{viewSubtitle}</span>
            </div>
            {activeView === 'notifications' && stats.unread > 0 && (
              <button type="button" onClick={readAll} title={t('notificationCenter.markAllRead')}>
                <CheckCheck size={16} aria-hidden="true" />
                <span>{t('notificationCenter.readAll')}</span>
              </button>
            )}
          </header>

          <nav className="notification-popover-tabs" aria-label={t('notificationCenter.viewLabel')}>
            <button
              type="button"
              className={activeView === 'notifications' ? 'is-active' : ''}
              onClick={() => setActiveView('notifications')}
            >
              <Bell size={14} aria-hidden="true" /> {t('notificationCenter.notifications')}
              {stats.unread > 0 && <span>{stats.unread > 99 ? '99+' : stats.unread}</span>}
            </button>
            <button
              type="button"
              className={activeView === 'tasks' ? 'is-active' : ''}
              onClick={() => setActiveView('tasks')}
            >
              <ListTodo size={15} aria-hidden="true" /> {t('notificationCenter.tasks')}
              {taskStats.open > 0 && <span className={taskStats.overdue ? 'is-overdue' : ''}>{taskStats.open}</span>}
            </button>
          </nav>

          {activeView === 'notifications' ? (
            <div className="notification-popover-list">
              {loading && <div className="notification-empty">{t('notificationCenter.notificationsLoading')}</div>}
              {!loading && error && <div className="notification-empty is-error">{error}</div>}
              {!loading && !error && items.length === 0 && (
                <div className="notification-empty">
                  <Check size={22} aria-hidden="true" />
                  <strong>{t('notificationCenter.quietTitle')}</strong>
                  <span>{t('notificationCenter.quietDescription')}</span>
                </div>
              )}
              {!loading && !error && items.map((notification) => (
                <button
                  type="button"
                  className={`notification-row severity-${notification.severity}${notification.status === 'unread' ? ' is-unread' : ''}`}
                  key={notification.id}
                  onClick={() => openNotification(notification)}
                >
                  <span className="notification-row-icon"><SeverityIcon severity={notification.severity} /></span>
                  <span className="notification-row-copy">
                    <span className="notification-row-title">
                      {notification.title}
                      {notification.occurrenceCount > 1 && <em>×{notification.occurrenceCount}</em>}
                    </span>
                    {notification.body && <span className="notification-row-body">{notification.body}</span>}
                    <span className="notification-row-meta">
                      {notification.source} · {relativeTime(notification.lastOccurredAt, t, formatDate)}
                      {notification.status === 'snoozed' && <><Clock3 size={11} /> {t('notificationCenter.snoozed')}</>}
                    </span>
                  </span>
                  {notification.status === 'unread' && <span className="notification-unread-dot" aria-hidden="true" />}
                </button>
              ))}
            </div>
          ) : (
            <div className="checklist-panel">
              <form className="checklist-create" onSubmit={createTask}>
                <input
                  type="text"
                  maxLength={240}
                  value={newTaskTitle}
                  placeholder={t('notificationCenter.newTask')}
                  aria-label={t('notificationCenter.newTaskLabel')}
                  onChange={(event) => setNewTaskTitle(event.target.value)}
                />
                <div>
                  <label>
                    <Clock3 size={13} aria-hidden="true" />
                    <input
                      type="datetime-local"
                      value={newTaskDue}
                      aria-label={t('notificationCenter.reminderTime')}
                      onChange={(event) => setNewTaskDue(event.target.value)}
                    />
                  </label>
                  <button type="submit" disabled={!newTaskTitle.trim() || taskBusy === 'create'}>
                    <Plus size={15} aria-hidden="true" /> {t('notificationCenter.add')}
                  </button>
                </div>
              </form>

              <div className="checklist-list">
                {loading && <div className="notification-empty">{t('notificationCenter.tasksLoading')}</div>}
                {!loading && error && <div className="notification-empty is-error">{error}</div>}
                {!loading && !error && openTasks.length === 0 && (
                  <div className="notification-empty checklist-empty">
                    <CheckCircle2 size={24} aria-hidden="true" />
                    <strong>{t('notificationCenter.emptyTasksTitle')}</strong>
                    <span>{t('notificationCenter.emptyTasksDescription')}</span>
                  </div>
                )}
                {!loading && !error && openTasks.map((task) => (
                  <ChecklistRow
                    key={task.id}
                    task={task}
                    busy={taskBusy === task.id}
                    expanded={expandedTaskId === task.id}
                    onExpand={expandTask}
                    onToggle={toggleTask}
                  />
                ))}
                {!loading && !error && completedTasks.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="checklist-completed-toggle"
                      onClick={() => setShowCompleted((current) => !current)}
                    >
                      <CheckCircle2 size={14} aria-hidden="true" />
                      {t('notificationCenter.completedTasks', { count: completedTasks.length })}
                      <span>{t(showCompleted ? 'notificationCenter.hide' : 'notificationCenter.show')}</span>
                    </button>
                    {showCompleted && completedTasks.slice(0, 20).map((task) => (
                      <ChecklistRow
                        key={task.id}
                        task={task}
                        busy={taskBusy === task.id}
                        expanded={expandedTaskId === task.id}
                        onExpand={expandTask}
                        onToggle={toggleTask}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>
          )}

          <footer className="notification-popover-footer">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings?.();
              }}
            >
              <Settings size={14} aria-hidden="true" />
              {t(activeView === 'tasks' ? 'notificationCenter.reminderSettings' : 'notificationCenter.notificationSettings')}
            </button>
          </footer>
        </section>,
        document.body
      )}
    </div>
  );
};

export default NotificationCenter;
