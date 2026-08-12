import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/apps/CodexApp.jsx', import.meta.url),
  'utf8'
);

test('Codex approval policy is server-owned across browsers', () => {
  assert.match(source, /useState\(DEFAULT_APPROVAL_POLICY\)/);
  assert.match(source, /nextConnection\.approvalPolicy/);
  assert.match(source, /\/api\/connections\/codex\/approval-policy/);
  assert.match(source, /removePreference\(LEGACY_APPROVAL_POLICY_STORAGE_KEY\)/);
  assert.doesNotMatch(source, /savePreference\(LEGACY_APPROVAL_POLICY_STORAGE_KEY/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{ text, approvalPolicy \}\)/);
});
