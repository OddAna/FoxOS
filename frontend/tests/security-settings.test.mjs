import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('security settings expose the complete owner security center', () => {
  const settings = read('../src/apps/SettingsApp.jsx');
  const security = read('../src/apps/SecuritySettings.jsx');

  assert.match(settings, /import SecuritySettings from '\.\/SecuritySettings'/);
  assert.match(settings, /activeTab === 'security' && <SecuritySettings \/>/);
  assert.match(security, /data-security-view="overview"/);
  assert.match(security, /data-security-view="sign-in"/);
  assert.match(security, /data-security-view="sessions"/);
  assert.match(security, /data-security-view="activity"/);
  assert.match(security, /\/api\/security\/overview/);
  assert.match(security, /\/api\/security\/sessions/);
  assert.match(security, /\/api\/security\/events/);
});

test('passkeys use the browser WebAuthn ceremony and recovery codes remain one-time output', () => {
  const security = read('../src/apps/SecuritySettings.jsx');
  const auth = read('../src/contexts/AuthContext.jsx');
  const lockScreen = read('../src/components/auth/LockScreen.jsx');

  assert.match(security, /startRegistration\(\{ optionsJSON: optionsPayload\.options \}\)/);
  assert.match(security, /\/api\/security\/passkeys\/options/);
  assert.match(security, /\/api\/security\/passkeys\/verify/);
  assert.match(security, /\/api\/security\/recovery-codes/);
  assert.match(security, /new Blob\(\[recoveryText\(\)\]/);
  assert.doesNotMatch(security, /localStorage|sessionStorage/);
  assert.match(auth, /startAuthentication\(\{ optionsJSON: optionsPayload\.options \}\)/);
  assert.match(auth, /\/api\/auth\/passkey\/verify/);
  assert.match(auth, /\/api\/auth\/recovery\/reset-password/);
  assert.match(lockScreen, /passkeyAvailable/);
  assert.match(lockScreen, /recoveryAvailable/);
});

test('security layout follows the settings window and has narrow-window modes', () => {
  const security = read('../src/apps/SecuritySettings.jsx');
  const css = read('../src/apps/SecuritySettings.css');

  assert.match(security, /import '\.\/SecuritySettings\.css'/);
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /@container \(max-width: 760px\)/);
  assert.match(css, /@container \(max-width: 540px\)/);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
});
