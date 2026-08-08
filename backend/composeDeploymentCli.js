#!/usr/bin/env node

const path = require('node:path');
const { createComposeDeploymentManager, PLAN_COMPOSE_CONFIRMATION } = require('./composeDeploymentManager');
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
  const manager = createComposeDeploymentManager({
    dataRoot,
    dockerRequest: docker.request,
    dockerBuildRequest: docker.requestBuild,
    autoStartQueue: command === 'wait',
    recoverInterruptedJobs: false
  });

  if (command === 'status') return output(manager.status());

  if (command === 'plan') {
    const repository = flagValue(args, '--repository');
    const ref = flagValue(args, '--ref');
    const ingressService = flagValue(args, '--ingress-service');
    const expectedBody = flagValue(args, '--expected-body');
    if (!repository || !ref || !ingressService || !expectedBody) {
      throw new Error(
        'Usage: composeDeploymentCli.js plan --repository <public-https-git-url> --ref <branch-or-tag> ' +
        '--manifest <compose.yaml> --ingress-service <service> --health-path / --expected-body <marker> ' +
        `--confirm "${PLAN_COMPOSE_CONFIRMATION}"`
      );
    }
    return output(await manager.createPlan({
      repository,
      ref,
      manifest: flagValue(args, '--manifest', 'compose.yaml'),
      ingressService,
      healthPath: flagValue(args, '--health-path', '/'),
      expectedBody,
      confirmation: flagValue(args, '--confirm')
    }));
  }

  if (command === 'enqueue') {
    const planId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!planId || !confirmation) {
      throw new Error('Usage: composeDeploymentCli.js enqueue <plan-id> --confirm "DEPLOY COMPOSE <plan-id>"');
    }
    return output(manager.enqueuePlan(planId, confirmation));
  }

  if (command === 'job') {
    if (!args[1]) throw new Error('Usage: composeDeploymentCli.js job <job-id>');
    return output(manager.getJob(args[1]));
  }

  if (command === 'wait') {
    const jobId = args[1];
    if (!jobId) throw new Error('Usage: composeDeploymentCli.js wait <job-id> [--timeout-seconds 900]');
    const timeoutMs = Math.max(1, Number.parseInt(flagValue(args, '--timeout-seconds', '900'), 10)) * 1000;
    const started = Date.now();
    const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
    while (Date.now() - started < timeoutMs) {
      const job = manager.getJob(jobId);
      if (terminal.has(job.status)) {
        output(job);
        if (job.status !== 'succeeded') process.exitCode = 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Timed out waiting for Compose deployment job');
  }

  if (command === 'cancel') {
    const jobId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!jobId || !confirmation) {
      throw new Error('Usage: composeDeploymentCli.js cancel <job-id> --confirm "CANCEL COMPOSE <job-id>"');
    }
    return output(manager.cancelJob(jobId, confirmation));
  }

  if (command === 'rollback') {
    const operationId = args[1];
    const confirmation = flagValue(args, '--confirm');
    if (!operationId || !confirmation) {
      throw new Error('Usage: composeDeploymentCli.js rollback <operation-id> --confirm "ROLLBACK COMPOSE <operation-id>"');
    }
    return output(await manager.rollbackOperation(operationId, confirmation));
  }

  throw new Error('Usage: composeDeploymentCli.js <status|plan|enqueue|job|wait|cancel|rollback>');
}

main().catch((error) => {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
});
