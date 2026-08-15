const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptionStore } = require('./encryptionStore');
const {
  createCalendarConnectionManager
} = require('./calendarConnectionManager');

function createHarness(httpRequest, options = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-calendar-accounts-'));
  const encryptionStore = createEncryptionStore({ dataRoot });
  let uuidCounter = 1;
  const manager = createCalendarConnectionManager({
    dataRoot,
    encryptionStore,
    httpRequest,
    randomUUID: () => String(uuidCounter++).padStart(32, '0').replace(
      /(.{8})(.{4})(.{4})(.{4})(.{12})/,
      '$1-$2-$3-$4-$5'
    ),
    ...options
  });
  return { dataRoot, encryptionStore, manager };
}

test('Google Calendar OAuth stores secrets encrypted and merges a writable account source', async (t) => {
  const calls = [];
  const httpRequest = async (request) => {
    calls.push(request);
    const url = new URL(request.url);
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      assert.equal(request.form.client_secret, 'google-client-secret');
      if (request.form.grant_type === 'authorization_code') {
        return {
          access_token: 'google-access-token',
          refresh_token: 'google-refresh-token',
          expires_in: 3600,
          scope: 'openid email https://www.googleapis.com/auth/calendar.events'
        };
      }
      return { access_token: 'google-refreshed-token', expires_in: 3600 };
    }
    if (url.origin === 'https://openidconnect.googleapis.com') {
      return { sub: 'google-subject-1', email: 'owner@example.com', name: 'Takvim Sahibi' };
    }
    if (url.pathname === '/calendar/v3/users/me/calendarList') {
      return {
        items: [{
          id: 'owner@example.com',
          summary: 'Kişisel',
          primary: true,
          selected: true,
          accessRole: 'owner',
          timeZone: 'Europe/Istanbul'
        }]
      };
    }
    if (url.pathname.includes('/calendar/v3/calendars/') && request.method === 'POST') {
      assert.equal(request.json.start.timeZone, 'Europe/Istanbul');
      return {
        id: 'created-google-event',
        summary: request.json.summary,
        description: request.json.description,
        location: request.json.location,
        status: 'confirmed',
        eventType: 'default',
        start: { dateTime: '2026-08-13T09:00:00+03:00' },
        end: { dateTime: '2026-08-13T10:00:00+03:00' },
        htmlLink: 'https://calendar.google.com/event?eid=created'
      };
    }
    if (url.pathname.includes('/calendar/v3/calendars/')) {
      return {
        items: [{
          id: 'google-event-1',
          status: 'confirmed',
          eventType: 'default',
          summary: 'Google toplantısı',
          location: 'İstanbul',
          description: 'Gündem',
          start: { dateTime: '2026-08-13T14:00:00+03:00' },
          end: { dateTime: '2026-08-13T15:00:00+03:00' },
          htmlLink: 'https://calendar.google.com/event?eid=one'
        }]
      };
    }
    throw new Error(`Unexpected request: ${request.method || 'GET'} ${request.url}`);
  };
  const harness = createHarness(httpRequest);
  t.after(() => fs.rmSync(harness.dataRoot, { recursive: true, force: true }));

  harness.manager.configureProvider('google', {
    clientId: 'client.apps.googleusercontent.com',
    clientSecret: 'google-client-secret'
  });
  const authorization = harness.manager.startAuthorization('google', {
    redirectUri: 'https://foxos.example.com/oauth/calendar/google/callback',
    ownerFingerprint: 'owner-fingerprint'
  });
  const authorizationUrl = new URL(authorization.authorizationUrl);
  assert.equal(authorizationUrl.origin, 'https://accounts.google.com');
  assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
  assert.match(authorizationUrl.searchParams.get('scope'), /calendar\.events/);
  assert.match(authorizationUrl.searchParams.get('scope'), /calendarlist\.readonly/);
  assert.ok(authorizationUrl.searchParams.get('code_challenge'));

  const account = await harness.manager.completeAuthorization('google', {
    state: authorizationUrl.searchParams.get('state'),
    code: 'google-authorization-code'
  });
  assert.equal(account.email, 'owner@example.com');
  assert.equal(account.calendars[0].writable, true);
  assert.equal(account.tokenStoredEncrypted, true);

  const diskText = fs.readFileSync(
    path.join(harness.dataRoot, 'connections', 'calendar', 'providers', 'google', 'client-secret.foxosenc')
  ).toString('utf8');
  assert.doesNotMatch(diskText, /google-client-secret/);
  const serializedStatus = JSON.stringify(harness.manager.status());
  assert.doesNotMatch(serializedStatus, /google-client-secret|google-refresh-token|google-access-token/);

  const sources = await harness.manager.listSources();
  assert.deepEqual(sources.sources.map((source) => source.name), ['FoxOS Takvimi', 'Kişisel']);

  const listed = await harness.manager.listEvents({
    from: '2026-08-01',
    to: '2026-08-31',
    timeZone: 'Europe/Istanbul'
  });
  assert.equal(listed.warnings.length, 0);
  assert.equal(listed.events.length, 1);
  assert.equal(listed.events[0].title, 'Google toplantısı');
  assert.equal(listed.events[0].date, '2026-08-13');
  assert.equal(listed.events[0].startTime, '14:00');
  assert.equal(listed.events[0].editable, true);

  const created = await harness.manager.createEvent({
    sourceId: account.id,
    calendarId: account.calendars[0].id,
    timeZone: 'Europe/Istanbul',
    title: 'Yeni etkinlik',
    date: '2026-08-13',
    allDay: false,
    startTime: '09:00',
    endTime: '10:00',
    location: 'Ofis',
    notes: 'Hazırlık',
    color: 'sky'
  });
  assert.equal(created.title, 'Yeni etkinlik');
  assert.equal(created.provider, 'google');
  assert.match(created.id, /^rem_/);
  assert.ok(calls.some((call) => call.method === 'POST' && call.json && call.json.summary === 'Yeni etkinlik'));
});

