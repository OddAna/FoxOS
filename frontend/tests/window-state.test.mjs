import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateExistingWindow,
  focusWindowById,
  topWindowZIndex
} from '../src/utils/windowState.js';

test('opening an existing dock app restores it and raises it above the active window', () => {
  const windows = [
    { id: 'terminal', type: 'terminal', zIndex: 101, isMinimized: true },
    { id: 'codex', type: 'codex', zIndex: 108, isMinimized: false }
  ];
  const activated = activateExistingWindow(windows, { id: 'terminal', navigation: 'session' });

  assert.equal(topWindowZIndex(windows), 108);
  assert.equal(activated.find((windowState) => windowState.id === 'terminal').zIndex, 109);
  assert.equal(activated.find((windowState) => windowState.id === 'terminal').isMinimized, false);
  assert.equal(activated.find((windowState) => windowState.id === 'terminal').navigation, 'session');
  assert.deepEqual(activated.find((windowState) => windowState.id === 'codex'), windows[1]);
});

test('focusing a window is a single deterministic state transition', () => {
  const windows = [
    { id: 'terminal', zIndex: 102 },
    { id: 'codex', zIndex: 105 }
  ];
  const focused = focusWindowById(windows, 'terminal');
  assert.equal(focused[0].zIndex, 106);
  assert.equal(focused[1].zIndex, 105);
  assert.equal(focusWindowById(windows, 'missing'), windows);
});
