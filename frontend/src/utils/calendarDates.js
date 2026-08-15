const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseCalendarDate(value) {
  const match = DATE_PATTERN.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function localCalendarDate(value = new Date()) {
  const date = value instanceof Date ? value : parseCalendarDate(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftCalendarMonth(anchor, amount) {
  const date = parseCalendarDate(anchor) || new Date();
  return localCalendarDate(new Date(date.getFullYear(), date.getMonth() + amount, 1, 12));
}

export function calendarMonthGrid(anchor, today = new Date(), weekStartsOn = 1) {
  const monthDate = parseCalendarDate(anchor) || new Date();
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 12);
  const normalizedWeekStart = weekStartsOn === 0 ? 0 : 1;
  const weekOffset = (firstDay.getDay() - normalizedWeekStart + 7) % 7;
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - weekOffset);
  const todayKey = localCalendarDate(today);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const isoDate = localCalendarDate(date);
    return {
      isoDate,
      day: date.getDate(),
      inCurrentMonth: date.getMonth() === firstDay.getMonth(),
      isToday: isoDate === todayKey
    };
  });
}

export function calendarGridRange(anchor, weekStartsOn = 1) {
  const days = calendarMonthGrid(anchor, new Date(), weekStartsOn);
  return { from: days[0].isoDate, to: days[days.length - 1].isoDate };
}
