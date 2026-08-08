#!/usr/bin/env node

const path = require('node:path');
const { createDockerClient } = require('./dockerClient');
const { createEncryptionStore } = require('./encryptionStore');
const { createResourceRegistry } = require('./resourceRegistry');
const { createSecretManager } = require('./secretManager');
const {
  PLAN_ENVIRONMENT_CONFIRMATION,
  PLAN_SOURCE_CONFIRMATION,
  createWorkloadEvidenceManager
} = require('./workloadEvidenceManager');

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
  const manager = createWorkloadEvidenceManager({
    dataRoot,
    dockerRequest: docker.request,
    resourceRegistry,
    encryptionStore,
    secretManager
  });

  if (command === 'status') return output(manager.status());

  if (command === 'plan-source') {
    const resourceId = args[1];
    if (!resourceId) {
      throw new Error(
        `Usage: workloadEvidenceCli.js plan-source <resource-id> --repository <https-url> --ref <ref> ` +
        `[--context <path>] [--dockerfile <path>] [--username <name> --credential-secret <name>] ` +
        `--confirm "${PLAN_SOURCE_CONFIRMATION}"`
      );
    }
    return output(await manager.planSource({
      resourceId,
      repository: flagValue(args, '--repository'),
      ref: flagValue(args, '--ref'),
      contextPath: flagValue(args, '--context', '.'),
      dockerfile: flagValue(args, '--dockerfile', 'Dockerfile'),
      username: flagValue(args, '--username'),
      credentialSecret: flagValue(args, '--credential-secret'),
      confirmation: flagValue(args, '--confirm')
    }));
  }

  if (command === 'capture-source') {
    const planId = args[1];
    if (!planId) {
      throw new Error('Usage: workloadEvidenceCli.js capture-source <plan-id> --confirm "CAPTURE WORKLOAD SOURCE <plan-id>"');
    }
    return output(await manager.captureSource(planId, flagValue(args, '--confirm')));
  }

  if (command === 'plan-environment') {
    const resourceId = args[1];
    if (!resourceId) {
      throw new Error(
        `Usage: workloadEvidenceCli.js plan-environment <resource-id> [--secret-name <name>] ` +
        `--confirm "${PLAN_ENVIRONMENT_CONFIRMATION}"`
      );
    }
    return output(await manager.planEnvironment({
      resourceId,
      secretNames: flagValues(args, '--secret-name'),
      confirmation: flagValue(args, '--confirm')
    }));
  }

  if (command === 'capture-environment') {
    const planId = args[1];
    if (!planId) {
      throw new Error(
        'Usage: workloadEvidenceCli.js capture-environment <plan-id> ' +
        '--confirm "CAPTURE WORKLOAD ENVIRONMENT <plan-id>"'
      );
    }
    return output(await manager.captureEnvironment(planId, flagValue(args, '--confirm')));
  }

  throw new Error('Usage: workloadEvidenceCli.js <status|plan-source|capture-source|plan-environment|capture-environment>');
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
});
