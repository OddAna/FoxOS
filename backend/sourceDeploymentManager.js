const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { atomicWriteJson } = require('./resourceRegistry');

const DEPLOYMENT_SCHEMA_VERSION = 1;
const DEPLOYMENT_NAME = 'foxos-deployment-lab';
const DEPLOYMENT_RESOURCE_ID = 'res_' + hash(DEPLOYMENT_NAME, 32);
const DISPOSABLE_LABEL = 'com.foxos.deployment.disposable';
const PLAN_CONFIRMATION = 'PLAN DISPOSABLE SOURCE';
const MAX_CONTEXT_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_FILES = 2000;
const MAX_DOCKERFILE_BYTES = 128 * 1024;
const MAX_BUILD_LOG_BYTES = 256 * 1024;
const MAX_OPERATIONS = 50;
const ID_PATTERN = /^(dplan|dop|drev)_[a-f0-9]{24,64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;

class SourceDeploymentError extends Error {
  constructor(message, statusCode = 400, code = 'source-deployment-error') {
    super(message);
    this.name = 'SourceDeploymentError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hash(value, length = 64) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function validateRepositoryUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new SourceDeploymentError('Repository must be a valid public HTTPS Git URL', 400, 'invalid-repository-url');
  }
  if (
    parsed.protocol !== 'https:' || !parsed.hostname || parsed.port || parsed.username ||
    parsed.password || parsed.search || parsed.hash || parsed.href.length > 512
  ) {
    throw new SourceDeploymentError(
      'The first source pilot accepts only credential-free public HTTPS Git URLs on port 443',
      400,
      'invalid-repository-url'
    );
  }
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost')) {
    throw new SourceDeploymentError('Local repository hosts are not allowed', 400, 'private-repository-host');
  }
  return parsed.href.replace(/\/$/, '');
}

function validateGitRef(value) {
  const ref = String(value || '').trim();
  if (
    !ref || ref.length > 160 || ref.startsWith('-') || ref.startsWith('/') ||
    ref.endsWith('/') || ref.endsWith('.') || ref.includes('..') || ref.includes('//') ||
    ref.includes('@{') || ref.endsWith('.lock') || !/^[a-zA-Z0-9._/-]+$/.test(ref)
  ) {
    throw new SourceDeploymentError('Git ref is invalid', 400, 'invalid-git-ref');
  }
  return ref;
}

function validateRelativePath(value, fallback = '.') {
  const candidate = String(value === undefined || value === null ? fallback : value).trim() || fallback;
  if (
    candidate.includes('\0') || candidate.includes('\\') || path.posix.isAbsolute(candidate) ||
    candidate.split('/').some((segment) => segment === '..') || candidate.length > 240 ||
    !/^[a-zA-Z0-9._/-]+$/.test(candidate)
  ) {
    throw new SourceDeploymentError('Build context path is invalid', 400, 'invalid-context-path');
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new SourceDeploymentError('Build context escapes the repository', 400, 'invalid-context-path');
  }
  return normalized;
}

function validateHealthPath(value) {
  const candidate = String(value || '/');
  if (
    !candidate.startsWith('/') || candidate.length > 160 || candidate.includes('..') ||
    !/^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*$/.test(candidate)
  ) {
    throw new SourceDeploymentError('Health path is invalid', 400, 'invalid-health-path');
  }
  return candidate;
}

function validatePrivatePort(value) {
  const port = Number.parseInt(value === undefined ? '8080' : String(value), 10);
  if (port !== 8080) {
    throw new SourceDeploymentError('The first disposable source pilot must use private port 8080', 400, 'invalid-private-port');
  }
  return port;
}

function validateExpectedBody(value) {
  const body = String(value || '').trim();
  if (!body || body.length > 128 || /[\r\n\0]/.test(body)) {
    throw new SourceDeploymentError('A short single-line expected body marker is required', 400, 'invalid-health-marker');
  }
  return body;
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (value.includes(':')) {
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') ||
      value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
  }
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    octets[0] >= 224;
}

async function assertPublicRepositoryHost(repository, resolveHost = async (hostname) => dns.lookup(hostname, { all: true })) {
  const hostname = new URL(repository).hostname;
  const addresses = await resolveHost(hostname);
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new SourceDeploymentError('Repository host did not resolve exclusively to public addresses', 400, 'private-repository-host');
  }
}

