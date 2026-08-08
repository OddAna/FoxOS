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
const THREAD_LIST_PAGE_LIMIT = 50;
const MAX_THREAD_CURSOR_LENGTH = 2048;
// The daemon currently reports direct App Server sessions as `vscode`; keep
// the documented `appServer` source compatible without admitting CLI/exec work.
const FOXOS_THREAD_SOURCES = new Set(['appServer', 'vscode']);
const MAX_THREAD_ID_LENGTH = 256;
const MAX_HISTORY_TURNS = 200;
const MAX_HISTORY_ITEMS = 2000;
const MAX_MEMORY_LABEL_LENGTH = 120;
const DEFAULT_APPROVAL_POLICY = 'untrusted';
const NO_APPROVAL_POLICY = 'never';
const APPROVAL_POLICIES = new Set([
  DEFAULT_APPROVAL_POLICY,
  NO_APPROVAL_POLICY
]);
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

function normalizeThreadId(value) {
  const threadId = typeof value === 'string' ? value.trim() : '';
  if (!threadId || threadId.length > MAX_THREAD_ID_LENGTH || /[\r\n\0]/.test(threadId)) {
    throw new CodexConnectionError('Codex konuşma kimliği geçersiz.', 400, 'codex-thread-id-invalid');
  }
  return threadId;
}

function normalizeApprovalPolicy(value) {
  const approvalPolicy = value === undefined || value === null || value === ''
    ? DEFAULT_APPROVAL_POLICY
    : typeof value === 'string' ? value.trim() : '';
  if (!APPROVAL_POLICIES.has(approvalPolicy)) {
    throw new CodexConnectionError('Codex izin politikası geçersiz.', 400, 'codex-approval-policy-invalid');
  }
  return approvalPolicy;
}

function normalizeThreadCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  const cursor = typeof value === 'string' ? value.trim() : '';
  if (!cursor || cursor.length > MAX_THREAD_CURSOR_LENGTH || /[\r\n\0]/.test(cursor)) {
    throw new CodexConnectionError('Codex konuşma sayfası geçersiz.', 400, 'codex-thread-cursor-invalid');
  }
  return cursor;
}

function normalizeDriveFolderUrl(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new CodexConnectionError('Drive hafıza klasörü bağlantısı geçersiz.', 400, 'codex-memory-folder-invalid');
  }
  const match = parsed.pathname.match(/^\/drive(?:\/u\/\d+)?\/folders\/([A-Za-z0-9_-]{10,200})\/?$/);
  if (
    parsed.protocol !== 'https:' || parsed.hostname !== 'drive.google.com' || parsed.port ||
    parsed.username || parsed.password || parsed.hash || !match
  ) {
    throw new CodexConnectionError('Drive hafıza klasörü bağlantısı geçersiz.', 400, 'codex-memory-folder-invalid');
  }
  return `https://drive.google.com/drive/folders/${match[1]}`;
}

function normalizeMemoryConfig(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object') {
    throw new CodexConnectionError('Codex hafıza kaydı desteklenmiyor.', 409, 'codex-config-invalid');
  }
  const label = typeof value.label === 'string' && value.label.trim()
    ? boundedText(value.label.trim(), MAX_MEMORY_LABEL_LENGTH)
    : 'Drive hafızası';
  if (/\n/.test(label)) {
    throw new CodexConnectionError('Codex hafıza kaydı desteklenmiyor.', 409, 'codex-config-invalid');
  }
  return {
    enabled: value.enabled === true,
    folderUrl: normalizeDriveFolderUrl(value.folderUrl),
    label
  };
}

