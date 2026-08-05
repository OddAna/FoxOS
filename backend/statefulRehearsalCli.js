#!/usr/bin/env node

const path = require('node:path');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createResourceRegistry } = require('./resourceRegistry');
const { createSecretManager } = require('./secretManager');
const {
  PLAN_STATEFUL_REHEARSAL_CONFIRMATION,
  createStatefulRehearsalManager
} = require('./statefulRehearsalManager');

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function flagValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
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
  const manager = createStatefulRehearsalManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerArchiveRequest: docker.requestBuffer,
    resourceRegistry,
    encryptionStore,
    secretManager
  });

  if (command === 'status') return output(manager.status());
  if (command === 'plan') {
    const resourceId = args[1];
    if (!resourceId) {
      throw new Error(
        `Usage: statefulRehearsalCli.js plan <resource-id> ` +
        `--persistent-volume <name> [--persistent-volume <name>] ` +
        `[--empty-volume <name>] --private-port <port> ` +
        `--confirm "${PLAN_STATEFUL_REHEARSAL_CONFIRMATION}"`
      );
    }
    return output(await manager.createPlan({
      resourceId,
      persistentVolumes: flagValues(args, '--persistent-volume'),
      emptyVolumes: flagValues(args, '--empty-volume'),
      privatePort: flagValue(args, '--private-port'),
      confirmation: flagValue(args, '--confirm')
    }));
  }
  if (command === 'run') {
    const planId = args[1];
    if (!planId) {
      throw new Error(
        'Usage: statefulRehearsalCli.js run <plan-id> ' +
        '--confirm "RUN STATEFUL REHEARSAL <plan-id>"'
      );
    }
    return output(await manager.runPlan(planId, flagValue(args, '--confirm')));
  }
  if (command === 'get-plan') {
    if (!args[1]) throw new Error('Usage: statefulRehearsalCli.js get-plan <plan-id>');
    return output(manager.getPlan(args[1]));
  }
  if (command === 'get-operation') {
    if (!args[1]) throw new Error('Usage: statefulRehearsalCli.js get-operation <operation-id>');
    return output(manager.getOperation(args[1]));
  }
  throw new Error('Usage: statefulRehearsalCli.js <status|plan|run|get-plan|get-operation>');
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
});
