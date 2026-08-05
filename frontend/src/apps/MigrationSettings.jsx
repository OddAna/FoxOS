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

const REVIEW_STATES = {
  ready: 'İncelemeye uygun',
  blocked: 'Eksik bilgi',
  unsupported: 'Bu sürümde desteklenmiyor',
  managed: 'FoxOS yönetiminde',
  protected: 'Korunan sistem kaynağı'
};

const STRATEGY_LABELS = {
  'blue-green-atomic-route': 'Kesintisiz blue/green geçiş',
  'shadow-refresh-bounded-quiesce': 'Durumlu gölge kopya ve kontrollü geçiş',
  'database-aware-replication-handoff': 'Veritabanına özel aktarım',
  'drain-and-replace': 'İşi boşalt ve değiştir',
  'provider-proxy-retirement-last': 'Sağlayıcı proxy’sini en son kaldır',
  'already-foxos-managed': 'FoxOS yönetiminde',
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
  stateless: 'Durumsuz',
  stateful: 'Durumlu',
  unknown: 'Belirsiz',
  'provider-owned': 'Harici sağlayıcı yönetiminde',
  'foxos-owned': 'FoxOS yönetiminde'
};

const AVAILABILITY_LABELS = {
  'zero-downtime-required': 'Kesintisiz geçiş gerekli',
  'bounded-quiesce-budget-required': 'Onaylı kısa duraklama bütçesi gerekli',
  'database-aware-handoff-required': 'Veritabanı tutarlılığı korunmalı',
  'already-managed': 'Mevcut çalışma korunacak',
  'not-applicable': 'Uygulanmaz',
  'unknown-blocked': 'Belirsiz — engelli'
};

const BLOCKER_LABELS = {
  'external-provider-authority': 'Yönetim otoritesi hâlâ harici sağlayıcıda.',
  'source-runtime-binding-missing': 'Çalışan imajı yeniden üretecek doğrulanmış kaynak bağı eksik.',
  'immutable-source-evidence-missing': 'Değişmez kaynak sürümü kanıtı eksik.',
  'environment-evidence-missing': 'Ortam değişkenleri için güvenli kanıt eksik.',
  'immutable-image-missing': 'Bu imajı değişmez biçimde yeniden kuracak repository digest kanıtı eksik.',
  'foxos-health-proof-missing': 'FoxOS tarafından üretilmiş güncel sağlık kanıtı eksik.',
  'foxos-route-missing': 'Gözlenen sağlayıcı rotasının FoxOS yönetiminde etkin bir karşılığı yok.',
  'runtime-resource-limits-missing': 'CPU, bellek ve işlem sınırları açıkça belirlenmemiş.',
  'update-rollback-proof-missing': 'Başarılı FoxOS güncelleme ve birebir geri alma kanıtı eksik.',
  'recovery-target-unavailable': 'Sunucu dışı kurtarma hedefi hazır değil.',
  'migration-apply-transaction-not-implemented': 'Gerçek geçiş işlemi bu sürümde henüz açılmadı.',
  'general-domain-route-cutover-not-implemented': 'Genel alan adı ve TLS yönlendirme geçişi henüz açılmadı.',
  'zero-downtime-blue-green-apply-not-implemented': 'Kesintisiz blue/green çalıştırma henüz açılmadı.',
  'stateful-cutover-pause-budget-unset': 'Durumlu geçiş için izin verilen azami duraklama süresi belirlenmedi.',
  'database-aware-handoff-not-implemented': 'Veritabanına özel çoğaltma ve ana sunucu devri henüz açılmadı.',
  'worker-drain-policy-not-implemented': 'Kuyruk boşaltma ve devam eden iş kurtarma politikası eksik.',
  'provider-proxy-retirement-gate-open': 'Bağımlı tüm rotalar doğrulanmadan sağlayıcı proxy’si kaldırılamaz.',
  'resource-class-migration-policy-missing': 'Bu kaynak sınıfı için incelenmiş geçiş politikası yok.'
};