function memoryDeveloperInstructions(config) {
  const memory = config && config.memory;
  if (!memory || memory.enabled !== true) return null;
  return [
    'FoxOS owner-configured private memory bootstrap:',
    'Before answering the first user message in this thread, use the connected Google Drive capability to open this exact private folder:',
    memory.folderUrl,
    'Read AGENTS.md completely first, then read index.md. Follow the vault rules and use the compact index to open only the memory pages relevant to the user\'s actual request.',
    'When the request concerns this FoxOS server or prior maintenance, search the same folder for foxos-46-server-operations.md and read only the relevant recent entries before acting.',
    'If a vault instruction names a local helper that is unavailable on this server, use targeted Google Drive search, folder listing, and file fetch instead; do not treat the missing local helper as missing memory.',
    'Do not expose or copy the folder URL, connector credentials, authentication state, tokens, or private memory into Git, repository files, command logs, or ordinary responses.',
    'Do not claim memory was loaded unless both startup files were read successfully. If the Drive connection is unavailable, tell the owner briefly and continue with the available context.'
  ].join('\n');
}

function normalizedTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizedThreadStatus(value) {
  const status = value && typeof value.type === 'string' ? value.type : '';
  return ['notLoaded', 'idle', 'systemError', 'active'].includes(status) ? status : 'notLoaded';
}

function isFoxosThread(thread) {
  return Boolean(
    thread && typeof thread === 'object' &&
    typeof thread.id === 'string' && thread.id &&
    thread.cwd === '/' && FOXOS_THREAD_SOURCES.has(thread.source)
  );
}

function sanitizeThreadSummary(thread) {
  if (!isFoxosThread(thread)) return null;
  return {
    id: boundedText(thread.id, MAX_THREAD_ID_LENGTH),
    name: typeof thread.name === 'string' && thread.name.trim()
      ? boundedText(thread.name.trim(), 200)
      : null,
    preview: typeof thread.preview === 'string'
      ? boundedText(thread.preview.trim().replace(/\s+/g, ' '), 500)
      : '',
    createdAt: normalizedTimestamp(thread.createdAt),
    updatedAt: normalizedTimestamp(thread.updatedAt),
    recencyAt: normalizedTimestamp(thread.recencyAt),
    status: normalizedThreadStatus(thread.status),
    ephemeral: thread.ephemeral === true
  };
}

function sanitizeHistoryItem(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null;
  const id = boundedText(item.id, 256);
  if (item.type === 'userMessage') {
    const content = (Array.isArray(item.content) ? item.content : [])
      .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
      .slice(0, 32)
      .map((entry) => ({ type: 'text', text: boundedText(entry.text, MAX_PROMPT_LENGTH) }));
    return content.length ? { id, type: 'userMessage', content } : null;
  }
  if (item.type === 'agentMessage') {
    return { id, type: 'agentMessage', text: boundedText(item.text, 128 * 1024) };
  }
  if (item.type === 'commandExecution') {
    return {
      id,
      type: 'commandExecution',
      command: boundedText(item.command, 8000),
      cwd: boundedText(item.cwd || '/', 2048),
      aggregatedOutput: boundedText(item.aggregatedOutput, 128 * 1024),
      status: boundedText(item.status, 40),
      exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null
    };
  }
  if (item.type === 'fileChange') {
    const changes = (Array.isArray(item.changes) ? item.changes : []).slice(0, 200).map((change) => ({
      path: boundedText(change && change.path, 2048),
      kind: boundedText(
        typeof (change && change.kind) === 'string'
          ? change.kind
          : change && change.kind && change.kind.type,
        40
      ) || 'changed'
    }));
    return {
      id,
      type: 'fileChange',
      changes,
      status: boundedText(item.status, 40)
    };
  }
  return null;
}

