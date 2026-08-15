import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('Host Terminal uses xterm over the authenticated same-origin WebSocket', () => {
  const terminal = read('../src/apps/TerminalApp.jsx');

  assert.match(terminal, /from '@xterm\/xterm'/);
  assert.match(terminal, /from '@xterm\/addon-fit'/);
  assert.match(terminal, /new WebSocket\(terminalSocketUrl\(\)\)/);
  assert.match(terminal, /\/api\/terminal\/socket/);
  assert.match(terminal, /type: 'input'/);
  assert.match(terminal, /type: 'resize'/);
  assert.doesNotMatch(terminal, /fetch\('\/api\/terminal'/);
});

test('minimizing keeps app state mounted and Dock activation can restore the same window', () => {
  const windowComponent = read('../src/components/Window.jsx');
  const windowContext = read('../src/contexts/WindowContext.jsx');

  assert.match(windowComponent, /display: win\.isMinimized \? 'none' : 'flex'/);
  assert.doesNotMatch(windowComponent, /if \(win\.isMinimized\) return null/);
  assert.match(windowContext, /activateExistingWindow\(prev, appConfig\)/);
  assert.match(windowContext, /setFocusedWindowId\(appConfig\.id\)/);
});
