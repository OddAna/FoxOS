const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createFileSearchManager,
  normalizeFileSearchText
} = require('./fileSearchManager');

test('file search normalizes Turkish names and finds nested workspace entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-file-search-'));
  try {
    fs.mkdirSync(path.join(root, 'Belgeler', 'Müşteri'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Belgeler', 'Müşteri', 'Çalışma Raporu.txt'), 'test');
    fs.mkdirSync(path.join(root, 'Masaüstü'), { recursive: true });

    const manager = createFileSearchManager({ diskRoot: root, maxScanMs: 10_000 });
    const result = await manager.search('calisma raporu');

    assert.equal(normalizeFileSearchText('Çalışma Raporu'), 'calisma raporu');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].path, '/Belgeler/Müşteri/Çalışma Raporu.txt');
    assert.equal(result.items[0].type, 'file');
    assert.equal(result.truncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file search never follows workspace symlinks and excludes server and trash roots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-file-search-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-file-search-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'gizli-hedef.txt'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'Sunucu'), 'dir');
    fs.symlinkSync(outside, path.join(root, 'Baglanti'), 'dir');
    fs.mkdirSync(path.join(root, 'Çöp Kutusu'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Çöp Kutusu', 'gizli-cop.txt'), 'trash');
    fs.mkdirSync(path.join(root, 'Belgeler'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Belgeler', 'gizli-not.txt'), 'visible');

    const manager = createFileSearchManager({ diskRoot: root, maxScanMs: 10_000 });
    const result = await manager.search('gizli');

    assert.deepEqual(result.items.map((item) => item.path), ['/Belgeler/gizli-not.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('file search validates short queries and bounds result count', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-file-search-'));
  try {
    fs.mkdirSync(path.join(root, 'Belgeler'));
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(path.join(root, 'Belgeler', `not-${index}.txt`), 'note');
    }
    const manager = createFileSearchManager({ diskRoot: root, maxScanMs: 10_000 });
    await assert.rejects(manager.search('n'), (error) => error.code === 'file-search-query-too-short');
    const result = await manager.search('not', { limit: 3 });
    assert.equal(result.items.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
