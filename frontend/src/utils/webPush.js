import { apiFetch } from '../api';

const SERVICE_WORKER_PATH = '/notification-sw.js';

function applicationServerKey(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function browserPushCapability() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { supported: false, reasonKey: 'notifications.channels.unsupportedEnvironment' };
  }
  if (!window.isSecureContext) {
    return { supported: false, reasonKey: 'notifications.channels.secureContextRequired' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { supported: false, reasonKey: 'notifications.channels.webPushUnsupported' };
  }
  if (Notification.permission === 'denied') {
    return { supported: false, reasonKey: 'notifications.channels.permissionBlocked' };
  }
  return { supported: true, reasonKey: null };
}

async function registration() {
  return navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: '/' });
}

export async function currentBrowserPushState() {
  const capability = browserPushCapability();
  if (!capability.supported) return {
    ...capability,
    subscribed: false,
    permission: typeof Notification === 'undefined' ? 'default' : Notification.permission
  };
  const existingRegistration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await existingRegistration?.pushManager.getSubscription();
  return {
    ...capability,
    subscribed: Boolean(subscription),
    permission: Notification.permission
  };
}

export async function enableBrowserPush(t = (key) => key) {
  const capability = browserPushCapability();
  if (!capability.supported) throw new Error(t(capability.reasonKey));
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(t('notifications.channels.permissionNotGranted'));
  const pushResponse = await apiFetch('/api/notifications/push');
  const push = await pushResponse.json();
  const serviceWorker = await registration();
  let subscription = await serviceWorker.pushManager.getSubscription();
  if (!subscription) {
    subscription = await serviceWorker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(push.publicKey)
    });
  }
  const response = await apiFetch('/api/notifications/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON() })
  });
  return response.json();
}

export async function disableBrowserPush(t = (key) => key) {
  const capability = browserPushCapability();
  if (!capability.supported && !('serviceWorker' in navigator)) throw new Error(t(capability.reasonKey));
  const existingRegistration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await existingRegistration?.pushManager.getSubscription();
  if (!subscription) return { removed: 0 };
  const response = await apiFetch('/api/notifications/push/subscriptions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });
  const payload = await response.json();
  await subscription.unsubscribe();
  return payload;
}
