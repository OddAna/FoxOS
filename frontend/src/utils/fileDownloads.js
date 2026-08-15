const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg']);
const TEXT_EXTENSIONS = new Set([
  '.bash', '.c', '.conf', '.cpp', '.css', '.csv', '.env', '.go', '.h', '.hpp', '.htm',
  '.html', '.ini', '.java', '.js', '.jsx', '.json', '.log', '.md', '.mjs', '.php', '.properties',
  '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml',
  '.yml', '.zsh'
]);

export const localFileDetails = (href) => {
  let decoded = String(href || '');
  try { decoded = decodeURI(decoded); } catch {}
  decoded = decoded.split(/[?#]/, 1)[0];
  const location = decoded.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const filePath = location ? location[1] : decoded;
  const line = location ? Number(location[2]) : null;
  const name = filePath.split('/').filter(Boolean).at(-1) || filePath;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return { filePath, line, name, ext };
};

export const workspaceFileDownloadUrl = (filePath) => {
  const relativePath = String(filePath || '').replace(/^[/\\]+/, '');
  return relativePath ? `/api/file-download?path=${encodeURIComponent(relativePath)}` : '';
};

export const localFileDownloadUrl = (href) => {
  const { filePath } = localFileDetails(href);
  return filePath.startsWith('/')
    ? workspaceFileDownloadUrl(`/Sunucu${filePath}`)
    : '';
};

export const localFilePreviewKind = (href) => {
  const { ext, line } = localFileDetails(href);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) return 'media';
  if (line || !ext || TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'download';
};
