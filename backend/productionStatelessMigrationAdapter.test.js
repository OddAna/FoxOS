const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { adapterStatus } = require('./statelessMigrationManager');
const {
  capabilityProfileForStartup,
  createProductionStatelessMigrationAdapter,
  dependencyFromValue,
  environmentForStartup,
  immutableImageFallbackAllowed,
  routeForHealth,
  sourceHealthAccepted,
  startupContractFromImageDefaults,
  startupContractFromObservation,
  rewriteEnvironmentDependencies
} = require('./productionStatelessMigrationAdapter');

test('health routing uses the reviewed private port while Docker health remains the source gate', () => {
  const health = { privatePort: 8080, path: '/healthz' };
  const routes = [
    { routeId: 'other', upstreamPrivatePort: 9090, path: '/api' },
    { routeId: 'health', upstreamPrivatePort: 8080, path: '/' }
  ];
  assert.equal(routeForHealth(routes, health).routeId, 'health');
  assert.equal(sourceHealthAccepted({
    State: { Health: { Status: 'healthy' } }
  }, {
    runtime: { health: { configured: true } }
  }, {
    statusCode: 404,
    tlsValid: true
  }), true);
  assert.equal(sourceHealthAccepted({
    State: { Health: { Status: 'unhealthy' } }
  }, {
    runtime: { health: { configured: true } }
  }, {
    statusCode: 200,
    tlsValid: true
  }), false);
  assert.equal(sourceHealthAccepted({ State: {} }, {
    runtime: { health: { configured: false } }
  }, {
    statusCode: 302,
    tlsValid: true
  }), true);
});

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

test('Next process titles become an executable standalone runtime contract', () => {
  const startup = startupContractFromObservation({
    argv: ['next-server (v15.5.12)'],
    argvExecutable: false,
    executablePath: '/nix/store/example-node/bin/node',
    workingDirectory: '/app/.next/standalone',
    nextStandaloneServer: true
  });
  assert.deepEqual(startup, {
    kind: 'next-standalone-runtime',
    entrypoint: ['/nix/store/example-node/bin/node', 'server.js'],
    cmd: [],
    workingDirectory: '/app/.next/standalone'
  });
  assert.deepEqual(environmentForStartup([
    'PORT=3000',
    'HOSTNAME=source-container'
  ], startup), [
    'PORT=3000',
    'HOSTNAME=0.0.0.0'
  ]);
  assert.deepEqual(environmentForStartup(['PORT=3000'], startup), [
    'PORT=3000',
    'HOSTNAME=0.0.0.0'
  ]);
});

test('unresolvable process titles fail closed instead of becoming Docker entrypoints', () => {
  assert.equal(startupContractFromObservation({
    argv: ['custom process title'],
    argvExecutable: false,
    executablePath: '/usr/bin/node',
    workingDirectory: '/app',
    nextStandaloneServer: false
  }), null);
  assert.deepEqual(startupContractFromObservation({
    argv: ['node', 'server.js'],
    argvExecutable: true,
    executablePath: '/usr/bin/node',
    workingDirectory: '/app',
    nextStandaloneServer: false
  }), {
    kind: 'observed-process-argv',
    entrypoint: ['node', 'server.js'],
    cmd: [],
    workingDirectory: '/app'
  });
});

test('matching immutable image defaults provide a bounded provider-neutral startup contract', () => {
  const config = {
    Entrypoint: ['/bin/bash', '-l', '-c'],
    Cmd: ['test -n "$PORT" && nginx -c /assets/nginx.conf'],
    WorkingDir: '/app/',
    User: ''
  };
  assert.deepEqual(startupContractFromImageDefaults({
    sourceConfig: config,
    imageConfig: { ...config }
  }), {
    kind: 'immutable-image-defaults',
    entrypoint: ['/bin/bash', '-l', '-c'],
    cmd: ['test -n "$PORT" && nginx -c /assets/nginx.conf'],
    workingDirectory: '/app/'
  });
});

test('image-default startup fallback rejects provider overrides and unsafe arguments', () => {
  const imageConfig = {
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: ['nginx -g "daemon off;"'],
    WorkingDir: '/app',
    User: ''
  };
  assert.equal(startupContractFromImageDefaults({
    sourceConfig: { ...imageConfig, Cmd: ['provider-wrapper'] },
    imageConfig
  }), null);
  assert.equal(startupContractFromImageDefaults({
    sourceConfig: imageConfig,
    imageConfig: { ...imageConfig, Cmd: ['unsafe\ncommand'] }
  }), null);
  assert.equal(startupContractFromImageDefaults({
    sourceConfig: { ...imageConfig, User: 'root' },
    imageConfig
  }), null);
});

