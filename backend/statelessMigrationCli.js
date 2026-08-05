#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const {
  PREPARE_STATELESS_MIGRATION_CONFIRMATION,
  createStatelessMigrationManager
} = require('./statelessMigrationManager');

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
  const manager = createStatelessMigrationManager({
    dataRoot,
    getServerMigrationPlan: (planId) => {
      const target = path.join(dataRoot, 'migration-orchestrator', 'plans', planId + '.json');
      try {
        return JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') {
          error.statusCode = 404;
          error.code = 'server-plan-not-found';
          error.message = 'Server migration plan was not found';
        }
        throw error;
      }
    }
  });

  if (command === 'status') return output(manager.status());
  if (command === 'plan') {
    return output(manager.createPlan({
      serverPlanId: flagValue(args, '--server-plan'),
      resourceId: flagValue(args, '--resource'),
      confirmation: flagValue(args, '--confirm')
    }));
  }
  if (command === 'get') {
    if (!args[1]) throw new Error('Usage: statelessMigrationCli.js get <plan-id>');
    return output(manager.getPlan(args[1]));
  }
  throw new Error(
    'Usage: statelessMigrationCli.js <status|get> or plan --server-plan PLAN_ID ' +
    '--resource RESOURCE_ID --confirm "' + PREPARE_STATELESS_MIGRATION_CONFIRMATION + '"'
  );
}

try {
  main();
} catch (error) {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
}
