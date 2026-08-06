import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Loader2,
  Play,
  RotateCw,
  Save,
  Search,
  Settings,
  Square
} from 'lucide-react';
import { apiFetch } from '../api';
import ApplicationLogo from '../components/ApplicationLogo';
import ApplicationStatus from '../components/ApplicationStatus';
import { useApplicationInventory } from '../contexts/ApplicationContext';
import { useDialog } from '../contexts/DialogContext';

const copyText = async (value) => {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Adres kopyalanamadı');
};

const accessUrlForApplication = (application, containerSettings) => {
  if (application.externalUrl) return application.externalUrl;
  const configuredPort = containerSettings && containerSettings.ports && containerSettings.ports[0];
  const hostPort = application.hostPort || (configuredPort && configuredPort.hostPort);
  if (!hostPort) return null;
  const bindAddress = application.bindAddress || (configuredPort && configuredPort.hostIp);
  const hostname = bindAddress === '127.0.0.1' ? '127.0.0.1' : window.location.hostname;
  return `http://${hostname}:${hostPort}`;
};

const ApplicationManager = ({ target }) => {
  const {
    actions,
    applications,
    error,
    loading,
    refreshApplications,
    runApplicationAction
  } = useApplicationInventory();
  const { showDialog } = useDialog();
  const [selectedApplicationId, setSelectedApplicationId] = useState(target && target.applicationId || null);
  const [targetContainerId, setTargetContainerId] = useState(target && target.containerId || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [containerSettings, setContainerSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [restartPolicy, setRestartPolicy] = useState('no');
  const [domainStatus, setDomainStatus] = useState(null);
  const [domainInput, setDomainInput] = useState('');
  const [domainPlan, setDomainPlan] = useState(null);
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainApplying, setDomainApplying] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!target) {
      setSelectedApplicationId(null);
      setTargetContainerId(null);
      setMessage(null);
      return;
    }
    setSelectedApplicationId(target.applicationId || null);
    setTargetContainerId(target.containerId || null);
    setSearchQuery('');
    setMessage(null);
  }, [target]);

  useEffect(() => {
    if (selectedApplicationId || !targetContainerId) return;
    const matched = applications.find((application) => (
      application.runtime && application.runtime.containerId === targetContainerId
    ));
    if (matched) setSelectedApplicationId(matched.id);
  }, [applications, selectedApplicationId, targetContainerId]);

  const selectedApplication = selectedApplicationId
    ? applications.find((application) => application.id === selectedApplicationId) || null
    : null;
  const selectedContainerId = selectedApplication && selectedApplication.runtime.containerId || null;
  const selectedDomainApplicationId = selectedApplication && selectedApplication.id || null;
  const canEditSelectedDomain = Boolean(
    selectedApplication && selectedApplication.capabilities.editDomain
  );

  useEffect(() => {
    if (!selectedContainerId) {
      setContainerSettings(null);
      return undefined;
    }

    let active = true;
    setSettingsLoading(true);
    setContainerSettings(null);
    setMessage(null);
    apiFetch(`/api/containers/${selectedContainerId}/settings`)
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setContainerSettings(payload.settings);
        setRestartPolicy(payload.settings.restartPolicy);
      })
      .catch((settingsError) => {
        if (active) setMessage({ type: 'error', text: settingsError.message });
      })
      .finally(() => {
        if (active) setSettingsLoading(false);
      });

    return () => { active = false; };
  }, [selectedContainerId]);

  useEffect(() => {
    if (!selectedDomainApplicationId || !canEditSelectedDomain) {
      setDomainStatus(null);
      setDomainInput('');
      setDomainPlan(null);
      setDomainLoading(false);
      return undefined;
    }

    let active = true;
    setDomainLoading(true);
    setDomainPlan(null);
    apiFetch(`/api/applications/${selectedDomainApplicationId}/domain`)
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setDomainStatus(payload);
        setDomainInput(payload.currentDomain || '');
      })
      .catch((domainError) => {
        if (active) setMessage({ type: 'error', text: domainError.message });
      })
      .finally(() => {
        if (active) setDomainLoading(false);
      });

    return () => { active = false; };
  }, [selectedDomainApplicationId, canEditSelectedDomain]);

  const displayedApplications = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('tr-TR');
    if (!query) return applications;
    return applications.filter((application) => (
      `${application.name} ${application.instanceName || ''} ${application.externalUrl || ''}`
        .toLocaleLowerCase('tr-TR')
        .includes(query)
    ));
  }, [applications, searchQuery]);

  const openApplication = (application) => {
    if (application.runtime.operationalState !== 'running') {
      showDialog({
        title: 'Servis Kapalı',
        message: 'Bu uygulamayı açmak için önce servisi başlatın.',
        type: 'warning'
      });
      return;
    }

    if (application.externalUrl) {
      window.open(application.externalUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    if (!application.hostPort) {
      showDialog({
        title: 'Erişim Adresi Bulunamadı',
        message: 'Bu uygulama için açılabilir bir alan adı veya yayın portu bulunamadı.',
        type: 'info'
      });
      return;
    }

    const localFoxOS = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
    if (application.bindAddress === '127.0.0.1' && !localFoxOS) {
      showDialog({
        title: 'Özel Erişim',
        message: `Bu uygulama 127.0.0.1:${application.hostPort} üzerinde çalışıyor. Aynı portu SSH tüneliyle açın.`,
        type: 'info'
      });
      return;
    }

    const hostname = application.bindAddress === '127.0.0.1'
      ? '127.0.0.1'
      : window.location.hostname;
    window.open(`http://${hostname}:${application.hostPort}`, '_blank', 'noopener,noreferrer');
  };

  const runAction = async (application, action) => {
    setMessage(null);
    try {
      await runApplicationAction(application, action);
      const labels = { start: 'başlatıldı', stop: 'durduruldu', restart: 'yeniden başlatıldı' };
      setMessage({ type: 'success', text: `${application.name} ${labels[action]}.` });
    } catch (actionError) {
      setMessage({ type: 'error', text: actionError.message });
    }
  };

  const saveContainerSettings = async () => {
    const containerId = selectedApplication && selectedApplication.runtime.containerId;
    if (!containerId || !containerSettings) return;
    setSettingsSaving(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/containers/${containerId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restartPolicy })
      });
      const payload = await response.json();
      setContainerSettings(payload.settings);
      setRestartPolicy(payload.settings.restartPolicy);
      setMessage({ type: 'success', text: 'Ayar kaydedildi.' });
    } catch (settingsError) {
      setMessage({ type: 'error', text: settingsError.message });
    } finally {
      setSettingsSaving(false);
    }
  };

  const checkDomain = async () => {
    if (!selectedApplication || !domainInput.trim()) return;
    setDomainLoading(true);
    setDomainPlan(null);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/applications/${selectedApplication.id}/domain/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainInput })
      });
      const payload = await response.json();
      setDomainPlan(payload.plan);
      setDomainInput(payload.plan.domain);
    } catch (domainError) {
      setMessage({ type: 'error', text: domainError.message });
    } finally {
      setDomainLoading(false);
    }
  };

  const refreshDomainStatus = async (applicationId) => {
    const response = await apiFetch(`/api/applications/${applicationId}/domain`);
    const payload = await response.json();
    setDomainStatus(payload);
    setDomainInput(payload.currentDomain || '');
    return payload;
  };

  const applyDomainPlan = async (plan) => {
    if (!selectedApplication || !plan) return;
    const applicationId = selectedApplication.id;
    setDomainApplying(true);
    setMessage(null);
    try {
      await apiFetch(`/api/application-domain-plans/${plan.planId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: plan.confirmation })
      });
      await refreshApplications();
      await refreshDomainStatus(applicationId);
      setDomainPlan(null);
      setMessage({
        type: 'success',
        text: `Birincil erişim adresi https://${plan.domain} olarak değiştirildi. Önceki adres açık bırakıldı.`
      });
    } catch (domainError) {
      setMessage({ type: 'error', text: domainError.message });
    } finally {
      setDomainApplying(false);
    }
  };

  const confirmDomainChange = () => {
    if (!domainPlan) return;
    showDialog({
      title: 'Erişim Adresini Değiştir',
      message: `https://${domainPlan.domain} sunucu yönlendirmesi, TLS ve uygulama sağlığıyla doğrulanacak. Mevcut adres işlem boyunca açık kalacak; doğrulama başarısız olursa yalnız yeni rota geri alınacak.`,
      type: 'confirm',
      confirmText: 'Değiştir',
      cancelText: 'Vazgeç',
      onConfirm: () => applyDomainPlan(domainPlan)
    });
  };

  const rollbackDomain = () => {
    const operation = domainStatus && domainStatus.latestOperation;
    if (!selectedApplication || !operation || !domainStatus.rollbackConfirmation) return;
    const applicationId = selectedApplication.id;
    showDialog({
      title: 'Önceki Adrese Dön',
      message: `Birincil erişim adresi yeniden https://${operation.previousDomain} olacak. Sonradan eklenen ${operation.primaryDomain} rotası güvenle kaldırılacak.`,
      type: 'confirm',
      confirmText: 'Geri Dön',
      cancelText: 'Vazgeç',
      onConfirm: async () => {
        setDomainApplying(true);
        setMessage(null);
        try {
          await apiFetch(`/api/application-domain-operations/${operation.operationId}/rollback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: domainStatus.rollbackConfirmation })
          });
          await refreshApplications();
          await refreshDomainStatus(applicationId);
          setDomainPlan(null);
          setMessage({ type: 'success', text: `Birincil erişim adresi https://${operation.previousDomain} olarak geri alındı.` });
        } catch (domainError) {
          setMessage({ type: 'error', text: domainError.message });
        } finally {
          setDomainApplying(false);
        }
      }
    });
  };

  const closeApplication = () => {
    setSelectedApplicationId(null);
    setTargetContainerId(null);
    setContainerSettings(null);
    setDomainStatus(null);
    setDomainInput('');
    setDomainPlan(null);
    setMessage(null);
  };

  if (selectedApplication) {
    const pendingAction = actions[selectedApplication.id];
    const accessUrl = accessUrlForApplication(selectedApplication, containerSettings);
    const canStart = selectedApplication.capabilities.start;
    const canStop = selectedApplication.capabilities.stop;
    const canRestart = selectedApplication.capabilities.restart;

    return (
      <div data-application-manager data-application-id={selectedApplication.id}>
        <button
          type="button"
          onClick={closeApplication}
          style={{ background: 'transparent', color: '#aaa', border: 'none', padding: '0', marginBottom: '24px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}
        >
          <ArrowLeft size={16} /> Uygulamalara Dön
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '18px', paddingBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ width: '72px', height: '72px', flex: '0 0 72px', borderRadius: '16px', background: 'rgba(255,255,255,0.9)', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ApplicationLogo app={selectedApplication} size={48} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 style={{ margin: '0 0 6px 0', fontSize: '28px', fontWeight: 'bold' }}>{selectedApplication.name}</h3>
            <div style={{ color: '#888', fontSize: '13px' }}>{selectedApplication.publisher}</div>
          </div>
          <ApplicationStatus application={selectedApplication} pendingAction={pendingAction} compact />
        </div>

        {message && (
          <div style={{ marginTop: '20px', padding: '10px 12px', borderRadius: '8px', background: message.type === 'error' ? 'rgba(255,95,86,0.12)' : 'rgba(39,201,63,0.12)', border: `1px solid ${message.type === 'error' ? 'rgba(255,95,86,0.35)' : 'rgba(39,201,63,0.35)'}`, color: message.type === 'error' ? '#ff8a84' : '#75da85', fontSize: '13px' }}>
            {message.text}
          </div>
        )}

        <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: '0 0 14px 0', fontSize: '16px' }}>Kontroller</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            <button type="button" onClick={() => openApplication(selectedApplication)} disabled={!selectedApplication.capabilities.open || selectedApplication.runtime.operationalState !== 'running'} style={{ background: '#0ea5e9', color: '#fff', border: 'none', padding: '9px 14px', borderRadius: '8px', cursor: selectedApplication.capabilities.open && selectedApplication.runtime.operationalState === 'running' ? 'pointer' : 'not-allowed', opacity: selectedApplication.capabilities.open && selectedApplication.runtime.operationalState === 'running' ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 'bold' }}>
              <ExternalLink size={15} /> Aç
            </button>
            {canStop ? (
              <button type="button" onClick={() => runAction(selectedApplication, 'stop')} disabled={Boolean(pendingAction)} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: pendingAction ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
                {pendingAction === 'stop' ? <Loader2 size={15} className="spin" /> : <Square size={15} />} Durdur
              </button>
            ) : (
              <button type="button" onClick={() => runAction(selectedApplication, 'start')} disabled={Boolean(pendingAction) || !canStart} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: pendingAction || !canStart ? 'not-allowed' : 'pointer', opacity: canStart ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
                {pendingAction === 'start' ? <Loader2 size={15} className="spin" /> : <Play size={15} />} Başlat
              </button>
            )}
            <button type="button" onClick={() => runAction(selectedApplication, 'restart')} disabled={Boolean(pendingAction) || !canRestart} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: pendingAction || !canRestart ? 'not-allowed' : 'pointer', opacity: canRestart ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
              {pendingAction === 'restart' ? <Loader2 size={15} className="spin" /> : <RotateCw size={15} />} Yeniden Başlat
            </button>
          </div>
        </section>

        <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Erişim</h3>
          <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px' }}>Uygulamanın yayınlanmış adresi.</div>
          {accessUrl ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
              <div style={{ flex: 1, minWidth: 0, padding: '9px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#ccc', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{accessUrl}</div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await copyText(accessUrl);
                    setMessage({ type: 'success', text: 'Erişim adresi kopyalandı.' });
                  } catch (copyError) {
                    setMessage({ type: 'error', text: copyError.message });
                  }
                }}
                style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}
              >
                <Copy size={14} /> Kopyala
              </button>
            </div>
          ) : (
            <div style={{ color: '#888', fontSize: '13px' }}>Bu uygulama için yayınlanmış bir web adresi bulunamadı.</div>
          )}

          <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ marginBottom: '8px', color: '#ccc', fontSize: '13px', fontWeight: 'bold' }}>Birincil Alan Adı</div>
            {selectedApplication.capabilities.editDomain ? (
              domainLoading && !domainStatus ? (
                <div style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}><Loader2 size={15} className="spin" /> Alan adı ayarları okunuyor...</div>
              ) : (
                <>
                  <div style={{ marginBottom: '10px', color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
                    Yeni adresi önce DNS ve çakışma denetiminden geçirin. Kontrol etmek hiçbir canlı rotayı değiştirmez.
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={domainInput}
                      onChange={(event) => { setDomainInput(event.target.value); setDomainPlan(null); }}
                      disabled={domainApplying}
                      placeholder="uygulama.ornek.com"
                      autoComplete="off"
                      spellCheck={false}
                      style={{ flex: '1 1 280px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}
                    />
                    <button type="button" onClick={checkDomain} disabled={domainLoading || domainApplying || !domainInput.trim()} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: domainLoading || domainApplying || !domainInput.trim() ? 'not-allowed' : 'pointer', opacity: domainLoading || domainApplying || !domainInput.trim() ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
                      {domainLoading ? <Loader2 size={15} className="spin" /> : <Search size={15} />} Kontrol Et
                    </button>
                  </div>

                  {domainPlan && (
                    <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(39,201,63,0.12)', border: '1px solid rgba(39,201,63,0.35)', color: '#75da85', fontSize: '13px', lineHeight: 1.5 }}>
                      <div>https://{domainPlan.domain} kullanılabilir ve genel DNS üzerinde çözümleniyor.</div>
                      <div style={{ marginTop: '10px' }}>
                        <button type="button" onClick={confirmDomainChange} disabled={domainApplying} style={{ background: '#0ea5e9', color: '#fff', border: 'none', padding: '9px 14px', borderRadius: '8px', cursor: domainApplying ? 'wait' : 'pointer', opacity: domainApplying ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 'bold' }}>
                          {domainApplying ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Bu Adrese Geç
                        </button>
                      </div>
                    </div>
                  )}

                  {domainStatus && domainStatus.latestOperation && domainStatus.latestOperation.rollbackAvailable && (
                    <button type="button" onClick={rollbackDomain} disabled={domainApplying} style={{ marginTop: '12px', background: 'transparent', color: '#aaa', border: 'none', padding: 0, cursor: domainApplying ? 'wait' : 'pointer', textDecoration: 'underline', fontSize: '12px' }}>
                      Önceki adrese dön: {domainStatus.latestOperation.previousDomain}
                    </button>
                  )}
                </>
              )
            ) : (
              <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
                Bu uygulama yalnız keşfedildi. Alan adı, sunucu yönetimine güvenli geçiş tamamlandıktan sonra buradan değiştirilebilir.
              </div>
            )}
          </div>
        </section>

        <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Otomatik Başlatma</h3>
          <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px' }}>Sunucu veya Docker yeniden başladığında containerın davranışı.</div>
          {settingsLoading ? (
            <div style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}><Loader2 size={15} className="spin" /> Ayarlar okunuyor...</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <select value={restartPolicy} onChange={(event) => setRestartPolicy(event.target.value)} disabled={!containerSettings} style={{ minWidth: '210px', background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}>
                <option value="no">Kapalı</option>
                <option value="unless-stopped">Elle durdurulana kadar</option>
                <option value="always">Her zaman</option>
              </select>
              <button type="button" onClick={saveContainerSettings} disabled={settingsSaving || !containerSettings} style={{ background: '#0ea5e9', color: '#fff', border: 'none', padding: '9px 14px', borderRadius: '8px', cursor: settingsSaving || !containerSettings ? 'not-allowed' : 'pointer', opacity: settingsSaving || !containerSettings ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 'bold' }}>
                {settingsSaving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Kaydet
              </button>
            </div>
          )}
        </section>

        <section style={{ padding: '26px 0 0 0' }}>
          <h3 style={{ margin: '0 0 14px 0', fontSize: '16px' }}>Uygulama</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', wordBreak: 'break-word' }}>
            <div style={{ color: '#888' }}>Instance</div><div>{selectedApplication.instanceName || selectedApplication.runtime.containerName}</div>
            <div style={{ color: '#888' }}>Container</div><div>{selectedApplication.runtime.containerName}</div>
            <div style={{ color: '#888' }}>Yönetim</div><div>{selectedApplication.managedByServer ? 'Sunucu' : 'Yalnız keşfedildi'}</div>
            <div style={{ color: '#888' }}>Durum</div><div>{selectedApplication.runtime.status || selectedApplication.runtime.state}</div>
            {containerSettings && containerSettings.ports.length > 0 && (
              <><div style={{ color: '#888' }}>Portlar</div><div>{containerSettings.ports.map((port) => `${port.hostIp}:${port.hostPort} → ${port.privatePort}`).join(', ')}</div></>
            )}
            {containerSettings && containerSettings.mounts.length > 0 && (
              <><div style={{ color: '#888' }}>Depolama</div><div>{containerSettings.mounts.map((mount) => `${mount.name || mount.source} → ${mount.destination}${mount.readOnly ? ' (salt okunur)' : ''}`).join(', ')}</div></>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div data-application-manager>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
        <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
          Sunucuda keşfedilen kullanıcı uygulamaları. Her instance ayrı görünür.
        </div>
        <button type="button" onClick={() => refreshApplications().catch(() => {})} disabled={loading} style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', padding: '8px 12px', borderRadius: '8px', cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 'bold' }}>
          <RotateCw size={14} className={loading ? 'spin' : ''} /> Yenile
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 10px', marginBottom: '20px' }}>
        <Search size={16} color="#888" style={{ marginRight: '8px' }} />
        <input
          type="text"
          placeholder="Uygulamalarda ara..."
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          style={{ background: 'transparent', border: 'none', color: '#fff', outline: 'none', width: '100%', fontSize: '13px' }}
        />
      </div>

      {error && applications.length > 0 && (
        <div style={{ marginBottom: '20px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(255,95,86,0.12)', border: '1px solid rgba(255,95,86,0.35)', color: '#ff8a84', fontSize: '13px' }}>
          Envanter yenilenemedi. Son doğrulanmış liste korunuyor: {error}
        </div>
      )}

      {loading && applications.length === 0 ? (
        <div style={{ padding: '40px', color: '#888', textAlign: 'center' }}><Loader2 size={20} className="spin" /> Uygulamalar yükleniyor...</div>
      ) : error && applications.length === 0 ? (
        <div style={{ padding: '40px', color: '#ff8a84', textAlign: 'center' }}>{error}</div>
      ) : displayedApplications.length === 0 ? (
        <div style={{ padding: '40px', color: '#888', textAlign: 'center' }}>Eşleşen uygulama bulunamadı.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px' }}>
          {displayedApplications.map((application) => (
            <div key={application.id} data-application-card={application.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '20px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
                <div style={{ width: '60px', height: '60px', flex: '0 0 60px', borderRadius: '14px', background: 'rgba(255,255,255,0.9)', padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ApplicationLogo app={application} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis' }}>{application.name}</h3>
                  <div style={{ fontSize: '12px', color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{application.instanceName || application.runtime.containerName}</div>
                </div>
              </div>
              <div style={{ margin: '0 0 20px 0', fontSize: '12px', color: '#888', lineHeight: '1.5', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {application.externalUrl || application.runtime.containerName}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '16px' }}>
                <ApplicationStatus application={application} pendingAction={actions[application.id]} compact />
                <button type="button" onClick={() => { setSelectedApplicationId(application.id); setMessage(null); }} style={{ background: 'transparent', color: '#0ea5e9', border: '1px solid #0ea5e9', padding: '6px 14px', borderRadius: '16px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Settings size={14} /> Ayarlar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ApplicationManager;
