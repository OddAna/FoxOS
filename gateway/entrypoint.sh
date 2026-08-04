#!/bin/sh
set -eu

token_file="/run/secrets/cloudflare_api_token"

if [ ! -s "$token_file" ]; then
  echo "FoxOS gateway DNS credential is missing or empty." >&2
  exit 1
fi

CLOUDFLARE_API_TOKEN="$(sed -e 's/[[:space:]]*$//' "$token_file")"
export CLOUDFLARE_API_TOKEN

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "FoxOS gateway DNS credential is empty." >&2
  exit 1
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
