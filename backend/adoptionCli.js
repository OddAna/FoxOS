#!/usr/bin/env node

const path = require('node:path');
const {
  createAdoptionManager,
  planDraftConfirmation
} = require('./adoptionManager');
const { createBackupManager } = require('./backupManager');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createResourceRegistry } = require('./resourceRegistry');
const { createRouteManager } = require('./routeManager');
const { createSecretManager } = require('./secretManager');

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', '.foxos-data'));
  const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
  const docker = createDockerClient(socketPath);
  const registry = createResourceRegistry({ dataRoot, dockerRequest: docker.request });
  const routeManager = createRouteManager({
    dataRoot,
    dockerRequest: docker.request,
    publicBaseUrl: process.env.FOXOS_ROUTE_BASE_URL,
    networkName: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
    gatewayHost: process.env.FOXOS_ROUTE_GATEWAY_HOST || 'foxos-gateway'
  });
  const encryptionStore = createEncryptionStore({ dataRoot });
  const secretManager = createSecretManager({ dataRoot, encryptionStore });
  const backupManager = createBackupManager({ dataRoot, encryptionStore });
  const manager = createAdoptionManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerArchiveRequest: docker.requestBuffer,
    resourceRegistry: registry,
    routeManager,
    secretManager,
    backupManager
  });

  if (command === 'status') {
    process.stdout.write(JSON.stringify(manager.status(), null, 2) + '\n');
    return;
  }

  if (command === 'scan') {
    const snapshot = await registry.scan();
    process.stdout.write(JSON.stringify({ snapshotId: snapshot.snapshotId, summary: snapshot.summary }, null, 2) + '\n');
    return;
  }

  if (command === 'plan') {
    const selector = args[1];
    if (!selector || !hasFlag(args, '--confirm-disposable')) {
      throw new Error('Usage: adoptionCli.js plan <resource-id-or-name> --confirm-disposable [--health-port 80] [--health-path /]');
    }
    const snapshot = await registry.scan();
    const resource = snapshot.resources.find((candidate) => candidate.id === selector || candidate.name === selector);
    if (!resource) throw new Error('Disposable resource was not found');
    const plan = await manager.createPlan(resource.id, {
      confirmation: planDraftConfirmation(resource.id),
      healthPrivatePort: flagValue(args, '--health-port', null),
      healthPath: flagValue(args, '--health-path', '/')
    });
    process.stdout.write(JSON.stringify({
      planId: plan.planId,
      resourceId: plan.resourceId,
      status: plan.status,
      checks: plan.checks,
      confirmation: plan.confirmation,
      manifestRevision: plan.manifestRevision
    }, null, 2) + '\n');
    return;
  }

  if (command === 'apply') {
    const planId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!planId || !confirmation) {
      throw new Error('Usage: adoptionCli.js apply <plan-id> --confirm "ADOPT DISPOSABLE <resource-id>"');
    }
    const operation = await manager.applyPlan(planId, confirmation);
    process.stdout.write(JSON.stringify(operation, null, 2) + '\n');
    return;
  }

  if (command === 'rollback') {
    const operationId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!operationId || !confirmation) {
      throw new Error('Usage: adoptionCli.js rollback <operation-id> --confirm "ROLLBACK <operation-id>"');
    }
    const operation = await manager.rollbackOperation(operationId, confirmation);
    process.stdout.write(JSON.stringify(operation, null, 2) + '\n');
    return;
  }

  throw new Error('Usage: adoptionCli.js <scan|status|plan|apply|rollback>');
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
});
