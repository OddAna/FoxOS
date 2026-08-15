const assert = require('node:assert/strict');
const test = require('node:test');
const { createCodexReviewSources } = require('./codexReviewSources');

const PATHS = {
  python: '/runtime/python3',
  gmail: '/skills/gmail.py',
  chat: '/skills/chat.py',
  telegram: '/skills/telegram-search',
  whatsapp: '/skills/whatsapp.py'
};
const WINDOW = {
  since: '2026-08-13T12:00:00.000Z',
  until: '2026-08-13T12:10:00.000Z',
  ownerAliases: ['Deniz', 'Deniz Kaya']
};

test('source adapters normalize live helper responses without inventing message fields', async () => {
  const calls = [];
  const sources = createCodexReviewSources({
    paths: PATHS,
    async runHostJson(file, args) {
      calls.push({ file, args });
      if (args[0] === PATHS.gmail && args[1] === 'search') {
        return {
          account: 'owner@example.test',
          messages: [{
            message_id: 'gmail-1',
            thread_id: 'thread-1',
            date_utc: '2026-08-13T12:02:00.000Z',
            from: 'Müşteri <customer@example.test>',
            to: 'owner@example.test',
            subject: 'Teklif',
            snippet: 'Teklifi kontrol eder misin?'
          }],
          next_page_token: null
        };
      }
      if (args[0] === PATHS.gmail && args[1] === 'read-message') {
        return {
          account: 'owner@example.test',
          message: {
            message_id: 'gmail-1',
            thread_id: 'thread-1',
            date_utc: '2026-08-13T12:02:00.000Z',
            from: 'Müşteri <customer@example.test>',
            to: 'owner@example.test',
            cc: '',
            subject: 'Teklif',
            body: 'Teklifi kontrol eder misin?',
            labels: ['INBOX'],
            attachments: [{ filename: 'teklif.pdf' }]
          }
        };
      }
      if (args[0] === PATHS.chat && args[1] === 'list-spaces') {
        return {
          spaces: [{ space_name: 'spaces/one', display_name: 'Müşteri', space_type: 'DIRECT_MESSAGE' }],
          next_page_token: null
        };
      }
      if (args[0] === PATHS.chat && args[1] === 'list-messages') {
        return {
          messages: [{
            message_name: 'spaces/one/messages/one',
            created_at: '2026-08-13T12:03:00.000Z',
            sender: { display_name: 'Deniz Kaya', type: 'HUMAN' },
            text: 'Ben kontrol edeceğim.',
            attachments: []
          }],
          next_page_token: null
        };
      }
      if (file === PATHS.telegram) {
        return {
          ok: true,
          complete: true,
          matched_messages: 1,
          results: [{
            chat: { chat_ref: 'tg_abc12345', title: 'Müşteri', kind: 'direct' },
            messages: [{
              is_anchor: true,
              message_id: 42,
              date: '2026-08-13T12:04:00.000Z',
              direction: 'incoming',
              sender: 'Müşteri',
              message_type: 'text',
              text: 'Durum nedir?'
            }]
          }]
        };
      }
      if (args[0] === PATHS.whatsapp) {
        return {
          ok: true,
          retrieval: {
            raw_messages: 1,
            matching_messages: 1,
            max_messages: 25000,
            output_budget_reached: false
          },
          results: [{
            chat: { chat_ref: 'def456', name: 'Proje', kind: 'group' },
            messages: [{
              message_id: 'wa-1',
              timestamp_utc: '2026-08-13T12:05:00.000Z',
              direction: 'incoming',
              sender: 'Müşteri',
              message_type: 'extendedTextMessage',
              text: '@Deniz raporu kontrol eder misin?'
            }]
          }]
        };
      }
      throw new Error(`Unexpected helper call: ${file} ${args.join(' ')}`);
    }
  });

  const gmail = await sources.collect('work-gmail', WINDOW);
  assert.equal(gmail.complete, true);
  assert.equal(gmail.messages.length, 1);
  assert.equal(gmail.messages[0].direction, 'incoming');
  assert.equal(gmail.messages[0].direct, true);
  assert.equal(gmail.messages[0].ccOnly, false);
  assert.equal(gmail.messages[0].hasAttachment, true);

  const chat = await sources.collect('work-chat', WINDOW);
  assert.equal(chat.messages[0].direction, 'outgoing');
  assert.equal(chat.messages[0].direct, true);

  const telegram = await sources.collect('telegram', { ...WINDOW, chatRefs: ['tg_abc12345'] });
  assert.equal(telegram.messages[0].messageKey, 'tg_abc12345:42:2026-08-13T12:04:00.000Z');
  assert.equal(telegram.messages[0].direct, true);
  assert.equal(telegram.messages[0].hasAttachment, false);

  const whatsapp = await sources.collect('whatsapp', WINDOW);
  assert.equal(whatsapp.messages[0].conversationKey, 'def456');
  assert.equal(whatsapp.messages[0].direct, false);
  assert.equal(whatsapp.messages[0].hasAttachment, false);

  const gmailSearch = calls.find((call) => call.args[0] === PATHS.gmail && call.args[1] === 'search');
  assert.equal(gmailSearch.args[gmailSearch.args.indexOf('--max-results') + 1], '50');
  const whatsappSearch = calls.find((call) => call.args[0] === PATHS.whatsapp);
  assert.equal(whatsappSearch.args[whatsappSearch.args.indexOf('--top-k') + 1], '20');
  assert.equal(whatsappSearch.args[whatsappSearch.args.indexOf('--output-char-budget') + 1], '100000');
  assert.equal(calls.every((call) => !call.args.includes('send') && !call.args.includes('mark-read')), true);
  const telegramSearch = calls.find((call) => call.file === PATHS.telegram);
  assert.equal(telegramSearch.args.includes('--all-chats'), false);
  assert.equal(telegramSearch.args[telegramSearch.args.indexOf('--chat-ref') + 1], 'tg_abc12345');
});

