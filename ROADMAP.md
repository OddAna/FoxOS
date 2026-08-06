# FoxOS roadmap

FoxOS already provides host visibility, Docker inventory and lifecycle control,
server files, terminal access, and a real application Store. The following work
is required before Coolify can be removed from the development host without
losing deployment, routing, recovery or operational capabilities.

## Product contract

FoxOS must own the desired state on the server. Applications, dependencies,
deployment revisions, domains, routes, TLS policy, environment configuration,
secret references, storage, backups and recovery metadata must survive the
removal of Coolify or any other imported provider. Providers may discover,
import, export or apply information, but they must never remain the only source
of truth after adoption. See `ARCHITECTURE.md`.

FoxOS core and its public HTTPS path have zero Coolify dependency. Optional
Coolify discovery exists only to rescue legacy workloads and must be removable
without changing FoxOS behavior.

Every release candidate must also pass a clean-install check with no `.env`,
domain, Cloudflare/DNS token, S3-compatible target, provider account or payment
method. The base installer must never create or enable a remote/billable
resource. External services are opt-in adapters; absence of an off-host backup
target blocks only adoption/migration operations that require restore proof.

## Ordered implementation milestones

1. **Resource registry and ownership audit** — create the provider-neutral,
   versioned server-side manifest model; inventory Docker and Coolify resources
   without mutation; persist redacted snapshots; classify resources as
   observed, import-draft, FoxOS-owned or independent.
2. **Reversible adoption of one disposable application** — build a dry-run,
   conflict report, local manifest, data backup, health proof and rollback for
   one test resource before touching a real workload.
3. **FoxOS-owned routes and TLS** — introduce the independent proxy, local route
   records and certificate lifecycle; cut over the disposable application while
   preserving immediate rollback.
4. **Secrets, persistence and recovery** — encrypted local secret references,
   volume/bind inventory, off-host backup and tested restore become adoption
   gates rather than optional follow-up work.
5. **Source build and deployments** — Git/image inputs become replaceable
   adapters feeding FoxOS-owned revisions, build logs, health gates and rollback.
6. **Resource-by-resource Coolify migration** — import and adopt production
   resources through the common automatic engine, one at a time for isolation;
   retire Coolify only after the final independence audit passes and destructive
   cleanup is separately approved.

### Milestone 1 progress: Resource Registry v1

- [x] Read containers, images, networks, volumes and container inspections using
  Docker `GET` requests only.
- [x] Normalize provider, role, runtime, ports, routes, mounts, networks, health,
  restart policy and safe provenance into provider-neutral resource records.
- [x] Assign stable local FoxOS resource IDs through hashed identity aliases.
- [x] Persist schema-versioned latest/revision snapshots atomically with
  owner-only permissions and bounded revision retention.
- [x] Exclude environment values, arbitrary labels, middleware credentials,
  health-check commands and token-like route segments from snapshots/exports.
- [x] Report ownership stage, adoption blockers, resource relationships and
  route/port/storage conflicts through authenticated scan/read/export APIs.
- [x] Define the separate desired-state manifest and import-draft schema used by
  an adoption plan, with immutable image input and provider-neutral desired
  runtime state.
- [x] Expose the read-only whole-server scan in the existing Settings window
  without changing its visual language; keep every repeated instance separate,
  show class/authority/routes/storage/blockers, and persist only eligible
  snapshot-bound intent on the server.

### Milestone 2 progress: Disposable Adoption v1

- [x] Require an explicitly named and labeled disposable resource; reject
  Coolify-managed and protected resources.
- [x] Produce a deterministic, versioned manifest and dry-run plan using Docker
  reads only, without persisting environment or secret values.
- [x] Reject drift, unresolved environment/command overrides, routes,
  relationships, conflicts, dangerous runtime access and unsupported storage.
- [x] Pin the adopted runtime to the observed repository digest.
- [x] Archive the pilot named volume and verify an actual restore before runtime
  mutation.
- [x] Preserve the source container, health-gate the FoxOS target and provide an
  exact-confirmation rollback to the original source.
- [x] Attempt automatic source restoration when target health verification
  fails.
- [ ] Add the reviewed adoption flow to the existing FoxOS interface without
  changing its visual language.
- [ ] Expand beyond the disposable static-volume policy only after encrypted
  secrets, database-aware consistency and route/TLS cutover exist.

### Milestone 3 progress: FoxOS-owned route cutover

- [x] Store a schema-versioned, provider-neutral route record under the FoxOS
  data root for the disposable pilot.
