export const APPLICATION_STATUS = {
  running: { color: '#27c93f', label: 'Çalışıyor' },
  transitioning: { color: '#ffbd2e', label: 'İşlem sürüyor' },
  error: { color: '#ff5f56', label: 'Hata' },
  stopped: { color: '#000', label: 'Durduruldu' }
};

export const applicationOperationalState = (application, pendingAction) => (
  pendingAction ? 'transitioning' : application.runtime.operationalState
);
