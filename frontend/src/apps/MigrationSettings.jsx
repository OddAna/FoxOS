import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck
} from 'lucide-react';
import { apiFetch } from '../api';
import { useI18n } from '../contexts/LocaleContext';

const RESOURCE_CARD_STYLE = {
  background: 'rgba(255,255,255,0.055)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '14px',
  padding: '16px'
};

const ACTION_BUTTON_STYLE = {
  border: '1px solid rgba(255,255,255,0.15)',
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  borderRadius: '8px',
  padding: '7px 10px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  cursor: 'pointer',
  fontSize: '12px'
};

const PRIMARY_BUTTON_STYLE = {
  background: '#0ea5e9',
  color: '#fff',
  border: 'none',
  padding: '9px 14px',
  borderRadius: '8px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  fontSize: '13px',
  fontWeight: 'bold'
};

const SECONDARY_BUTTON_STYLE = {
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.16)',
  padding: '9px 14px',
  borderRadius: '8px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
  fontSize: '13px',
  fontWeight: 'bold'
};

const SELECT_STYLE = {
  minWidth: '210px',
  maxWidth: '100%',
  background: '#24242a',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.16)',
  padding: '9px 12px',
  borderRadius: '8px',
  outline: 'none',
  fontSize: '13px'
};

const REVIEW_STATES = {
  ready: 'migration.reviewStates.ready',
  blocked: 'migration.reviewStates.blocked',
  unsupported: 'migration.reviewStates.unsupported',
  managed: 'migration.reviewStates.managed',
  grouped: 'migration.reviewStates.grouped',
  retirement: 'migration.reviewStates.retirement',
  protected: 'migration.reviewStates.protected'
};

const STRATEGY_LABELS = {
  'blue-green-atomic-route': 'migration.strategies.blue-green-atomic-route',
  'shadow-refresh-bounded-quiesce': 'migration.strategies.shadow-refresh-bounded-quiesce',
  'database-aware-replication-handoff': 'migration.strategies.database-aware-replication-handoff',
  'drain-and-replace': 'migration.strategies.drain-and-replace',
  'provider-proxy-retirement-last': 'migration.strategies.provider-proxy-retirement-last',
  'provider-definition-recovery': 'migration.strategies.provider-definition-recovery',
  'host-network-service-adoption': 'migration.strategies.host-network-service-adoption',
  'host-service-adoption': 'migration.strategies.host-service-adoption',
  'already-server-owned': 'migration.strategies.already-server-owned',
  'migrate-with-parent': 'migration.strategies.migrate-with-parent',
  'provider-control-plane-retirement-last': 'migration.strategies.provider-control-plane-retirement-last',
  'already-foxos-managed': 'migration.strategies.already-foxos-managed',
  'protected-skip': 'migration.strategies.protected-skip',
  'dedicated-lifecycle-required': 'migration.strategies.dedicated-lifecycle-required',
  'manual-review-required': 'migration.strategies.manual-review-required'
};

const CLASS_LABELS = {
  application: 'migration.classes.application',
  'internal-service': 'migration.classes.internal-service',
  database: 'migration.classes.database',
  worker: 'migration.classes.worker',
  agent: 'migration.classes.agent',
  proxy: 'migration.classes.proxy',
  core: 'migration.classes.core',
  'network-service': 'migration.classes.network-service',
  stateless: 'migration.classes.stateless',
  stateful: 'migration.classes.stateful',
  'host-configured': 'migration.classes.host-configured',
  unknown: 'migration.classes.unknown',
  'provider-owned': 'migration.classes.provider-owned',
  'foxos-owned': 'migration.classes.foxos-owned',
  'server-owned': 'migration.classes.server-owned'
};

const AVAILABILITY_LABELS = {
  'zero-downtime-required': 'migration.availability.zero-downtime-required',
  'bounded-quiesce-budget-required': 'migration.availability.bounded-quiesce-budget-required',
  'stateful-presync-required': 'migration.availability.stateful-presync-required',
  'stateful-storage-capacity-insufficient': 'migration.availability.stateful-storage-capacity-insufficient',
  'stateful-storage-layout-unsupported': 'migration.availability.stateful-storage-layout-unsupported',
  'stateful-capacity-inspection-failed': 'migration.availability.stateful-capacity-inspection-failed',
  'bounded-quiesce-ready': 'migration.availability.bounded-quiesce-ready',
  'database-aware-handoff-required': 'migration.availability.database-aware-handoff-required',
  'already-managed': 'migration.availability.already-managed',
  'not-applicable': 'migration.availability.not-applicable',
  'unknown-blocked': 'migration.availability.unknown-blocked',
  'host-service-continuity-required': 'migration.availability.host-service-continuity-required',
  'included-with-parent': 'migration.availability.included-with-parent',
  'provider-retirement-pending': 'migration.availability.provider-retirement-pending',
  'in-place-runtime-transfer-ready': 'migration.availability.in-place-runtime-transfer-ready'
};

const ACTIVE_RUN_STATUSES = new Set(['queued', 'preparing', 'executing']);