- [x] Route the disposable pilot through FoxOS Caddy on the existing
  browser-trusted certificate without a Coolify proxy, network, API or label.
- [x] Attach only the FoxOS-managed target to an internal FoxOS-owned routing
  network and verify the public HTTPS response before completing apply.
- [x] Disconnect the route, prove the public path is unavailable and restore the
  preserved source during rollback.
- [x] Generalize the fixed pilot path into conflict-checked domain/path records
  for normal stateless applications through FoxOS Caddy and HAProxy.

### Milestone 4 progress: Secrets, persistence and recovery gate

- [x] Create owner-only local encryption state and authenticated AES-256-GCM
  envelopes for secret revisions, backup-adapter credentials and archives.
- [x] Separate ordinary environment values from encrypted, revision-pinned
  secret references and inject values only while creating the target runtime.
- [x] Keep secret values out of registry snapshots, manifests, plans, operation
  records, list/status APIs and CLI output.
- [x] Require an off-host S3-compatible HTTPS target before a disposable plan
  can become ready.
- [x] Encrypt before local persistence/upload, then HEAD, download, digest-check,
  authenticate, decrypt and restore the downloaded object before source stop.
- [ ] Add scheduled retention, independently protected recovery-key export,
  database-consistent snapshots and full-machine disaster restore.

### Milestone 5 progress: Disposable Source Deployment v1

- [x] Resolve a credential-free public HTTPS Git branch/tag without a provider
  API and pin the exact commit, context digest and Dockerfile digest.
- [x] Enforce the first reviewed Dockerfile subset: digest-pinned bases, bounded
  context, no symlinks, `ADD`, build mounts, secrets or build network.
- [x] Persist FoxOS-owned immutable revisions, plans, bounded redacted build
  logs, image IDs, operation history and the current deployment pointer.
- [x] Start a resource-limited candidate on a dynamic loopback port and prove
  HTTP status/body before stopping the active disposable canary.
- [x] Preserve the previous healthy container and restore/re-prove it through an
  exact-confirmation rollback.
- [x] Keep the pilot fixed to `foxos-deployment-lab`; exclude its active and
  history containers from Store discovery and never touch Coolify/real workloads.
- [x] Parse a second fixed `foxos-compose-lab` manifest into a strict connected
  two-or-three-service DAG; build every service and keep provider networks,
  volumes, environment, secrets and host access outside the accepted subset.
- [x] Persist a serial deployment queue with queued cancellation, cooperative
  pre-cutover cancellation, restart interruption records and bounded history.
- [x] Start dependencies on a fresh isolated bridge, health-gate only the
  loopback ingress, preserve the complete previous group and roll it back in
  dependency order.
- [x] Resolve the first reviewed image tags to registry digests, revalidate at
  apply, pull by immutable reference, health-gate a constrained candidate and
  restore the preserved previous image through exact rollback.
- [x] Add read-only private Git evidence capture through encrypted scoped
  credentials and an authenticated server-local source archive.
- [ ] Use private Git credentials in the health-gated deployment transaction;
  read-only source capture is not deployment approval.
- [ ] Add webhook triggers and reviewed build-pack workflows; general Compose,
  persistence and production workloads remain separate gates.

## Stable release system

- [x] Freeze public `main` separately from ongoing development.
- [x] Use `develop` for the dedicated development server.
- [x] Keep published tags immutable.
- [ ] Publish a GitHub Release for each approved version.
- [ ] Add opt-in `Stable` and `Preview` update channels with release notes,
  preflight checks, data preservation and rollback; never force updates.

## Declarative resources and migration

- [x] Add Application Manifest v1 with immutable OCI input, runtime constraints,
  domains/TLS route references, classified environment revision, encrypted
  secret references, persistence/recovery policy, dependencies, health evidence
  and update/rollback proof.
- [x] Compile the existing Docker/Compose/Coolify resource graph into redacted,
  provider-neutral import drafts without copying secret values, mutating the
  runtime or taking ownership.
- [x] Extend the manifest source model from immutable OCI images to FoxOS-owned
  source-build and Compose deployment revisions.
- [x] Classify every observed resource on separate deterministic workload-role,
  state and authority axes, with stable revisions, reason codes and fail-closed
  unknown states while keeping every manageable instance addressable.
- [x] Produce owner-only read-only independence audits for real provider-owned
  stateless application candidates. Audits reuse manifest gates and explicitly
  approve neither runtime apply nor provider detachment.
