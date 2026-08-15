#!/usr/bin/env python3
"""Emit and resolve events through the local FoxOS Notification Hub."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_RESPONSE_BYTES = 1_000_000


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
                raise RuntimeError(f"FoxOS notification token permissions are unsafe: {candidate}")
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as error:
            raise RuntimeError(f"FoxOS notification token could not be read: {candidate}") from error
        token = payload.get("token") if isinstance(payload, dict) else None
        if isinstance(token, str) and len(token) == 64 and all(char in "0123456789abcdef" for char in token):
            return token
        raise RuntimeError(f"FoxOS notification token is invalid: {candidate}")
    raise RuntimeError("FoxOS notification token was not found. Start FoxOS before using this skill.")


def foxos_url() -> str:
    value = os.environ.get("FOXOS_URL", "http://127.0.0.1:8080").strip().rstrip("/") + "/"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("FOXOS_URL must be a safe HTTP or HTTPS origin.")
    if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Refusing to send the owner token over non-loopback HTTP. Use HTTPS.")
    return value


def request(path: str, payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    target = urljoin(foxos_url(), path.lstrip("/"))
    http_request = Request(
        target,
        data=body,
        method="POST",
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
        raise RuntimeError(message or f"FoxOS rejected the notification ({error.code}).") from error
    except URLError as error:
        raise RuntimeError("FoxOS Notification Hub is unavailable.") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("FoxOS returned an oversized response.")
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise RuntimeError("FoxOS returned an invalid response.") from error
    if not isinstance(result, dict):
        raise RuntimeError("FoxOS returned an invalid response.")
    return result


def send(args: argparse.Namespace) -> int:
    target = None
    if args.target_app:
        target = {"app": args.target_app}
        if args.target_tab:
            target["tab"] = args.target_tab
        if args.target_date:
            target["date"] = args.target_date
    payload = {
        "source": args.source,
        "category": args.category,
        "severity": args.severity,
        "title": args.title,
        "body": args.body or "",
        "dedupeKey": args.dedupe_key,
        "threadId": args.thread_id,
        "sensitive": args.sensitive,
        "target": target,
    }
    result = request("/api/notifications/ingest", payload)
    notification = result.get("notification", {})
    print(json.dumps({
        "accepted": True,
        "id": notification.get("id"),
        "status": notification.get("status"),
        "occurrenceCount": notification.get("occurrenceCount"),
    }, ensure_ascii=False))
    return 0


def resolve(args: argparse.Namespace) -> int:
    result = request("/api/notifications/ingest/resolve", {
        "source": args.source,
        "dedupeKey": args.dedupe_key,
    })
    notification = result.get("notification", {})
    print(json.dumps({
        "resolved": notification.get("status") == "resolved",
        "id": notification.get("id"),
        "status": notification.get("status"),
    }, ensure_ascii=False))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    emit = commands.add_parser("send", help="Create or update a FoxOS notification")
    emit.add_argument("--source", required=True)
    emit.add_argument("--category", default="system")
    emit.add_argument("--severity", choices=("info", "success", "warning", "critical"), default="info")
    emit.add_argument("--title", required=True)
    emit.add_argument("--body")
    emit.add_argument("--dedupe-key")
    emit.add_argument("--thread-id")
    emit.add_argument("--sensitive", action="store_true")
    emit.add_argument("--target-app")
    emit.add_argument("--target-tab")
    emit.add_argument("--target-date")
    emit.set_defaults(handler=send)

    close = commands.add_parser("resolve", help="Resolve an open notification by dedupe key")
    close.add_argument("--source", required=True)
    close.add_argument("--dedupe-key", required=True)
    close.set_defaults(handler=resolve)
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