function reviewState(resource) {
  if (resource.protected) return 'protected';
  if (!resource.migrationRequired) return 'managed';
  if (resource.strategy !== 'blue-green-atomic-route') return 'unsupported';
  if (!resource.readiness?.evidenceComplete) return 'blocked';
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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const applyLoadedState = useCallback((registryPayload, orchestratorPayload, selectionPayload) => {
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
    setDetailResourceId(null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [registryResponse, orchestratorResponse, selectionResponse] = await Promise.all([
        apiFetch('/api/resources'),
        apiFetch('/api/migration-orchestrator'),
        apiFetch('/api/migration-selections/current')
      ]);
      const [registryPayload, orchestratorPayload, selectionPayload] = await Promise.all([
        registryResponse.json(),
        orchestratorResponse.json(),
        selectionResponse.json()
      ]);
      applyLoadedState(registryPayload, orchestratorPayload, selectionPayload);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  }, [applyLoadedState]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const scrollContainer = rootRef.current?.closest('[data-settings-content]');
    scrollContainer?.scrollTo({ top: 0 });
  }, [detailResourceId]);

  const resources = useMemo(() => plan?.resources || [], [plan]);
  const snapshotResources = useMemo(() => new Map(
    (snapshot?.resources || []).map((resource) => [resource.id, resource])
  ), [snapshot]);
  const selectableIds = useMemo(() => resources
    .filter((resource) => reviewState(resource) === 'ready')
    .map((resource) => resource.resourceId), [resources]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const savedIds = selectionStatus?.current && !selectionStatus.stale &&
    selectionStatus.current.serverPlanId === plan?.planId
    ? selectionStatus.current.selectedResourceIds
    : [];
  const selectionChanged = JSON.stringify([...selectedIds].sort()) !== JSON.stringify([...savedIds].sort());
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
      applyLoadedState(
        { snapshot: scanPayload.snapshot },
        { latest: planPayload.plan },
        selectionPayload
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

  const saveSelection = async () => {
    if (!plan) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await apiFetch('/api/migration-selections/current', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverPlanId: plan.planId,
          resourceIds: selectedIds,
          confirmation: 'SAVE MIGRATION SELECTION'
        })
      });
      const payload = await response.json();
      setSelectionStatus(payload.status);
      setSelectedIds(payload.selection.selectedResourceIds);
      setMessage({
        type: 'success',
        text: selectedIds.length
          ? `${selectedIds.length} kaynak inceleme planına eklendi. Geçiş başlatılmadı.`
          : 'Kaydedilmiş inceleme seçimi temizlendi. Geçiş başlatılmadı.'
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
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
            <DetailLine label="Mevcut kaynak">{detailResource.observedProvider || 'docker'}</DetailLine>
            <DetailLine label="Yönetim">{CLASS_LABELS[classification.authorityClass] || classification.authorityClass}</DetailLine>
            <DetailLine label="Kaynak sınıfı">{CLASS_LABELS[classification.workloadRole] || classification.workloadRole} · {CLASS_LABELS[classification.stateClass] || classification.stateClass}</DetailLine>
            <DetailLine label="İnceleme stratejisi">{STRATEGY_LABELS[detailResource.strategy] || detailResource.strategy}</DetailLine>
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
                        {resource.observedProvider || 'docker'} · {CLASS_LABELS[classification.workloadRole] || classification.workloadRole || 'Belirsiz'} · {observed.runtime?.health?.status || observed.runtime?.state || 'bilinmiyor'}
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
            <h2 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>İnceleme Seçimi</h2>
            <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
              Seçim bu tarama sonucuna bağlı olarak sunucuda saklanır. Kaydetmek geçişi başlatmaz.
            </div>
            <button
              type="button"
              onClick={saveSelection}
              disabled={saving || !selectionChanged}
              style={{ ...PRIMARY_BUTTON_STYLE, cursor: saving || !selectionChanged ? 'not-allowed' : 'pointer', opacity: saving || !selectionChanged ? 0.5 : 1 }}
            >
              {saving ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
              {selectedIds.length ? 'Seçilenleri Kaydet' : 'Kaydedilmiş Seçimi Temizle'}
            </button>
          </section>
        </>
      )}
    </div>
  );
};

export default MigrationSettings;
