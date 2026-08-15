import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../src/apps/CodexApp.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/apps/CodexApp.css', import.meta.url), 'utf8');

test('Codex command cards are collapsible and closed by default', () => {
  assert.match(app, /<details key=\{entry\.id\} className="codex-command-card">/);
  assert.match(app, /<summary className="codex-command-title">/);
  assert.doesNotMatch(app, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(css, /\.codex-command-card\[open\] \.codex-command-chevron/);
});
