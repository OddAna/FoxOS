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
- Coolify and similar control panels are import providers only. Their labels,
  databases, APIs and proxy configuration may be read to build a migration
  plan, but FoxOS must not require that provider after a resource is adopted.
- Provider imports must produce a provider-neutral FoxOS manifest stored on the
  server. Preserve import provenance for audit and rollback, not as the active
  authority.
- Never mark a discovered resource as FoxOS-owned automatically. Adoption must
  be explicit, conflict-checked, backed up, reversible and verified before the
  external provider is detached.
- External registrars, certificate authorities, Git hosts, registries and DNS
  APIs are replaceable adapters. FoxOS must keep the desired state and recovery
  information locally so changing an adapter does not erase resource truth.
- Read `ARCHITECTURE.md` before changing discovery, deployment, domains,
  secrets, persistence, backup or migration behavior.

## Development and deployment

- The development server checkout under `/opt/foxos` tracks `develop`; it is not
  the stable channel used by public installations.
- Before a release, run backend tests and syntax checks, frontend lint/build,
  Compose and shell validation, version scans, production image build, and
  browser interaction QA proportional to the change.
- Preserve existing Docker applications, volumes, authentication data and
  server configuration during development deployments. Never take ownership of
  an externally managed container merely because FoxOS discovers it.
