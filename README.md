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

FoxOS can publish its own HTTPS endpoint without Coolify. The first gateway
adapter uses Caddy and Cloudflare **DNS only** for ACME DNS-01 validation; web
traffic goes directly from the browser to the FoxOS gateway.

This is a separate, opt-in adapter. `install.sh` never invokes
`install-gateway.sh`, and the normal SSH-tunnel installation above does not need
Cloudflare or any other DNS provider.

1. Create a DNS-only `A` record for the chosen FoxOS hostname pointing to the
   server.
2. Create a Cloudflare API token limited to the one zone with only
   `Zone:Read` and `DNS:Edit`.
3. Run:

```bash
chmod +x install-gateway.sh
./install-gateway.sh
```

The installer asks for the hostname, ACME contact email and token without
printing the token. It binds the direct agent port to `127.0.0.1`, enables
secure session cookies, writes the credential to an owner-only Docker secret,
and starts the isolated `foxos-gateway` service.

The gateway uses host port `8443` by default so it can coexist with another
process already using `443`. Open `https://your-foxos-domain:8443`. Set
`FOXOS_HTTPS_PORT=443` when standard HTTPS port `443` is free.

## How it controls the host

```text
Browser
  │  authenticated, same-origin HTTPS
  ▼
FoxOS-owned gateway (optional Caddy + DNS-01 TLS)
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
| `POST /api/resources/:resourceId/adoption-plan` | Create a deterministic import draft for the strictly disposable pilot |
| `GET /api/secrets` | Read encrypted-secret metadata without returning values |
| `POST /api/secrets` | Create a new encrypted secret revision |
| `GET /api/resources/:resourceId/environment-revision` | Read the classified environment revision for one resource |
| `POST /api/resources/:resourceId/environment-revisions` | Pin ordinary values and encrypted secret references to one resource |
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

## Application Manifest v1

Every manageable instance can now receive a server-owned, provider-neutral
application manifest. FoxOS compiles it from the latest read-only resource
registry snapshot and its own environment, route, recovery and image-operation
records. The manifest keeps one stable resource identity and describes:

- immutable OCI image input and desired runtime state;
- ports, restart behavior and CPU/memory/PID/security constraints;
- a local environment revision plus encrypted secret references, never values;
- volumes or bind mounts and their backup/restore requirements;
- FoxOS-owned route records and TLS policy;
- related resource manifests and health/update/rollback evidence.

An observed Docker, Compose or Coolify workload may produce an `import-draft`,
but planning changes no container, network, route or provider state. The draft
lists every blocking gate. External provider authority, an unclassified
environment, missing immutable image, unresolved dependency, provider-only
route, persistent data without tested restore, missing limits, health evidence
or update/rollback proof prevents finalization. Provider labels remain lookup
provenance only and are never required to reconstruct the desired resource.

Finalization is intentionally available only when every gate is satisfied by
FoxOS-owned evidence. It stores an immutable revision and current pointer; it
does not detach a provider or recreate the runtime. Those are later, separately
confirmed transactions. Secret values are never written to the manifest or
returned by its API.

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
- General resource migration is not available; only the explicitly labeled
  disposable pilot can be adopted, routed, backed up, restored and rolled back
- Off-host recovery currently gates each disposable adoption operation; there
  is no scheduled retention policy, database-consistent backup, key escrow or
  full-machine disaster restore workflow yet
- A fresh installation intentionally has no external backup adapter configured;
  ordinary FoxOS host management does not require one
- The App Store catalog is intentionally small and reviewed; arbitrary Compose
  files and untrusted install scripts are not accepted through the UI. The only
  Compose support is the fixed, strict, no-persistence disposable CLI/API pilot
- Image update/rollback is currently limited to the two reviewed tags of the
  fixed disposable canary; normal Store and imported applications are not
  eligible yet
- Application Manifest v1 can describe and audit imported application state,
  but it does not yet adopt, reconcile or detach normal production resources
- App Store images are maintained by their respective third-party projects, not
  by FoxOS
- The included FoxOS-owned HTTPS gateway currently ships one DNS-01 adapter for
  Cloudflare-managed zones; additional DNS providers are not yet packaged

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
├── install.sh                 # Environment checks and startup
├── install-gateway.sh         # Owner-only DNS secret and HTTPS startup
├── gateway/                   # Caddy build, config, and secret entrypoint
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
