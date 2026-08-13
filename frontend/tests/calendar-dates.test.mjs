import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  calendarGridRange,
  calendarMonthGrid,
  localCalendarDate,
  parseCalendarDate,
  shiftCalendarMonth
} from '../src/utils/calendarDates.js';

test('calendar month grid starts on Monday and always exposes six complete weeks', () => {
  const days = calendarMonthGrid('2026-08-01', '2026-08-13');
  assert.equal(days.length, 42);
  assert.equal(days[0].isoDate, '2026-07-27');
  assert.equal(days[41].isoDate, '2026-09-06');
  assert.equal(days.find((day) => day.isToday).isoDate, '2026-08-13');
  assert.deepEqual(calendarGridRange('2026-08-01'), {
    from: '2026-07-27',
    to: '2026-09-06'
  });
});

test('calendar date helpers validate dates and cross year boundaries', () => {
  assert.equal(parseCalendarDate('2026-02-30'), null);
  assert.equal(localCalendarDate(parseCalendarDate('2026-12-31')), '2026-12-31');
  assert.equal(shiftCalendarMonth('2026-12-01', 1), '2027-01-01');
  assert.equal(shiftCalendarMonth('2026-01-01', -1), '2025-12-01');
});

test('calendar is wired to persistent APIs, Spotlight and the top-right menu bar clock', () => {
  const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const app = read('../src/apps/CalendarApp.jsx');
  const topBar = read('../src/components/TopBar.jsx');
  const dock = read('../src/components/Dock.jsx');
  const spotlight = read('../src/components/SpotlightSearch.jsx');
  assert.match(app, /\/api\/calendar\/events/);
  assert.match(topBar, /className="topbar-item topbar-clock-trigger"/);
  assert.match(topBar, /type: 'calendar'/);
  assert.doesNotMatch(dock, /app-calendar/);
  assert.match(spotlight, /id: 'system-calendar'/);
});

test('calendar merges connected account sources and routes account setup through Connections', () => {
  const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const app = read('../src/apps/CalendarApp.jsx');
  const connections = read('../src/apps/ConnectionsSettings.jsx');
  assert.match(app, /\/api\/calendar\/sources/);
  assert.match(app, /sourceKey/);
  assert.match(app, /timeZone=/);
  assert.match(app, /navigation: \{ tab: 'connections' \}/);
  assert.match(connections, /calendar-accounts/);
  assert.match(connections, /Google, Outlook ve Microsoft 365/);
  assert.match(connections, /\{providerLabel\} Hesabı Ekle/);
  assert.match(connections, /DISCONNECT CALENDAR ACCOUNT/);
});
