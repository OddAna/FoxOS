import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.resolve(root, relative), 'utf8');

test('menu bar exposes cached CLI usage with provider windows and manual refresh', () => {
  const topBar = read('../src/components/TopBar.jsx');
  const menu = read('../src/components/CliUsageMenu.jsx');

  assert.match(topBar, /import CliUsageMenu from '\.\/CliUsageMenu'/);
  assert.match(topBar, /<CliUsageMenu \/>/);
  assert.match(menu, /apiFetch\(force \? '\/api\/cli-usage\/refresh' : '\/api\/cli-usage'/);
  assert.match(menu, /minimumRemainingPercent/);
  assert.match(menu, /provider\.windows/);
  assert.match(menu, /window\.remainingPercent/);
  assert.match(menu, /createPortal\(/);
  assert.match(menu, /POLL_INTERVAL_MS = 5 \* 60 \* 1000/);
});

test('CLI usage popover keeps its mobile boundary above the Dock', () => {
  const css = read('../src/index.css');
  assert.match(css, /\.topbar-cli-usage-trigger\s*\{/);
  assert.match(css, /\.cli-usage-popover\s*\{/);
  assert.match(css, /bottom:\s*calc\(var\(--foxos-dock-reserve\) \+ 6px\)/);
  assert.match(css, /\.cli-usage-meter span\s*\{/);
});
