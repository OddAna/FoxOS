import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  localFileDetails,
  localFileDownloadUrl,
  localFilePreviewKind,
  workspaceFileDownloadUrl
} from '../src/utils/fileDownloads.js';

const codexMarkdown = readFileSync(new URL('../src/apps/CodexMarkdown.jsx', import.meta.url), 'utf8');
const filesApp = readFileSync(new URL('../src/apps/FilesApp.jsx', import.meta.url), 'utf8');

test('server file download URLs use the authenticated workspace endpoint', () => {
  assert.equal(
    workspaceFileDownloadUrl('/Sunucu/var/lib/foxos/codex/outputs/Oredata kapakları.zip'),
    '/api/file-download?path=Sunucu%2Fvar%2Flib%2Ffoxos%2Fcodex%2Foutputs%2FOredata%20kapaklar%C4%B1.zip'
  );
  assert.equal(
    localFileDownloadUrl('/var/lib/foxos/codex/outputs/Oredata%20kapaklar%C4%B1.zip'),
    '/api/file-download?path=Sunucu%2Fvar%2Flib%2Ffoxos%2Fcodex%2Foutputs%2FOredata%20kapaklar%C4%B1.zip'
  );
  assert.equal(localFileDownloadUrl('relative/file.zip'), '');
});

test('Codex local file metadata preserves source locations and chooses safe previews', () => {
  assert.deepEqual(localFileDetails('/opt/foxos/backend/server.js:2400:7'), {
    filePath: '/opt/foxos/backend/server.js',
    line: 2400,
    name: 'server.js',
    ext: '.js'
  });
  assert.equal(localFilePreviewKind('/tmp/kapak.webp'), 'image');
  assert.equal(localFilePreviewKind('/tmp/demo.mp4'), 'media');
  assert.equal(localFilePreviewKind('/tmp/archive.zip'), 'download');
  assert.equal(localFilePreviewKind('/tmp/README'), 'text');
});

test('Codex and Files surfaces expose an explicit file download action', () => {
  assert.match(codexMarkdown, /codex-local-file-download/);
  assert.match(codexMarkdown, /codexApp\.downloadFile/);
  assert.match(filesApp, /handleDownload/);
  assert.match(filesApp, /t\('filesApp\.download'\)/);
});