test('immutable image fallback stays closed for dependencies, mounts and runtime-user drift', () => {
  const imageId = 'sha256:' + '1'.repeat(64);
  const safe = {
    image: { Id: imageId },
    imageId,
    dependencies: [],
    runtime: { writableMounts: 0, user: null },
    sourceConfig: { User: '' }
  };
  assert.equal(immutableImageFallbackAllowed(safe), true);
  assert.equal(immutableImageFallbackAllowed({ ...safe, dependencies: [{ hostname: 'database' }] }), false);
  assert.equal(immutableImageFallbackAllowed({
    ...safe,
    runtime: { ...safe.runtime, writableMounts: 1 }
  }), false);
  assert.equal(immutableImageFallbackAllowed({
    ...safe,
    runtime: { ...safe.runtime, user: '1000' }
  }), false);
  assert.equal(immutableImageFallbackAllowed({
    ...safe,
    image: { Id: 'sha256:' + '2'.repeat(64) }
  }), false);
});

test('immutable root bootstrap receives only local identity capabilities', () => {
  assert.deepEqual(capabilityProfileForStartup({
    startup: { kind: 'immutable-image-defaults' },
    runtime: { user: null },
    privatePort: 3000
  }), {
    name: 'immutable-image-local-bootstrap-v1',
    capabilities: ['CHOWN', 'SETGID', 'SETUID']
  });
  assert.deepEqual(capabilityProfileForStartup({
    startup: { kind: 'immutable-image-defaults' },
    runtime: { user: null },
    privatePort: 80
  }), {
    name: 'immutable-image-local-bootstrap-v1',
    capabilities: ['CHOWN', 'SETGID', 'SETUID', 'NET_BIND_SERVICE']
  });
  assert.deepEqual(capabilityProfileForStartup({
    startup: { kind: 'immutable-image-defaults' },
    runtime: { user: '1000' },
    privatePort: 80
  }), {
    name: 'immutable-image-low-port-v1',
    capabilities: ['NET_BIND_SERVICE']
  });
  assert.deepEqual(capabilityProfileForStartup({
    startup: { kind: 'immutable-image-defaults' },
    runtime: { user: '1000' },
    privatePort: 3000
  }), {
    name: 'capability-free',
    capabilities: []
  });
  assert.deepEqual(capabilityProfileForStartup({
    startup: { kind: 'observed-process-argv' },
    runtime: { user: null },
    privatePort: 3000
  }), {
    name: 'capability-free',
    capabilities: []
  });
});

