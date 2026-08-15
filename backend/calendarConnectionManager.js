const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');
const {
  CalendarError,
  normalizeDate,
  normalizeEventInput
} = require('./calendarManager');

const SCHEMA_VERSION = 1;
const ACCOUNT_ID_PATTERN = /^cal_[a-f0-9]{32}$/;
const REMOTE_EVENT_PREFIX = 'rem_';
const MAX_ACCOUNTS = 20;
const MAX_CALENDARS_PER_ACCOUNT = 100;
const MAX_REMOTE_EVENTS = 5_000;
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const PROVIDER_IDS = ['google', 'microsoft'];
const EVENT_COLORS = ['sky', 'green', 'orange', 'pink', 'purple'];

const PROVIDERS = Object.freeze({
  google: {
    id: 'google',
    name: 'Google Takvim',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
    ]
  },
  microsoft: {
    id: 'microsoft',
    name: 'Outlook / Microsoft 365',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite']
  }
});

class CalendarConnectionError extends CalendarError {
  constructor(message, statusCode = 409, code = 'calendar-connection-error') {
    super(message, statusCode, code);
    this.name = 'CalendarConnectionError';
  }
}

class RemoteResponseError extends Error {
  constructor(statusCode, payload = null) {
    super(`Remote calendar request failed with status ${statusCode}`);
    this.name = 'RemoteResponseError';
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function fileExists(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function removeFileIfPresent(target) {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function boundedString(value, label, maximum, { required = true } = {}) {
  if (typeof value !== 'string') {
    throw new CalendarConnectionError(`${label} geçersiz.`, 400, 'calendar-connection-field-invalid');
  }
  const result = value.trim();
  if ((required && !result) || result.length > maximum || result.includes('\0')) {
    throw new CalendarConnectionError(`${label} geçersiz.`, 400, 'calendar-connection-field-invalid');
  }
  return result;
}

function providerDefinition(providerId) {
  const provider = PROVIDERS[String(providerId || '')];
  if (!provider) {
    throw new CalendarConnectionError('Takvim sağlayıcısı desteklenmiyor.', 404, 'calendar-provider-unsupported');
  }
  return provider;
}

function addDays(date, amount) {
  const normalized = normalizeDate(date);
  const value = new Date(`${normalized}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function normalizeTimeZone(value) {
  const timeZone = boundedString(value || 'UTC', 'Saat dilimi', 100);
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
  } catch {
    throw new CalendarConnectionError('Saat dilimi geçersiz.', 400, 'calendar-time-zone-invalid');
  }
  return timeZone;
}

function microsoftTimeZone(value) {
  return ['UTC', 'Etc/UTC'].includes(value) ? 'UTC' : value;
}

function dateTimeParts(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function addMinutesToLocal(date, time, minutes) {
  const value = new Date(`${date}T${time}:00Z`);
  value.setUTCMinutes(value.getUTCMinutes() + minutes);
  return { date: value.toISOString().slice(0, 10), time: value.toISOString().slice(11, 16) };
}

function safeText(value, maximum, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replaceAll('\0', '').trim().slice(0, maximum) || fallback;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString().slice(0, 2_000)
      : null;
  } catch {
    return null;
  }
}

function colorFor(value) {
  const digest = crypto.createHash('sha256').update(String(value || '')).digest();
  return EVENT_COLORS[digest[0] % EVENT_COLORS.length];
}

function remoteEventId(reference) {
  return REMOTE_EVENT_PREFIX + Buffer.from(JSON.stringify(reference), 'utf8').toString('base64url');
}

function parseRemoteEventId(value) {
  const encoded = String(value || '');
  if (!encoded.startsWith(REMOTE_EVENT_PREFIX) || encoded.length > 8_000) {
    throw new CalendarConnectionError('Uzak etkinlik kimliği geçersiz.', 400, 'calendar-remote-event-id-invalid');
  }
  let reference;
  try {
    reference = JSON.parse(Buffer.from(encoded.slice(REMOTE_EVENT_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new CalendarConnectionError('Uzak etkinlik kimliği geçersiz.', 400, 'calendar-remote-event-id-invalid');
  }
  if (
    !reference || !ACCOUNT_ID_PATTERN.test(String(reference.accountId || '')) ||
    typeof reference.calendarId !== 'string' || !reference.calendarId || reference.calendarId.length > 1_024 ||
    typeof reference.eventId !== 'string' || !reference.eventId || reference.eventId.length > 4_096
  ) {
    throw new CalendarConnectionError('Uzak etkinlik kimliği geçersiz.', 400, 'calendar-remote-event-id-invalid');
  }
  return reference;
}

async function defaultHttpRequest({ url, method = 'GET', headers = {}, form = null, json = undefined }) {
  const target = new URL(url);
  const allowedOrigins = new Set([
    'https://oauth2.googleapis.com',
    'https://openidconnect.googleapis.com',
    'https://www.googleapis.com',
    'https://login.microsoftonline.com',
    'https://graph.microsoft.com'
  ]);
  if (!allowedOrigins.has(target.origin) || target.username || target.password) {
    throw new CalendarConnectionError('Takvim sağlayıcısı adresi reddedildi.', 502, 'calendar-provider-url-rejected');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(target, {
      method,
      headers: {
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: form ? new URLSearchParams(form).toString() : json !== undefined ? JSON.stringify(json) : undefined,
      redirect: 'error',
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof CalendarConnectionError) throw error;
    throw new CalendarConnectionError(
      error.name === 'AbortError' ? 'Takvim sağlayıcısı zaman aşımına uğradı.' : 'Takvim sağlayıcısına bağlanılamadı.',
      503,
      error.name === 'AbortError' ? 'calendar-provider-timeout' : 'calendar-provider-unavailable'
    );
  } finally {
    clearTimeout(timeout);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 2 * 1024 * 1024) {
    throw new CalendarConnectionError('Takvim sağlayıcısı yanıtı güvenli sınırı aştı.', 502, 'calendar-provider-response-too-large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) {
    throw new CalendarConnectionError('Takvim sağlayıcısı yanıtı güvenli sınırı aştı.', 502, 'calendar-provider-response-too-large');
  }
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new CalendarConnectionError('Takvim sağlayıcısı geçersiz yanıt verdi.', 502, 'calendar-provider-invalid-response');
    }
  }
  if (!response.ok) throw new RemoteResponseError(response.status, payload);
  return payload;
}

function providerFailure(provider, error, fallbackCode = 'calendar-provider-request-failed') {
  if (error instanceof CalendarConnectionError) return error;
  const reauthorization = error instanceof RemoteResponseError && (
    error.statusCode === 401 ||
    (error.payload && ['invalid_grant', 'invalid_token'].includes(error.payload.error))
  );
  return new CalendarConnectionError(
    reauthorization
      ? `${provider.name} hesabının yeniden bağlanması gerekiyor.`
      : `${provider.name} isteği tamamlanamadı.`,
    reauthorization ? 409 : 502,
    reauthorization ? 'calendar-account-reauthorization-required' : fallbackCode
  );
}

function createCalendarConnectionManager({
  dataRoot,
  encryptionStore,
  httpRequest = defaultHttpRequest,
  clock = () => new Date(),
  randomUUID = crypto.randomUUID,
  randomBytes = crypto.randomBytes
}) {
  if (!dataRoot || !path.isAbsolute(dataRoot) || !encryptionStore || typeof httpRequest !== 'function') {
    throw new TypeError('Calendar connection manager requires absolute data, encryption and network adapters');
  }

  const root = path.join(dataRoot, 'connections', 'calendar');
  const providersRoot = path.join(root, 'providers');
  const accountsRoot = path.join(root, 'accounts');
  const authorizations = new Map();
  const accessTokens = new Map();

  function now() {
    return new Date(clock()).toISOString();
  }

  function providerRoot(providerId) {
    return path.join(providersRoot, providerId);
  }

  function providerConfigFile(providerId) {
    return path.join(providerRoot(providerId), 'config.json');
  }

  function providerSecretFile(providerId) {
    return path.join(providerRoot(providerId), 'client-secret.foxosenc');
  }

  function providerSecretContext(providerId) {
    return {
      purpose: 'foxos-calendar-oauth-client-secret',
      schemaVersion: SCHEMA_VERSION,
      provider: providerId
    };
  }

  function accountRoot(accountId) {
    return path.join(accountsRoot, accountId);
  }

  function accountConfigFile(accountId) {
    return path.join(accountRoot(accountId), 'config.json');
  }

  function accountTokenFile(accountId) {
    return path.join(accountRoot(accountId), 'refresh-token.foxosenc');
  }

  function accountTokenContext(accountId, providerId) {
    return {
      purpose: 'foxos-calendar-account-refresh-token',
      schemaVersion: SCHEMA_VERSION,
      provider: providerId,
      accountId
    };
  }

  function loadProviderConfig(providerId) {
    const provider = providerDefinition(providerId);
    const config = readJson(providerConfigFile(provider.id), null);
    if (!config) return null;
    if (
      config.schemaVersion !== SCHEMA_VERSION || config.provider !== provider.id ||
      typeof config.clientId !== 'string' || !config.clientId || config.clientId.length > 512 ||
      typeof config.secretFingerprint !== 'string' ||
      typeof config.configuredAt !== 'string' || !Number.isFinite(Date.parse(config.configuredAt)) ||
      typeof config.updatedAt !== 'string' || !Number.isFinite(Date.parse(config.updatedAt))
    ) {
      throw new CalendarConnectionError(`${provider.name} bağlantı ayarı okunamadı.`, 409, 'calendar-provider-config-invalid');
    }
    return config;
  }

  function loadProviderSecret(providerId) {
    const provider = providerDefinition(providerId);
    const config = loadProviderConfig(provider.id);
    if (!config || !fileExists(providerSecretFile(provider.id))) {
      throw new CalendarConnectionError(`${provider.name} OAuth uygulaması yapılandırılmadı.`, 409, 'calendar-provider-not-configured');
    }
    try {
      const secret = encryptionStore.decryptBuffer(
        fs.readFileSync(providerSecretFile(provider.id)),
        providerSecretContext(provider.id)
      ).toString('utf8');
      if (encryptionStore.fingerprint(secret) !== config.secretFingerprint) throw new Error('fingerprint mismatch');
      return { config, secret };
    } catch {
      throw new CalendarConnectionError(`${provider.name} OAuth anahtarı çözülemedi.`, 409, 'calendar-provider-secret-unavailable');
    }
  }

  function normalizeCalendar(calendar) {
    if (
      !calendar || typeof calendar.id !== 'string' || !calendar.id || calendar.id.length > 1_024 ||
      typeof calendar.name !== 'string' || !calendar.name || calendar.name.length > 300
    ) {
      throw new CalendarConnectionError('Takvim hesap kaydı okunamadı.', 409, 'calendar-account-config-invalid');
    }
    return {
      id: calendar.id,
      name: calendar.name,
      primary: calendar.primary === true,
      enabled: calendar.enabled !== false,
      writable: calendar.writable === true,
      timeZone: typeof calendar.timeZone === 'string' ? calendar.timeZone.slice(0, 100) : null,
      color: EVENT_COLORS.includes(calendar.color) ? calendar.color : colorFor(calendar.id)
    };
  }

  function loadAccount(accountId) {
    if (!ACCOUNT_ID_PATTERN.test(String(accountId || ''))) {
      throw new CalendarConnectionError('Takvim hesabı kimliği geçersiz.', 400, 'calendar-account-id-invalid');
    }
    const config = readJson(accountConfigFile(accountId), null);
    if (!config) {
      throw new CalendarConnectionError('Takvim hesabı bulunamadı.', 404, 'calendar-account-not-found');
    }
    if (
      config.schemaVersion !== SCHEMA_VERSION || config.id !== accountId || !PROVIDERS[config.provider] ||
      typeof config.subjectFingerprint !== 'string' || typeof config.tokenFingerprint !== 'string' ||
      typeof config.email !== 'string' || !config.email || config.email.length > 320 ||
      typeof config.displayName !== 'string' || config.displayName.length > 300 ||
      !Array.isArray(config.calendars) || config.calendars.length > MAX_CALENDARS_PER_ACCOUNT ||
      typeof config.connectedAt !== 'string' || !Number.isFinite(Date.parse(config.connectedAt))
    ) {
      throw new CalendarConnectionError('Takvim hesap kaydı okunamadı.', 409, 'calendar-account-config-invalid');
    }
    return { ...config, calendars: config.calendars.map(normalizeCalendar) };
  }

  function listAccounts() {
    let entries;
    try {
      entries = fs.readdirSync(accountsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && ACCOUNT_ID_PATTERN.test(entry.name))
      .slice(0, MAX_ACCOUNTS + 1)
      .map((entry) => loadAccount(entry.name))
      .sort((left, right) => left.email.localeCompare(right.email, 'tr'));
  }

  function publicAccount(account) {
    return {
      id: account.id,
      provider: account.provider,
      providerName: PROVIDERS[account.provider].name,
      email: account.email,
      displayName: account.displayName,
      connectedAt: account.connectedAt,
      lastSyncedAt: account.lastSyncedAt || null,
      needsReconnect: account.needsReconnect === true,
      tokenStoredEncrypted: fileExists(accountTokenFile(account.id)),
      tokenIncluded: false,
      calendars: account.calendars.map((calendar) => ({ ...calendar }))
    };
  }

  function providerStatus(providerId, redirectUri = null) {
    const provider = providerDefinition(providerId);
    const config = loadProviderConfig(provider.id);
    const accounts = listAccounts().filter((account) => account.provider === provider.id);
    return {
      id: provider.id,
      name: provider.name,
      configured: Boolean(config && fileExists(providerSecretFile(provider.id))),
      callbackUrl: redirectUri,
      accountCount: accounts.length,
      clientSecretStoredEncrypted: Boolean(config && fileExists(providerSecretFile(provider.id))),
      clientSecretIncluded: false,
      permissions: provider.id === 'google'
        ? ['Takvim listesini görme', 'Etkinlikleri okuma ve düzenleme']
        : ['Hesap profilini görme', 'Takvim etkinliklerini okuma ve düzenleme'],
      configuredAt: config ? config.configuredAt : null,
      updatedAt: config ? config.updatedAt : null
    };
  }

  function status({ redirectUris = {} } = {}) {
    const accounts = listAccounts();
    return {
      id: 'calendar-accounts',
      name: 'Takvim Hesapları',
      connected: accounts.length > 0,
      ready: accounts.some((account) => !account.needsReconnect && fileExists(accountTokenFile(account.id))),
      optional: true,
      accountCount: accounts.length,
      accounts: accounts.map(publicAccount),
      providers: PROVIDER_IDS.map((providerId) => providerStatus(providerId, redirectUris[providerId] || null)),
      credentialsStoredEncrypted: accounts.length > 0,
      credentialsIncluded: false
    };
  }

  function configureProvider(providerId, input) {
    const provider = providerDefinition(providerId);
    const current = loadProviderConfig(provider.id);
    const clientId = boundedString(input && input.clientId, 'OAuth Client ID', 512);
    const suppliedSecret = typeof (input && input.clientSecret) === 'string'
      ? input.clientSecret.trim()
      : '';
    const existingAccounts = listAccounts().filter((account) => account.provider === provider.id);
    if (current && current.clientId !== clientId && existingAccounts.length) {
      throw new CalendarConnectionError(
        'Bağlı hesaplar varken OAuth Client ID değiştirilemez. Önce bu sağlayıcının hesaplarını ayırın.',
        409,
        'calendar-provider-client-in-use'
      );
    }
    let secret = suppliedSecret;
    if (!secret && current) secret = loadProviderSecret(provider.id).secret;
    secret = boundedString(secret, 'OAuth Client Secret', 4_096);

    const timestamp = now();
    const next = {
      schemaVersion: SCHEMA_VERSION,
      provider: provider.id,
      clientId,
      secretFingerprint: encryptionStore.fingerprint(secret),
      configuredAt: current ? current.configuredAt : timestamp,
      updatedAt: timestamp
    };
    const secretFile = providerSecretFile(provider.id);
    const configFile = providerConfigFile(provider.id);
    const previousSecret = fileExists(secretFile) ? fs.readFileSync(secretFile) : null;
    const previousConfig = fileExists(configFile) ? fs.readFileSync(configFile) : null;
    try {
      encryptionStore.atomicWriteBuffer(
        secretFile,
        encryptionStore.encryptBuffer(Buffer.from(secret, 'utf8'), providerSecretContext(provider.id))
      );
      atomicWriteJson(configFile, next);
    } catch (error) {
      if (previousSecret) encryptionStore.atomicWriteBuffer(secretFile, previousSecret);
      else removeFileIfPresent(secretFile);
      if (previousConfig) encryptionStore.atomicWriteBuffer(configFile, previousConfig);
      else removeFileIfPresent(configFile);
      throw error;
    }
    return providerStatus(provider.id);
  }

  function purgeAuthorizations() {
    const timestamp = Date.now();
    for (const [state, authorization] of authorizations.entries()) {
      if (authorization.expiresAtMs <= timestamp) authorizations.delete(state);
    }
    while (authorizations.size >= 20) authorizations.delete(authorizations.keys().next().value);
  }

  function startAuthorization(providerId, { redirectUri, ownerFingerprint = null } = {}) {
    const provider = providerDefinition(providerId);
    const { config } = loadProviderSecret(provider.id);
    let callback;
    try {
      callback = new URL(redirectUri);
    } catch {
      throw new CalendarConnectionError('OAuth dönüş adresi geçersiz.', 400, 'calendar-oauth-redirect-invalid');
    }
    if (!['https:', 'http:'].includes(callback.protocol) || callback.username || callback.password || callback.hash) {
      throw new CalendarConnectionError('OAuth dönüş adresi geçersiz.', 400, 'calendar-oauth-redirect-invalid');
    }

    purgeAuthorizations();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const expiresAtMs = Date.now() + AUTHORIZATION_TTL_MS;
    authorizations.set(state, {
      provider: provider.id,
      redirectUri: callback.toString(),
      codeVerifier,
      ownerFingerprint,
      expiresAtMs
    });

    const url = new URL(provider.authorizationUrl);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', callback.toString());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', provider.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (provider.id === 'google') {
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('include_granted_scopes', 'true');
      url.searchParams.set('prompt', 'consent select_account');
    } else {
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set('prompt', 'select_account');
    }
    return {
      provider: provider.id,
      providerName: provider.name,
      authorizationUrl: url.toString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  async function requestIdentity(provider, accessToken) {
    try {
      if (provider.id === 'google') {
        const payload = await httpRequest({
          url: 'https://openidconnect.googleapis.com/v1/userinfo',
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const subject = boundedString(payload && payload.sub, 'Google hesap kimliği', 300);
        const email = boundedString(payload && payload.email, 'Google e-posta adresi', 320).toLowerCase();
        return {
          subject,
          email,
          displayName: safeText(payload && payload.name, 300, email)
        };
      }
      const payload = await httpRequest({
        url: 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const subject = boundedString(payload && payload.id, 'Microsoft hesap kimliği', 300);
      const email = boundedString(
        payload && (payload.mail || payload.userPrincipalName),
        'Microsoft e-posta adresi',
        320
      ).toLowerCase();
      return {
        subject,
        email,
        displayName: safeText(payload && payload.displayName, 300, email)
      };
    } catch (error) {
      throw providerFailure(provider, error, 'calendar-account-identity-failed');
    }
  }

  async function listGoogleCalendars(accessToken) {
    const calendars = [];
    let pageToken = null;
    for (let page = 0; page < 4; page += 1) {
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('showDeleted', 'false');
      url.searchParams.set('showHidden', 'false');
      url.searchParams.set('fields', 'nextPageToken,items(id,summary,primary,selected,accessRole,timeZone,deleted,hidden)');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const payload = await httpRequest({
        url: url.toString(),
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      for (const entry of Array.isArray(payload && payload.items) ? payload.items : []) {
        if (entry.deleted || entry.hidden || typeof entry.id !== 'string' || !entry.id) continue;
        calendars.push({
          id: entry.id.slice(0, 1_024),
          name: safeText(entry.summary, 300, entry.primary ? 'Birincil takvim' : 'Google Takvim'),
          primary: entry.primary === true,
          enabled: entry.primary === true || entry.selected !== false,
          writable: ['writer', 'owner'].includes(entry.accessRole),
          timeZone: safeText(entry.timeZone, 100, '') || null,
          color: colorFor(entry.id)
        });
        if (calendars.length >= MAX_CALENDARS_PER_ACCOUNT) return calendars;
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null;
      if (!pageToken) break;
    }
    return calendars;
  }

  async function listMicrosoftCalendars(accessToken) {
    const calendars = [];
    let nextUrl = 'https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100';
    for (let page = 0; page < 4 && nextUrl; page += 1) {
      const parsed = new URL(nextUrl);
      if (parsed.origin !== 'https://graph.microsoft.com' || !parsed.pathname.startsWith('/v1.0/me/')) {
        throw new CalendarConnectionError('Microsoft sayfalama adresi reddedildi.', 502, 'calendar-provider-url-rejected');
      }
      const payload = await httpRequest({
        url: parsed.toString(),
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      for (const entry of Array.isArray(payload && payload.value) ? payload.value : []) {
        if (typeof entry.id !== 'string' || !entry.id) continue;
        calendars.push({
          id: entry.id.slice(0, 1_024),
          name: safeText(entry.name, 300, entry.isDefaultCalendar ? 'Birincil takvim' : 'Outlook Takvimi'),
          primary: entry.isDefaultCalendar === true,
          enabled: true,
          writable: entry.canEdit !== false,
          timeZone: null,
          color: colorFor(entry.id)
        });
        if (calendars.length >= MAX_CALENDARS_PER_ACCOUNT) return calendars;
      }
      nextUrl = typeof payload['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null;
    }
    return calendars;
  }

  async function listCalendarsWithToken(provider, accessToken) {
    try {
      return provider.id === 'google'
        ? await listGoogleCalendars(accessToken)
        : await listMicrosoftCalendars(accessToken);
    } catch (error) {
      throw providerFailure(provider, error, 'calendar-list-failed');
    }
  }

  function persistAccountToken(accountId, providerId, refreshToken) {
    const token = boundedString(refreshToken, 'OAuth yenileme anahtarı', 16_384);
    encryptionStore.atomicWriteBuffer(
      accountTokenFile(accountId),
      encryptionStore.encryptBuffer(
        Buffer.from(token, 'utf8'),
        accountTokenContext(accountId, providerId)
      )
    );
    return encryptionStore.fingerprint(token);
  }

  function loadRefreshToken(account) {
    try {
      const token = encryptionStore.decryptBuffer(
        fs.readFileSync(accountTokenFile(account.id)),
        accountTokenContext(account.id, account.provider)
      ).toString('utf8');
      if (encryptionStore.fingerprint(token) !== account.tokenFingerprint) throw new Error('fingerprint mismatch');
      return token;
    } catch {
      throw new CalendarConnectionError(
        `${PROVIDERS[account.provider].name} hesap anahtarı çözülemedi.`,
        409,
        'calendar-account-token-unavailable'
      );
    }
  }

  async function completeAuthorization(providerId, input = {}) {
    const provider = providerDefinition(providerId);
    purgeAuthorizations();
    const state = boundedString(input.state, 'OAuth state', 256);
    const authorization = authorizations.get(state);
    authorizations.delete(state);
    if (!authorization || authorization.provider !== provider.id || authorization.expiresAtMs <= Date.now()) {
      throw new CalendarConnectionError('Takvim bağlantı oturumu geçersiz veya süresi doldu.', 400, 'calendar-oauth-state-invalid');
    }
    if (input.error) {
      throw new CalendarConnectionError('Takvim hesabı bağlantısı onaylanmadı.', 400, 'calendar-oauth-denied');
    }
    const code = boundedString(input.code, 'OAuth doğrulama kodu', 8_192);
    const { config, secret } = loadProviderSecret(provider.id);
    let tokenPayload;
    try {
      tokenPayload = await httpRequest({
        url: provider.tokenUrl,
        method: 'POST',
        form: {
          client_id: config.clientId,
          client_secret: secret,
          code,
          code_verifier: authorization.codeVerifier,
          redirect_uri: authorization.redirectUri,
          grant_type: 'authorization_code',
          ...(provider.id === 'microsoft' ? { scope: provider.scopes.join(' ') } : {})
        }
      });
    } catch (error) {
      throw providerFailure(provider, error, 'calendar-oauth-token-exchange-failed');
    }
    const accessToken = boundedString(tokenPayload && tokenPayload.access_token, 'OAuth erişim anahtarı', 32_768);
    const identity = await requestIdentity(provider, accessToken);
    const subjectFingerprint = encryptionStore.fingerprint(`${provider.id}\0${identity.subject}`);
    const accounts = listAccounts();
    let existing = accounts.find((account) => (
      account.provider === provider.id && account.subjectFingerprint === subjectFingerprint
    ));
    if (!existing && accounts.length >= MAX_ACCOUNTS) {
      throw new CalendarConnectionError('Takvim hesabı sınırına ulaşıldı.', 409, 'calendar-account-limit-reached');
    }
    const refreshToken = typeof tokenPayload.refresh_token === 'string' && tokenPayload.refresh_token
      ? tokenPayload.refresh_token
      : existing ? loadRefreshToken(existing) : null;
    if (!refreshToken) {
      throw new CalendarConnectionError(
        'Sağlayıcı çevrimdışı erişim anahtarı vermedi. Hesap iznini kaldırıp yeniden bağlamayı deneyin.',
        409,
        'calendar-oauth-refresh-token-missing'
      );
    }
    const calendars = await listCalendarsWithToken(provider, accessToken);
    const accountId = existing ? existing.id : 'cal_' + randomUUID().replaceAll('-', '').toLowerCase();
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new CalendarConnectionError('Takvim hesabı kimliği üretilemedi.', 500, 'calendar-account-id-generation-failed');
    }
    const timestamp = now();
    const tokenFingerprint = persistAccountToken(accountId, provider.id, refreshToken);
    const account = {
      schemaVersion: SCHEMA_VERSION,
      id: accountId,
      provider: provider.id,
      subjectFingerprint,
      tokenFingerprint,
      email: identity.email,
      displayName: identity.displayName,
      scopes: safeText(tokenPayload.scope, 4_096, provider.scopes.join(' ')).split(/\s+/).filter(Boolean).slice(0, 30),
      calendars,
      connectedAt: existing ? existing.connectedAt : timestamp,
      updatedAt: timestamp,
      lastSyncedAt: timestamp,
      needsReconnect: false
    };
    atomicWriteJson(accountConfigFile(accountId), account);
    const expiresIn = Math.max(60, Math.min(86_400, Number(tokenPayload.expires_in) || 3_600));
    accessTokens.set(accountId, { token: accessToken, expiresAt: Date.now() + expiresIn * 1_000 });
    return publicAccount(account);
  }

  function markReconnect(account) {
    if (account.needsReconnect) return;
    atomicWriteJson(accountConfigFile(account.id), {
      ...account,
      needsReconnect: true,
      updatedAt: now()
    });
  }

  async function accessTokenForAccount(account, { force = false } = {}) {
    const cached = accessTokens.get(account.id);
    if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const provider = providerDefinition(account.provider);
    const refreshToken = loadRefreshToken(account);
    const { config, secret } = loadProviderSecret(provider.id);
    let payload;
    try {
      payload = await httpRequest({
        url: provider.tokenUrl,
        method: 'POST',
        form: {
          client_id: config.clientId,
          client_secret: secret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
          ...(provider.id === 'microsoft' ? { scope: provider.scopes.join(' ') } : {})
        }
      });
    } catch (error) {
      const failure = providerFailure(provider, error, 'calendar-token-refresh-failed');
      if (failure.code === 'calendar-account-reauthorization-required') markReconnect(account);
      throw failure;
    }
    const accessToken = boundedString(payload && payload.access_token, 'OAuth erişim anahtarı', 32_768);
    const expiresIn = Math.max(60, Math.min(86_400, Number(payload.expires_in) || 3_600));
    accessTokens.set(account.id, { token: accessToken, expiresAt: Date.now() + expiresIn * 1_000 });
    if (typeof payload.refresh_token === 'string' && payload.refresh_token && payload.refresh_token !== refreshToken) {
      const tokenFingerprint = persistAccountToken(account.id, account.provider, payload.refresh_token);
      atomicWriteJson(accountConfigFile(account.id), {
        ...account,
        tokenFingerprint,
        updatedAt: now(),
        needsReconnect: false
      });
    } else if (account.needsReconnect) {
      atomicWriteJson(accountConfigFile(account.id), { ...account, needsReconnect: false, updatedAt: now() });
    }
    return accessToken;
  }

  async function refreshAccountCalendars(account) {
    const provider = providerDefinition(account.provider);
    const token = await accessTokenForAccount(account);
    const calendars = await listCalendarsWithToken(provider, token);
    const updated = {
      ...loadAccount(account.id),
      calendars,
      lastSyncedAt: now(),
      updatedAt: now(),
      needsReconnect: false
    };
    atomicWriteJson(accountConfigFile(account.id), updated);
    return updated;
  }

  function sourceFor(account, calendar) {
    return {
      id: `${account.id}:${Buffer.from(calendar.id, 'utf8').toString('base64url')}`,
      accountId: account.id,
      provider: account.provider,
      providerName: PROVIDERS[account.provider].name,
      accountName: account.email,
      calendarId: calendar.id,
      name: calendar.name,
      primary: calendar.primary,
      enabled: calendar.enabled,
      writable: calendar.writable,
      color: calendar.color
    };
  }

  async function listSources({ refresh = false } = {}) {
    const warnings = [];
    const accounts = [];
    for (const account of listAccounts()) {
      try {
        accounts.push(refresh ? await refreshAccountCalendars(account) : account);
      } catch (error) {
        accounts.push(loadAccount(account.id));
        warnings.push({
          accountId: account.id,
          provider: account.provider,
          code: error.code || 'calendar-source-refresh-failed',
          message: error.message || 'Takvim hesabı yenilenemedi.'
        });
      }
    }
    return {
      accounts: accounts.map(publicAccount),
      sources: [
        {
          id: 'local',
          accountId: null,
          provider: 'local',
          providerName: 'FoxOS',
          accountName: 'Bu sunucu',
          calendarId: 'local',
          name: 'FoxOS Takvimi',
          primary: true,
          enabled: true,
          writable: true,
          color: 'sky'
        },
        ...accounts.flatMap((account) => account.calendars.map((calendar) => sourceFor(account, calendar)))
      ],
      warnings
    };
  }

  function normalizeGoogleEvent(account, calendar, event, timeZone) {
    if (!event || event.status === 'cancelled' || !event.start || typeof event.id !== 'string') return null;
    const allDay = typeof event.start.date === 'string';
    let start;
    let end;
    if (allDay) {
      try {
        start = { date: normalizeDate(event.start.date), time: null };
        end = { date: event.end && event.end.date ? addDays(normalizeDate(event.end.date), -1) : start.date, time: null };
      } catch {
        return null;
      }
    } else {
      start = dateTimeParts(event.start.dateTime, timeZone);
      end = dateTimeParts(event.end && event.end.dateTime, timeZone);
      if (!start) return null;
    }
    const editableType = !event.eventType || event.eventType === 'default';
    return {
      id: remoteEventId({ accountId: account.id, calendarId: calendar.id, eventId: event.id }),
      source: 'remote',
      sourceId: account.id,
      provider: account.provider,
      providerName: PROVIDERS[account.provider].name,
      accountName: account.email,
      calendarId: calendar.id,
      calendarName: calendar.name,
      editable: calendar.writable && editableType && end && end.date === start.date,
      title: safeText(event.summary, 120, '(Başlıksız etkinlik)'),
      date: start.date,
      endDate: end ? end.date : start.date,
      allDay,
      startTime: allDay ? null : start.time,
      endTime: allDay || !end || end.date !== start.date ? null : end.time,
      location: safeText(event.location, 160),
      notes: safeText(event.description, 2_000),
      color: calendar.color,
      externalUrl: safeUrl(event.htmlLink),
      createdAt: Number.isFinite(Date.parse(event.created)) ? event.created : null,
      updatedAt: Number.isFinite(Date.parse(event.updated)) ? event.updated : null
    };
  }

  function graphLocalDateTime(value) {
    const text = safeText(value, 100);
    const date = text.slice(0, 10);
    const time = text.slice(11, 16);
    try {
      normalizeDate(date);
    } catch {
      return null;
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
    return { date, time };
  }

  function normalizeMicrosoftEvent(account, calendar, event) {
    if (!event || event.isCancelled || typeof event.id !== 'string' || !event.start) return null;
    const allDay = event.isAllDay === true;
    let start;
    let end;
    if (allDay) {
      const startDate = safeText(event.start.dateTime, 100).slice(0, 10);
      const endDate = safeText(event.end && event.end.dateTime, 100).slice(0, 10);
      try {
        start = { date: normalizeDate(startDate), time: null };
        end = { date: endDate ? addDays(normalizeDate(endDate), -1) : start.date, time: null };
      } catch {
        return null;
      }
    } else {
      start = graphLocalDateTime(event.start.dateTime);
      end = graphLocalDateTime(event.end && event.end.dateTime);
      if (!start) return null;
    }
    return {
      id: remoteEventId({ accountId: account.id, calendarId: calendar.id, eventId: event.id }),
      source: 'remote',
      sourceId: account.id,
      provider: account.provider,
      providerName: PROVIDERS[account.provider].name,
      accountName: account.email,
      calendarId: calendar.id,
      calendarName: calendar.name,
      editable: calendar.writable && end && end.date === start.date,
      title: safeText(event.subject, 120, '(Başlıksız etkinlik)'),
      date: start.date,
      endDate: end ? end.date : start.date,
      allDay,
      startTime: allDay ? null : start.time,
      endTime: allDay || !end || end.date !== start.date ? null : end.time,
      location: safeText(event.location && event.location.displayName, 160),
      notes: safeText(event.bodyPreview, 2_000),
      color: calendar.color,
      externalUrl: safeUrl(event.webLink),
      createdAt: null,
      updatedAt: null
    };
  }

  async function listGoogleEvents(account, calendar, accessToken, { from, to, timeZone }) {
    const events = [];
    let pageToken = null;
    for (let page = 0; page < 5; page += 1) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events`);
      url.searchParams.set('timeMin', `${addDays(from, -1)}T00:00:00Z`);
      url.searchParams.set('timeMax', `${addDays(to, 2)}T00:00:00Z`);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('showDeleted', 'false');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '1000');
      url.searchParams.set('timeZone', timeZone);
      url.searchParams.set('fields', 'nextPageToken,items(id,status,summary,description,location,start,end,htmlLink,created,updated,eventType)');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const payload = await httpRequest({
        url: url.toString(),
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      for (const raw of Array.isArray(payload && payload.items) ? payload.items : []) {
        const event = normalizeGoogleEvent(account, calendar, raw, timeZone);
        if (event && event.date >= from && event.date <= to) events.push(event);
        if (events.length >= MAX_REMOTE_EVENTS) return events;
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null;
      if (!pageToken) break;
    }
    return events;
  }

  async function listMicrosoftEvents(account, calendar, accessToken, { from, to, timeZone }) {
    const events = [];
    const zone = microsoftTimeZone(timeZone);
    const url = new URL(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.id)}/calendarView`);
    url.searchParams.set('startDateTime', `${addDays(from, -1)}T00:00:00Z`);
    url.searchParams.set('endDateTime', `${addDays(to, 2)}T00:00:00Z`);
    url.searchParams.set('$select', 'id,subject,start,end,isAllDay,location,bodyPreview,webLink,isCancelled');
    url.searchParams.set('$top', '1000');
    let nextUrl = url.toString();
    for (let page = 0; page < 5 && nextUrl; page += 1) {
      const parsed = new URL(nextUrl);
      if (parsed.origin !== 'https://graph.microsoft.com' || !parsed.pathname.startsWith('/v1.0/me/')) {
        throw new CalendarConnectionError('Microsoft sayfalama adresi reddedildi.', 502, 'calendar-provider-url-rejected');
      }
      const payload = await httpRequest({
        url: parsed.toString(),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: `outlook.timezone="${zone}"`
        }
      });
      for (const raw of Array.isArray(payload && payload.value) ? payload.value : []) {
        const event = normalizeMicrosoftEvent(account, calendar, raw);
        if (event && event.date >= from && event.date <= to) events.push(event);
        if (events.length >= MAX_REMOTE_EVENTS) return events;
      }
      nextUrl = typeof payload['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null;
    }
    return events;
  }

  async function listEvents({ from, to, timeZone = 'UTC' }) {
    const start = normalizeDate(from, 'Başlangıç tarihi');
    const end = normalizeDate(to, 'Bitiş tarihi');
    const zone = normalizeTimeZone(timeZone);
    const warnings = [];
    const results = await Promise.all(listAccounts().map(async (originalAccount) => {
      let account = originalAccount;
      try {
        if (!account.calendars.length) account = await refreshAccountCalendars(account);
        const provider = providerDefinition(account.provider);
        const accessToken = await accessTokenForAccount(account);
        const events = [];
        for (const calendar of account.calendars.filter((item) => item.enabled).slice(0, 30)) {
          const listed = provider.id === 'google'
            ? await listGoogleEvents(account, calendar, accessToken, { from: start, to: end, timeZone: zone })
            : await listMicrosoftEvents(account, calendar, accessToken, { from: start, to: end, timeZone: zone });
          events.push(...listed);
          if (events.length >= MAX_REMOTE_EVENTS) break;
        }
        const refreshed = { ...loadAccount(account.id), lastSyncedAt: now(), updatedAt: now(), needsReconnect: false };
        atomicWriteJson(accountConfigFile(account.id), refreshed);
        return events.slice(0, MAX_REMOTE_EVENTS);
      } catch (error) {
        warnings.push({
          accountId: account.id,
          provider: account.provider,
          code: error.code || 'calendar-account-sync-failed',
          message: error.message || 'Takvim hesabı eşitlenemedi.'
        });
        return [];
      }
    }));
    const events = results.flat().slice(0, MAX_REMOTE_EVENTS);
    events.sort((left, right) => (
      left.date.localeCompare(right.date) ||
      Number(right.allDay) - Number(left.allDay) ||
      String(left.startTime || '').localeCompare(String(right.startTime || '')) ||
      left.title.localeCompare(right.title, 'tr')
    ));
    return { events, warnings };
  }

  function accountAndCalendar(accountId, calendarId, { writable = false } = {}) {
    const account = loadAccount(accountId);
    const calendar = account.calendars.find((entry) => entry.id === calendarId);
    if (!calendar) {
      throw new CalendarConnectionError('Takvim kaynağı bulunamadı.', 404, 'calendar-source-not-found');
    }
    if (writable && !calendar.writable) {
      throw new CalendarConnectionError('Bu takvim salt okunur.', 409, 'calendar-source-read-only');
    }
    return { account, calendar, provider: providerDefinition(account.provider) };
  }

  function providerEventBody(providerId, input, timeZone) {
    const event = normalizeEventInput(input);
    const end = event.allDay
      ? { date: addDays(event.date, 1), time: null }
      : event.endTime
        ? { date: event.date, time: event.endTime }
        : addMinutesToLocal(event.date, event.startTime, 60);
    if (providerId === 'google') {
      return {
        normalized: event,
        body: {
          summary: event.title,
          description: event.notes || undefined,
          location: event.location || undefined,
          start: event.allDay
            ? { date: event.date }
            : { dateTime: `${event.date}T${event.startTime}:00`, timeZone },
          end: event.allDay
            ? { date: end.date }
            : { dateTime: `${end.date}T${end.time}:00`, timeZone }
        }
      };
    }
    const zone = microsoftTimeZone(timeZone);
    return {
      normalized: event,
      body: {
        subject: event.title,
        body: { contentType: 'text', content: event.notes || '' },
        location: { displayName: event.location || '' },
        isAllDay: event.allDay,
        start: {
          dateTime: `${event.date}T${event.allDay ? '00:00' : event.startTime}:00`,
          timeZone: zone
        },
        end: {
          dateTime: `${end.date}T${event.allDay ? '00:00' : end.time}:00`,
          timeZone: zone
        }
      }
    };
  }

  async function mutateWithAccount(account, operation) {
    const provider = providerDefinition(account.provider);
    let token = await accessTokenForAccount(account);
    try {
      return await operation(token);
    } catch (error) {
      if (!(error instanceof RemoteResponseError) || error.statusCode !== 401) {
        throw providerFailure(provider, error, 'calendar-event-write-failed');
      }
      accessTokens.delete(account.id);
      token = await accessTokenForAccount(loadAccount(account.id), { force: true });
      try {
        return await operation(token);
      } catch (retryError) {
        throw providerFailure(provider, retryError, 'calendar-event-write-failed');
      }
    }
  }

  async function createEvent(input) {
    const accountId = boundedString(input && input.sourceId, 'Takvim hesabı', 64);
    const calendarId = boundedString(input && input.calendarId, 'Takvim kaynağı', 1_024);
    const timeZone = normalizeTimeZone(input && input.timeZone || 'UTC');
    const { account, calendar, provider } = accountAndCalendar(accountId, calendarId, { writable: true });
    const { body } = providerEventBody(provider.id, input, timeZone);
    const raw = await mutateWithAccount(account, (accessToken) => {
      if (provider.id === 'google') {
        return httpRequest({
          url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events`,
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          json: body
        });
      }
      return httpRequest({
        url: `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.id)}/events`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: `outlook.timezone="${microsoftTimeZone(timeZone)}"`
        },
        json: body
      });
    });
    const normalized = provider.id === 'google'
      ? normalizeGoogleEvent(account, calendar, raw, timeZone)
      : normalizeMicrosoftEvent(account, calendar, raw);
    if (!normalized) {
      throw new CalendarConnectionError('Sağlayıcı oluşturulan etkinliği doğrulamadı.', 502, 'calendar-event-create-invalid-response');
    }
    return normalized;
  }

  async function updateEvent(eventId, input) {
    const reference = parseRemoteEventId(eventId);
    const timeZone = normalizeTimeZone(input && input.timeZone || 'UTC');
    const { account, calendar, provider } = accountAndCalendar(
      reference.accountId,
      reference.calendarId,
      { writable: true }
    );
    const { body } = providerEventBody(provider.id, input, timeZone);
    const raw = await mutateWithAccount(account, (accessToken) => httpRequest({
      url: provider.id === 'google'
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(reference.eventId)}`
        : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(reference.eventId)}`,
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(provider.id === 'microsoft' ? { Prefer: `outlook.timezone="${microsoftTimeZone(timeZone)}"` } : {})
      },
      json: body
    }));
    const normalized = provider.id === 'google'
      ? normalizeGoogleEvent(account, calendar, raw, timeZone)
      : normalizeMicrosoftEvent(account, calendar, raw);
    if (!normalized) {
      throw new CalendarConnectionError('Sağlayıcı güncellenen etkinliği doğrulamadı.', 502, 'calendar-event-update-invalid-response');
    }
    return normalized;
  }

  async function removeEvent(eventId) {
    const reference = parseRemoteEventId(eventId);
    const { account, calendar, provider } = accountAndCalendar(
      reference.accountId,
      reference.calendarId,
      { writable: true }
    );
    await mutateWithAccount(account, (accessToken) => httpRequest({
      url: provider.id === 'google'
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(reference.eventId)}`
        : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(reference.eventId)}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    }));
    return { id: eventId, deleted: true };
  }

  function disconnectAccount(accountId, confirmation) {
    if (confirmation !== 'DISCONNECT CALENDAR ACCOUNT') {
      throw new CalendarConnectionError('Takvim hesabını ayırma onayı gerekli.', 400, 'calendar-account-disconnect-confirmation-required');
    }
    const account = loadAccount(accountId);
    accessTokens.delete(account.id);
    removeFileIfPresent(accountTokenFile(account.id));
    removeFileIfPresent(accountConfigFile(account.id));
    try {
      fs.rmdirSync(accountRoot(account.id));
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    return { disconnected: true, account: publicAccount({ ...account, calendars: [] }) };
  }

  function disconnectProvider(providerId, confirmation) {
    const provider = providerDefinition(providerId);
    if (confirmation !== 'REMOVE CALENDAR OAUTH APP') {
      throw new CalendarConnectionError('OAuth uygulamasını kaldırma onayı gerekli.', 400, 'calendar-provider-disconnect-confirmation-required');
    }
    if (listAccounts().some((account) => account.provider === provider.id)) {
      throw new CalendarConnectionError('Önce bu sağlayıcıya bağlı takvim hesaplarını ayırın.', 409, 'calendar-provider-accounts-exist');
    }
    removeFileIfPresent(providerSecretFile(provider.id));
    removeFileIfPresent(providerConfigFile(provider.id));
    try {
      fs.rmdirSync(providerRoot(provider.id));
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    return { disconnected: true, provider: providerStatus(provider.id) };
  }

  return {
    completeAuthorization,
    configureProvider,
    createEvent,
    disconnectAccount,
    disconnectProvider,
    listEvents,
    listSources,
    parseRemoteEventId,
    paths: { accountsRoot, providersRoot, root },
    startAuthorization,
    status,
    updateEvent,
    removeEvent
  };
}

module.exports = {
  ACCOUNT_ID_PATTERN,
  CalendarConnectionError,
  PROVIDERS,
  REMOTE_EVENT_PREFIX,
  SCHEMA_VERSION,
  createCalendarConnectionManager,
  defaultHttpRequest,
  normalizeTimeZone,
  parseRemoteEventId
};