test('telegram exposes a safe chat catalog and refuses all-chat collection', async () => {
  const calls = [];
  const sources = createCodexReviewSources({
    paths: PATHS,
    async runHostJson(file, args) {
      calls.push({ file, args });
      return {
        ok: true,
        chats: [
          { chat_ref: 'tg_customer1', title: 'Müşteri Ekibi', kind: 'group', account_ref: 'private-account' },
          { chat_ref: 'tg_person001', title: 'Müşteri', kind: 'direct', account_ref: 'private-account' },
          { chat_ref: 'tg_channel01', title: 'Haber Kanalı', kind: 'channel', account_ref: 'private-account' },
          { chat_ref: 'invalid', title: 'Geçersiz', kind: 'group' }
        ]
      };
    }
  });

  const catalog = await sources.listTelegramChats();
  assert.deepEqual(catalog.chats, [
    { chatRef: 'tg_customer1', title: 'Müşteri Ekibi', kind: 'group' },
    { chatRef: 'tg_person001', title: 'Müşteri', kind: 'direct' }
  ]);
  assert.equal(calls[0].args.includes('--all-chats'), false);
  await assert.rejects(
    sources.collect('telegram', WINDOW),
    (error) => error.code === 'codex-review-telegram-scope-required'
  );
});

test('source adapters reject unsupported sources and preserve exclusive cursor boundaries', async () => {
  const sources = createCodexReviewSources({
    paths: PATHS,
    async runHostJson(file, args) {
      if (args[0] === PATHS.gmail && args[1] === 'search') {
        return {
          account: 'owner@example.test',
          messages: [{
            message_id: 'at-cursor',
            thread_id: 'thread',
            date_utc: WINDOW.since,
            from: 'Müşteri',
            to: 'owner@example.test',
            subject: 'Eski'
          }],
          next_page_token: null
        };
      }
      throw new Error('A cursor-bound message must not be read in detail');
    }
  });
  const result = await sources.collect('work-gmail', WINDOW);
  assert.deepEqual(result.messages, []);
  await assert.rejects(
    sources.collect('legacy-clickup', WINDOW),
    (error) => error instanceof TypeError && /Unsupported/.test(error.message)
  );
});
