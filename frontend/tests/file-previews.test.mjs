import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const filesApp = readFileSync(new URL('../src/apps/FilesApp.jsx', import.meta.url), 'utf8');

test('grid files render lazy image and video previews with icon fallback', () => {
  assert.match(filesApp, /IMAGE_PREVIEW_EXTENSIONS/);
  assert.match(filesApp, /VIDEO_PREVIEW_EXTENSIONS/);
  assert.match(filesApp, /loading="lazy"/);
  assert.match(filesApp, /preload="metadata"/);
  assert.match(filesApp, /viewMode === 'list' \|\| failed/);
  assert.match(filesApp, /onError=\{\(\) => setFailed\(true\)\}/);
});

test('preview URLs encode every file path segment', () => {
  assert.match(filesApp, /parts\.map\(encodeURIComponent\)\.join\('\/'\)/);
  assert.match(filesApp, /`\/api\/static\/\$\{/);
});
