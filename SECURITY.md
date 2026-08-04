# Security

FoxOS is a **privileged server administration panel**. A FoxOS session has
root-equivalent access to the host because the agent can enter host namespaces,
write to the host filesystem, and control the Docker daemon.

## Safe deployment

- Keep the default `127.0.0.1` bind address.
- Reach FoxOS through an SSH tunnel, a private VPN, or an authenticated HTTPS
  reverse proxy.
- Do not publish port `8080` directly to the public internet.
- Use a unique password of at least 10 characters.
- Keep the server, Docker Engine, and FoxOS image up to date.
- Back up files before using terminal or file-management write actions.

When an HTTPS reverse proxy is in place, set `FOXOS_SECURE_COOKIE=true`.

FoxOS also ships an optional, independently managed Caddy gateway. It keeps the
direct agent port on loopback, stores certificate state and the DNS credential
under `.foxos-data/gateway/`, and does not use a Coolify proxy, network, API,
certificate, or container. The included first DNS adapter is Cloudflare DNS-01;
the DNS record must remain **DNS only**, so application traffic connects
directly to the FoxOS-owned gateway.

The DNS credential must be limited to `Zone:Read` and `DNS:Edit` for the single
FoxOS zone. `install-gateway.sh` writes it to an owner-only Docker secret file;
never place it in Git, `.env`, the Caddyfile, command output, or issue reports.

## App Store deployments

App Store applications are separate Docker containers and have their own
security model. Installing one does not automatically place it behind FoxOS
authentication.

- Keep the default **Private** (`127.0.0.1`) exposure unless the application has
  its own authentication or is protected by a trusted reverse proxy or VPN.
- The current store UI installs apps with the **Private** (`127.0.0.1`) bind.
  An authenticated API client that explicitly requests `0.0.0.0` can make the
  chosen port internet-accessible, depending on firewall and provider rules.
- Review the linked upstream project before installing. Catalog images are built
  and maintained by their respective third-party projects.
- Apps that read the Docker socket, such as Dozzle, have elevated visibility into
  the server even when the socket is mounted read-only.
- The uninstall screen preserves named volumes by default. Enabling data removal
  permanently deletes the catalog app's FoxOS-managed volume.

## Resource Registry data

Resource scans use Docker `GET` requests only and must never adopt or mutate a
discovered workload. The registry excludes environment values, arbitrary labels,
proxy middleware values and health-check commands because they may contain
credentials. Only explicitly allowed identity and grouping labels are retained,
and long token-like route path segments are stored only as redacted fingerprints.
Production runs one asynchronous read-only scan at startup unless
`FOXOS_RESOURCE_SCAN_ON_STARTUP=false` is explicitly configured.

Registry files live under `.foxos-data/registry/` with owner-only directory and
file permissions. They still contain operational metadata such as application
names, image references, domains, ports and host storage paths. Protect and back
up this directory as private server administration data. Review a migration-plan
export before sharing it even though secret-bearing fields are excluded.

## Disposable adoption pilot

The first adoption engine is intentionally restricted to disposable lab
containers. It requires both the `foxos-adoption-lab*` name and the explicit
`com.foxos.adoption.disposable=true` label. It rejects protected resources,
Coolify-managed workloads, provider routes, relationships, conflicts,
unclassified environment overrides, command/user/workdir overrides, host
namespaces, privileged mode, added devices/capabilities, non-loopback ports and
unsupported persistence. Do not add the disposable label to a real workload to
bypass these controls.

Planning uses Docker reads only. Apply and rollback require separate exact
confirmation strings. Before stopping the source, FoxOS archives the pilot
volume and restores it into temporary Docker objects, then compares a normalized
content digest. Backup archives and operation files are owner-only under
`.foxos-data/adoption/`; they may still contain application data and must be
treated as sensitive.

The preserved source container is stopped and renamed, not deleted. A rollback
verifies that the active target carries the expected FoxOS resource identity,
removes only that target without deleting its named volume, restores the source
name and state, and verifies health when the source defines a health check. The
pilot is not evidence that databases, live write-heavy volumes, routes, TLS or
secrets are safe to migrate.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Contact the maintainer
privately through the contact method listed on the maintainer's GitHub profile.
