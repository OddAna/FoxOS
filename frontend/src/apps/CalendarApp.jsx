import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react';
import { apiFetch } from '../api';
import { useDialog } from '../contexts/DialogContext';
import {
  calendarGridRange,
  calendarMonthGrid,
  localCalendarDate,
  parseCalendarDate,
  shiftCalendarMonth
} from '../utils/calendarDates';
import './CalendarApp.css';

const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const COLORS = ['sky', 'green', 'orange', 'pink', 'purple'];

const blankEvent = (date) => ({
  title: '',
  date,
  allDay: false,
  startTime: '09:00',
  endTime: '10:00',
  location: '',
  notes: '',
  color: 'sky'
});

const monthTitle = (date) => (parseCalendarDate(date) || new Date()).toLocaleDateString('tr-TR', {
  month: 'long',
  year: 'numeric'
});

const longDate = (date) => (parseCalendarDate(date) || new Date()).toLocaleDateString('tr-TR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long'
});

const eventTime = (event) => {
  if (event.allDay) return 'Tüm gün';
  return event.endTime ? `${event.startTime}–${event.endTime}` : event.startTime;
};

const CalendarApp = ({ target = null }) => {
  const { showDialog } = useDialog();
  const today = localCalendarDate();
  const requestedDate = parseCalendarDate(target?.date) ? target.date : today;
  const [month, setMonth] = useState(`${requestedDate.slice(0, 7)}-01`);
  const [selectedDate, setSelectedDate] = useState(requestedDate);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(() => blankEvent(requestedDate));

  const days = useMemo(() => calendarMonthGrid(month), [month]);
  const range = useMemo(() => calendarGridRange(month), [month]);
  const eventsByDate = useMemo(() => events.reduce((map, event) => {
    const current = map.get(event.date) || [];
    current.push(event);
    map.set(event.date, current);
    return map;
  }, new Map()), [events]);
  const selectedEvents = eventsByDate.get(selectedDate) || [];

  const loadEvents = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await apiFetch(
        `/api/calendar/events?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
      );
      const payload = await response.json();
      setEvents(Array.isArray(payload.events) ? payload.events : []);
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Takvim yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

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
    setForm(blankEvent(selectedDate));
    setFormOpen(true);
  };

  const beginEdit = (event) => {
    setEditingId(event.id);
    setForm({
      title: event.title,
      date: event.date,
      allDay: event.allDay,
      startTime: event.startTime || '09:00',
      endTime: event.endTime || '10:00',
      location: event.location || '',
      notes: event.notes || '',
      color: event.color || 'sky'
    });
    setFormOpen(true);
  };

  const saveEvent = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await apiFetch(editingId ? `/api/calendar/events/${editingId}` : '/api/calendar/events', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      setSelectedDate(form.date);
      setMonth(`${form.date.slice(0, 7)}-01`);
      setFormOpen(false);
      setEditingId(null);
      await loadEvents({ quiet: true });
    } catch (requestError) {
      setError(requestError.message || 'Etkinlik kaydedilemedi.');
    } finally {
      setSaving(false);
    }
  };

  const deleteEvent = (event) => {
    showDialog({
      title: 'Etkinliği Sil',
      message: `“${event.title}” etkinliği kalıcı olarak silinsin mi?`,
      type: 'warning',
      confirmText: 'Sil',
      cancelText: 'Vazgeç',
      pendingText: 'Siliniyor…',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/calendar/events/${event.id}`, { method: 'DELETE' });
          if (editingId === event.id) {
            setFormOpen(false);
            setEditingId(null);
          }
          await loadEvents({ quiet: true });
        } catch (requestError) {
          setError(requestError.message || 'Etkinlik silinemedi.');
        }
      }
    });
  };

  return (
    <div className="calendar-app">
      <header className="calendar-toolbar">
        <div className="calendar-title">
          <CalendarDays size={21} aria-hidden="true" />
          <strong>{monthTitle(month)}</strong>
        </div>
        <div className="calendar-toolbar-actions">
          <button type="button" className="calendar-button" onClick={goToday}>Bugün</button>
          <div className="calendar-month-nav" aria-label="Ay seçimi">
            <button type="button" onClick={() => moveMonth(-1)} aria-label="Önceki ay"><ChevronLeft size={17} /></button>
            <button type="button" onClick={() => moveMonth(1)} aria-label="Sonraki ay"><ChevronRight size={17} /></button>
          </div>
          <button type="button" className="calendar-icon-button" onClick={() => loadEvents()} aria-label="Takvimi yenile">
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {error && <div className="calendar-error" role="alert">{error}</div>}

      <div className="calendar-layout">
        <section className="calendar-month" aria-label={monthTitle(month)}>
          <div className="calendar-weekdays">
            {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
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
                  aria-label={`${longDate(day.isoDate)}, ${dayEvents.length} etkinlik`}
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
              <span>Seçili gün</span>
              <h2>{longDate(selectedDate)}</h2>
            </div>
            <button type="button" className="calendar-add-button" onClick={beginCreate}>
              <Plus size={15} /> Etkinlik
            </button>
          </div>

          {formOpen ? (
            <form className="calendar-event-form" onSubmit={saveEvent}>
              <div className="calendar-form-heading">
                <strong>{editingId ? 'Etkinliği Düzenle' : 'Yeni Etkinlik'}</strong>
                <button type="button" aria-label="Formu kapat" onClick={() => setFormOpen(false)}><X size={16} /></button>
              </div>
              <label>
                Başlık
                <input
                  value={form.title}
                  maxLength={120}
                  required
                  autoFocus
                  onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Etkinlik adı"
                />
              </label>
              <label>
                Tarih
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
                Tüm gün
              </label>
              {!form.allDay && (
                <div className="calendar-time-fields">
                  <label>
                    Başlangıç
                    <input type="time" value={form.startTime} required onChange={(event) => setForm((current) => ({ ...current, startTime: event.target.value }))} />
                  </label>
                  <label>
                    Bitiş
                    <input type="time" value={form.endTime} onChange={(event) => setForm((current) => ({ ...current, endTime: event.target.value }))} />
                  </label>
                </div>
              )}
              <label>
                Konum
                <input value={form.location} maxLength={160} onChange={(event) => setForm((current) => ({ ...current, location: event.target.value }))} placeholder="İsteğe bağlı" />
              </label>
              <label>
                Notlar
                <textarea value={form.notes} maxLength={2000} rows={3} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="İsteğe bağlı" />
              </label>
              <fieldset className="calendar-color-field">
                <legend>Renk</legend>
                <div>
                  {COLORS.map((color) => (
                    <button
                      type="button"
                      key={color}
                      className={`calendar-color is-${color}${form.color === color ? ' is-active' : ''}`}
                      aria-label={`${color} renk`}
                      aria-pressed={form.color === color}
                      onClick={() => setForm((current) => ({ ...current, color }))}
                    />
                  ))}
                </div>
              </fieldset>
              <button type="submit" className="calendar-save-button" disabled={saving || !form.title.trim()}>
                {saving ? 'Kaydediliyor…' : editingId ? 'Değişiklikleri Kaydet' : 'Etkinliği Ekle'}
              </button>
            </form>
          ) : (
            <div className="calendar-event-list">
              {loading && events.length === 0 ? (
                <div className="calendar-empty"><RefreshCw size={19} className="spin" /> Takvim yükleniyor…</div>
              ) : selectedEvents.length === 0 ? (
                <div className="calendar-empty">
                  <CalendarDays size={24} />
                  <span>Bu gün için etkinlik yok.</span>
                  <button type="button" onClick={beginCreate}>İlk etkinliği ekle</button>
                </div>
              ) : selectedEvents.map((event) => (
                <article key={event.id} className={`calendar-event-card is-${event.color}`}>
                  <button type="button" className="calendar-event-main" onClick={() => beginEdit(event)}>
                    <strong>{event.title}</strong>
                    <span><Clock3 size={13} /> {eventTime(event)}</span>
                    {event.location && <span><MapPin size={13} /> {event.location}</span>}
                    {event.notes && <p>{event.notes}</p>}
                  </button>
                  <div className="calendar-event-actions">
                    <button type="button" onClick={() => beginEdit(event)} aria-label="Etkinliği düzenle"><Pencil size={14} /></button>
                    <button type="button" onClick={() => deleteEvent(event)} aria-label="Etkinliği sil"><Trash2 size={14} /></button>
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