test('Microsoft accounts keep calendar times in the requested display zone and use delegated writes', async (t) => {
  const calls = [];
  const httpRequest = async (request) => {
    calls.push(request);
    const url = new URL(request.url);
    if (url.origin === 'https://login.microsoftonline.com' && url.pathname.endsWith('/token')) {
      return {
        access_token: 'microsoft-access-token',
        refresh_token: 'microsoft-refresh-token',
        expires_in: 3600,
        scope: 'openid email offline_access Calendars.ReadWrite'
      };
    }
    if (url.pathname === '/v1.0/me') {
      return {
        id: 'microsoft-subject-1',
        displayName: 'Outlook Sahibi',
        mail: 'owner@outlook.com'
      };
    }
    if (url.pathname === '/v1.0/me/calendars') {
      return {
        value: [{ id: 'outlook-calendar-id', name: 'Takvim', canEdit: true, isDefaultCalendar: true }]
      };
    }
    if (url.pathname.endsWith('/calendarView')) {
      assert.equal(request.headers.Prefer, 'outlook.timezone="Europe/Istanbul"');
      return {
        value: [{
          id: 'outlook-event-id',
          subject: 'Outlook toplantısı',
          isAllDay: false,
          isCancelled: false,
          start: { dateTime: '2026-08-18T10:30:00.0000000', timeZone: 'Turkey Standard Time' },
          end: { dateTime: '2026-08-18T11:15:00.0000000', timeZone: 'Turkey Standard Time' },
          location: { displayName: 'Teams' },
          bodyPreview: 'Haftalık görüşme',
          webLink: 'https://outlook.live.com/calendar/item'
        }]
      };
    }
    if (url.pathname.endsWith('/events') && request.method === 'POST') {
      assert.equal(request.json.start.timeZone, 'Europe/Istanbul');
      return {
        id: 'outlook-created-id',
        subject: request.json.subject,
        isAllDay: request.json.isAllDay,
        isCancelled: false,
        start: request.json.start,
        end: request.json.end,
        location: request.json.location,
        bodyPreview: request.json.body.content,
        webLink: 'https://outlook.live.com/calendar/created'
      };
    }
    throw new Error(`Unexpected request: ${request.method || 'GET'} ${request.url}`);
  };
  const harness = createHarness(httpRequest);
  t.after(() => fs.rmSync(harness.dataRoot, { recursive: true, force: true }));

  harness.manager.configureProvider('microsoft', {
    clientId: 'microsoft-client-id',
    clientSecret: 'microsoft-client-secret'
  });
  const authorization = harness.manager.startAuthorization('microsoft', {
    redirectUri: 'https://foxos.example.com/oauth/calendar/microsoft/callback'
  });
  const authorizationUrl = new URL(authorization.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get('prompt'), 'select_account');
  assert.match(authorizationUrl.searchParams.get('scope'), /Calendars\.ReadWrite/);
  const account = await harness.manager.completeAuthorization('microsoft', {
    state: authorizationUrl.searchParams.get('state'),
    code: 'microsoft-authorization-code'
  });

  const listed = await harness.manager.listEvents({
    from: '2026-08-01',
    to: '2026-08-31',
    timeZone: 'Europe/Istanbul'
  });
  assert.equal(listed.events[0].date, '2026-08-18');
  assert.equal(listed.events[0].startTime, '10:30');
  assert.equal(listed.events[0].endTime, '11:15');

  const created = await harness.manager.createEvent({
    sourceId: account.id,
    calendarId: account.calendars[0].id,
    timeZone: 'Europe/Istanbul',
    title: 'Outlook kaydı',
    date: '2026-08-20',
    allDay: false,
    startTime: '13:00',
    endTime: '14:00',
    location: '',
    notes: '',
    color: 'green'
  });
  assert.equal(created.startTime, '13:00');
  assert.ok(calls.some((call) => call.json && call.json.subject === 'Outlook kaydı'));

  assert.throws(
    () => harness.manager.disconnectAccount(account.id, 'wrong'),
    /ayırma onayı/
  );
  const disconnected = harness.manager.disconnectAccount(account.id, 'DISCONNECT CALENDAR ACCOUNT');
  assert.equal(disconnected.disconnected, true);
  assert.equal(harness.manager.status().accountCount, 0);
});