function sanitizeThreadWithHistory(thread) {
  const summary = sanitizeThreadSummary(thread);
  if (!summary) return null;
  const sourceTurns = Array.isArray(thread.turns) ? thread.turns : [];
  const selectedTurns = sourceTurns.slice(-MAX_HISTORY_TURNS);
  let itemCount = 0;
  let historyTruncated = selectedTurns.length !== sourceTurns.length;
  const turns = [];
  for (const turn of selectedTurns) {
    if (!turn || typeof turn !== 'object' || typeof turn.id !== 'string') continue;
    const items = [];
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (itemCount >= MAX_HISTORY_ITEMS) {
        historyTruncated = true;
        break;
      }
      const sanitized = sanitizeHistoryItem(item);
      if (!sanitized) continue;
      items.push(sanitized);
      itemCount += 1;
    }
    turns.push({
      id: boundedText(turn.id, 256),
      status: boundedText(turn.status, 40),
      error: turn.error && typeof turn.error.message === 'string'
        ? { message: boundedText(turn.error.message, 2000) }
        : null,
      items
    });
  }
  return { ...summary, turns, historyTruncated };
}

function normalizeCliInspection(value) {
  return {
    installed: value && value.installed === true,
    version: value && typeof value.version === 'string'
      ? boundedText(value.version.trim(), 120)
      : null
  };
}

