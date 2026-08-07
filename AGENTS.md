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
- User-visible application identities must be understandable, server-owned and
  controller-neutral. Name application containers `<domain-or-app>` and
  supporting bridges `<app>-<service>-bridge`; do not prefix either with
  `foxos` or another controller/provider brand. Never expose migration strategy
  names, provider UUIDs or operation hashes as the primary name. Keep technical
  transaction and controller identity in owner-only state and labels.
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
- The authenticated **Bağlantılar** section is the explicit configuration
  boundary for optional external accounts. Cloudflare is currently the first DNS
  adapter: keep token storage encrypted and owner-only, never return the token,
  keep access-link planning read-only, require the separate confirmed apply,
  recheck DNS drift and preserve exact rollback. It must not become a clean-
  install, startup, paid-plan, proxy or application-authority dependency.
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
  restore, existing healthy Docker health or an explicit bounded candidate-only
  internal HTTP path probed through the host namespace at Docker's observed
  private address, no published candidate host port, source liveness/health
  re-proof and exact cleanup. It must not accept arbitrary health hosts or
  operator commands, databases, bind mounts, unsafe runtime overrides or
  protected resources; stop/recreate the source; change routes/traffic/provider
  state; detach authority; claim off-host recovery; or replay an interrupted
  operation. Do not widen this contract without Burak's explicit approval and
  the remaining persistence gates.
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
  retained previous revision and exact rollback. Do not widen its **apply** path
  to Store apps, imported containers, arbitrary registries, credentials,
  persistence, secrets, routes or real workloads without Burak's explicit
  approval. The separate application update-check path remains read-only and
  must not imply that an unknown result is current.
- Real application updates belong only to `applicationUpdateManager.js`, never
  to the disposable image-update manager. Preserve its exact Compose-label
  source binding, file-revision and runtime drift checks, selected-service plus
  reverse-dependent sidecar graph, previous-image tags, encrypted streaming
  named-volume snapshots, serialized process lock, Compose health wait, public
  endpoint proof and automatic rollback. Reject scaled services, writable bind
  mounts, missing Compose sources, FoxOS core and `/opt/foxos`; do not silently
  broaden the contract to direct containers or host services. Apply and manual
  rollback require their exact confirmations. Provider provenance remains a
  warning because a later provider deployment can overwrite the result until
  migration finishes.
- The application Compose editor is a source-file editor, not a deployment or
  adoption shortcut. Resolve files only from the exact selected container's
  `com.docker.compose.*` labels; reject client-supplied paths, symlinks,
  oversized/non-YAML files, stale revisions, invalid YAML, selected-service
  removal, FoxOS core and `/opt/foxos`. Encrypt the prior content before atomic
  replacement and never persist Compose plaintext in operation records. Saving
  must not run Compose, pull/build an image, recreate/restart a service, detach a
  provider or claim server ownership; warn that an external provider can
  overwrite its file until migration completes.
- The canonical Application Manager inventory includes inactive provider
  application/service/database definitions even when no Docker container is
  present. Keep them truthful: stopped, stable-ID based, off the desktop by
  default and without lifecycle, update, Compose or access-link capabilities
  until a verifiable runtime exists. An explicit shortcut override may expose
  the record on the desktop but must not create or imply a runtime. Never use a
  provider UUID as its visible primary name.
- A completed stateless migration keeps its logical application identity after
  an explicitly cleaned cold source disappears. Registry may fall back only to
  the exact operation-bound, FoxOS-managed candidate; Application Manager must
  retain the operation's logical resource ID and collapse an inactive provider
  definition that declares the same managed domain. Never let source cleanup
  turn a running application into a stopped card or silently drop its desktop
  shortcut.
- The same inventory includes discovered administrator-owned systemd and
  WireGuard host-service records. These resources already belong to the Linux
  server and require no provider migration or FoxOS adoption. Preserve the real
  unit and observed state, keep them off the desktop by default and expose only
  the dedicated fixed systemd start/stop/restart and boot-enable controls. The
  manager must resolve the exact unit from Registry, accept no client command or
  unit path, serialize each resource operation and refresh observation after a
  change. Do not expose Docker lifecycle, update, Compose or access-link
  capability, and never read service contents, WireGuard configuration or keys.
- Keep the disposable stateless lab separate from production. Preserve its
  reviewed image digest, `slab_*` identity, `.foxos.invalid` hostname,
  loopback-only ports, injected-fault rollback and exact run-labeled cleanup;
  it must never accept a real domain or emulate production approval.
- The production stateless adapter is authorized only through the authenticated
  one-click run coordinator and the exact reviewed manifest contract. Preserve
  registry/manifest/image drift binding, encrypted environment resolution,
  constrained no-host-port candidates, operation-scoped dependency bridges,
  FoxOS-owned TLS/route authority, zero-unavailable probes, source continuity
  and automatic rollback. Candidate startup must be reconstructed from a
  verified running executable contract; a process title or provider startup
  wrapper must never be executed blindly. Keep source stop absent before and
  during cutover proof. After verified zero-unavailable completion, FoxOS may
  stop only the exact preserved source as a cold rollback target to avoid
  indefinite duplicate RAM use; rollback must start and prove that exact source
  through the legacy backend before switching traffic. Keep source recreation,
  provider detach, destructive cleanup and separate approve endpoints absent.
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
