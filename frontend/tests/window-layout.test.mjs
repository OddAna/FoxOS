import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearWindowLayouts,
  readWindowLayout,
  WINDOW_LAYOUT_STORAGE_KEY,
  writeWindowLayouts
} from '../src/utils/windowLayout.js';

test('window layouts persist bounded geometry and can be cleared without affecting other storage', () => {
  const values = new Map([['unrelated', 'keep']]);
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    }
  };

  try {
    writeWindowLayouts([{ id: 'settings', x: 12.4, y: 28.7, width: 120, height: 90, isMaximized: true }]);
    assert.deepEqual(readWindowLayout('settings'), {
      x: 12,
      y: 29,
      width: 300,
      height: 200,
      isMaximized: true
    });
    assert.ok(values.has(WINDOW_LAYOUT_STORAGE_KEY));
    clearWindowLayouts();
    assert.equal(readWindowLayout('settings'), null);
    assert.equal(values.get('unrelated'), 'keep');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
