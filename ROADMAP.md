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
   resources one at a time; retire Coolify only after the final independence
   audit passes and destructive cleanup is separately approved.

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
- [ ] Expose the audit in the existing FoxOS interface without changing its
  visual language.

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
- [ ] Generalize the fixed pilot path into conflict-checked domain/path records
  for normal applications.

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

## Stable release system

- [x] Freeze public `main` separately from ongoing development.
- [x] Use `develop` for the dedicated development server.
- [x] Keep published tags immutable.
- [ ] Publish a GitHub Release for each approved version.
- [ ] Add opt-in `Stable` and `Preview` update channels with release notes,
  preflight checks, data preservation and rollback; never force updates.

## Declarative resources and migration

- [ ] Expand the versioned FoxOS application manifest beyond the implemented
  disposable image/port/health/mount/restart/resource-limit subset to source
  builds, domains, TLS, classified environment, secrets and dependencies.
- [ ] Import the existing Coolify resource graph without copying secrets into
  logs or taking ownership before explicit migration.
- [ ] Distinguish applications, databases, workers, agents, proxies and internal
  dependencies while keeping every manageable instance addressable.
- [ ] Expand the implemented disposable dry-run, conflict detection, verified
  cutover and reversible rollback to real application classes one safety gate at
  a time.

## Git source, build and deployment

- [ ] Connect public and private Git repositories with scoped deploy credentials.
- [ ] Support manual and webhook-driven deployments from selected branches or tags.
- [ ] Support reviewed Dockerfile, Docker Compose and build-pack workflows.
- [ ] Add a deployment queue with cancellable builds, bounded logs, status and
  retained build/deployment history.
- [ ] Add health-gated recreate/rolling deployment and automatic rollback to the
  last healthy revision.
- [ ] Add controlled image update, digest pinning and rollback for image-based apps.

## Environment and secrets

- [x] Store secrets encrypted at rest with strict file permissions and scoped
  runtime injection.
- [x] Mask secrets in API responses, local records, plans, exports and
  diagnostics used by the disposable pilot.
- [x] Separate ordinary environment variables from secrets and pin immutable
  secret/environment revisions.
- [ ] Add reviewed import/rotation controls to the existing FoxOS interface.
- [x] Prevent secret leakage through container discovery or repository manifests.

## Domains, proxy and TLS

- [x] Add the first FoxOS-owned control-panel gateway: an isolated Caddy service,
  DNS-01 certificate issuance/renewal, owner-only persistent TLS state, secure
  cookies and a loopback-only direct agent port. It does not use the Coolify
  proxy, API, network, labels or certificate store.
- [ ] Manage arbitrary domains and routes through the FoxOS-owned Caddy layer;
  the fixed disposable pilot route is implemented.
- [ ] Detect domain and port collisions before deployment.
- [ ] Support HTTP-to-HTTPS redirects, WebSockets, path routes and reviewed middleware.
- [ ] Issue and automatically renew ACME certificates; support custom certificates
  and expose renewal failures clearly.
- [ ] Migrate existing routes one by one with DNS, TLS and application health proof
  before the Coolify proxy is stopped.

## Persistence, backups and restore

- [x] Inventory named volumes and bind mounts, including provider-owned paths.
- [ ] Configure scheduled encrypted backups with retention and off-host targets.
- [x] Require an encrypted off-host upload/download plus actual temporary-volume
  restore proof for every disposable adoption operation.
- [ ] Back up resource manifests, deployment metadata, environment configuration
  and proxy/TLS state without exposing secrets.
- [ ] Provide per-resource restore and full-disaster restore workflows.
- [ ] Expand the implemented per-operation disposable volume restore proof into
  scheduled and off-host automated restore verification; a backup without a
  tested restore is not considered complete.

## Operations and safety

- [ ] Add application logs, health history, resource metrics and actionable alerts.
- [ ] Add audit logs, users/roles and explicit authorization for destructive actions.
- [ ] Add CPU/memory/storage limits and disk-pressure protection.
- [ ] Add database-aware lifecycle and backup safety rather than treating databases
  as ordinary stateless web containers.
- [ ] Protect FoxOS core, proxy, critical databases and provider-owned resources
  from accidental stop/delete/reconfigure operations.

## Coolify retirement gate

Coolify may be removed only after every active resource has an independently
verified FoxOS manifest, secret source, persistent-data backup and tested
restore, health check, restart behavior, domain/TLS route and deployment/
rollback path. `/data/coolify`, Coolify volumes, networks and proxy must remain
untouched until the final migration audit passes and Burak separately approves
the destructive cleanup.
