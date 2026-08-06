const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHostServiceDiscovery } = require('./hostServiceDiscovery');

test('host discovery finds configured WireGuard and direct administrator systemd units without reading config contents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-host-discovery-'));
  try {
    fs.mkdirSync(path.join(root, 'etc', 'systemd', 'system'), { recursive: true });
    fs.mkdirSync(path.join(root, 'etc', 'wireguard'), { recursive: true });
    fs.writeFileSync(path.join(root, 'etc', 'systemd', 'system', 'custom-worker.service'), '[Service]\nEnvironment=SECRET=hidden\n');
    fs.writeFileSync(path.join(root, 'etc', 'wireguard', 'wg0.conf'), 'PrivateKey = never-read-this\n');
    const outputs = {
      'systemd-unit-files': 'custom-worker.service enabled enabled\nwg-quick@.service indirect enabled\nwg-quick@wg0.service enabled enabled\n',
      'systemd-units': 'custom-worker.service loaded inactive dead Custom worker\nwg-quick@wg0.service loaded active exited WireGuard via wg-quick\n',
      'wireguard-interfaces': 'wg0\n',
      'wireguard-version': 'wireguard-tools v1.0.20210914\n'
    };
    const discovery = await createHostServiceDiscovery({
      hostRoot: root,
      hostRead: async (operation) => ({ success: true, output: outputs[operation] })
    });
    assert.equal(discovery.resources.length, 2);
    const wireguard = discovery.resources.find((resource) => resource.serviceType === 'wireguard');
    assert.equal(wireguard.name, 'WireGuard (wg0)');
    assert.equal(wireguard.runtime.state, 'running');
    assert.equal(wireguard.runtime.unitFileState, 'enabled');
    assert.deepEqual(wireguard.configuration, {
      interface: 'wg0',
      filePresent: true,
      contentsRead: false
    });
    const worker = discovery.resources.find((resource) => resource.name === 'custom-worker');
    assert.equal(worker.runtime.state, 'stopped');
    assert.equal(JSON.stringify(discovery).includes('never-read-this'), false);
    assert.equal(JSON.stringify(discovery).includes('SECRET=hidden'), false);
    assert.equal(discovery.guarantees.wireGuardKeysIncluded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
