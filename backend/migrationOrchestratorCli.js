#!/usr/bin/env node

const path = require('node:path');
const { createApplicationManifestManager } = require('./applicationManifestManager');
const { createBackupManager } = require('./backupManager');
const { createComposeDeploymentManager } = require('./composeDeploymentManager');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createImageUpdateManager } = require('./imageUpdateManager');
const {
  PLAN_SERVER_MIGRATION_CONFIRMATION,
  createMigrationOrchestrator
} = require('./migrationOrchestrator');
const { createResourceRegistry } = require('./resourceRegistry');
const { createRouteManager } = require('./routeManager');
const { createSecretManager } = require('./secretManager');
const { createSourceDeploymentManager } = require('./sourceDeploymentManager');
const { createStatefulRehearsalManager } = require('./statefulRehearsalManager');
const { createStatefulShadowManager } = require('./statefulShadowManager');
const { createWorkloadEvidenceManager } = require('./workloadEvidenceManager');

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
  const workloadEvidenceManager = createWorkloadEvidenceManager({
    dataRoot,
    dockerRequest: docker.request,
    resourceRegistry,
    encryptionStore,
    secretManager
  });
  const statefulRehearsalManager = createStatefulRehearsalManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerArchiveRequest: docker.requestBuffer,
    resourceRegistry,
    encryptionStore,
    secretManager
  });
  const statefulShadowManager = createStatefulShadowManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerArchiveRequest: docker.requestBuffer,
    resourceRegistry,
    encryptionStore,
    secretManager,
    statefulRehearsalStatus: () => statefulRehearsalManager.status()
  });
  const applicationManifestManager = createApplicationManifestManager({
    dataRoot,
    resourceRegistry,
    getEnvironmentRevision: (resourceId) => secretManager.getEnvironmentRevision(resourceId),
    routeStatus: () => routeManager.status(),
    backupStatus: () => backupManager.status(),
    sourceDeploymentStatus: () => sourceDeploymentManager.status(),
    composeDeploymentStatus: () => composeDeploymentManager.status(),
    imageUpdateStatus: () => imageUpdateManager.status(),
    workloadEvidenceStatus: () => workloadEvidenceManager.status(),
    statefulRehearsalStatus: () => statefulRehearsalManager.status(),
    statefulShadowStatus: () => statefulShadowManager.status()
  });
  const manager = createMigrationOrchestrator({
    dataRoot,
    resourceRegistry,
    compileApplicationManifest: (resourceId) => applicationManifestManager.compile(resourceId)
  });

  if (command === 'status') return output(manager.status());
  if (command === 'plan') {
    return output(manager.createPlan({ confirmation: flagValue(args, '--confirm') }));
  }
  if (command === 'get') {
    if (!args[1]) throw new Error('Usage: migrationOrchestratorCli.js get <plan-id>');
    return output(manager.getPlan(args[1]));
  }
  throw new Error(
    'Usage: migrationOrchestratorCli.js <status|get> or plan --confirm "' +
    PLAN_SERVER_MIGRATION_CONFIRMATION + '"'
  );
}

try {
  main();
} catch (error) {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
}
