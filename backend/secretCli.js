#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createEncryptionStore } = require('./encryptionStore');
const { createSecretManager } = require('./secretManager');

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

function pairs(values, label) {
  return Object.fromEntries(values.map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error(`${label} must use NAME=value`);
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function sensitiveValue(args) {
  const file = flagValue(args, '--value-file');
  const fromStdin = args.includes('--value-stdin');
  if (Boolean(file) === fromStdin) {
    throw new Error('Choose exactly one of --value-file or --value-stdin');
  }
  const value = file ? fs.readFileSync(path.resolve(file), 'utf8') : fs.readFileSync(0, 'utf8');
  return value.replace(/\r?\n$/, '');
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', '.foxos-data'));
  const encryptionStore = createEncryptionStore({ dataRoot });
  const manager = createSecretManager({ dataRoot, encryptionStore });

  if (command === 'status') {
    process.stdout.write(JSON.stringify({ ...manager.status(), secrets: manager.listSecrets() }, null, 2) + '\n');
    return;
  }

  if (command === 'put') {
    const name = args[1];
    if (!name) throw new Error('Usage: secretCli.js put <name> (--value-file <path> | --value-stdin)');
    process.stdout.write(JSON.stringify(manager.putSecret(name, sensitiveValue(args)), null, 2) + '\n');
    return;
  }

  if (command === 'environment') {
    const resourceId = args[1];
    if (!resourceId) {
      throw new Error('Usage: secretCli.js environment <resource-id> [--ordinary NAME=value] [--secret NAME=secret-name]');
    }
    const environment = manager.createEnvironmentRevision(resourceId, {
      ordinary: pairs(flagValues(args, '--ordinary'), 'Ordinary environment'),
      secretRefs: pairs(flagValues(args, '--secret'), 'Secret environment')
    });
    process.stdout.write(JSON.stringify(environment, null, 2) + '\n');
    return;
  }

  throw new Error('Usage: secretCli.js <status|put|environment>');
}

try {
  main();
} catch (error) {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
}
