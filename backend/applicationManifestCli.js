#!/usr/bin/env node

const path = require('node:path');
const {
  PLAN_APPLICATION_MANIFEST_CONFIRMATION,
  createApplicationManifestManager
} = require('./applicationManifestManager');
const { createBackupManager } = require('./backupManager');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createImageUpdateManager } = require('./imageUpdateManager');
const { createResourceRegistry } = require('./resourceRegistry');
const { createRouteManager } = require('./routeManager');
const { createSecretManager } = require('./secretManager');

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function output(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', '.foxos-data'));
  const docker = createDockerClient(process.env.DOCKER_SOCKET || '/var/run/docker.sock');
  const resourceRegistry = createResourceRegistry({ dataRoot, dockerRequest: docker.request });
  const encryptionStore = createEncryptionStore({ dataRoot });
  const secretManager = createSecretManager({ dataRoot, encryptionStore });
  const backupManager = createBackupManager({ dataRoot, encryptionStore });
  const routeManager = createRouteManager({
    dataRoot,
    dockerRequest: docker.request,
    publicBaseUrl: process.env.FOXOS_ROUTE_BASE_URL,
    networkName: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
    gatewayHost: process.env.FOXOS_ROUTE_GATEWAY_HOST || 'foxos-gateway'
  });
  const imageUpdateManager = createImageUpdateManager({ dataRoot, dockerRequest: docker.request });
  const manager = createApplicationManifestManager({
    dataRoot,
    resourceRegistry,
    getEnvironmentRevision: (resourceId) => secretManager.getEnvironmentRevision(resourceId),
    routeStatus: () => routeManager.status(),
    backupStatus: () => backupManager.status(),
    imageUpdateStatus: () => imageUpdateManager.status()
  });

  if (command === 'status') return output(manager.status());

  if (command === 'draft') {
    const resourceId = args[1];
    if (!resourceId) {
      throw new Error(
        `Usage: applicationManifestCli.js draft <resource-id> --confirm "${PLAN_APPLICATION_MANIFEST_CONFIRMATION}"`
      );
    }
    return output(manager.createDraft({
      resourceId,
      confirmation: flagValue(args, '--confirm')
    }));
  }

  if (command === 'finalize') {
    const draftId = args[1];
    if (!draftId) {
      throw new Error(
        'Usage: applicationManifestCli.js finalize <draft-id> ' +
        '--confirm "FINALIZE APPLICATION MANIFEST <draft-id>"'
      );
    }
    return output(manager.finalizeDraft(draftId, flagValue(args, '--confirm')));
  }

  if (command === 'current') {
    const resourceId = args[1];
    if (!resourceId) throw new Error('Usage: applicationManifestCli.js current <resource-id>');
    const manifest = manager.getCurrent(resourceId);
    if (!manifest) throw new Error('Application manifest was not found');
    return output(manifest);
  }

  throw new Error('Usage: applicationManifestCli.js <status|draft|finalize|current>');
}

try {
  main();
} catch (error) {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
}
