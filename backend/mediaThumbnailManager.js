const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUE = 128;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_CACHE_TARGET_BYTES = 192 * 1024 * 1024;
const THUMBNAIL_ADDRESS_SPACE_BYTES = 512 * 1024 * 1024;
const THUMBNAIL_CPU_SECONDS = 15;
const THUMBNAIL_MAX_OUTPUT_BYTES = 1024 * 1024;
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);

class MediaThumbnailError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = 'MediaThumbnailError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function mediaKind(sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

function statFingerprint(sourcePath, stats) {
  return [
    CACHE_SCHEMA_VERSION,
    sourcePath,
    stats.dev,
    stats.ino,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs
  ].map(String).join('\0');
}

function cacheKey(sourcePath, stats) {
  return crypto.createHash('sha256').update(statFingerprint(sourcePath, stats)).digest('hex');
}

function thumbnailArguments(sourcePath, outputPath, kind) {
  const seek = kind === 'video' ? ['-ss', '0.1'] : [];
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-threads', '1',
    '-filter_threads', '1',
    ...seek,
    '-i', sourcePath,
    '-frames:v', '1',
    '-vf', 'scale=160:160:force_original_aspect_ratio=increase,crop=160:160',
    '-an',
    '-sn',
    '-q:v', '5',
    '-y',
    outputPath
  ];
}

function thumbnailSandboxArguments(sourcePath, outputPath, kind, {
  ffmpegBinary = '/opt/foxos-thumbnailer/bin/ffmpeg'
} = {}) {
  const sandboxSource = '/input/media' + path.extname(sourcePath).toLowerCase();
  const sandboxOutput = '/output/thumbnail.jpg';
  const thumbnailerRoot = path.dirname(path.dirname(ffmpegBinary));
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop', 'ALL',
    '--clearenv',
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'PATH', path.dirname(ffmpegBinary),
    '--setenv', 'LANG', 'C',
    '--setenv', 'LD_LIBRARY_PATH', path.join(thumbnailerRoot, 'lib'),
    '--dir', '/usr',
    '--ro-bind', '/usr/lib', '/usr/lib',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', thumbnailerRoot, thumbnailerRoot,
    '--dir', '/etc',
    '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--dir', '/input',
    '--ro-bind', sourcePath, sandboxSource,
    '--dir', '/output',
    '--bind', outputPath, sandboxOutput,
    '--chdir', '/tmp',
    '--',
    ffmpegBinary,
    ...thumbnailArguments(sandboxSource, sandboxOutput, kind)
  ];
}

function thumbnailProcessArguments(sourcePath, outputPath, kind, {
  sandboxBinary = '/usr/bin/bwrap',
  ffmpegBinary = '/opt/foxos-thumbnailer/bin/ffmpeg'
} = {}) {
  return [
    `--as=${THUMBNAIL_ADDRESS_SPACE_BYTES}`,
    `--cpu=${THUMBNAIL_CPU_SECONDS}`,
    `--fsize=${THUMBNAIL_MAX_OUTPUT_BYTES}`,
    '--nofile=256',
    '--nproc=64',
    '--',
    sandboxBinary,
    ...thumbnailSandboxArguments(sourcePath, outputPath, kind, { ffmpegBinary })
  ];
}

function createFfmpegGenerator({
  resourceLimitBinary = process.env.FOXOS_PRLIMIT_BINARY || '/usr/bin/prlimit',
  sandboxBinary = process.env.FOXOS_BWRAP_BINARY || '/usr/bin/bwrap',
  ffmpegBinary = process.env.FOXOS_FFMPEG_BINARY || '/opt/foxos-thumbnailer/bin/ffmpeg',
  spawnProcess = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  return (sourcePath, outputPath, kind) => new Promise((resolve, reject) => {
    const child = spawnProcess(
      resourceLimitBinary,
      thumbnailProcessArguments(sourcePath, outputPath, kind, { sandboxBinary, ffmpegBinary }),
      {
      stdio: ['ignore', 'ignore', 'pipe']
      }
    );
    let stderr = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new MediaThumbnailError(
        'Thumbnail generation timed out',
        'thumbnail-timeout',
        503
      ));
    }, timeoutMs);
    timeout.unref?.();

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
    });
    child.once('error', () => finish(new MediaThumbnailError(
      'Thumbnail generator is unavailable',
      'thumbnail-generator-unavailable',
      503
    )));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 0) return finish();
      finish(new MediaThumbnailError(
        signal ? 'Thumbnail generation was interrupted' : 'Media could not be decoded',
        signal ? 'thumbnail-interrupted' : 'thumbnail-decode-failed',
        422
      ));
    });
  });
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function pruneCache(cacheRoot, {
  maxBytes = DEFAULT_CACHE_MAX_BYTES,
  targetBytes = DEFAULT_CACHE_TARGET_BYTES,
  now = Date.now()
} = {}) {
  let entries;
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: 0, bytes: 0 };
    throw error;
  }

  const thumbnails = [];
  let totalBytes = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(cacheRoot, entry.name);
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (entry.name.includes('.tmp.')) {
      if (now - stats.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
        safeUnlink(filePath);
        removed += 1;
      }
      continue;
    }
    if (!entry.name.endsWith('.jpg')) continue;
    totalBytes += stats.size;
    thumbnails.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size });
  }

  if (totalBytes <= maxBytes) return { removed, bytes: totalBytes };
  thumbnails.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const thumbnail of thumbnails) {
    if (totalBytes <= targetBytes) break;
    safeUnlink(thumbnail.filePath);
    totalBytes -= thumbnail.size;
    removed += 1;
  }
  return { removed, bytes: totalBytes };
}

