const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDockerClient } = require('./dockerClient');

test('bounded observability readers accept only exact container identities and non-streaming requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-docker-client-'));
  const socketPath = path.join(root, 'docker.sock');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith('/json')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ Id: 'a'.repeat(64), State: { Running: true } }));
      return;
    }
    if (request.url.includes('/stats?')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ read: '2026-08-15T10:00:00.000Z', cpu_stats: {} }));
      return;
    }
    if (request.url.includes('/logs?')) {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(Buffer.from('raw log\n'));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const client = createDockerClient(socketPath);
    const containerId = 'a'.repeat(64);
    assert.equal((await client.containerInspect(containerId)).State.Running, true);
    assert.equal((await client.containerStats(containerId)).read, '2026-08-15T10:00:00.000Z');
    assert.equal((await client.containerLogs(containerId, { tail: 125 })).toString(), 'raw log\n');
    assert.deepEqual(requests, [
      `/containers/${containerId}/json`,
      `/containers/${containerId}/stats?stream=false&one-shot=true`,
      `/containers/${containerId}/logs?stdout=1&stderr=1&timestamps=1&tail=125`
    ]);
    await assert.rejects(client.containerInspect('friendly-name'), /exact container ID/);
    await assert.rejects(client.containerInspect('a'.repeat(12)), /exact container ID/);
    await assert.rejects(client.containerLogs(containerId, { tail: 501 }), /safety limit/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
