const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createCliUsageManager,
  normalizeAntigravityUsage,
  normalizeCodexRateLimits
} = require('./cliUsageManager');

test('Codex rate-limit snapshots become bounded remaining windows', () => {
  const windows = normalizeCodexRateLimits({
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1787206025 }
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: 'codex_bengalfox',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1787311976 },
        credits: { balance: 'must-not-leak' }
      },
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1787206025 }
      }
    }
  });

  assert.deepEqual(windows.map((window) => [window.group, window.period, window.remainingPercent]), [
    ['Codex', 'weekly', 85],
    ['GPT-5.3-Codex-Spark', 'weekly', 100]
  ]);
  assert.equal(windows[0].resetsAt, '2026-08-20T06:07:05.000Z');
  assert.equal(JSON.stringify(windows).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(windows).includes('bengalfox'), false);
});

test('Antigravity usage output keeps model families, remaining percentages and resets', () => {
  const windows = normalizeAntigravityUsage({
    response: [
      'Gemini Models\tWeekly Limit Remaining\t92%\t2026-08-16T19:48:09Z',
      'Gemini Models\tFive Hour Limit Remaining\t97%\t2026-08-14T13:14:22Z',
      'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-08-21T11:31:36Z',
      'malformed provider data'
    ].join('\n'),
    account: 'must-not-leak'
  });

  assert.deepEqual(windows.map((window) => [window.group, window.period, window.remainingPercent]), [
    ['Gemini modelleri', 'weekly', 92],
    ['Gemini modelleri', 'five-hour', 97],
    ['Claude ve GPT modelleri', 'weekly', 100]
  ]);
  assert.equal(windows[1].durationMinutes, 300);
  assert.equal(JSON.stringify(windows).includes('must-not-leak'), false);
});

test('CLI usage manager caches successful providers and isolates unavailable ones', async () => {
  let now = new Date('2026-08-14T12:00:00.000Z');
  let codexReads = 0;
  let antigravityReads = 0;
  const errors = [];
  const manager = createCliUsageManager({
    cacheTtlMs: 60_000,
    clock: () => now,
    onError: (provider, error) => errors.push([provider, error.message]),
    providers: [
      {
        id: 'codex',
        name: 'Codex',
        connection: async () => ({ installed: true, connected: true }),
        read: async () => {
          codexReads += 1;
          return { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300 } } };
        },
        normalize: normalizeCodexRateLimits
      },
      {
        id: 'antigravity-cli',
        name: 'Antigravity',
        connection: async () => ({ installed: true, connected: true }),
        read: async () => {
          antigravityReads += 1;
          throw new Error('private provider failure');
        },
        normalize: normalizeAntigravityUsage
      }
    ]
  });

  const first = await manager.status();
  const cached = await manager.status();
  assert.equal(first, cached);
  assert.equal(first.summary.minimumRemainingPercent, 75);
  assert.equal(first.summary.availableProviderCount, 1);
  assert.equal(first.providers[1].status, 'unavailable');
  assert.equal(JSON.stringify(first).includes('private provider failure'), false);
  assert.equal(codexReads, 1);
  assert.equal(antigravityReads, 1);

  now = new Date('2026-08-14T12:02:00.000Z');
  await manager.status();
  assert.equal(codexReads, 2);
  assert.equal(antigravityReads, 2);
  assert.deepEqual(errors.map(([provider]) => provider), ['antigravity-cli', 'antigravity-cli']);
});
