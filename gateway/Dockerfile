ARG CADDY_VERSION=2.11.4

FROM caddy:${CADDY_VERSION}-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/foxos-caddy-entrypoint

RUN mkdir -p /etc/caddy/runtime \
    && touch /etc/caddy/runtime/00-empty.caddy \
    && chmod 0755 /usr/local/bin/foxos-caddy-entrypoint \
    && FOXOS_DOMAIN=foxos.example.com \
       FOXOS_ACME_EMAIL=admin@example.com \
       caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

ENTRYPOINT ["/usr/local/bin/foxos-caddy-entrypoint"]
