const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { adapterStatus } = require('./statelessMigrationManager');
const {
  createProductionStatelessMigrationAdapter,
  dependencyFromValue,
  rewriteEnvironmentDependencies
} = require('./productionStatelessMigrationAdapter');

test('dependency discovery accepts known URL transports without retaining credentials', () => {
  assert.deepEqual(dependencyFromValue('postgres://user:secret@database:5432/app'), {
    hostname: 'database',
    port: 5432,
    protocol: 'postgres:'
  });
  assert.equal(dependencyFromValue('not-a-url'), null);
  assert.equal(dependencyFromValue('file:///tmp/data'), null);
});

test('dependency URLs are rewritten in memory to operation-scoped bridge aliases', () => {
  const value = 'postgres://user:secret@database:5432/app?sslmode=disable';
  const rewritten = rewriteEnvironmentDependencies(['DATABASE_URL=' + value, 'PUBLIC_URL=https://example.com'], [{
    hostname: 'database',
    port: 5432,
    bridgeAlias: 'foxos-dep-123456789012-abcdef12'
  }]);
  assert.deepEqual(rewritten, [
    'DATABASE_URL=postgres://user:secret@foxos-dep-123456789012-abcdef12:5432/app?sslmode=disable',
    'PUBLIC_URL=https://example.com'
  ]);
});

test('production adapter exposes every safe transaction capability and no destructive methods', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-adapter-'));
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest: async () => ({}),
    dockerExec: async () => ({ exitCode: 0 }),
    resourceRegistry: { getLatest: () => null },
    secretManager: {
      getEnvironmentRevision: () => null,
      resolveEnvironment: () => []
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      inspectOwnedInfrastructure: async () => ({}),
      stageRoutes: async () => []
    }
  });
  const status = adapterStatus(adapter, async () => ({ approved: true }));
  assert.equal(status.ready, true);
  assert.deepEqual(status.unsafeCapabilities, []);
  assert.equal(typeof adapter.stopSource, 'undefined');
  assert.equal(typeof adapter.detachProvider, 'undefined');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
