import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('menu bar notification center uses the authenticated hub and real-time stream', () => {
  const topBar = read('../src/components/TopBar.jsx');
  const center = read('../src/components/NotificationCenter.jsx');
  assert.match(topBar, /<NotificationCenter/);
  assert.match(topBar, /tab: 'notifications'/);
  assert.match(center, /\/api\/notifications\?limit=12/);
  assert.match(center, /\/api\/tasks\?status=all&limit=100/);
  assert.match(center, /new EventSource\('\/api\/notifications\/stream'\)/);
  assert.match(center, /\/api\/notifications\/read-all/);
  assert.match(center, /activeView === 'tasks'/);
  assert.match(center, /type="datetime-local"/);
  assert.match(center, /\/api\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/\$\{action\}/);
  assert.match(center, /notificationCenter\.completedTasks/);
  assert.match(center, /topbar-notification-trigger/);
  assert.match(center, /expandedTaskId/);
  assert.match(center, /aria-expanded=\{expanded\}/);
  assert.match(center, /className="checklist-details"/);
  assert.match(center, /task\.notes \|\| t\('notificationCenter\.noNotes'\)/);
  assert.match(center, /taskDateLabel\(task\.createdAt/);
  assert.match(center, /createPortal/);
  assert.match(center, /popoverRef\.current\?\.contains/);
});

test('notification settings expose working channels, rules, source controls and delivery history', () => {
  const settings = read('../src/apps/SettingsApp.jsx');
  const notifications = read('../src/apps/NotificationSettings.jsx');
  assert.match(settings, /<NotificationSettings/);
  assert.match(notifications, /\/api\/notifications\/settings/);
  assert.match(notifications, /\/api\/notifications\/test/);
  assert.match(notifications, /enableBrowserPush/);
  assert.match(notifications, /\/api\/notifications\/telegram\/configure/);
  assert.match(notifications, /\/api\/notifications\/telegram\/pair/);
  assert.match(notifications, /https:\/\/t\.me\/BotFather/);
  assert.match(notifications, /\/bildirimler/);
  assert.match(notifications, /\/gorevler/);
  assert.match(notifications, /\/sessiz 2s/);
  assert.match(notifications, /\/api\/tasks\/codex-review/);
  assert.match(notifications, /\/api\/tasks\/codex-review\/run/);
  assert.match(notifications, /\/api\/tasks\/codex-review\/telegram-chats/);
  assert.match(notifications, /notifications\.review\.telegramChats/);
  assert.match(notifications, /chatRefs: telegramReviewDraft/);
  assert.match(notifications, /notifications\.review\.title/);
  assert.match(notifications, /notifications\.review\.noteBefore/);
  assert.match(notifications, /notifications\.review\.noteStrong/);
  assert.match(notifications, /notifications\.review\.noConnection/);
  assert.match(notifications, /notifications\.review\.runNow/);
  assert.match(notifications, /notifications\.rules\.quietHours/);
  assert.match(notifications, /notifications\.sourceRules\.title/);
  assert.match(notifications, /notifications\.history\.title/);
});

test('web push is installable and keeps notification interaction in the FoxOS origin', () => {
  const push = read('../src/utils/webPush.js');
  const serviceWorker = read('../public/notification-sw.js');
  const manifest = JSON.parse(read('../public/manifest.webmanifest'));
  const html = read('../index.html');
  assert.match(push, /serviceWorker\.register\(SERVICE_WORKER_PATH/);
  assert.match(push, /pushManager\.subscribe/);
  assert.match(push, /\/api\/notifications\/push\/subscriptions/);
  assert.match(serviceWorker, /self\.registration\.showNotification/);
  assert.match(serviceWorker, /self\.clients\.matchAll/);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.match(html, /manifest\.webmanifest/);
});

test('notification center and settings have dedicated mobile layouts', () => {
  const css = read('../src/index.css');
  assert.match(css, /\.notification-popover\s*\{[\s\S]*position: fixed/);
  assert.match(css, /\.notification-popover\s*\{[\s\S]*bottom: calc\(var\(--foxos-dock-reserve\) \+ 6px\)/);
  assert.match(css, /\.notification-popover\s*\{[\s\S]*max-height: none/);
  assert.match(css, /\.checklist-create > input,[\s\S]*font-size: 16px/);
  assert.match(css, /\.checklist-row\s*\{[\s\S]*min-height: 70px/);
  assert.match(css, /\.checklist-detail-facts\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.notification-channel-grid,[\s\S]*\.notification-rule-grid[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.notification-history-actions[\s\S]*flex-direction: row/);
  assert.match(css, /\.notification-telegram-facts[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.codex-review-controls,[\s\S]*\.codex-review-sources[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('notification and checklist titles wrap without ellipsis', () => {
  const css = read('../src/index.css');
  for (const selector of ['notification-row-title', 'checklist-copy strong']) {
    const escapedSelector = selector.replaceAll(' ', '\\s+');
    const block = css.match(new RegExp(`\\.${escapedSelector}\\s*\\{[^}]*\\}`, 's'))?.[0] || '';
    assert.match(block, /overflow-wrap:\s*anywhere/);
    assert.match(block, /white-space:\s*normal/);
    assert.doesNotMatch(block, /text-overflow:\s*ellipsis/);
    assert.doesNotMatch(block, /overflow:\s*hidden/);
  }
});
