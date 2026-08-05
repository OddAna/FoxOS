#!/usr/bin/env node

const path = require('node:path');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createResourceRegistry } = require('./resourceRegistry');
const { createSecretManager } = require('./secretManager');
const { createStatefulRehearsalManager } = require('./statefulRehearsalManager');
const {
  PLAN_STATEFUL_SHADOW_CONFIRMATION,
  createStatefulShadowManager
} = require('./statefulShadowManager');

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function output(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', '.foxos-data'));
  const docker = createDockerClient(process.env.DOCKER_SOCKET || '/var/run/docker.sock');
  const resourceRegistry = createResourceRegistry({ dataRoot, dockerRequest: docker.request });
  const encryptionStore = createEncryptionStore({ dataRoot });
  const secretManager = createSecretManager({ dataRoot, encryptionStore });
  const rehearsalManager = createStatefulRehearsalManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerArchiveRequest: docker.requestBuffer,
    resourceRegistry,
    encryptionStore,
    secretManager
  });
  const manager = createStatefulShadowManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerArchiveRequest: docker.requestBuffer,
    resourceRegistry,
    encryptionStore,
    secretManager,
    statefulRehearsalStatus: () => rehearsalManager.status()
  });

  if (command === 'status') return output(manager.status());
  if (command === 'plan') {
    const resourceId = args[1];
    if (!resourceId) {
      throw new Error(
        `Usage: statefulShadowCli.js plan <resource-id> ` +
        `--confirm "${PLAN_STATEFUL_SHADOW_CONFIRMATION}"`
      );
    }
    return output(await manager.createPlan({
      resourceId,
      confirmation: flagValue(args, '--confirm')
    }));
  }
  if (command === 'run') {
    const planId = args[1];
    if (!planId) {
      throw new Error('Usage: statefulShadowCli.js run <plan-id> --confirm "RUN STATEFUL SHADOW <plan-id>"');
    }
    return output(await manager.runPlan(planId, flagValue(args, '--confirm')));
  }
  if (command === 'get-plan') {
    if (!args[1]) throw new Error('Usage: statefulShadowCli.js get-plan <plan-id>');
    return output(manager.getPlan(args[1]));
  }
  if (command === 'get-operation') {
    if (!args[1]) throw new Error('Usage: statefulShadowCli.js get-operation <operation-id>');
    return output(manager.getOperation(args[1]));
  }
  throw new Error('Usage: statefulShadowCli.js <status|plan|run|get-plan|get-operation>');
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
});
