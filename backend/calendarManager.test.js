const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCalendarManager } = require('./calendarManager');

const UUID = '12345678-1234-1234-1234-1234567890ab';

test('calendar events persist atomically and list within an inclusive date range', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-calendar-'));
  try {
    const manager = createCalendarManager({
      dataRoot,
      clock: () => new Date('2026-08-13T09:00:00.000Z'),
      randomUUID: () => UUID
    });
    const created = manager.create({
      title: 'Ürün toplantısı',
      date: '2026-08-14',
      startTime: '10:30',
      endTime: '11:15',
      location: 'Çevrim içi',
      notes: 'Gündemi gözden geçir',
      color: 'purple'
    });

    assert.equal(created.id, 'evt_123456781234123412341234567890ab');
    assert.deepEqual(manager.list({ from: '2026-08-14', to: '2026-08-14' }), [created]);
    assert.deepEqual(manager.list({ from: '2026-08-15', to: '2026-08-20' }), []);
    assert.equal(fs.statSync(manager.paths.eventsFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(manager.paths.eventsFile)).mode & 0o777, 0o700);

    const reloaded = createCalendarManager({ dataRoot });
    assert.equal(reloaded.state().events[0].title, 'Ürün toplantısı');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('calendar updates and deletes the exact event without changing its creation time', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-calendar-'));
  let current = new Date('2026-08-13T09:00:00.000Z');
  try {
    const manager = createCalendarManager({ dataRoot, clock: () => current, randomUUID: () => UUID });
    const created = manager.create({
      title: 'Odak zamanı', date: '2026-08-13', startTime: '09:00', endTime: '10:00'
    });
    current = new Date('2026-08-13T09:05:00.000Z');
    const updated = manager.update(created.id, { title: 'Derin çalışma', allDay: true });
    assert.equal(updated.title, 'Derin çalışma');
    assert.equal(updated.allDay, true);
    assert.equal(updated.startTime, null);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, '2026-08-13T09:05:00.000Z');
    assert.deepEqual(manager.remove(created.id), { id: created.id, deleted: true });
    assert.equal(manager.state().events.length, 0);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('calendar rejects invalid dates, time order, oversized ranges and corrupt state', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-calendar-'));
  try {
    const manager = createCalendarManager({ dataRoot, randomUUID: () => UUID });
    assert.throws(
      () => manager.create({ title: 'Hatalı', date: '2026-02-30', startTime: '10:00' }),
      (error) => error.code === 'calendar-date-invalid'
    );
    assert.throws(
      () => manager.create({ title: 'Hatalı', date: '2026-08-13', startTime: '11:00', endTime: '10:00' }),
      (error) => error.code === 'calendar-time-order-invalid'
    );
    assert.throws(
      () => manager.list({ from: '2026-01-01', to: '2027-02-01' }),
      (error) => error.code === 'calendar-range-too-large'
    );
    fs.mkdirSync(path.dirname(manager.paths.eventsFile), { recursive: true });
    fs.writeFileSync(manager.paths.eventsFile, '{broken');
    assert.throws(() => manager.state(), (error) => error.code === 'calendar-state-invalid');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
