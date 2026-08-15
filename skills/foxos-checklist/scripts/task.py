#!/usr/bin/env python3
"""Manage durable tasks through the local FoxOS Checklist."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_RESPONSE_BYTES = 1_000_000
TASK_ID_PREFIX = "tsk_"


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        return None


def token_candidates() -> list[Path]:
    candidates: list[Path] = []
    explicit = os.environ.get("FOXOS_NOTIFICATION_TOKEN_FILE", "").strip()
    if explicit:
        candidates.append(Path(explicit))
    data_root = os.environ.get("FOXOS_DATA_ROOT", "").strip()
    if data_root:
        candidates.append(Path(data_root) / "notifications" / "ingest-token.json")
    candidates.extend(
        [
            Path("/opt/foxos/.foxos-data/notifications/ingest-token.json"),
            Path("/data/notifications/ingest-token.json"),
        ]
    )
    return candidates


def read_token() -> str:
    for candidate in token_candidates():
        try:
            file_stat = candidate.stat()
            if stat.S_IMODE(file_stat.st_mode) & 0o077:
                raise RuntimeError(f"FoxOS owner token permissions are unsafe: {candidate}")
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as error:
            raise RuntimeError(f"FoxOS owner token could not be read: {candidate}") from error
        token = payload.get("token") if isinstance(payload, dict) else None
        if isinstance(token, str) and len(token) == 64 and all(char in "0123456789abcdef" for char in token):
            return token
        raise RuntimeError(f"FoxOS owner token is invalid: {candidate}")
    raise RuntimeError("FoxOS owner token was not found. Start FoxOS before using this skill.")


def foxos_url() -> str:
    value = os.environ.get("FOXOS_URL", "http://127.0.0.1:8080").strip().rstrip("/") + "/"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("FOXOS_URL must be a safe HTTP or HTTPS origin.")
    if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Refusing to send the owner token over non-loopback HTTP. Use HTTPS.")
    return value


def request(method: str, path: str, payload: dict | None = None, query: dict | None = None) -> dict:
    target = urljoin(foxos_url(), path.lstrip("/"))
    if query:
        target += "?" + urlencode(query)
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    http_request = Request(
        target,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {read_token()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        response = build_opener(NoRedirects()).open(http_request, timeout=10)
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raw = error.read(MAX_RESPONSE_BYTES + 1)
        try:
            message = json.loads(raw.decode("utf-8")).get("error")
        except (UnicodeDecodeError, ValueError, AttributeError):
            message = None
        raise RuntimeError(message or f"FoxOS rejected the checklist operation ({error.code}).") from error
    except URLError as error:
        raise RuntimeError("FoxOS Checklist is unavailable.") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("FoxOS returned an oversized response.")
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise RuntimeError("FoxOS returned an invalid response.") from error
    if not isinstance(result, dict):
        raise RuntimeError("FoxOS returned an invalid response.")
    return result


def validate_task_id(value: str) -> str:
    if not value.startswith(TASK_ID_PREFIX) or len(value) != 36:
        raise RuntimeError("FoxOS task ID is invalid.")
    suffix = value[len(TASK_ID_PREFIX):]
    if any(char not in "0123456789abcdef" for char in suffix):
        raise RuntimeError("FoxOS task ID is invalid.")
    return value


def task_summary(result: dict, action: str) -> dict:
    task = result.get("task") if isinstance(result.get("task"), dict) else {}
    return {
        "action": action,
        "id": task.get("id"),
        "title": task.get("title"),
        "status": task.get("status"),
        "dueAt": task.get("dueAt"),
        "timeZone": task.get("timeZone"),
        "created": result.get("created"),
        "changed": result.get("changed"),
    }


def add(args: argparse.Namespace) -> int:
    if args.due_at and not args.time_zone:
        raise RuntimeError("--time-zone is required when --due-at is used.")
    result = request("POST", "/api/tasks/ingest", {
        "title": args.title,
        "notes": args.notes or "",
        "dueAt": args.due_at,
        "timeZone": args.time_zone or "UTC",
        "source": args.source,
        "externalKey": args.external_key,
        "sensitive": args.sensitive,
    })
    print(json.dumps(task_summary(result, "created" if result.get("created") else "deduplicated"), ensure_ascii=False))
    return 0


def list_tasks(args: argparse.Namespace) -> int:
    result = request("GET", "/api/tasks/ingest", query={"status": args.status, "limit": args.limit})
    print(json.dumps({
        "items": result.get("items", []),
        "stats": result.get("stats", {}),
        "updatedAt": result.get("updatedAt"),
    }, ensure_ascii=False))
    return 0


def update(args: argparse.Namespace) -> int:
    payload: dict[str, object] = {}
    for key, value in (
        ("title", args.title),
        ("notes", args.notes),
        ("dueAt", args.due_at),
        ("timeZone", args.time_zone),
    ):
        if value is not None:
            payload[key] = value
    if args.clear_due:
        payload["dueAt"] = None
    if not payload:
        raise RuntimeError("Provide at least one task field to update.")
    result = request("PATCH", f"/api/tasks/ingest/{validate_task_id(args.id)}", payload)
    print(json.dumps(task_summary(result, "updated"), ensure_ascii=False))
    return 0


def transition(args: argparse.Namespace) -> int:
    task_id = validate_task_id(args.id)
    result = request("POST", f"/api/tasks/ingest/{task_id}/{args.command}", {})
    print(json.dumps(task_summary(result, args.command), ensure_ascii=False))
    return 0


def snooze(args: argparse.Namespace) -> int:
    task_id = validate_task_id(args.id)
    if args.until:
        until = args.until
    else:
        until = (datetime.now(timezone.utc) + timedelta(hours=args.hours)).isoformat().replace("+00:00", "Z")
    result = request("POST", f"/api/tasks/ingest/{task_id}/snooze", {"until": until})
    print(json.dumps(task_summary(result, "snoozed"), ensure_ascii=False))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    create = commands.add_parser("add", help="Create or deduplicate a FoxOS task")
    create.add_argument("--title", required=True)
    create.add_argument("--notes")
    create.add_argument("--due-at")
    create.add_argument("--time-zone")
    create.add_argument("--source", default="codex")
    create.add_argument("--external-key")
    create.add_argument("--sensitive", action="store_true")
    create.set_defaults(handler=add)

    listing = commands.add_parser("list", help="List FoxOS tasks")
    listing.add_argument("--status", choices=("open", "completed", "all"), default="open")
    listing.add_argument("--limit", type=int, choices=range(1, 501), default=100, metavar="1..500")
    listing.set_defaults(handler=list_tasks)

    edit = commands.add_parser("update", help="Update an exact FoxOS task")
    edit.add_argument("--id", required=True)
    edit.add_argument("--title")
    edit.add_argument("--notes")
    edit.add_argument("--due-at")
    edit.add_argument("--time-zone")
    edit.add_argument("--clear-due", action="store_true")
    edit.set_defaults(handler=update)

    for name in ("complete", "reopen"):
        action = commands.add_parser(name, help=f"{name.title()} an exact FoxOS task")
        action.add_argument("--id", required=True)
        action.set_defaults(handler=transition)

    delay = commands.add_parser("snooze", help="Move an open task reminder")
    delay.add_argument("--id", required=True)
    choice = delay.add_mutually_exclusive_group(required=True)
    choice.add_argument("--until")
    choice.add_argument("--hours", type=int, choices=range(1, 721), metavar="1..720")
    delay.set_defaults(handler=snooze)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        return args.handler(args)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
