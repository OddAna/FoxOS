#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createBackupManager } = require('./backupManager');
const { createEncryptionStore } = require('./encryptionStore');

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(__dirname, '..', '.foxos-data'));
  const encryptionStore = createEncryptionStore({ dataRoot });
  const manager = createBackupManager({ dataRoot, encryptionStore });

  if (command === 'status') {
    process.stdout.write(JSON.stringify({ encryption: encryptionStore.status(), backup: manager.status() }, null, 2) + '\n');
    return;
  }

  if (command === 'configure-s3') {
    const accessKeyFile = flagValue(args, '--access-key-file');
    const secretKeyFile = flagValue(args, '--secret-key-file');
    const endpoint = flagValue(args, '--endpoint');
    const bucket = flagValue(args, '--bucket');
    if (!accessKeyFile || !secretKeyFile || !endpoint || !bucket) {
      throw new Error(
        'Usage: recoveryCli.js configure-s3 --endpoint <https-url> --bucket <name> ' +
        '--access-key-file <path> --secret-key-file <path> [--region auto] [--prefix foxos]'
      );
    }
    const result = manager.configureS3({
      endpoint,
      bucket,
      region: flagValue(args, '--region', 'auto'),
      prefix: flagValue(args, '--prefix', 'foxos'),
      accessKeyId: fs.readFileSync(path.resolve(accessKeyFile), 'utf8'),
      secretAccessKey: fs.readFileSync(path.resolve(secretKeyFile), 'utf8')
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  throw new Error('Usage: recoveryCli.js <status|configure-s3>');
}

try {
  main();
} catch (error) {
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n');
  process.exitCode = 1;
}
