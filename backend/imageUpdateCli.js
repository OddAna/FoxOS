#!/usr/bin/env node

const path = require('node:path');
const {
  PLAN_IMAGE_UPDATE_CONFIRMATION,
  createImageUpdateManager
} = require('./imageUpdateManager');
const { createDockerClient } = require('./dockerClient');

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
  const manager = createImageUpdateManager({ dataRoot, dockerRequest: docker.request });

  if (command === 'status') return output(manager.status());

  if (command === 'plan') {
    const image = flagValue(args, '--image');
    const expectedBody = flagValue(args, '--expected-body');
    if (!image || !expectedBody) {
      throw new Error(
        'Usage: imageUpdateCli.js plan --image <reviewed-tag> --health-path / --expected-body <marker> ' +
        `--confirm "${PLAN_IMAGE_UPDATE_CONFIRMATION}"`
      );
    }
    return output(await manager.createPlan({
      image,
      healthPath: flagValue(args, '--health-path', '/'),
      expectedBody,
      confirmation: flagValue(args, '--confirm')
    }));
  }

  if (command === 'apply') {
    const planId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!planId || !confirmation) {
      throw new Error('Usage: imageUpdateCli.js apply <plan-id> --confirm "APPLY IMAGE UPDATE <plan-id>"');
    }
    return output(await manager.applyPlan(planId, confirmation));
  }

  if (command === 'rollback') {
    const operationId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!operationId || !confirmation) {
      throw new Error('Usage: imageUpdateCli.js rollback <operation-id> --confirm "ROLLBACK IMAGE UPDATE <operation-id>"');
    }
    return output(await manager.rollbackOperation(operationId, confirmation));
  }

  throw new Error('Usage: imageUpdateCli.js <status|plan|apply|rollback>');
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
});
