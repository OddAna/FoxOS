const crypto = require('node:crypto');

const AUTHORIZATION_HOST = 'accounts.google.com';
const AUTHORIZATION_PATH = '/o/oauth2/auth';
const AUTHORIZATION_CODE_PATTERN = /^[A-Za-z0-9._~+/=-]{6,2048}$/;
const LOGIN_ID_PATTERN = /^agylogin_[a-f0-9]{32}$/;
const MAX_CAPTURE_BYTES = 128 * 1024;

function normalizeAuthorizationUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' || parsed.hostname !== AUTHORIZATION_HOST ||
    parsed.pathname !== AUTHORIZATION_PATH || parsed.port || parsed.username ||
    parsed.password || parsed.hash || !parsed.searchParams.get('state') ||
    !parsed.searchParams.get('code_challenge') ||
    parsed.searchParams.get('code_challenge_method') !== 'S256'
  ) {
    return null;
  }
  return parsed.toString();
}

function extractAuthorizationUrl(value) {
  const input = String(value || '');
  const candidates = input.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s\x00-\x20\x7f\x1b\x07]+/g) || [];
  for (const candidate of candidates) {
    const normalized = normalizeAuthorizationUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeAuthorizationCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!AUTHORIZATION_CODE_PATTERN.test(code)) {
    const error = new Error('Antigravity doğrulama kodu geçersiz.');
    error.code = 'antigravity-authorization-code-invalid';
    error.statusCode = 400;
    throw error;
  }
  return code;
}

function finalJsonPayload(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const payload = JSON.parse(lines[index]);
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
    } catch {
      // Continue looking for the final structured print-mode response.
    }
  }
  return null;
}

