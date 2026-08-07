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
  ready: 'Geçiş hazırlığına uygun',
  blocked: 'Eksik bilgi',
  unsupported: 'Geçiş desteği hazırlanıyor',
  managed: 'Sunucu yönetiminde',
  grouped: 'Bağlı uygulamayla birlikte geçirilecek',
  retirement: 'Sağlayıcı kaldırılırken sona bırakılacak',
  protected: 'Korunan sistem kaynağı'
};

const STRATEGY_LABELS = {
  'blue-green-atomic-route': 'Kesintisiz blue/green geçiş',
  'shadow-refresh-bounded-quiesce': 'Durumlu gölge kopya ve kontrollü geçiş',
  'database-aware-replication-handoff': 'Veritabanına özel aktarım',
  'drain-and-replace': 'İşi boşalt ve değiştir',
  'provider-proxy-retirement-last': 'Sağlayıcı proxy’sini en son kaldır',
  'provider-definition-recovery': 'Deaktif tanımı kurtar ve yeniden oluştur',
  'host-network-service-adoption': 'Host ağ servisini güvenli biçimde devral',
  'host-service-adoption': 'Host servisini güvenli biçimde devral',
  'already-server-owned': 'Doğrudan sunucu yönetiminde',
  'migrate-with-parent': 'Ana uygulamayla tek grup olarak geçir',
  'provider-control-plane-retirement-last': 'Sağlayıcı kontrol düzlemini en son kaldır',
  'already-foxos-managed': 'Sunucu yönetiminde',
  'protected-skip': 'Korunan kaynak — atla',
  'dedicated-lifecycle-required': 'Kaynağa özel yaşam döngüsü gerekli',
  'manual-review-required': 'Elle inceleme gerekli'
};

const CLASS_LABELS = {
  application: 'Uygulama',
  'internal-service': 'İç servis',
  database: 'Veritabanı',
  worker: 'Worker',
  agent: 'Ajan',
  proxy: 'Proxy',
  core: 'Sistem',
  'network-service': 'Ağ servisi',
  stateless: 'Durumsuz',
  stateful: 'Durumlu',
  'host-configured': 'Host yapılandırmalı',
  unknown: 'Belirsiz',
  'provider-owned': 'Harici sağlayıcı yönetiminde',
  'foxos-owned': 'Sunucu yönetiminde',
  'server-owned': 'Doğrudan sunucu yönetiminde'
};

const AVAILABILITY_LABELS = {
  'zero-downtime-required': 'Kesintisiz geçiş gerekli',
  'bounded-quiesce-budget-required': 'Onaylı kısa duraklama bütçesi gerekli',
  'stateful-presync-required': 'Çalışırken ön eşitleme gerekli',
  'stateful-storage-capacity-insufficient': 'Yeterli boş depolama yok',
  'stateful-storage-layout-unsupported': 'Depolama düzeni desteklenmiyor',
  'stateful-capacity-inspection-failed': 'Depolama doğrulaması tamamlanamadı',
  'bounded-quiesce-ready': 'Kontrollü kısa duraklama ve otomatik geri alma',
  'database-aware-handoff-required': 'Veritabanı tutarlılığı korunmalı',
  'already-managed': 'Mevcut çalışma korunacak',
  'not-applicable': 'Uygulanmaz',
  'unknown-blocked': 'Belirsiz — engelli',
  'host-service-continuity-required': 'Host servisi kesintisiz korunmalı',
  'included-with-parent': 'Ana uygulamanın geçiş sözleşmesine dahil',
  'provider-retirement-pending': 'Tüm uygulamalar bağımsız olduktan sonra kaldırılacak'
};

const ACTIVE_RUN_STATUSES = new Set(['queued', 'preparing', 'executing']);

