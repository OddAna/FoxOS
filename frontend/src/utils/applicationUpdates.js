import { apiFetch } from '../api';

export const APPLY_APPLICATION_UPDATE_CONFIRMATION = 'UYGULAMA GÜNCELLEMESİNİ UYGULA';
export const ROLLBACK_APPLICATION_UPDATE_CONFIRMATION = 'UYGULAMA GÜNCELLEMESİNİ GERİ AL';

export const checkAndPlanApplicationUpdate = async (applicationId) => {
  const checkResponse = await apiFetch(`/api/applications/${applicationId}/update-check`);
  const checkPayload = await checkResponse.json();
  const update = checkPayload.update;
  if (!update || update.updateAvailable !== true) return { update, plan: null };
  const planResponse = await apiFetch(`/api/applications/${applicationId}/update-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  const planPayload = await planResponse.json();
  return { update, plan: planPayload.plan };
};

export const applyApplicationUpdate = async (planId) => {
  const response = await apiFetch(`/api/application-update-plans/${planId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: APPLY_APPLICATION_UPDATE_CONFIRMATION })
  });
  return (await response.json()).operation;
};

export const rollbackApplicationUpdate = async (operationId) => {
  const response = await apiFetch(`/api/application-update-operations/${operationId}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: ROLLBACK_APPLICATION_UPDATE_CONFIRMATION })
  });
  return (await response.json()).operation;
};

export const updateConfirmationMessage = (plan) => {
  const current = plan.current && plan.current.version || 'mevcut sürüm';
  const latest = plan.latest && plan.latest.version || 'güncel sürüm';
  const services = (plan.services || []).map((service) => service.name).join(', ');
  const backup = plan.statefulVolumes && plan.statefulVolumes.length
    ? ` ${plan.statefulVolumes.length} kalıcı veri alanı önce şifreli yedeklenecek.`
    : '';
  const provider = plan.providerMayOverwrite
    ? ' Geçiş tamamlanana kadar mevcut sağlayıcının sonraki dağıtımı bu sürümü yeniden değiştirebilir.'
    : '';
  return `${current} → ${latest} güncellemesi uygulanacak. Birlikte güncellenecek servisler: ${services}.${backup} Sağlık kontrolü geçmezse önceki sürüm otomatik geri yüklenecek.${provider}`;
};
