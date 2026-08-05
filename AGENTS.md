# FoxOS repository rules

## Release boundary

- `main` is the stable public installation branch. Do not commit or push daily
  development directly to `main`.
- `develop` is the integration branch for the 46-prefixed development server.
  Start ordinary work here; use `feature/*` branches from `develop` when a task
  needs isolation.
- Merge `develop` into `main` only when Burak explicitly requests a release and
  the complete validation suite passes.
- Published version tags are immutable. `v0.0.1` is frozen at its released
  commit and must never be force-moved again.
- Do not change the package/README version from `0.0.1` until Burak explicitly
  chooses the next release version.
- Public users update deliberately from a stable release. Never introduce a
  forced or silent updater.

## Interface boundary

- Preserve the recovered original FoxOS Store, Window, Dock and desktop visual
  language. Do not invent a replacement theme or redesign it without Burak's
  explicit instruction.
- Do not use frontend/design skills as aesthetic authorities for FoxOS.
- Functional additions must fit the existing interface and reuse its current
  visual tokens and interaction patterns.

## Server ownership boundary

- FoxOS is the server-owned source of truth for applications, service
  relationships, deployment revisions, domains, routes, TLS policy,
  environment configuration, secret references, persistence, backups and
  recovery metadata.
- FoxOS has zero Coolify runtime dependency. A clean installation and normal
  host management, authentication, deployment, routing, TLS, storage, backup
  and recovery path must not require Coolify APIs, databases, proxy, networks,
  files or containers.
- Coolify and similar control panels are optional migration readers only. Their
  labels, databases, APIs and proxy configuration may be read to rescue an
  existing resource, but this integration must be removable and disabled by
  default. It is never part of the FoxOS core or HTTPS path.
- Provider imports must produce a provider-neutral FoxOS manifest stored on the
  server. Preserve import provenance for audit and rollback, not as the active
  authority.
- Never mark a discovered resource as FoxOS-owned automatically. Adoption must
  be explicit, conflict-checked, backed up, reversible and verified before the
  external provider is detached.
- The current adoption implementation is a disposable-only pilot. Do not widen
  its `foxos-adoption-lab*` name gate, explicit disposable label, loopback port,
  read-only single-volume policy or Coolify rejection without Burak's explicit
  approval and the missing safety gates in `ROADMAP.md`.
- The current route manager is likewise a fixed disposable pilot: it may publish
  only `/_foxos/apps/foxos-adoption-lab/` through FoxOS Caddy and may connect
  only the verified FoxOS-managed target to the labeled `foxos-routing`
  network. Do not make provider proxy/network state part of this path.
- External registrars, certificate authorities, Git hosts, registries and DNS
  APIs are replaceable adapters. FoxOS must keep the desired state and recovery
  information locally so changing an adapter does not erase resource truth.
- A clean public installation must require no external provider account, domain,
  API token, object store, payment method or existing panel. Base startup and
  ordinary host management must work with recovery explicitly unconfigured.
- Never make an installer create, subscribe to or enable a remote or billable
  service. `S3-compatible` is a provider-neutral protocol adapter, not an AWS,
  Cloudflare or other vendor dependency; external backup configuration must be
  explicit and removable.
- The source deployment implementation is also a disposable-only pilot. Keep the
  fixed `foxos-deployment-lab` identity, public credential-free HTTPS Git input,
  commit/context/Dockerfile pinning, digest-pinned base images, networkless and
  secretless build, dynamic loopback candidate, health-before-cutover and exact
  rollback gates. Do not widen it to private Git, arbitrary containers, ports,
  build mounts, general Compose/build packs, persistence or real workloads without
  Burak's explicit approval and the remaining roadmap gates.
- The workload-evidence path is separate from source deployment. It may capture
  source only for a running, fully inspected provider-owned stateless
  application, use a credential-free or encrypted-credential HTTPS Git adapter,
  and store an authenticated encrypted local source archive. GET-only
  environment capture also accepts the corresponding stateful application
  class. This evidence never proves source-to-runtime image binding,
  starts/builds/stops a workload, changes a route, adopts/detaches a provider or
  authorizes cutover.
- The stateful-rehearsal path is a separate narrow proof for running, fully
  inspected provider-owned stateful applications. Preserve explicit
  persistent/empty classification for every writable named volume, exact plan
  and run confirmations, pre-pause drift checks, persisted pause intent,
  immediate unpause, authenticated local encryption, exact-image temporary
  restore, internal-network/dynamic-loopback candidate health proof, source
  health re-proof and exact cleanup. It must not accept databases, bind mounts,
  unsafe runtime overrides or protected resources; stop/recreate the source;
  change routes/traffic/provider state; detach authority; claim off-host
  recovery; or replay an interrupted operation. Do not widen this contract
  without Burak's explicit approval and the remaining persistence gates.
- The approved Compose extension is a second fixed disposable pilot. Preserve
  the `foxos-compose-lab` identity, public-Git manifest/commit/context pinning,
  two-or-three-service connected DAG, source-build-only services, no
  environment/secrets/volumes/host access/provider networks, isolated project
  bridge, loopback-only ingress, serial queue, safe cancellation checkpoints,
  health-before-group-cutover and full-group rollback. Do not reinterpret this
  as permission for arbitrary Compose, persistence, private Git, build packs,
  real routes or production workloads.
- The controlled image update implementation is a third fixed disposable pilot.
  Preserve the `foxos-image-update-lab` identity, reviewed
  `traefik/whoami:v1.10.3` and `v1.11.0` tag/digest set, registry revalidation,
  immutable digest pull, non-root/read-only/capability-free runtime, fresh
  dedicated bridge, loopback-only port, health-before-cutover, process lock,
  retained previous revision and exact rollback. Do not widen it to Store apps,
  imported containers, arbitrary registries, credentials, persistence, secrets,
  routes or real workloads without Burak's explicit approval and the missing
  safety gates in `ROADMAP.md`.
- Read `ARCHITECTURE.md` before changing discovery, deployment, domains,
  secrets, persistence, backup or migration behavior.

## Development and deployment

- The development server checkout under `/opt/foxos` tracks `develop`; it is not
  the stable channel used by public installations.
- Before a release, run backend tests and syntax checks, frontend lint/build,
  Compose and shell validation, version scans, production image build, and
  browser interaction QA proportional to the change.
- CI must prove the base Compose install becomes healthy without `.env`, DNS,
  Cloudflare or S3 credentials and reports external recovery as unconfigured.
- Preserve existing Docker applications, volumes, authentication data and
  server configuration during development deployments. Never take ownership of
  an externally managed container merely because FoxOS discovers it.
