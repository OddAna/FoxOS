const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const CONFIG_SCHEMA_VERSION = 1;
const PROVIDER = 'codex';
const DEFAULT_ACCESS_PROFILE = 'read-only';
const FULL_SERVER_ACCESS_PROFILE = 'full-server';
const INSTALL_CONFIRMATION = 'INSTALL CODEX ON SERVER';
const FULL_SERVER_CONFIRMATION = 'ENABLE CODEX FULL SERVER';
const DISCONNECT_CONFIRMATION = 'DISCONNECT CODEX';
const MAX_EVENT_COUNT = 1000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_EVENT_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 32768;
const REQUEST_TIMEOUT_MS = 30000;
const MODEL_LIST_PAGE_LIMIT = 100;
const MODEL_LIST_MAX_PAGES = 5;
const SUPPORTED_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval'
]);
const APPROVAL_DECISIONS = new Set([
  'accept',
  'acceptForSession',
  'decline',
  'cancel'
]);

class CodexConnectionError extends Error {
  constructor(message, statusCode = 409, code = 'codex-connection-error') {
    super(message);
    this.name = 'CodexConnectionError';
    this.statusCode = statusCode;
    this.code = code;
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

function boundedText(value, maximum = 500) {
  return String(value || '').replace(/[\r\0]/g, '').slice(0, maximum);
}

function normalizeCliInspection(value) {
  return {
    installed: value && value.installed === true,
    version: value && typeof value.version === 'string'
      ? boundedText(value.version.trim(), 120)
      : null
  };
}

function normalizeModelCatalog(value) {
  const models = [];
  const seenModels = new Set();
  for (const entry of value || []) {
    if (!entry || typeof entry !== 'object') continue;
    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!model || model.length > 200 || /[\r\n\0]/.test(model) || seenModels.has(model)) continue;

    const efforts = [];
    const seenEfforts = new Set();
    for (const option of Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts
      : []) {
      const effort = typeof option === 'string'
        ? option.trim()
        : option && typeof option.reasoningEffort === 'string'
          ? option.reasoningEffort.trim()
          : '';
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(effort) || seenEfforts.has(effort)) continue;
      seenEfforts.add(effort);
      efforts.push(effort);
    }

    const advertisedDefault = typeof entry.defaultReasoningEffort === 'string'
      ? entry.defaultReasoningEffort.trim()
      : '';
    if (/^[a-z][a-z0-9-]{0,31}$/.test(advertisedDefault) && !seenEfforts.has(advertisedDefault)) {
      efforts.push(advertisedDefault);
    }
    if (!efforts.length) continue;

    seenModels.add(model);
    models.push({
      id: typeof entry.id === 'string' && entry.id.trim()
        ? boundedText(entry.id.trim(), 200)
        : model,
      model,
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim()
        ? boundedText(entry.displayName.trim(), 200)
        : model,
      description: typeof entry.description === 'string'
        ? boundedText(entry.description.trim(), 1000)
        : '',
      isDefault: entry.isDefault === true,
      defaultReasoningEffort: efforts.includes(advertisedDefault) ? advertisedDefault : efforts[0],
      supportedReasoningEfforts: efforts
    });
  }

  if (!models.length) {
    throw new CodexConnectionError(
      'Codex kullanılabilir bir model bildirmedi.',
      502,
      'codex-model-catalog-invalid'
    );
  }
  return {
    models,
    defaultModel: (models.find((entry) => entry.isDefault) || models[0]).model
  };
}

function safeEvent(method, params) {
  let encoded;
  try {
    encoded = JSON.stringify({ method, params });
  } catch {
    return {
      method: 'warning',
      params: { message: 'Codex okunamayan bir çalışma olayı gönderdi.' }
    };
  }
  if (Buffer.byteLength(encoded) <= MAX_EVENT_BYTES) return { method, params };
  return {
    method: 'warning',
    params: { message: 'Codex çalışma olayı güvenli yanıt sınırını aştığı için gösterilmedi.' }
  };
}

function threadIdForEvent(event) {
  const params = event && event.params || {};
  return params.threadId ||
    params.thread && params.thread.id ||
    params.turn && params.turn.threadId ||
    null;
}

class CodexAppServerClient {
  constructor({ spawnAppServer, clock = () => new Date() }) {
    this.spawnAppServer = spawnAppServer;
    this.clock = clock;
    this.child = null;
    this.starting = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.pendingApprovals = new Map();
    this.events = [];
    this.eventBufferBytes = 0;
    this.nextEventSequence = 1;
  }

