const { createApplicationManifestManager } = require('./applicationManifestManager');
const { createBackupManager } = require('./backupManager');
const { createComposeDeploymentManager } = require('./composeDeploymentManager');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createImageUpdateManager } = require('./imageUpdateManager');
const { createMigrationOrchestrator } = require('./migrationOrchestrator');
const { createResourceRegistry } = require('./resourceRegistry');
const { createRouteManager } = require('./routeManager');
const { createSecretManager } = require('./secretManager');
const { createSourceDeploymentManager } = require('./sourceDeploymentManager');
const { createStatefulRehearsalManager } = require('./statefulRehearsalManager');
const { createStatefulShadowManager } = require('./statefulShadowManager');
const {
  createStatelessMigrationManifestCompiler
} = require('./statelessMigrationManifestCompiler');
const { createWorkloadEvidenceManager } = require('./workloadEvidenceManager');

function createMigrationPlanningContext({
  dataRoot,
  dockerSocket = '/var/run/docker.sock',
  routeBaseUrl = null,
  routeNetwork = 'foxos-routing',
  routeGatewayHost = 'foxos-gateway'
}) {
  if (!dataRoot) throw new Error('Migration planning context requires a data root');

  const docker = createDockerClient(dockerSocket);
  const resourceRegistry = createResourceRegistry({ dataRoot, dockerRequest: docker.request });
  const encryptionStore = createEncryptionStore({ dataRoot });
  const secretManager = createSecretManager({ dataRoot, encryptionStore });
  const backupManager = createBackupManager({ dataRoot, encryptionStore });
  const routeManager = createRouteManager({
    dataRoot,
    dockerRequest: docker.request,
    publicBaseUrl: routeBaseUrl,
    networkName: routeNetwork,
    gatewayHost: routeGatewayHost
  });
  const imageUpdateManager = createImageUpdateManager({
    dataRoot,
    dockerRequest: docker.request,
    recoverInterruptedOperations: false
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
  const migrationOrchestrator = createMigrationOrchestrator({
    dataRoot,
    resourceRegistry,
    compileApplicationManifest: (resourceId) => applicationManifestManager.compile(resourceId)
  });
  const statelessMigrationManifestCompiler = createStatelessMigrationManifestCompiler({
    resourceRegistry,
    compileApplicationManifest: (resourceId) => applicationManifestManager.compile(resourceId)
  });

  return {
    applicationManifestManager,
    migrationOrchestrator,
    resourceRegistry,
    statelessMigrationManifestCompiler
  };
}

module.exports = { createMigrationPlanningContext };
