const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CONTRACT_BYTES = 32 * 1024;
const MAX_MATCHED_CONTEXT_BYTES = 64 * 1024;
const MAX_CONTRACTS = 128;
const MAX_MATCH_GROUPS = 16;
const MAX_PHRASES_PER_GROUP = 64;
const CONTRACT_STATUSES = new Set(['active', 'superseded', 'rejected', 'historical']);

class CodexMemoryContractError extends Error {
  constructor(message, code = 'codex-memory-contract-invalid') {
    super(message);
    this.name = 'CodexMemoryContractError';
    this.code = code;
  }
}

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function readRegularFile(target, maximumBytes, missingIsNull = false) {
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new CodexMemoryContractError('Codex aktif hafıza sözleşmesi güvenli boyut sınırını aşıyor.');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (missingIsNull && error && error.code === 'ENOENT') return null;
    if (error instanceof CodexMemoryContractError) throw error;
    throw new CodexMemoryContractError('Codex aktif hafıza sözleşmesi okunamadı.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function boundedString(value, maximum, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    throw new CodexMemoryContractError(`Codex hafıza sözleşmesi ${label} alanı geçersiz.`);
  }
  return normalized;
}

function normalizePhraseGroup(group) {
  if (!Array.isArray(group) || !group.length || group.length > MAX_PHRASES_PER_GROUP) {
    throw new CodexMemoryContractError('Codex hafıza sözleşmesi eşleşme grubu geçersiz.');
  }
  const phrases = [];
  const seen = new Set();
  for (const value of group) {
    const phrase = normalizeForMatch(boundedString(value, 160, 'eşleşme'));
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    phrases.push(phrase);
  }
  if (!phrases.length) {
    throw new CodexMemoryContractError('Codex hafıza sözleşmesi eşleşme grubu boş.');
  }
  return phrases;
}

function normalizeContract(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new CodexMemoryContractError('Codex hafıza sözleşmesi kaydı geçersiz.');
  }
  const id = boundedString(entry.id, 120, 'kimlik');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new CodexMemoryContractError('Codex hafıza sözleşmesi kimliği geçersiz.');
  }
  const status = boundedString(entry.status, 24, 'statü');
  if (!CONTRACT_STATUSES.has(status)) {
    throw new CodexMemoryContractError('Codex hafıza sözleşmesi statüsü geçersiz.');
  }
  const priority = Number.isInteger(entry.priority) && entry.priority >= 0 && entry.priority <= 1000
    ? entry.priority
    : 0;
  const file = boundedString(entry.file, 180, 'dosya');
  if (path.basename(file) !== file || !/^[a-z0-9][a-z0-9.-]*\.md$/.test(file)) {
    throw new CodexMemoryContractError('Codex hafıza sözleşmesi dosyası geçersiz.');
  }
  const sha256 = boundedString(entry.sha256, 64, 'özet').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new CodexMemoryContractError('Codex hafıza sözleşmesi özeti geçersiz.');
  }
  const all = entry.match && Array.isArray(entry.match.all) ? entry.match.all : [];
  if (!all.length || all.length > MAX_MATCH_GROUPS) {
    throw new CodexMemoryContractError('Codex hafıza sözleşmesi eşleşme koşulları geçersiz.');
  }
  const none = entry.match && Array.isArray(entry.match.none)
    ? entry.match.none.map((value) => normalizeForMatch(boundedString(value, 160, 'hariç eşleşme')))
    : [];
  return {
    id,
    status,
    priority,
    file,
    sha256,
    all: all.map(normalizePhraseGroup),
    none,
    sourceTitle: typeof entry.sourceTitle === 'string'
      ? boundedString(entry.sourceTitle, 200, 'kaynak başlığı')
      : null,
    sourceModifiedAt: typeof entry.sourceModifiedAt === 'string'
      ? boundedString(entry.sourceModifiedAt, 80, 'kaynak zamanı')
      : null
  };
}

function contractMatches(contract, normalizedPrompt) {
  if (contract.status !== 'active') return false;
  const paddedPrompt = ` ${normalizedPrompt} `;
  const includesPhrase = (phrase) => phrase && paddedPrompt.includes(` ${phrase} `);
  if (contract.none.some(includesPhrase)) return false;
  return contract.all.every((group) => group.some(includesPhrase));
}

function readManifest(contractRoot) {
  const manifestText = readRegularFile(
    path.join(contractRoot, 'manifest.json'),
    MAX_MANIFEST_BYTES,
    true
  );
  if (manifestText === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new CodexMemoryContractError('Codex aktif hafıza sözleşmesi manifesti bozuk.');
  }
  if (
    !parsed || parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(parsed.contracts) || parsed.contracts.length > MAX_CONTRACTS
  ) {
    throw new CodexMemoryContractError('Codex aktif hafıza sözleşmesi manifesti desteklenmiyor.');
  }
  const contracts = parsed.contracts.map(normalizeContract);
  if (new Set(contracts.map((entry) => entry.id)).size !== contracts.length) {
    throw new CodexMemoryContractError('Codex aktif hafıza sözleşmesi kimliği yineleniyor.');
  }
  return contracts;
}

function createCodexMemoryContractResolver({ dataRoot }) {
  if (!dataRoot || typeof dataRoot !== 'string') {
    throw new Error('Codex memory contract resolver requires a data root');
  }
  const contractRoot = path.join(dataRoot, 'connections', 'codex', 'memory-contracts');

  function resolve(prompt) {
    const normalizedPrompt = normalizeForMatch(prompt);
    if (!normalizedPrompt) return null;
    const matches = readManifest(contractRoot)
      .filter((contract) => contractMatches(contract, normalizedPrompt))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    if (!matches.length) return null;

    let totalBytes = 0;
    const additionalContext = {};
    for (const contract of matches) {
      const content = readRegularFile(path.join(contractRoot, contract.file), MAX_CONTRACT_BYTES);
      const observedHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      if (observedHash !== contract.sha256) {
        throw new CodexMemoryContractError(
          'Codex aktif hafıza sözleşmesi güncellik doğrulamasını geçemedi.',
          'codex-memory-contract-stale'
        );
      }
      const value = [
        'FOXOS ACTIVE MEMORY CONTRACT',
        `Contract: ${contract.id}`,
        'Lifecycle: active',
        'Authority: canonical operational contract',
        'This contract was loaded because both its domain and action triggers matched the current user request.',
        'Apply it before historical task pages, examples, similarity-ranked search results, or chronological logs.',
        contract.sourceModifiedAt
          ? 'Before consequential work, verify the canonical Drive file still has this modified time. If it differs, stop using this cache until the active contract cache is refreshed.'
          : null,
        contract.sourceTitle ? `Canonical source title: ${contract.sourceTitle}` : null,
        contract.sourceModifiedAt ? `Canonical source modified at: ${contract.sourceModifiedAt}` : null,
        '',
        content.trim()
      ].filter((line) => line !== null).join('\n');
      totalBytes += Buffer.byteLength(value, 'utf8');
      if (totalBytes > MAX_MATCHED_CONTEXT_BYTES) {
        throw new CodexMemoryContractError('Codex eşleşen aktif hafıza sözleşmeleri fazla büyük.');
      }
      additionalContext[`foxos-active-memory-contract:${contract.id}`] = {
        kind: 'application',
        value
      };
    }
    return additionalContext;
  }

  return { resolve };
}

module.exports = {
  CodexMemoryContractError,
  MANIFEST_SCHEMA_VERSION,
  createCodexMemoryContractResolver,
  normalizeForMatch
};
