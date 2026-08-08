const assert = require('node:assert/strict');
const test = require('node:test');
const {
  HostServiceError,
  bootEnabled,
  createHostServiceManager
} = require('./hostServiceManager');

function hostResource(overrides = {}) {
  return {
    id: 'res_' + 'a'.repeat(32),
    kind: 'host-service',
    provider: 'linux-host',
    runtime: {
      unit: 'example.service',
      state: 'stopped',
      status: 'inactive:dead',
      activeState: 'inactive',
      subState: 'dead',
      unitFileState: 'disabled'
    },
    ...overrides
  };
}

test('boot enabled recognizes only systemd enabled states', () => {
  assert.equal(bootEnabled({ unitFileState: 'enabled' }), true);
  assert.equal(bootEnabled({ unitFileState: 'enabled-runtime' }), true);
  assert.equal(bootEnabled({ unitFileState: 'disabled' }), false);
  assert.equal(bootEnabled({ unitFileState: 'static' }), false);
});

test('host lifecycle resolves the unit from registry and refreshes observed state', async () => {
  let current = hostResource();
  const commands = [];
  let scans = 0;
  const manager = createHostServiceManager({
    resourceRegistry: {
      getLatest: () => ({ resources: [current] }),
      scan: async () => {
        scans += 1;
        current = hostResource({
          runtime: {
            ...current.runtime,
            state: 'running',
            status: 'active:running',
            activeState: 'active',
            subState: 'running'
          }
        });
      }
    },
    hostCommand: async (action, unit) => {
      commands.push([action, unit]);
      return { success: true, output: '' };
    }
  });

  const result = await manager.lifecycle(current.id, 'start');
  assert.deepEqual(commands, [['start', 'example.service']]);
  assert.equal(scans, 1);
  assert.equal(result.settings.state, 'running');
  assert.equal(result.settings.serverOwned, true);
});

test('host boot state uses fixed enable/disable commands and never accepts a client unit', async () => {
  let current = hostResource();
  const commands = [];
  const manager = createHostServiceManager({
    resourceRegistry: {
      getLatest: () => ({ resources: [current] }),
      scan: async () => {
        current = hostResource({ runtime: { ...current.runtime, unitFileState: 'enabled' } });
      }
    },
    hostCommand: async (action, unit) => {
      commands.push([action, unit]);
      return { success: true, output: '' };
    }
  });

  const result = await manager.setBootState(current.id, 'enabled');
  assert.deepEqual(commands, [['enable', 'example.service']]);
  assert.equal(result.settings.bootEnabled, true);
  await assert.rejects(
    () => manager.setBootState(current.id, 'enable --now attacker.service'),
    (error) => error instanceof HostServiceError && error.code === 'invalid-host-service-boot-state'
  );
});

test('host manager rejects non-host resources and command failures', async () => {
  let current = hostResource({ kind: 'container' });
  const manager = createHostServiceManager({
    resourceRegistry: {
      getLatest: () => ({ resources: [current] }),
      scan: async () => {}
    },
    hostCommand: async () => ({ success: false, output: 'redacted' })
  });
  await assert.rejects(
    () => manager.lifecycle(current.id, 'start'),
    (error) => error.code === 'host-service-not-found'
  );

  current = hostResource();
  await assert.rejects(
    () => manager.lifecycle(current.id, 'start'),
    (error) => error.code === 'host-service-command-failed' && !error.message.includes('redacted')
  );
});
