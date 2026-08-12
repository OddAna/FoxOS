import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  formatBytes,
  formatPercent,
  healthStateLabel,
  healthStateTone
} from '../src/utils/applicationObservability.js';

const observability = readFileSync(
  new URL('../src/apps/ApplicationObservability.jsx', import.meta.url),
  'utf8'
);
const manager = readFileSync(new URL('../src/apps/ApplicationManager.jsx', import.meta.url), 'utf8');

test('application observability formats bounded resource readings and health states', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatPercent(92.34), '%92,3');
  assert.equal(healthStateLabel({ operationalState: 'running', healthStatus: 'healthy' }), 'Sağlıklı');
  assert.equal(healthStateTone({ operationalState: 'error', healthStatus: 'unhealthy' }), 'critical');
});

test('Application Manager reads authenticated observability and exposes metrics, history, alerts and redacted logs', () => {
  assert.match(manager, /<ApplicationObservability application=\{selectedApplication\} \/>/);
  assert.match(observability, /\/observability\?tail=160/);
  assert.match(observability, /METRIC_REFRESH_MS = 15000/);
  assert.match(observability, /document\.visibilityState !== 'hidden'/);
  assert.match(observability, /application-metric-grid/);
  assert.match(observability, /Sağlık geçmişi/);
  assert.match(observability, /Aktif uyarı yok/);
  assert.match(observability, /kimlik bilgisi desenleri yanıttan önce gizlenir/);
  assert.doesNotMatch(observability, /dangerouslySetInnerHTML/);
});