test('candidate creation falls back to matching immutable image defaults with encrypted secrets', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-image-default-startup-'));
  const operationId = 'smop_' + 'a'.repeat(32);
  const resourceId = 'res_' + 'b'.repeat(32);
  const sourceId = 'c'.repeat(64);
  const candidateId = 'd'.repeat(64);
  const imageId = 'sha256:' + 'e'.repeat(64);
  const agentImageId = 'sha256:' + 'f'.repeat(64);
  const snapshotId = 'snap_' + '1'.repeat(32);
  const environmentRevision = 'env_rev_' + '2'.repeat(32);
  const secretRef = {
    name: 'APP_TOKEN',
    secretId: 'secret_' + '5'.repeat(32),
    revision: 'secret_rev_' + '6'.repeat(32),
    keyId: 'key_' + '7'.repeat(24)
  };
  const imageConfig = {
    Entrypoint: ['/bin/bash', '-l', '-c'],
    Cmd: ['test -n "$PORT" && nginx -c /assets/nginx.conf'],
    WorkingDir: '/app/',
    User: ''
  };
  let createPayload = null;
  const source = {
    Id: sourceId,
    Image: imageId,
    Config: { ...imageConfig },
    State: { Running: true },
    NetworkSettings: { Networks: { legacy: {} } }
  };
  const dockerRequest = async (method, requestPath, payload) => {
    if (method === 'GET' && requestPath === '/containers/' + sourceId + '/json') return source;
    if (method === 'GET' && requestPath === '/containers/foxos/json') return { Image: agentImageId };
    if (method === 'GET' && requestPath === '/images/' + encodeURIComponent(imageId) + '/json') {
      return { Id: imageId, Config: { ...imageConfig } };
    }
    if (method === 'POST' && requestPath.startsWith('/images/')) return {};
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      createPayload = payload;
      return { Id: candidateId };
    }
    if (method === 'POST' && requestPath === '/networks/foxos-egress/connect') return {};
    if (method === 'POST' && requestPath === '/containers/' + candidateId + '/start') return {};
    if (method === 'GET' && requestPath === '/containers/' + candidateId + '/json') {
      return { Id: candidateId, Image: imageId, State: { Running: true, ExitCode: 0, OOMKilled: false } };
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  };
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest,
    dockerExec: async () => ({ exitCode: 1, output: '' }),
    resourceRegistry: {
      getLatest: () => ({
        snapshotId,
        resources: [{ id: resourceId, runtime: { containerId: sourceId, imageId } }]
      })
    },
    secretManager: {
      getEnvironmentRevision: () => ({ revision: environmentRevision, secretRefs: [secretRef] }),
      resolveEnvironment: () => ['APP_TOKEN=resolved-at-candidate-creation', 'PORT=3000']
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      hostIngressAddress: async () => '10.0.3.1',
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    }
  });
  fs.writeFileSync(path.join(adapter.paths.operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    planId: 'smplan_' + '3'.repeat(32),
    resourceId,
    source: { containerId: sourceId, imageId },
    dependencies: [],
    candidate: null,
    routes: []
  }));
  const candidate = await adapter.createCandidate({
    operationId,
    plan: {
      sourceSnapshotId: snapshotId,
      resource: { resourceId },
      executionContract: {
        contractId: 'smcontract_' + '4'.repeat(32),
        candidate: {
          environment: { revision: environmentRevision },
          runtime: {
            user: null,
            restartPolicy: 'unless-stopped',
            readOnlyRootFilesystem: false,
            memoryBytes: 536870912,
            nanoCpus: 1000000000,
            pidsLimit: 256,
            writableMounts: 0
          },
          ingressPorts: [3000],
          health: { privatePort: 3000 }
        }
      }
    }
  });
  assert.equal(candidate.owned, true);
  assert.deepEqual(createPayload.Entrypoint, imageConfig.Entrypoint);
  assert.deepEqual(createPayload.Cmd, imageConfig.Cmd);
  assert.equal(createPayload.WorkingDir, '/app/');
  assert.deepEqual(createPayload.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(createPayload.HostConfig.CapAdd, ['CHOWN', 'SETGID', 'SETUID']);
  assert.deepEqual(createPayload.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.deepEqual(createPayload.Env, ['APP_TOKEN=resolved-at-candidate-creation', 'PORT=3000']);
  const state = JSON.parse(fs.readFileSync(
    path.join(adapter.paths.operationsRoot, operationId + '.json'),
    'utf8'
  ));
  assert.equal(state.candidate.startupKind, 'immutable-image-defaults');
  assert.equal(state.candidate.capabilityProfile, 'immutable-image-local-bootstrap-v1');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('candidate creation applies the reconstructed Next standalone contract', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-next-startup-'));
  const operationId = 'smop_' + '1'.repeat(32);
  const resourceId = 'res_' + '2'.repeat(32);
  const sourceId = '3'.repeat(64);
  const candidateId = '4'.repeat(64);
  const imageId = 'sha256:' + '5'.repeat(64);
  const agentImageId = 'sha256:' + '6'.repeat(64);
  const snapshotId = 'snap_' + '7'.repeat(32);
  const environmentRevision = 'env_rev_' + '8'.repeat(32);
  let createPayload = null;
  const source = {
    Id: sourceId,
    Image: imageId,
    State: { Running: true },
    NetworkSettings: { Networks: { legacy: {} } }
  };
  const dockerRequest = async (method, requestPath, payload) => {
    if (method === 'GET' && requestPath === '/containers/' + sourceId + '/json') return source;
    if (method === 'GET' && requestPath === '/containers/foxos/json') return { Image: agentImageId };
    if (method === 'POST' && requestPath.startsWith('/images/')) return {};
    if (method === 'POST' && requestPath.startsWith('/containers/create?name=')) {
      createPayload = payload;
      return { Id: candidateId };
    }
    if (method === 'POST' && requestPath === '/networks/foxos-egress/connect') return {};
    if (method === 'POST' && requestPath === '/containers/' + candidateId + '/start') return {};
    if (method === 'GET' && requestPath === '/containers/' + candidateId + '/json') {
      return { Id: candidateId, Image: imageId, State: { Running: true, ExitCode: 0, OOMKilled: false } };
    }
    throw new Error('Unexpected Docker request: ' + method + ' ' + requestPath);
  };
  const dockerExec = async (_containerId, command) => {
    if (command[0] === 'cat') return { exitCode: 0, output: 'next-server (v15.5.12)\0' };
    if (command[0] === 'readlink' && command[1] === '/proc/1/exe') {
      return { exitCode: 0, output: '/nix/store/example-node/bin/node\n' };
    }
    if (command[0] === 'readlink' && command[1] === '/proc/1/cwd') {
      return { exitCode: 0, output: '/app/.next/standalone\n' };
    }
    if (command[0] === 'test') return { exitCode: 0, output: '' };
    throw new Error('Unexpected Docker exec: ' + command.join(' '));
  };
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest,
    dockerExec,
    resourceRegistry: {
      getLatest: () => ({
        snapshotId,
        resources: [{ id: resourceId, runtime: { containerId: sourceId, imageId } }]
      })
    },
    secretManager: {
      getEnvironmentRevision: () => ({ revision: environmentRevision }),
      resolveEnvironment: () => ['PORT=3000', 'HOSTNAME=source-container']
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      hostIngressAddress: async () => '10.0.3.1',
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    }
  });
  fs.writeFileSync(path.join(adapter.paths.operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    planId: 'smplan_' + '9'.repeat(32),
    resourceId,
    source: { containerId: sourceId, imageId },
    dependencies: [],
    candidate: null,
    routes: []
  }));
  const candidate = await adapter.createCandidate({
    operationId,
    plan: {
      sourceSnapshotId: snapshotId,
      resource: { resourceId },
      executionContract: {
        contractId: 'smcontract_' + 'a'.repeat(32),
        candidate: {
          environment: { revision: environmentRevision },
          runtime: {
            user: null,
            restartPolicy: 'unless-stopped',
            readOnlyRootFilesystem: false,
            memoryBytes: 536870912,
            nanoCpus: 1000000000,
            pidsLimit: 256
          },
          ingressPorts: [3000],
          health: { privatePort: 3000 }
        }
      }
    }
  });
  assert.equal(candidate.owned, true);
  assert.deepEqual(createPayload.Entrypoint, ['/nix/store/example-node/bin/node', 'server.js']);
  assert.deepEqual(createPayload.Cmd, []);
  assert.equal(createPayload.WorkingDir, '/app/.next/standalone');
  assert.equal(createPayload.Env.includes('HOSTNAME=0.0.0.0'), true);
  assert.equal(createPayload.Env.includes('HOSTNAME=source-container'), false);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('candidate health waits through the initial connection race and accepts planned redirects', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-health-retry-'));
  const operationId = 'smop_' + 'b'.repeat(32);
  const candidateId = 'c'.repeat(64);
  const gatewayId = 'f'.repeat(64);
  let probeCalls = 0;
  let waitCalls = 0;
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest: async (method, requestPath) => {
      assert.equal(method, 'GET');
      assert.equal(requestPath, '/containers/' + candidateId + '/json');
      return { State: { Running: true, ExitCode: 0, OOMKilled: false } };
    },
    dockerExec: async (containerId, command) => {
      assert.equal(containerId, gatewayId);
      assert.equal(command[0], 'wget');
      probeCalls += 1;
      if (probeCalls === 1) return { exitCode: 1, output: 'connection refused' };
      return { exitCode: 1, output: '  HTTP/1.1 307 Temporary Redirect\r\n' };
    },
    resourceRegistry: { getLatest: () => null },
    secretManager: {
      getEnvironmentRevision: () => null,
      resolveEnvironment: () => []
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      hostIngressAddress: async () => '10.0.3.1',
      inspectOwnedInfrastructure: async () => ({ gateway: { Id: gatewayId } }),
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    },
    candidateHealthAttempts: 3,
    candidateHealthIntervalMs: 0,
    wait: async () => { waitCalls += 1; }
  });
  fs.writeFileSync(path.join(adapter.paths.operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    candidate: {
      containerId: candidateId,
      alias: 'foxos-health-candidate',
      privatePort: 3000
    }
  }));
  const proof = await adapter.verifyCandidateHealth({
    operationId,
    plan: {
      executionContract: {
        candidate: {
          health: {
            privatePort: 3000,
            path: '/',
            acceptedStatusMinimum: 200,
            acceptedStatusMaximum: 399
          }
        }
      }
    }
  });
  assert.equal(proof.healthy, true);
  assert.equal(proof.statusCode, 307);
  assert.equal(proof.attempts, 2);
  assert.equal(probeCalls, 2);
  assert.equal(waitCalls, 1);
  const state = JSON.parse(fs.readFileSync(
    path.join(adapter.paths.operationsRoot, operationId + '.json'),
    'utf8'
  ));
  assert.deepEqual(state.candidate.health, {
    statusCode: 307,
    attempts: 2,
    checkedAt: proof.checkedAt
  });
  assert.equal(state.candidateAttempt.healthy, true);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('candidate health exhaustion persists bounded diagnostics before cleanup', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-health-failure-'));
  const operationId = 'smop_' + 'd'.repeat(32);
  const candidateId = 'e'.repeat(64);
  const gatewayId = 'f'.repeat(64);
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest: async () => ({
      State: { Running: true, ExitCode: 0, OOMKilled: false }
    }),
    dockerExec: async (containerId) => {
      assert.equal(containerId, gatewayId);
      return { exitCode: 1, output: 'connection refused' };
    },
    resourceRegistry: { getLatest: () => null },
    secretManager: {
      getEnvironmentRevision: () => null,
      resolveEnvironment: () => []
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      hostIngressAddress: async () => '10.0.3.1',
      inspectOwnedInfrastructure: async () => ({ gateway: { Id: gatewayId } }),
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    },
    candidateHealthAttempts: 2,
    candidateHealthIntervalMs: 0,
    wait: async () => {}
  });
  fs.writeFileSync(path.join(adapter.paths.operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    candidate: {
      containerId: candidateId,
      alias: 'foxos-health-candidate',
      privatePort: 3000
    }
  }));
  await assert.rejects(adapter.verifyCandidateHealth({
    operationId,
    plan: {
      executionContract: {
        candidate: {
          health: {
            privatePort: 3000,
            path: '/',
            acceptedStatusMinimum: 200,
            acceptedStatusMaximum: 399
          }
        }
      }
    }
  }), (error) => error.code === 'candidate-http-health-failed');
  const state = JSON.parse(fs.readFileSync(
    path.join(adapter.paths.operationsRoot, operationId + '.json'),
    'utf8'
  ));
  assert.equal(state.candidateAttempt.attempts, 2);
  assert.equal(state.candidateAttempt.running, true);
  assert.equal(state.candidateAttempt.healthy, false);
  assert.deepEqual(state.failure.code, 'candidate-http-health-failed');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('candidate health polling stops at its bounded readiness deadline', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-health-deadline-'));
  const operationId = 'smop_' + '6'.repeat(32);
  const candidateId = '7'.repeat(64);
  const gatewayId = '8'.repeat(64);
  let elapsed = 0;
  let probeCalls = 0;
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest: async () => ({
      State: { Running: true, ExitCode: 0, OOMKilled: false }
    }),
    dockerExec: async (containerId) => {
      assert.equal(containerId, gatewayId);
      probeCalls += 1;
      return { exitCode: 1, output: 'connection refused' };
    },
    resourceRegistry: { getLatest: () => null },
    secretManager: {
      getEnvironmentRevision: () => null,
      resolveEnvironment: () => []
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      hostIngressAddress: async () => '10.0.3.1',
      inspectOwnedInfrastructure: async () => ({ gateway: { Id: gatewayId } }),
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    },
    candidateHealthAttempts: 20,
    candidateHealthIntervalMs: 500,
    candidateHealthTimeoutMs: 600,
    healthClock: () => elapsed,
    wait: async (milliseconds) => { elapsed += milliseconds; }
  });
  fs.writeFileSync(path.join(adapter.paths.operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    candidate: {
      containerId: candidateId,
      alias: 'foxos-health-candidate',
      privatePort: 3000
    }
  }));
  await assert.rejects(adapter.verifyCandidateHealth({
    operationId,
    plan: {
      executionContract: {
        candidate: {
          health: {
            privatePort: 3000,
            path: '/',
            acceptedStatusMinimum: 200,
            acceptedStatusMaximum: 399
          }
        }
      }
    }
  }), (error) => error.code === 'candidate-http-health-failed');
  assert.equal(elapsed, 600);
  assert.equal(probeCalls, 2);
  const state = JSON.parse(fs.readFileSync(
    path.join(adapter.paths.operationsRoot, operationId + '.json'),
    'utf8'
  ));
  assert.equal(state.candidateAttempt.attempts, 2);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('traffic proof bypasses public DNS and verifies the direct host ingress path', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-direct-ingress-'));
  const operationId = 'smop_' + '5'.repeat(32);
  const sourceId = '6'.repeat(64);
  const routeId = 'smroute_' + '7'.repeat(24);
  const probeOptions = [];
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest: async (method, requestPath) => {
      assert.equal(method, 'GET');
      assert.equal(requestPath, '/containers/' + sourceId + '/json');
      return { Id: sourceId, State: { Running: true } };
    },
    dockerExec: async () => ({ exitCode: 0 }),
    resourceRegistry: { getLatest: () => null },
    secretManager: {
      getEnvironmentRevision: () => null,
      resolveEnvironment: () => []
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      hostIngressAddress: async () => '10.0.3.1',
      httpsProbe: async (options) => {
        probeOptions.push(options);
        return {
          statusCode: 307,
          tlsValid: true,
          expectedRoute: true,
          candidateIdentity: operationId
        };
      },
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    }
  });
  fs.writeFileSync(path.join(adapter.paths.operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    source: { containerId: sourceId },
    routes: [{ routeId, domain: 'app.example.com', path: '/' }]
  }));

  const proof = await adapter.verifyTraffic({ operationId });
  assert.equal(proof.healthy, true);
  assert.equal(probeOptions.length, 8);
  assert.equal(probeOptions.every((options) => options.connectHost === '10.0.3.1'), true);
  assert.equal(probeOptions.every((options) => options.hostname === 'app.example.com'), true);
  fs.rmSync(dataRoot, { recursive: true, force: true });
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
      hostIngressAddress: async () => '10.0.3.1',
      inspectOwnedInfrastructure: async () => ({ gateway: { Id: 'f'.repeat(64) } }),
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    }
  });
  const status = adapterStatus(adapter, async () => ({ approved: true }));
  assert.equal(status.ready, true);
  assert.deepEqual(status.unsafeCapabilities, []);
  assert.equal(typeof adapter.stopSource, 'undefined');
  assert.equal(typeof adapter.detachProvider, 'undefined');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('candidate health fails closed before exec when gateway identity is not exact', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-production-health-gateway-'));
  const operationId = 'smop_' + '9'.repeat(32);
  let execCalls = 0;
  const adapter = createProductionStatelessMigrationAdapter({
    dataRoot,
    dockerRequest: async () => ({ State: { Running: true, ExitCode: 0, OOMKilled: false } }),
    dockerExec: async () => { execCalls += 1; return { exitCode: 0, output: '' }; },
    resourceRegistry: { getLatest: () => null },
    secretManager: {
      getEnvironmentRevision: () => null,
      resolveEnvironment: () => []
    },
    certificateImporter: { importDomain: async () => ({}) },
    ingressAuthority: {
      hostIngressAddress: async () => '10.0.3.1',
      inspectOwnedInfrastructure: async () => ({ gateway: { Id: 'foxos-gateway' } }),
      stageRoutes: async () => [],
      verifyLegacyDomain: async () => ({ legacyReady: true })
    }
  });
  fs.writeFileSync(path.join(adapter.paths.operationsRoot, operationId + '.json'), JSON.stringify({
    schemaVersion: 1,
    operationId,
    candidate: {
      containerId: 'a'.repeat(64),
      alias: 'foxos-health-candidate',
      privatePort: 3000
    }
  }));
  await assert.rejects(adapter.verifyCandidateHealth({
    operationId,
    plan: {
      executionContract: {
        candidate: {
          health: {
            privatePort: 3000,
            path: '/',
            acceptedStatusMinimum: 200,
            acceptedStatusMaximum: 399
          }
        }
      }
    }
  }), (error) => error.code === 'foxos-gateway-identity-invalid');
  assert.equal(execCalls, 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
