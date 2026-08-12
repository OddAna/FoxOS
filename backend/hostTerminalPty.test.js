const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createHostTerminalPtyFactory,
  rootLoginShell,
  terminalEnvironment
} = require('./hostTerminalPty');

test('host terminal uses the verified root login shell through nsenter with a minimal environment', (t) => {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-terminal-host-'));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(hostRoot, 'etc'), { recursive: true });
  fs.mkdirSync(path.join(hostRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'etc', 'passwd'), 'root:x:0:0:root:/root:/bin/bash\n');
  fs.writeFileSync(path.join(hostRoot, 'bin', 'bash'), '#!/bin/sh\n');
  fs.chmodSync(path.join(hostRoot, 'bin', 'bash'), 0o755);

  assert.equal(rootLoginShell(hostRoot), '/bin/bash');
  const calls = [];
  const factory = createHostTerminalPtyFactory({
    hostRoot,
    hostExecution: 'nsenter',
    loadPty: () => ({
      spawn(executable, args, options) {
        calls.push({ executable, args, options });
        return { executable, args, options };
      }
    })
  });

  factory({ cols: 120, rows: 36 });
  assert.equal(calls[0].executable, 'nsenter');
  assert.deepEqual(calls[0].args.slice(-3), ['--', '/bin/bash', '-l']);
  assert.ok(calls[0].args.includes('--root=/proc/1/root'));
  assert.ok(calls[0].args.includes('--wd=/proc/1/root'));
  assert.equal(calls[0].options.cols, 120);
  assert.equal(calls[0].options.rows, 36);
  assert.equal(calls[0].options.cwd, '/');
  assert.equal(calls[0].options.env.HOME, '/root');
  assert.equal(calls[0].options.env.TERM, 'xterm-256color');
  assert.equal('FOXOS_SECRET' in calls[0].options.env, false);
});

test('terminal environment ignores unsafe inherited locale values and exposes no unrelated variables', () => {
  const environment = terminalEnvironment('/bin/sh', {
    LANG: 'bad locale; value',
    FOXOS_SECRET: 'do-not-copy'
  });
  assert.equal(environment.LANG, 'C.UTF-8');
  assert.equal(environment.SHELL, '/bin/sh');
  assert.equal(environment.FOXOS_SECRET, undefined);
});
