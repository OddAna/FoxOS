#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "FoxOS host management currently supports Linux servers only." >&2
  echo "Docker Desktop on macOS or Windows would manage its VM, not the physical host." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine is required. Install it from https://docs.docker.com/engine/install/ and run this script again." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but the current user cannot access the Docker daemon." >&2
  echo "Run FoxOS with a Docker-enabled user or fix Docker daemon permissions." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi

mkdir -p .foxos-data
chmod 700 .foxos-data

docker compose up -d --build

port="${FOXOS_PORT:-8080}"
echo
echo "FoxOS is running on the server at 127.0.0.1:${port}."
echo "From your computer, create a secure tunnel:"
echo "  ssh -L ${port}:127.0.0.1:${port} <user>@<server-ip>"
echo "Then open http://127.0.0.1:${port}"
