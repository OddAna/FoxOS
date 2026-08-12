import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const filesApp = readFileSync(new URL('../src/apps/FilesApp.jsx', import.meta.url), 'utf8');

test('grid files render lazy cached thumbnails with icon fallback', () => {
  assert.match(filesApp, /IMAGE_PREVIEW_EXTENSIONS/);
  assert.match(filesApp, /VIDEO_PREVIEW_EXTENSIONS/);
  assert.match(filesApp, /loading="lazy"/);
  assert.match(filesApp, /decoding="async"/);
  assert.match(filesApp, /\/api\/file-thumbnail\?path=/);
  assert.match(filesApp, /ext === '\.svg' \? staticFileUrl/);
  assert.doesNotMatch(filesApp, /<video/);
  assert.match(filesApp, /viewMode === 'list' \|\| failed/);
  assert.match(filesApp, /onError=\{\(\) => setFailed\(true\)\}/);
});

test('preview URLs encode every file path segment', () => {
  assert.match(filesApp, /encodeURIComponent\(parts\.join\('\/'\)\)/);
  assert.match(filesApp, /`\/api\/file-thumbnail\?path=\$\{/);
  assert.match(filesApp, /encodeURIComponent\(revision\)/);
});