- [x] Capture a real stateless workload's private/public Git revision as an
  authenticated encrypted local archive and its observed environment as a
  drift-checked local revision without runtime, route or provider mutation.
- [x] Attach a matching real stateful application's same-host restore rehearsal
  to its Application Manifest while keeping off-host recovery and external
  authority blocking.
- [x] Materialize that authenticated point-in-time proof as a separately
  identified, persistent FoxOS-owned shadow with its own volumes, internal-only
  network, resilient restart policy, explicit limits and current health proof,
  without source mutation, route, traffic cutover or provider detachment.
- [x] Add Resource Migration Orchestrator v1 planning: compile the whole latest
  registry through the existing Application Manifest gates; select class-based
  strategies and availability policies; keep observed relationships as
  non-ordering coordination hints; separate authority, evidence and
  implementation blockers; persist deterministic owner-only redacted plans;
  and expose authenticated API/CLI with no apply or runtime mutation path.
- [x] Add the stateless migration transaction core: bind one evidenced
  blue/green resource to a deterministic review plan; require one-time FoxOS UI
  approval; model separate candidate, health, route/TLS staging, atomic switch,
  zero unavailable samples, exact rollback and operation-owned cleanup; persist
  allowlisted redacted proofs; and keep approval inside the authenticated
  server-run coordinator rather than exposing a separate approve endpoint.
- [x] Prove the transaction against real Docker in an explicitly disposable
  lab: create a constrained candidate, stage an operation-scoped TLS route,
  switch atomically under a continuous availability/identity probe, preserve
  exact source runtime continuity, roll back explicitly, inject one unavailable
  sample, roll back automatically and remove every operation-owned object.
  The lab remains isolated from production domains and cannot authorize a live
  migration.
- [x] Compile a normal evidence-ready stateless OCI Application Manifest into a
  deterministic production candidate specification and arbitrary FoxOS-owned
  domain/path/TLS authority review contract. Bind every observed route to its
  exact private port, keep environment values out of the plan, require an
  explicit browser-trusted certificate adapter selection, and keep certificate
  and DNS implementations replaceable.
- [x] Keep the authenticated API and standalone CLI on the same read-only
  planning/compiler context. Status inspection stays lazy and does not contact
  Docker, create encryption state or recover operations. The later UI run
  coordinator does not change this standalone CLI/planning boundary.
- [x] Add the read-only Settings scan and server-authoritative selection layer:
  classify all observed resources, distinguish safe stateless preparation
  candidates from evidence-complete execution readiness, allow candidates to be
  selected while their missing evidence remains visible, invalidate saved
  selections after snapshot drift, and expose no apply, approval, source-stop
  or provider-detach action.
- [x] Add the reviewed FoxOS interface for health target, applied runtime
  defaults, every route and replaceable certificate adapter selection. Persist
  only the allowlisted configuration on the server, bind it to the exact
  snapshot/resource/manifest/execution contract, and invalidate it on drift.
- [x] Replace the user-visible selection-save action with one authenticated
  `Geçişi Başlat` run. Persist/revalidate its exact selection and snapshot
  internally, preflight every selected member before mutation, order only by
  explicit dependencies, execute ready resources serially, and issue a
  short-lived one-time in-memory grant per resource. Blocked runs execute zero
  resources; source stop, provider detach and destructive cleanup remain absent.
- [x] Implement and inject the provider-neutral production Docker/route/TLS
  adapter: exact-image candidate creation, encrypted environment resolution,
  operation-scoped dependency bridges, FoxOS routing plus egress networks,
  browser-trusted certificate import, Caddy route staging, HAProxy domain
  switching, reversible host ingress, public identity probes and rollback.
- [x] Reconstruct candidate startup from a verified live executable and working
  directory instead of trusting mutable PID1 process titles. Support the
  provider-neutral Next standalone runtime directly, fail closed on unsupported
  titles before traffic mutation, and preserve bounded adapter failure codes in
  the run record without secrets.
- [x] Replace the single immediate production-candidate HTTP probe with a
  bounded 30-second readiness window that accepts the reviewed `200-399`
  response range, persists value-free attempt/exit/OOM diagnostics and retains
  the failed transaction's exact operation ID in the parent migration run.
- [x] Discover credential-free local HTTP targets from existing Docker health
  checks without persisting commands or credentials; bind their private port
  and path through source, candidate, staged-route, cutover and rollback proof
  while leaving the public application route unchanged.
- [x] Complete fresh UI-authorized production stateless migrations and
  record source continuity, zero unavailable samples, rollback availability and
  unchanged non-selected workloads before calling the live boundary complete.
