import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('new owner sessions enter the server-owned onboarding gate before the desktop', () => {
  const auth = read('../src/contexts/AuthContext.jsx');
  const app = read('../src/App.jsx');

  assert.match(auth, /onboardingRequired \? 'needs_onboarding' : 'authenticated'/);
  assert.match(auth, /\/api\/setup\/onboarding\/complete/);
  assert.doesNotMatch(auth, /localStorage|sessionStorage/);
  assert.match(app, /authState === 'needs_onboarding'/);
  assert.match(app, /<ServerOnboarding \/>/);
});

test('first-run onboarding starts the existing read-only scan and keeps migration optional', () => {
  const onboarding = read('../src/components/auth/ServerOnboarding.jsx');
  const migration = read('../src/apps/MigrationSettings.jsx');

  assert.match(onboarding, /<MigrationSettings autoScan/);
  assert.match(onboarding, /finish\('deferred'\)/);
  assert.match(onboarding, /finish\('reviewed'\)/);
  assert.match(migration, /\/api\/resources\/scan/);
  assert.match(migration, /PLAN SERVER MIGRATION/);
  assert.match(migration, /if \(!autoScan \|\| loading \|\| autoScanStartedRef\.current\) return/);
});
