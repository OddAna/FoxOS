import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../src/apps/CodexApp.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/apps/CodexApp.css', import.meta.url), 'utf8');

test('Codex keeps redundant actions out of the top bar', () => {
  const topbar = app.match(/<header className="codex-topbar">([\s\S]*?)<\/header>/)?.[1] || '';

  assert.doesNotMatch(topbar, />Yeni konuşma</);
  assert.doesNotMatch(topbar, />Bağlantı</);
  assert.match(topbar, /codex-icon-button/);
  assert.match(topbar, /codex-brand-title/);
});

test('model, reasoning, and permission controls live in the composer footer', () => {
  assert.doesNotMatch(app, /className="codex-config-row"/);

  const footer = app.match(/<div className="codex-composer-footer">([\s\S]*?)<div className="codex-composer-actions">/)?.[1] || '';
  assert.match(footer, /className="codex-composer-controls"/);
  assert.match(footer, /aria-label=\{t\('codexApp\.modelLabel'\)\}/);
  assert.match(footer, /aria-label=\{t\('codexApp\.reasoningLabel'\)\}/);
  assert.match(footer, /aria-label=\{t\('codexApp\.permissionLabel'\)\}/);
  assert.match(css, /\.codex-composer-controls\s*\{/);
  assert.match(css, /\.codex-composer-control\.is-permission\s*\{/);
});
