#!/usr/bin/env node
const { createCoolifyMigrationReader } = require('./coolifyMigrationReader');
const { createEncryptionStore } = require('./encryptionStore');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readStdin() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

async function main() {
  const command = process.argv[2];
  const dataRoot = process.env.DATA_ROOT || '/data';
  const reader = createCoolifyMigrationReader({
    dataRoot,
    encryptionStore: createEncryptionStore({ dataRoot })
  });
  if (command === 'status') {
    process.stdout.write(JSON.stringify(reader.status(), null, 2) + '\n');
    return;
  }
  if (command !== 'configure') throw new Error('Usage: coolifyMigrationReaderCli.js configure --url <url> < token');
  const baseUrl = option('--url');
  const token = await readStdin();
  const result = await reader.configure({ baseUrl, token });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write((error.code || 'coolify-reader-error') + ': ' + error.message + '\n');
  process.exitCode = 1;
});