const RUN_STATUS_LABELS = {
  queued: 'Sıraya alındı',
  preparing: 'Ön kontroller yapılıyor',
  executing: 'Geçiş yürütülüyor',
  completed: 'Tamamlandı',
  blocked: 'Güvenlik kapısında durdu',
  failed: 'Başarısız — sıra durduruldu',
  'interrupted-before-execution': 'Çalıştırılmadan kesildi',
  'interrupted-recovery-required': 'Kurtarma incelemesi gerekli'
};

const CERTIFICATE_ADAPTER_LABELS = {
  'acme-http-01': 'ACME HTTP-01',
  'acme-dns-01': 'ACME DNS-01',
  'imported-certificate': 'Sunucudaki özel sertifika'
};

const BLOCKER_LABELS = {
  'external-provider-authority': 'Yönetim otoritesi hâlâ harici sağlayıcıda.',
  'source-runtime-binding-missing': 'Çalışan imajı yeniden üretecek doğrulanmış kaynak bağı eksik.',
  'immutable-source-evidence-missing': 'Değişmez kaynak sürümü kanıtı eksik.',
  'environment-evidence-missing': 'Ortam değişkenleri için güvenli kanıt eksik.',
  'immutable-image-missing': 'Bu imajı değişmez biçimde yeniden kuracak repository digest kanıtı eksik.',
  'foxos-health-proof-missing': 'Sunucu tarafından üretilmiş güncel sağlık kanıtı eksik.',
  'foxos-route-missing': 'Gözlenen sağlayıcı rotasının sunucu yönetiminde etkin bir karşılığı yok.',
  'runtime-resource-limits-missing': 'CPU, bellek ve işlem sınırları açıkça belirlenmemiş.',
  'update-rollback-proof-missing': 'Sunucuya ait başarılı güncelleme ve birebir geri alma kanıtı eksik.',
  'recovery-target-unavailable': 'Sunucu dışı kurtarma hedefi hazır değil.',
  'migration-apply-transaction-not-implemented': 'Gerçek geçiş işlemi bu sürümde henüz açılmadı.',
  'general-domain-route-cutover-not-implemented': 'Genel alan adı ve TLS yönlendirme geçişi henüz açılmadı.',
  'zero-downtime-blue-green-apply-not-implemented': 'Kesintisiz blue/green çalıştırma henüz açılmadı.',
  'stateful-cutover-pause-budget-unset': 'Durumlu geçiş için izin verilen azami duraklama süresi belirlenmedi.',
  'database-aware-handoff-not-implemented': 'Veritabanına özel çoğaltma ve ana sunucu devri henüz açılmadı.',
  'worker-drain-policy-not-implemented': 'Kuyruk boşaltma ve devam eden iş kurtarma politikası eksik.',
  'provider-proxy-retirement-gate-open': 'Bağımlı tüm rotalar doğrulanmadan sağlayıcı proxy’si kaldırılamaz.',
  'resource-class-migration-policy-missing': 'Bu kaynak sınıfı için incelenmiş geçiş politikası yok.',
  'provider-definition-runtime-evidence-missing': 'Deaktif tanımın çalışan runtime kanıtı henüz yok.',
  'provider-definition-runtime-recovery-required': 'Deaktif tanım sunucuya ait bir çalışma manifestine dönüştürülmeli.',
  'provider-resource-group-transaction-required': 'Uygulama ve aynı kurulum grubundaki veritabanı/runner tek doğrulanmış işlemde geçirilmelidir.',
  'host-service-manifest-missing': 'Host servisi için sunucuya ait manifest ve geri alma sürümü eksik.',
  'host-network-service-adoption-not-implemented': 'Host ağ servisi için anahtar koruması ve birebir geri alma işlemi hazırlanıyor.',
  'host-service-adoption-not-implemented': 'systemd servisi için yapılandırma yakalama ve geri alma işlemi hazırlanıyor.',
  'stateful-presync-required': 'Veri, kısa duraklamalı doğrudan kopyalama için fazla büyük. Kaynak çalışırken ön eşitleme yapılmadan geçiş başlatılamaz.',
  'stateful-storage-capacity-insufficient': 'Şifreli anlık görüntü ve yeni çalışma kopyası için sunucuda yeterli boş alan yok.',
  'stateful-storage-layout-unsupported': 'Veri birimleri bu otomatik geçiş yönteminin güvenle doğrulayamadığı depolama düzeninde.',
  'stateful-capacity-inspection-failed': 'Veri boyutu ve kullanılabilir depolama güvenle doğrulanamadığı için geçiş başlatılmadı.',
  'legacy-bridge-conflict': 'Mevcut sunucu yönlendirme köprüsü doğrulanamadığı için kaynak değiştirilmeden işlem durduruldu.'
};

