export const APPLICATION_STATUS = {
  running: { color: '#27c93f', labelKey: 'applications.status.running' },
  transitioning: { color: '#ffbd2e', labelKey: 'applications.status.transitioning' },
  error: { color: '#ff5f56', labelKey: 'applications.status.error' },
  stopped: { color: '#000', labelKey: 'applications.status.stopped' }
};

export const applicationOperationalState = (application, pendingAction) => (
  pendingAction ? 'transitioning' : application.runtime.operationalState
);
