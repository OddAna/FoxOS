#!/usr/bin/env node

const path = require('node:path');
const {
  PLAN_SERVER_MIGRATION_CONFIRMATION
} = require('./migrationOrchestrator');
const { createMigrationPlanningContext } = require('./migrationPlanningContext');

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
  const { migrationOrchestrator: manager } = createMigrationPlanningContext({
    dataRoot,
    dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
    routeBaseUrl: process.env.FOXOS_ROUTE_BASE_URL,
    routeNetwork: process.env.FOXOS_ROUTE_NETWORK || 'foxos-routing',
    routeGatewayHost: process.env.FOXOS_ROUTE_GATEWAY_HOST || 'foxos-gateway'
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