test('OAuth state is one-use and provider client settings cannot change while accounts exist', async (t) => {
  const httpRequest = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/token') {
      return { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 };
    }
    if (url.origin === 'https://openidconnect.googleapis.com') {
      return { sub: 'subject', email: 'owner@example.com', name: 'Owner' };
    }
    if (url.pathname.endsWith('/calendarList')) {
      return { items: [{ id: 'primary', summary: 'Primary', primary: true, accessRole: 'owner' }] };
    }
    throw new Error('unexpected request');
  };
  const harness = createHarness(httpRequest);
  t.after(() => fs.rmSync(harness.dataRoot, { recursive: true, force: true }));
  harness.manager.configureProvider('google', { clientId: 'client-one', clientSecret: 'secret-one' });
  const authorization = harness.manager.startAuthorization('google', {
    redirectUri: 'https://foxos.example.com/oauth/calendar/google/callback'
  });
  const state = new URL(authorization.authorizationUrl).searchParams.get('state');
  await harness.manager.completeAuthorization('google', { state, code: 'code' });
  await assert.rejects(
    harness.manager.completeAuthorization('google', { state, code: 'code' }),
    /geçersiz veya süresi doldu/
  );
  assert.throws(
    () => harness.manager.configureProvider('google', { clientId: 'client-two', clientSecret: 'secret-two' }),
    /Bağlı hesaplar varken/
  );
});