const RUN_STATUS_LABELS = {
  queued: 'migration.runStatus.queued',
  preparing: 'migration.runStatus.preparing',
  executing: 'migration.runStatus.executing',
  completed: 'migration.runStatus.completed',
  blocked: 'migration.runStatus.blocked',
  failed: 'migration.runStatus.failed',
  'interrupted-before-execution': 'migration.runStatus.interrupted-before-execution',
  'interrupted-recovery-required': 'migration.runStatus.interrupted-recovery-required'
};

const CERTIFICATE_ADAPTER_LABELS = {
  'acme-http-01': 'migration.certificates.acme-http-01',
  'acme-dns-01': 'migration.certificates.acme-dns-01',
  'imported-certificate': 'migration.certificates.imported-certificate'
};

const translatedMapValue = (map, key, t) => map[key] ? t(map[key]) : key;

const blockerLabel = (blocker, t) => {
  if (!blocker) return '';
  const key = `migration.blockers.${blocker.code}`;
  const translated = t(key);
  return translated === key ? blocker.message || blocker.code : translated;
};

function runBlocker(run) {
  return run?.error || run?.blockers?.[0] ||
    run?.resources?.flatMap((resource) => resource.blockers || [])[0] || null;
}

function runBlockerText(run, t) {
  const blocker = runBlocker(run);
  return blocker && blockerLabel(blocker, t);
}

function reviewState(resource) {
  if (resource.protected) return 'protected';
  if (resource.readiness?.planningStatus === 'included-with-parent') return 'grouped';
  if (resource.readiness?.planningStatus === 'provider-retirement-pending') return 'retirement';
  if (!resource.migrationRequired) return 'managed';
  if (!resource.executionAdapter) return 'unsupported';
  const plannedApply = resource.readiness?.applyImplemented;
  const applyImplemented = plannedApply === true || (
    plannedApply === undefined && resource.strategy === 'blue-green-atomic-route'
  );
  if (!applyImplemented) return 'unsupported';
  const plannedEligibility = resource.readiness?.reviewEligible;
  const reviewEligible = plannedEligibility === true || (
    plannedEligibility === undefined &&
    resource.classification?.independenceAudit?.eligibleForReadOnlyAudit === true
  );
  if (!reviewEligible) return 'blocked';
  return 'ready';
}

function allBlockers(resource) {
  const blockers = Object.entries(resource.blockers || {}).flatMap(([group, entries]) => (
    (entries || []).map((blocker) => ({ ...blocker, group }))
  ));
  return Array.from(new Map(blockers.map((blocker) => [blocker.code, blocker])).values());
}

function shortId(value) {
  if (!value) return '—';
  return value.length > 22 ? value.slice(0, 12) + '…' + value.slice(-6) : value;
}

function reviewDraftFromStatus(status) {
  const current = !status?.stale ? status?.current : null;
  if (!current) return status?.defaults || null;
  return {
    healthRouteId: current.configuration.healthTarget?.routeId || null,
    runtimeConfirmed: current.configuration.runtime?.confirmed === true,
    routes: (current.configuration.routes || []).map((route) => ({
      routeId: route.routeId,
      confirmed: route.confirmed === true,
      certificateAdapter: route.certificateAdapter || null
    }))
  };
}

function formatMemory(value) {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value / 1024 / 1024)} MiB`;
}

function formatCpu(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value / 1_000_000_000} CPU`;
}