  emit(method, params = {}) {
    const event = safeEvent(method, params);
    const record = {
      sequence: this.nextEventSequence++,
      createdAt: new Date(this.clock()).toISOString(),
      ...event
    };
    const buffered = {
      ...record,
      bufferedBytes: Buffer.byteLength(JSON.stringify(record))
    };
    this.events.push(buffered);
    this.eventBufferBytes += buffered.bufferedBytes;
    while (this.events.length > MAX_EVENT_COUNT || this.eventBufferBytes > MAX_EVENT_BUFFER_BYTES) {
      const removed = this.events.shift();
      this.eventBufferBytes -= removed.bufferedBytes;
    }
  }

  rejectPending(message) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexConnectionError(message, 503, 'codex-app-server-stopped'));
    }
    this.pendingRequests.clear();
    this.pendingApprovals.clear();
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('warning', { message: 'Codex app-server geçersiz bir çalışma olayı gönderdi.' });
      return;
    }

    if (message && message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(String(message.id));
      if (!pending) return;
      this.pendingRequests.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexConnectionError(
          boundedText(message.error.message || 'Codex isteği başarısız oldu.'),
          409,
          'codex-app-server-request-failed'
        ));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    if (message && message.method && message.id !== undefined) {
      if (!SUPPORTED_APPROVAL_METHODS.has(message.method)) {
        this.write({
          id: message.id,
          error: { code: -32601, message: 'FoxOS bu Codex istemci isteğini henüz desteklemiyor.' }
        });
        this.emit('warning', {
          threadId: message.params && message.params.threadId || null,
          message: 'Codex desteklenmeyen bir istemci etkileşimi istedi; işlem güvenli biçimde durduruldu.'
        });
        return;
      }

      const requestId = crypto.randomUUID();
      const params = message.params || {};
      this.pendingApprovals.set(requestId, {
        rpcId: message.id,
        method: message.method,
        params
      });
      this.emit('foxos/approvalRequested', {
        requestId,
        method: message.method,
        threadId: params.threadId || null,
        turnId: params.turnId || null,
        itemId: params.itemId || null,
        command: params.command ? boundedText(params.command, 8000) : null,
        cwd: params.cwd ? boundedText(params.cwd, 2048) : null,
        reason: params.reason ? boundedText(params.reason, 2000) : null,
        availableDecisions: Array.isArray(params.availableDecisions)
          ? params.availableDecisions.filter((entry) => typeof entry === 'string').slice(0, 8)
          : null
      });
      return;
    }

    if (message && message.method) this.emit(message.method, message.params || {});
  }

  attachChild(child) {
    this.child = child;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk;
      let newline;
      while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.once('error', () => {
      this.emit('error', { error: { message: 'Codex app-server başlatılamadı.' } });
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.starting = null;
      this.rejectPending('Codex app-server bağlantısı kapandı.');
      this.emit('foxos/runtimeStopped', {
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null
      });
    });
  }

  write(message) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new CodexConnectionError('Codex app-server çalışmıyor.', 503, 'codex-app-server-unavailable');
    }
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  requestDirect(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(new CodexConnectionError('Codex isteği zaman aşımına uğradı.', 504, 'codex-app-server-timeout'));
      }, timeoutMs);
      this.pendingRequests.set(String(id), { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(String(id));
        reject(error);
      }
    });
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      let child;
      try {
        child = this.spawnAppServer();
      } catch {
        throw new CodexConnectionError('Codex app-server başlatılamadı.', 503, 'codex-app-server-unavailable');
      }
      this.attachChild(child);
      try {
        await this.requestDirect('initialize', {
          clientInfo: {
            name: 'foxos',
            title: 'FoxOS',
            version: '0.0.2'
          }
        });
        this.write({ method: 'initialized', params: {} });
        this.emit('foxos/runtimeReady', {});
      } catch (error) {
        try { child.kill('SIGTERM'); } catch {}
        throw error;
      }
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.ensureStarted();
    return this.requestDirect(method, params, timeoutMs);
  }

  eventsAfter(sequence = 0, threadId = null) {
    const normalizedSequence = Number.isInteger(Number(sequence)) && Number(sequence) >= 0
      ? Number(sequence)
      : 0;
    const events = this.events.filter((event) => (
      event.sequence > normalizedSequence &&
      (!threadId || !threadIdForEvent(event) || threadIdForEvent(event) === threadId)
    )).slice(0, 250).map(({ bufferedBytes, ...event }) => event);
    return {
      events,
      cursor: events.length ? events[events.length - 1].sequence : normalizedSequence,
      latest: this.nextEventSequence - 1
    };
  }

  resolveApproval(requestId, decision) {
    const pending = this.pendingApprovals.get(String(requestId || ''));
    if (!pending) {
      throw new CodexConnectionError('Codex onay isteği bulunamadı veya süresi doldu.', 404, 'codex-approval-not-found');
    }
    if (!APPROVAL_DECISIONS.has(decision)) {
      throw new CodexConnectionError('Codex onay kararı geçersiz.', 400, 'codex-approval-decision-invalid');
    }
    const available = pending.params && pending.params.availableDecisions;
    if (Array.isArray(available) && available.length && !available.includes(decision)) {
      throw new CodexConnectionError('Bu karar Codex onay isteği için kullanılamıyor.', 409, 'codex-approval-decision-unavailable');
    }
    this.write({ id: pending.rpcId, result: { decision } });
    this.pendingApprovals.delete(String(requestId));
    return { resolved: true, requestId, decision };
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.rejectPending('Codex app-server bağlantısı kapatıldı.');
    try { child.kill('SIGTERM'); } catch {}
  }
}

