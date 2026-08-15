# FoxOS notification event schema

## Event fields

| Field | Required | Rule |
| --- | --- | --- |
| `source` | Yes | Stable lowercase identifier, up to 64 characters. |
| `category` | No | Stable lowercase category; defaults to `system`. |
| `severity` | No | `info`, `success`, `warning`, or `critical`; defaults to `info`. |
| `title` | Yes | Concise, actionable, up to 140 characters. |
| `body` | No | Supporting context, up to 2,000 characters. Never include secrets or raw logs. |
| `dedupeKey` | Recommended | Stable condition identity, up to 180 characters. |
| `threadId` | No | Groups related but distinct conditions, up to 180 characters. |
| `sensitive` | No | When true, every external adapter receives a generic redacted summary. |
| `target` | No | Bounded FoxOS destination with `app`, optional `tab`, and optional ISO date. |

Slugs accept lowercase ASCII letters, numbers, `.`, `_`, and `-`. They must start with a letter or number.

## Delivery semantics

- FoxOS persists the in-app event before attempting any external channel.
- Reusing `source + dedupeKey` updates the unresolved event, returns it to unread, and increments `occurrenceCount`.
- Resolving by `source + dedupeKey` closes the current condition without deleting its history.
- Source thresholds, quiet hours, critical override, and channel subscriptions are owner settings. Agents must not bypass them.
- Telegram is a FoxOS-owned delivery adapter. Agents submit only the normalized event and never handle its bot token, paired chat, pause state, or commands.
- External delivery is best effort. Consult delivery receipts in FoxOS instead of inferring delivery from API acceptance.

## Targets

Use these built-in app values when relevant:

- `settings`, optionally with `notifications`, `connections`, or another settings tab
- `calendar`, optionally with `date` in `YYYY-MM-DD`
- `weather`
- `server`
- `files`
- `codex`
- `store`

An installed application's FoxOS identity may also be used as `target.app`.