function runBlocker(run) {
  return run?.error || run?.blockers?.[0] ||
    run?.resources?.flatMap((resource) => resource.blockers || [])[0] || null;
}

function runBlockerText(run) {
  const blocker = runBlocker(run);
  return blocker && (BLOCKER_LABELS[blocker.code] || blocker.message || blocker.code);
}

function reviewState(resource) {
  if (resource.protected) return 'protected';
  if (resource.readiness?.planningStatus === 'included-with-parent') return 'grouped';
  if (resource.readiness?.planningStatus === 'provider-retirement-pending') return 'retirement';
  if (!resource.migrationRequired) return 'managed';
  if (!['blue-green-atomic-route', 'shadow-refresh-bounded-quiesce'].includes(resource.strategy)) return 'unsupported';
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

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      dateStyle: 'short',
      timeStyle: 'medium'
    }).format(new Date(value));
  } catch {
    return value;
  }
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

const MigrationSettings = () => {
  const rootRef = useRef(null);
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
              text: `${payload.run.summary.completed} kaynak doğrulanmış olarak sunucu yönetimine geçirildi.`
            });
          } else if (payload.run.status === 'blocked') {
            setMessage({
              type: 'error',
              text: `Geçiş güvenlik kapısında durdu. ${payload.run.summary.blocked} kaynakta tamamlanması gereken önkoşul var; hiçbir kaynak çalıştırılmadı.`
            });
          } else {
            const detail = runBlockerText(payload.run);
            setMessage({
              type: 'error',
              text: detail
                ? `Geçiş sırası durduruldu. ${detail}`
                : 'Geçiş sırası durduruldu. Ayrıntılı işlem kaydı sunucuda korundu.'
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
  }, [latestRunId, latestRunStatus, load]);

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
    if (!resource || reviewState(resource) !== 'ready') {
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
  }, { ready: 0, blocked: 0, unsupported: 0, managed: 0, protected: 0 }), [resources]);

  const scanServer = async () => {
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
        text: `${planPayload.plan.summary.resources} kaynak salt okunur olarak tarandı. Hiçbir çalışma durumu değiştirilmedi.`
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setScanning(false);
    }
  };

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
        text: `${selectedIds.length} kaynak için geçiş işlemi başlatıldı. Değişmez ön kontroller tamamlanmadan hiçbir trafik değiştirilmeyecek.`
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
          ? 'İnceleme yapılandırması tamamlandı. Geçiş başlatılmadı; çalıştırma kapısı kapalı.'
          : `${payload.review.reviewBlockers.length} inceleme gereksinimi eksik. Geçiş başlatılmadı.`
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
        <Loader2 size={15} className="spin" /> Sunucu envanteri okunuyor…
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
          <ArrowLeft size={16} /> Tarama Sonuçlarına Dön
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
            {REVIEW_STATES[state]}
          </div>
        </div>

        <DetailSection title="Kaynak Bilgileri">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', wordBreak: 'break-word' }}>
            <DetailLine label="Sağlık">{observed.runtime?.health?.status || observed.runtime?.state}</DetailLine>
            <DetailLine label="Mevcut yönetim">{detailResource.currentProvider || detailResource.observedProvider || 'docker'}</DetailLine>
            {detailResource.management?.sourcePreserved && (
              <DetailLine label="Korunan eski kaynak">{detailResource.observedProvider || 'docker'} · soğuk geri alma için korunuyor</DetailLine>
            )}
            <DetailLine label="Yönetim">{CLASS_LABELS[detailResource.currentAuthorityClass || classification.authorityClass] || detailResource.currentAuthorityClass || classification.authorityClass}</DetailLine>
            <DetailLine label="Kaynak sınıfı">{CLASS_LABELS[classification.workloadRole] || classification.workloadRole} · {CLASS_LABELS[classification.stateClass] || classification.stateClass}</DetailLine>
            <DetailLine label="İnceleme stratejisi">{STRATEGY_LABELS[detailResource.strategy] || detailResource.strategy}</DetailLine>
            <DetailLine label="Hazırlık durumu">
              {state === 'managed'
                ? detailResource.management?.state === 'active' ? 'Geçiş tamamlandı' : 'Sunucu yönetiminde · inceleme gerekli'
                : detailResource.readiness?.evidenceComplete ? 'Önkoşullar tamam' : 'Eksikler ayrıntılarda çözülecek'}
            </DetailLine>
            <DetailLine label="Erişilebilirlik">{AVAILABILITY_LABELS[detailResource.availability?.currentMode] || detailResource.availability?.currentMode}</DetailLine>
            <DetailLine label="İmaj" mono>{observed.runtime?.image}</DetailLine>
            <DetailLine label="Container" mono>{shortId(observed.runtime?.containerId)}</DetailLine>
            <DetailLine label="Ortam değişkeni">{detailResource.evidence?.environmentVariableCount ?? '—'}</DetailLine>
            <DetailLine label="Manifest sürümü" mono>{shortId(detailResource.evidence?.manifestRevisionId)}</DetailLine>
          </div>
        </DetailSection>

        <DetailSection title="Alan Adları ve Rotalar" description="Kaynak üzerinde gözlenen yayın adresleri.">
          {routes.length ? routes.map((route, index) => (
            <div key={`${route.domain}-${route.path}-${index}`} style={{ fontSize: '13px', marginTop: index ? '8px' : 0, overflowWrap: 'anywhere' }}>
              {route.tls ? 'https' : 'http'}://{route.domain}{route.path || '/'}
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>Yayınlanmış rota bulunamadı.</div>}
        </DetailSection>

        <DetailSection title="Depolama" description="Container ile bağlı kalıcı veya geçici depolama yolları.">
          {mounts.length ? mounts.map((mount, index) => (
            <div key={`${mount.destination}-${index}`} style={{ fontSize: '13px', marginTop: index ? '10px' : 0, overflowWrap: 'anywhere' }}>
              <div>{mount.name || mount.source || mount.type} → {mount.destination}</div>
              <div style={{ color: '#888', fontSize: '12px', marginTop: '2px' }}>{mount.readOnly ? 'Salt okunur' : 'Yazılabilir'} · {mount.type}</div>
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>Kalıcı depolama bağı gözlenmedi.</div>}
        </DetailSection>

        <DetailSection title="İlişkiler ve Doğrulanmış Bağımlılıklar">
          {dependencies.length ? dependencies.map((dependency, index) => (
            <div key={dependency.relationshipId || index} style={{ fontSize: '13px', marginTop: index ? '10px' : 0 }}>
              <div>{dependency.type || 'İlişki'} · {dependency.required ? 'gerekli bağımlılık' : 'gözlenen ilişki'}</div>
              <div style={{ color: '#888', fontSize: '12px', marginTop: '2px', overflowWrap: 'anywhere' }}>
                {(dependency.resourceIds || []).join(', ')}
              </div>
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>Doğrulanmış bir kaynak bağımlılığı bulunamadı.</div>}
        </DetailSection>

        {isReady && (
          <>
            <DetailSection title="Geçiş İncelemesi" description="Bu ayarlar yalnızca mevcut plan ve manifest için sunucuda saklanır. Kaydetmek çalışma durumunu, rotaları veya sağlayıcıyı değiştirmez.">
              {reviewLoading ? (
                <div style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Loader2 size={15} className="spin" /> İnceleme sözleşmesi hazırlanıyor…
                </div>
              ) : reviewMessage?.type === 'error' && !reviewPlan ? (
                <div style={{ color: '#ff8a84', fontSize: '13px' }}>{reviewMessage.text}</div>
              ) : reviewStatus?.stale ? (
                <div style={{ color: '#ccc', fontSize: '13px' }}>Sunucu envanteri değişti. Bu incelemeyi kaydetmeden önce yeniden tarama yapmalısın.</div>
              ) : contractBlockers.length ? (
                <div>
                  {contractBlockers.map((blocker, index) => (
                    <div key={`${blocker.code}-${index}`} style={{ fontSize: '13px', marginTop: index ? '10px' : 0 }}>
                      {BLOCKER_LABELS[blocker.code] || blocker.message || blocker.code}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px' }}>
                  <DetailLine label="Plan" mono>{shortId(reviewPlan?.planId)}</DetailLine>
                  <DetailLine label="Sözleşme" mono>{shortId(executionContract?.contractId)}</DetailLine>
                  <DetailLine label="Kayıt durumu">{reviewStatus?.state === 'complete' ? 'İnceleme tamamlandı' : 'İnceleme eksik'}</DetailLine>
                  <DetailLine label="Çalıştırma">Kapalı</DetailLine>
                </div>
              )}
            </DetailSection>

            {executionContract && !contractBlockers.length && reviewDraft && !reviewStatus?.stale && (
              <>
                <DetailSection title="Sağlık Hedefi" description="FoxOS aday uygulamayı bu gözlenen iç port ve yol üzerinden doğrulayacak.">
                  <select
                    value={reviewDraft.healthRouteId || ''}
                    onChange={(event) => {
                      setReviewDraft((current) => ({ ...current, healthRouteId: event.target.value || null }));
                      setReviewMessage(null);
                    }}
                    style={SELECT_STYLE}
                  >
                    <option value="">Sağlık hedefi seç</option>
                    {(executionContract.routes || []).map((route) => (
                      <option key={route.routeId} value={route.routeId}>
                        {route.domain}{route.path} → :{route.upstreamPrivatePort}
                      </option>
                    ))}
                  </select>
                  <div style={{ color: '#888', fontSize: '12px', marginTop: '9px' }}>Kabul edilen HTTP durumları: 200–399</div>
                </DetailSection>

                <DetailSection title="Çalışma Sınırları" description="Manifest derleyicisinin sabitlediği aday container ayarları.">
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', marginBottom: '16px' }}>
                    <DetailLine label={`Bellek${runtimeDefaults.has('memoryBytes') ? ' · varsayılan' : ''}`}>{formatMemory(executionContract.candidate.runtime.memoryBytes)}</DetailLine>
                    <DetailLine label={`CPU${runtimeDefaults.has('nanoCpus') ? ' · varsayılan' : ''}`}>{formatCpu(executionContract.candidate.runtime.nanoCpus)}</DetailLine>
                    <DetailLine label={`PID sınırı${runtimeDefaults.has('pidsLimit') ? ' · varsayılan' : ''}`}>{executionContract.candidate.runtime.pidsLimit}</DetailLine>
                    <DetailLine label="Yeniden başlatma">{executionContract.candidate.runtime.restartPolicy}</DetailLine>
                    <DetailLine label="Çalışma kullanıcısı">{executionContract.candidate.runtime.user || 'İmaj varsayılanı'}</DetailLine>
                    <DetailLine label="Kök dosya sistemi">{executionContract.candidate.runtime.readOnlyRootFilesystem ? 'Salt okunur' : 'Yazılabilir'}</DetailLine>
                    <DetailLine label="Host portu">Yayınlanmayacak</DetailLine>
                    <DetailLine label="Yazılabilir mount">Yok</DetailLine>
                    <DetailLine label="Yetkili çalışma">Kapalı</DetailLine>
                    <DetailLine label="Ek yetkiler">Kapalı · tüm capabilities düşürülecek</DetailLine>
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
                    Bu çalışma sınırlarını inceledim
                  </label>
                </DetailSection>

                <DetailSection title="Rotalar ve Sertifikalar" description="Her rota kendi alan adı, yolu, iç portu ve değiştirilebilir sertifika adaptörüyle ayrı ayrı incelenir.">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
                    {(executionContract.routes || []).map((route) => {
                      const reviewed = reviewedRoutes.get(route.routeId) || {};
                      return (
                        <div key={route.routeId} style={RESOURCE_CARD_STYLE}>
                          <div style={{ fontSize: '13px', overflowWrap: 'anywhere' }}>https://{route.domain}{route.path}</div>
                          <div style={{ color: '#888', fontSize: '12px', marginTop: '3px' }}>İç port: {route.upstreamPrivatePort} · HTTP → HTTPS</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginTop: '14px' }}>
                            <select
                              aria-label={`${route.domain}${route.path} sertifika adaptörü`}
                              value={reviewed.certificateAdapter || ''}
                              onChange={(event) => updateReviewRoute(route.routeId, { certificateAdapter: event.target.value || null })}
                              style={SELECT_STYLE}
                            >
                              <option value="">Sertifika adaptörü seç</option>
                              {(reviewStatus?.certificateAdapters || []).map((adapter) => (
                                <option key={adapter} value={adapter}>{CERTIFICATE_ADAPTER_LABELS[adapter] || adapter}</option>
                              ))}
                            </select>
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '13px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={reviewed.confirmed === true}
                                onChange={(event) => updateReviewRoute(route.routeId, { confirmed: event.target.checked })}
                              />
                              Rotayı inceledim
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ color: '#888', fontSize: '12px', marginTop: '10px', lineHeight: 1.45 }}>
                    ACME seçimleri belirli bir DNS firması veya ücretli hizmet zorunluluğu oluşturmaz. Erişim bilgileri bu ekranda saklanmaz.
                  </div>
                </DetailSection>

                <DetailSection title="İnceleme Kaydı">
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
                    Kaydet ve Yeniden Değerlendir
                  </button>
                </DetailSection>
              </>
            )}
          </>
        )}

        <DetailSection title="Engeller ve Sonraki Gereksinimler" last>
          {blockers.length ? blockers.map((blocker, index) => (
            <div key={`${blocker.group}-${blocker.code}-${index}`} style={{ padding: index ? '12px 0 0' : 0, marginTop: index ? '12px' : 0, borderTop: index ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
              <div style={{ fontSize: '13px', lineHeight: 1.45 }}>{BLOCKER_LABELS[blocker.code] || blocker.message || blocker.code}</div>
              <div style={{ color: '#888', fontSize: '11px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }}>{blocker.code}</div>
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>İnceleme planını engelleyen eksik kanıt bulunmadı.</div>}
        </DetailSection>
      </div>
    );
  }

  const countSummary = Object.entries(REVIEW_STATES)
    .filter(([state]) => counts[state] > 0)
    .map(([state, label]) => `${counts[state]} ${label.toLocaleLowerCase('tr-TR')}`)
    .join(' · ');
  const latestRunAlreadyManaged = Boolean(
    latestRun && ['failed', 'blocked'].includes(latestRun.status) && latestRun.resources?.length &&
    latestRun.resources.every((runResource) => {
      const current = resources.find((resource) => resource.resourceId === runResource.resourceId);
      return current?.management?.owner === 'foxos' && current.management.state === 'active';
    })
  );
  const latestRunBlockerText = runBlockerText(latestRun);

  return (
    <div ref={rootRef}>
      <section style={{ padding: '0 0 26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Sunucu Taraması</h2>
        <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
          Docker kaynaklarını salt okunur inceler. Tarama hiçbir uygulamayı durdurmaz ve geçiş başlatmaz.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
          <button
            type="button"
            onClick={scanServer}
            disabled={scanning}
            style={{ ...SECONDARY_BUTTON_STYLE, cursor: scanning ? 'wait' : 'pointer', opacity: scanning ? 0.6 : 1 }}
          >
            {scanning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            {scanning ? 'Taranıyor…' : 'Sunucuyu Tara'}
          </button>
          {snapshot && (
            <div style={{ color: '#888', fontSize: '12px' }}>
              Son tarama: {formatDate(snapshot.generatedAt)} · {snapshot.summary?.resources ?? resources.length} kaynak
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
          Sunucu envanteri değiştiği için önceki seçim geçersiz. Yeni sonuçlara göre tekrar seçim yapmalısın.
        </div>
      )}

      {!plan ? (
        <section style={{ padding: '26px 0 0 0' }}>
          <div style={{ ...RESOURCE_CARD_STYLE, color: '#8b93a1', textAlign: 'center', fontSize: '13px' }}>
            Güncel bir tarama sonucu yok. Kaynakları sınıflandırmak için “Sunucuyu Tara” düğmesini kullan.
          </div>
        </section>
      ) : (
        <>
          <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Kaynaklar</h2>
            <div style={{ marginBottom: '14px', color: '#888', fontSize: '12px' }}>{countSummary}</div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', marginBottom: '12px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', color: selectableIds.length ? '#fff' : '#888', fontSize: '13px', cursor: selectableIds.length ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  checked={selectableIds.length > 0 && selectableIds.every((resourceId) => selectedSet.has(resourceId))}
                  onChange={toggleAll}
                  disabled={!selectableIds.length}
                />
                Tüm uygun kaynakları seç
              </label>
              <span style={{ color: '#8b93a1', fontSize: '12px' }}>{selectedIds.length} seçili</span>
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
                      aria-label={`${resource.name} kaynağını seç`}
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
                        {resource.currentProvider || resource.observedProvider || 'docker'} · {CLASS_LABELS[classification.workloadRole] || classification.workloadRole || 'Belirsiz'} · {observed.runtime?.health?.status || observed.runtime?.state || 'bilinmiyor'}
                        {routeDomains.length ? ` · ${routeDomains.join(', ')}` : ` · ${(observed.mounts || []).length} depolama bağı`}
                      </div>
                    </div>
                    <div style={{ color: '#8b93a1', fontSize: '12px', whiteSpace: 'nowrap' }}>{REVIEW_STATES[state]}</div>
                    <button
                      type="button"
                      onClick={() => setDetailResourceId(resource.resourceId)}
                      style={ACTION_BUTTON_STYLE}
                    >
                      Ayrıntılar <ChevronRight size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section style={{ padding: '26px 0 0 0' }}>
            <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Geçiş</h2>
            <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
              Seçilen kaynakların değişmez ön kontrolleri birlikte tamamlanır; ardından uygun kaynaklar sağlık ve geri alma doğrulamasıyla sırayla geçirilir.
            </div>
            {latestRun && (
              <div style={{ marginBottom: '14px', color: '#888', fontSize: '12px' }}>
                <div>
                  {latestRunAlreadyManaged
                    ? `Son durum: Sunucu yönetiminde · ${latestRun.resources.length}/${latestRun.resources.length} tamamlandı`
                    : `Son işlem: ${RUN_STATUS_LABELS[latestRun.status] || latestRun.status} · ${latestRun.summary?.completed || 0}/${latestRun.summary?.selected || 0} tamamlandı`}
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
              {starting || ACTIVE_RUN_STATUSES.has(latestRun?.status) ? 'Geçiş Başlatılıyor…' : 'Geçişi Başlat'}
            </button>
          </section>
        </>
      )}
    </div>
  );
};

export default MigrationSettings;
