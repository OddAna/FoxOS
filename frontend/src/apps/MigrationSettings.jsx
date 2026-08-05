import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck
} from 'lucide-react';
import { apiFetch } from '../api';

const CARD_STYLE = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px'
};

const BUTTON_STYLE = {
  border: '1px solid rgba(255,255,255,0.16)',
  borderRadius: '8px',
  padding: '9px 14px',
  color: '#fff',
  fontSize: '13px',
  fontWeight: 'bold',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px'
};

const REVIEW_STATES = {
  ready: { label: 'İnceleme planına uygun', color: '#4ade80' },
  blocked: { label: 'Eksik bilgi', color: '#f59e0b' },
  unsupported: { label: 'Bu sürümde desteklenmiyor', color: '#aaa' },
  managed: { label: 'Zaten FoxOS yönetiminde', color: '#38bdf8' },
  protected: { label: 'Korunan sistem kaynağı', color: '#c4b5fd' }
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
      <div ref={rootRef} style={{ ...CARD_STYLE, padding: '24px', color: '#aaa', display: 'flex', alignItems: 'center', gap: '9px' }}>
        <Loader2 size={17} className="spin" /> Sunucu envanteri okunuyor…
      </div>
    );
  }

  const detailResource = resources.find((resource) => resource.resourceId === detailResourceId);
  if (detailResource) {
    const observed = snapshotResources.get(detailResource.resourceId) || {};
    const classification = detailResource.classification || {};
    const state = reviewState(detailResource);
    const stateInfo = REVIEW_STATES[state];
    const blockers = allBlockers(detailResource);
    const routes = observed.routes || [];
    const mounts = observed.mounts || [];
    const dependencies = detailResource.dependencies || [];

    return (
      <div ref={rootRef}>
        <button
          type="button"
          onClick={() => setDetailResourceId(null)}
          style={{ background: 'transparent', color: '#aaa', border: 'none', padding: '0', marginBottom: '20px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}
        >
          <ArrowLeft size={16} /> Tarama sonuçlarına dön
        </button>

        <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '19px', fontWeight: 'bold', overflowWrap: 'anywhere' }}>{detailResource.name}</div>
              <div title={detailResource.resourceId} style={{ marginTop: '5px', color: '#888', fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {detailResource.resourceId}
              </div>
            </div>
            <div style={{ color: stateInfo.color, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '7px' }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: stateInfo.color }} />
              {stateInfo.label}
            </div>
          </div>
        </div>

        <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', margin: '0 0 16px', color: '#ccc' }}>Kaynak bilgileri</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', gap: '11px 18px', fontSize: '13px', lineHeight: 1.5 }}>
            <DetailLine label="Sağlık">{observed.runtime?.health?.status || observed.runtime?.state}</DetailLine>
            <DetailLine label="Mevcut kaynak">{detailResource.observedProvider || 'docker'}</DetailLine>
            <DetailLine label="Yönetim otoritesi">{CLASS_LABELS[classification.authorityClass] || classification.authorityClass}</DetailLine>
            <DetailLine label="Kaynak sınıfı">{CLASS_LABELS[classification.workloadRole] || classification.workloadRole} · {CLASS_LABELS[classification.stateClass] || classification.stateClass}</DetailLine>
            <DetailLine label="İnceleme stratejisi">{STRATEGY_LABELS[detailResource.strategy] || detailResource.strategy}</DetailLine>
            <DetailLine label="Erişilebilirlik">{AVAILABILITY_LABELS[detailResource.availability?.currentMode] || detailResource.availability?.currentMode}</DetailLine>
            <DetailLine label="İmaj" mono>{observed.runtime?.image}</DetailLine>
            <DetailLine label="Container" mono>{shortId(observed.runtime?.containerId)}</DetailLine>
            <DetailLine label="Ortam değişkeni">{detailResource.evidence?.environmentVariableCount ?? '—'}</DetailLine>
            <DetailLine label="Manifest sürümü" mono>{shortId(detailResource.evidence?.manifestRevisionId)}</DetailLine>
          </div>
        </div>

        <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', margin: '0 0 14px', color: '#ccc' }}>Alan adları ve rotalar</h3>
          {routes.length ? routes.map((route, index) => (
            <div key={`${route.domain}-${route.path}-${index}`} style={{ fontSize: '13px', marginTop: index ? '8px' : 0, overflowWrap: 'anywhere' }}>
              {route.tls ? 'https' : 'http'}://{route.domain}{route.path || '/'}
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>Yayınlanmış rota bulunamadı.</div>}
        </div>

        <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', margin: '0 0 14px', color: '#ccc' }}>Depolama</h3>
          {mounts.length ? mounts.map((mount, index) => (
            <div key={`${mount.destination}-${index}`} style={{ fontSize: '13px', marginTop: index ? '10px' : 0, overflowWrap: 'anywhere' }}>
              <div>{mount.name || mount.source || mount.type} → {mount.destination}</div>
              <div style={{ color: '#888', fontSize: '12px', marginTop: '2px' }}>{mount.readOnly ? 'Salt okunur' : 'Yazılabilir'} · {mount.type}</div>
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>Kalıcı depolama bağı gözlenmedi.</div>}
        </div>

        <div style={{ ...CARD_STYLE, padding: '20px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', margin: '0 0 14px', color: '#ccc' }}>İlişkiler ve doğrulanmış bağımlılıklar</h3>
          {dependencies.length ? dependencies.map((dependency, index) => (
            <div key={dependency.relationshipId || index} style={{ fontSize: '13px', marginTop: index ? '10px' : 0 }}>
              <div>{dependency.type || 'İlişki'} · {dependency.required ? 'gerekli bağımlılık' : 'gözlenen ilişki'}</div>
              <div style={{ color: '#888', fontSize: '12px', marginTop: '2px', overflowWrap: 'anywhere' }}>
                {(dependency.resourceIds || []).join(', ')}
              </div>
            </div>
          )) : <div style={{ color: '#888', fontSize: '13px' }}>Doğrulanmış bir kaynak bağımlılığı bulunamadı.</div>}
        </div>

        <div style={{ ...CARD_STYLE, padding: '20px' }}>
          <h3 style={{ fontSize: '14px', margin: '0 0 14px', color: '#ccc' }}>Engeller ve sonraki gereksinimler</h3>
          {blockers.length ? blockers.map((blocker, index) => (
            <div key={`${blocker.group}-${blocker.code}-${index}`} style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', marginTop: index ? '12px' : 0 }}>
              <AlertTriangle size={15} color="#f59e0b" style={{ flex: '0 0 auto', marginTop: '2px' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '13px', lineHeight: 1.45 }}>{BLOCKER_LABELS[blocker.code] || blocker.message || blocker.code}</div>
                <div style={{ color: '#777', fontSize: '11px', marginTop: '3px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }}>{blocker.code}</div>
              </div>
            </div>
          )) : (
            <div style={{ color: '#4ade80', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <CheckCircle2 size={15} /> İnceleme planını engelleyen eksik kanıt bulunmadı.
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <div style={{ ...CARD_STYLE, padding: '18px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '18px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', fontSize: '14px', fontWeight: 'bold' }}>
              <Server size={18} /> Sunucuyu Tara
            </div>
            <p style={{ margin: '8px 0 0', color: '#999', fontSize: '13px', lineHeight: 1.5 }}>
              Docker kaynaklarını salt okunur inceler. Tarama, seçim ve inceleme planı hiçbir uygulamayı durdurmaz veya geçiş başlatmaz.
            </p>
          </div>
          <button
            type="button"
            onClick={scanServer}
            disabled={scanning}
            style={{ ...BUTTON_STYLE, background: 'rgba(255,255,255,0.1)', cursor: scanning ? 'wait' : 'pointer', opacity: scanning ? 0.65 : 1 }}
          >
            {scanning ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {scanning ? 'Taranıyor…' : 'Sunucuyu Tara'}
          </button>
        </div>
        {snapshot && (
          <div style={{ marginTop: '13px', color: '#777', fontSize: '11px' }}>
            Son tarama: {formatDate(snapshot.generatedAt)} · {snapshot.summary?.resources ?? resources.length} kaynak · {shortId(snapshot.snapshotId)}
          </div>
        )}
      </div>

      {message && (
        <div style={{ marginBottom: '16px', padding: '11px 13px', borderRadius: '9px', fontSize: '13px', lineHeight: 1.45, background: message.type === 'error' ? 'rgba(255,95,86,0.12)' : 'rgba(74,222,128,0.1)', border: `1px solid ${message.type === 'error' ? 'rgba(255,95,86,0.35)' : 'rgba(74,222,128,0.25)'}`, color: message.type === 'error' ? '#ffaaa5' : '#a7f3d0' }}>
          {message.text}
        </div>
      )}

      {selectionStatus?.stale && (
        <div style={{ marginBottom: '16px', padding: '11px 13px', borderRadius: '9px', fontSize: '13px', lineHeight: 1.45, background: 'rgba(245,158,11,0.11)', border: '1px solid rgba(245,158,11,0.3)', color: '#fcd34d', display: 'flex', gap: '9px', alignItems: 'flex-start' }}>
          <AlertTriangle size={16} style={{ flex: '0 0 auto', marginTop: '1px' }} />
          Sunucu envanteri değiştiği için önceki seçim geçersiz. Yeni sonuçlara göre tekrar seçim yapmalısın.
        </div>
      )}

      {!plan ? (
        <div style={{ ...CARD_STYLE, padding: '30px', textAlign: 'center' }}>
          <ShieldCheck size={24} color="#888" />
          <div style={{ marginTop: '11px', fontSize: '14px' }}>Güncel bir tarama sonucu yok.</div>
          <div style={{ marginTop: '6px', color: '#888', fontSize: '13px' }}>Sunucudaki kaynakları sınıflandırmak için “Sunucuyu Tara” düğmesini kullan.</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginBottom: '16px' }}>
            {Object.entries(REVIEW_STATES).map(([state, info]) => (
              <div key={state} style={{ ...CARD_STYLE, padding: '12px 13px' }}>
                <div style={{ fontSize: '18px', fontWeight: 'bold' }}>{counts[state]}</div>
                <div style={{ color: info.color, fontSize: '11px', lineHeight: 1.35, marginTop: '3px' }}>{info.label}</div>
              </div>
            ))}
          </div>

          <div style={{ ...CARD_STYLE, overflow: 'hidden' }}>
            <div style={{ minHeight: '43px', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '13px', cursor: selectableIds.length ? 'pointer' : 'default', color: selectableIds.length ? '#fff' : '#777' }}>
                <input
                  type="checkbox"
                  checked={selectableIds.length > 0 && selectableIds.every((resourceId) => selectedSet.has(resourceId))}
                  onChange={toggleAll}
                  disabled={!selectableIds.length}
                  style={{ accentColor: '#0ea5e9' }}
                />
                Tüm uygun kaynakları seç ({selectableIds.length})
              </label>
              <span style={{ color: '#888', fontSize: '12px' }}>{selectedIds.length} seçili</span>
            </div>

            {resources.map((resource, index) => {
              const state = reviewState(resource);
              const info = REVIEW_STATES[state];
              const selectable = state === 'ready';
              const observed = snapshotResources.get(resource.resourceId) || {};
              const routeDomains = (observed.routes || []).map((route) => route.domain).filter(Boolean);
              const classification = resource.classification || {};
              return (
                <div
                  key={resource.resourceId}
                  style={{ padding: '14px', borderTop: index ? '1px solid rgba(255,255,255,0.07)' : 'none', display: 'grid', gridTemplateColumns: '22px minmax(180px, 1.4fr) minmax(150px, 1fr) minmax(160px, 1.1fr) 24px', gap: '12px', alignItems: 'center' }}
                >
                  <input
                    type="checkbox"
                    aria-label={`${resource.name} kaynağını seç`}
                    checked={selectedSet.has(resource.resourceId)}
                    onChange={() => toggleResource(resource.resourceId)}
                    disabled={!selectable}
                    style={{ accentColor: '#0ea5e9' }}
                  />
                  <button
                    type="button"
                    onClick={() => setDetailResourceId(resource.resourceId)}
                    style={{ minWidth: 0, border: 'none', padding: 0, background: 'transparent', color: '#fff', textAlign: 'left', cursor: 'pointer' }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{resource.name}</div>
                    <div title={resource.resourceId} style={{ color: '#777', fontSize: '11px', marginTop: '4px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {resource.resourceId}
                    </div>
                  </button>
                  <div style={{ minWidth: 0, fontSize: '12px' }}>
                    <div>{CLASS_LABELS[classification.workloadRole] || classification.workloadRole || 'Belirsiz'} · {CLASS_LABELS[classification.stateClass] || classification.stateClass || 'Belirsiz'}</div>
                    <div style={{ color: '#777', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{resource.observedProvider || 'docker'} · {observed.runtime?.health?.status || observed.runtime?.state || 'bilinmiyor'}</div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: info.color, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <span style={{ width: '6px', height: '6px', flex: '0 0 6px', borderRadius: '50%', background: info.color }} />
                      {info.label}
                    </div>
                    <div title={routeDomains.join(', ')} style={{ color: '#777', fontSize: '11px', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {routeDomains.length ? routeDomains.join(', ') : `${(observed.mounts || []).length} depolama bağı`}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`${resource.name} ayrıntılarını aç`}
                    onClick={() => setDetailResourceId(resource.resourceId)}
                    style={{ border: 'none', padding: '4px', background: 'transparent', color: '#888', cursor: 'pointer', display: 'flex' }}
                  >
                    <ChevronRight size={17} />
                  </button>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <div style={{ color: '#888', fontSize: '12px', lineHeight: 1.45, flex: '1 1 300px' }}>
              Seçim sunucuda bu tarama sonucuna bağlı saklanır. Bu işlem yalnızca sonraki inceleme adımını hazırlar.
            </div>
            <button
              type="button"
              onClick={saveSelection}
              disabled={saving || !selectionChanged}
              style={{ ...BUTTON_STYLE, background: '#0ea5e9', borderColor: '#0ea5e9', cursor: saving || !selectionChanged ? 'not-allowed' : 'pointer', opacity: saving || !selectionChanged ? 0.5 : 1 }}
            >
              {saving ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />}
              {selectedIds.length ? 'Seçilenleri inceleme planına ekle' : 'Kaydedilmiş seçimi temizle'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default MigrationSettings;
