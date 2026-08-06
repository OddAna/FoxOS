const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptionStore } = require('./encryptionStore');
const {
  DISCONNECT_CONFIRMATION,
  createCloudflareConnectionManager
} = require('./cloudflareConnectionManager');

const TOKEN = 'cloudflare-token-value-with-safe-length-123456';
const ZONE_ID = 'a'.repeat(32);
const A_RECORD_ID = 'b'.repeat(32);
const AAAA_RECORD_ID = 'c'.repeat(32);
const CREATED_RECORD_ID = 'd'.repeat(32);
const PUBLIC_IPV4 = '93.184.216.34';

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-cloudflare-test-'));
  const calls = [];
  let records = (options.records || []).map((record) => ({ ttl: 1, proxied: false, ...record }));
  let createCounter = 0;

  async function apiRequest(call) {
    calls.push(JSON.parse(JSON.stringify({ ...call, token: call.token ? '<redacted>' : null })));
    assert.equal(call.token, TOKEN);
    if (call.apiPath === '/user/tokens/verify') {
      return { success: true, result: { id: 'token-id', status: 'active' } };
    }
    if (call.apiPath === '/zones') {
      return { success: true, result: [{ id: ZONE_ID, name: 'example.com', status: 'active' }] };
    }
    if (call.apiPath === `/zones/${ZONE_ID}/dns_records` && call.method === 'GET') {
      const name = call.query && call.query.name;
      return { success: true, result: name ? records.filter((record) => record.name === name) : records.slice(0, 1) };
    }
    if (call.apiPath === `/zones/${ZONE_ID}/dns_records` && call.method === 'POST') {
      createCounter += 1;
      const record = {
        id: createCounter === 1 ? CREATED_RECORD_ID : (createCounter.toString(16).padStart(32, 'e')).slice(0, 32),
        ...call.body
      };
      records.push(record);
      return { success: true, result: record };
    }
    const recordPath = new RegExp(`^/zones/${ZONE_ID}/dns_records/([a-f0-9]{32})$`).exec(call.apiPath);
    if (recordPath && call.method === 'PATCH') {
      const index = records.findIndex((record) => record.id === recordPath[1]);
      assert.notEqual(index, -1);
      records[index] = { id: recordPath[1], ...call.body };
      return { success: true, result: records[index] };
    }
    if (recordPath && call.method === 'DELETE') {
      const index = records.findIndex((record) => record.id === recordPath[1]);
      assert.notEqual(index, -1);
      records.splice(index, 1);
      return { success: true, result: { id: recordPath[1] } };
    }
    throw new Error(`Unexpected Cloudflare API call: ${call.method} ${call.apiPath}`);
  }

  const manager = createCloudflareConnectionManager({
    dataRoot: root,
    encryptionStore: createEncryptionStore({ dataRoot: root }),
    apiRequest,
    detectPublicIpv4: async () => PUBLIC_IPV4,
    clock: () => new Date('2026-08-06T20:00:00.000Z')
  });

  return {
    calls,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    manager,
    records: () => records,
    root
  };
}

test('connection verifies token and zone access, encrypts the token and returns only safe status', async (t) => {
  const fixture = harness();
  t.after(fixture.cleanup);

  const status = await fixture.manager.configure({ apiToken: TOKEN, publicIpv4: '8.8.8.8' });
  assert.equal(status.connected, true);
  assert.equal(status.ready, true);
  assert.deepEqual(status.zones, ['example.com']);
  assert.equal(status.publicIpv4, PUBLIC_IPV4);
  assert.equal(status.tokenIncluded, false);
  assert.equal(status.tokenStoredEncrypted, true);
  assert.deepEqual(status.permissions, ['Zone Read', 'DNS Edit']);
  assert.equal(fs.statSync(fixture.manager.paths.credentialsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fixture.manager.paths.configFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(fixture.manager.paths.credentialsFile).includes(Buffer.from(TOKEN)), false);
  assert.equal(fs.readFileSync(fixture.manager.paths.configFile, 'utf8').includes(TOKEN), false);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);

  await assert.rejects(
    async () => fixture.manager.disconnect('DISCONNECT SOMETHING ELSE'),
    { code: 'cloudflare-disconnect-confirmation-invalid' }
  );
  const disconnected = fixture.manager.disconnect(DISCONNECT_CONFIRMATION);
  assert.equal(disconnected.connection.connected, false);
  assert.equal(disconnected.dnsRecordsPreserved, true);
  assert.equal(fs.existsSync(fixture.manager.paths.credentialsFile), false);
});