function DetailLine({ label, children, mono = false }) {
  return (
    <>
      <div style={{ color: '#888' }}>{label}</div>
      <div style={{ minWidth: 0, overflowWrap: 'anywhere', fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit' }}>
        {children ?? '—'}
      </div>
    </>
  );
}

function DetailSection({ title, description, children, last = false }) {
  return (
    <section style={{ padding: last ? '26px 0 0 0' : '26px 0', borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.08)' }}>
      <h2 style={{ margin: description ? '0 0 6px 0' : '0 0 14px 0', fontSize: '16px' }}>{title}</h2>
      {description && <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px' }}>{description}</div>}
      {children}
    </section>
  );
}

const MigrationSettings = ({ autoScan = false, onScanComplete = null }) => {
  const { formatDate, formatNumber, locale, t } = useI18n();
  const rootRef = useRef(null);
  const autoScanStartedRef = useRef(false);
  const [snapshot, setSnapshot] = useState(null);
  const [plan, setPlan] = useState(null);
  const [selectionStatus, setSelectionStatus] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [detailResourceId, setDetailResourceId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [latestRun, setLatestRun] = useState(null);
  const [message, setMessage] = useState(null);
  const [reviewPlan, setReviewPlan] = useState(null);
  const [reviewStatus, setReviewStatus] = useState(null);
  const [reviewDraft, setReviewDraft] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewMessage, setReviewMessage] = useState(null);

  const applyLoadedState = useCallback((registryPayload, orchestratorPayload, selectionPayload, runsPayload) => {
    const currentSnapshot = registryPayload.snapshot || null;
    const latestPlan = orchestratorPayload.latest || null;
    const currentPlan = currentSnapshot && latestPlan?.sourceSnapshotId === currentSnapshot.snapshotId
      ? latestPlan
      : null;
    const currentSelection = selectionPayload.current;
    const selectionMatches = Boolean(
      currentPlan && currentSelection && !selectionPayload.stale &&
      currentSelection.serverPlanId === currentPlan.planId &&
      currentSelection.sourceSnapshotId === currentSnapshot.snapshotId
    );

    setSnapshot(currentSnapshot);
    setPlan(currentPlan);
    setSelectionStatus(selectionPayload);
    setSelectedIds(selectionMatches ? currentSelection.selectedResourceIds : []);
    setLatestRun(runsPayload.latest || null);
    setDetailResourceId(null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [registryResponse, orchestratorResponse, selectionResponse, runsResponse] = await Promise.all([
        apiFetch('/api/resources'),
        apiFetch('/api/migration-orchestrator'),
        apiFetch('/api/migration-selections/current'),
        apiFetch('/api/migration-runs')
      ]);
      const [registryPayload, orchestratorPayload, selectionPayload, runsPayload] = await Promise.all([
        registryResponse.json(),
        orchestratorResponse.json(),
        selectionResponse.json(),
        runsResponse.json()
      ]);
      applyLoadedState(registryPayload, orchestratorPayload, selectionPayload, runsPayload);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  }, [applyLoadedState]);

  useEffect(() => {
    load();
  }, [load]);

  const latestRunId = latestRun?.runId;
  const latestRunStatus = latestRun?.status;

  useEffect(() => {
    if (!latestRunId || !ACTIVE_RUN_STATUSES.has(latestRunStatus)) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const response = await apiFetch(`/api/migration-runs/${latestRunId}`);
        const payload = await response.json();
        if (!active) return;
        setLatestRun(payload.run);
        if (!ACTIVE_RUN_STATUSES.has(payload.run.status)) {
          if (payload.run.status === 'completed') {
            await load();
            if (!active) return;
            setMessage({
              type: 'success',
              text: t('migration.runCompleted', { count: formatNumber(payload.run.summary.completed) })
            });
          } else if (payload.run.status === 'blocked') {
            setMessage({
              type: 'error',
              text: t('migration.runBlocked', { count: formatNumber(payload.run.summary.blocked) })
            });
          } else {
            const detail = runBlockerText(payload.run, t);
            setMessage({
              type: 'error',
              text: detail
                ? t('migration.runStoppedDetail', { detail })
                : t('migration.runStopped')
            });
          }
        }
      } catch (error) {
        if (active) setMessage({ type: 'error', text: error.message });
      }
    };
    const timer = window.setInterval(poll, 1000);
    poll();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [formatNumber, latestRunId, latestRunStatus, load, t]);

  useEffect(() => {
    const scrollContainer = rootRef.current?.closest('[data-settings-content]');
    scrollContainer?.scrollTo({ top: 0 });
  }, [detailResourceId]);

  useEffect(() => {
    let active = true;
    const resource = (plan?.resources || []).find((entry) => entry.resourceId === detailResourceId);
    setReviewPlan(null);
    setReviewStatus(null);
    setReviewDraft(null);
    setReviewMessage(null);
    if (
      !resource || reviewState(resource) !== 'ready' ||
      resource.executionAdapter !== 'stateless-blue-green'
    ) {
      setReviewLoading(false);
      return () => { active = false; };
    }

    const loadReview = async () => {
      setReviewLoading(true);
      try {
        const planResponse = await apiFetch('/api/stateless-migrations/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverPlanId: plan.planId,
            resourceId: resource.resourceId,
            confirmation: 'PREPARE STATELESS MIGRATION'
          })
        });
        const planPayload = await planResponse.json();
        const statusResponse = await apiFetch(`/api/stateless-migrations/plans/${planPayload.plan.planId}/review`);
        const statusPayload = await statusResponse.json();
        if (!active) return;
        setReviewPlan(planPayload.plan);
        setReviewStatus(statusPayload);
        setReviewDraft(reviewDraftFromStatus(statusPayload));
      } catch (error) {
        if (active) setReviewMessage({ type: 'error', text: error.message });
      } finally {
        if (active) setReviewLoading(false);
      }
    };
    loadReview();
    return () => { active = false; };
  }, [detailResourceId, plan]);

  const resources = useMemo(() => plan?.resources || [], [plan]);
  const snapshotResources = useMemo(() => new Map(
    (snapshot?.resources || []).map((resource) => [resource.id, resource])
  ), [snapshot]);
  const selectableIds = useMemo(() => resources
    .filter((resource) => reviewState(resource) === 'ready')
    .map((resource) => resource.resourceId), [resources]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const counts = useMemo(() => resources.reduce((result, resource) => {
    const state = reviewState(resource);
    result[state] += 1;
    return result;
  }, { ready: 0, blocked: 0, unsupported: 0, managed: 0, grouped: 0, retirement: 0, protected: 0 }), [resources]);

  const scanServer = useCallback(async () => {
    setScanning(true);
    setMessage(null);
    try {
      const scanResponse = await apiFetch('/api/resources/scan', { method: 'POST' });
      const scanPayload = await scanResponse.json();
      const planResponse = await apiFetch('/api/migration-orchestrator/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'PLAN SERVER MIGRATION' })
      });
      const planPayload = await planResponse.json();
      const selectionResponse = await apiFetch('/api/migration-selections/current');
      const selectionPayload = await selectionResponse.json();
      const runsResponse = await apiFetch('/api/migration-runs');
      const runsPayload = await runsResponse.json();
      applyLoadedState(
        { snapshot: scanPayload.snapshot },
        { latest: planPayload.plan },
        selectionPayload,
        runsPayload
      );
      setMessage({
        type: 'success',
        text: t('migration.scanSuccess', { count: formatNumber(planPayload.plan.summary.resources) })
      });
      onScanComplete?.({
        success: true,
        snapshot: scanPayload.snapshot,
        plan: planPayload.plan
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
      onScanComplete?.({ success: false, error: error.message });
    } finally {
      setScanning(false);
    }
  }, [applyLoadedState, formatNumber, onScanComplete, t]);

  useEffect(() => {
    if (!autoScan || loading || autoScanStartedRef.current) return;
    autoScanStartedRef.current = true;
    scanServer();
  }, [autoScan, loading, scanServer]);

  const toggleResource = (resourceId) => {
    setSelectedIds((current) => current.includes(resourceId)
      ? current.filter((value) => value !== resourceId)
      : [...current, resourceId].sort());
    setMessage(null);
  };

  const toggleAll = () => {
    const allSelected = selectableIds.every((resourceId) => selectedSet.has(resourceId));
    setSelectedIds(allSelected ? [] : [...selectableIds].sort());
    setMessage(null);
  };

  const startMigration = async () => {
    if (!plan) return;
    setStarting(true);
    setMessage(null);
    try {
      const response = await apiFetch('/api/migration-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverPlanId: plan.planId,
          resourceIds: selectedIds,
          confirmation: 'START SERVER MIGRATION'
        })
      });
      const payload = await response.json();
      setLatestRun(payload.run);
      const selectionResponse = await apiFetch('/api/migration-selections/current');
      setSelectionStatus(await selectionResponse.json());
      setMessage({
        type: 'success',
        text: t('migration.migrationStarted', { count: formatNumber(selectedIds.length) })
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setStarting(false);
    }
  };

  const updateReviewRoute = (routeId, patch) => {
    setReviewDraft((current) => ({
      ...current,
      routes: (current?.routes || []).map((route) => (
        route.routeId === routeId ? { ...route, ...patch } : route
      ))
    }));
    setReviewMessage(null);
  };

  const saveReview = async () => {
    if (!reviewPlan || !reviewDraft) return;
    setReviewSaving(true);
    setReviewMessage(null);
    try {
      const response = await apiFetch(`/api/stateless-migrations/plans/${reviewPlan.planId}/review`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverPlanId: reviewPlan.serverPlanId,
          resourceId: reviewPlan.resource.resourceId,
          executionContractId: reviewPlan.executionContract.contractId,
          healthRouteId: reviewDraft.healthRouteId,
          runtimeConfirmed: reviewDraft.runtimeConfirmed,
          routes: reviewDraft.routes,
          confirmation: 'SAVE STATELESS MIGRATION REVIEW'
        })
      });
      const payload = await response.json();
      setReviewStatus(payload.status);
      setReviewDraft(reviewDraftFromStatus(payload.status));
      setReviewMessage({
        type: payload.review.reviewComplete ? 'success' : 'error',
        text: payload.review.reviewComplete
          ? t('migration.reviewComplete')
          : t('migration.reviewIncomplete', { count: formatNumber(payload.review.reviewBlockers.length) })
      });
    } catch (error) {
      setReviewMessage({ type: 'error', text: error.message });
    } finally {
      setReviewSaving(false);
    }
  };

  if (loading) {
    return (
      <div ref={rootRef} style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Loader2 size={15} className="spin" /> {t('migration.loadingInventory')}
      </div>
    );
  }

  const detailResource = resources.find((resource) => resource.resourceId === detailResourceId);
  if (detailResource) {
    const observed = snapshotResources.get(detailResource.resourceId) || {};
    const classification = detailResource.classification || {};
    const state = reviewState(detailResource);
    const blockers = allBlockers(detailResource);
    const routes = observed.routes || [];
    const mounts = observed.mounts || [];
    const dependencies = detailResource.dependencies || [];
    const isReady = state === 'ready';
    const executionContract = reviewPlan?.executionContract || null;
    const contractBlockers = executionContract?.readiness?.blockers || [];
    const reviewedRoutes = new Map((reviewDraft?.routes || []).map((route) => [route.routeId, route]));
    const runtimeDefaults = new Set(executionContract?.uiReview?.runtimeDefaultsApplied || []);

    return (
      <div ref={rootRef}>
        <button
          type="button"
          onClick={() => setDetailResourceId(null)}
          style={{ background: 'transparent', color: '#aaa', border: 'none', padding: '0', marginBottom: '24px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}
        >
          <ArrowLeft size={16} /> {t('migration.backToScan')}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '18px', paddingBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <Server size={24} color="#38bdf8" style={{ flex: '0 0 auto' }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 style={{ margin: '0 0 6px 0', fontSize: '28px', fontWeight: 'bold', overflowWrap: 'anywhere' }}>{detailResource.name}</h1>
            <div title={detailResource.resourceId} style={{ color: '#888', fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }}>
              {detailResource.resourceId}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: isReady ? '#27c93f' : '#8b93a1', fontSize: '13px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'currentColor' }} />
            {translatedMapValue(REVIEW_STATES, state, t)}
          </div>
        </div>

        <DetailSection title={t('migration.detail.resourceInfo')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', wordBreak: 'break-word' }}>
            <DetailLine label={t('migration.detail.health')}>{observed.runtime?.health?.status || observed.runtime?.state}</DetailLine>
            <DetailLine label={t('migration.detail.currentManagement')}>{detailResource.currentProvider || detailResource.observedProvider || 'docker'}</DetailLine>
            {detailResource.management?.sourcePreserved && (
              <DetailLine label={t('migration.detail.preservedSource')}>{t('migration.detail.preservedForRollback', { provider: detailResource.observedProvider || 'docker' })}</DetailLine>
            )}
            <DetailLine label={t('migration.detail.management')}>{translatedMapValue(CLASS_LABELS, detailResource.currentAuthorityClass || classification.authorityClass, t)}</DetailLine>
            <DetailLine label={t('migration.detail.resourceClass')}>{translatedMapValue(CLASS_LABELS, classification.workloadRole, t)} · {translatedMapValue(CLASS_LABELS, classification.stateClass, t)}</DetailLine>
            <DetailLine label={t('migration.detail.reviewStrategy')}>{translatedMapValue(STRATEGY_LABELS, detailResource.strategy, t)}</DetailLine>
            <DetailLine label={t('migration.detail.readiness')}>
              {state === 'managed'
                ? detailResource.management?.state === 'active' ? t('migration.detail.migrationComplete') : t('migration.detail.managedReviewRequired')
                : detailResource.readiness?.evidenceComplete ? t('migration.detail.prerequisitesComplete') : t('migration.detail.missingInDetails')}
            </DetailLine>
            <DetailLine label={t('migration.detail.availability')}>{translatedMapValue(AVAILABILITY_LABELS, detailResource.availability?.currentMode, t)}</DetailLine>
            <DetailLine label={t('migration.detail.image')} mono>{observed.runtime?.image}</DetailLine>
            <DetailLine label="Container" mono>{shortId(observed.runtime?.containerId)}</DetailLine>
            <DetailLine label={t('migration.detail.environmentVariables')}>{detailResource.evidence?.environmentVariableCount ?? '—'}</DetailLine>
            <DetailLine label={t('migration.detail.manifestRevision')} mono>{shortId(detailResource.evidence?.manifestRevisionId)}</DetailLine>
          </div>
        </DetailSection>

        <DetailSection title={t('migration.detail.domainsRoutes')} description={t('migration.detail.domainsDescription')}>
          {routes.length ? routes.map((route, index) => (
            <div key={`${route.domain}-${route.path}-${index}`} style={{ fontSize: '13px', marginTop: index ? '8px' : 0, overflowWrap: 'anywhere' }}>
              {route.tls ? 'https' : 'http'}://{route.domain}{route.path || '/'}
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>{t('migration.detail.noRoutes')}</div>}
        </DetailSection>

        <DetailSection title={t('migration.detail.storage')} description={t('migration.detail.storageDescription')}>
          {mounts.length ? mounts.map((mount, index) => (
            <div key={`${mount.destination}-${index}`} style={{ fontSize: '13px', marginTop: index ? '10px' : 0, overflowWrap: 'anywhere' }}>
              <div>{mount.name || mount.source || mount.type} → {mount.destination}</div>
              <div style={{ color: '#888', fontSize: '12px', marginTop: '2px' }}>{mount.readOnly ? t('migration.detail.readOnly') : t('migration.detail.writable')} · {mount.type}</div>
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>{t('migration.detail.noStorage')}</div>}
        </DetailSection>

        <DetailSection title={t('migration.detail.relationships')}>
          {dependencies.length ? dependencies.map((dependency, index) => (
            <div key={dependency.relationshipId || index} style={{ fontSize: '13px', marginTop: index ? '10px' : 0 }}>
              <div>{dependency.type || t('migration.detail.relationship')} · {dependency.required ? t('migration.detail.requiredDependency') : t('migration.detail.observedRelationship')}</div>
              <div style={{ color: '#888', fontSize: '12px', marginTop: '2px', overflowWrap: 'anywhere' }}>
                {(dependency.resourceIds || []).join(', ')}
              </div>
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>{t('migration.detail.noDependencies')}</div>}
        </DetailSection>

        {isReady && detailResource.executionAdapter === 'runtime-transfer' && (
          <DetailSection title={t('migration.detail.migrationReview')} description={t('migration.detail.transferDescription')}>
            <div style={{ fontSize: '13px', lineHeight: 1.5 }}>
              {detailResource.migrationGroup?.memberResourceIds?.length > 1
                ? t('migration.detail.groupedTransfer', { count: formatNumber(detailResource.migrationGroup.memberResourceIds.length) })
                : t('migration.detail.preserveRuntime')}
            </div>
          </DetailSection>
        )}

        {isReady && detailResource.executionAdapter !== 'runtime-transfer' && (
          <>
            <DetailSection title={t('migration.detail.migrationReview')} description={t('migration.detail.reviewDescription')}>
              {reviewLoading ? (
                <div style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Loader2 size={15} className="spin" /> {t('migration.detail.preparingContract')}
                </div>
              ) : reviewMessage?.type === 'error' && !reviewPlan ? (
                <div style={{ color: '#ff8a84', fontSize: '13px' }}>{reviewMessage.text}</div>
              ) : reviewStatus?.stale ? (
                <div style={{ color: '#ccc', fontSize: '13px' }}>{t('migration.detail.inventoryChanged')}</div>
              ) : contractBlockers.length ? (
                <div>
                  {contractBlockers.map((blocker, index) => (
                    <div key={`${blocker.code}-${index}`} style={{ fontSize: '13px', marginTop: index ? '10px' : 0 }}>
                      {blockerLabel(blocker, t)}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px' }}>
                  <DetailLine label={t('migration.detail.plan')} mono>{shortId(reviewPlan?.planId)}</DetailLine>
                  <DetailLine label={t('migration.detail.contract')} mono>{shortId(executionContract?.contractId)}</DetailLine>
                  <DetailLine label={t('migration.detail.recordStatus')}>{reviewStatus?.state === 'complete' ? t('migration.detail.reviewCompleted') : t('migration.detail.reviewMissing')}</DetailLine>
                  <DetailLine label={t('migration.detail.execution')}>{t('migration.detail.off')}</DetailLine>
                </div>
              )}
            </DetailSection>

            {executionContract && !contractBlockers.length && reviewDraft && !reviewStatus?.stale && (
              <>
                <DetailSection title={t('migration.detail.healthTarget')} description={t('migration.detail.healthTargetDescription')}>
                  <select
                    value={reviewDraft.healthRouteId || ''}
                    onChange={(event) => {
                      setReviewDraft((current) => ({ ...current, healthRouteId: event.target.value || null }));
                      setReviewMessage(null);
                    }}
                    style={SELECT_STYLE}
                  >
                    <option value="">{t('migration.detail.selectHealthTarget')}</option>
                    {(executionContract.routes || []).map((route) => (
                      <option key={route.routeId} value={route.routeId}>
                        {route.domain}{route.path} → :{route.upstreamPrivatePort}
                      </option>
                    ))}
                  </select>
                  <div style={{ color: '#888', fontSize: '12px', marginTop: '9px' }}>{t('migration.detail.acceptedHttp')}</div>
                </DetailSection>

                <DetailSection title={t('migration.detail.runtimeLimits')} description={t('migration.detail.runtimeLimitsDescription')}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px' }}>
                    <DetailLine label={`${t('migration.detail.memory')}${runtimeDefaults.has('memoryBytes') ? t('migration.detail.defaultSuffix') : ''}`}>{formatMemory(executionContract.candidate.runtime.memoryBytes)}</DetailLine>
                    <DetailLine label={`CPU${runtimeDefaults.has('nanoCpus') ? t('migration.detail.defaultSuffix') : ''}`}>{formatCpu(executionContract.candidate.runtime.nanoCpus)}</DetailLine>
                    <DetailLine label={`${t('migration.detail.pidLimit')}${runtimeDefaults.has('pidsLimit') ? t('migration.detail.defaultSuffix') : ''}`}>{executionContract.candidate.runtime.pidsLimit}</DetailLine>
                    <DetailLine label={t('migration.detail.restart')}>{executionContract.candidate.runtime.restartPolicy}</DetailLine>
                    <DetailLine label={t('migration.detail.runtimeUser')}>{executionContract.candidate.runtime.user || t('migration.detail.imageDefault')}</DetailLine>
                    <DetailLine label={t('migration.detail.rootFilesystem')}>{executionContract.candidate.runtime.readOnlyRootFilesystem ? t('migration.detail.readOnly') : t('migration.detail.writable')}</DetailLine>
                    <DetailLine label={t('migration.detail.hostPort')}>{t('migration.detail.notPublished')}</DetailLine>
                    <DetailLine label={t('migration.detail.writableMount')}>{t('migration.detail.none')}</DetailLine>
                    <DetailLine label={t('migration.detail.privileged')}>{t('migration.detail.off')}</DetailLine>
                    <DetailLine label={t('migration.detail.additionalCapabilities')}>{t('migration.detail.capabilitiesOff')}</DetailLine>
                  </div>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '13px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={reviewDraft.runtimeConfirmed === true}
                      onChange={(event) => {
                        setReviewDraft((current) => ({ ...current, runtimeConfirmed: event.target.checked }));
                        setReviewMessage(null);
                      }}
                    />
                    {t('migration.detail.reviewedRuntime')}
                  </label>
                </DetailSection>

                <DetailSection title={t('migration.detail.routesCertificates')} description={t('migration.detail.routesDescription')}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
                    {(executionContract.routes || []).map((route) => {
                      const reviewed = reviewedRoutes.get(route.routeId) || {};
                      return (
                        <div key={route.routeId} style={RESOURCE_CARD_STYLE}>
                          <div style={{ fontSize: '13px', overflowWrap: 'anywhere' }}>https://{route.domain}{route.path}</div>
                          <div style={{ color: '#888', fontSize: '12px', marginTop: '3px' }}>{t('migration.detail.internalPort', { port: route.upstreamPrivatePort })}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginTop: '14px' }}>
                            <select
                              aria-label={t('migration.detail.certificateLabel', { route: `${route.domain}${route.path}` })}
                              value={reviewed.certificateAdapter || ''}
                              onChange={(event) => updateReviewRoute(route.routeId, { certificateAdapter: event.target.value || null })}
                              style={SELECT_STYLE}
                            >
                              <option value="">{t('migration.detail.selectCertificate')}</option>
                              {(reviewStatus?.certificateAdapters || []).map((adapter) => (
                                <option key={adapter} value={adapter}>{translatedMapValue(CERTIFICATE_ADAPTER_LABELS, adapter, t)}</option>
                              ))}
                            </select>
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '13px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={reviewed.confirmed === true}
                                onChange={(event) => updateReviewRoute(route.routeId, { confirmed: event.target.checked })}
                              />
                              {t('migration.detail.reviewedRoute')}
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ color: '#888', fontSize: '12px', marginTop: '10px', lineHeight: 1.45 }}>
                    {t('migration.detail.acmeNote')}
                  </div>
                </DetailSection>

                <DetailSection title={t('migration.detail.reviewRecord')}>
                  {reviewMessage && (
                    <div style={{ marginBottom: '14px', color: reviewMessage.type === 'error' ? '#ff8a84' : '#75da85', fontSize: '13px' }}>
                      {reviewMessage.text}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={saveReview}
                    disabled={reviewSaving}
                    style={{ ...PRIMARY_BUTTON_STYLE, cursor: reviewSaving ? 'wait' : 'pointer', opacity: reviewSaving ? 0.6 : 1 }}
                  >
                    {reviewSaving ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
                    {t('migration.detail.saveReview')}
                  </button>
                </DetailSection>
              </>
            )}
          </>
        )}

        <DetailSection title={t('migration.detail.blockers')} last>
          {blockers.length ? blockers.map((blocker, index) => (
            <div key={`${blocker.group}-${blocker.code}-${index}`} style={{ padding: index ? '12px 0 0' : 0, marginTop: index ? '12px' : 0, borderTop: index ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
              <div style={{ fontSize: '13px', lineHeight: 1.45 }}>{blockerLabel(blocker, t)}</div>
              <div style={{ color: '#888', fontSize: '11px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }}>{blocker.code}</div>
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>{t('migration.detail.noBlockers')}</div>}
        </DetailSection>
      </div>
    );
  }

  const countSummary = Object.entries(REVIEW_STATES)
    .filter(([state]) => counts[state] > 0)
    .map(([state, labelKey]) => `${formatNumber(counts[state])} ${t(labelKey).toLocaleLowerCase(locale)}`)
    .join(' · ');
  const latestRunAlreadyManaged = Boolean(
    latestRun && ['failed', 'blocked'].includes(latestRun.status) && latestRun.resources?.length &&
    latestRun.resources.every((runResource) => {
      const current = resources.find((resource) => resource.resourceId === runResource.resourceId);
      return current?.management?.owner === 'foxos' && current.management.state === 'active';
    })
  );
  const latestRunBlockerText = runBlockerText(latestRun, t);

  return (
    <div ref={rootRef}>
      <section style={{ padding: '0 0 26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>{t('migration.scan.title')}</h2>
        <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
          {t('migration.scan.description')}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
          <button
            type="button"
            onClick={scanServer}
            disabled={scanning}
            style={{ ...SECONDARY_BUTTON_STYLE, cursor: scanning ? 'wait' : 'pointer', opacity: scanning ? 0.6 : 1 }}
          >
            {scanning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            {scanning ? t('migration.scan.scanning') : t('migration.scan.action')}
          </button>
          {snapshot && (
            <div style={{ color: '#888', fontSize: '12px' }}>
              {t('migration.scan.last', {
                date: formatDate(snapshot.generatedAt, { dateStyle: 'short', timeStyle: 'medium' }),
                count: formatNumber(snapshot.summary?.resources ?? resources.length)
              })}
            </div>
          )}
        </div>
      </section>

      {message && (
        <div style={{ marginTop: '20px', padding: '10px 12px', borderRadius: '8px', background: message.type === 'error' ? 'rgba(255,95,86,0.12)' : 'rgba(39,201,63,0.12)', border: `1px solid ${message.type === 'error' ? 'rgba(255,95,86,0.35)' : 'rgba(39,201,63,0.35)'}`, color: message.type === 'error' ? '#ff8a84' : '#75da85', fontSize: '13px' }}>
          {message.text}
        </div>
      )}

      {selectionStatus?.stale && (
        <div style={{ marginTop: '20px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#ccc', fontSize: '13px', lineHeight: 1.45 }}>
          {t('migration.scan.staleSelection')}
        </div>
      )}

      {!plan ? (
        <section style={{ padding: '26px 0 0 0' }}>
          <div style={{ ...RESOURCE_CARD_STYLE, color: '#8b93a1', textAlign: 'center', fontSize: '13px' }}>
            {t('migration.scan.empty')}
          </div>
        </section>
      ) : (
        <>
          <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>{t('migration.resources.title')}</h2>
            <div style={{ marginBottom: '14px', color: '#888', fontSize: '12px' }}>{countSummary}</div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', marginBottom: '12px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', color: selectableIds.length ? '#fff' : '#888', fontSize: '13px', cursor: selectableIds.length ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  checked={selectableIds.length > 0 && selectableIds.every((resourceId) => selectedSet.has(resourceId))}
                  onChange={toggleAll}
                  disabled={!selectableIds.length}
                />
                {t('migration.resources.selectAll')}
              </label>
              <span style={{ color: '#8b93a1', fontSize: '12px' }}>{t('migration.resources.selected', { count: formatNumber(selectedIds.length) })}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
              {resources.map((resource) => {
                const state = reviewState(resource);
                const selectable = state === 'ready';
                const observed = snapshotResources.get(resource.resourceId) || {};
                const routeDomains = (observed.routes || []).map((route) => route.domain).filter(Boolean);
                const classification = resource.classification || {};
                const isReady = state === 'ready';

                return (
                  <div key={resource.resourceId} style={{ ...RESOURCE_CARD_STYLE, display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <input
                      type="checkbox"
                      aria-label={t('migration.resources.selectLabel', { name: resource.name })}
                      checked={selectedSet.has(resource.resourceId)}
                      onChange={() => toggleResource(resource.resourceId)}
                      disabled={!selectable}
                      style={{ opacity: selectable ? 1 : 0.5 }}
                    />
                    <div style={{ width: '10px', height: '10px', borderRadius: '50%', flex: '0 0 auto', background: isReady ? '#27c93f' : '#6b7280', boxShadow: isReady ? '0 0 12px rgba(39,201,63,0.45)' : 'none' }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <strong style={{ fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{resource.name}</strong>
                        {resource.protected && <ShieldCheck size={14} color="#38bdf8" />}
                      </div>
                      <div style={{ color: '#8b93a1', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '3px' }}>
                        {resource.currentProvider || resource.observedProvider || 'docker'} · {classification.workloadRole ? translatedMapValue(CLASS_LABELS, classification.workloadRole, t) : t('migration.resources.unknown')} · {observed.runtime?.health?.status || observed.runtime?.state || t('migration.resources.unknownLower')}
                        {routeDomains.length ? ` · ${routeDomains.join(', ')}` : ` · ${t('migration.resources.storageBindings', { count: formatNumber((observed.mounts || []).length) })}`}
                      </div>
                    </div>
                    <div style={{ color: '#8b93a1', fontSize: '12px', whiteSpace: 'nowrap' }}>{translatedMapValue(REVIEW_STATES, state, t)}</div>
                    <button
                      type="button"
                      onClick={() => setDetailResourceId(resource.resourceId)}
                      style={ACTION_BUTTON_STYLE}
                    >
                      {t('migration.resources.details')} <ChevronRight size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section style={{ padding: '26px 0 0 0' }}>
            <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>{t('migration.start.title')}</h2>
            <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
              {t('migration.start.description')}
            </div>
            {latestRun && (
              <div style={{ marginBottom: '14px', color: '#888', fontSize: '12px' }}>
                <div>
                  {latestRunAlreadyManaged
                    ? t('migration.start.latestManaged', {
                      completed: formatNumber(latestRun.resources.length),
                      total: formatNumber(latestRun.resources.length)
                    })
                    : t('migration.start.latestRun', {
                      status: translatedMapValue(RUN_STATUS_LABELS, latestRun.status, t),
                      completed: formatNumber(latestRun.summary?.completed || 0),
                      total: formatNumber(latestRun.summary?.selected || 0)
                    })}
                </div>
                {!latestRunAlreadyManaged && latestRunBlockerText && (
                  <div style={{ marginTop: '5px', color: '#ff8a84', lineHeight: 1.45 }}>{latestRunBlockerText}</div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={startMigration}
              disabled={starting || !selectedIds.length || ACTIVE_RUN_STATUSES.has(latestRun?.status)}
              style={{ ...PRIMARY_BUTTON_STYLE, cursor: starting || !selectedIds.length || ACTIVE_RUN_STATUSES.has(latestRun?.status) ? 'not-allowed' : 'pointer', opacity: starting || !selectedIds.length || ACTIVE_RUN_STATUSES.has(latestRun?.status) ? 0.5 : 1 }}
            >
              {starting || ACTIVE_RUN_STATUSES.has(latestRun?.status) ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
              {starting || ACTIVE_RUN_STATUSES.has(latestRun?.status) ? t('migration.start.starting') : t('migration.start.action')}
            </button>
          </section>
        </>
      )}
    </div>
  );
};

export default MigrationSettings;
