const fs = require('node:fs');
const http = require('node:http');

const DEFAULT_JSON_LIMIT = 16 * 1024 * 1024;
const DEFAULT_ARCHIVE_LIMIT = 64 * 1024 * 1024;
const DEFAULT_BUILD_LOG_LIMIT = 8 * 1024 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

function createDockerClient(socketPath) {
  if (!socketPath) {
    throw new Error('Docker client requires a socket path');
  }

  function requestRaw(method, requestPath, payload, options = {}) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(socketPath)) {
        return reject(new Error('Docker socket is not available'));
      }

      const body = payload === null || payload === undefined
        ? null
        : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
      const headers = {
        'Content-Type': options.contentType || 'application/json'
      };
      if (body !== null) {
        headers['Content-Length'] = body.length;
      }

      const maxResponseBytes = options.maxResponseBytes || DEFAULT_JSON_LIMIT;
      const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 0;
      let settled = false;
      const finish = (operation) => {
        if (settled) return;
        settled = true;
        operation();
      };

      const dockerRequest = http.request({
        socketPath,
        path: requestPath,
        method,
        headers
      }, (response) => {
        const chunks = [];
        let received = 0;

        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxResponseBytes) {
            response.destroy();
            return finish(() => reject(new Error('Docker API response exceeded the configured safety limit')));
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          if (settled) return;
          const responseBody = Buffer.concat(chunks);
          if ((response.statusCode >= 200 && response.statusCode < 300) || response.statusCode === 304) {
            return finish(() => resolve(responseBody));
          }

          let message = 'Docker API returned HTTP ' + response.statusCode;
          const text = responseBody.toString('utf8');
          try {
            message = JSON.parse(text).message || message;
          } catch {
            if (text) message = text;
          }
          finish(() => reject(new Error(message)));
        });
      });

      dockerRequest.on('error', (error) => finish(() => reject(error)));
      if (timeoutMs > 0) {
        dockerRequest.setTimeout(timeoutMs, () => {
          dockerRequest.destroy();
          finish(() => reject(new Error('Docker API request timed out')));
        });
      }
      if (body !== null) dockerRequest.write(body);
      dockerRequest.end();
    });
  }

  async function request(method, requestPath, payload = null) {
    const body = payload === null ? null : JSON.stringify(payload);
    const response = await requestRaw(method, requestPath, body, {
      contentType: 'application/json',
      maxResponseBytes: DEFAULT_JSON_LIMIT
    });
    if (!response.length) return null;
    const text = response.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function requestBuffer(method, requestPath, payload = null) {
    return requestRaw(method, requestPath, payload, {
      contentType: 'application/x-tar',
      maxResponseBytes: DEFAULT_ARCHIVE_LIMIT
    });
  }

  function requestBuild(requestPath, buildContext) {
    return requestRaw('POST', requestPath, buildContext, {
      contentType: 'application/x-tar',
      maxResponseBytes: DEFAULT_BUILD_LOG_LIMIT,
      timeoutMs: DEFAULT_BUILD_TIMEOUT_MS
    });
  }

  async function exec(containerId, command, options = {}) {
    if (!/^[a-f0-9]{12,64}$/i.test(String(containerId || ''))) {
      throw new Error('Docker exec requires an exact container ID');
    }
    if (
      !Array.isArray(command) || command.length < 1 || command.length > 32 ||
      command.some((value) => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))
    ) {
      throw new Error('Docker exec command is invalid');
    }
    const created = await request('POST', '/containers/' + containerId + '/exec', {
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: command
    });
    if (!created || !/^[a-f0-9]{12,64}$/i.test(String(created.Id || ''))) {
      throw new Error('Docker did not return an exec identity');
    }
    const output = await requestRaw('POST', '/exec/' + created.Id + '/start', JSON.stringify({
      Detach: false,
      Tty: true
    }), {
      contentType: 'application/json',
      maxResponseBytes: options.maxResponseBytes || 256 * 1024,
      timeoutMs: options.timeoutMs || 15000
    });
    const details = await request('GET', '/exec/' + created.Id + '/json');
    const exitCode = Number.isInteger(details && details.ExitCode) ? details.ExitCode : null;
    return {
      execId: created.Id,
      exitCode,
      output: output.toString('utf8')
    };
  }

  return { exec, request, requestBuffer, requestBuild };
}

module.exports = {
  DEFAULT_ARCHIVE_LIMIT,
  DEFAULT_BUILD_LOG_LIMIT,
  DEFAULT_BUILD_TIMEOUT_MS,
  createDockerClient
};