function validateDockerfile(content) {
  if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_DOCKERFILE_BYTES) {
    throw new SourceDeploymentError('Dockerfile is empty or exceeds the safety limit', 409, 'invalid-dockerfile');
  }
  const text = content.toString('utf8');
  const logicalLines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const fromLines = logicalLines.filter((line) => /^\s*FROM\s+/i.test(line));
  if (!fromLines.length) {
    throw new SourceDeploymentError('Dockerfile must contain a FROM instruction', 409, 'invalid-dockerfile');
  }
  for (const line of fromLines) {
    const tokens = line.trim().split(/\s+/).slice(1).filter((token) => !token.startsWith('--'));
    const image = tokens[0] || '';
    if (!/@sha256:[a-f0-9]{64}$/i.test(image)) {
      throw new SourceDeploymentError('Every Dockerfile FROM image must be pinned by sha256 digest', 409, 'unpinned-base-image');
    }
  }
  if (logicalLines.some((line) => /^\s*ADD\s+/i.test(line))) {
    throw new SourceDeploymentError('ADD is outside the first public source pilot; use COPY', 409, 'add-blocked');
  }
  if (/\bRUN\s+--mount=/i.test(text)) {
    throw new SourceDeploymentError('RUN mounts are outside the public disposable pilot', 409, 'build-mount-blocked');
  }
}

function inspectContext(contextRoot, dockerfileName = 'Dockerfile') {
  const root = path.resolve(contextRoot);
  const entries = [];
  let totalBytes = 0;
  let fileCount = 0;

  function walk(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === '.git' || name === '.gitmodules') continue;
      const absolute = path.join(directory, name);
      const relative = prefix ? prefix + '/' + name : name;
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw new SourceDeploymentError('Symlinks are not allowed in the first source build context', 409, 'context-symlink-blocked');
      }
      if (stats.isDirectory()) {
        entries.push({ path: relative, type: 'directory', mode: stats.mode & 0o777 });
        walk(absolute, relative);
        continue;
      }
      if (!stats.isFile()) {
        throw new SourceDeploymentError('Build context contains a non-file entry', 409, 'unsupported-context-entry');
      }
      fileCount += 1;
      totalBytes += stats.size;
      if (fileCount > MAX_CONTEXT_FILES || totalBytes > MAX_CONTEXT_BYTES) {
        throw new SourceDeploymentError('Build context exceeds the disposable pilot safety limit', 413, 'context-limit-exceeded');
      }
      const buffer = fs.readFileSync(absolute);
      entries.push({
        path: relative,
        type: 'file',
        mode: stats.mode & 0o777,
        size: stats.size,
        digest: 'sha256:' + hash(buffer)
      });
    }
  }

  walk(root);
  const dockerfilePath = path.resolve(root, dockerfileName);
  if (dockerfilePath !== root && !dockerfilePath.startsWith(root + path.sep)) {
    throw new SourceDeploymentError('Dockerfile escapes the build context', 400, 'invalid-dockerfile-path');
  }
  if (!fs.existsSync(dockerfilePath) || !fs.statSync(dockerfilePath).isFile()) {
    throw new SourceDeploymentError('Dockerfile was not found in the selected context', 404, 'dockerfile-not-found');
  }
  const dockerfile = fs.readFileSync(dockerfilePath);
  validateDockerfile(dockerfile);
  return {
    contextDigest: 'sha256:' + hash(canonicalJson(entries)),
    dockerfileDigest: 'sha256:' + hash(dockerfile),
    fileCount,
    totalBytes
  };
}

function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout: options.timeoutMs || 120000,
      maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || stdout || error.message).trim();
        const wrapped = new SourceDeploymentError(message || 'Source command failed', 502, 'source-command-failed');
        wrapped.cause = error;
        return reject(wrapped);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function gitArgs(args) {
  return [
    '-c', 'credential.helper=',
    '-c', 'core.askPass=',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.ssh.allow=never',
    '-c', 'http.followRedirects=false',
    ...args
  ];
}

