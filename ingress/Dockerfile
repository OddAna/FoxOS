FROM haproxy:3.2.4-alpine3.22@sha256:436a5691e6fd563ca4090e351048fda1066bec93b595cc8eaf26988c65eb1152

USER root

COPY haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg

RUN mkdir -p /runtime \
    && touch /runtime/routes.map \
    && haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