- [x] Remove indefinite duplicate RAM use after successful stateless cutover:
  keep the source running through all availability proofs, then park only the
  exact preserved source container as a cold rollback target. Rollback starts
  and proves the legacy backend before switching traffic; no source record,
  image, provider network or rollback evidence is deleted.
- [x] Replace opaque `foxos-stateless-<operation>` production names with
  controller-neutral `<domain-or-app>` identities. Prefer reviewed public
  domains, fall back to a clear service name for temporary previews, and retain
  migration identifiers only as internal evidence. Supporting bridges follow
  `<app>-<service>-bridge`; neither application nor helper name carries a FoxOS
  or provider prefix.
- [x] Reconcile public ingress against the firewall backend that owns Docker's
  active NAT chain so a provider restart cannot silently put migrated domains
  back behind the legacy proxy; reassert recorded authority on agent startup.
- [ ] Expand the implemented disposable dry-run, conflict detection, verified
  cutover and reversible rollback to real application classes one safety gate at
  a time.

## Git source, build and deployment

- [x] Connect credential-free public Git repositories through the generic HTTPS
  deployment adapter and support scoped encrypted private credentials in the
  separate read-only workload-evidence adapter.
- [ ] Extend the health-gated deployment transaction itself to private Git.
- [x] Support exactly confirmed manual branch/tag deployments for the disposable
  canary; webhook-driven deployment remains open.
- [x] Support the first restricted Dockerfile workflow and a separate strict
  disposable Compose source-build graph; general Compose and build packs remain open.
- [x] Store bounded redacted logs, status, retained history and a persistent
  serial queue with safe cancellation checkpoints; parallel workers remain open.
- [x] Health-gate candidate deployment and exact rollback to the previous healthy
  disposable revision; general rolling deployment remains open.
- [x] Add the fixed disposable proof for controlled image update, digest pinning
  and exact rollback.
- [ ] Generalize the proven image transaction to FoxOS-managed applications only
  after their persistence, secret, route and recovery manifests are complete.

## Environment and secrets

- [x] Store secrets encrypted at rest with strict file permissions and scoped
  runtime injection.
- [x] Mask secrets in API responses, local records, plans, exports and
  diagnostics used by the disposable pilot.
- [x] Separate ordinary environment variables from secrets and pin immutable
  secret/environment revisions.
- [x] Capture a candidate workload's Docker environment through a value-free,
  keyed plan; recheck drift and persist sensitive names only as encrypted secret
  references without changing the source container. Provider-injected runtime
  metadata is classified as excluded rather than copied into desired state.
  This read-only evidence path covers fully inspected provider-owned stateless
  and stateful applications; persistence and cutover authority do not expand.
- [ ] Add reviewed import/rotation controls to the existing FoxOS interface.
- [x] Prevent secret leakage through container discovery or repository manifests.

## Domains, proxy and TLS

- [x] Add the first FoxOS-owned control-panel gateway: an isolated Caddy service,
  provider-neutral HTTP-01 certificate issuance/renewal, owner-only persistent TLS state, secure
  cookies and a loopback-only direct agent port. It does not use the Coolify
  proxy, API, network, labels or certificate store.
- [x] Manage arbitrary observed domains and path routes for eligible stateless
  migrations through FoxOS-owned Caddy.
- [x] Detect observed domain and port collisions before migration.
- [x] Support HTTP-to-HTTPS redirects, WebSockets and path routes.
- [x] Issue and automatically renew provider-neutral ACME HTTP-01 certificates.
- [ ] Add reviewed custom middleware/custom certificate controls and expose
  renewal failures clearly in the interface.
- [ ] Migrate existing routes one by one with DNS, TLS and application health proof
  before the Coolify proxy is stopped.

## Persistence, backups and restore

- [x] Inventory named volumes and bind mounts, including provider-owned paths.
- [ ] Configure scheduled encrypted backups with retention and off-host targets.
- [x] Require an encrypted off-host upload/download plus actual temporary-volume
  restore proof for every disposable adoption operation.
- [x] Add an exact-confirmation same-host restore rehearsal for provider-owned
  stateful applications with explicitly classified named volumes, temporary
  source pause, encrypted archives, an internal-network candidate with no
  published host port, bounded host-namespace health proof and complete cleanup
  without traffic, route, provider or detach mutation.
- [x] Keep a verified rehearsal snapshot running as a persistent FoxOS-owned
  no-traffic shadow on separate volumes and a separate identity; registry proof
  must confirm its restart policy, limits, mounts, absent host port and internal
  network before it becomes current.
