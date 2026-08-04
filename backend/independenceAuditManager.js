const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./resourceRegistry');

const INDEPENDENCE_AUDIT_SCHEMA_VERSION = 1;
const AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION = 'AUDIT WORKLOAD INDEPENDENCE';
const RESOURCE_ID_PATTERN = /^res_[a-f0-9]{32}$/;
const AUDIT_ID_PATTERN = /^audit_[a-f0-9]{32}$/;
const MAX_AUDITS = 100;

class IndependenceAuditError extends Error {
  constructor(message, statusCode = 400, code = 'independence-audit-error') {
    super(message);
    this.name = 'IndependenceAuditError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function listJson(directory) {
  try {
    return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()
      .map((file) => readJson(path.join(directory, file))).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function prune(directory) {
  const reports = listJson(directory).sort((left, right) => (
    String(left.generatedAt).localeCompare(String(right.generatedAt)) || left.auditId.localeCompare(right.auditId)
  ));
  for (const report of reports.slice(0, Math.max(0, reports.length - MAX_AUDITS))) {
    fs.unlinkSync(path.join(directory, report.auditId + '.json'));
  }
}

function check(code, status, blockerCodes = []) {
  return { code, status, blockerCodes: Array.from(new Set(blockerCodes)).sort() };
}

function manifestSectionCheck(code, blockers, sections) {
  const matching = blockers.filter((blocker) => sections.includes(blocker.section));
  return check(code, matching.length ? 'blocked' : 'pass', matching.map((blocker) => blocker.code));
}

function buildChecks(resource, manifest) {
  const classification = resource.classification;
  const manifestBlockers = manifest && manifest.gates && manifest.gates.blockers || [];
  const candidateBlockers = classification && classification.independenceAudit &&
    classification.independenceAudit.blockers || ['classification-missing'];
  const stateStatus = !classification || classification.stateClass === 'unknown'
    ? 'needs-evidence'
    : classification.stateClass === 'stateless' ? 'pass' : 'blocked';
  return [
    check(
      'classification',
      classification && classification.status === 'classified' ? 'pass' : 'needs-evidence',
      classification && classification.status === 'classified' ? [] : candidateBlockers
    ),
    check(
      'stateless-application-candidate',
      classification && classification.independenceAudit.eligibleForReadOnlyAudit ? 'pass' : 'blocked',
      candidateBlockers
    ),
    check('declared-persistence', stateStatus, stateStatus === 'pass' ? [] : [
      classification ? `state-class:${classification.stateClass}` : 'classification-missing'
    ]),
    manifestSectionCheck('immutable-source', manifestBlockers, ['source']),
    manifestSectionCheck('environment-and-secrets', manifestBlockers, ['environment']),
    manifestSectionCheck('routes-and-tls', manifestBlockers, ['routes']),
    manifestSectionCheck('dependency-graph', manifestBlockers, ['dependencies']),
    manifestSectionCheck('runtime-and-health', manifestBlockers, ['runtime', 'health', 'updates']),
    manifestSectionCheck('backup-and-restore', manifestBlockers, ['recovery'])
  ];
}

function createIndependenceAuditManager({
  dataRoot,
  resourceRegistry,
  compileApplicationManifest,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID()
}) {
  if (
    !dataRoot || !resourceRegistry || typeof resourceRegistry.getLatest !== 'function' ||
    typeof compileApplicationManifest !== 'function'
  ) {
    throw new Error('Independence audit manager requires registry and manifest compiler adapters');
  }
  const root = path.join(dataRoot, 'independence-audits');
  const reportsRoot = path.join(root, 'reports');

  function snapshot() {
    const current = resourceRegistry.getLatest();
    if (!current) {
      throw new IndependenceAuditError(
        'Run a resource scan before auditing workload independence',
        409,
        'registry-not-scanned'
      );
    }
    return current;
  }

  function candidates() {
    return (snapshot().resources || []).filter((resource) => (
      resource.classification &&
      resource.classification.independenceAudit &&
      resource.classification.independenceAudit.eligibleForReadOnlyAudit
    )).map((resource) => ({
      resourceId: resource.id,
      name: resource.name,
      provider: resource.provider,
      workloadRole: resource.classification.workloadRole,
      stateClass: resource.classification.stateClass,
      authorityClass: resource.classification.authorityClass,
      classificationRevision: resource.classification.revision,
      routeCount: (resource.routes || []).length,
      mountCount: (resource.mounts || []).length,
      observedEnvironmentVariableCount: resource.runtime.environmentVariableCount,
      applyApproved: false,
      providerDetachApproved: false
    })).sort((left, right) => left.name.localeCompare(right.name) || left.resourceId.localeCompare(right.resourceId));
  }

  function createAudit(input = {}) {
    if (input.confirmation !== AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION) {
      throw new IndependenceAuditError(
        'Exact workload independence audit confirmation is required',
        400,
        'confirmation-required'
      );
    }
    if (!RESOURCE_ID_PATTERN.test(String(input.resourceId || ''))) {
      throw new IndependenceAuditError('Invalid FoxOS resource ID', 400, 'invalid-resource-id');
    }
    const currentSnapshot = snapshot();
    const resource = (currentSnapshot.resources || []).find((candidate) => candidate.id === input.resourceId);
    if (!resource) {
      throw new IndependenceAuditError('Resource was not found in the latest registry snapshot', 404, 'resource-not-found');
    }

    const manifest = compileApplicationManifest(resource.id);
    const manifestBlockers = (manifest.gates && manifest.gates.blockers || []).map((blocker) => ({
      code: blocker.code,
      section: blocker.section,
      severity: blocker.severity
    })).sort((left, right) => left.code.localeCompare(right.code));
    const checks = buildChecks(resource, manifest);
    const summary = {
      passed: checks.filter((entry) => entry.status === 'pass').length,
      blocked: checks.filter((entry) => entry.status === 'blocked').length,
      needsEvidence: checks.filter((entry) => entry.status === 'needs-evidence').length
    };
    const classificationCandidate = Boolean(
      resource.classification && resource.classification.independenceAudit &&
      resource.classification.independenceAudit.eligibleForReadOnlyAudit
    );
    const nonAuthorityBlockers = manifestBlockers.filter((blocker) => blocker.code !== 'external-provider-authority');
    const result = !classificationCandidate
      ? 'not-a-stateless-application-candidate'
      : nonAuthorityBlockers.length ? 'evidence-incomplete' : 'ready-for-explicit-migration-planning';
    const auditId = 'audit_' + randomUUID().replace(/-/g, '');
    const report = {
      schemaVersion: INDEPENDENCE_AUDIT_SCHEMA_VERSION,
      auditId,
      generatedAt: new Date(clock()).toISOString(),
      mode: 'read-only-independence-audit',
      result,
      resource: {
        resourceId: resource.id,
        name: resource.name,
        observedProvider: resource.provider,
        classification: resource.classification || null
      },
      evidence: {
        registrySnapshotId: currentSnapshot.snapshotId,
        manifestRevisionId: manifest.revisionId,
        manifestGateStatus: manifest.gates.status,
        sourceType: manifest.desired && manifest.desired.source && manifest.desired.source.type || null,
        manifestBlockers,
        secretValuesIncluded: false
      },
      checks,
      summary,
      guarantees: {
        dockerRequestsMade: 0,
        runtimeMutated: false,
        routesMutated: false,
        providerStateMutated: false,
        providerDetached: false,
        applyApproved: false,
        secretValuesIncluded: false
      }
    };
    atomicWriteJson(path.join(reportsRoot, auditId + '.json'), report);
    prune(reportsRoot);
    return report;
  }

  function getAudit(auditId) {
    if (!AUDIT_ID_PATTERN.test(String(auditId || ''))) {
      throw new IndependenceAuditError('Invalid independence audit ID', 400, 'invalid-audit-id');
    }
    const report = readJson(path.join(reportsRoot, auditId + '.json'));
    if (!report) throw new IndependenceAuditError('Independence audit was not found', 404, 'audit-not-found');
    return report;
  }

  function status() {
    let availableCandidates = [];
    try {
      availableCandidates = candidates();
    } catch (error) {
      if (error.code !== 'registry-not-scanned') throw error;
    }
    return {
      schemaVersion: INDEPENDENCE_AUDIT_SCHEMA_VERSION,
      mode: 'read-only-independence-audit',
      candidates: availableCandidates,
      audits: listJson(reportsRoot),
      guarantees: {
        runtimeMutated: false,
        providerDetached: false,
        applyApproved: false,
        secretValuesIncluded: false
      }
    };
  }

  return { candidates, createAudit, getAudit, paths: { root, reportsRoot }, status };
}

module.exports = {
  AUDIT_WORKLOAD_INDEPENDENCE_CONFIRMATION,
  INDEPENDENCE_AUDIT_SCHEMA_VERSION,
  IndependenceAuditError,
  createIndependenceAuditManager
};
