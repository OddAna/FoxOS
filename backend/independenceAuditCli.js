#!/usr/bin/env node

const path = require('node:path');
const {
  AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION,
  createIndependenceAuditManager
} = require('./independenceAuditManager');
const { createApplicationManifestManager } = require('./applicationManifestManager');
const { createBackupManager } = require('./backupManager');
const { createComposeDeploymentManager } = require('./composeDeploymentManager');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createImageUpdateManager } = require('./imageUpdateManager');
const { createResourceRegistry } = require('./resourceRegistry');
const { createRouteManager } = require('./routeManager');
const { createSecretManager } = require('./secretManager');
const { createSourceDeploymentManager } = require('./sourceDeploymentManager');

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
  const sourceDeploymentManager = createSourceDeploymentManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerBuildRequest: docker.requestBuild
  });
  const composeDeploymentManager = createComposeDeploymentManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerBuildRequest: docker.requestBuild,
    autoStartQueue: false,
    recoverInterruptedJobs: false
  });
  const imageUpdateManager = createImageUpdateManager({ dataRoot, dockerRequest: docker.request });
  const applicationManifestManager = createApplicationManifestManager({
    dataRoot,
    resourceRegistry,
    getEnvironmentRevision: (resourceId) => secretManager.getEnvironmentRevision(resourceId),
    routeStatus: () => routeManager.status(),
    backupStatus: () => backupManager.status(),
    sourceDeploymentStatus: () => sourceDeploymentManager.status(),
    composeDeploymentStatus: () => composeDeploymentManager.status(),
    imageUpdateStatus: () => imageUpdateManager.status()
  });
  const manager = createIndependenceAuditManager({
    dataRoot,
    resourceRegistry,
    compileApplicationManifest: (resourceId) => applicationManifestManager.compile(resourceId)
  });

  if (command === 'status') return output(manager.status());
  if (command === 'candidates') return output(manager.candidates());
  if (command === 'audit') {
    const resourceId = args[1];
    if (!resourceId) {
      throw new Error(
        `Usage: independenceAuditCli.js audit <resource-id> --confirm "${AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION}"`
      );
    }
    return output(manager.createAudit({ resourceId, confirmation: flagValue(args, '--confirm') }));
  }
  if (command === 'get') {
    if (!args[1]) throw new Error('Usage: independenceAuditCli.js get <audit-id>');
    return output(manager.getAudit(args[1]));
  }
  throw new Error('Usage: independenceAuditCli.js <status|candidates|audit|get>');
}

try {
  main();
} catch (error) {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
}
