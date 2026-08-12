const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MediaThumbnailError,
  createMediaThumbnailManager,
  mediaKind,
  pruneCache,
  thumbnailArguments,
  thumbnailProcessArguments
} = require('./mediaThumbnailManager');

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-thumbnails-'));
  const cacheRoot = path.join(root, 'cache');
  let generations = 0;
  const generate = options.generate || (async (_source, output) => {
    generations += 1;
    fs.writeFileSync(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
  const manager = createMediaThumbnailManager({ cacheRoot, generate, ...options });
  return {
    cacheRoot,
    generations: () => generations,
    manager,
    root,
    write(name, contents = 'media') {
      const filePath = path.join(root, name);
      fs.writeFileSync(filePath, contents);
      return filePath;
    }
  };
}

test('media allowlist and sandboxed ffmpeg arguments use one bounded frame without a shell', () => {
  assert.equal(mediaKind('/tmp/photo.JPG'), 'image');
  assert.equal(mediaKind('/tmp/clip.MOV'), 'video');
  assert.equal(mediaKind('/tmp/archive.zip'), null);

  const args = thumbnailArguments('/tmp/source.mov', '/tmp/output.jpg', 'video');
  assert.deepEqual(args.slice(0, 6), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1']);
  assert.ok(args.includes('-ss'));
  assert.ok(args.includes('scale=160:160:force_original_aspect_ratio=increase,crop=160:160'));
  assert.equal(args.at(-1), '/tmp/output.jpg');

  const processArgs = thumbnailProcessArguments('/private/source.mov', '/private/output.jpg', 'video');
  assert.ok(processArgs.includes('--as=536870912'));
  assert.ok(processArgs.includes('/usr/bin/bwrap'));
  assert.ok(processArgs.includes('--unshare-all'));
  assert.ok(processArgs.includes('--clearenv'));
  assert.ok(processArgs.includes('/private/source.mov'));
  assert.ok(processArgs.includes('/input/media.mov'));
  assert.ok(processArgs.includes('/private/output.jpg'));
  assert.ok(processArgs.some((value, index) => value === '--ro-bind' && processArgs[index + 1] === '/lib'));
  assert.equal(processArgs.some((value, index) => value === '--ro-bind' && processArgs[index + 1] === '/'), false);
});

test('thumbnail cache deduplicates concurrent work and invalidates when the source changes', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({
    generate: async (_source, output) => {
      calls += 1;
      await gate;
      fs.writeFileSync(output, 'thumbnail');
    }
  });
  try {
    const source = h.write('clip.mp4');
    const first = h.manager.getThumbnail(source);
    const second = h.manager.getThumbnail(source);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    assert.equal(await first, await second);
    assert.equal(fs.statSync(await first).mode & 0o777, 0o600);

    assert.equal(await h.manager.getThumbnail(source), await first);
    assert.equal(calls, 1);
    fs.appendFileSync(source, '-changed');
    const changed = await h.manager.getThumbnail(source);
    assert.notEqual(changed, await first);
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('thumbnail generation is concurrency-bounded and rejects an overflowing queue', async () => {
  const releases = [];
  let active = 0;
  let peak = 0;
  const h = harness({
    concurrency: 1,
    maxQueue: 1,
    generate: (_source, output) => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      releases.push(() => {
        fs.writeFileSync(output, 'thumbnail');
        active -= 1;
        resolve();
      });
    })
  });
  try {
    const first = h.manager.getThumbnail(h.write('first.jpg'));
    await new Promise((resolve) => setImmediate(resolve));
    const second = h.manager.getThumbnail(h.write('second.jpg'));
    await assert.rejects(
      h.manager.getThumbnail(h.write('third.jpg')),
      (error) => error instanceof MediaThumbnailError && error.code === 'thumbnail-queue-full'
    );
    releases.shift()();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()();
    await second;
    assert.equal(peak, 1);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('cache pruning removes oldest thumbnails only after the hard size ceiling', () => {
  const h = harness();
  try {
    const oldFile = path.join(h.cacheRoot, 'old.jpg');
    const newFile = path.join(h.cacheRoot, 'new.jpg');
    fs.writeFileSync(oldFile, Buffer.alloc(8));
    fs.writeFileSync(newFile, Buffer.alloc(8));
    fs.utimesSync(oldFile, new Date(1_000), new Date(1_000));
    fs.utimesSync(newFile, new Date(2_000), new Date(2_000));
    const result = pruneCache(h.cacheRoot, { maxBytes: 12, targetBytes: 8 });
    assert.equal(result.bytes, 8);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('unsupported files fail before any generator work is scheduled', async () => {
  const h = harness();
  try {
    await assert.rejects(
      h.manager.getThumbnail(h.write('notes.txt')),
      (error) => error instanceof MediaThumbnailError && error.statusCode === 415
    );
    assert.equal(h.generations(), 0);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});
