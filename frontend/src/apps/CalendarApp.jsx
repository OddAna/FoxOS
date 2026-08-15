import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Link2,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react';
import { apiFetch } from '../api';
import { useDialog } from '../contexts/DialogContext';
import { useI18n } from '../contexts/LocaleContext';
import { useWindowManager } from '../contexts/WindowContext';
import {
  calendarGridRange,
  calendarMonthGrid,
  parseCalendarDate,
  shiftCalendarMonth
} from '../utils/calendarDates';
import './CalendarApp.css';

const COLORS = ['sky', 'green', 'orange', 'pink', 'purple'];
const LOCAL_SOURCE = {
  id: 'local',
  accountId: null,
  provider: 'local',
  providerName: 'FoxOS',
  accountName: 'FoxOS',
  calendarId: 'local',
  name: 'FoxOS',
  writable: true,
  color: 'sky'
};

const blankEvent = (date, source = LOCAL_SOURCE, timeZone = 'UTC') => ({
  title: '',
  date,
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  location: '',
  notes: '',
  color: source.color || 'sky',
  sourceKey: source.id,
  timeZone
});

const calendarDateInTimeZone = (date, timeZone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const CalendarApp = ({ target = null }) => {
  const { showDialog } = useDialog();
  const { formatDate, t, timeZone, weekStartsOn } = useI18n();
  const { openWindow } = useWindowManager();
  const today = useMemo(() => calendarDateInTimeZone(new Date(), timeZone), [timeZone]);
  const requestedDate = parseCalendarDate(target?.date) ? target.date : today;
  const [month, setMonth] = useState(`${requestedDate.slice(0, 7)}-01`);
  const [selectedDate, setSelectedDate] = useState(requestedDate);
  const [events, setEvents] = useState([]);
  const [sources, setSources] = useState([LOCAL_SOURCE]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(() => blankEvent(requestedDate, LOCAL_SOURCE, timeZone));

  const days = useMemo(() => calendarMonthGrid(month, parseCalendarDate(today), weekStartsOn), [month, today, weekStartsOn]);
  const range = useMemo(() => calendarGridRange(month, weekStartsOn), [month, weekStartsOn]);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const day = new Date(Date.UTC(2024, 0, 7 + ((weekStartsOn + index) % 7)));
    return formatDate(day, { weekday: 'short', timeZone: 'UTC' });
  }), [formatDate, weekStartsOn]);
  const eventsByDate = useMemo(() => events.reduce((map, event) => {
    const current = map.get(event.date) || [];
    current.push(event);
    map.set(event.date, current);
    return map;
  }, new Map()), [events]);
  const selectedEvents = eventsByDate.get(selectedDate) || [];
  const formSource = sources.find((source) => source.id === form.sourceKey) || LOCAL_SOURCE;
  const monthTitle = (date) => formatDate(parseCalendarDate(date) || new Date(), { month: 'long', year: 'numeric' });
  const longDate = (date) => formatDate(parseCalendarDate(date) || new Date(), { weekday: 'long', day: 'numeric', month: 'long' });
  const eventTime = (event) => event.allDay
    ? t('calendar.allDay')
    : event.endTime ? `${event.startTime}–${event.endTime}` : event.startTime;

  const loadEvents = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await apiFetch(
        `/api/calendar/events?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&timeZone=${encodeURIComponent(timeZone)}`
      );
      const payload = await response.json();
      setEvents(Array.isArray(payload.events) ? payload.events : []);
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      setWarning(warnings.length ? warnings.map((item) => item.message).filter(Boolean).join(' ') : '');
      setError('');
    } catch (requestError) {
      setError(requestError.message || t('calendar.loadError'));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, t, timeZone]);

  const loadSources = useCallback(async ({ refresh = false } = {}) => {
    try {
      const response = await apiFetch(`/api/calendar/sources${refresh ? '?refresh=1' : ''}`);
      const payload = await response.json();
      const nextSources = Array.isArray(payload.sources) && payload.sources.length
        ? payload.sources
        : [LOCAL_SOURCE];
      setSources(nextSources);
      setAccounts(Array.isArray(payload.accounts) ? payload.accounts : []);
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      if (warnings.length) setWarning(warnings.map((item) => item.message).filter(Boolean).join(' '));
    } catch (requestError) {
      setWarning(requestError.message || t('calendar.sourcesError'));
    }
  }, [t]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    loadSources({ refresh: true });
  }, [loadSources]);

  useEffect(() => {
    if (!target?.requestId || !parseCalendarDate(target.date)) return;
    setSelectedDate(target.date);
    setMonth(`${target.date.slice(0, 7)}-01`);
  }, [target?.date, target?.requestId]);

  const selectDate = (date) => {
    setSelectedDate(date);
    if (date.slice(0, 7) !== month.slice(0, 7)) setMonth(`${date.slice(0, 7)}-01`);
    if (formOpen && !editingId) setForm((current) => ({ ...current, date }));
  };

  const moveMonth = (amount) => {
    const next = shiftCalendarMonth(month, amount);
    setMonth(next);
    setSelectedDate(next);
    setFormOpen(false);
    setEditingId(null);
  };

  const goToday = () => {
    setMonth(`${today.slice(0, 7)}-01`);
    setSelectedDate(today);
  };

  const beginCreate = () => {
    setEditingId(null);
    setForm(blankEvent(selectedDate, LOCAL_SOURCE, timeZone));
    setFormOpen(true);
  };

  const beginEdit = (event) => {
    if (!event.editable) {
      if (event.externalUrl) window.open(event.externalUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const source = sources.find((item) => (
      event.source === 'local'
        ? item.id === 'local'
        : item.accountId === event.sourceId && item.calendarId === event.calendarId
    )) || LOCAL_SOURCE;
    setEditingId(event.id);
    setForm({
      title: event.title,
      date: event.date,
      allDay: event.allDay,
      startTime: event.startTime || '09:00',
      endTime: event.endTime || '10:00',
      location: event.location || '',
      notes: event.notes || '',
      color: event.color || source.color || 'sky',
      sourceKey: source.id,
      timeZone
    });
    setFormOpen(true);
  };

  const saveEvent = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const source = sources.find((item) => item.id === form.sourceKey) || LOCAL_SOURCE;
      const payload = {
        ...form,
        sourceId: source.accountId || 'local',
        calendarId: source.calendarId,
        timeZone
      };
      await apiFetch(editingId ? `/api/calendar/events/${encodeURIComponent(editingId)}` : '/api/calendar/events', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setSelectedDate(form.date);
      setMonth(`${form.date.slice(0, 7)}-01`);
      setFormOpen(false);
      setEditingId(null);
      await loadEvents({ quiet: true });
    } catch (requestError) {
      setError(requestError.message || t('calendar.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const deleteEvent = (event) => {
    showDialog({
      title: t('calendar.deleteTitle'),
      message: t('calendar.deleteMessage', { title: event.title }),
      type: 'warning',
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      pendingText: t('calendar.deleting'),
      onConfirm: async () => {
        try {
          await apiFetch(`/api/calendar/events/${encodeURIComponent(event.id)}`, { method: 'DELETE' });
          if (editingId === event.id) {
            setFormOpen(false);
            setEditingId(null);
          }
          await loadEvents({ quiet: true });
        } catch (requestError) {
          setError(requestError.message || t('calendar.deleteError'));
        }
      }
    });
  };

  const openConnections = () => openWindow({
    id: 'settings',
    type: 'settings',
    title: t('common.settings'),
    component: null,
    navigation: { tab: 'connections' },
    width: 900,
    height: 650
  });

  const refreshCalendar = async () => {
    setLoading(true);
    await loadSources({ refresh: true });
    await loadEvents({ quiet: true });
  };

  return (
    <div className="calendar-app">
      <header className="calendar-toolbar">
        <div className="calendar-title">
          <CalendarDays size={21} aria-hidden="true" />
          <strong>{monthTitle(month)}</strong>
        </div>
        <div className="calendar-toolbar-actions">
          <button type="button" className="calendar-button calendar-account-button" onClick={openConnections}>
            <Link2 size={14} /> {accounts.length ? t('calendar.accounts', { count: accounts.length }) : t('calendar.connectAccount')}
          </button>
          <button type="button" className="calendar-button" onClick={goToday}>{t('calendar.today')}</button>
          <div className="calendar-month-nav" aria-label={t('calendar.monthSelection')}>
            <button type="button" onClick={() => moveMonth(-1)} aria-label={t('calendar.previousMonth')}><ChevronLeft size={17} /></button>
            <button type="button" onClick={() => moveMonth(1)} aria-label={t('calendar.nextMonth')}><ChevronRight size={17} /></button>
          </div>
          <button type="button" className="calendar-icon-button" onClick={refreshCalendar} aria-label={t('calendar.refresh')}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {error && <div className="calendar-error" role="alert">{error}</div>}
      {!error && warning && <div className="calendar-warning" role="status">{warning}</div>}

      <div className="calendar-layout">
        <section className="calendar-month" aria-label={monthTitle(month)}>
          <div className="calendar-weekdays">
            {weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
          </div>
          <div className="calendar-grid">
            {days.map((day) => {
              const dayEvents = eventsByDate.get(day.isoDate) || [];
              return (
                <button
                  type="button"
                  key={day.isoDate}
                  className={[
                    'calendar-day',
                    day.inCurrentMonth ? '' : 'is-outside',
                    day.isToday ? 'is-today' : '',
                    selectedDate === day.isoDate ? 'is-selected' : ''
                  ].filter(Boolean).join(' ')}
                  aria-label={`${longDate(day.isoDate)}, ${t('calendar.eventsCount', { count: dayEvents.length })}`}
                  aria-pressed={selectedDate === day.isoDate}
                  onClick={() => selectDate(day.isoDate)}
                >
                  <span className="calendar-day-number">{day.day}</span>
                  <span className="calendar-day-events" aria-hidden="true">
                    {dayEvents.slice(0, 2).map((event) => (
                      <span key={event.id} className={`calendar-day-event is-${event.color}`}>
                        {event.allDay ? '' : event.startTime} {event.title}
                      </span>
                    ))}
                    {dayEvents.length > 2 && <span className="calendar-day-more">+{dayEvents.length - 2}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <aside className="calendar-agenda">
          <div className="calendar-agenda-header">
            <div>
              <span>{t('calendar.selectedDay')}</span>
              <h2>{longDate(selectedDate)}</h2>
            </div>
            <button type="button" className="calendar-add-button" onClick={beginCreate}>
              <Plus size={15} /> {t('calendar.event')}
            </button>
          </div>

          {formOpen ? (
            <form className="calendar-event-form" onSubmit={saveEvent}>
              <div className="calendar-form-heading">
                <strong>{editingId ? t('calendar.editEvent') : t('calendar.newEvent')}</strong>
                <button type="button" aria-label={t('calendar.closeForm')} onClick={() => setFormOpen(false)}><X size={16} /></button>
              </div>
              <label>
                {t('calendar.title')}
                <input
                  value={form.title}
                  maxLength={120}
                  required
                  autoFocus
                  onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder={t('calendar.eventName')}
                />
              </label>
              <label>
                {t('calendar.calendar')}
                <select
                  value={form.sourceKey}
                  disabled={Boolean(editingId)}
                  onChange={(event) => {
                    const source = sources.find((item) => item.id === event.target.value) || LOCAL_SOURCE;
                    setForm((current) => ({
                      ...current,
                      sourceKey: source.id,
                      color: source.color || current.color
                    }));
                  }}
                >
                  {sources.filter((source) => source.writable).map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.provider === 'local' ? t('calendar.localCalendar') : `${source.accountName} · ${source.name}`}
                    </option>
                  ))}
                </select>
                {editingId && <small>{t('calendar.calendarImmutable')}</small>}
              </label>
              <label>
                {t('calendar.date')}
                <input
                  type="date"
                  min="1970-01-01"
                  max="2100-12-31"
                  value={form.date}
                  required
                  onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
                />
              </label>
              <label className="calendar-all-day">
                <input
                  type="checkbox"
                  checked={form.allDay}
                  onChange={(event) => setForm((current) => ({ ...current, allDay: event.target.checked }))}
                />
                {t('calendar.allDay')}
              </label>
              {!form.allDay && (
                <div className="calendar-time-fields">
                  <label>
                    {t('calendar.start')}
                    <input type="time" value={form.startTime} required onChange={(event) => setForm((current) => ({ ...current, startTime: event.target.value }))} />
                  </label>
                  <label>
                    {t('calendar.end')}
                    <input type="time" value={form.endTime} onChange={(event) => setForm((current) => ({ ...current, endTime: event.target.value }))} />
                  </label>
                </div>
              )}
              <label>
                {t('calendar.location')}
                <input value={form.location} maxLength={160} onChange={(event) => setForm((current) => ({ ...current, location: event.target.value }))} placeholder={t('calendar.optional')} />
              </label>
              <label>
                {t('calendar.notes')}
                <textarea value={form.notes} maxLength={2000} rows={3} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder={t('calendar.optional')} />
              </label>
              {formSource.provider === 'local' && (
                <fieldset className="calendar-color-field">
                  <legend>{t('calendar.color')}</legend>
                  <div>
                    {COLORS.map((color) => (
                      <button
                        type="button"
                        key={color}
                        className={`calendar-color is-${color}${form.color === color ? ' is-active' : ''}`}
                        aria-label={t('calendar.colorLabel', { color: t(`calendar.colors.${color}`) })}
                        aria-pressed={form.color === color}
                        onClick={() => setForm((current) => ({ ...current, color }))}
                      />
                    ))}
                  </div>
                </fieldset>
              )}
              <button type="submit" className="calendar-save-button" disabled={saving || !form.title.trim()}>
                {saving ? t('calendar.saving') : editingId ? t('calendar.saveChanges') : t('calendar.addEvent')}
              </button>
            </form>
          ) : (
            <div className="calendar-event-list">
              {loading && events.length === 0 ? (
                <div className="calendar-empty"><RefreshCw size={19} className="spin" /> {t('calendar.loading')}</div>
              ) : selectedEvents.length === 0 ? (
                <div className="calendar-empty">
                  <CalendarDays size={24} />
                  <span>{t('calendar.empty')}</span>
                  <button type="button" onClick={beginCreate}>{t('calendar.addFirst')}</button>
                </div>
              ) : selectedEvents.map((event) => (
                <article key={event.id} className={`calendar-event-card is-${event.color}`}>
                  <button type="button" className="calendar-event-main" onClick={() => beginEdit(event)}>
                    <strong>{event.title}</strong>
                    <span><Clock3 size={13} /> {eventTime(event)}</span>
                    <span className="calendar-event-source">{event.source === 'local' ? t('calendar.localCalendar') : event.calendarName || t('calendar.localCalendar')}{event.source === 'remote' && event.accountName ? ` · ${event.accountName}` : ''}</span>
                    {event.location && <span><MapPin size={13} /> {event.location}</span>}
                    {event.notes && <p>{event.notes}</p>}
                  </button>
                  <div className="calendar-event-actions">
                    {event.externalUrl && (
                      <a href={event.externalUrl} target="_blank" rel="noreferrer" aria-label={t('calendar.openProvider')}><ExternalLink size={14} /></a>
                    )}
                    {event.editable && <button type="button" onClick={() => beginEdit(event)} aria-label={t('calendar.edit')}><Pencil size={14} /></button>}
                    {event.editable && <button type="button" onClick={() => deleteEvent(event)} aria-label={t('calendar.delete')}><Trash2 size={14} /></button>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

export default CalendarApp;