- [x] Add controlled point-in-time shadow refresh from a newer authenticated
  rehearsal. The previous healthy generation stays current until separate
  volumes/network/container pass digest, isolation, health and registry proof;
  failure before promotion leaves it untouched.
- [x] Couple final source quiesce to a reversible FoxOS HTTPS canary-route
  rehearsal. The source remains paused from snapshot capture through candidate
  restore, authorized-TLS activation and verified route removal; startup
  recovery rolls back the route, unpauses the source and cleans exact temporary
  resources without replay.
- [ ] Perform the separately approved production-domain authority cutover. A
  rolled-back canary rehearsal deliberately leaves
  `finalSynchronizationProven=false`, does not move real traffic and does not
  detach or mutate the existing provider.
- [ ] Back up resource manifests, deployment metadata, environment configuration
  and proxy/TLS state without exposing secrets.
- [ ] Provide per-resource restore and full-disaster restore workflows.
- [ ] Expand the implemented disposable and real-workload same-host volume
  restore proofs into scheduled and off-host automated verification; a backup
  without a tested restore is not considered complete.

## Operations and safety

### Application management interface

- [x] Project every user-facing server application into one canonical,
  provider-neutral inventory with a stable local resource identity. Keep
  repeated WordPress sites and other repeated deployments separate while
  collapsing a migrated cold source and its active server-owned runtime into
  one application.
- [x] Place those applications on the existing desktop without creating files,
  copies or extra containers. Preserve the original icon/status-dot language,
  saved positions, open action and Docker-backed start/stop/restart menu.
- [x] Add **Uygulama Yöneticisi** to Settings using the existing FoxOS visual
  language. Open the selected application's page in the same Settings window;
  do not create a popup or a second window. Desktop and Settings share the same
  canonical inventory, pending lifecycle state and Docker action path; desktop
  and Store settings links target the exact application/container record.
- [x] Make the first editable setting the primary application domain. The
  owner-only transaction rejects panel/resource/pending-plan collisions and
  private or unresolved DNS before mutation, rechecks drift under a persistent
  lock, keeps the previous route live, uses server-owned Caddy ACME and ingress,
  verifies the exact route internally and through a pinned public DNS address,
  and removes only the new route on failed TLS/health proof. A completed change
  keeps the old address as a reversible alias and exposes verified rollback in
  the same Settings page.
- [ ] Add reviewed environment/secret editing, logs, health history, resource
  limits, deployment/update and backup/restore controls from the same canonical
  application record as their safety contracts become complete.
- [ ] On first installation, run the server scan before presenting applications,
  then offer the optional migration selection flow. Declining migration must
  still leave discovery, desktop shortcuts and management of safe observed
  capabilities operational.

- [ ] Add application logs, health history, resource metrics and actionable alerts.
- [ ] Add audit logs, users/roles and explicit authorization for destructive actions.
- [ ] Add CPU/memory/storage limits and disk-pressure protection.
- [ ] Add database-aware lifecycle and backup safety rather than treating databases
  as ordinary stateless web containers.
- [ ] Protect FoxOS core, proxy, critical databases and provider-owned resources
  from accidental stop/delete/reconfigure operations.
- [x] Keep base install and ordinary host management operational with no external
  provider account; CI starts FoxOS with recovery unconfigured.
- [x] Require exact confirmation to remove an external backup configuration
  while preserving encrypted local archives and the master key.

## Coolify retirement gate

Coolify may be removed only after every active resource has an independently
verified FoxOS manifest, secret source, persistent-data backup and tested
restore, health check, restart behavior, domain/TLS route and deployment/
rollback path. `/data/coolify`, Coolify volumes, networks and proxy must remain
untouched until the final migration audit passes and Burak separately approves
the destructive cleanup.

## Post-roadmap: zero-downtime stateful and database migration

After the six milestones and Coolify retirement capability are complete, add
true zero-downtime migration for stateful applications and databases. This work
must not be forgotten, but it does not block the first safe automatic migration
engine.

- Replace full-pause stateful snapshot/cutover with continuous pre-sync plus a
  verified final delta, or an application-aware replication adapter.
- Add database-engine-specific replication/transaction-log capture,
  consistency proof, controlled primary handoff and rollback.
- Measure and expose availability throughout the operation; never hide a pause.
- Keep zero-downtime as the target. Until these capabilities exist, any
  stateful migration may use only an explicit, operator-approved maximum pause
  budget and must roll back before cutover if the budget is exceeded.
