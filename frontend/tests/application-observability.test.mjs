import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  formatBytes,
  formatCount,
  formatPercent,
  healthStateLabel,
  healthStateTone,
  metricTrend
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
  assert.equal(formatBytes(null), '—');
  assert.equal(formatPercent(92.34), '%92,3');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatCount(null), '—');
  assert.equal(healthStateLabel({ operationalState: 'running', healthStatus: 'healthy' }), 'Sağlıklı');
  assert.equal(healthStateTone({ operationalState: 'error', healthStatus: 'unhealthy' }), 'critical');
});

test('application observability builds bounded metric trend points without treating missing counters as zero', () => {
  const trend = metricTrend([
    { collectedAt: '2026-08-12T12:00:00.000Z', cpuPercent: null },
    { collectedAt: '2026-08-12T12:05:00.000Z', cpuPercent: 25 },
    { collectedAt: '2026-08-12T12:10:00.000Z', cpuPercent: 50 }
  ], 'cpuPercent', 100);
  assert.equal(trend.count, 2);
  assert.equal(trend.minimum, 25);
  assert.equal(trend.maximum, 50);
  assert.equal(trend.latest.value, 50);
  assert.match(trend.points, /^0\.00,/);
  assert.match(trend.points, /100\.00,/);
});

test('Application Manager reads authenticated observability and exposes metrics, history, alerts and redacted logs', () => {
  assert.match(manager, /<ApplicationObservability application=\{selectedApplication\} \/>/);
  assert.match(observability, /\/observability\?tail=160/);
  assert.match(observability, /METRIC_REFRESH_MS = 15000/);
  assert.match(observability, /document\.visibilityState !== 'hidden'/);
  assert.match(observability, /application-metric-grid/);
  assert.match(observability, /Kaynak eğilimi/);
  assert.match(observability, /Son systemd journal kayıtları/);
  assert.match(observability, /Sağlık geçmişi/);
  assert.match(observability, /Aktif uyarı yok/);
  assert.match(observability, /kimlik bilgisi desenleri yanıttan önce gizlenir/);
  assert.match(observability, /servis dosyası ve ortam içeriği okunmaz/);
  assert.doesNotMatch(observability, /dangerouslySetInnerHTML/);
});
