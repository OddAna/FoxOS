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
- [ ] Define the separate desired-state manifest and import-draft schema used by
  an adoption plan. Resource Registry v1 records observed state only.
- [ ] Expose the audit in the existing FoxOS interface without changing its
  visual language.

## Stable release system

- [x] Freeze public `main` separately from ongoing development.
- [x] Use `develop` for the dedicated development server.
- [x] Keep published tags immutable.
- [ ] Publish a GitHub Release for each approved version.
- [ ] Add opt-in `Stable` and `Preview` update channels with release notes,
  preflight checks, data preservation and rollback; never force updates.

## Declarative resources and migration

- [ ] Define a versioned FoxOS application/service manifest covering image or
  source, build method, ports, domains, health checks, environment, mounts,
  dependencies, restart policy and resource limits.
- [ ] Import the existing Coolify resource graph without copying secrets into
  logs or taking ownership before explicit migration.
- [ ] Distinguish applications, databases, workers, agents, proxies and internal
  dependencies while keeping every manageable instance addressable.
- [ ] Provide migration dry-run, conflict detection, per-resource cutover,
  verification and reversible rollback.

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

- [ ] Store secrets encrypted at rest with strict file permissions and scoped
  runtime injection.
- [ ] Mask secrets in the UI, API responses, logs, exports and diagnostics.
- [ ] Separate ordinary environment variables from secrets and support safe
  revision, rotation, import and backup boundaries.
- [ ] Prevent secret leakage through container discovery or repository manifests.

## Domains, proxy and TLS

- [x] Add the first FoxOS-owned control-panel gateway: an isolated Caddy service,
  DNS-01 certificate issuance/renewal, owner-only persistent TLS state, secure
  cookies and a loopback-only direct agent port. It does not use the Coolify
  proxy, API, network, labels or certificate store.
- [ ] Manage domains and routes through a FoxOS-owned Traefik, Caddy or NGINX layer.
- [ ] Detect domain and port collisions before deployment.
- [ ] Support HTTP-to-HTTPS redirects, WebSockets, path routes and reviewed middleware.
- [ ] Issue and automatically renew ACME certificates; support custom certificates
  and expose renewal failures clearly.
- [ ] Migrate existing routes one by one with DNS, TLS and application health proof
  before the Coolify proxy is stopped.

## Persistence, backups and restore

- [ ] Inventory named volumes and bind mounts, including provider-owned paths.
- [ ] Configure scheduled encrypted backups with retention and off-host targets.
- [ ] Back up resource manifests, deployment metadata, environment configuration
  and proxy/TLS state without exposing secrets.
- [ ] Provide per-resource restore and full-disaster restore workflows.
- [ ] Require automated restore verification; a backup without a tested restore is
  not considered complete.

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
