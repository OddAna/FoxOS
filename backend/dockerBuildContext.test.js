const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('production Docker build context excludes local environment and persistent data', () => {
  const ignoreFile = fs.readFileSync(path.resolve(__dirname, '..', '.dockerignore'), 'utf8');
  const rules = ignoreFile.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.equal(rules.includes('.env'), true);
  assert.equal(rules.includes('.env.*'), true);
  assert.equal(rules.includes('!.env.example'), true);
  assert.equal(rules.includes('.foxos-data'), true);
  assert.equal(rules.includes('**/node_modules'), true);
});
