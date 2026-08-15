---
name: foxos-notifications
description: Create, update, deduplicate, and resolve actionable notifications in the server-owned FoxOS Notification Hub. Use when an agent, scheduled task, application, health check, report, reminder, or background workflow needs to alert the FoxOS owner, surface a meaningful result, report a failure or recovery, or request attention without depending on Telegram, Sofia, email, or another delivery channel.
---

# FoxOS Notifications

Emit normalized events to FoxOS. Let the owner's central rules decide whether the event stays in the menu-bar Notification Center or also reaches Web Push, Telegram, and future adapters.

## Decide whether to notify

- Notify for actionable changes, failures, approaching deadlines, explicit reminders, and results the user asked to receive.
- Keep routine healthy/no-op checks silent unless the user explicitly requested visible confirmation.
- Never put secrets, credentials, raw logs, full transcripts, provider tokens, or private identifiers in a notification.
- Mark sensitive summaries with `--sensitive`; FoxOS then redacts every external channel body.
- Never call Telegram, Web Push, email, or a provider adapter directly. Never request or store a bot token or chat ID; the owner manages channels in **Ayarlar → Bildirimler**.
- Prefer one concise notification with a precise FoxOS target over a long report.

## Choose severity

- Use `info` for neutral developments and reminders.
- Use `success` for a requested operation that completed.
- Use `warning` when attention is needed but service remains usable.
- Use `critical` only for urgent loss, outage, security, or time-sensitive failure.

## Emit or update

Always choose a stable lowercase `source`. Use a stable `dedupe-key` for any condition that can recur. Reusing the same `source + dedupe-key` updates the existing open notification and increments its occurrence count instead of creating noise.

Run:

```bash
python3 scripts/notify.py send \
  --source backups \
  --category recovery \
  --severity warning \
  --title "Yedekleme gecikti" \
  --body "Son başarılı yedek 18 saat önceydi." \
  --dedupe-key backup-late \
  --target-app settings \
  --target-tab notifications
```

Resolve the same condition after recovery:

```bash
python3 scripts/notify.py resolve --source backups --dedupe-key backup-late
```

Use paths relative to this skill directory. The script discovers the owner-only FoxOS ingest token locally. Set `FOXOS_URL` only when FoxOS does not listen on `http://127.0.0.1:8080`; never place the token in a prompt or command output.

## Report the result

State whether FoxOS accepted, updated, or resolved the notification. Do not claim that every external device received it; delivery receipts belong to **Ayarlar → Bildirimler**.

Read [references/event-schema.md](references/event-schema.md) only when choosing fields, targets, deduplication behavior, or handling an API validation failure.
