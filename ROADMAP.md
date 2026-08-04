# FoxOS roadmap

FoxOS already provides host visibility, Docker inventory and lifecycle control,
server files, terminal access, and a real application Store. The following work
is required before Coolify can be removed from the development host without
losing deployment, routing, recovery or operational capabilities.

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
