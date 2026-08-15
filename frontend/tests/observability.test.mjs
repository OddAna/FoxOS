import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('Settings exposes an authenticated read-only Observability Center', () => {
  const settings = read('../src/apps/SettingsApp.jsx');
  const observability = read('../src/apps/ObservabilitySettings.jsx');

  assert.match(settings, /import ObservabilitySettings from '\.\/ObservabilitySettings'/);
  assert.match(settings, /id: 'observability'/);
  assert.match(settings, /activeTab === 'observability' && <ObservabilitySettings/);
  assert.match(observability, /\/api\/observability\/overview/);
  assert.match(observability, /\/api\/observability\/refresh/);
  assert.match(observability, /\/api\/observability\/diagnostics/);
  assert.match(observability, /window\.setInterval\(\(\) => loadOverview\(\{ quiet: true \}\), 30_000\)/);
  assert.match(observability, /redacted-diagnostics/);
  assert.match(observability, /overview\.activeAlerts/);
  assert.match(observability, /overview\.recentEvents/);
});

test('Application Manager includes summary, metrics, redacted logs and events without lifecycle actions', () => {
  const manager = read('../src/apps/ApplicationManager.jsx');
  const panel = read('../src/apps/ApplicationObservabilityPanel.jsx');

  assert.match(manager, /import ApplicationObservabilityPanel from '\.\/ApplicationObservabilityPanel'/);
  assert.match(manager, /<ApplicationObservabilityPanel application=\{selectedApplication\} \/>/);
  assert.match(panel, /\/api\/applications\/\$\{encodeURIComponent\(applicationId\)\}\/observability/);
  assert.match(panel, /\/api\/applications\/\$\{encodeURIComponent\(applicationId\)\}\/logs/);
  assert.match(panel, /window\.setInterval\(\(\) => loadLogs\(\{ quiet: true \}\), 5_000\)/);
  assert.match(panel, /logsPrivacy/);
  assert.match(panel, /URLSearchParams\(\{ applicationId \}\)/);
  assert.doesNotMatch(panel, /\/start|\/stop|\/restart|\/update-plans/);
});

test('observability layouts respond to both wide and narrow settings windows', () => {
  const centerCss = read('../src/apps/ObservabilitySettings.css');
  const applicationCss = read('../src/apps/ApplicationObservabilityPanel.css');

  for (const css of [centerCss, applicationCss]) {
    assert.match(css, /container-type: inline-size/);
    assert.match(css, /@container \(max-width: 720px\)/);
    assert.match(css, /@container \(max-width: 540px\)/);
  }
  assert.match(centerCss, /\.observability-metric-grid/);
  assert.match(applicationCss, /\.application-observability-log-view/);
});