function createCodexConnectionManager({
  dataRoot,
  inspectCli,
  installCli,
  spawnAppServer,
  clock = () => new Date()
}) {
  if (!dataRoot || typeof inspectCli !== 'function' || typeof installCli !== 'function' || typeof spawnAppServer !== 'function') {
    throw new Error('Codex connection manager requires data and host CLI adapters');
  }

  const root = path.join(dataRoot, 'connections', PROVIDER);
  const configFile = path.join(root, 'config.json');
  const client = new CodexAppServerClient({ spawnAppServer, clock });
  let runtimeMutationTail = Promise.resolve();

  function serializeRuntimeMutation(operation) {
    const pending = runtimeMutationTail.then(operation, operation);
    runtimeMutationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  function now() {
    return new Date(clock()).toISOString();
  }

  function loadConfig() {
    const config = readJson(configFile, null);
    if (!config) {
      return {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        provider: PROVIDER,
        accessProfile: DEFAULT_ACCESS_PROFILE,
        configuredAt: null,
        updatedAt: null
      };
    }
    if (
      config.schemaVersion !== CONFIG_SCHEMA_VERSION || config.provider !== PROVIDER ||
      ![DEFAULT_ACCESS_PROFILE, FULL_SERVER_ACCESS_PROFILE].includes(config.accessProfile)
    ) {
      throw new CodexConnectionError('Codex bağlantı kaydı desteklenmiyor.', 409, 'codex-config-invalid');
    }
    return config;
  }

  function saveConfig(accessProfile) {
    const previous = loadConfig();
    const timestamp = now();
    const config = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      provider: PROVIDER,
      accessProfile,
      configuredAt: previous.configuredAt || timestamp,
      updatedAt: timestamp
    };
    ensureDirectory(root);
    atomicWriteJson(configFile, config);
    fs.chmodSync(configFile, 0o600);
    return config;
  }

  async function requireInstalled() {
    const inspection = normalizeCliInspection(await inspectCli());
    if (!inspection.installed) {
      throw new CodexConnectionError('Codex CLI bu sunucuda kurulu değil.', 409, 'codex-cli-not-installed');
    }
    return inspection;
  }

  async function readAccount() {
    const result = await client.request('account/read', { refreshToken: false });
    return result.account || null;
  }

  async function loadModelCatalog() {
    const entries = [];
    let cursor = null;
    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
      const result = await client.request('model/list', {
        includeHidden: false,
        limit: MODEL_LIST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {})
      });
      if (!result || !Array.isArray(result.data)) {
        throw new CodexConnectionError(
          'Codex model kataloğu okunamadı.',
          502,
          'codex-model-catalog-invalid'
        );
      }
      entries.push(...result.data);
      cursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : null;
      if (!cursor) return normalizeModelCatalog(entries);
    }
    throw new CodexConnectionError(
      'Codex model kataloğu güvenli sayfalama sınırını aştı.',
      502,
      'codex-model-catalog-invalid'
    );
  }

  async function listModels() {
    await requireInstalled();
    if (!(await readAccount())) {
      throw new CodexConnectionError('Önce Codex hesabınızı bağlayın.', 409, 'codex-account-required');
    }
    return loadModelCatalog();
  }

  async function status() {
    const inspection = normalizeCliInspection(await inspectCli());
    const config = loadConfig();
    let account = null;
    let runtimeReady = false;
    let runtimeError = null;
    if (inspection.installed) {
      try {
        account = await readAccount();
        runtimeReady = true;
      } catch (error) {
        runtimeError = error.code || 'codex-app-server-unavailable';
      }
    }
    const fullServer = config.accessProfile === FULL_SERVER_ACCESS_PROFILE;
    return {
      id: PROVIDER,
      name: 'Codex',
      installed: inspection.installed,
      version: inspection.version,
      connected: Boolean(account),
      ready: Boolean(inspection.installed && account && runtimeReady),
      runtimeReady,
      runtimeError,
      authMode: account && account.type || null,
      email: account && typeof account.email === 'string' ? account.email : null,
      planType: account && typeof account.planType === 'string' ? account.planType : null,
      accessProfile: config.accessProfile,
      fullServer,
      rootEquivalent: fullServer,
      workingDirectory: '/',
      approvalPolicy: 'untrusted',
      credentialsManagedByCodex: true,
      credentialIncluded: false,
      optional: true,
      accountRequiredForConnection: true,
      paidServiceRequiredForFoxos: false,
      configuredAt: config.configuredAt,
      updatedAt: config.updatedAt
    };
  }

  async function install(confirmation) {
    if (confirmation !== INSTALL_CONFIRMATION) {
      throw new CodexConnectionError('Codex kurulumu için tam onay gerekli.', 400, 'codex-install-confirmation-required');
    }
    client.stop();
    await installCli();
    const inspection = await requireInstalled();
    if (!loadConfig().configuredAt) saveConfig(DEFAULT_ACCESS_PROFILE);
    return { installed: true, version: inspection.version, connection: await status() };
  }

  async function startLogin() {
    await requireInstalled();
    const result = await client.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (
      result.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string' ||
      typeof result.verificationUrl !== 'string' || typeof result.userCode !== 'string'
    ) {
      throw new CodexConnectionError('Codex giriş akışı başlatılamadı.', 502, 'codex-login-response-invalid');
    }
    return {
      loginId: result.loginId,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode
    };
  }

  async function cancelLogin(loginId) {
    if (typeof loginId !== 'string' || !loginId.trim()) {
      throw new CodexConnectionError('Codex giriş kimliği geçersiz.', 400, 'codex-login-id-invalid');
    }
    await client.request('account/login/cancel', { loginId: loginId.trim() });
    return { cancelled: true };
  }

  async function setAccessProfile(accessProfile, confirmation = null) {
    await requireInstalled();
    if (![DEFAULT_ACCESS_PROFILE, FULL_SERVER_ACCESS_PROFILE].includes(accessProfile)) {
      throw new CodexConnectionError('Codex erişim profili geçersiz.', 400, 'codex-access-profile-invalid');
    }
    if (accessProfile === FULL_SERVER_ACCESS_PROFILE && confirmation !== FULL_SERVER_CONFIRMATION) {
      throw new CodexConnectionError('Full Server erişimi için tam onay gerekli.', 400, 'codex-full-server-confirmation-required');
    }
    if (accessProfile === FULL_SERVER_ACCESS_PROFILE && !(await readAccount())) {
      throw new CodexConnectionError('Önce Codex hesabınızı bağlayın.', 409, 'codex-account-required');
    }
    saveConfig(accessProfile);
    if (accessProfile === DEFAULT_ACCESS_PROFILE) {
      client.stop();
    }
    return status();
  }

  async function disconnect(confirmation) {
    if (confirmation !== DISCONNECT_CONFIRMATION) {
      throw new CodexConnectionError('Codex bağlantısını kesmek için tam onay gerekli.', 400, 'codex-disconnect-confirmation-required');
    }
    saveConfig(DEFAULT_ACCESS_PROFILE);
    const inspection = normalizeCliInspection(await inspectCli());
    try {
      if (inspection.installed) {
        try {
          await client.request('account/logout', {});
        } catch (error) {
          if (error.code !== 'codex-app-server-request-failed') throw error;
        }
      }
    } finally {
      client.stop();
    }
    return { disconnected: true, connection: await status() };
  }

  async function startThread(model, reasoningEffort) {
    await requireInstalled();
    const account = await readAccount();
    if (!account) {
      throw new CodexConnectionError('Önce Codex hesabınızı bağlayın.', 409, 'codex-account-required');
    }
    const config = loadConfig();
    if (config.accessProfile !== FULL_SERVER_ACCESS_PROFILE) {
      throw new CodexConnectionError(
        'Codex çalıştırmadan önce Full Server erişimini etkinleştirin.',
        409,
        'codex-full-server-required'
      );
    }
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
      throw new CodexConnectionError('Codex modeli geçersiz.', 400, 'codex-model-invalid');
    }
    if (
      reasoningEffort !== undefined && reasoningEffort !== null &&
      (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())
    ) {
      throw new CodexConnectionError(
        'Codex reasoning seviyesi geçersiz.',
        400,
        'codex-reasoning-effort-invalid'
      );
    }
    const catalog = await loadModelCatalog();
    const requestedModel = typeof model === 'string' ? model.trim() : catalog.defaultModel;
    const selectedModel = catalog.models.find((entry) => entry.model === requestedModel);
    if (!selectedModel) {
      throw new CodexConnectionError('Codex modeli kullanılamıyor.', 400, 'codex-model-invalid');
    }
    const selectedEffort = typeof reasoningEffort === 'string' && reasoningEffort.trim()
      ? reasoningEffort.trim()
      : selectedModel.defaultReasoningEffort;
    if (!selectedModel.supportedReasoningEfforts.includes(selectedEffort)) {
      throw new CodexConnectionError(
        'Seçilen reasoning seviyesi bu modelde kullanılamıyor.',
        400,
        'codex-reasoning-effort-invalid'
      );
    }
    const result = await client.request('thread/start', {
      model: selectedModel.model,
      cwd: '/',
      approvalPolicy: 'untrusted',
      sandbox: 'danger-full-access',
      serviceName: 'foxos',
      config: { model_reasoning_effort: selectedEffort }
    });
    if (!result.thread || typeof result.thread.id !== 'string') {
      throw new CodexConnectionError('Codex konuşması başlatılamadı.', 502, 'codex-thread-response-invalid');
    }
    return {
      thread: result.thread,
      model: typeof result.model === 'string' ? result.model : selectedModel.model,
      reasoningEffort: typeof result.reasoningEffort === 'string'
        ? result.reasoningEffort
        : selectedEffort,
      accessProfile: config.accessProfile,
      workingDirectory: '/'
    };
  }

  async function startTurn(threadId, text) {
    await requireInstalled();
    if (loadConfig().accessProfile !== FULL_SERVER_ACCESS_PROFILE) {
      throw new CodexConnectionError(
        'Codex çalıştırmadan önce Full Server erişimini etkinleştirin.',
        409,
        'codex-full-server-required'
      );
    }
    const account = await readAccount();
    if (!account) {
      throw new CodexConnectionError('Önce Codex hesabınızı bağlayın.', 409, 'codex-account-required');
    }
    const normalizedThreadId = typeof threadId === 'string' ? threadId.trim() : '';
    const prompt = typeof text === 'string' ? text.trim() : '';
    if (!normalizedThreadId || normalizedThreadId.length > 256 || /[\r\n\0]/.test(normalizedThreadId)) {
      throw new CodexConnectionError('Codex konuşma kimliği geçersiz.', 400, 'codex-thread-id-invalid');
    }
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      throw new CodexConnectionError('Codex isteği boş veya çok uzun.', 400, 'codex-prompt-invalid');
    }
    const result = await client.request('turn/start', {
      threadId: normalizedThreadId,
      input: [{ type: 'text', text: prompt }]
    });
    return { turn: result.turn || null };
  }

  async function interruptTurn(threadId, turnId) {
    if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId) {
      throw new CodexConnectionError('Codex çalışma kimliği geçersiz.', 400, 'codex-turn-id-invalid');
    }
    await client.request('turn/interrupt', { threadId, turnId });
    return { interrupted: true };
  }

  return {
    cancelLogin,
    disconnect: (confirmation) => serializeRuntimeMutation(() => disconnect(confirmation)),
    events: (sequence, threadId) => client.eventsAfter(sequence, threadId),
    install: (confirmation) => serializeRuntimeMutation(() => install(confirmation)),
    interruptTurn,
    listModels,
    resolveApproval: (requestId, decision) => client.resolveApproval(requestId, decision),
    setAccessProfile: (accessProfile, confirmation) => serializeRuntimeMutation(
      () => setAccessProfile(accessProfile, confirmation)
    ),
    startLogin,
    startThread: (model, reasoningEffort) => serializeRuntimeMutation(
      () => startThread(model, reasoningEffort)
    ),
    startTurn: (threadId, text) => serializeRuntimeMutation(() => startTurn(threadId, text)),
    status,
    stop: () => client.stop()
  };
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_ACCESS_PROFILE,
  DISCONNECT_CONFIRMATION,
  FULL_SERVER_ACCESS_PROFILE,
  FULL_SERVER_CONFIRMATION,
  INSTALL_CONFIRMATION,
  CodexConnectionError,
  createCodexConnectionManager
};
