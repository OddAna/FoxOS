#!/usr/bin/env node
const { createMaintenanceSessionManager } = require('./maintenanceSessionManager');

const manager = createMaintenanceSessionManager({
  dataRoot: process.env.DATA_ROOT || '/data'
});

if (process.argv[2] !== 'issue') {
  process.stderr.write('Usage: maintenanceSessionCli.js issue\n');
  process.exit(2);
}

process.stdout.write(manager.issue().token);
