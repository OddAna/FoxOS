const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const CALENDAR_SCHEMA_VERSION = 1;
const EVENT_ID_PATTERN = /^evt_[a-f0-9]{32}$/;
const EVENT_COLORS = new Set(['sky', 'green', 'orange', 'pink', 'purple']);

class CalendarError extends Error {
  constructor(message, statusCode = 400, code = 'calendar-error') {
    super(message);
    this.name = 'CalendarError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeDate(value, label = 'Tarih') {
  const date = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new CalendarError(`${label} geçersiz.`, 400, 'calendar-date-invalid');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1970 || year > 2100 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new CalendarError(`${label} geçersiz.`, 400, 'calendar-date-invalid');
  }
  return date;
}

function normalizeTime(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const time = String(value).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new CalendarError(`${label} geçersiz.`, 400, 'calendar-time-invalid');
  }
  return time;
}

function boundedText(value, { label, maximum, required = false }) {
  if (value === null || value === undefined) {
    if (required) throw new CalendarError(`${label} zorunludur.`, 400, 'calendar-field-required');
    return '';
  }
  if (typeof value !== 'string') {
    throw new CalendarError(`${label} geçersiz.`, 400, 'calendar-field-invalid');
  }
  const text = value.trim();
  if ((required && !text) || text.length > maximum || text.includes('\0')) {
    throw new CalendarError(`${label} geçersiz.`, 400, 'calendar-field-invalid');
  }
  return text;
}

function normalizeEventInput(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CalendarError('Etkinlik bilgileri geçersiz.', 400, 'calendar-event-invalid');
  }
  const source = existing ? { ...existing, ...input } : input;
  const allDay = source.allDay === true;
  if (source.allDay !== undefined && typeof source.allDay !== 'boolean') {
    throw new CalendarError('Tüm gün seçimi geçersiz.', 400, 'calendar-all-day-invalid');
  }
  const startTime = allDay ? null : normalizeTime(source.startTime, 'Başlangıç saati');
  const endTime = allDay ? null : normalizeTime(source.endTime, 'Bitiş saati');
  if (!allDay && !startTime) {
    throw new CalendarError('Başlangıç saati zorunludur.', 400, 'calendar-start-time-required');
  }
  if (endTime && endTime <= startTime) {
    throw new CalendarError('Bitiş saati başlangıçtan sonra olmalıdır.', 400, 'calendar-time-order-invalid');
  }
  const color = source.color === undefined || source.color === '' ? 'sky' : String(source.color);
  if (!EVENT_COLORS.has(color)) {
    throw new CalendarError('Etkinlik rengi geçersiz.', 400, 'calendar-color-invalid');
  }

  return {
    title: boundedText(source.title, { label: 'Başlık', maximum: 120, required: true }),
    date: normalizeDate(source.date),
    allDay,
    startTime,
    endTime,
    location: boundedText(source.location, { label: 'Konum', maximum: 160 }),
    notes: boundedText(source.notes, { label: 'Notlar', maximum: 2_000 }),
    color
  };
}

function createCalendarManager({
  dataRoot,
  clock = () => new Date(),
  randomUUID = crypto.randomUUID
}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new TypeError('Calendar manager requires an absolute data root');
  }
  const eventsFile = path.join(dataRoot, 'calendar', 'events.json');

  function now() {
    return new Date(clock()).toISOString();
  }

  function emptyState() {
    return { schemaVersion: CALENDAR_SCHEMA_VERSION, updatedAt: null, events: [] };
  }

  function state() {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw new CalendarError('Takvim verisi okunamadı.', 503, 'calendar-state-invalid');
    }
    if (
      !payload || payload.schemaVersion !== CALENDAR_SCHEMA_VERSION ||
      !Array.isArray(payload.events) || payload.events.length > 10_000
    ) {
      throw new CalendarError('Takvim verisi okunamadı.', 503, 'calendar-state-invalid');
    }
    const events = payload.events.map((event) => {
      if (
        !event || !EVENT_ID_PATTERN.test(String(event.id || '')) ||
        typeof event.allDay !== 'boolean' ||
        typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt)) ||
        typeof event.updatedAt !== 'string' || !Number.isFinite(Date.parse(event.updatedAt))
      ) {
        throw new CalendarError('Takvim verisi okunamadı.', 503, 'calendar-state-invalid');
      }
      return {
        id: event.id,
        ...normalizeEventInput(event),
        createdAt: event.createdAt,
        updatedAt: event.updatedAt
      };
    });
    return {
      schemaVersion: CALENDAR_SCHEMA_VERSION,
      updatedAt: payload.updatedAt || null,
      events
    };
  }

  function persist(events) {
    const updatedAt = now();
    const ordered = [...events].sort((left, right) => (
      left.date.localeCompare(right.date) ||
      Number(right.allDay) - Number(left.allDay) ||
      String(left.startTime || '').localeCompare(String(right.startTime || '')) ||
      left.title.localeCompare(right.title, 'tr')
    ));
    atomicWriteJson(eventsFile, {
      schemaVersion: CALENDAR_SCHEMA_VERSION,
      updatedAt,
      events: ordered
    });
    return updatedAt;
  }

  function list({ from, to }) {
    const start = normalizeDate(from, 'Başlangıç tarihi');
    const end = normalizeDate(to, 'Bitiş tarihi');
    if (end < start) {
      throw new CalendarError('Bitiş tarihi başlangıçtan önce olamaz.', 400, 'calendar-range-invalid');
    }
    const daySpan = (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86_400_000;
    if (daySpan > 370) {
      throw new CalendarError('Takvim aralığı en fazla 370 gün olabilir.', 400, 'calendar-range-too-large');
    }
    return state().events.filter((event) => event.date >= start && event.date <= end);
  }

  function create(input) {
    const current = state();
    if (current.events.length >= 10_000) {
      throw new CalendarError('Takvim etkinlik sınırına ulaştı.', 409, 'calendar-event-limit-reached');
    }
    const timestamp = now();
    const event = {
      id: 'evt_' + randomUUID().replace(/-/g, '').toLowerCase(),
      ...normalizeEventInput(input),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    persist([...current.events, event]);
    return event;
  }

  function update(eventId, input) {
    if (!EVENT_ID_PATTERN.test(String(eventId || ''))) {
      throw new CalendarError('Etkinlik kimliği geçersiz.', 400, 'calendar-event-id-invalid');
    }
    const current = state();
    const existing = current.events.find((event) => event.id === eventId);
    if (!existing) throw new CalendarError('Etkinlik bulunamadı.', 404, 'calendar-event-not-found');
    const updated = {
      ...existing,
      ...normalizeEventInput(input, existing),
      updatedAt: now()
    };
    persist(current.events.map((event) => event.id === eventId ? updated : event));
    return updated;
  }

  function remove(eventId) {
    if (!EVENT_ID_PATTERN.test(String(eventId || ''))) {
      throw new CalendarError('Etkinlik kimliği geçersiz.', 400, 'calendar-event-id-invalid');
    }
    const current = state();
    const existing = current.events.find((event) => event.id === eventId);
    if (!existing) throw new CalendarError('Etkinlik bulunamadı.', 404, 'calendar-event-not-found');
    persist(current.events.filter((event) => event.id !== eventId));
    return { id: eventId, deleted: true };
  }

  return {
    create,
    list,
    paths: { eventsFile },
    remove,
    state,
    update
  };
}

module.exports = {
  CALENDAR_SCHEMA_VERSION,
  CalendarError,
  createCalendarManager,
  normalizeDate,
  normalizeEventInput
};
