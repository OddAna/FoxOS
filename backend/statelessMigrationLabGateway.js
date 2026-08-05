const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { spawnSync } = require('node:child_process');

const TLS_PORT = 8443;
const CONTROL_PORT = 9090;
const MAX_BODY_BYTES = 64 * 1024;
const ROUTE_HEADER = 'x-foxos-route';
const TARGET_HEADER = 'x-foxos-lab-target';

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function labConfiguration() {
  const domain = String(process.env.FOXOS_STATELESS_LAB_DOMAIN || '').toLowerCase();
  const routePath = String(process.env.FOXOS_STATELESS_LAB_PATH || '');
  const routeName = String(process.env.FOXOS_STATELESS_LAB_ROUTE || '');
  const sourceHost = String(process.env.FOXOS_STATELESS_LAB_SOURCE_HOST || '');
  const candidateHost = String(process.env.FOXOS_STATELESS_LAB_CANDIDATE_HOST || '');
  const sourceIdentity = String(process.env.FOXOS_STATELESS_LAB_SOURCE_IDENTITY || '');
  const candidateIdentity = String(process.env.FOXOS_STATELESS_LAB_CANDIDATE_IDENTITY || '');
  if (!/^[a-z0-9][a-z0-9.-]{1,120}\.invalid$/.test(domain)) fail('Disposable lab TLS domain is invalid');
  if (!/^\/_foxos\/migrations\/stateless-lab\/[a-f0-9]{12}\/$/.test(routePath)) {
    fail('Disposable lab route path is invalid');
  }
  if (!/^foxos-stateless-lab-[a-f0-9]{12}$/.test(routeName)) fail('Disposable lab route name is invalid');
  if (!/^foxos-stateless-lab-source-[a-f0-9]{12}$/.test(sourceHost)) fail('Disposable source host is invalid');
  if (!/^foxos-stateless-lab-candidate-[a-f0-9]{12}$/.test(candidateHost)) {
    fail('Disposable candidate host is invalid');
  }
  if (sourceIdentity !== sourceHost || candidateIdentity !== candidateHost) {
    fail('Disposable lab identity contract is invalid');
  }
  return { domain, routePath, routeName, sourceHost, candidateHost, sourceIdentity, candidateIdentity };
}

function generateCertificate(domain) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-stateless-lab-tls-'));
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=' + domain,
    '-addext', 'subjectAltName=DNS:' + domain,
    '-addext', 'keyUsage=digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth'
  ], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 256 * 1024
  });
  if (result.status !== 0) fail('Disposable TLS certificate generation failed');
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);
  fs.rmSync(directory, { recursive: true, force: true });
  const parsed = new crypto.X509Certificate(cert);
  if (parsed.checkHost(domain) !== domain) fail('Disposable TLS hostname proof failed');
  return { key, cert, fingerprint256: parsed.fingerprint256 };
}

function jsonResponse(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  response.end(body);
}

function controlRequest(action) {
  const paths = {
    status: ['GET', '/status'],
    source: ['POST', '/target/source'],
    candidate: ['POST', '/target/candidate'],
    'candidate-with-fault': ['POST', '/target/candidate-with-fault']
  };
  const selected = paths[action];
  if (!selected) fail('Disposable lab gateway control action is invalid');
  const [method, requestPath] = selected;
  const request = http.request({
    host: '127.0.0.1',
    port: CONTROL_PORT,
    path: requestPath,
    method,
    timeout: 5000
  }, (response) => {
    const chunks = [];
    let received = 0;
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) response.destroy();
      else chunks.push(chunk);
    });
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (response.statusCode < 200 || response.statusCode >= 300) fail('Disposable gateway control failed');
      process.stdout.write(body + '\n');
    });
  });
  request.on('timeout', () => request.destroy(new Error('control timeout')));
  request.on('error', () => fail('Disposable gateway control request failed'));
  request.end();
}

