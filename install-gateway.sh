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
https_port="${FOXOS_HTTPS_PORT:-$(read_env_value FOXOS_HTTPS_PORT)}"
https_port="${https_port:-8443}"
dns_token="${CLOUDFLARE_API_TOKEN:-}"
secret_path=".foxos-data/gateway/secrets/cloudflare-api-token"
reuse_secret=false

if [[ -z "$domain" ]]; then
  read -r -p "FoxOS HTTPS domain: " domain
fi

if [[ -z "$acme_email" ]]; then
  read -r -p "ACME contact email: " acme_email
fi

if [[ -z "$dns_token" && -s "$secret_path" ]]; then
  reuse_secret=true
elif [[ -z "$dns_token" ]]; then
  read -r -s -p "Cloudflare DNS API token: " dns_token
  echo
fi

if [[ ! "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || [[ "$domain" != *.* ]]; then
  echo "FOXOS_DOMAIN must be a valid DNS hostname." >&2
  exit 1
fi

if [[ ! "$acme_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "FOXOS_ACME_EMAIL must be a valid email address." >&2
  exit 1
fi

if [[ ! "$https_port" =~ ^[0-9]+$ ]] || (( https_port < 1 || https_port > 65535 )); then
  echo "FOXOS_HTTPS_PORT must be between 1 and 65535." >&2
  exit 1
fi

if [[ "$reuse_secret" == false && -z "$dns_token" ]]; then
  echo "The DNS API token cannot be empty." >&2
  exit 1
fi

mkdir -p \
  .foxos-data/gateway/secrets \
  .foxos-data/gateway/caddy-data \
  .foxos-data/gateway/caddy-config
chmod 700 .foxos-data .foxos-data/gateway \
  .foxos-data/gateway/secrets \
  .foxos-data/gateway/caddy-data \
  .foxos-data/gateway/caddy-config

secret_tmp=""
env_tmp=""

cleanup() {
  if [[ -n "$secret_tmp" ]]; then
    rm -f -- "$secret_tmp"
  fi
  if [[ -n "$env_tmp" ]]; then
    rm -f -- "$env_tmp"
  fi
}
trap cleanup EXIT

if [[ "$reuse_secret" == false ]]; then
  secret_tmp="$(mktemp .foxos-data/gateway/secrets/.cloudflare-api-token.XXXXXX)"
  chmod 600 "$secret_tmp"
  printf '%s' "$dns_token" > "$secret_tmp"
  mv -f -- "$secret_tmp" "$secret_path"
  secret_tmp=""
fi
chmod 600 "$secret_path"
unset dns_token CLOUDFLARE_API_TOKEN

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
set_env_value FOXOS_HTTPS_BIND_ADDRESS 0.0.0.0
set_env_value FOXOS_HTTPS_PORT "$https_port"

docker compose -f docker-compose.yml -f docker-compose.gateway.yml up -d --build

echo
echo "FoxOS HTTPS gateway is starting at https://${domain}:${https_port}"
echo "The direct FoxOS agent port remains loopback-only."