function createGitSourceAdapter({ runCommand = runFile, resolveHost } = {}) {
  async function resolve(repository, ref) {
    await assertPublicRepositoryHost(repository, resolveHost);
    const branchRef = 'refs/heads/' + ref;
    const tagRef = 'refs/tags/' + ref;
    const result = await runCommand('git', gitArgs([
      'ls-remote', '--exit-code', repository, branchRef, tagRef, tagRef + '^{}'
    ]), {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: 60000
    });
    const records = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [commit, name] = line.trim().split(/\s+/, 2);
      return { commit: String(commit || '').toLowerCase(), name };
    });
    const branch = records.find((record) => record.name === branchRef);
    const tag = records.find((record) => record.name === tagRef);
    const peeledTag = records.find((record) => record.name === tagRef + '^{}');
    if (branch && tag) {
      throw new SourceDeploymentError('Git ref is ambiguous between a branch and tag', 409, 'ambiguous-git-ref');
    }
    const selected = branch || peeledTag || tag;
    if (!selected || !GIT_COMMIT_PATTERN.test(selected.commit)) {
      throw new SourceDeploymentError('Git branch or tag was not found', 404, 'git-ref-not-found');
    }
    return { commit: selected.commit, refType: branch ? 'branch' : 'tag' };
  }

  async function cloneAndInspect(source) {
    await assertPublicRepositoryHost(source.repository, resolveHost);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-source-'));
    const repositoryRoot = path.join(workspace, 'repository');
    try {
      await runCommand('git', gitArgs([
        'clone', '--depth', '1', '--filter=blob:limit=8388608', '--single-branch', '--branch', source.ref,
        source.repository, repositoryRoot
      ]), {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 120000,
        maxBuffer: 2 * 1024 * 1024
      });
      const head = await runCommand('git', gitArgs(['-C', repositoryRoot, 'rev-parse', 'HEAD']), {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 30000
      });
      const commit = head.stdout.trim().toLowerCase();
      if (commit !== source.commit) {
        throw new SourceDeploymentError('Git ref moved after planning; create a new plan', 409, 'source-plan-stale');
      }
      if (fs.existsSync(path.join(repositoryRoot, '.gitmodules'))) {
        throw new SourceDeploymentError('Git submodules are outside the first public source pilot', 409, 'submodules-blocked');
      }
      const contextRoot = path.resolve(repositoryRoot, source.contextPath);
      if (contextRoot !== repositoryRoot && !contextRoot.startsWith(repositoryRoot + path.sep)) {
        throw new SourceDeploymentError('Build context escapes the repository', 400, 'invalid-context-path');
      }
      if (!fs.existsSync(contextRoot) || !fs.statSync(contextRoot).isDirectory()) {
        throw new SourceDeploymentError('Build context was not found', 404, 'context-not-found');
      }
      const inspection = inspectContext(contextRoot, source.dockerfile);
      return { workspace, repositoryRoot, contextRoot, commit, ...inspection };
    } catch (error) {
      fs.rmSync(workspace, { recursive: true, force: true });
      throw error;
    }
  }

  async function inspect(source) {
    const resolved = await resolve(source.repository, source.ref);
    const checkout = await cloneAndInspect({ ...source, ...resolved });
    try {
      return {
        ...resolved,
        contextDigest: checkout.contextDigest,
        dockerfileDigest: checkout.dockerfileDigest,
        fileCount: checkout.fileCount,
        totalBytes: checkout.totalBytes
      };
    } finally {
      fs.rmSync(checkout.workspace, { recursive: true, force: true });
    }
  }

  async function archive(source) {
    const checkout = await cloneAndInspect(source);
    const archiveFile = path.join(checkout.workspace, 'context.tar');
    try {
      if (
        checkout.contextDigest !== source.contextDigest ||
        checkout.dockerfileDigest !== source.dockerfileDigest
      ) {
        throw new SourceDeploymentError('Source context changed after planning', 409, 'source-plan-stale');
      }
      await runCommand('tar', [
        '--format=ustar', '--exclude=.git', '--exclude=.gitmodules', '-cf', archiveFile, '.'
      ], { cwd: checkout.contextRoot, timeoutMs: 60000, maxBuffer: 1024 * 1024 });
      const stats = fs.statSync(archiveFile);
      if (stats.size > MAX_CONTEXT_BYTES + 2 * 1024 * 1024) {
        throw new SourceDeploymentError('Archived build context exceeds the safety limit', 413, 'context-limit-exceeded');
      }
      return fs.readFileSync(archiveFile);
    } finally {
      fs.rmSync(checkout.workspace, { recursive: true, force: true });
    }
  }

  async function read(source, maxBytes = 128 * 1024) {
    const filePath = validateRelativePath(source.filePath);
    const resolved = await resolve(source.repository, source.ref);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'foxos-source-file-'));
    const repositoryRoot = path.join(workspace, 'repository');
    try {
      await runCommand('git', gitArgs([
        'clone', '--depth', '1', '--filter=blob:limit=8388608', '--single-branch', '--branch', source.ref,
        source.repository, repositoryRoot
      ]), {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 120000,
        maxBuffer: 2 * 1024 * 1024
      });
      const head = await runCommand('git', gitArgs(['-C', repositoryRoot, 'rev-parse', 'HEAD']), {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 30000
      });
      const commit = head.stdout.trim().toLowerCase();
      if (commit !== resolved.commit || (source.commit && commit !== source.commit)) {
        throw new SourceDeploymentError('Git ref moved after planning; create a new plan', 409, 'source-plan-stale');
      }
      if (fs.existsSync(path.join(repositoryRoot, '.gitmodules'))) {
        throw new SourceDeploymentError('Git submodules are outside the public source pilot', 409, 'submodules-blocked');
      }
      const target = path.resolve(repositoryRoot, filePath);
      if (target !== repositoryRoot && !target.startsWith(repositoryRoot + path.sep)) {
        throw new SourceDeploymentError('Source file escapes the repository', 400, 'invalid-source-file');
      }
      const realRepositoryRoot = fs.realpathSync(repositoryRoot);
      const realTarget = fs.realpathSync(target);
      if (realTarget !== realRepositoryRoot && !realTarget.startsWith(realRepositoryRoot + path.sep)) {
        throw new SourceDeploymentError('Source file resolves outside the repository', 409, 'invalid-source-file');
      }
      const stats = fs.lstatSync(target);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size < 1 || stats.size > maxBytes) {
        throw new SourceDeploymentError('Source file is missing, linked or exceeds the safety limit', 409, 'invalid-source-file');
      }
      const content = fs.readFileSync(target);
      return {
        ...resolved,
        commit,
        filePath,
        fileDigest: 'sha256:' + hash(content),
        fileBytes: content.length,
        content
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new SourceDeploymentError('Source file was not found', 404, 'source-file-not-found');
      }
      throw error;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  return { inspect, archive, read };
}

