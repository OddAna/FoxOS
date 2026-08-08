const crypto = require('node:crypto');

const UI_APPROVAL_TTL_MS = 60 * 1000;
const UI_APPROVAL_SOURCE = 'foxos-ui';
const TOKEN_PATTERN = /^uig_([a-f0-9]{24})\.([A-Za-z0-9_-]{32,128})$/;

class UiApprovalError extends Error {
  constructor(message, statusCode = 403, code = 'ui-approval-error') {
    super(message);
    this.name = 'UiApprovalError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function createUiApprovalManager({
  clock = () => new Date(),
  randomBytes = crypto.randomBytes,
  ttlMs = UI_APPROVAL_TTL_MS
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 5 * 60 * 1000) {
    throw new Error('FoxOS UI approval TTL is invalid');
  }
  const grants = new Map();

  function nowMs() {
    return new Date(clock()).getTime();
  }

  function prune() {
    const current = nowMs();
    for (const [grantId, grant] of grants.entries()) {
      if (grant.expiresAtMs <= current) grants.delete(grantId);
    }
  }

  function issue({ kind, planId, resourceId, evidenceFingerprint, actor }) {
    if (
      !kind || !planId || !resourceId || !evidenceFingerprint ||
      !actor || actor.type !== 'foxos-session' || !actor.sessionToken
    ) {
      throw new UiApprovalError('Authenticated FoxOS UI approval context is required', 401, 'ui-session-required');
    }
    prune();
    const grantId = randomBytes(12).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const issuedAtMs = nowMs();
    const grant = {
      grantId,
      kind,
      planId,
      resourceId,
      evidenceFingerprint,
      actor: {
        type: 'foxos-session',
        username: actor.username || null,
        sessionFingerprint: crypto.createHash('sha256').update(actor.sessionToken).digest('hex').slice(0, 16)
      },
      secretDigest: digest(secret),
      issuedAtMs,
      expiresAtMs: issuedAtMs + ttlMs
    };
    grants.set(grantId, grant);
    return 'uig_' + grantId + '.' + secret;
  }

  async function verify({ kind, planId, resourceId, evidenceFingerprint, approval }) {
    prune();
    const match = TOKEN_PATTERN.exec(String(approval || ''));
    if (!match) throw new UiApprovalError('FoxOS UI approval is invalid', 403, 'ui-approval-invalid');
    const [, grantId, secret] = match;
    const grant = grants.get(grantId);
    if (!grant) throw new UiApprovalError('FoxOS UI approval is unavailable or already used', 403, 'ui-approval-unavailable');

    // Consume before validating the binding so every grant is strictly one-shot.
    grants.delete(grantId);
    const suppliedDigest = digest(secret);
    const secretMatches = suppliedDigest.length === grant.secretDigest.length &&
      crypto.timingSafeEqual(suppliedDigest, grant.secretDigest);
    if (!secretMatches) throw new UiApprovalError('FoxOS UI approval is invalid', 403, 'ui-approval-invalid');
    if (grant.expiresAtMs <= nowMs()) {
      throw new UiApprovalError('FoxOS UI approval expired', 403, 'ui-approval-expired');
    }
    if (
      grant.kind !== kind || grant.planId !== planId ||
      grant.resourceId !== resourceId || grant.evidenceFingerprint !== evidenceFingerprint
    ) {
      throw new UiApprovalError('FoxOS UI approval is bound to another migration', 409, 'ui-approval-binding-mismatch');
    }
    return {
      approved: true,
      source: UI_APPROVAL_SOURCE,
      kind,
      planId,
      resourceId,
      evidenceFingerprint,
      grantId,
      oneTime: true,
      consumed: true,
      approvedAt: new Date(grant.issuedAtMs).toISOString(),
      expiresAt: new Date(grant.expiresAtMs).toISOString()
    };
  }

  function status() {
    prune();
    return {
      source: UI_APPROVAL_SOURCE,
      oneTime: true,
      ttlMs,
      outstanding: grants.size,
      rawTokensPersisted: false,
      externalApprovalEndpointExposed: false
    };
  }

  return { issue, status, verify };
}

module.exports = {
  UI_APPROVAL_SOURCE,
  UI_APPROVAL_TTL_MS,
  UiApprovalError,
  createUiApprovalManager
};
