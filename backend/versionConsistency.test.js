const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const backendPackage = require('./package.json');
const backendLock = require('./package-lock.json');
const frontendPackage = require('../frontend/package.json');
const frontendLock = require('../frontend/package-lock.json');

const repoRoot = path.resolve(__dirname, '..');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('FoxOS product version declarations stay synchronized', () => {
  const version = backendPackage.version;
  const escapedVersion = escapeRegExp(version);

  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(backendLock.version, version);
  assert.equal(backendLock.packages[''].version, version);
  assert.equal(frontendPackage.version, version);
  assert.equal(frontendLock.version, version);
  assert.equal(frontendLock.packages[''].version, version);

  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`FoxOS-v${escapedVersion}_alpha`));
  assert.match(readme, new RegExp('FoxOS `v' + escapedVersion + '` is an \\*\\*alpha release\\*\\*'));
  assert.match(readme, new RegExp(`## v${escapedVersion} capabilities`));
});
