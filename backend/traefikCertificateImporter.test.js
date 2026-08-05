const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTraefikCertificateImporter } = require('./traefikCertificateImporter');

// The importer is integration-proven against real Let's Encrypt storage. Unit tests keep the
// filesystem and Docker boundary fail-closed without embedding a private-key fixture in Git.
test('rejects a proxy without a writable Traefik storage mount', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-cert-import-'));
  const manager = createTraefikCertificateImporter({
    dataRoot: path.join(root, 'data'),
    hostRoot: path.join(root, 'host'),
    dockerRequest: async () => ({ Id: 'a'.repeat(64), Mounts: [] })
  });
  await assert.rejects(
    manager.importDomain({ domain: 'app.example.com', proxyContainerId: 'a'.repeat(64) }),
    (error) => error.code === 'traefik-acme-storage-unavailable'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects invalid identities before reading Docker or certificate files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-cert-import-'));
  let calls = 0;
  const manager = createTraefikCertificateImporter({
    dataRoot: path.join(root, 'data'),
    hostRoot: path.join(root, 'host'),
    dockerRequest: async () => { calls += 1; return {}; }
  });
  await assert.rejects(
    manager.importDomain({ domain: '../example.com', proxyContainerId: crypto.randomUUID() }),
    (error) => error.code === 'invalid-certificate-import'
  );
  assert.equal(calls, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
