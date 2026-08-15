const DEFAULT_PATHS = Object.freeze({
  python: '/usr/bin/python3',
  gmail: null,
  chat: null,
  telegram: null,
  whatsapp: null
});
const SOURCE_IDS = Object.freeze(['work-gmail', 'work-chat', 'telegram', 'whatsapp']);
const MAX_PAGES = 5;
const GMAIL_PAGE_SIZE = 50;
const CHAT_PAGE_SIZE = 100;
const MAX_WINDOW_DEPTH = 10;
const MAX_TELEGRAM_CHATS = 50;
const TELEGRAM_CHAT_REF_PATTERN = /^tg_[a-z0-9]{8,80}$/;

class CodexReviewSourceError extends Error {
  constructor(message, code = 'codex-review-source-failed') {
    super(message);
    this.name = 'CodexReviewSourceError';
    this.code = code;
  }
}

function validDate(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(parsed);
}

function compact(value, maximum = 8_000) {
  return String(value || '').replace(/\0/g, '').slice(0, maximum).trim();
}

function sourcePayload(payload, source) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CodexReviewSourceError(`${source} returned an invalid response`, 'codex-review-source-invalid');
  }
  return payload;
}

function inWindow(value, since, until) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > since.getTime() && parsed <= until.getTime();
}

function normalizedAliases(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => compact(value, 100).normalize('NFKC').toLocaleLowerCase('tr-TR').replace(/^@/, ''))
    .filter(Boolean);
}

function belongsToOwner(displayName, aliases) {
  const candidate = compact(displayName, 200).normalize('NFKC').toLocaleLowerCase('tr-TR');
  return aliases.some((alias) => candidate === alias || candidate.includes(alias));
}

function safeConversation(value, fallback) {
  return compact(value, 240) || fallback;
}

function uniqueMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    const key = `${message.source}\0${message.messageKey}`;
    if (!message.messageKey || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

function normalizedTelegramChatRefs(values) {
  if (!Array.isArray(values) || values.length > MAX_TELEGRAM_CHATS) {
    throw new CodexReviewSourceError(
      'telegram requires an explicit chat selection',
      'codex-review-telegram-scope-invalid'
    );
  }
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const chatRef = compact(value, 100).toLocaleLowerCase('en-US');
    if (!TELEGRAM_CHAT_REF_PATTERN.test(chatRef)) {
      throw new CodexReviewSourceError(
        'telegram chat selection is invalid',
        'codex-review-telegram-scope-invalid'
      );
    }
    if (!seen.has(chatRef)) {
      seen.add(chatRef);
      unique.push(chatRef);
    }
  }
  if (!unique.length) {
    throw new CodexReviewSourceError(
      'telegram requires an explicit chat selection',
      'codex-review-telegram-scope-required'
    );
  }
  return unique;
}

