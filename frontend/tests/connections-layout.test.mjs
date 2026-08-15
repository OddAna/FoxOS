import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('connections use one selectable service directory and one detail surface', () => {
  const app = read('../src/apps/ConnectionsSettings.jsx');

  assert.match(app, /className="connections-directory"/);
  assert.match(app, /className="connections-detail"/);
  assert.match(app, /aria-controls=\{active \? `connection-panel-\${id}` : undefined\}/);

  for (const id of ['calendar', 'codex', 'antigravity', 'gemini', 'cloudflare']) {
    assert.match(app, new RegExp(`id="${id}"`));
    assert.match(app, new RegExp(`activeConnection === '${id}'`));
    assert.match(app, new RegExp(`id="connection-panel-${id}"`));
  }
});

test('connections layout adapts to narrow settings windows without a browser viewport dependency', () => {
  const app = read('../src/apps/ConnectionsSettings.jsx');
  const css = read('../src/apps/ConnectionsSettings.css');

  assert.match(app, /import '\.\/ConnectionsSettings\.css'/);
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /@container \(max-width: 760px\)/);
  assert.match(css, /\.connections-workspace\s*\{[\s\S]*grid-template-columns: minmax\(218px, 238px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.connections-directory\s*\{[\s\S]*overflow-x: auto/);
  assert.match(css, /@container \(max-width: 520px\)[\s\S]*\.connections-detail-grid\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\) !important/);
});
