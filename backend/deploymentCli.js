#!/usr/bin/env node

const path = require('node:path');
const { createDockerClient } = require('./dockerClient');
const {
  PLAN_CONFIRMATION,
  createSourceDeploymentManager
} = require('./sourceDeploymentManager');

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', '.foxos-data'));
  const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
  const docker = createDockerClient(socketPath);
  const manager = createSourceDeploymentManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerBuildRequest: docker.requestBuild
  });

  if (command === 'status') {
    process.stdout.write(JSON.stringify(manager.status(), null, 2) + '\n');
    return;
  }

  if (command === 'plan') {
    const repository = flagValue(args, '--repository');
    const ref = flagValue(args, '--ref');
    const expectedBody = flagValue(args, '--expected-body');
    if (!repository || !ref || !expectedBody) {
      throw new Error(
        'Usage: deploymentCli.js plan --repository <public-https-git-url> --ref <branch-or-tag> ' +
        '--context <path> --dockerfile Dockerfile --private-port <port> --health-path / ' +
        `--expected-body <marker> --confirm "${PLAN_CONFIRMATION}"`
      );
    }
    const plan = await manager.createPlan({
      repository,
      ref,
      contextPath: flagValue(args, '--context', '.'),
      dockerfile: flagValue(args, '--dockerfile', 'Dockerfile'),
      privatePort: flagValue(args, '--private-port', '8080'),
      healthPath: flagValue(args, '--health-path', '/'),
      expectedBody,
      confirmation: flagValue(args, '--confirm')
    });
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }

  if (command === 'apply') {
    const planId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!planId || !confirmation) {
      throw new Error('Usage: deploymentCli.js apply <plan-id> --confirm "DEPLOY DISPOSABLE <plan-id>"');
    }
    process.stdout.write(JSON.stringify(await manager.applyPlan(planId, confirmation), null, 2) + '\n');
    return;
  }

  if (command === 'rollback') {
    const operationId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!operationId || !confirmation) {
      throw new Error('Usage: deploymentCli.js rollback <operation-id> --confirm "ROLLBACK DEPLOYMENT <operation-id>"');
    }
    process.stdout.write(JSON.stringify(await manager.rollbackOperation(operationId, confirmation), null, 2) + '\n');
    return;
  }

  throw new Error('Usage: deploymentCli.js <status|plan|apply|rollback>');
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
});