function createCodexReviewSources({ runHostJson, paths = DEFAULT_PATHS } = {}) {
  if (typeof runHostJson !== 'function') {
    throw new TypeError('Codex review sources require a host JSON runner');
  }
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };

  function configured(sourceId) {
    if (sourceId === 'work-gmail') return Boolean(resolvedPaths.python && resolvedPaths.gmail);
    if (sourceId === 'work-chat') return Boolean(resolvedPaths.python && resolvedPaths.chat);
    if (sourceId === 'telegram') return Boolean(resolvedPaths.telegram);
    if (sourceId === 'whatsapp') return Boolean(resolvedPaths.python && resolvedPaths.whatsapp);
    return false;
  }

  function requireConfigured(sourceId) {
    if (configured(sourceId)) return;
    throw new CodexReviewSourceError(
      `${sourceId} is not configured`,
      'codex-review-source-not-configured'
    );
  }

  async function invoke(file, args, source) {
    try {
      return sourcePayload(await runHostJson(file, args, { timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024 }), source);
    } catch (error) {
      if (error instanceof CodexReviewSourceError) throw error;
      throw new CodexReviewSourceError(
        `${source} could not be read`,
        typeof error?.code === 'string' && /^codex-review-[a-z0-9-]+$/.test(error.code)
          ? error.code
          : 'codex-review-source-unavailable'
      );
    }
  }

  async function collectGmail(since, until) {
    requireConfigured('work-gmail');
    const messages = [];
    let pageToken = null;
    let complete = true;
    let account = null;
    const after = Math.max(0, Math.floor(since.getTime() / 1_000) - 1);
    const before = Math.ceil(until.getTime() / 1_000) + 1;
    const query = `after:${after} before:${before} -in:spam -in:trash`;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const args = [resolvedPaths.gmail, 'search', '--query', query, '--max-results', String(GMAIL_PAGE_SIZE)];
      if (pageToken) args.push('--page-token', pageToken);
      const listing = await invoke(resolvedPaths.python, args, 'work-gmail');
      const listingAccount = compact(listing.account, 320).toLocaleLowerCase('en-US');
      if (!listingAccount) {
        throw new CodexReviewSourceError('work-gmail did not verify its account', 'codex-review-source-invalid');
      }
      if (account && account !== listingAccount) {
        throw new CodexReviewSourceError('work-gmail account changed during a scan', 'codex-review-source-invalid');
      }
      account = listingAccount;
      for (const summary of Array.isArray(listing.messages) ? listing.messages : []) {
        if (!summary || !inWindow(summary.date_utc, since, until) || !summary.message_id) continue;
        const detail = await invoke(resolvedPaths.python, [
          resolvedPaths.gmail, 'read-message', '--message-id', String(summary.message_id)
        ], 'work-gmail');
        const detailAccount = compact(detail.account, 320).toLocaleLowerCase('en-US');
        if (detailAccount !== account) {
          throw new CodexReviewSourceError('work-gmail account identity did not match', 'codex-review-source-invalid');
        }
        const message = detail.message && typeof detail.message === 'object' ? detail.message : summary;
        const labels = Array.isArray(message.labels) ? message.labels.map(String) : [];
        const from = compact(message.from, 1_000);
        const to = compact(message.to, 2_000).toLocaleLowerCase('en-US');
        const cc = compact(message.cc, 2_000).toLocaleLowerCase('en-US');
        const outgoing = labels.includes('SENT') || from.toLocaleLowerCase('en-US').includes(account);
        messages.push({
          source: 'work-gmail',
          messageKey: String(message.message_id || summary.message_id),
          conversationKey: String(message.thread_id || summary.thread_id || message.message_id || summary.message_id),
          occurredAt: new Date(message.date_utc || summary.date_utc).toISOString(),
          direction: outgoing ? 'outgoing' : 'incoming',
          sender: from,
          conversation: safeConversation(message.subject || summary.subject, 'E-posta'),
          subject: compact(message.subject || summary.subject, 500),
          text: compact(message.body || message.snippet || summary.snippet),
          direct: outgoing || to.includes(account),
          ccOnly: !outgoing && !to.includes(account) && cc.includes(account),
          noReply: /(?:^|[<@._-])no-?reply(?:[>@._-]|$)|(?:^|[<@._-])noreply(?:[>@._-]|$)/iu.test(from),
          chatKind: 'email',
          hasAttachment: Array.isArray(message.attachments) && message.attachments.length > 0,
          broadcast: labels.some((label) => ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'].includes(label)) &&
            !to.includes(account)
        });
      }
      pageToken = typeof listing.next_page_token === 'string' && listing.next_page_token
        ? listing.next_page_token
        : null;
      if (!pageToken) break;
      if (page === MAX_PAGES - 1) complete = false;
    }
    return { messages: uniqueMessages(messages), complete };
  }

  async function listChatSpaces() {
    requireConfigured('work-chat');
    const spaces = [];
    let pageToken = null;
    let complete = true;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const args = [resolvedPaths.chat, 'list-spaces', '--max-results', String(CHAT_PAGE_SIZE)];
      if (pageToken) args.push('--page-token', pageToken);
      const listing = await invoke(resolvedPaths.python, args, 'work-chat');
      spaces.push(...(Array.isArray(listing.spaces) ? listing.spaces : []));
      pageToken = typeof listing.next_page_token === 'string' && listing.next_page_token
        ? listing.next_page_token
        : null;
      if (!pageToken) break;
      if (page === MAX_PAGES - 1) complete = false;
    }
    return { spaces, complete };
  }

  async function collectChat(since, until, ownerAliases) {
    const catalog = await listChatSpaces();
    const messages = [];
    let complete = catalog.complete;
    const aliases = normalizedAliases(ownerAliases);
    for (const space of catalog.spaces) {
      if (!space || typeof space.space_name !== 'string') continue;
      let pageToken = null;
      let reachedCursor = false;
      for (let page = 0; page < MAX_PAGES && !reachedCursor; page += 1) {
        const args = [
          resolvedPaths.chat, 'list-messages', '--space-name', space.space_name,
          '--max-results', String(CHAT_PAGE_SIZE)
        ];
        if (pageToken) args.push('--page-token', pageToken);
        const listing = await invoke(resolvedPaths.python, args, 'work-chat');
        const pageMessages = Array.isArray(listing.messages) ? listing.messages : [];
        for (const message of pageMessages) {
          const occurredAt = message && message.created_at;
          if (!Number.isFinite(Date.parse(occurredAt))) continue;
          if (Date.parse(occurredAt) <= since.getTime()) {
            reachedCursor = true;
            continue;
          }
          if (!inWindow(occurredAt, since, until) || !message.message_name) continue;
          const sender = message.sender && message.sender.display_name;
          const outgoing = belongsToOwner(sender, aliases);
          const spaceType = String(space.space_type || '').toLocaleUpperCase('en-US');
          const direct = ['DIRECT_MESSAGE', 'DIRECT'].includes(spaceType);
          messages.push({
            source: 'work-chat',
            messageKey: String(message.message_name),
            conversationKey: space.space_name,
            occurredAt: new Date(occurredAt).toISOString(),
            direction: outgoing ? 'outgoing' : 'incoming',
            sender: compact(sender, 300),
            conversation: safeConversation(space.display_name, direct ? 'Özel sohbet' : 'Google Chat alanı'),
            subject: '',
            text: compact(message.text),
            direct,
            ccOnly: false,
            noReply: message.sender && message.sender.type === 'BOT',
            chatKind: direct ? 'direct' : 'group',
            hasAttachment: Array.isArray(message.attachments) && message.attachments.length > 0,
            broadcast: false
          });
        }
        pageToken = typeof listing.next_page_token === 'string' && listing.next_page_token
          ? listing.next_page_token
          : null;
        if (!pageToken) break;
        if (page === MAX_PAGES - 1 && !reachedCursor) complete = false;
      }
    }
    return { messages: uniqueMessages(messages), complete };
  }

  async function splitBoundedWindow({ since, until, fetchWindow, countFor, rowsFor, source, depth = 0 }) {
    const payload = await fetchWindow(since, until);
    const rows = rowsFor(payload);
    const count = countFor(payload);
    if (count <= rows.length) return { rows, complete: payload.complete !== false };
    const span = until.getTime() - since.getTime();
    if (depth >= MAX_WINDOW_DEPTH || span <= 1_000) {
      throw new CodexReviewSourceError(`${source} window exceeded the safe result cap`, 'codex-review-source-overflow');
    }
    const midpoint = new Date(since.getTime() + Math.floor(span / 2));
    const left = await splitBoundedWindow({ since, until: midpoint, fetchWindow, countFor, rowsFor, source, depth: depth + 1 });
    const right = await splitBoundedWindow({ since: midpoint, until, fetchWindow, countFor, rowsFor, source, depth: depth + 1 });
    return { rows: [...left.rows, ...right.rows], complete: left.complete && right.complete };
  }

  async function listTelegramChats() {
    requireConfigured('telegram');
    const payload = await invoke(resolvedPaths.telegram, [
      'list-chats', '--chat-type', 'all', '--limit', '200', '--dialog-limit', '500'
    ], 'telegram');
    const chats = [];
    const seen = new Set();
    for (const entry of Array.isArray(payload.chats) ? payload.chats : []) {
      const chatRef = compact(entry && entry.chat_ref, 100).toLocaleLowerCase('en-US');
      const kind = compact(entry && entry.kind, 20).toLocaleLowerCase('en-US');
      if (!TELEGRAM_CHAT_REF_PATTERN.test(chatRef) || !['direct', 'group'].includes(kind) || seen.has(chatRef)) {
        continue;
      }
      seen.add(chatRef);
      chats.push({
        chatRef,
        title: safeConversation(entry.title, kind === 'direct' ? 'Özel sohbet' : 'Grup'),
        kind
      });
    }
    return { chats };
  }

  async function collectTelegram(since, until, chatRefs) {
    requireConfigured('telegram');
    const selected = normalizedTelegramChatRefs(chatRefs);
    const rows = [];
    let complete = true;
    for (const chatRef of selected) {
      const fetchWindow = async (windowSince, windowUntil) => invoke(resolvedPaths.telegram, [
        'search', '--chat-ref', chatRef,
        '--since', windowSince.toISOString(), '--until', windowUntil.toISOString(),
        '--latest', '--top-k', '50', '--context', '0', '--max-messages', '25000',
        '--max-text-chars', '4000', '--output-char-budget', '200000'
      ], 'telegram');
      const bounded = await splitBoundedWindow({
        since,
        until,
        fetchWindow,
        source: 'telegram',
        countFor: (payload) => Number(payload.matched_messages) || 0,
        rowsFor: (payload) => Array.isArray(payload.results) ? payload.results : []
      });
      rows.push(...bounded.rows);
      complete = complete && bounded.complete;
    }
    const messages = [];
    for (const result of rows) {
      const chat = result && result.chat || {};
      for (const message of Array.isArray(result && result.messages) ? result.messages : []) {
        if (!message || message.is_anchor !== true || !inWindow(message.date, since, until)) continue;
        messages.push({
          source: 'telegram',
          messageKey: `${chat.chat_ref || 'chat'}:${message.message_id}:${message.date}`,
          conversationKey: String(chat.chat_ref || chat.title || 'telegram'),
          occurredAt: new Date(message.date).toISOString(),
          direction: message.direction === 'outgoing' ? 'outgoing' : 'incoming',
          sender: compact(message.sender, 300),
          conversation: safeConversation(chat.title, 'Telegram sohbeti'),
          subject: '',
          text: compact(message.text),
          direct: chat.kind === 'direct',
          ccOnly: false,
          noReply: false,
          chatKind: compact(chat.kind, 30) || 'unknown',
          hasAttachment: message.message_type && message.message_type !== 'text',
          broadcast: chat.kind === 'channel'
        });
      }
    }
    return { messages: uniqueMessages(messages), complete };
  }

  async function collectWhatsApp(since, until) {
    requireConfigured('whatsapp');
    const fetchWindow = async (windowSince, windowUntil) => {
      const payload = await invoke(resolvedPaths.python, [
        resolvedPaths.whatsapp, '--all-chats', '--chat-type', 'all',
        '--since', windowSince.toISOString(), '--until', windowUntil.toISOString(),
        '--latest', '--top-k', '20', '--context', '0', '--max-messages', '25000',
        '--max-text-chars', '4000', '--output-char-budget', '100000'
      ], 'whatsapp');
      const retrieval = payload.retrieval && typeof payload.retrieval === 'object' ? payload.retrieval : {};
      payload.complete = retrieval.output_budget_reached !== true &&
        Number(retrieval.raw_messages || 0) < Number(retrieval.max_messages || 25000);
      return payload;
    };
    const bounded = await splitBoundedWindow({
      since,
      until,
      fetchWindow,
      source: 'whatsapp',
      countFor: (payload) => Number(payload.retrieval && payload.retrieval.matching_messages) || 0,
      rowsFor: (payload) => Array.isArray(payload.results) ? payload.results : []
    });
    const messages = [];
    for (const result of bounded.rows) {
      const chat = result && result.chat || {};
      for (const message of Array.isArray(result && result.messages) ? result.messages : []) {
        if (!message || !inWindow(message.timestamp_utc, since, until)) continue;
        messages.push({
          source: 'whatsapp',
          messageKey: `${chat.chat_ref || 'chat'}:${message.message_id}:${message.timestamp_utc}`,
          conversationKey: String(chat.chat_ref || chat.name || 'whatsapp'),
          occurredAt: new Date(message.timestamp_utc).toISOString(),
          direction: message.direction === 'outgoing' ? 'outgoing' : 'incoming',
          sender: compact(message.sender, 300),
          conversation: safeConversation(chat.name, 'WhatsApp sohbeti'),
          subject: '',
          text: compact(message.text),
          direct: chat.kind === 'direct',
          ccOnly: false,
          noReply: false,
          chatKind: compact(chat.kind, 30) || 'unknown',
          hasAttachment: Boolean(message.message_type) &&
            !['conversation', 'extendedTextMessage'].includes(message.message_type),
          broadcast: !['direct', 'group'].includes(chat.kind)
        });
      }
    }
    return { messages: uniqueMessages(messages), complete: bounded.complete };
  }

  async function collect(sourceId, { since, until, ownerAliases = [], chatRefs = [] } = {}) {
    if (!SOURCE_IDS.includes(sourceId)) {
      throw new TypeError('Unsupported Codex review source');
    }
    const sinceDate = validDate(since, 'since');
    const untilDate = validDate(until, 'until');
    if (sinceDate >= untilDate) return { messages: [], complete: true };
    if (sourceId === 'work-gmail') return collectGmail(sinceDate, untilDate);
    if (sourceId === 'work-chat') return collectChat(sinceDate, untilDate, ownerAliases);
    if (sourceId === 'telegram') return collectTelegram(sinceDate, untilDate, chatRefs);
    return collectWhatsApp(sinceDate, untilDate);
  }

  return { collect, configured, listTelegramChats, sourceIds: [...SOURCE_IDS] };
}

module.exports = {
  CodexReviewSourceError,
  DEFAULT_PATHS,
  MAX_TELEGRAM_CHATS,
  SOURCE_IDS,
  createCodexReviewSources
};
