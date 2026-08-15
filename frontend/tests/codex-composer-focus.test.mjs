import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/apps/CodexApp.css', import.meta.url), 'utf8');

test('Codex composer keeps its designed surface without a focus ring', () => {
  assert.match(
    css,
    /\.codex-composer textarea:focus,\s*\.codex-composer textarea:focus-visible\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s
  );
});
