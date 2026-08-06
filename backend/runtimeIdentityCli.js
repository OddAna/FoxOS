#!/usr/bin/env node

const path = require('node:path');
const { createDockerClient } = require('./dockerClient');
const { createIngressAuthorityManager } = require('./ingressAuthorityManager');
const { createResourceRegistry } = require('./resourceRegistry');
const { createRuntimeIdentityManager } = require('./runtimeIdentityManager');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', '.foxos-data'));
  const docker = createDockerClient(process.env.DOCKER_SOCKET || '/var/run/docker.sock');
  const ingressAuthority = createIngressAuthorityManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerExec: docker.exec,
    hostCommand: async () => ({ success: false, exitCode: 1, output: '' }),
    routingNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
    gatewayContainer: process.env.FOXOS_ROUTE_GATEWAY_HOST || 'foxos-gateway',
    ingressHttpPort: Number.parseInt(process.env.FOXOS_INGRESS_HTTP_PORT || '9080', 10),
    ingressHttpsPort: Number.parseInt(process.env.FOXOS_INGRESS_HTTPS_PORT || '9443', 10)
  });
  const manager = createRuntimeIdentityManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerExec: docker.exec,
    ingressAuthority,
    routingNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing'
  });
  const registry = createResourceRegistry({ dataRoot, dockerRequest: docker.request });

  if (command === 'status') {
    process.stdout.write(JSON.stringify({
      operations: manager.completedOperations().map((operation) => operation.operationId)
    }, null, 2) + '\n');
    return;
  }
  if (command === 'reconcile' && args[1] === '--all' && args[2] === '--confirm' && args[3] === 'RECONCILE READABLE RUNTIME IDENTITIES') {
    const result = await manager.reconcileAll();
    const snapshot = await registry.scan();
    process.stdout.write(JSON.stringify({ result, snapshotId: snapshot.snapshotId }, null, 2) + '\n');
    return;
  }
  if (command === 'reconcile' && /^smop_[a-f0-9]{32}$/.test(String(args[1] || '')) && args[2] === '--confirm' && args[3] === 'RECONCILE READABLE RUNTIME IDENTITY') {
    const result = await manager.reconcileOperation(args[1]);
    const snapshot = await registry.scan();
    process.stdout.write(JSON.stringify({ result, snapshotId: snapshot.snapshotId }, null, 2) + '\n');
    return;
  }
  throw new Error(
    'Usage: runtimeIdentityCli.js status | reconcile --all --confirm "RECONCILE READABLE RUNTIME IDENTITIES" | ' +
    'reconcile <operation-id> --confirm "RECONCILE READABLE RUNTIME IDENTITY"'
  );
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
});