function parseBuildOutput(buffer) {
  const lines = [];
  let imageId = null;
  for (const rawLine of buffer.toString('utf8').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let record;
    try {
      record = JSON.parse(rawLine);
    } catch {
      lines.push(rawLine);
      continue;
    }
    if (record.error || record.errorDetail) {
      const message = record.errorDetail && record.errorDetail.message || record.error || 'Docker build failed';
      throw new SourceDeploymentError(String(message).slice(0, 500), 502, 'docker-build-failed');
    }
    if (record.aux && /^sha256:[a-f0-9]{64}$/i.test(record.aux.ID || '')) imageId = record.aux.ID.toLowerCase();
    if (record.stream) lines.push(record.stream);
    if (record.status) lines.push(record.status + (record.progress ? ' ' + record.progress : ''));
  }
  return { imageId, log: sanitizeBuildLog(lines.join('')) };
}

function sanitizeBuildLog(value) {
  let output = String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
  output = output.replace(/(https:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
  output = output.replace(/\b(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
  const lines = output.split(/\r?\n/).map((line) => line.slice(0, 1000));
  output = lines.join('\n');
  if (Buffer.byteLength(output) > MAX_BUILD_LOG_BYTES) {
    output = Buffer.from(output).subarray(0, MAX_BUILD_LOG_BYTES).toString('utf8') + '\n[log truncated]\n';
  }
  return output;
}

async function defaultHostProbe({ port, healthPath, timeoutMs = 5000 }) {
  const marker = '\nFOXOS_HTTP_STATUS:';
  const result = await runFile('nsenter', [
    '-t', '1', '-n',
    'curl', '--silent', '--show-error', '--location', '--max-redirs', '0',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '--max-filesize', String(64 * 1024),
    '--header', 'User-Agent: FoxOS-source-health/1',
    '--write-out', marker + '%{http_code}',
    'http://127.0.0.1:' + port + healthPath
  ], { timeoutMs: timeoutMs + 1000, maxBuffer: 128 * 1024 });
  const separator = result.stdout.lastIndexOf(marker);
  if (separator === -1) throw new Error('Health probe did not return an HTTP status');
  return {
    statusCode: Number.parseInt(result.stdout.slice(separator + marker.length), 10),
    body: result.stdout.slice(0, separator)
  };
}

function deploymentConfirmation(planId) {
  return 'DEPLOY DISPOSABLE ' + planId;
}

function rollbackConfirmation(operationId) {
  return 'ROLLBACK DEPLOYMENT ' + operationId;
}

function createSourceDeploymentManager({
  dataRoot,
  dockerRequest,
  dockerBuildRequest,
  sourceAdapter = createGitSourceAdapter(),
  probeHttp = defaultHostProbe,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (!dataRoot || typeof dockerRequest !== 'function' || typeof dockerBuildRequest !== 'function' || !sourceAdapter) {
    throw new Error('Source deployment manager requires data root, Docker clients and a source adapter');
  }

  const root = path.join(dataRoot, 'deployments');
  const plansRoot = path.join(root, 'plans');
  const revisionsRoot = path.join(root, 'revisions');
  const operationsRoot = path.join(root, 'operations');
  const logsRoot = path.join(root, 'logs');
  const currentFile = path.join(root, 'current.json');
  const inFlight = new Set();

  function recordPath(directory, id) {
    if (!ID_PATTERN.test(String(id))) {
      throw new SourceDeploymentError('Invalid deployment record ID', 400, 'invalid-deployment-id');
    }
    return path.join(directory, id + '.json');
  }

  function getPlan(planId) {
    const plan = readJson(recordPath(plansRoot, planId));
    if (!plan) throw new SourceDeploymentError('Deployment plan was not found', 404, 'deployment-plan-not-found');
    return plan;
  }

  function getOperation(operationId) {
    const operation = readJson(recordPath(operationsRoot, operationId));
    if (!operation) throw new SourceDeploymentError('Deployment operation was not found', 404, 'deployment-operation-not-found');
    return operation;
  }

  function listRecords(directory) {
    try {
      return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort().map((file) => readJson(path.join(directory, file))).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  function pruneOperations() {
    let files;
    try {
      files = fs.readdirSync(operationsRoot).filter((file) => file.endsWith('.json')).sort();
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const file of files.slice(0, Math.max(0, files.length - MAX_OPERATIONS))) fs.unlinkSync(path.join(operationsRoot, file));
  }

  function status() {
    return {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      scope: 'disposable-public-git-dockerfile-only',
      resourceId: DEPLOYMENT_RESOURCE_ID,
      name: DEPLOYMENT_NAME,
      current: readJson(currentFile),
      plans: listRecords(plansRoot),
      operations: listRecords(operationsRoot),
      guarantees: {
        publicHttpsGitOnly: true,
        immutableCommitRequired: true,
        pinnedBaseImagesRequired: true,
        buildSecretsSupported: false,
        environmentSupported: false,
        runtimeSecretsSupported: false,
        buildNetwork: 'none',
        candidateHealthBeforeCutover: true,
        providerAuthorityRequired: false,
        coolifyMutable: false
      }
    };
  }

  async function createPlan(input = {}) {
    if (input.confirmation !== PLAN_CONFIRMATION) {
      throw new SourceDeploymentError('Exact disposable source planning confirmation is required', 400, 'confirmation-required');
    }
    const repository = validateRepositoryUrl(input.repository);
    const ref = validateGitRef(input.ref);
    const contextPath = validateRelativePath(input.contextPath, '.');
    const dockerfile = validateRelativePath(input.dockerfile, 'Dockerfile');
    const privatePort = validatePrivatePort(input.privatePort);
    const healthPath = validateHealthPath(input.healthPath);
    const expectedBody = validateExpectedBody(input.expectedBody);
    const inspected = await sourceAdapter.inspect({ repository, ref, contextPath, dockerfile });
    const revisionBody = {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      resourceId: DEPLOYMENT_RESOURCE_ID,
      source: {
        adapter: 'public-git-https',
        repository,
        ref,
        refType: inspected.refType,
        commit: inspected.commit,
        contextPath,
        dockerfile,
        contextDigest: inspected.contextDigest,
        dockerfileDigest: inspected.dockerfileDigest,
        fileCount: inspected.fileCount,
        totalBytes: inspected.totalBytes
      },
      build: {
        method: 'dockerfile',
        networkMode: 'none',
        secretValuesIncluded: false,
        baseImagesPinned: true
      },
      runtime: {
        privatePort,
        bindAddress: '127.0.0.1',
        publishedPort: 'dynamic',
        restartPolicy: 'unless-stopped',
        privileged: false,
        noNewPrivileges: true,
        memoryBytes: 128 * 1024 * 1024,
        nanoCpus: 500000000
      },
      health: { path: healthPath, expectedStatus: 200, expectedBody }
    };
    const revisionId = 'drev_' + hash(canonicalJson(revisionBody), 32);
    const planId = 'dplan_' + randomUUID().replace(/-/g, '');
    const revision = { ...revisionBody, revisionId, createdAt: new Date(clock()).toISOString() };
    const plan = {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      planId,
      status: 'ready',
      resourceId: DEPLOYMENT_RESOURCE_ID,
      revisionId,
      source: revision.source,
      runtime: revision.runtime,
      health: revision.health,
      actions: [
        'reclone-and-verify-immutable-source',
        'build-without-network-or-secrets',
        'start-isolated-loopback-candidate',
        'verify-http-status-and-body-marker',
        'preserve-previous-active-container',
        'promote-candidate'
      ],
      confirmation: deploymentConfirmation(planId),
      createdAt: revision.createdAt
    };
    atomicWriteJson(recordPath(revisionsRoot, revisionId), revision);
    atomicWriteJson(recordPath(plansRoot, planId), plan);
    return plan;
  }

  async function ownedActiveContainer() {
    const containers = await dockerRequest('GET', '/containers/json?all=1');
    const active = (containers || []).find((container) => (container.Names || []).includes('/' + DEPLOYMENT_NAME));
    if (!active) return null;
    const labels = active.Labels || {};
    if (
      labels[DISPOSABLE_LABEL] !== 'true' || labels['com.foxos.managed'] !== 'true' ||
      labels['com.foxos.resource.id'] !== DEPLOYMENT_RESOURCE_ID
    ) {
      throw new SourceDeploymentError('The deployment lab name is occupied by a non-FoxOS container', 409, 'deployment-name-conflict');
    }
    return active;
  }

  function containerPayload(plan, operationId, imageId) {
    const portKey = plan.runtime.privatePort + '/tcp';
    return {
      Image: imageId,
      Labels: {
        'com.foxos.managed': 'true',
        'com.foxos.resource.id': DEPLOYMENT_RESOURCE_ID,
        [DISPOSABLE_LABEL]: 'true',
        'com.foxos.deployment.revision': plan.revisionId,
        'com.foxos.deployment.operation': operationId
      },
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '0' }] },
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        Privileged: false,
        SecurityOpt: ['no-new-privileges:true'],
        Memory: plan.runtime.memoryBytes,
        NanoCpus: plan.runtime.nanoCpus,
        PidsLimit: 128
      }
    };
  }

  function buildPath(imageTag, plan) {
    const labels = JSON.stringify({
      'com.foxos.deployment.disposable': 'true',
      'com.foxos.deployment.revision': plan.revisionId
    });
    const query = new URLSearchParams({
      t: imageTag,
      dockerfile: plan.source.dockerfile,
      rm: '1',
      forcerm: '1',
      pull: '1',
      networkmode: 'none',
      memory: String(512 * 1024 * 1024),
      memswap: String(512 * 1024 * 1024),
      cpuquota: '50000',
      labels
    });
    return '/build?' + query.toString();
  }

  function publishedPort(details, privatePort) {
    const bindings = details.NetworkSettings && details.NetworkSettings.Ports && details.NetworkSettings.Ports[privatePort + '/tcp'];
    const port = Number.parseInt(bindings && bindings[0] && bindings[0].HostPort || '', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SourceDeploymentError('Docker did not publish the candidate loopback port', 502, 'candidate-port-missing');
    }
    return port;
  }

  async function proveHealth(containerId, plan) {
    let lastError = null;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        const details = await dockerRequest('GET', '/containers/' + containerId + '/json');
        if (!details.State || details.State.Status !== 'running') {
          throw new SourceDeploymentError('Candidate container exited before health verification', 502, 'candidate-exited');
        }
        const port = publishedPort(details, plan.runtime.privatePort);
        const response = await probeHttp({ port, healthPath: plan.health.path, timeoutMs: 5000 });
        if (response.statusCode === plan.health.expectedStatus && response.body.includes(plan.health.expectedBody)) {
          return {
            verified: true,
            statusCode: response.statusCode,
            bodyDigest: 'sha256:' + hash(response.body),
            expectedBodyMatched: true,
            hostPort: port,
            verifiedAt: new Date(clock()).toISOString()
          };
        }
        lastError = new Error('HTTP health proof did not match the expected status and marker');
      } catch (error) {
        lastError = error;
      }
      await wait(500);
    }
    throw new SourceDeploymentError(lastError && lastError.message || 'Candidate health verification failed', 502, 'candidate-health-failed');
  }

  async function restorePreviousAfterFailure({ previous, candidateId, previousRollbackName }) {
    if (candidateId) {
      try { await dockerRequest('DELETE', '/containers/' + candidateId + '?force=1&v=0'); } catch { /* best effort */ }
    }
    if (previous && previousRollbackName) {
      try { await dockerRequest('POST', '/containers/' + previous.Id + '/rename?name=' + encodeURIComponent(DEPLOYMENT_NAME)); } catch { /* best effort */ }
      try { await dockerRequest('POST', '/containers/' + previous.Id + '/start'); } catch { /* best effort */ }
    }
  }

  async function applyPlan(planId, confirmation) {
    const plan = getPlan(planId);
    if (confirmation !== plan.confirmation) {
      throw new SourceDeploymentError('Exact disposable deployment confirmation is required', 400, 'confirmation-required');
    }
    if (inFlight.has(DEPLOYMENT_RESOURCE_ID)) {
      throw new SourceDeploymentError('A source deployment is already running', 409, 'deployment-in-progress');
    }
    inFlight.add(DEPLOYMENT_RESOURCE_ID);

    const operationId = 'dop_' + randomUUID().replace(/-/g, '');
    const operationFile = recordPath(operationsRoot, operationId);
    let operation = {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      operationId,
      planId,
      revisionId: plan.revisionId,
      resourceId: DEPLOYMENT_RESOURCE_ID,
      status: 'running',
      startedAt: new Date(clock()).toISOString(),
      source: plan.source,
      build: { status: 'pending', imageId: null, imageTag: null, logFile: null, secretValuesIncluded: false },
      previous: null,
      candidate: null,
      healthProof: null,
      rollback: { available: false, confirmation: rollbackConfirmation(operationId) }
    };
    atomicWriteJson(operationFile, operation);

    let previous = null;
    let previousRollbackName = null;
    let candidateId = null;
    try {
      previous = await ownedActiveContainer();
      const archive = await sourceAdapter.archive(plan.source);
      const imageTag = DEPLOYMENT_NAME + ':' + plan.revisionId.slice(-16);
      operation.build = { ...operation.build, status: 'running', imageTag };
      atomicWriteJson(operationFile, operation);

      const buildResult = parseBuildOutput(await dockerBuildRequest(buildPath(imageTag, plan), archive));
      const imageDetails = await dockerRequest('GET', '/images/' + encodeURIComponent(imageTag) + '/json');
      const imageId = String(imageDetails.Id || buildResult.imageId || '').toLowerCase();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
        throw new SourceDeploymentError('Docker build did not produce an immutable image ID', 502, 'build-image-id-missing');
      }
      ensureDirectory(logsRoot);
      const logFile = path.join(logsRoot, operationId + '.log');
      fs.writeFileSync(logFile, buildResult.log, { mode: 0o600 });
      fs.chmodSync(logFile, 0o600);
      operation.build = {
        status: 'succeeded',
        imageId,
        imageTag,
        logFile: path.relative(dataRoot, logFile),
        logBytes: Buffer.byteLength(buildResult.log),
        secretValuesIncluded: false
      };
      atomicWriteJson(operationFile, operation);

      const candidateName = DEPLOYMENT_NAME + '-candidate-' + hash(operationId, 12);
      const created = await dockerRequest(
        'POST',
        '/containers/create?name=' + encodeURIComponent(candidateName),
        containerPayload(plan, operationId, imageId)
      );
      candidateId = created.Id;
      await dockerRequest('POST', '/containers/' + candidateId + '/start');
      operation.healthProof = await proveHealth(candidateId, plan);
      operation.candidate = {
        containerId: candidateId,
        name: candidateName,
        imageId,
        hostPort: operation.healthProof.hostPort
      };
      atomicWriteJson(operationFile, operation);

      if (previous) {
        const previousDetails = await dockerRequest('GET', '/containers/' + previous.Id + '/json');
        const previousLabels = previousDetails.Config && previousDetails.Config.Labels || {};
        operation.previous = {
          containerId: previous.Id,
          revisionId: previousLabels['com.foxos.deployment.revision'] || null,
          operationId: previousLabels['com.foxos.deployment.operation'] || null,
          hostPort: publishedPort(previousDetails, plan.runtime.privatePort),
          wasRunning: previousDetails.State && previousDetails.State.Status === 'running'
        };
        if (operation.previous.wasRunning) await dockerRequest('POST', '/containers/' + previous.Id + '/stop?t=10');
        previousRollbackName = DEPLOYMENT_NAME + '-rollback-' + hash(operationId, 12);
        await dockerRequest('POST', '/containers/' + previous.Id + '/rename?name=' + encodeURIComponent(previousRollbackName));
        operation.previous.rollbackName = previousRollbackName;
      }

      await dockerRequest('POST', '/containers/' + candidateId + '/rename?name=' + encodeURIComponent(DEPLOYMENT_NAME));
      operation.candidate.name = DEPLOYMENT_NAME;
      operation.status = 'applied';
      operation.completedAt = new Date(clock()).toISOString();
      operation.rollback.available = Boolean(previous);
      atomicWriteJson(operationFile, operation);
      atomicWriteJson(currentFile, {
        schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
        resourceId: DEPLOYMENT_RESOURCE_ID,
        operationId,
        revisionId: plan.revisionId,
        containerId: candidateId,
        imageId,
        hostPort: operation.healthProof.hostPort,
        source: plan.source,
        healthProof: operation.healthProof,
        activatedAt: operation.completedAt
      });
      pruneOperations();
      return operation;
    } catch (error) {
      await restorePreviousAfterFailure({ previous, candidateId, previousRollbackName });
      operation = {
        ...operation,
        status: previousRollbackName ? 'failed-previous-restoration-attempted' : 'failed-before-cutover',
        completedAt: new Date(clock()).toISOString(),
        error: {
          code: error.code || 'source-deployment-failed',
          message: error instanceof SourceDeploymentError ? error.message : 'Source deployment failed'
        }
      };
      atomicWriteJson(operationFile, operation);
      throw error;
    } finally {
      inFlight.delete(DEPLOYMENT_RESOURCE_ID);
    }
  }

  async function rollbackOperation(operationId, confirmation) {
    const operation = getOperation(operationId);
    if (operation.status !== 'applied' || !operation.rollback.available || !operation.previous) {
      throw new SourceDeploymentError('This deployment has no available rollback', 409, 'rollback-unavailable');
    }
    if (confirmation !== operation.rollback.confirmation) {
      throw new SourceDeploymentError('Exact deployment rollback confirmation is required', 400, 'confirmation-required');
    }
    if (inFlight.has(DEPLOYMENT_RESOURCE_ID)) {
      throw new SourceDeploymentError('A source deployment is already running', 409, 'deployment-in-progress');
    }
    inFlight.add(DEPLOYMENT_RESOURCE_ID);

    const currentId = operation.candidate.containerId;
    const previousId = operation.previous.containerId;
    const currentParkedName = DEPLOYMENT_NAME + '-rolled-forward-' + hash(operationId, 12);
    let currentRenamed = false;
    let previousRenamed = false;
    try {
      const current = await dockerRequest('GET', '/containers/' + currentId + '/json');
      const previous = await dockerRequest('GET', '/containers/' + previousId + '/json');
      const currentLabels = current.Config && current.Config.Labels || {};
      const previousLabels = previous.Config && previous.Config.Labels || {};
      for (const labels of [currentLabels, previousLabels]) {
        if (labels[DISPOSABLE_LABEL] !== 'true' || labels['com.foxos.resource.id'] !== DEPLOYMENT_RESOURCE_ID) {
          throw new SourceDeploymentError('Deployment rollback container identity mismatch', 409, 'rollback-identity-mismatch');
        }
      }

      if (current.State && current.State.Status === 'running') await dockerRequest('POST', '/containers/' + currentId + '/stop?t=10');
      await dockerRequest('POST', '/containers/' + currentId + '/rename?name=' + encodeURIComponent(currentParkedName));
      currentRenamed = true;
      await dockerRequest('POST', '/containers/' + previousId + '/rename?name=' + encodeURIComponent(DEPLOYMENT_NAME));
      previousRenamed = true;
      await dockerRequest('POST', '/containers/' + previousId + '/start');

      const previousOperation = operation.previous.operationId
        ? getOperation(operation.previous.operationId)
        : null;
      if (!previousOperation) {
        throw new SourceDeploymentError('Previous deployment operation was not found', 409, 'rollback-history-missing');
      }
      const previousPlan = getPlan(previousOperation.planId);
      const rollbackPlan = {
        ...previousPlan,
        revisionId: operation.previous.revisionId,
        runtime: { ...previousPlan.runtime, privatePort: Number(Object.keys(previous.HostConfig.PortBindings || {})[0].split('/')[0]) }
      };
      const healthProof = await proveHealth(previousId, rollbackPlan);
      operation.status = 'rolled-back';
      operation.rolledBackAt = new Date(clock()).toISOString();
      operation.rollback.available = false;
      operation.rollback.proof = healthProof;
      operation.rollback.currentParkedName = currentParkedName;
      atomicWriteJson(recordPath(operationsRoot, operationId), operation);
      atomicWriteJson(currentFile, {
        schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
        resourceId: DEPLOYMENT_RESOURCE_ID,
        operationId: operation.previous.operationId,
        revisionId: operation.previous.revisionId,
        containerId: previousId,
        imageId: previous.Config.Image,
        hostPort: healthProof.hostPort,
        source: previousPlan.source,
        healthProof,
        activatedAt: operation.rolledBackAt,
        restoredBy: operationId
      });
      return operation;
    } catch (error) {
      if (previousRenamed) {
        try { await dockerRequest('POST', '/containers/' + previousId + '/stop?t=10'); } catch { /* best effort */ }
        try { await dockerRequest('POST', '/containers/' + previousId + '/rename?name=' + encodeURIComponent(operation.previous.rollbackName)); } catch { /* best effort */ }
      }
      if (currentRenamed) {
        try { await dockerRequest('POST', '/containers/' + currentId + '/rename?name=' + encodeURIComponent(DEPLOYMENT_NAME)); } catch { /* best effort */ }
        try { await dockerRequest('POST', '/containers/' + currentId + '/start'); } catch { /* best effort */ }
      }
      throw error;
    } finally {
      inFlight.delete(DEPLOYMENT_RESOURCE_ID);
    }
  }

  return {
    createPlan,
    applyPlan,
    rollbackOperation,
    getPlan,
    getOperation,
    status
  };
}

module.exports = {
  DEPLOYMENT_NAME,
  DEPLOYMENT_RESOURCE_ID,
  DISPOSABLE_LABEL,
  PLAN_CONFIRMATION,
  SourceDeploymentError,
  assertPublicRepositoryHost,
  canonicalJson,
  createGitSourceAdapter,
  createSourceDeploymentManager,
  defaultHostProbe,
  deploymentConfirmation,
  ensureDirectory,
  hash,
  inspectContext,
  isPrivateAddress,
  parseBuildOutput,
  readJson,
  rollbackConfirmation,
  sanitizeBuildLog,
  validateDockerfile,
  validateExpectedBody,
  validateGitRef,
  validateHealthPath,
  validateRelativePath,
  validateRepositoryUrl
};
