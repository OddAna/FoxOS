const ICON_CACHE = new Map();
const ICON_CACHE_TTL_MS = 60 * 60 * 1000;
const ICON_FETCH_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_ICON_BYTES = 1024 * 1024;

function safeHttpUrl(value, baseUrl = undefined) {
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    if (!/^[a-z0-9.-]+$/i.test(url.hostname)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function attributeValue(tag, attribute) {
  const match = tag.match(new RegExp('\\b' + attribute + '\\s*=\\s*["\\\']([^"\\\']+)["\\\']', 'i'));
  return match ? match[1] : null;
}

function iconCandidatesFromHtml(html, baseUrl) {
  const candidates = [];
  for (const match of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attributeValue(tag, 'rel');
    const href = attributeValue(tag, 'href');
    if (!rel || !href || !/(^|\s)(shortcut\s+icon|icon|apple-touch-icon|mask-icon)(\s|$)/i.test(rel)) {
      continue;
    }

    if (/^data:image\//i.test(href)) {
      candidates.push(href);
      continue;
    }

    const resolved = safeHttpUrl(href, baseUrl);
    if (resolved) {
      candidates.push(resolved.toString());
    }
  }
  return [...new Set(candidates)];
}

async function readLimitedBody(response, maximumBytes) {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new Error('Remote icon response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function decodeDataImage(value) {
  const match = String(value).match(/^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is);
  if (!match) {
    return null;
  }

  try {
    const buffer = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    if (!buffer.length || buffer.length > MAX_ICON_BYTES) {
      return null;
    }
    return { buffer, contentType: match[1].toLowerCase() };
  } catch {
    return null;
  }
}

async function fetchRemote(url, maximumBytes) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'FoxOS/0.0.2 app-icon-discovery' }
  });
  if (!safeHttpUrl(response.url)) {
    await response.body?.cancel();
    return null;
  }
  const buffer = await readLimitedBody(response, maximumBytes);
  return { response, buffer };
}

async function fetchImage(candidate) {
  if (/^data:image\//i.test(candidate)) {
    return decodeDataImage(candidate);
  }

  const url = safeHttpUrl(candidate);
  if (!url) {
    return null;
  }

  try {
    const result = await fetchRemote(url, MAX_ICON_BYTES);
    if (!result || !result.response.ok) {
      return null;
    }
    const contentType = (result.response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/') || !result.buffer.length) {
      return null;
    }
    return { buffer: result.buffer, contentType };
  } catch {
    return null;
  }
}

function cacheIcon(key, icon) {
  if (ICON_CACHE.size >= 256) {
    ICON_CACHE.delete(ICON_CACHE.keys().next().value);
  }
  ICON_CACHE.set(key, { icon, expiresAt: Date.now() + ICON_CACHE_TTL_MS });
  return icon;
}

async function resolveAppIcon(appState) {
  const baseUrl = safeHttpUrl(appState && appState.externalUrl);
  if (!baseUrl) {
    return null;
  }

  const cacheKey = appState.id + ':' + baseUrl.origin;
  const cached = ICON_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.icon;
  }

  const candidates = [];
  try {
    const page = await fetchRemote(baseUrl, MAX_HTML_BYTES);
    if (page) {
      const contentType = (page.response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        candidates.push(...iconCandidatesFromHtml(page.buffer.toString('utf8'), page.response.url));
      }
    }
  } catch {
    // Conventional favicon paths below remain useful when the page cannot be read.
  }

  candidates.push(
    new URL('/favicon.ico', baseUrl).toString(),
    new URL('/favicon.svg', baseUrl).toString()
  );

  for (const candidate of [...new Set(candidates)]) {
    const icon = await fetchImage(candidate);
    if (icon) {
      return cacheIcon(cacheKey, icon);
    }
  }

  return cacheIcon(cacheKey, null);
}

module.exports = { iconCandidatesFromHtml, resolveAppIcon, safeHttpUrl };
