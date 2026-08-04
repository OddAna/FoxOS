ARG CADDY_VERSION=2.11.4

FROM caddy:${CADDY_VERSION}-builder-alpine AS builder

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    xcaddy build \
      --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:${CADDY_VERSION}-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/foxos-caddy-entrypoint

RUN chmod 0755 /usr/local/bin/foxos-caddy-entrypoint \
    && FOXOS_DOMAIN=foxos.example.com \
       FOXOS_ACME_EMAIL=admin@example.com \
       CLOUDFLARE_API_TOKEN=validation-only \
       caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

ENTRYPOINT ["/usr/local/bin/foxos-caddy-entrypoint"]