function serve() {
  const config = labConfiguration();
  const certificate = generateCertificate(config.domain);
  const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  let target = 'source';
  let unavailableOnce = 0;
  let shuttingDown = false;
  let monitorTimer = null;
  const stats = {
    samples: 0,
    unavailableSamples: 0,
    tlsFailures: 0,
    identityFailures: 0,
    sourceSamples: 0,
    candidateSamples: 0,
    lastStatusCode: null,
    lastTarget: null,
    lastIdentity: null,
    startedAt: new Date().toISOString(),
    switchedAt: null
  };

  const expectedIdentity = () => target === 'source' ? config.sourceIdentity : config.candidateIdentity;

  const tlsServer = https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    if (request.method !== 'GET' || request.url !== config.routePath) {
      response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('not found\n');
      return;
    }
    const selectedTarget = target;
    if (unavailableOnce > 0) {
      unavailableOnce -= 1;
      response.writeHead(503, {
        'content-type': 'text/plain',
        [ROUTE_HEADER]: config.routeName,
        [TARGET_HEADER]: selectedTarget,
        'cache-control': 'no-store'
      });
      response.end('disposable injected unavailable sample\n');
      return;
    }
    const upstreamHost = selectedTarget === 'source' ? config.sourceHost : config.candidateHost;
    const upstream = http.request({
      host: upstreamHost,
      port: 80,
      path: '/',
      method: 'GET',
      timeout: 3000,
      agent: upstreamAgent,
      headers: { 'user-agent': 'FoxOS-stateless-lab-gateway/1' }
    }, (upstreamResponse) => {
      const chunks = [];
      let received = 0;
      upstreamResponse.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) upstreamResponse.destroy();
        else chunks.push(chunk);
      });
      upstreamResponse.on('end', () => {
        const body = Buffer.concat(chunks);
        response.writeHead(upstreamResponse.statusCode || 502, {
          'content-type': 'text/plain',
          'content-length': body.length,
          [ROUTE_HEADER]: config.routeName,
          [TARGET_HEADER]: selectedTarget,
          'cache-control': 'no-store'
        });
        response.end(body);
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, {
        'content-type': 'text/plain',
        [ROUTE_HEADER]: config.routeName,
        [TARGET_HEADER]: selectedTarget,
        'cache-control': 'no-store'
      });
      response.end('upstream unavailable\n');
    });
    upstream.end();
  });

  function monitorSample() {
    if (shuttingDown) return;
    const selectedTarget = target;
    const expected = expectedIdentity();
    const request = https.request({
      hostname: '127.0.0.1',
      port: TLS_PORT,
      path: config.routePath,
      method: 'GET',
      servername: config.domain,
      rejectUnauthorized: false,
      timeout: 2500,
      headers: { host: config.domain }
    }, (response) => {
      const peer = response.socket.getPeerCertificate(true);
      const fingerprintMatches = peer && peer.fingerprint256 === certificate.fingerprint256;
      const hostnameValid = peer && !tls.checkServerIdentity(config.domain, peer);
      const tlsValid = Boolean(fingerprintMatches && hostnameValid && response.socket.encrypted);
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) response.destroy();
        else chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const routeMatches = response.headers[ROUTE_HEADER] === config.routeName;
        const targetMatches = response.headers[TARGET_HEADER] === selectedTarget;
        const identityMatches = body.includes('Hostname: ' + expected);
        const available = response.statusCode === 200 && tlsValid && routeMatches && targetMatches && identityMatches;
        stats.samples += 1;
        stats.lastStatusCode = response.statusCode || null;
        stats.lastTarget = selectedTarget;
        stats.lastIdentity = identityMatches ? expected : null;
        if (!tlsValid) stats.tlsFailures += 1;
        if (!identityMatches) stats.identityFailures += 1;
        if (!available) stats.unavailableSamples += 1;
        else if (selectedTarget === 'source') stats.sourceSamples += 1;
        else stats.candidateSamples += 1;
        monitorTimer = setTimeout(monitorSample, 10);
      });
    });
    request.on('timeout', () => request.destroy(new Error('monitor timeout')));
    request.on('error', () => {
      stats.samples += 1;
      stats.unavailableSamples += 1;
      stats.lastStatusCode = null;
      stats.lastTarget = selectedTarget;
      stats.lastIdentity = null;
      monitorTimer = setTimeout(monitorSample, 10);
    });
    request.end();
  }

  const controlServer = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/status') {
      jsonResponse(response, 200, {
        target,
        domain: config.domain,
        path: config.routePath,
        routeName: config.routeName,
        tls: {
          mode: 'operation-pinned-self-signed',
          fingerprint256: certificate.fingerprint256,
          hostnameVerified: true
        },
        stats: { ...stats }
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/target/source') {
      target = 'source';
      jsonResponse(response, 200, { switched: true, target });
      return;
    }
    if (request.method === 'POST' && request.url === '/target/candidate') {
      target = 'candidate';
      stats.switchedAt = new Date().toISOString();
      jsonResponse(response, 200, { switched: true, target });
      return;
    }
    if (request.method === 'POST' && request.url === '/target/candidate-with-fault') {
      target = 'candidate';
      unavailableOnce += 1;
      stats.switchedAt = new Date().toISOString();
      jsonResponse(response, 200, { switched: true, target, faultInjected: true });
      return;
    }
    jsonResponse(response, 404, { error: 'not-found' });
  });

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (monitorTimer) clearTimeout(monitorTimer);
    upstreamAgent.destroy();
    controlServer.close();
    tlsServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
    tlsServer.listen(TLS_PORT, '0.0.0.0', () => {
      process.stdout.write('FOXOS_STATELESS_LAB_GATEWAY_READY ' + JSON.stringify({
        domain: config.domain,
        path: config.routePath,
        routeName: config.routeName,
        tlsPort: TLS_PORT,
        controlPort: CONTROL_PORT,
        fingerprint256: certificate.fingerprint256
      }) + '\n');
      monitorSample();
    });
  });
}

const [mode, action] = process.argv.slice(2);
if (mode === 'control') controlRequest(action || 'status');
else if (!mode || mode === 'serve') serve();
else fail('Disposable lab gateway mode is invalid');
