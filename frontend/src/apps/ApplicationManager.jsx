import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Play,
  Plus,
  RotateCw,
  Save,
  Search,
  Settings,
  Square,
  X
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
    runApplicationAction,
    setDesktopShortcut
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
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainApplying, setDomainApplying] = useState(false);
  const [domainMessage, setDomainMessage] = useState(null);
  const [shortcutSaving, setShortcutSaving] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [composeState, setComposeState] = useState(null);
  const [composeLoading, setComposeLoading] = useState(false);
  const [composeSaving, setComposeSaving] = useState(false);
  const [composeError, setComposeError] = useState(null);
  const [composeMessage, setComposeMessage] = useState(null);
  const [selectedComposeFileId, setSelectedComposeFileId] = useState(null);
  const [composeContent, setComposeContent] = useState('');
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!target) {
      setSelectedApplicationId(null);
      setTargetContainerId(null);
      setDomainMessage(null);
      setUpdateStatus(null);
      setMessage(null);
      return;
    }
    setSelectedApplicationId(target.applicationId || null);
    setTargetContainerId(target.containerId || null);
    setSearchQuery('');
    setDomainMessage(null);
    setUpdateStatus(null);
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
    selectedApplication && (selectedApplication.capabilities.editAccessLink || selectedApplication.capabilities.editDomain)
  );
  const canEditSelectedCompose = Boolean(
    selectedApplication && selectedApplication.capabilities.editCompose
  );

  useEffect(() => {
    if (!selectedContainerId) {
      setContainerSettings(null);
      setSettingsLoading(false);
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
      setDomainLoading(false);
      setDomainMessage(null);
      return undefined;
    }

    let active = true;
    setDomainLoading(true);
    setDomainMessage(null);
    setMessage(null);
    apiFetch(`/api/applications/${selectedDomainApplicationId}/domain`)
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setDomainStatus(payload);
        setDomainInput('');
      })
      .catch((domainError) => {
        if (active) setDomainMessage({ type: 'error', text: domainError.message });
      })
      .finally(() => {
        if (active) setDomainLoading(false);
      });

    return () => { active = false; };
  }, [selectedDomainApplicationId, canEditSelectedDomain]);

  useEffect(() => {
    if (!selectedApplicationId) {
      setComposeState(null);
      setComposeError(null);
      setComposeMessage(null);
      setSelectedComposeFileId(null);
      setComposeContent('');
      return undefined;
    }

    if (!canEditSelectedCompose) {
      setComposeLoading(false);
      setComposeError(null);
      setComposeMessage(null);
      setSelectedComposeFileId(null);
      setComposeContent('');
      setComposeState({
        editable: false,
        files: [],
        reason: 'Bu deaktif kurulumun çalışan container metadata’sı olmadığı için bağlı Compose kaynağı henüz doğrulanamıyor.'
      });
      return undefined;
    }

    let active = true;
    setComposeLoading(true);
    setComposeState(null);
    setComposeError(null);
    setComposeMessage(null);
    setSelectedComposeFileId(null);
    setComposeContent('');
    apiFetch(`/api/applications/${selectedApplicationId}/compose-files`)
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        const compose = payload.compose;
        setComposeState(compose);
        const firstFile = compose && compose.files && compose.files[0];
        if (firstFile) {
          setSelectedComposeFileId(firstFile.fileId);
          setComposeContent(firstFile.content);
        }
      })
      .catch((composeLoadError) => {
        if (active) setComposeError(composeLoadError.message);
      })
      .finally(() => {
        if (active) setComposeLoading(false);
      });

    return () => { active = false; };
  }, [selectedApplicationId, canEditSelectedCompose]);

  const displayedApplications = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('tr-TR');
    if (!query) return applications;
    return applications.filter((application) => (
      `${application.name} ${application.instanceName || ''} ${application.externalUrl || ''} ${(application.declaredUrls || []).join(' ')} ${application.category || ''}`
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

  const changeDesktopShortcut = async () => {
    if (!selectedApplication) return;
    const visible = selectedApplication.desktopShortcutVisible === false;
    setShortcutSaving(true);
    setMessage(null);
    try {
      await setDesktopShortcut(selectedApplication, visible);
      setMessage({
        type: 'success',
        text: visible ? 'Masaüstü kısayolu oluşturuldu.' : 'Masaüstü kısayolu kaldırıldı.'
      });
    } catch (shortcutError) {
      setMessage({ type: 'error', text: shortcutError.message });
    } finally {
      setShortcutSaving(false);
    }
  };

  const checkForUpdates = async () => {
    if (!selectedApplication) return;
    setUpdateChecking(true);
    setUpdateStatus(null);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/applications/${selectedApplication.id}/update-check`);
      const payload = await response.json();
      setUpdateStatus(payload.update);
    } catch (updateError) {
      setMessage({ type: 'error', text: updateError.message });
    } finally {
      setUpdateChecking(false);
    }
  };

  const selectComposeFile = (file) => {
    setSelectedComposeFileId(file.fileId);
    setComposeContent(file.content);
    setComposeError(null);
    setComposeMessage(null);
  };

  const saveComposeFile = async (file) => {
    if (!selectedApplication || !file) return;
    setComposeSaving(true);
    setComposeError(null);
    setComposeMessage(null);
    try {
      const response = await apiFetch(
        `/api/applications/${selectedApplication.id}/compose-files/${file.fileId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirmation: 'COMPOSE DOSYASINI KAYDET',
            content: composeContent,
            revision: file.revision
          })
        }
      );
      const payload = await response.json();
      const result = payload.result;
      setComposeState((current) => ({
        ...current,
        files: current.files.map((candidate) => (
          candidate.fileId === result.file.fileId ? result.file : candidate
        ))
      }));
      setComposeContent(result.file.content);
      setComposeMessage(result.message);
    } catch (composeSaveError) {
      setComposeError(composeSaveError.message);
    } finally {
      setComposeSaving(false);
    }
  };

  const confirmComposeSave = (file) => {
    showDialog({
      title: 'Compose Dosyasını Kaydet',
      message: 'YAML doğrulanacak, mevcut revision şifreli yedeklenecek ve gerçek sunucu dosyası atomik olarak değiştirilecek. Çalışan servis otomatik yeniden oluşturulmayacak.',
      type: 'confirm',
      confirmText: 'Kaydet',
      cancelText: 'Vazgeç',
      onConfirm: () => saveComposeFile(file)
    });
  };

  const addDomain = async () => {
    if (!selectedApplication || !domainInput.trim()) return;
    setDomainLoading(true);
    setDomainMessage(null);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/applications/${selectedApplication.id}/domain/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domainInput })
      });
      const payload = await response.json();
      const plan = payload.plan;
      const dnsChange = plan.dnsAutomation && plan.dnsAutomation.mutationRequired
        ? ` Cloudflare üzerinde A kaydı ${plan.dnsAutomation.publicIpv4} adresine ayarlanacak${plan.dnsAutomation.removesIpv6 ? ` ve ${plan.dnsAutomation.removesIpv6} AAAA kaydı kaldırılacak` : ''}; işlem tamamlanamazsa DNS değişikliği geri alınacak.`
        : '';
      showDialog({
        title: 'Erişim Linki Ekle',
        message: `https://${plan.domain} sunucu yönlendirmesi, TLS ve uygulama sağlığıyla doğrulanacak.${dnsChange} Yeni link birincil olur; mevcut erişim linkleri açık kalır.`,
        type: 'confirm',
        confirmText: 'Ekle',
        cancelText: 'Vazgeç',
        onConfirm: () => applyDomainPlan(plan)
      });
    } catch (domainError) {
      setDomainMessage({ type: 'error', text: domainError.message });
    } finally {
      setDomainLoading(false);
    }
  };

  const refreshDomainStatus = async (applicationId) => {
    const response = await apiFetch(`/api/applications/${applicationId}/domain`);
    const payload = await response.json();
    setDomainStatus(payload);
    setDomainInput('');
    return payload;
  };

  const applyDomainPlan = async (plan) => {
    if (!selectedApplication || !plan) return;
    const applicationId = selectedApplication.id;
    setDomainApplying(true);
    setDomainMessage(null);
    setMessage(null);
    try {
      await apiFetch(`/api/application-domain-plans/${plan.planId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: plan.confirmation })
      });
      await refreshApplications();
      await refreshDomainStatus(applicationId);
      setDomainMessage({
        type: 'success',
        text: `${plan.dnsAutomation && plan.dnsAutomation.mutationRequired ? 'Cloudflare DNS kaydıyla birlikte ' : ''}https://${plan.domain} erişim linki eklendi. Mevcut linkler açık bırakıldı.`
      });
    } catch (domainError) {
      setDomainMessage({ type: 'error', text: domainError.message });
    } finally {
      setDomainApplying(false);
    }
  };

  const rollbackDomain = () => {
    const operation = domainStatus && domainStatus.latestOperation;
    if (!selectedApplication || !operation || !domainStatus.rollbackConfirmation) return;
    const applicationId = selectedApplication.id;
    const previousAddress = operation.previousDomain ? `https://${operation.previousDomain}` : 'önceki erişim adresi';
    const dnsRollback = operation.dnsAutomation && operation.dnsAutomation.mutationRequired
      ? ' Bu işlemde değiştirilen Cloudflare DNS kayıtları da önceki durumuna getirilecek.'
      : '';
    showDialog({
      title: 'Önceki Adrese Dön',
      message: `Erişim linki yeniden ${previousAddress} olacak. Sonradan eklenen ${operation.primaryDomain} rotası güvenle kaldırılacak.${dnsRollback}`,
      type: 'confirm',
      confirmText: 'Geri Dön',
      cancelText: 'Vazgeç',
      onConfirm: async () => {
        setDomainApplying(true);
        setDomainMessage(null);
        setMessage(null);
        try {
          await apiFetch(`/api/application-domain-operations/${operation.operationId}/rollback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: domainStatus.rollbackConfirmation })
          });
          await refreshApplications();
          await refreshDomainStatus(applicationId);
          setDomainMessage({ type: 'success', text: `Erişim linki ${previousAddress} olarak geri alındı.` });
        } catch (domainError) {
          setDomainMessage({ type: 'error', text: domainError.message });
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
    setDomainMessage(null);
    setUpdateStatus(null);
    setComposeState(null);
    setComposeError(null);
    setSelectedComposeFileId(null);
    setComposeContent('');
    setMessage(null);
  };

  if (selectedApplication) {
    const pendingAction = actions[selectedApplication.id];
    const accessUrl = accessUrlForApplication(selectedApplication, containerSettings);
    const canStart = selectedApplication.capabilities.start;
    const canStop = selectedApplication.capabilities.stop;
    const canRestart = selectedApplication.capabilities.restart;
    const selectedComposeFile = composeState && composeState.files
      ? composeState.files.find((file) => file.fileId === selectedComposeFileId) || null
      : null;
    const activeAccessUrls = domainStatus && domainStatus.editable
      ? [...new Set([domainStatus.currentDomain, ...(domainStatus.aliases || [])].filter(Boolean))]
        .sort((left, right) => (
          left === domainStatus.currentDomain ? -1 : right === domainStatus.currentDomain ? 1 : left.localeCompare(right)
        ))
        .map((domain) => `https://${domain}`)
      : accessUrl ? [accessUrl] : [];

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
            <button type="button" onClick={checkForUpdates} disabled={updateChecking || !selectedApplication.capabilities.checkUpdates} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: updateChecking ? 'wait' : selectedApplication.capabilities.checkUpdates ? 'pointer' : 'not-allowed', opacity: selectedApplication.capabilities.checkUpdates ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
              {updateChecking ? <Loader2 size={15} className="spin" /> : <RotateCw size={15} />} Güncellemeleri Denetle
            </button>
            <button type="button" onClick={changeDesktopShortcut} disabled={shortcutSaving} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 14px', borderRadius: '8px', cursor: shortcutSaving ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
              {shortcutSaving ? <Loader2 size={15} className="spin" /> : selectedApplication.desktopShortcutVisible === false ? <Plus size={15} /> : <X size={15} />}
              {selectedApplication.desktopShortcutVisible === false ? 'Masaüstüne Kısayol Oluştur' : 'Masaüstü Kısayolunu Kaldır'}
            </button>
          </div>
          {updateStatus && (
            <div aria-live="polite" style={{ marginTop: '14px', padding: '10px 12px', borderRadius: '8px', background: updateStatus.status === 'update-available' ? 'rgba(245,158,11,0.12)' : updateStatus.status === 'up-to-date' ? 'rgba(39,201,63,0.12)' : 'rgba(255,255,255,0.05)', border: `1px solid ${updateStatus.status === 'update-available' ? 'rgba(245,158,11,0.35)' : updateStatus.status === 'up-to-date' ? 'rgba(39,201,63,0.35)' : 'rgba(255,255,255,0.12)'}`, color: updateStatus.status === 'update-available' ? '#fbbf24' : updateStatus.status === 'up-to-date' ? '#75da85' : '#bbb', fontSize: '13px', lineHeight: 1.5 }}>
              <div>{updateStatus.message}</div>
              {(updateStatus.current && updateStatus.current.version || updateStatus.latest && updateStatus.latest.version) && (
                <div style={{ marginTop: '4px', color: '#aaa', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>
                  {updateStatus.current && updateStatus.current.version || 'bilinmiyor'} → {updateStatus.latest && updateStatus.latest.version || 'bilinmiyor'}
                </div>
              )}
            </div>
          )}
        </section>

        <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Erişim Linkleri</h3>
          <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px' }}>Uygulamayı açan etkin adresler.</div>
          {activeAccessUrls.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {activeAccessUrls.map((url) => {
                const primary = domainStatus && url === `https://${domainStatus.currentDomain}`;
                return (
                  <div key={url} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'stretch' }}>
                    <div style={{ flex: '1 1 280px', minWidth: 0, padding: '9px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#ccc', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {url}{primary && <span style={{ marginLeft: '9px', color: '#75da85', fontFamily: 'inherit' }}>Birincil</span>}
                    </div>
                    <button type="button" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}>
                      <ExternalLink size={14} /> Aç
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await copyText(url);
                          setMessage({ type: 'success', text: 'Erişim linki kopyalandı.' });
                        } catch (copyError) {
                          setMessage({ type: 'error', text: copyError.message });
                        }
                      }}
                      style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px' }}
                    >
                      <Copy size={14} /> Kopyala
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            selectedApplication.declaredUrls && selectedApplication.declaredUrls.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {selectedApplication.declaredUrls.map((url) => (
                  <div key={url} style={{ padding: '9px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#888', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {url} · tanımda kayıtlı, şu anda çalışmıyor
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: '#888', fontSize: '13px' }}>Bu uygulama için yayınlanmış bir web adresi bulunamadı.</div>
            )
          )}

          <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ marginBottom: '8px', color: '#ccc', fontSize: '13px', fontWeight: 'bold' }}>Yeni Link Ekle</div>
            {canEditSelectedDomain ? (
              domainLoading && !domainStatus ? (
                <div style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}><Loader2 size={15} className="spin" /> Erişim linki okunuyor...</div>
              ) : domainStatus && !domainStatus.editable ? (
                <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.5 }}>{domainStatus.reason}</div>
              ) : (
                <>
                  <div style={{ marginBottom: '10px', color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
                    {domainStatus && domainStatus.dnsAutomation && domainStatus.dnsAutomation.connected
                      ? 'Yeni HTTPS adresini yazın. Bağlı Cloudflare hesabı bu alan adını kapsıyorsa gerekli DNS kaydı otomatik hazırlanır. Ekleme güvenle tamamlanamazsa hiçbir değişiklik yapılmadan sorun burada gösterilir.'
                      : 'Yeni HTTPS adresini yazın. Cloudflare bağlantısı yoksa alan adının A kaydı önce bu sunucuya yönlenmiş olmalıdır. Ekleme güvenle tamamlanamazsa hiçbir değişiklik yapılmaz.'}
                  </div>
                  <form onSubmit={(event) => { event.preventDefault(); addDomain(); }} style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={domainInput}
                      onChange={(event) => { setDomainInput(event.target.value); setDomainMessage(null); }}
                      disabled={domainLoading || domainApplying}
                      placeholder="uygulama.ornek.com"
                      autoComplete="off"
                      spellCheck={false}
                      style={{ flex: '1 1 280px', minWidth: 0, background: '#24242a', color: '#fff', border: '1px solid rgba(255,255,255,0.16)', padding: '9px 12px', borderRadius: '8px', outline: 'none', fontSize: '13px' }}
                    />
                    <button type="submit" disabled={domainLoading || domainApplying || !domainInput.trim()} style={{ background: '#0ea5e9', color: '#fff', border: 'none', padding: '9px 14px', borderRadius: '8px', cursor: domainLoading || domainApplying || !domainInput.trim() ? 'not-allowed' : 'pointer', opacity: domainLoading || domainApplying || !domainInput.trim() ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 'bold' }}>
                      {domainLoading || domainApplying ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Ekle
                    </button>
                  </form>

                  {domainMessage && (
                    <div aria-live="polite" style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '8px', background: domainMessage.type === 'error' ? 'rgba(255,95,86,0.12)' : 'rgba(39,201,63,0.12)', border: `1px solid ${domainMessage.type === 'error' ? 'rgba(255,95,86,0.35)' : 'rgba(39,201,63,0.35)'}`, color: domainMessage.type === 'error' ? '#ff8a84' : '#75da85', fontSize: '13px', lineHeight: 1.5 }}>
                      {domainMessage.text}
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
                Bu uygulama için doğrulanmış bir web hedefi henüz bulunamadı. Sunucu taramasını yenileyip tekrar deneyin.
              </div>
            )}
          </div>
        </section>

        <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Otomatik Başlatma</h3>
          <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px' }}>Sunucu veya Docker yeniden başladığında containerın davranışı.</div>
          {!selectedContainerId ? (
            <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.5 }}>Çalışan container bulunmadığı için otomatik başlatma ayarı henüz kullanılamıyor.</div>
          ) : settingsLoading ? (
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

        <section style={{ padding: '26px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '16px' }}>Compose Dosyaları</h3>
          <div style={{ marginBottom: '14px', color: '#888', fontSize: '13px', lineHeight: 1.5 }}>
            Docker metadata’sında bu uygulamaya bağlı olduğu doğrulanan gerçek Compose kaynakları.
          </div>
          {composeLoading ? (
            <div style={{ color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}><Loader2 size={15} className="spin" /> Compose dosyaları okunuyor...</div>
          ) : composeError && !composeState ? (
            <div aria-live="polite" style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(255,95,86,0.12)', border: '1px solid rgba(255,95,86,0.35)', color: '#ff8a84', fontSize: '13px', lineHeight: 1.5 }}>{composeError}</div>
          ) : composeState && !composeState.editable ? (
            <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.5 }}>{composeState.reason}</div>
          ) : composeState && selectedComposeFile ? (
            <>
              {composeState.providerMayOverwrite && (
                <div style={{ marginBottom: '14px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)', color: '#fbbf24', fontSize: '13px', lineHeight: 1.5 }}>
                  Geçiş tamamlanana kadar mevcut sağlayıcının sonraki dağıtımı bu dosyayı yeniden yazabilir.
                </div>
              )}
              {composeState.files.length > 1 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                  {composeState.files.map((file) => (
                    <button key={file.fileId} type="button" onClick={() => selectComposeFile(file)} style={{ background: file.fileId === selectedComposeFileId ? '#0ea5e9' : 'rgba(255,255,255,0.08)', color: '#fff', border: file.fileId === selectedComposeFileId ? '1px solid #0ea5e9' : '1px solid rgba(255,255,255,0.16)', padding: '7px 11px', borderRadius: '8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '12px' }}>
                      <FileText size={14} /> {file.name}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ marginBottom: '8px', color: '#888', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' }}>{selectedComposeFile.path}</div>
              <textarea
                value={composeContent}
                onChange={(event) => { setComposeContent(event.target.value); setComposeError(null); setComposeMessage(null); }}
                disabled={composeSaving}
                spellCheck={false}
                style={{ width: '100%', minHeight: '320px', resize: 'vertical', boxSizing: 'border-box', background: '#17171b', color: '#e5e7eb', border: '1px solid rgba(255,255,255,0.16)', borderRadius: '8px', padding: '12px', outline: 'none', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', lineHeight: 1.55 }}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginTop: '10px' }}>
                <div style={{ color: '#888', fontSize: '12px', lineHeight: 1.5, flex: '1 1 320px' }}>
                  Kaydetme YAML’i doğrular ve önceki revision’ı şifreli yedekler. Çalışan servis kendiliğinden yeniden oluşturulmaz.
                </div>
                <button type="button" onClick={() => confirmComposeSave(selectedComposeFile)} disabled={composeSaving || composeContent === selectedComposeFile.content} style={{ background: '#0ea5e9', color: '#fff', border: 'none', padding: '9px 14px', borderRadius: '8px', cursor: composeSaving || composeContent === selectedComposeFile.content ? 'not-allowed' : 'pointer', opacity: composeSaving || composeContent === selectedComposeFile.content ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 'bold' }}>
                  {composeSaving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Dosyayı Kaydet
                </button>
              </div>
              {composeMessage && (
                <div aria-live="polite" style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(39,201,63,0.12)', border: '1px solid rgba(39,201,63,0.35)', color: '#75da85', fontSize: '13px', lineHeight: 1.5 }}>{composeMessage}</div>
              )}
              {composeError && (
                <div aria-live="polite" style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(255,95,86,0.12)', border: '1px solid rgba(255,95,86,0.35)', color: '#ff8a84', fontSize: '13px', lineHeight: 1.5 }}>{composeError}</div>
              )}
            </>
          ) : (
            <div style={{ color: '#888', fontSize: '13px' }}>Compose kaynağı bulunamadı.</div>
          )}
        </section>

        <section style={{ padding: '26px 0 0 0' }}>
          <h3 style={{ margin: '0 0 14px 0', fontSize: '16px' }}>Uygulama</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', rowGap: '10px', columnGap: '16px', fontSize: '13px', wordBreak: 'break-word' }}>
            <div style={{ color: '#888' }}>Instance</div><div>{selectedApplication.instanceName || selectedApplication.runtime.containerName || 'Deaktif kurulum'}</div>
            <div style={{ color: '#888' }}>Container</div><div>{selectedApplication.runtime.containerName || 'Çalışan container yok'}</div>
            <div style={{ color: '#888' }}>Yönetim</div><div>{selectedApplication.installation && selectedApplication.installation.state === 'inactive-definition' ? 'Kurulum tanımı bulundu · şu anda çalışmıyor' : selectedApplication.managedByServer ? 'Sunucu tarafından yönetiliyor' : `${selectedApplication.provenance.source === 'coolify' ? 'Coolify' : 'Mevcut'} kurulumundan çalışıyor · geçiş tamamlanmadı`}</div>
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
          Sunucuda keşfedilen kurulu uygulamalar. Çalışan ve deaktif her instance ayrı görünür.
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
                  <div style={{ fontSize: '12px', color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{application.instanceName || application.runtime.containerName || 'Deaktif kurulum'}</div>
                </div>
              </div>
              <div style={{ margin: '0 0 20px 0', fontSize: '12px', color: '#888', lineHeight: '1.5', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {application.externalUrl || application.runtime.containerName || application.summary}
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
