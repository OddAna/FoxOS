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
- Base `install.sh` must never create a provider account, bucket, subscription,
  DNS record or other remote/billable resource. External adapters require a
  separate explicit operator action.

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
This optional gateway is not invoked by the base installer.

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

## Disposable source deployment pilot

Treat every Git repository and Dockerfile as untrusted code. The implemented
source path is restricted to the fixed `foxos-deployment-lab`; it must not be
pointed at a production application.

- Only credential-free public HTTPS Git URLs are accepted. Local/private
  addresses, redirects, URL credentials, submodules and non-HTTPS transports
  are rejected.
- The plan pins the exact commit, complete context digest and Dockerfile digest.
  Apply clones again and fails closed if any of them changed.
- Contexts are bounded and cannot contain symlinks. Every `FROM` image must be
  digest-pinned; `ADD`, `RUN --mount`, build secrets and SSH forwarding are
  rejected.
- Docker build networking is disabled. No secret/environment revision is
  injected. Build response size, runtime, stored log length and log line length
  are bounded, and common credential forms are redacted.
- Candidates bind only to a Docker-assigned `127.0.0.1` port and receive memory,
  CPU and PID limits plus `no-new-privileges`. They are verified before the
  previous canary is stopped.
- Plan, apply and rollback have separate exact confirmation strings. Only
  containers with the fixed FoxOS resource/disposable labels can participate.
- Deployment state/logs under `.foxos-data/deployments/` are owner-only and may
  still reveal repository names, commits, build steps and image metadata.

This is a transactional safety proof, not a general multi-tenant build service.
Private Git, webhooks, arbitrary ports, general Compose/build packs,
persistence, domains and real workload updates remain unsupported.

## Disposable Compose deployment pilot

The separate `foxos-compose-lab` path is a strict service-graph proof, not a
general Compose runner. FoxOS parses the YAML and creates Docker resources from
its own normalized plan; it never executes the submitted manifest with the
Compose CLI.

- Only two or three source-built services are accepted. Every service must be
  reachable from one ingress through an acyclic dependency graph.
- Images, environment, secrets, build args, commands, entrypoints, published
  ports, volumes, configs, custom/provider networks, host namespaces, devices,
  capabilities and privilege settings are rejected.
- Every service context passes the public-Git commit/context/Dockerfile drift
  gates. Builds receive no network or secrets and require digest-pinned bases.
- Candidate containers use a fresh isolated bridge, read-only root filesystem,
  dropped capabilities, `no-new-privileges`, bounded tmpfs and CPU/memory/PID
  limits. Only the ingress receives a dynamic `127.0.0.1` host port.
- The project bridge is isolated from existing Docker/provider networks but it
  permits ordinary outbound traffic. Do not treat this pilot as an egress
  sandbox for untrusted code.
- The persisted serial queue supports immediate queued cancellation and
  cooperative running cancellation only before cutover. A process restart
  marks a running job interrupted for inspection rather than replaying it.
- Health-gated cutover preserves the complete previous group. Rollback verifies
  fixed group/service labels and restores every service in dependency order.
- `.foxos-data/compose-deployments/` is owner-only but contains repository,
  commit, graph, image, operation, job and bounded build-log metadata.

Private Git, environment/secrets, persistence, build packs, webhooks, parallel
workers, arbitrary routes and real workloads remain outside this boundary.

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
disconnects it from the FoxOS-owned internal routing network, verifies that the
public HTTPS pilot path no longer serves the app, removes only that target
without deleting its named volume, restores the source name and state, and
verifies health when the source defines a health check.

The fixed pilot route uses only `foxos-gateway`, the `foxos-routing` internal
network and owner-only route records under `.foxos-data/routes/`. The target is
connected with a fixed alias only after Docker health succeeds. FoxOS accepts
the cutover only after a browser-trusted TLS request returns the expected route
identity. Neither apply nor rollback joins or edits a provider proxy or network.
This narrow proof is not evidence that arbitrary domains, databases, live
write-heavy volumes or secrets are safe to migrate.

## Reporting a vulnerability

Do not publish exploitable details in a public issue. Contact the maintainer
privately through the contact method listed on the maintainer's GitHub profile.