function createMediaThumbnailManager({
  cacheRoot,
  concurrency = DEFAULT_CONCURRENCY,
  maxQueue = DEFAULT_MAX_QUEUE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  generate = createFfmpegGenerator({ timeoutMs })
} = {}) {
  if (!cacheRoot || !path.isAbsolute(cacheRoot)) {
    throw new Error('Thumbnail cache root must be an absolute path');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('Thumbnail concurrency must be between 1 and 8');
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 1) {
    throw new Error('Thumbnail queue limit must be positive');
  }

  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(cacheRoot, 0o700);
  try {
    pruneCache(cacheRoot);
  } catch {
    // The disposable cache can recover naturally even if startup pruning fails.
  }

  const inFlight = new Map();
  const queue = [];
  let active = 0;
  let generatedSincePrune = 0;

  const drain = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.work)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  const schedule = (work) => {
    if (queue.length >= maxQueue) {
      throw new MediaThumbnailError(
        'Thumbnail queue is full',
        'thumbnail-queue-full',
        503
      );
    }
    return new Promise((resolve, reject) => {
      queue.push({ work, resolve, reject });
      drain();
    });
  };

  const createThumbnail = async (sourcePath, expectedStats, finalPath) => {
    const temporaryPath = path.join(
      cacheRoot,
      path.basename(finalPath, '.jpg') + '.' + crypto.randomBytes(8).toString('hex') + '.tmp.jpg'
    );
    try {
      fs.writeFileSync(temporaryPath, '', { mode: 0o600, flag: 'wx' });
      await generate(sourcePath, temporaryPath, mediaKind(sourcePath));
      const outputStats = fs.statSync(temporaryPath);
      if (!outputStats.isFile() || outputStats.size === 0) {
        throw new MediaThumbnailError('Thumbnail output was empty', 'thumbnail-empty', 422);
      }

      const currentStats = fs.statSync(sourcePath, { bigint: true });
      if (statFingerprint(sourcePath, currentStats) !== statFingerprint(sourcePath, expectedStats)) {
        throw new MediaThumbnailError('Media changed during thumbnail generation', 'thumbnail-source-changed', 409);
      }

      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, finalPath);
      generatedSincePrune += 1;
      if (generatedSincePrune >= 256) {
        generatedSincePrune = 0;
        try {
          pruneCache(cacheRoot);
        } catch {
          // Cache cleanup failure must not block a valid thumbnail response.
        }
      }
      return finalPath;
    } finally {
      try {
        safeUnlink(temporaryPath);
      } catch {
        // A failed temporary-file cleanup is handled by the next cache prune.
      }
    }
  };

  const getThumbnail = async (sourcePath) => {
    const kind = mediaKind(sourcePath);
    if (!kind) {
      throw new MediaThumbnailError('Unsupported preview format', 'thumbnail-unsupported', 415);
    }

    let sourceStats;
    try {
      sourceStats = fs.statSync(sourcePath, { bigint: true });
    } catch {
      throw new MediaThumbnailError('Media file was not found', 'thumbnail-source-missing', 404);
    }
    if (!sourceStats.isFile()) {
      throw new MediaThumbnailError('Media file was not found', 'thumbnail-source-missing', 404);
    }

    const key = cacheKey(sourcePath, sourceStats);
    const finalPath = path.join(cacheRoot, key + '.jpg');
    try {
      const cachedStats = fs.statSync(finalPath);
      if (cachedStats.isFile() && cachedStats.size > 0) return finalPath;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (inFlight.has(key)) return inFlight.get(key);
    let scheduled;
    try {
      scheduled = schedule(() => createThumbnail(sourcePath, sourceStats, finalPath));
    } catch (error) {
      throw error;
    }
    inFlight.set(key, scheduled);
    scheduled.finally(() => inFlight.delete(key)).catch(() => {});
    return scheduled;
  };

  return {
    getThumbnail,
    prune: (options) => pruneCache(cacheRoot, options),
    status: () => ({ active, queued: queue.length, inFlight: inFlight.size })
  };
}

module.exports = {
  IMAGE_EXTENSIONS,
  MediaThumbnailError,
  VIDEO_EXTENSIONS,
  cacheKey,
  createFfmpegGenerator,
  createMediaThumbnailManager,
  mediaKind,
  pruneCache,
  statFingerprint,
  thumbnailArguments,
  thumbnailProcessArguments,
  thumbnailSandboxArguments
};
