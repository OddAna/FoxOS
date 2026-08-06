<div align="center">

# 🦊 FoxOS

**A desktop-style control panel for your existing Linux server.**

![FoxOS](https://img.shields.io/badge/FoxOS-v0.0.1_alpha-FF5F56?style=for-the-badge&logo=firefox-browser&logoColor=white)
![Linux](https://img.shields.io/badge/Host-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
![Docker](https://img.shields.io/badge/Runtime-Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)

</div>

> [!IMPORTANT]
> FoxOS is **not a Linux distribution** and it does **not install Ubuntu** (or
> replace your server's operating system). It is a privileged management agent
> and web UI that runs on an existing Linux server.

FoxOS is designed for one simple outcome: clone it on a Linux server, start it,
and manage that same server from a browser. The host can be Ubuntu, Debian,
Fedora, Rocky Linux, AlmaLinux, Arch, or another Linux distribution; FoxOS does
not use the host package manager for its own runtime.

## FoxOS v0.0.1 alpha

- **Real host overview** — hostname, Linux distribution, kernel, uptime, load,
  memory, and disk usage
- **Real Docker control** — list containers and start, stop, or restart them
- **Real App Store** — install a reviewed catalog of Docker applications on the
  server, discover usable applications that already exist on that server, and
  manage their real lifecycle, access address, restart policy, ports, and
  storage from the FoxOS store interface
- **Host terminal** — commands run directly in the Linux host namespaces
- **Host file access** — the Files app contains a `Sunucu` entry linked to
  the host root filesystem
- **Persistent FoxOS workspace** — desktop and trash data live under
  `.foxos-data/` and survive rebuilds
- **Server-side authentication** — salted scrypt password hashing, HTTP-only
  session cookies, protected management APIs, and basic login rate limiting
- **Independent HTTPS gateway** — the optional FoxOS-owned Caddy service issues
  and renews its own certificate without the Coolify proxy or network
- **Server-owned secrets and recovery gate** — environment revisions reference
  AES-256-GCM encrypted local secrets, while disposable adoption requires an
  encrypted off-host upload, download, authentication and real restore proof
- **Disposable Compose deployment graph** — a strict two-or-three-service
  public-Git Compose subset builds every service, runs a serial cancellable
  queue, health-gates the ingress, and rolls the complete service group back
- **Digest-pinned image updates** — the fixed disposable image canary resolves
  reviewed registry tags to immutable digests, health-gates a constrained
  candidate, preserves the prior revision, and proves exact rollback
- **Server-owned workload evidence** — a stateless provider workload can pin a
  private or public Git commit into an authenticated encrypted local source
  archive and capture its live environment into ordinary names plus encrypted
  secret revisions without changing that workload
- **Stateful restore rehearsal** — an explicitly selected provider-owned
  stateful application can prove a same-host encrypted named-volume restore in
  an isolated healthy candidate without stopping, recreating or routing traffic
  away from the source
- **Persistent stateful shadow** — a verified rehearsal snapshot can become a
  separately identified FoxOS-owned runtime with its own persistent volumes,
  internal-only network, resilient restart policy and explicit limits while the
  original application keeps all production traffic
- **Controlled shadow refresh** — a newer verified rehearsal can build a
  separate shadow generation; the previous healthy generation remains current
  until the replacement passes restore, isolation, health and registry proof
- **Stateless production migration** — eligible provider-owned web applications
  can be cloned into a constrained FoxOS runtime, health-checked, moved behind
  FoxOS-owned TLS and ingress with zero unavailable probe samples, and rolled
  back while the original container remains running

FoxOS is currently an **alpha**. See [Current limitations](#current-limitations)
before exposing it to other users.

## Supported hosts

| Host | Status | Notes |
| --- | --- | --- |
| Linux server with Docker Engine + Compose v2 | Supported | FoxOS manages the actual Linux host |
| x86_64 or ARM64 Linux | Supported | Depends on standard multi-architecture Node images |
| macOS with Docker Desktop | Not supported for host management | It would manage Docker Desktop's Linux VM, not macOS |
| Windows with Docker Desktop | Not supported for host management | It would manage Docker Desktop's Linux VM, not Windows |
| Server without Docker | Not yet supported | A native systemd installer is not implemented |

## Install

### Requirements

- A Linux server
- Docker Engine
- Docker Compose v2 (`docker compose`)
- A user that can access the Docker daemon

No external service account is required. A clean FoxOS installation does not
need Cloudflare, a domain, DNS API access, Amazon S3, R2, another object-storage
provider, an API token, a credit card or an existing control panel. The base
installer never signs up for, provisions or enables a remote or billable
service. It starts with off-host recovery shown as **not configured** while host
management, authentication, Files, Terminal, Docker and App Store remain
available.

### 1. Clone and start

```bash
git clone https://github.com/OddAna/FoxOS.git
cd FoxOS
chmod +x install.sh
./install.sh
```

The installer validates the environment and starts FoxOS. It does not install or
modify the host operating system, call a cloud provider or create a remote
resource.

### 2. Connect safely

FoxOS binds to `127.0.0.1:8080` by default because it has root-equivalent
server access. From your own computer:

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-server-ip
```

Then open [http://127.0.0.1:8080](http://127.0.0.1:8080) and create the first
FoxOS account. Passwords must be at least 10 characters.

If you already have a private VPN or an HTTPS reverse proxy, copy
`.env.example` to `.env` and configure the bind address:

```bash
cp .env.example .env
# Edit FOXOS_BIND_ADDRESS and, when HTTPS is active, FOXOS_SECURE_COOKIE.
docker compose up -d
```

Do not publish FoxOS directly to the public internet. Read
[SECURITY.md](SECURITY.md) first.

### 3. Optional independent public HTTPS

FoxOS can publish its own HTTPS endpoint without Coolify, Cloudflare, a DNS API
token, or a paid certificate service. Its Caddy gateway uses the public,
provider-neutral ACME HTTP-01 flow and keeps certificate state on the server.

This is a separate, opt-in adapter. `install.sh` never invokes
`install-gateway.sh`, and the normal SSH-tunnel installation above does not need
any domain or certificate provider.

1. Create an `A`/`AAAA` record for the chosen FoxOS hostname pointing to the
   server. The DNS host is your choice; FoxOS does not call its API.
2. Make sure inbound TCP ports `80` and `443` reach this server.
3. Run:

```bash
chmod +x install-gateway.sh
./install-gateway.sh
```

The installer asks only for the hostname and ACME contact email. It binds the
direct agent port to `127.0.0.1`, enables secure session cookies, and starts the
isolated `foxos-gateway` service on standard ports `80` and `443`. If another
proxy already owns those ports, migrate ingress authority through FoxOS before
retiring that proxy; a nonstandard HTTPS port alone cannot complete public
HTTP-01 certificate validation.

## How it controls the host

```text
Browser
  │  authenticated, same-origin HTTPS
  ▼
FoxOS-owned gateway (optional Caddy + HTTP-01 TLS)
  │  private Compose network
  ▼
FoxOS agent container (Node.js + built React UI)
  ├── host PID/mount/network namespaces via nsenter
  ├── host root mounted at /host
  ├── Docker Engine socket mounted read/write
  ├── curated apps created as labeled sibling containers
  └── persistent FoxOS data mounted at /data
```

The agent container uses a small Debian-based runtime image for packaging. That
image is **not installed onto the host**. Terminal commands enter PID 1's Linux
namespaces and execute the host's own `/bin/sh`, package manager, files,
network, and processes.

This architecture is intentionally privileged. It is what makes full server
management possible, and it also means a compromised FoxOS session is equivalent
to compromised root access.

## Use

- Open **Sunucu** from the Dock to inspect host metrics and control Docker
  containers.
- Open **App Store** to install and manage applications on the actual server.
  FoxOS currently includes curated definitions for
  [Uptime Kuma](https://github.com/louislam/uptime-kuma),
  [Dozzle](https://github.com/amir20/dozzle),
  [IT-Tools](https://github.com/CorentinTh/it-tools), and
  [Stirling PDF](https://github.com/Stirling-Tools/Stirling-PDF).
- Use an installed application's three-dot menu to open, start, stop, restart,
  or manage that exact instance. **Ayarlar** opens as a full page inside the
  same Store window; it is not a popup or a separate browser window.
- Open **Terminal** to execute commands on the host.
- Open **Dosyalar**, then **Sunucu**, to browse the host filesystem.
- Use **Masaüstü** for FoxOS-only workspace files that should persist without
  cluttering the host root.
- Right-clicks stay inside FoxOS instead of opening the browser menu. Desktop
  and Files keep their item menus; application windows provide minimize,
  maximize/restore, and close actions.

The FoxOS core container is marked as protected and cannot stop or restart itself
from the container list.

App Store installs are not simulations and are not kept in browser storage.
FoxOS pulls the catalog image through the host Docker Engine, creates a labeled
container with an `unless-stopped` restart policy, and reads its live state back
from Docker. The store installs apps on their catalog port with a private
`127.0.0.1` bind by default. Persistent app data is kept in a named Docker volume
and is preserved by the store when the app is removed; the authenticated API can
explicitly remove a FoxOS-owned volume when requested.

The store also inspects the live Docker inventory. Existing catalog images and
user-facing Docker or Coolify applications with a published port or proxy route
appear as installed without being re-created. Every discovered container remains
a separate application instance, so multiple WordPress sites or repeated app
deployments do not collapse into one card. The Store can open, start, stop, and
restart these existing containers and can save their Docker restart policy;
only FoxOS-owned installations can be deleted from Store. A stopped application
with a configured published port remains visible and can be started again. Known
applications use their project logos, while custom applications use the icon
declared by their own web route and fall back to the Docker mark when they do not
publish one. Coolify databases, workers, agents, reverse proxies, and other
internal dependency containers are not presented as standalone store applications.

## Server-owned Resource Registry

FoxOS keeps a provider-neutral, versioned observation of the server under
`.foxos-data/registry/`. Coolify labels and other provider metadata are treated
as migration input, not permanent authority. A scan reads containers, images,
networks, volumes, mounts, ports, routes, health and restart state through
Docker `GET` requests only. It does not recreate, label, start, stop or adopt a
resource.

The production agent performs this same read-only scan asynchronously at
startup so the server has a current snapshot after a FoxOS restart. Set
`FOXOS_RESOURCE_SCAN_ON_STARTUP=false` only when an operator intentionally wants
to disable that observation; authenticated manual scans remain available.

The authenticated API exposes:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/resources/scan` | Run a read-only inventory and atomically store a new snapshot |
| `GET /api/resources` | Read the latest stored snapshot, ownership status, relationships, conflicts and adoption blockers |
| `GET /api/resources/export` | Download a redacted provider-neutral migration plan |
| `GET /api/migration-selections/current` | Read the snapshot-bound selection persisted internally by the latest start request |
| `PUT /api/migration-selections/current` | Internal compatibility surface for selection persistence; it never executes a migration |
| `GET /api/migration-runs` | Read owner-only whole-server migration run history and the latest state |
| `POST /api/migration-runs` | Persist the exact selection and start immutable all-resource preflight followed by serial execution when every gate is ready |
| `GET /api/migration-runs/:runId` | Read one migration run, per-resource blockers and verified operation IDs |
| `GET /api/stateless-migrations/plans/:planId/review` | Read the server-owned reviewed configuration and drift state for one stateless plan |
| `PUT /api/stateless-migrations/plans/:planId/review` | Save health target, runtime confirmation, every route confirmation and certificate adapter choice without applying them |
| `POST /api/resources/:resourceId/adoption-plan` | Create a deterministic import draft for the strictly disposable pilot |
| `GET /api/secrets` | Read encrypted-secret metadata without returning values |
| `POST /api/secrets` | Create a new encrypted secret revision |
| `GET /api/resources/:resourceId/environment-revision` | Read the classified environment revision for one resource |
| `POST /api/resources/:resourceId/environment-revisions` | Pin ordinary values and encrypted secret references to one resource |
| `GET /api/workload-evidence` | Read redacted Git-archive and environment-capture evidence |
| `POST /api/workload-evidence/source-plans` | Resolve and inspect a credential-free or encrypted-credential HTTPS Git source without Docker mutation |
| `POST /api/workload-evidence/source-plans/:planId/capture` | Reverify, encrypt, authenticate and store the bounded source archive locally |
| `POST /api/workload-evidence/environment-plans` | Read one candidate container environment through Docker `GET` and plan value-free classification |
| `POST /api/workload-evidence/environment-plans/:planId/capture` | Recheck drift and store an immutable local environment/secret revision |
| `GET /api/stateful-rehearsals` | Read redacted stateful rehearsal plans, operations, current proofs and guarantees |
| `POST /api/stateful-rehearsals/plans` | Create a GET-only, exact-confirmation plan with explicit persistent/empty volume classification |
| `POST /api/stateful-rehearsals/cutover-plans` | Create a GET-only final-quiesce plus reversible FoxOS HTTPS canary-route plan |
| `GET /api/stateful-rehearsals/plans/:planId` | Read one immutable rehearsal plan and its operation-specific run confirmation |
| `POST /api/stateful-rehearsals/plans/:planId/run` | Revalidate drift, pause briefly, encrypt/restore, health-gate and clean the isolated candidate |
| `POST /api/stateful-rehearsals/cutover-plans/:planId/run` | Keep the source paused through candidate restore, HTTPS canary activation and verified route rollback, then restore source health |
| `GET /api/stateful-rehearsals/operations/:operationId` | Read one redacted rehearsal result and cleanup state |
| `GET /api/stateful-shadows` | Read persistent FoxOS-owned shadow plans, operations, current registry proofs and guarantees |
| `POST /api/stateful-shadows/plans` | Plan a no-traffic shadow from the current authenticated rehearsal snapshot |
| `GET /api/stateful-shadows/plans/:planId` | Read one immutable shadow plan and its operation-specific run confirmation |
| `POST /api/stateful-shadows/plans/:planId/run` | Restore separate FoxOS volumes, start the constrained internal runtime and verify its FoxOS identity |
| `POST /api/stateful-shadows/refresh-plans` | Bind a newer verified rehearsal to the current healthy shadow without mutating either generation |
| `POST /api/stateful-shadows/refresh-plans/:planId/run` | Build and verify a separate generation, atomically promote it, then clean the prior generation by exact ownership |
| `GET /api/stateful-shadows/operations/:operationId` | Read one redacted persistent shadow result and failure cleanup state |
| `GET /api/recovery/status` | Read local encryption and off-host backup readiness without credentials |
| `GET /api/deployments` | Read FoxOS-owned disposable source revisions, plans, operations and current state |
| `POST /api/deployments/plans` | Resolve a public HTTPS Git branch/tag to an immutable commit and create a reviewed Dockerfile plan |
| `POST /api/deployments/plans/:planId/apply` | Build and health-gate an exactly confirmed disposable source revision |
| `POST /api/deployments/:operationId/rollback` | Restore the preserved previous healthy source revision |
| `GET /api/compose-deployments` | Read the fixed Compose lab's revisions, queue, jobs, operations and current service group |
| `POST /api/compose-deployments/plans` | Pin and validate a public-Git strict Compose graph and every service build context |
| `POST /api/compose-deployments/plans/:planId/enqueue` | Add an exactly confirmed Compose plan to the serial deployment queue |
| `GET /api/compose-deployments/jobs/:jobId` | Read one persisted queue job and its terminal operation ID |
| `POST /api/compose-deployments/jobs/:jobId/cancel` | Cancel a queued job or request cooperative cancellation before cutover |
| `POST /api/compose-deployments/:operationId/rollback` | Restore and re-prove the complete previous Compose service group |
| `GET /api/image-updates` | Read the fixed image-update lab's reviewed inputs, plans, operations and current revision |
| `POST /api/image-updates/plans` | Resolve a reviewed image tag to its immutable registry digest and create a no-mutation plan |
| `GET /api/image-updates/plans/:planId` | Read one immutable image-update plan and its exact apply confirmation |
| `POST /api/image-updates/plans/:planId/apply` | Revalidate, pull by digest, constrain and health-gate a disposable image revision |
| `POST /api/image-updates/:operationId/rollback` | Restore and re-prove the preserved previous image revision |
| `GET /api/adoptions` | Read locally stored plans and operations |
| `GET /api/routes` | Read FoxOS-owned route records and their last verification state |
| `POST /api/adoptions/plans/:planId/apply` | Apply an explicitly confirmed disposable plan |
| `POST /api/adoptions/:operationId/rollback` | Restore the preserved source container for an applied pilot operation |

Environment values, arbitrary provider labels, middleware credentials and
secret-bearing health-check commands are never copied into registry snapshots
or exports; long token-like route path segments are replaced by stable redacted
fingerprints. Stable FoxOS resource IDs survive normal container recreation by
using locally stored, hashed identity aliases. Existing external resources stay
in the `observed` stage unless an operator uses the narrowly gated disposable
adoption pilot described below.

## Disposable source deployment pilot

FoxOS includes the first Milestone 5 source-build transaction. It is deliberately
limited to the fixed `foxos-deployment-lab` canary and is not exposed in the Store
UI. The source adapter accepts a credential-free public HTTPS Git URL plus a
branch or tag, resolves it without a provider API, and pins the plan to the exact
Git commit, Dockerfile digest and complete bounded context digest. Git hosts are
inputs only; all revision, build, health and rollback authority is stored under
`.foxos-data/deployments/` with owner-only permissions.

The pilot rejects local/private repository hosts, redirects, credentials,
submodules, symlinks, oversized contexts, unpinned `FROM` images, `ADD`, build
mounts and every private port except `8080`. Docker builds receive no secrets and
run with build networking disabled. Build output is bounded, redacted and stored
separately from the immutable revision record.

Apply starts the built image on a Docker-assigned `127.0.0.1` port with CPU,
memory and PID limits. The existing active canary remains running while FoxOS
checks HTTP `200` and an explicit response marker. Only a verified candidate is
promoted. A failed build or health proof removes the candidate without cutting
over. A later healthy revision stops and preserves the previous container so an
exact-confirmation rollback can restore and re-prove it.

The repository contains two intentionally tiny canary contexts for the live
v1 → v2 → rollback proof. After this branch is published, plan them with:

```bash
docker compose exec -T foxos node /app/deploymentCli.js plan \
  --repository https://github.com/OddAna/FoxOS.git \
  --ref develop \
  --context pilot/source-deployment-canary/v1 \
  --dockerfile Dockerfile \
  --private-port 8080 \
  --health-path / \
  --expected-body "FoxOS source deployment canary v1" \
  --confirm "PLAN DISPOSABLE SOURCE"

# Use the plan ID and exact confirmation returned above.
docker compose exec -T foxos node /app/deploymentCli.js apply PLAN_ID \
  --confirm "DEPLOY DISPOSABLE PLAN_ID"

# After applying v2, use its operation ID and returned rollback confirmation.
docker compose exec -T foxos node /app/deploymentCli.js rollback OPERATION_ID \
  --confirm "ROLLBACK DEPLOYMENT OPERATION_ID"
```

This path has no domain, external route, volume, secret, Cloudflare, S3 or
Coolify dependency. It proves the source-build/deployment transaction only; real
applications, private Git credentials, webhooks, persistent data and general
rolling deployments remain blocked.

## Disposable Compose deployment pilot

FoxOS also accepts one strict Compose graph under the separate fixed
`foxos-compose-lab` identity. This is not a call to `docker compose up` and it is
not a general Compose execution endpoint. FoxOS parses the manifest itself and
accepts only two or three source-built services, simple acyclic `depends_on`
lists and one declared private TCP port per service. Every service must be part
of the ingress dependency graph; the ingress is fixed to private port `8080`.

The manifest cannot set images, environment values, secrets, build arguments,
ports, volumes, configs, custom networks, commands, entrypoints, privileges,
devices or host namespaces. Every service uses the same bounded,
digest-pinned-Dockerfile and networkless-build rules as the single-container
pilot. At runtime FoxOS creates a new isolated project bridge. Only the ingress
gets a Docker-assigned `127.0.0.1` port; no service receives a public bind,
volume, host mount, capability or provider network.

Compose applies run through a server-persisted serial queue. Queued jobs can be
cancelled immediately; a running cancellation is checked between source,
build, candidate and pre-cutover phases. A verified candidate starts
dependencies first, then proves the ingress HTTP status and response marker
before the previous service group is stopped. Rollback identity-checks every
service, restores the whole previous group in dependency order and repeats its
original ingress proof.

The repository includes v1/v2 two-service canaries. Plan and queue v1 with:

```bash
docker compose exec -T foxos node /app/composeDeploymentCli.js plan \
  --repository https://github.com/OddAna/FoxOS.git \
  --ref develop \
  --manifest pilot/compose-deployment-canary/v1/compose.yaml \
  --ingress-service web \
  --health-path / \
  --expected-body "FoxOS compose deployment canary v1 + api-v1" \
  --confirm "PLAN DISPOSABLE COMPOSE"

docker compose exec -T foxos node /app/composeDeploymentCli.js enqueue PLAN_ID \
  --confirm "DEPLOY COMPOSE PLAN_ID"

docker compose exec -T foxos node /app/composeDeploymentCli.js wait JOB_ID

# After applying v2, roll its operation back to v1.
docker compose exec -T foxos node /app/composeDeploymentCli.js rollback OPERATION_ID \
  --confirm "ROLLBACK COMPOSE OPERATION_ID"
```

Plans, revisions, jobs, per-service redacted build logs, operations and the
current group live under `.foxos-data/compose-deployments/` with owner-only
permissions. Private Git, environment/secrets, persistence, build packs,
webhooks, parallel jobs, general routes and real workloads remain unsupported.

## Disposable image update pilot

The image-update path proves the remaining Milestone 5 transaction without
touching a Store application or an imported workload. It accepts only the fixed
`foxos-image-update-lab` identity and the two tag/digest pairs recorded in
[`pilot/image-update-canary.json`](pilot/image-update-canary.json). There is no
arbitrary repository, registry credential, provider API, Coolify, domain,
Cloudflare, S3, volume, environment or secret input.

Planning asks Docker Engine for the registry distribution descriptor and stores
the immutable repository digest, descriptor metadata, supported platforms,
runtime constraints and health proof. It rejects a tag whose current digest no
longer matches the reviewed set. Apply resolves the tag again, rejects plan or
active-state drift, and pulls `traefik/whoami@sha256:...` rather than the mutable
tag.

Each revision starts as a non-root candidate with a read-only root filesystem,
all Linux capabilities dropped, `no-new-privileges`, bounded CPU, memory and
PIDs, no mounts, a dedicated FoxOS bridge and only a Docker-assigned
`127.0.0.1` port. FoxOS verifies HTTP `200` and the planned response marker
before stopping the current canary. A failed pull, constraint check or health
proof removes the candidate and its network. A successful update keeps the
previous healthy container and network stopped as rollback evidence. Exact
rollback restores that container and repeats its original health proof.

Run the v1 → v2 → v1 proof through the agent:

```bash
docker compose exec -T foxos node /app/imageUpdateCli.js plan \
  --image traefik/whoami:v1.10.3 \
  --health-path / \
  --expected-body "Hostname:" \
  --confirm "PLAN DISPOSABLE IMAGE UPDATE"

docker compose exec -T foxos node /app/imageUpdateCli.js apply PLAN_ID \
  --confirm "APPLY IMAGE UPDATE PLAN_ID"

# Create and apply a v1.11.0 plan, then restore v1.10.3 exactly.
docker compose exec -T foxos node /app/imageUpdateCli.js rollback OPERATION_ID \
  --confirm "ROLLBACK IMAGE UPDATE OPERATION_ID"
```

Plans, revisions, operations and the current pointer live under
`.foxos-data/image-updates/` with owner-only permissions. The Store does not
show the active or retained lab containers. General image-based application
updates remain blocked until per-application manifests, persistence, secrets,
routes and recovery policy can participate in the same transaction.

## Application Manifest

Every manageable instance can now receive a server-owned, provider-neutral
application manifest. FoxOS compiles it from the latest read-only resource
registry snapshot and its own environment, route, recovery, image-operation,
source-deployment and Compose-deployment records. The manifest keeps one stable
resource identity and describes:

- immutable OCI image, FoxOS public-Git build revision or strict Compose graph
  revision plus desired runtime state;
- ports, restart behavior and CPU/memory/PID/security constraints;
- a local environment revision plus encrypted secret references, never values;
- volumes or bind mounts and their backup/restore requirements;
- FoxOS-owned route records and TLS policy;
- directed Compose dependencies, informational observed relationships and
  health/update/rollback evidence.

An observed Docker, Compose or Coolify workload may produce an `import-draft`,
but planning changes no container, network, route or provider state. The draft
lists every blocking gate. External provider authority, an unclassified
environment, missing immutable source, unresolved directed dependency, provider-only
route, persistent data without tested restore, missing limits, health evidence
or update/rollback proof prevents finalization. Provider labels remain lookup
provenance only and are never required to reconstruct the desired resource.

Finalization is intentionally available only when every gate is satisfied by
FoxOS-owned evidence. It stores an immutable revision and current pointer; it
does not detach a provider or recreate the runtime. Those are later, separately
confirmed transactions. Secret values are never written to the manifest or
returned by its API.

The two existing source-build pilots now participate without expanding their
scope. `foxos-deployment-lab` points to its pinned Git commit, context and
Dockerfile revision. Each `foxos-compose-lab` service remains independently
addressable while sharing the same pinned manifest/graph revision; only explicit
`depends_on` edges require another finalized manifest. Merely sharing a Docker
network is observational evidence, not a dependency or ownership claim.

After an authenticated resource scan, inspect the resource ID and use the CLI:

```bash
docker compose exec -T foxos node /app/applicationManifestCli.js draft RESOURCE_ID \
  --confirm "PLAN APPLICATION MANIFEST"

docker compose exec -T foxos node /app/applicationManifestCli.js finalize DRAFT_ID \
  --confirm "FINALIZE APPLICATION MANIFEST DRAFT_ID"

docker compose exec -T foxos node /app/applicationManifestCli.js current RESOURCE_ID
docker compose exec -T foxos node /app/applicationManifestCli.js status
```

Authenticated clients can use `GET /api/application-manifests`, create drafts
with `POST /api/application-manifests/drafts`, and finalize a reviewed draft at
`POST /api/application-manifests/drafts/:draftId/finalize`. Owner-only state
lives under `.foxos-data/application-manifests/`.

## Workload classification and independence audits

Every Resource Registry record carries a deterministic, explainable
classification with three separate axes:

- workload role: `application`, `database`, `worker`, `agent`, `proxy`, `core`,
  `internal-service` or `unknown`;
- state class: `stateless`, `stateful`, `database` or `unknown`;
- authority: `foxos-owned` or `provider-owned`.

Classification uses only redacted local Docker observations: trusted safe
labels, image/name role evidence, published surfaces, complete inspection and
declared mounts. It stores reason codes and a stable classification revision.
Incomplete inspection or unknown mounts fail closed. A `stateless` result means
only that Docker exposes no declared writable mount; it does not prove that the
application keeps no important data elsewhere.

Only a running, fully inspected, provider-owned stateless application appears
as a candidate for a read-only independence audit. An audit compiles the same
provider-neutral Application Manifest gates and reports missing immutable
source, environment/secret, route/TLS, dependency, runtime/health/update and
backup/restore evidence. It writes private metadata only and never calls Docker,
changes a route, detaches a provider or approves apply.

```bash
docker compose exec -T foxos node /app/independenceAuditCli.js candidates

docker compose exec -T foxos node /app/independenceAuditCli.js audit RESOURCE_ID \
  --confirm "AUDIT WORKLOAD INDEPENDENCE"

docker compose exec -T foxos node /app/independenceAuditCli.js status
```

Authenticated clients can use `GET /api/independence-audits`, create a report
with `POST /api/independence-audits`, and read one through
`GET /api/independence-audits/:auditId`. Reports are owner-only under
`.foxos-data/independence-audits/`. A planning-ready audit is still not a
migration, cutover or provider-removal approval.

## Automatic whole-server migration planning

Resource Migration Orchestrator v1 turns the latest registry and Application
Manifest evidence into one deterministic plan for the whole server. Beszel is
only the first real stateful reference; the planner does not contain a
Beszel-specific migration path. `Resource-by-resource` means the common engine
will process resources sequentially for isolation and rollback, not that every
application needs a separate implementation.

Each resource receives a class-based strategy, availability policy, authority
transition, evidence blockers, implementation gaps, observed relationships and
conflicts. Shared Docker networks and provider projects remain coordination
hints and never become invented dependency direction. Current availability
contracts are explicit:

- stateless application: zero-downtime blue/green plus atomic route switch;
- stateful application: an explicit bounded-quiesce budget until post-roadmap
  continuous sync or application-aware replication exists;
- database: blocked until engine-consistent replication/backup and primary
  handoff exist;
- unknown/custom: blocked for review rather than guessed.

Create or inspect a server-local plan with:

```bash
docker compose exec -T foxos node /app/migrationOrchestratorCli.js plan \
  --confirm "PLAN SERVER MIGRATION"

docker compose exec -T foxos node /app/migrationOrchestratorCli.js status
docker compose exec -T foxos node /app/migrationOrchestratorCli.js get PLAN_ID
```

Authenticated clients can use `GET /api/migration-orchestrator`, create a plan
with `POST /api/migration-orchestrator/plans`, and read one through
`GET /api/migration-orchestrator/plans/:planId`. Plans are owner-only under
`.foxos-data/migration-orchestrator/`. Planning itself makes zero Docker
requests and changes no runtime, route or provider state. Execution is a
separate authenticated transaction started only through the Server Migration
screen; there is no provider-detach or destructive source-cleanup endpoint.

The existing Settings window now includes **Server Migration**. Its manual scan
uses the same read-only registry and orchestrator, keeps repeated instances such
as multiple WordPress containers separate, and shows exact resource identity,
health, current authority, class, routes, storage, availability policy,
relationships and blockers. Resources are separated into review-ready,
missing-evidence, unsupported-in-this-version, already-FoxOS-managed and
protected-system states.

Running, fully inspected provider-owned stateless blue/green preparation
candidates can be selected even while their unresolved evidence remains
visible. The user-facing action is `Geçişi Başlat`; there is no separate save
step. That request writes the exact IDs under
`.foxos-data/migration-selections/`, creates an owner-only run under
`.foxos-data/migration-runs/` and binds both to the exact plan and Registry
snapshot. A later inventory change fails closed before execution. Browser
storage is never authority.

The run prepares every selected member before it changes any runtime. A blocker
on one member prevents partial execution. When all gates are complete, explicit
required dependencies determine order and resources execute serially. Each
transaction receives an in-memory, short-lived, one-time grant bound to the
authenticated FoxOS session, plan, resource and evidence fingerprint. Raw
grants are not returned or stored. There is no separate approve endpoint,
source-stop, provider-detach or destructive cleanup action.

For selected stateless resources, the run captures the current environment into
server-owned ordinary values and encrypted secret references, recompiles the
plan, and writes the allowlisted review contract automatically. The contract is
bound to the exact server plan, Registry snapshot, resource, manifest revision,
evidence fingerprint and execution contract; drift invalidates it before
candidate creation. The user does not need a separate save or approve action.

## Stateless production migration

The production transaction accepts running, fully inspected, provider-owned
stateless Docker applications with an observed HTTPS route, no writable mounts,
an exact content-addressed local image or immutable OCI digest, and a complete
environment revision. Unsupported, stateful, database, privileged, ambiguous
or drifted resources remain blocked before traffic changes.

One authenticated `Geçişi Başlat` action performs the complete transaction:

1. Revalidate the Registry snapshot, source container identity, image,
   environment, route, proxy and current health. When Docker already defines a
   credential-free local HTTP health target, FoxOS uses that exact port and path
   instead of assuming the public route path is also a health endpoint.
2. Keep the source running and create a separate constrained candidate on
   FoxOS-owned routing and egress networks, with no host port or writable mount.
3. Bridge discovered server-local URL dependencies through operation-scoped
   aliases. Secret values are resolved in memory and never written into plans,
   operation records or logs.
4. Import the existing matching browser-trusted certificate as migration input
   into FoxOS Caddy storage, then stage and validate the FoxOS route. Caddy owns
   later provider-neutral ACME HTTP-01 renewal; no DNS API or Cloudflare account
   is required.
5. Switch only the selected domain through FoxOS-owned HAProxy and reversible
   host ingress rules. Domains not selected for migration continue through a
   temporary FoxOS-owned bridge to the existing proxy.
6. Require eight successful public TLS, route-identity and candidate-identity
   samples with zero unavailable responses. Any failed post-switch proof routes
   traffic back to the continuously running source and verifies rollback.

Candidate startup uses the verified running-process contract, not a mutable
process title or an unreviewed provider wrapper. Ordinary argv is accepted only
when its executable exists inside the source container. Next standalone
runtimes are reconstructed from the observed Node executable, observed
standalone working directory and existing `server.js`; this avoids rerunning a
wrapper that may perform database schema work. Unknown process-title patterns
fail closed before route or traffic changes. Bounded adapter failures keep their
actionable code in the owner-only run record without storing environment or
secret values. Candidate HTTP readiness is retried for a bounded 30-second
window instead of treating the first connection race as an application
failure. The first response status is checked against the reviewed `200-399`
contract; attempt count, status and container exit/OOM state are retained as
value-free diagnostics, and the migration run retains the exact operation ID.
Resource discovery stores only the normalized local health protocol, private
port and path. It does not copy the Docker health command, headers, credentials,
query strings or non-local hosts. The public domain/path route remains unchanged
when a distinct endpoint such as `/healthz` is used for source, candidate,
staged-route, cutover and rollback health proofs.

The transaction has no method that can stop or recreate the source, detach the
provider, delete provider state or perform destructive source cleanup. A
successful cutover leaves the source available as the exact rollback target.
Retiring the old proxy, provider networks, database runtime or source container
is a later per-resource audit, never an automatic side effect of this step.

```bash
docker compose exec -T foxos node /app/statelessMigrationCli.js status

docker compose exec -T foxos node /app/statelessMigrationCli.js plan \
  --server-plan SERVER_PLAN_ID --resource RESOURCE_ID \
  --confirm "PREPARE STATELESS MIGRATION"

docker compose exec -T foxos node /app/statelessMigrationCli.js get STATELESS_PLAN_ID
```

Authenticated clients can use `GET /api/stateless-migrations`, create a
review-only plan with `POST /api/stateless-migrations/plans`, and read one with
`GET /api/stateless-migrations/plans/:planId`. Its reviewed configuration is
available through `GET` and `PUT`
`/api/stateless-migrations/plans/:planId/review`. Whole-server execution starts
only through `POST /api/migration-runs`; it supplies the one-time,
complete-contract-bound approval internally. The standalone CLI above remains
a planning/status surface and cannot bypass the authenticated UI start action.

The transaction is exercised against real Docker by a separate, deliberately
non-production lab command:

```bash
docker compose exec -T foxos node /app/statelessMigrationLabCli.js proof \
  --confirm "RUN DISPOSABLE STATELESS LAB"
```

It creates only exact-labeled disposable objects, uses a reserved
`.foxos.invalid` hostname and loopback ports, holds the source container ID,
start time and restart count constant, and proves both a zero-unavailable-sample
switch with explicit rollback and a one-sample injected failure with automatic
rollback. It then removes every lab container and network. The TLS certificate
is ephemeral and operation-pinned. The lab remains a safe transaction
regression test and does not authorize or target a production domain.

Normal evidence-ready stateless OCI workloads now also receive a deterministic
execution contract inside their review plan. The compiler rechecks the exact
registry snapshot and Application Manifest revision, binds the immutable image
ID, retains every observed domain/path plus its Traefik service private port,
and describes a separate constrained candidate with no host port or writable
mount. Environment output contains names and encrypted references only.

Each route declares FoxOS as desired authority and requires browser-trusted TLS.
DNS and certificate implementations remain replaceable; FoxOS does not infer
Cloudflare or any other provider, and the clean base installation still needs
no domain, token, external account or paid service. Creating or reviewing a
contract alone cannot change traffic; only the authenticated migration run can
consume its one-time approval.

The authenticated API and standalone CLI use the same compiler context. A CLI
status read initializes no Docker connection or encryption key; the heavier
read-only planning context is created only when a review plan is requested.
That context disables deployment-queue startup and operation recovery, so
preparing a plan cannot silently reinterpret or resume older runtime work.

## Server-owned workload source and environment evidence

A running, fully inspected, provider-owned stateless application can capture
source and environment evidence without moving traffic or taking runtime
authority. A stateful application may capture environment evidence only; source
deployment, persistence/restore and cutover stay blocked behind their separate
gates.

For source evidence, FoxOS accepts a credential-free HTTPS Git URL or an
encrypted secret reference for a scoped read-only private Git credential. The
credential value is supplied to Git only through an ephemeral `askpass`
environment; it is never placed in the repository URL, Git arguments, plans,
archives, manifests, logs or API responses. Planning pins the branch or tag to
an immutable commit plus deterministic context and Dockerfile digests. Capture
reclones and rechecks those values, creates a bounded context archive, encrypts
it with the server-local AES-256-GCM key, writes it with owner-only permissions,
decrypts it again and authenticates the digest. The captured revision can be
reconstructed from FoxOS local state without contacting the Git host.

For environment evidence, planning performs one Docker `GET` inspection and
stores only variable names, their ordinary/secret classification and a keyed
fingerprint. Sensitive-looking names are always encrypted; `--secret-name`
classifies additional application-specific names as secrets. Capture repeats
the inspection, rejects any value/name/container drift, encrypts secret values
into revision-pinned references and stores the complete local environment
revision. Provider-injected `COOLIFY_*`, `SERVICE_FQDN_*`, `SERVICE_URL_*` and
`SERVICE_NAME_*` runtime metadata is recorded by name as excluded and is not
copied into FoxOS desired environment state. Evidence plan/capture output
includes neither secret nor ordinary values.

```bash
# Use a repository-scoped read-only credential. Its value comes from stdin.
docker compose exec -T foxos node /app/secretCli.js put git-workload-read \
  --value-stdin < /secure/path/read-token

docker compose exec -T foxos node /app/workloadEvidenceCli.js plan-source RESOURCE_ID \
  --repository https://github.com/owner/private-repository.git \
  --ref main --context . --dockerfile Dockerfile \
  --username x-access-token --credential-secret git-workload-read \
  --confirm "PLAN WORKLOAD SOURCE EVIDENCE"

docker compose exec -T foxos node /app/workloadEvidenceCli.js capture-source SOURCE_PLAN_ID \
  --confirm "CAPTURE WORKLOAD SOURCE SOURCE_PLAN_ID"

docker compose exec -T foxos node /app/workloadEvidenceCli.js plan-environment RESOURCE_ID \
  --secret-name APPLICATION_SPECIFIC_SECRET \
  --confirm "PLAN WORKLOAD ENVIRONMENT EVIDENCE"

docker compose exec -T foxos node /app/workloadEvidenceCli.js capture-environment ENVIRONMENT_PLAN_ID \
  --confirm "CAPTURE WORKLOAD ENVIRONMENT ENVIRONMENT_PLAN_ID"
```

These operations write only FoxOS evidence and make no Docker lifecycle,
route, provider or detach request. A captured source archive deliberately does
not claim that the provider's current image was built from that archive. Until
FoxOS builds the revision, health-gates it and proves update/rollback, the
manifest remains blocked by `source-runtime-binding-missing` and external
provider authority.

## Stateful restore rehearsal

The first real stateful safety transaction is deliberately narrow. It accepts
only a running, fully inspected, provider-owned application whose writable
mounts are one to four named Docker volumes. The operator must classify every
volume as either persistent or empty-ephemeral and must identify an observed
TCP application port. A source with Docker health must currently be healthy. If
the image has no Docker health definition, the operator must provide a bounded
absolute HTTP path that FoxOS will request only through the temporary
candidate's verified internal Docker address from the host network namespace.
The candidate has no published host port. Bind mounts, databases, protected
resources, custom command/user overrides and privileged or host access fail
closed.

Planning is Docker `GET` only. Running requires a plan-specific exact
confirmation and rechecks the resource, immutable image, environment revision,
mounts, health definition and runtime safety before mutation. FoxOS records the
pause request, briefly pauses the source while reading consistent volume
archives, then unpauses it immediately. The source is never stopped, recreated,
renamed or detached.

Persistent archives are encrypted locally with AES-256-GCM, written owner-only
and authenticated before use; plaintext archives and environment/secret values
are not stored. FoxOS restores them into temporary named volumes attached to a
constrained candidate using the exact observed image. The candidate has a fresh
internal Docker network and no published host port. FoxOS verifies the network
is internal, reads the candidate's private RFC1918 address from Docker, and uses
a bounded host-namespace HTTP probe only for that address and selected private
port. A proof is current only after restored content matches, candidate health
passes, source health is re-proven and every temporary container, volume and
network is removed. Startup recovery may unpause and clean an interrupted
operation but never replays it.

```bash
docker compose exec -T foxos node /app/statefulRehearsalCli.js plan RESOURCE_ID \
  --persistent-volume APP_DATA_VOLUME \
  --empty-volume OPTIONAL_EMPTY_SOCKET_VOLUME \
  --private-port 8090 \
  --health-http-path / \
  --confirm "PLAN STATEFUL REHEARSAL"

# Use the returned plan ID and its exact confirmation.
docker compose exec -T foxos node /app/statefulRehearsalCli.js run PLAN_ID \
  --confirm "RUN STATEFUL REHEARSAL PLAN_ID"

docker compose exec -T foxos node /app/statefulRehearsalCli.js status
```

Omit `--health-http-path` when the source already has a Docker healthcheck. The
fallback accepts only a path without a query, fragment or traversal; FoxOS does
not execute an operator-provided command, accept an operator-provided host or
publish the candidate port.

This proves a same-host restore and closes only the Application Manifest's local
restore-test blocker. The encrypted archive and master key are on the same
server, so it does **not** prove off-host recovery, key escrow, scheduled
retention, database consistency, domain cutover, provider detachment or full
machine disaster recovery. Those gates remain blocking.

## Persistent stateful shadow

A current stateful rehearsal can be materialized as a long-running FoxOS-owned
shadow without changing the source application. Planning requires the exact
`PLAN STATEFUL SHADOW` confirmation and binds the source resource, container,
immutable image, captured environment revision, health contract and rehearsal
operation. Running rechecks all of them before creating anything.

The shadow receives a deterministic FoxOS resource ID that is different from
the source ID. It has separate FoxOS-labeled named volumes, a dedicated internal
Docker network, no host port, no proxy labels and no route. FoxOS decrypts the
authenticated rehearsal archive only in memory, restores it into the shadow
volumes, recreates explicitly empty-ephemeral volumes, starts the exact image
with `unless-stopped`, `no-new-privileges`, 256 MiB memory, 0.5 CPU and a 256
process limit, then verifies health and isolation. A fresh Resource Registry
scan must recognize the running container as the expected FoxOS-owned identity
before the operation becomes current. Store discovery deliberately hides this
no-traffic shadow so it does not appear as a duplicate installed application.

```bash
docker compose exec -T foxos node /app/statefulShadowCli.js plan RESOURCE_ID \
  --confirm "PLAN STATEFUL SHADOW"

# Use the returned plan ID and its exact confirmation.
docker compose exec -T foxos node /app/statefulShadowCli.js run PLAN_ID \
  --confirm "RUN STATEFUL SHADOW PLAN_ID"

docker compose exec -T foxos node /app/statefulShadowCli.js status
```

The source receives Docker `GET` requests only during this transaction: it is
not paused, stopped, recreated, relabeled or detached. No domain, route,
traffic, provider metadata or Coolify resource is changed. If creation fails,
FoxOS removes only the exact shadow objects recorded as created by that
operation; startup recovery uses the same bounded cleanup and never replays an
interrupted deployment.

The shadow uses the rehearsal's point-in-time snapshot, not a live replication
stream. It proves that FoxOS can keep a persistent, constrained copy running and
supplies tested health and runtime-limit evidence to the Application Manifest.
It does **not** make the shadow production-authoritative, synchronize later
source writes, publish a route, prove update/rollback, prove off-host recovery
or detach the existing provider. Those remain separate gates before cutover.

### Controlled shadow refresh

Refresh never overwrites the current shadow volumes in place. First create and
run a new stateful rehearsal for the same source and volume classification. The
refresh planner accepts it only when its verified snapshot is newer than the
snapshot used by the current healthy shadow and the source image, environment,
health contract and volume policy have not drifted.

```bash
# After a newer stateful rehearsal has completed successfully:
docker compose exec -T foxos node /app/statefulShadowCli.js refresh-plan RESOURCE_ID \
  --confirm "PLAN STATEFUL SHADOW REFRESH"

# Use the returned refresh plan ID and its exact confirmation.
docker compose exec -T foxos node /app/statefulShadowCli.js refresh-run REFRESH_PLAN_ID \
  --confirm "REFRESH STATEFUL SHADOW REFRESH_PLAN_ID"
```

Apply restores the newer encrypted archive into new operation-owned volumes and
starts a separately named candidate on a new internal-only network. The existing
healthy shadow remains running while the candidate passes content digest,
runtime constraints, internal health and a fresh Resource Registry proof. FoxOS
then atomically replaces the current pointer and removes only the prior
generation's exact operation-labeled container, volumes and network. A failure
before promotion cleans only the candidate and leaves the prior current pointer
and runtime untouched. Startup recovery distinguishes those two phases: it
removes an unpromoted candidate, but keeps and reconciles a promoted generation.

This is a controlled **point-in-time refresh**, not live replication or final
cutover synchronization. Source writes may continue after the rehearsal pause,
so `finalSynchronizationProven` remains false. Route publication, traffic,
provider authority, off-host recovery and application update/rollback remain
separate blocking gates.

### Reversible stateful cutover rehearsal

The next safety gate couples a fresh, quiesced source snapshot to a real route
transaction without moving production traffic. Planning is GET-only and uses
the same explicit persistent/empty volume classification as the restore
rehearsal, but requires a stronger confirmation:

```bash
docker compose exec -T foxos node /app/statefulRehearsalCli.js cutover-plan RESOURCE_ID \
  --persistent-volume DATA_VOLUME \
  --empty-volume EMPTY_VOLUME \
  --private-port 8090 \
  --confirm "PLAN STATEFUL CUTOVER REHEARSAL"

# Use the returned plan ID and its exact confirmation.
docker compose exec -T foxos node /app/statefulRehearsalCli.js cutover-run PLAN_ID \
  --confirm "CUTOVER STATEFUL REHEARSAL PLAN_ID"
```

At run time FoxOS revalidates source identity, image, environment, health and
volume policy before pausing the source. While it remains paused, FoxOS captures
and authenticates the encrypted archive, restores it into an operation-owned
candidate with no host port, proves candidate health, attaches only that exact
candidate to the FoxOS-owned internal routing network, and verifies it over the
gateway's authorized HTTPS canary path. FoxOS then disconnects the canary,
proves the public path is unavailable, unpauses the source, proves its original
health and deletes only the recorded temporary container, volumes and network.
Startup recovery performs the same bounded route rollback, source unpause and
cleanup and never replays an interrupted transaction.

This proves `coupledCutoverRehearsalProven=true`, but deliberately records
`productionTrafficCutover=false` and `finalSynchronizationProven=false` after
rollback. It does not change the application's real domain, DNS, provider
metadata or Coolify resource. General domain ownership and the actual
production-authority cutover remain separate approvals.

## Disposable adoption pilot

FoxOS now has the first provider-neutral import draft, dry-run plan, apply and
rollback engine. It is intentionally **not a general migration button** and is
not exposed in the Store UI yet. The engine accepts only a resource whose name
starts with `foxos-adoption-lab`, whose
`com.foxos.adoption.disposable=true` label was deliberately set, and whose
runtime passes every pilot safety gate. Coolify-managed resources are rejected.

The included `pilot/docker-compose.adoption-lab.yml` creates the isolated test
resource. Its source publishes only on `127.0.0.1:18088`, uses one read-only
named volume, one ordinary test setting and one disposable secret setting, and
has no provider route or dependency. Before runtime mutation, FoxOS writes a
versioned manifest, pins the image digest and pins the classified environment
revision. Secret values are decrypted only in memory for source comparison and
target creation; they do not enter the manifest, plan, operation, API response
or registry snapshot.

The volume archive is encrypted locally with AES-256-GCM before it is written
or uploaded to the configured S3-compatible HTTPS target. FoxOS then verifies
the remote object metadata, downloads it again, verifies the ciphertext digest
and authentication tag, decrypts it in memory, and restores the downloaded
archive into a temporary Docker volume. Only after that real restore proof does
it stop and preserve the source container, create the FoxOS-managed target and
require a healthy result. The target is connected to the internal FoxOS routing
network and the fixed pilot path is verified through the FoxOS-owned Caddy
gateway with trusted HTTPS before apply completes.

The old source container is retained stopped under a distinct rollback name;
it is not shown as a second Store application. Rolling back first disconnects
and verifies removal of the public pilot route, then deletes only the
FoxOS-managed target, keeps the named volume, restores the source name, starts
it if it was previously running and verifies its runtime. Route records live
under `.foxos-data/routes/`; secret/environment revisions, recovery config,
encrypted archives, manifests, plans and operation records live below
`.foxos-data/`, all with owner-only permissions. See
[`pilot/README.md`](pilot/README.md) for the operator procedure.

### Configure encrypted secrets and off-host recovery

These operator CLIs deliberately read sensitive values from files or standard
input instead of command-line arguments. The Store UI does not expose this
pilot workflow yet.

Off-host recovery is optional for a normal FoxOS installation and mandatory
only when an operator deliberately starts the adoption pilot. “S3-compatible”
describes the open API protocol accepted by the current adapter; it does not
mean Amazon, Cloudflare or any other company is required. FoxOS never creates a
bucket, subscription or provider account and never opts the operator into
billing. The operator must explicitly choose and provision a target before
configuring it.

```bash
# Store or rotate a secret. The returned metadata never contains the value.
docker compose exec -T foxos node /app/secretCli.js put pilot-token \
  --value-stdin < /owner-only/path/pilot-token

# Pin the source resource's complete override set to an environment revision.
docker compose exec -T foxos node /app/secretCli.js environment RESOURCE_ID \
  --ordinary FOXOS_PILOT_MODE=disposable \
  --secret FOXOS_PILOT_TOKEN=pilot-token

# Configure an off-host S3-compatible HTTPS target with scoped credentials.
docker compose exec -T foxos node /app/recoveryCli.js configure-s3 \
  --endpoint https://your-s3-endpoint \
  --bucket your-foxos-backup-bucket \
  --region auto \
  --prefix foxos \
  --credentials-stdin < /owner-only/path/s3-credentials.json

# Stop using the configured external target. This removes only its local config
# and encrypted credential; existing encrypted archives and the master key stay.
docker compose exec -T foxos node /app/recoveryCli.js clear-configuration \
  --confirm "REMOVE BACKUP CONFIGURATION"
```

The credential JSON has exactly two fields: `accessKeyId` and
`secretAccessKey`. Keep that input file owner-only and remove it after the
configuration is stored. FoxOS persists the adapter credential itself only as
an authenticated encrypted envelope; it is not written to the config file.

`DATA_ROOT/security/master-key` is the local encryption root. Losing it makes
encrypted secrets and archives unreadable, so it must be protected separately
with the FoxOS data backup. The current gate proves operational off-host
round-trip and restore on the same FoxOS installation; scheduled retention,
key escrow and full-machine disaster recovery remain later milestones.

## Operations

```bash
# Status
docker compose ps

# Logs
docker compose logs -f foxos

# Gateway status and logs
docker compose -f docker-compose.yml -f docker-compose.gateway.yml ps
docker compose -f docker-compose.yml -f docker-compose.gateway.yml logs -f foxos-gateway

# Restart or stop a gateway installation
docker compose -f docker-compose.yml -f docker-compose.gateway.yml restart
docker compose -f docker-compose.yml -f docker-compose.gateway.yml down

# Restart
docker compose restart foxos

# Stop
docker compose down

# Update after pulling new code
git pull
./install.sh

# Update a gateway installation; the owner-only DNS secret is reused
git pull
./install-gateway.sh
```

### Change the port

Create a `.env` file:

```dotenv
FOXOS_BIND_ADDRESS=127.0.0.1
FOXOS_PORT=9090
FOXOS_SECURE_COOKIE=false
```

Then run `docker compose up -d`.

### Reset the FoxOS password

This removes only the FoxOS login record; it does not delete workspace or server
files:

```bash
docker compose exec foxos rm -f /data/auth.json
docker compose restart foxos
```

Refresh the page to create a new account.

### Back up FoxOS data

Stop FoxOS and back up the complete local `.foxos-data/` directory. It contains
the authentication record, FoxOS desktop files, registry/manifests, encrypted
secret records, the encryption master key, recovery configuration and trash.
Do not copy its contents into Git or logs.

## Current limitations

- Linux hosts only
- Docker Engine and Docker Compose v2 are required
- The terminal is command-based and not yet a full interactive PTY, so programs
  such as `vim`, `top`, and password prompts are not suitable yet
- File operations are synchronous; very large copy/move operations can take time
- No multi-user roles or permission levels
- No audit log yet
- Automatic production migration currently supports only eligible stateless
  Docker web applications. Stateful applications, databases, workers,
  privileged containers, writable mounts and ambiguous routes remain blocked
- The first certificate handoff imports an already valid matching certificate
  from readable Traefik ACME storage. After import, FoxOS Caddy owns renewal;
  other legacy proxy storage formats need their own migration adapters
- A migrated stateless application may still depend on a database or service
  that has not moved yet. FoxOS bridges that dependency without joining the
  candidate to the provider network, but the application is not fully
  independent until those dependencies have their own verified migrations
- A local content-addressed Docker image is enough for same-server cutover and
  rollback, but off-host image export or a FoxOS-owned registry is still needed
  for full disaster reconstruction after loss of the server
- Off-host recovery currently gates each disposable adoption operation; there
  is no scheduled retention policy, database-consistent backup, key escrow or
  full-machine disaster restore workflow yet
- Real provider-owned stateful applications have a same-host, named-volume-only
  restore rehearsal and may run an internal persistent FoxOS-owned shadow from
  that point-in-time snapshot. This is not live replication and does not yet
  support bind mounts, databases, off-host recovery, route cutover, source-write
  synchronization, adoption or provider detachment
- A fresh installation intentionally has no external backup adapter configured;
  ordinary FoxOS host management does not require one
- The App Store catalog is intentionally small and reviewed; arbitrary Compose
  files and untrusted install scripts are not accepted through the UI. The only
  Compose support is the fixed, strict, no-persistence disposable CLI/API pilot
- Image update/rollback is currently limited to the two reviewed tags of the
  fixed disposable canary; normal Store and imported applications are not
  eligible yet
- Application Manifest schema 2 can describe and audit imported application state,
  and can bind the fixed FoxOS OCI/source-build/Compose canaries to immutable
  local revisions. It can also reference an authenticated encrypted workload
  source archive and environment revision, but that evidence does not yet build,
  adopt, reconcile or detach normal production resources
- App Store images are maintained by their respective third-party projects, not
  by FoxOS
- The FoxOS HTTPS gateway uses provider-neutral ACME HTTP-01. Public certificate
  issuance or renewal requires ports `80` and `443` to reach FoxOS while the
  challenge is active

## Development

Run the backend and frontend separately:

```bash
# Terminal 1
cd backend
npm install
PORT=3001 DATA_ROOT=../.foxos-data HOST_ROOT=/ HOST_EXECUTION=local npm start

# Terminal 2
cd frontend
npm ci
npm run dev
```

The Vite development server proxies `/api` to
`http://localhost:3001`. In local development, host commands run with the
permissions of the user that started the backend.

Production uses the root [Dockerfile](Dockerfile), which builds the frontend and
ships a single runtime service.

## Project structure

```text
FoxOS/
├── Dockerfile                 # Multi-stage production image
├── docker-compose.yml         # Privileged Linux host integration
├── docker-compose.gateway.yml # Optional independent HTTPS gateway
├── docker-compose.ingress.yml # FoxOS-owned production ingress authority
├── install.sh                 # Environment checks and startup
├── install-gateway.sh         # Provider-neutral HTTPS startup
├── gateway/                   # Caddy HTTP-01 TLS and runtime routes
├── ingress/                   # HAProxy domain switch and legacy fallback
├── SECURITY.md                # Deployment and disclosure guidance
├── backend/
│   ├── server.js              # Auth, files, host terminal, metrics, Docker API
│   ├── appCatalog.js          # Reviewed application definitions
│   ├── appManager.js          # Docker app validation and container payloads
│   ├── resourceRegistry.js    # Read-only inventory, ownership and migration plan
│   ├── encryptionStore.js     # Local AES-GCM key and authenticated envelopes
│   ├── secretManager.js       # Encrypted secrets and classified environment revisions
│   ├── backupManager.js       # Encrypted S3-compatible round-trip and restore gate
│   ├── sourceDeploymentManager.js # Public Git commit, Docker build, health gate and rollback pilot
│   ├── composeDeploymentManager.js # Strict service graph, serial queue, group cutover and rollback
│   ├── imageUpdateManager.js # Reviewed registry digest, candidate health and exact rollback
│   ├── workloadEvidenceManager.js # Encrypted source archive and environment evidence capture
│   ├── statefulRehearsalManager.js # Same-host encrypted restore and isolated health proof
│   ├── statefulShadowManager.js # Persistent internal FoxOS-owned stateful shadow
│   ├── statelessMigrationManager.js # Blue/green transaction state machine
│   ├── productionStatelessMigrationAdapter.js # Candidate, health and traffic adapter
│   ├── ingressAuthorityManager.js # Caddy, HAProxy and reversible host ingress
│   ├── traefikCertificateImporter.js # Existing certificate migration input
│   ├── statelessMigrationLabAdapter.js # Real-Docker disposable adapter and rollback proof
│   ├── statelessMigrationLabGateway.js # Operation-pinned lab TLS switch and probe
│   ├── applicationManifestManager.js # Provider-neutral import drafts and desired revisions
│   ├── adoptionManager.js     # Disposable plan/apply/rollback transaction
│   └── package.json
└── frontend/
    ├── src/
    │   ├── apps/ServerApp.jsx # Host dashboard and Docker controls
    │   ├── apps/               # App Store, files, terminal, settings, media tools
    │   ├── components/         # Desktop, Dock, windows, authentication
    │   └── contexts/           # Auth, windows, and dialogs
    └── package.json
```

## Contributing

Issues and pull requests are welcome. Please describe the Linux distribution and
Docker versions used for testing, and never include credentials, private host
paths, or production logs containing secrets.

## License

FoxOS is available under the [MIT License](LICENSE).

<div align="center">

Built by [Burak Esen](https://github.com/OddAna)

</div>