function normalizeAccountInspection(value) {
  return {
    connected: value && value.connected === true,
    authMode: value && typeof value.authMode === 'string'
      ? boundedText(value.authMode.trim(), 40) || null
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
  constructor({ prepareAppServer, spawnAppServer, clock = () => new Date() }) {
    this.prepareAppServer = prepareAppServer;
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
        await this.prepareAppServer();
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
  inspectAccount,
  inspectCli,
  installCli,
  prepareAppServer,
  spawnAppServer,
  stopAppServer,
  clock = () => new Date()
}) {
  if (
    !dataRoot || typeof inspectAccount !== 'function' || typeof inspectCli !== 'function' ||
    typeof installCli !== 'function' || typeof prepareAppServer !== 'function' ||
    typeof spawnAppServer !== 'function' ||
    typeof stopAppServer !== 'function'
  ) {
    throw new Error('Codex connection manager requires data and host runtime adapters');
  }

  const root = path.join(dataRoot, 'connections', PROVIDER);
  const configFile = path.join(root, 'config.json');
  let hostRuntimeKnownStopped = false;
  let loginInProgress = false;
  const client = new CodexAppServerClient({
    prepareAppServer,
    spawnAppServer: () => {
      hostRuntimeKnownStopped = false;
      return spawnAppServer();
    },
    clock
  });
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
        memory: null,
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
    return {
      ...config,
      memory: normalizeMemoryConfig(config.memory)
    };
  }

  function saveConfig(accessProfile, memoryOverride = undefined) {
    const previous = loadConfig();
    const timestamp = now();
    const memory = memoryOverride === undefined
      ? previous.memory
      : normalizeMemoryConfig(memoryOverride);
    const config = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      provider: PROVIDER,
      accessProfile,
      ...(memory ? { memory } : {}),
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

  async function stopHostRuntime() {
    client.stop();
    if (hostRuntimeKnownStopped) return;
    await stopAppServer();
    hostRuntimeKnownStopped = true;
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

  async function requireFullServer() {
    await requireInstalled();
    const config = loadConfig();
    if (config.accessProfile !== FULL_SERVER_ACCESS_PROFILE) {
      throw new CodexConnectionError(
        'Codex çalıştırmadan önce Full Server erişimini etkinleştirin.',
        409,
        'codex-full-server-required'
      );
    }
    if (!(await readAccount())) {
      throw new CodexConnectionError('Önce Codex hesabınızı bağlayın.', 409, 'codex-account-required');
    }
    return config;
  }

  async function status() {
    const inspection = normalizeCliInspection(await inspectCli());
    const config = loadConfig();
    const fullServer = config.accessProfile === FULL_SERVER_ACCESS_PROFILE;
    let account = null;
    let accountConnected = false;
    let authMode = null;
    let runtimeReady = false;
    let runtimeError = null;
    if (inspection.installed) {
      try {
        if (fullServer) {
          account = await readAccount();
          accountConnected = Boolean(account);
          authMode = account && account.type || null;
          runtimeReady = true;
        } else {
          const accountInspection = normalizeAccountInspection(await inspectAccount());
          accountConnected = accountInspection.connected;
          authMode = accountInspection.authMode;
          if (!loginInProgress || accountConnected) {
            loginInProgress = false;
            await stopHostRuntime();
          }
          runtimeReady = true;
        }
      } catch (error) {
        runtimeError = error.code || 'codex-app-server-unavailable';
      }
    }
    return {
      id: PROVIDER,
      name: 'Codex',
      installed: inspection.installed,
      version: inspection.version,
      connected: accountConnected,
      ready: Boolean(inspection.installed && accountConnected && runtimeReady),
      runtimeReady,
      runtimeError,
      authMode,
      email: account && typeof account.email === 'string' ? account.email : null,
      planType: account && typeof account.planType === 'string' ? account.planType : null,
      runtimeOwner: 'server',
      runtimeTransport: 'unix-websocket',
      survivesAgentRestart: inspection.installed,
      accessProfile: config.accessProfile,
      fullServer,
      rootEquivalent: fullServer,
      workingDirectory: '/',
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      supportedApprovalPolicies: [DEFAULT_APPROVAL_POLICY, NO_APPROVAL_POLICY],
      memoryConfigured: Boolean(config.memory),
      memoryEnabled: Boolean(config.memory && config.memory.enabled),
      memoryLabel: config.memory ? config.memory.label : null,
      memoryLocationIncluded: false,
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
    const existing = normalizeCliInspection(await inspectCli());
    if (existing.installed) await stopHostRuntime();
    await installCli();
    hostRuntimeKnownStopped = false;
    loginInProgress = false;
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
    loginInProgress = true;
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
    loginInProgress = false;
    if (loadConfig().accessProfile === DEFAULT_ACCESS_PROFILE) await stopHostRuntime();
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
      loginInProgress = false;
      await stopHostRuntime();
    }
    return status();
  }

  async function configureMemory({ enabled, folderUrl, label } = {}) {
    await requireInstalled();
    if (typeof enabled !== 'boolean') {
      throw new CodexConnectionError('Drive hafızası durumu geçersiz.', 400, 'codex-memory-enabled-invalid');
    }
    const config = loadConfig();
    const nextMemory = typeof folderUrl === 'string' && folderUrl.trim()
      ? normalizeMemoryConfig({ enabled, folderUrl, label })
      : config.memory
        ? { ...config.memory, enabled }
        : null;
    if (enabled && !nextMemory) {
      throw new CodexConnectionError(
        'Drive hafızasını açmak için klasör bağlantısı gerekli.',
        400,
        'codex-memory-folder-required'
      );
    }
    saveConfig(config.accessProfile, nextMemory);
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
      loginInProgress = false;
      await stopHostRuntime();
    }
    return { disconnected: true, connection: await status() };
  }

  async function listThreads(cursor = null) {
    await requireFullServer();
    const normalizedCursor = normalizeThreadCursor(cursor);
    const result = await client.request('thread/list', {
      limit: THREAD_LIST_PAGE_LIMIT,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: [...FOXOS_THREAD_SOURCES],
      cwd: '/',
      ...(normalizedCursor ? { cursor: normalizedCursor } : {})
    });
    if (!result || !Array.isArray(result.data)) {
      throw new CodexConnectionError(
        'Codex konuşma geçmişi okunamadı.',
        502,
        'codex-thread-list-invalid'
      );
    }
    return {
      threads: result.data.map(sanitizeThreadSummary).filter(Boolean),
      nextCursor: typeof result.nextCursor === 'string' && result.nextCursor.length <= MAX_THREAD_CURSOR_LENGTH
        ? result.nextCursor
        : null
    };
  }

  async function startThread(model, reasoningEffort, requestedApprovalPolicy) {
    const config = await requireFullServer();
    const approvalPolicy = normalizeApprovalPolicy(requestedApprovalPolicy);
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
    const developerInstructions = memoryDeveloperInstructions(config);
    const result = await client.request('thread/start', {
      model: selectedModel.model,
      cwd: '/',
      approvalPolicy,
      sandbox: 'danger-full-access',
      serviceName: 'foxos',
      ephemeral: false,
      ...(developerInstructions ? { developerInstructions } : {}),
      config: { model_reasoning_effort: selectedEffort }
    });
    const thread = sanitizeThreadSummary(result.thread);
    if (!thread) {
      throw new CodexConnectionError('Codex konuşması başlatılamadı.', 502, 'codex-thread-response-invalid');
    }
    return {
      thread,
      model: typeof result.model === 'string' ? result.model : selectedModel.model,
      reasoningEffort: typeof result.reasoningEffort === 'string'
        ? result.reasoningEffort
        : selectedEffort,
      approvalPolicy,
      accessProfile: config.accessProfile,
      memoryEnabled: Boolean(config.memory && config.memory.enabled),
      workingDirectory: '/'
    };
  }

  async function resumeThread(threadId, requestedApprovalPolicy) {
    const config = await requireFullServer();
    const normalizedThreadId = normalizeThreadId(threadId);
    const approvalPolicy = normalizeApprovalPolicy(requestedApprovalPolicy);
    const developerInstructions = memoryDeveloperInstructions(config);
    const result = await client.request('thread/resume', {
      threadId: normalizedThreadId,
      cwd: '/',
      approvalPolicy,
      sandbox: 'danger-full-access',
      ...(developerInstructions ? { developerInstructions } : {})
    });
    const thread = sanitizeThreadWithHistory(result.thread);
    if (!thread || thread.id !== normalizedThreadId) {
      throw new CodexConnectionError('Codex konuşması açılamadı.', 404, 'codex-thread-not-found');
    }
    return {
      thread,
      model: typeof result.model === 'string' ? boundedText(result.model, 200) : null,
      reasoningEffort: typeof result.reasoningEffort === 'string'
        ? boundedText(result.reasoningEffort, 32)
        : null,
      approvalPolicy,
      accessProfile: FULL_SERVER_ACCESS_PROFILE,
      memoryEnabled: Boolean(config.memory && config.memory.enabled),
      workingDirectory: '/'
    };
  }

  async function startTurn(threadId, text, requestedApprovalPolicy) {
    await requireFullServer();
    const normalizedThreadId = normalizeThreadId(threadId);
    const approvalPolicy = normalizeApprovalPolicy(requestedApprovalPolicy);
    const prompt = typeof text === 'string' ? text.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      throw new CodexConnectionError('Codex isteği boş veya çok uzun.', 400, 'codex-prompt-invalid');
    }
    const result = await client.request('turn/start', {
      threadId: normalizedThreadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy
    });
    return { turn: result.turn || null, approvalPolicy };
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
    configureMemory: (memory) => serializeRuntimeMutation(() => configureMemory(memory)),
    disconnect: (confirmation) => serializeRuntimeMutation(() => disconnect(confirmation)),
    events: (sequence, threadId) => client.eventsAfter(sequence, threadId),
    install: (confirmation) => serializeRuntimeMutation(() => install(confirmation)),
    interruptTurn,
    listModels,
    listThreads,
    resolveApproval: (requestId, decision) => client.resolveApproval(requestId, decision),
    resumeThread: (threadId, approvalPolicy) => serializeRuntimeMutation(
      () => resumeThread(threadId, approvalPolicy)
    ),
    setAccessProfile: (accessProfile, confirmation) => serializeRuntimeMutation(
      () => setAccessProfile(accessProfile, confirmation)
    ),
    startLogin,
    startThread: (model, reasoningEffort, approvalPolicy) => serializeRuntimeMutation(
      () => startThread(model, reasoningEffort, approvalPolicy)
    ),
    startTurn: (threadId, text, approvalPolicy) => serializeRuntimeMutation(
      () => startTurn(threadId, text, approvalPolicy)
    ),
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
