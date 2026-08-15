const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXCLUDED_ROOTS = ['Sunucu', 'Çöp Kutusu'];

const TURKISH_ASCII_EQUIVALENTS = {
  ç: 'c',
  ğ: 'g',
  ı: 'i',
  ö: 'o',
  ş: 's',
  ü: 'u'
};

class FileSearchError extends Error {
  constructor(message, statusCode = 400, code = 'file-search-error') {
    super(message);
    this.name = 'FileSearchError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeFileSearchText(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[çğıöşü]/g, (character) => TURKISH_ASCII_EQUIVALENTS[character])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function searchScore(entry, query) {
  const normalizedName = normalizeFileSearchText(entry.name);
  const normalizedPath = normalizeFileSearchText(entry.path);
  const tokens = query.split(' ').filter(Boolean);
  if (!tokens.every((token) => normalizedPath.includes(token))) return null;
  if (normalizedName === query) return 0;
  if (normalizedName.startsWith(query)) return 10;
  if (normalizedName.split(' ').some((word) => word.startsWith(query))) return 20;
  if (normalizedName.includes(query)) return 30;
  return 50;
}

function createFileSearchManager({
  diskRoot,
  excludedRootNames = DEFAULT_EXCLUDED_ROOTS,
  followedSymlinkRootNames = [],
  allowedSymlinkTargetRoots = [],
  maxDepth = 12,
  maxEntries = 20_000,
  maxScanMs = 350,
  cacheTtlMs = 5_000,
  clock = () => Date.now()
}) {
  if (typeof diskRoot !== 'string' || !path.isAbsolute(diskRoot)) {
    throw new TypeError('File search manager requires an absolute disk root');
  }
  if (![maxDepth, maxEntries, maxScanMs, cacheTtlMs].every(Number.isSafeInteger)) {
    throw new TypeError('File search manager limits must be integers');
  }
  if (
    !Array.isArray(followedSymlinkRootNames) ||
    followedSymlinkRootNames.some((name) => (
      typeof name !== 'string' || !name.trim() || name.includes('/') || name.includes('\\')
    ))
  ) {
    throw new TypeError('Followed symlink roots must be workspace root names');
  }
  if (
    !Array.isArray(allowedSymlinkTargetRoots) ||
    allowedSymlinkTargetRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))
  ) {
    throw new TypeError('Allowed symlink target roots must be absolute paths');
  }

  const excludedRoots = new Set(excludedRootNames.map(String));
  const followedSymlinkRoots = new Set(followedSymlinkRootNames.map((name) => name.trim()));
  let cachedIndex = null;
  let indexPromise = null;

  async function buildIndex() {
    const startedAt = clock();
    let realRoot;
    try {
      realRoot = await fs.promises.realpath(diskRoot);
    } catch (error) {
      throw new FileSearchError(
        error.code === 'ENOENT' ? 'FoxOS dosya alanı bulunamadı.' : 'FoxOS dosya alanı okunamadı.',
        503,
        'file-search-workspace-unavailable'
      );
    }

    const allowedRealSymlinkRoots = [realRoot];
    for (const allowedRoot of allowedSymlinkTargetRoots) {
      try {
        allowedRealSymlinkRoots.push(await fs.promises.realpath(allowedRoot));
      } catch {
        // An unavailable optional target root cannot authorize traversal.
      }
    }

    const queue = [{
      absolutePath: diskRoot,
      relativePath: '',
      depth: 0,
      realBoundary: realRoot,
      realAncestors: [],
      allowDirectorySymlink: false,
      insideFollowedSymlink: false
    }];
    let queueIndex = 0;
    const entries = [];
    let visited = 0;
    let truncated = false;

    while (queueIndex < queue.length) {
      if (visited >= maxEntries || clock() - startedAt >= maxScanMs) {
        truncated = true;
        break;
      }

      const directory = queue[queueIndex];
      queueIndex += 1;
      let realAncestors;
      try {
        const directoryStats = await fs.promises.lstat(directory.absolutePath);
        if (directoryStats.isSymbolicLink()) {
          if (!directory.allowDirectorySymlink) continue;
          const targetStats = await fs.promises.stat(directory.absolutePath);
          if (!targetStats.isDirectory()) continue;
        } else if (!directoryStats.isDirectory()) {
          continue;
        }
        const realDirectory = await fs.promises.realpath(directory.absolutePath);
        if (!isWithinRoot(directory.realBoundary, realDirectory)) continue;
        if (directory.realAncestors.includes(realDirectory)) continue;
        realAncestors = [...directory.realAncestors, realDirectory];
      } catch {
        continue;
      }

      let children;
      try {
        children = await fs.promises.readdir(directory.absolutePath, { withFileTypes: true });
      } catch {
        continue;
      }
      children.sort((left, right) => left.name.localeCompare(right.name, 'tr'));

      for (const child of children) {
        if (visited >= maxEntries || clock() - startedAt >= maxScanMs) {
          truncated = true;
          break;
        }
        if (!directory.relativePath && excludedRoots.has(child.name)) continue;

        const absolutePath = path.join(directory.absolutePath, child.name);
        const relativePath = directory.relativePath
          ? path.join(directory.relativePath, child.name)
          : child.name;
        let stats;
        try {
          stats = await fs.promises.lstat(absolutePath);
        } catch {
          continue;
        }
        visited += 1;

        if (stats.isSymbolicLink()) {
          const rootName = relativePath.split(path.sep)[0];
          if (directory.insideFollowedSymlink || !followedSymlinkRoots.has(rootName)) continue;

          let targetStats;
          let realTarget;
          try {
            targetStats = await fs.promises.stat(absolutePath);
            realTarget = await fs.promises.realpath(absolutePath);
          } catch {
            continue;
          }
          if (!allowedRealSymlinkRoots.some((root) => isWithinRoot(root, realTarget))) continue;

          const type = targetStats.isDirectory() ? 'folder' : targetStats.isFile() ? 'file' : null;
          if (!type) continue;
          const workspacePath = '/' + relativePath.split(path.sep).join('/');
          entries.push({
            id: crypto.createHash('sha1').update(workspacePath).digest('hex').slice(0, 16),
            name: child.name,
            path: workspacePath,
            parentPath: '/' + path.dirname(relativePath).split(path.sep).join('/').replace(/^\.$/, ''),
            type,
            ext: type === 'file' ? path.extname(child.name).toLowerCase() : null,
            size: type === 'file' ? targetStats.size : 0,
            mtime: targetStats.mtime.toISOString(),
            symlink: true
          });

          if (type === 'folder' && directory.depth < maxDepth && !realAncestors.includes(realTarget)) {
            queue.push({
              absolutePath,
              relativePath,
              depth: directory.depth + 1,
              realBoundary: realTarget,
              realAncestors,
              allowDirectorySymlink: true,
              insideFollowedSymlink: true
            });
          } else if (type === 'folder' && directory.depth >= maxDepth) {
            truncated = true;
          }
          continue;
        }

        const type = stats.isDirectory() ? 'folder' : stats.isFile() ? 'file' : null;
        if (!type) continue;
        const workspacePath = '/' + relativePath.split(path.sep).join('/');
        entries.push({
          id: crypto.createHash('sha1').update(workspacePath).digest('hex').slice(0, 16),
          name: child.name,
          path: workspacePath,
          parentPath: '/' + path.dirname(relativePath).split(path.sep).join('/').replace(/^\.$/, ''),
          type,
          ext: type === 'file' ? path.extname(child.name).toLowerCase() : null,
          size: type === 'file' ? stats.size : 0,
          mtime: stats.mtime.toISOString(),
          symlink: false
        });

        if (type === 'folder' && directory.depth < maxDepth) {
          queue.push({
            absolutePath,
            relativePath,
            depth: directory.depth + 1,
            realBoundary: directory.realBoundary,
            realAncestors,
            allowDirectorySymlink: false,
            insideFollowedSymlink: directory.insideFollowedSymlink
          });
        } else if (type === 'folder' && directory.depth >= maxDepth) {
          truncated = true;
        }
      }
    }

    return {
      builtAt: clock(),
      entries,
      scannedEntries: visited,
      truncated
    };
  }

  async function getIndex() {
    const now = clock();
    if (cachedIndex && now - cachedIndex.builtAt < cacheTtlMs) return cachedIndex;
    if (indexPromise) return indexPromise;
    indexPromise = buildIndex()
      .then((index) => {
        cachedIndex = index;
        return index;
      })
      .finally(() => {
        indexPromise = null;
      });
    return indexPromise;
  }

  async function search(query, { limit = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 120 || query.includes('\0')) {
      throw new FileSearchError('Dosya arama sorgusu geçersiz.', 400, 'file-search-query-invalid');
    }
    const normalizedQuery = normalizeFileSearchText(query);
    if (normalizedQuery.length < 2) {
      throw new FileSearchError('Dosya araması için en az 2 karakter girin.', 400, 'file-search-query-too-short');
    }
    const boundedLimit = Math.max(1, Math.min(30, Number.parseInt(limit, 10) || 20));
    const index = await getIndex();
    const items = index.entries
      .map((entry) => ({ entry, score: searchScore(entry, normalizedQuery) }))
      .filter((candidate) => candidate.score !== null)
      .sort((left, right) => (
        left.score - right.score ||
        (left.entry.type === right.entry.type ? 0 : left.entry.type === 'folder' ? -1 : 1) ||
        left.entry.path.localeCompare(right.entry.path, 'tr')
      ))
      .slice(0, boundedLimit)
      .map((candidate) => candidate.entry);

    return {
      query: query.trim(),
      items,
      scannedEntries: index.scannedEntries,
      truncated: index.truncated
    };
  }

  return {
    invalidate: () => { cachedIndex = null; },
    search
  };
}

module.exports = {
  DEFAULT_EXCLUDED_ROOTS,
  FileSearchError,
  createFileSearchManager,
  normalizeFileSearchText
};