test('DNS planning is read-only and confirmed apply creates A, removes AAAA and rolls back exactly', async (t) => {
  const fixture = harness({
    records: [{
      id: AAAA_RECORD_ID,
      type: 'AAAA',
      name: 'app.example.com',
      content: '2001:4860:4860::8888'
    }]
  });
  t.after(fixture.cleanup);
  await fixture.manager.configure({ apiToken: TOKEN });
  const writesBeforePlan = fixture.calls.filter((call) => ['POST', 'PATCH', 'DELETE'].includes(call.method)).length;

  const plan = await fixture.manager.planDns('app.example.com');
  assert.equal(plan.action, 'create');
  assert.equal(plan.mutationRequired, true);
  assert.equal(plan.removesIpv6, 1);
  assert.equal(fixture.calls.filter((call) => ['POST', 'PATCH', 'DELETE'].includes(call.method)).length, writesBeforePlan);

  const receipt = await fixture.manager.applyDnsPlan(plan);
  assert.equal(receipt.aAction, 'create');
  assert.equal(receipt.removedAAAA.length, 1);
  assert.deepEqual(
    fixture.records().map((record) => [record.type, record.name, record.content, record.proxied]),
    [['A', 'app.example.com', PUBLIC_IPV4, false]]
  );

  await fixture.manager.prepareRollback(receipt);
  const rollback = await fixture.manager.rollbackDnsChange(receipt);
  assert.equal(rollback.restored, true);
  assert.equal(rollback.restoredAAAA, 1);
  assert.deepEqual(
    fixture.records().map((record) => [record.type, record.name, record.content]),
    [['AAAA', 'app.example.com', '2001:4860:4860::8888']]
  );
});

test('a wrong or proxied A record is updated only after apply and exact rollback restores it', async (t) => {
  const fixture = harness({
    records: [{
      id: A_RECORD_ID,
      type: 'A',
      name: 'app.example.com',
      content: '8.8.8.8',
      proxied: true,
      ttl: 120,
      comment: 'existing record'
    }]
  });
  t.after(fixture.cleanup);
  await fixture.manager.configure({ apiToken: TOKEN });

  const plan = await fixture.manager.planDns('app.example.com');
  assert.equal(plan.action, 'update');
  assert.equal(fixture.records()[0].content, '8.8.8.8');
  const receipt = await fixture.manager.applyDnsPlan(plan);
  assert.equal(fixture.records()[0].content, PUBLIC_IPV4);
  assert.equal(fixture.records()[0].proxied, false);

  await fixture.manager.rollbackDnsChange(receipt);
  assert.equal(fixture.records()[0].id, A_RECORD_ID);
  assert.equal(fixture.records()[0].content, '8.8.8.8');
  assert.equal(fixture.records()[0].proxied, true);
  assert.equal(fixture.records()[0].ttl, 120);
  assert.equal(fixture.records()[0].comment, 'existing record');
});

test('CNAME, ambiguous A and post-plan drift fail closed before mutation', async (t) => {
  const cname = harness({
    records: [{ id: A_RECORD_ID, type: 'CNAME', name: 'app.example.com', content: 'target.example.net' }]
  });
  t.after(cname.cleanup);
  await cname.manager.configure({ apiToken: TOKEN });
  await assert.rejects(cname.manager.planDns('app.example.com'), { code: 'cloudflare-cname-conflict' });

  const ambiguous = harness({
    records: [
      { id: A_RECORD_ID, type: 'A', name: 'app.example.com', content: '8.8.8.8' },
      { id: CREATED_RECORD_ID, type: 'A', name: 'app.example.com', content: '1.1.1.1' }
    ]
  });
  t.after(ambiguous.cleanup);
  await ambiguous.manager.configure({ apiToken: TOKEN });
  await assert.rejects(ambiguous.manager.planDns('app.example.com'), { code: 'cloudflare-a-record-ambiguous' });

  const drift = harness();
  t.after(drift.cleanup);
  await drift.manager.configure({ apiToken: TOKEN });
  const plan = await drift.manager.planDns('app.example.com');
  drift.records().push({ id: A_RECORD_ID, type: 'A', name: 'app.example.com', content: '8.8.8.8', ttl: 1, proxied: false });
  await assert.rejects(drift.manager.applyDnsPlan(plan), { code: 'cloudflare-dns-plan-stale' });
});

test('rollback refuses to overwrite a DNS record changed after the FoxOS operation', async (t) => {
  const fixture = harness();
  t.after(fixture.cleanup);
  await fixture.manager.configure({ apiToken: TOKEN });
  const receipt = await fixture.manager.applyDnsPlan(await fixture.manager.planDns('app.example.com'));
  fixture.records()[0].content = '8.8.4.4';

  await assert.rejects(
    fixture.manager.rollbackDnsChange(receipt),
    { code: 'cloudflare-dns-rollback-drift' }
  );
  assert.equal(fixture.records()[0].content, '8.8.4.4');
});
