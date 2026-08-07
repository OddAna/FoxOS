import { applicationOperationalState } from './applicationStatus';

export const DESKTOP_ROOT = '/Masaüstü';

export const canonicalDesktopPath = (value = DESKTOP_ROOT) => {
  const slashPath = String(value || DESKTOP_ROOT).trim().replace(/\\/g, '/');
  const segments = slashPath.split('/').filter(Boolean);
  if (segments[0] !== DESKTOP_ROOT.slice(1)) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return '/' + segments.join('/');
};

export const applicationShortcutPath = (application) => (
  canonicalDesktopPath(application && application.desktopShortcutPath) || DESKTOP_ROOT
);

export const applicationsAtShortcutPath = (applications, folderPath) => {
  const target = canonicalDesktopPath(folderPath);
  if (!target) return [];
  return applications.filter((application) => (
    application.desktopShortcutVisible !== false && applicationShortcutPath(application) === target
  ));
};

export const folderApplicationOperationalState = (
  folderPath,
  applications,
  pendingActions = {}
) => {
  const target = canonicalDesktopPath(folderPath);
  if (!target) return null;
  const prefix = target + '/';
  const states = applications
    .filter((application) => {
      if (application.desktopShortcutVisible === false) return false;
      const shortcutPath = applicationShortcutPath(application);
      return shortcutPath === target || shortcutPath.startsWith(prefix);
    })
    .map((application) => applicationOperationalState(application, pendingActions[application.id]));

  if (states.length === 0) return null;
  if (states.includes('error')) return 'error';
  if (states.includes('transitioning')) return 'transitioning';
  if (states.includes('running')) return 'running';
  return 'stopped';
};