function createControllerError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function createAntigravityLoginController({
  spawnLogin,
  clock = () => new Date(),
  discoveryTimeoutMs = 15_000,
  completionTimeoutMs = 45_000,
  sessionTtlMs = 65_000,
  postSubmissionWaitMs = null,
  postTerminationWaitMs = 0,
  authorizationCodeTerminator = '\n'
}) {
  if (
    typeof spawnLogin !== 'function' || !Number.isInteger(discoveryTimeoutMs) ||
    discoveryTimeoutMs < 100 || !Number.isInteger(completionTimeoutMs) ||
    completionTimeoutMs < 100 || !Number.isInteger(sessionTtlMs) ||
    sessionTtlMs < discoveryTimeoutMs ||
    (postSubmissionWaitMs !== null && (
      !Number.isInteger(postSubmissionWaitMs) || postSubmissionWaitMs < 100 ||
      postSubmissionWaitMs > completionTimeoutMs
    )) || !Number.isInteger(postTerminationWaitMs) || postTerminationWaitMs < 0 ||
    postTerminationWaitMs > 5000 || !['\n', '\r'].includes(authorizationCodeTerminator)
  ) {
    throw new Error('Antigravity login controller requires a bounded process adapter');
  }

  let active = null;

  function clearTimers(record) {
    if (record.discoveryTimer) clearTimeout(record.discoveryTimer);
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    if (record.completionTimer) clearTimeout(record.completionTimer);
    record.discoveryTimer = null;
    record.expiryTimer = null;
    record.completionTimer = null;
  }

  function clearActive(record) {
    clearTimers(record);
    if (active === record) active = null;
  }

  function stopRecord(record) {
    clearActive(record);
    try { record.child.stdin.end(); } catch { /* stream already closed */ }
    try { record.child.kill('SIGTERM'); } catch { /* process already exited */ }
  }

  async function cancelActive() {
    if (!active) return false;
    stopRecord(active);
    return true;
  }

  function attachProcess(record) {
    const append = (chunk) => {
      record.output = (record.output + String(chunk || '')).slice(-MAX_CAPTURE_BYTES);
      if (!record.verificationUrl) {
        const verificationUrl = extractAuthorizationUrl(record.output);
        if (verificationUrl) {
          record.verificationUrl = verificationUrl;
          record.resolveUrl(verificationUrl);
        }
      }
    };
    record.child.stdout.on('data', append);
    record.child.stderr.on('data', append);
    record.child.stdin.on('error', (error) => {
      record.processError = error;
      record.resolveExit({ code: null, signal: null });
    });
    record.child.once('error', (error) => {
      record.processError = error;
      record.resolveExit({ code: null, signal: null });
      if (!record.verificationUrl) record.rejectUrl(error);
    });
    record.child.once('close', (code, signal) => {
      record.exited = true;
      record.resolveExit({ code, signal });
      if (!record.verificationUrl) {
        record.rejectUrl(createControllerError(
          'Antigravity Google giriş bağlantısı üretilemedi.',
          'antigravity-login-url-unavailable',
          502
        ));
      }
    });
  }

  async function start() {
    await cancelActive();
    const child = spawnLogin();
    if (
      !child || !child.stdin || !child.stdout || !child.stderr ||
      typeof child.on !== 'function' || typeof child.kill !== 'function'
    ) {
      throw createControllerError(
        'Antigravity giriş işlemi başlatılamadı.',
        'antigravity-login-process-invalid',
        502
      );
    }

    const record = {
      child,
      loginId: 'agylogin_' + crypto.randomBytes(16).toString('hex'),
      output: '',
      verificationUrl: null,
      submitted: false,
      exited: false,
      processError: null,
      discoveryTimer: null,
      completionTimer: null,
      expiryTimer: null
    };
    record.urlPromise = new Promise((resolve, reject) => {
      record.resolveUrl = resolve;
      record.rejectUrl = reject;
    });
    record.exitPromise = new Promise((resolve) => {
      record.resolveExit = resolve;
    });
    active = record;
    attachProcess(record);

    record.discoveryTimer = setTimeout(() => {
      record.rejectUrl(createControllerError(
        'Antigravity Google giriş bağlantısı zamanında üretilemedi.',
        'antigravity-login-url-timeout',
        504
      ));
      stopRecord(record);
    }, discoveryTimeoutMs);
    record.discoveryTimer.unref?.();

    let verificationUrl;
    try {
      verificationUrl = await record.urlPromise;
    } catch (error) {
      stopRecord(record);
      throw error;
    }
    if (record.discoveryTimer) clearTimeout(record.discoveryTimer);
    record.discoveryTimer = null;

    const expiresAtMs = new Date(clock()).getTime() + sessionTtlMs;
    record.expiryTimer = setTimeout(() => stopRecord(record), sessionTtlMs);
    record.expiryTimer.unref?.();
    return {
      loginId: record.loginId,
      verificationUrl,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  async function complete(loginId, authorizationCode) {
    if (!LOGIN_ID_PATTERN.test(String(loginId || ''))) {
      throw createControllerError('Antigravity giriş kimliği geçersiz.', 'antigravity-login-id-invalid', 400);
    }
    const code = normalizeAuthorizationCode(authorizationCode);
    const record = active;
    if (!record || record.loginId !== loginId || record.exited) {
      throw createControllerError(
        'Antigravity giriş işlemi bulunamadı veya süresi doldu.',
        'antigravity-login-unavailable',
        409
      );
    }
    if (record.submitted) {
      throw createControllerError(
        'Antigravity doğrulama kodu zaten gönderildi.',
        'antigravity-login-code-already-submitted',
        409
      );
    }
    record.submitted = true;
    try {
      await new Promise((resolve, reject) => {
        record.child.stdin.write(
          code + authorizationCodeTerminator,
          (error) => error ? reject(error) : resolve()
        );
      });
    } catch {
      stopRecord(record);
      throw createControllerError(
        'Antigravity giriş işlemi kod gönderilmeden sona erdi.',
        'antigravity-login-code-write-failed',
        409
      );
    }

    const exit = await Promise.race([
      record.exitPromise,
      new Promise((resolve) => {
        record.completionTimer = setTimeout(
          () => resolve({
            code: null,
            signal: postSubmissionWaitMs === null ? 'TIMEOUT' : 'EXTERNAL_VERIFICATION'
          }),
          postSubmissionWaitMs === null ? completionTimeoutMs : postSubmissionWaitMs
        );
      })
    ]);
    if (record.completionTimer) clearTimeout(record.completionTimer);
    record.completionTimer = null;
    if (postSubmissionWaitMs !== null) {
      if (active === record) {
        stopRecord(record);
        let terminationTimer;
        await Promise.race([
          record.exitPromise,
          new Promise((resolve) => {
            terminationTimer = setTimeout(resolve, 3000);
          })
        ]);
        if (terminationTimer) clearTimeout(terminationTimer);
        if (postTerminationWaitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, postTerminationWaitMs));
        }
      } else {
        clearActive(record);
      }
      return { submitted: true, authMode: 'google-oauth' };
    }
    const payload = finalJsonPayload(record.output);
    const succeeded = exit.code === 0 && !record.processError && payload &&
      payload.status !== 'ERROR' && !payload.error;
    if (!succeeded) {
      stopRecord(record);
      throw createControllerError(
        'Antigravity Google hesabı doğrulanamadı. Yeni bir giriş bağlantısı başlatın.',
        exit.signal === 'TIMEOUT' ? 'antigravity-login-completion-timeout' : 'antigravity-login-failed',
        exit.signal === 'TIMEOUT' ? 504 : 409
      );
    }
    clearActive(record);
    return { connected: true, authMode: 'google-oauth' };
  }

  async function cancel(loginId = null) {
    if (loginId !== null && !LOGIN_ID_PATTERN.test(String(loginId || ''))) {
      throw createControllerError('Antigravity giriş kimliği geçersiz.', 'antigravity-login-id-invalid', 400);
    }
    if (!active) return { cancelled: false };
    if (loginId !== null && active.loginId !== loginId) {
      throw createControllerError('Antigravity giriş işlemi bulunamadı.', 'antigravity-login-unavailable', 409);
    }
    stopRecord(active);
    return { cancelled: true };
  }

  return {
    cancel,
    complete,
    inProgress: () => Boolean(active),
    shutdown: cancelActive,
    start
  };
}

module.exports = {
  createAntigravityLoginController,
  extractAuthorizationUrl,
  finalJsonPayload,
  normalizeAuthorizationCode,
  normalizeAuthorizationUrl
};
