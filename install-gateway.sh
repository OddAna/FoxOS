#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The FoxOS HTTPS gateway currently supports Linux servers only." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker Engine is required and must be accessible to the current user." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  if [[ ! -f .env ]]; then
    return 0
  fi
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env
}

domain="${FOXOS_DOMAIN:-$(read_env_value FOXOS_DOMAIN)}"
acme_email="${FOXOS_ACME_EMAIL:-$(read_env_value FOXOS_ACME_EMAIL)}"
http_port="${FOXOS_HTTP_PORT:-$(read_env_value FOXOS_HTTP_PORT)}"
http_port="${http_port:-80}"
https_port="${FOXOS_HTTPS_PORT:-$(read_env_value FOXOS_HTTPS_PORT)}"
https_port="${https_port:-443}"

if [[ -z "$domain" ]]; then
  read -r -p "FoxOS HTTPS domain: " domain
fi

if [[ -z "$acme_email" ]]; then
  read -r -p "ACME contact email: " acme_email
fi

if [[ ! "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || [[ "$domain" != *.* ]]; then
  echo "FOXOS_DOMAIN must be a valid DNS hostname." >&2
  exit 1
fi

if [[ ! "$acme_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "FOXOS_ACME_EMAIL must be a valid email address." >&2
  exit 1
fi

if [[ ! "$http_port" =~ ^[0-9]+$ ]] || (( http_port < 1 || http_port > 65535 )) ||
   [[ ! "$https_port" =~ ^[0-9]+$ ]] || (( https_port < 1 || https_port > 65535 )); then
  echo "FOXOS_HTTP_PORT and FOXOS_HTTPS_PORT must be between 1 and 65535." >&2
  exit 1
fi

mkdir -p \
  .foxos-data/gateway/caddy-data \
  .foxos-data/gateway/caddy-config \
  .foxos-data/gateway/runtime
chmod 700 .foxos-data .foxos-data/gateway \
  .foxos-data/gateway/caddy-data \
  .foxos-data/gateway/caddy-config \
  .foxos-data/gateway/runtime
touch .foxos-data/gateway/runtime/00-empty.caddy
chmod 600 .foxos-data/gateway/runtime/00-empty.caddy

env_tmp=""

cleanup() {
  if [[ -n "$env_tmp" ]]; then
    rm -f -- "$env_tmp"
  fi
}
trap cleanup EXIT

touch .env
chmod 600 .env

set_env_value() {
  local key="$1"
  local value="$2"
  env_tmp="$(mktemp .env.XXXXXX)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) print key "=" value
    }
  ' .env > "$env_tmp"
  chmod 600 "$env_tmp"
  mv -f -- "$env_tmp" .env
  env_tmp=""
}

set_env_value FOXOS_BIND_ADDRESS 127.0.0.1
set_env_value FOXOS_SECURE_COOKIE true
set_env_value FOXOS_TRUST_PROXY 1
set_env_value FOXOS_DOMAIN "$domain"
set_env_value FOXOS_ACME_EMAIL "$acme_email"
set_env_value FOXOS_HTTP_BIND_ADDRESS 0.0.0.0
set_env_value FOXOS_HTTP_PORT "$http_port"
set_env_value FOXOS_HTTPS_BIND_ADDRESS 0.0.0.0
set_env_value FOXOS_HTTPS_PORT "$https_port"

docker compose \
  -f docker-compose.yml \
  -f docker-compose.gateway.yml \
  -f docker-compose.ingress.yml \
  up -d --build

echo
if [[ "$https_port" == 443 ]]; then
  echo "FoxOS HTTPS gateway is starting at https://${domain}"
else
  echo "FoxOS HTTPS gateway is starting at https://${domain}:${https_port}"
fi
echo "The direct FoxOS agent port remains loopback-only."
