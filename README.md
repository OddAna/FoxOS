<div align="center">

# 🦊 FoxOS

**A desktop-style control panel for the Linux server you already own.**

![FoxOS](https://img.shields.io/badge/FoxOS-v0.0.2_alpha-FF5F56?style=for-the-badge&logo=firefox-browser&logoColor=white)
![Linux](https://img.shields.io/badge/Host-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
![Docker](https://img.shields.io/badge/Runtime-Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)

</div>

FoxOS turns an existing Linux server into a browser-managed workspace. It
discovers what is already running, gives applications stable identities and
desktop shortcuts, manages Docker and selected host services, and can move
eligible workloads away from third-party control panels into server-owned
runtime, routing and recovery state.

> [!IMPORTANT]
> FoxOS is **not a Linux distribution**. It does not install Ubuntu, replace the
> host operating system or create a virtual server. It is a privileged
> management agent and web interface installed on a Linux server that already
> has Docker Engine and Docker Compose v2.

FoxOS `v0.0.2` is an **alpha release**. It is useful on real servers, but its
management session has root-equivalent power and migration support deliberately
rejects workloads whose safety cannot yet be proven. Read
[Security](#security-model) and [Current limitations](#current-limitations)
before installation.

## What FoxOS owns

FoxOS is a server control plane, not a skin over Coolify or another provider.
Its durable application identity, desired runtime, domains, routes, TLS policy,
environment revisions, encrypted secret references, storage relationships,
backup evidence and rollback history live on the server.

- A clean installation has **zero Coolify dependency**.
- Coolify metadata can be enabled as an optional, read-only migration input for
  discovering legacy and inactive definitions.
- Cloudflare is an optional DNS adapter. FoxOS does not require Cloudflare, a
  paid plan, a domain or an API token to install or run.
- S3-compatible storage is an optional, provider-neutral recovery adapter. Base
  installation and ordinary server management work without it.
- The installer never signs up for, provisions or enables a remote or billable
  service.

After a workload has completed FoxOS's independence checks, stopping the FoxOS
agent does not stop that workload. Applications continue under Docker and the
Linux host. The separate FoxOS-owned gateway/ingress services must remain
running when applications depend on them for public domains, and the FoxOS
agent is still required to perform management operations.

## v0.0.2 capabilities

### Server and application control

- View the real host name, distribution, kernel, uptime, load, memory and disk
  use.
- List all Docker containers, including stopped containers, and expose only the
  lifecycle actions each resource actually supports.
- Start, stop and restart Docker applications from the desktop, Store,
  Application Manager or FoxOS context menu.
- Discover multiple instances of the same application as separate resources
  with stable local identities.
- Discover selected administrator-owned `systemd` units and WireGuard
  interfaces without reading unit contents, WireGuard configuration or keys.
- Start, stop, restart and change boot enablement for verified host services
  through fixed, Registry-bound operations.
- Use a host terminal and browse the host filesystem from the web interface.

### Desktop and Application Manager

- Project installed and discovered applications onto the FoxOS desktop with
  their real icon and observed status.
- Keep shortcut visibility and location separate from application runtime
  state. Removing a shortcut does not stop or delete the application.
- Drag shortcuts into desktop folders. Folder status summarizes contained
  applications: warning and error states take priority, while stopped
  applications do not make an otherwise healthy folder fail.
- Open an application's full management page for runtime state, restart policy,
  ports, storage, access links, source, updates and Compose controls when those
  capabilities are available.
- Create or remove a desktop shortcut from either the context menu or
  Application Manager.

### App Store

The Store installs reviewed Docker applications as real sibling containers on
the server. It also reconciles installed and discovered instances instead of
showing a separate fictional catalog state.

The current curated catalog includes:

- [Uptime Kuma](https://github.com/louislam/uptime-kuma)
- [Dozzle](https://github.com/amir20/dozzle)
- [IT-Tools](https://github.com/CorentinTh/it-tools)
- [Stirling PDF](https://github.com/Stirling-Tools/Stirling-PDF)

Store applications default to a loopback-only host port and named Docker
storage where persistence is required.

### Access links, DNS and TLS

- Keep more than one HTTPS access link for the same application.
- Check host conflicts, route ownership, target identity, DNS and public health
  as one confirmed transaction.
- Publish domains through the FoxOS-owned Caddy gateway and HAProxy ingress,
  independent of the Coolify proxy and networks.
- Obtain and renew browser-trusted certificates with provider-neutral ACME
  HTTP-01 when the optional public gateway is installed.
- Optionally connect a restricted Cloudflare API token from **Settings →
  Connections**. FoxOS encrypts the token, never returns it through the API and
  uses it only for confirmed DNS changes.
- Restore the previous DNS and route state when a confirmed access-link
  transaction fails.

Cloudflare is not part of the normal request path. If it is connected, it is
used to manage DNS records; the applications, routes and desired state remain
on the server.

### Codex Full Server

- Optionally install Codex CLI on the Linux host from **Settings → Connections**
  using OpenAI's official installer.
- Connect each server owner's own eligible ChatGPT account with the Codex
  device-code flow. FoxOS does not ask for or return an OpenAI API key.
- Keep access read-only after installation and login. The owner must separately
  confirm **Full Server** before the Codex application can run.
- Run Full Server threads from the real host root (`/`) with root-equivalent
  filesystem, Docker, systemd, package and network access. Codex requests
  untrusted command and file-change approvals through the authenticated FoxOS
  interface.
- Reverting to read-only stops the active Codex runtime and blocks turns on old
  Full Server threads. Disconnecting also logs the ChatGPT account out while
  leaving the optional CLI installed.

Codex authentication and session state are owned by Codex under
`/var/lib/foxos/codex` by default. The app-server is connected over private
stdio and is not exposed as a network service. Account eligibility and usage
limits remain those of the connected ChatGPT account; FoxOS does not create a
subscription or make Codex a base-install dependency.

### Updates and Compose

- Check direct tagged images against immutable registry digests without
  treating an authentication error or unknown source as "up to date".
- Detect supported Compose-built version changes, including a final Dockerfile
  base image when the running build exposes comparable version metadata.
- Apply a confirmed update to a verified Compose application together with its
  reverse-dependent sidecars.
- Apply a confirmed update to an eligible, already migrated server-owned
  single-container runtime when its upstream registry source and migration
  binding are both proven.
- Snapshot exclusive named volumes with authenticated encryption before a
  supported update, verify runtime and public health, and roll back
  automatically on failure.
- Keep an explicit manual rollback action after a successful supported update.
- Read and edit only Compose files proven by the selected container's Docker
  Compose metadata. Saves are revision-checked, YAML-validated, backed up
  encrypted and atomic; saving does not silently redeploy the application.

FoxOS blocks updates when it cannot prove the upstream image, Compose source,
storage safety, route binding or rollback target. This is intentional.

### Removal

Application deletion is separate from removing a desktop shortcut. A real
removal:

1. builds a short-lived, drift-checked plan;
2. shows the exact runtime, routes, companion services and exclusive volumes in
   scope;
3. requires the FoxOS account password;
4. removes only the confirmed, still-matching resources.

Shared volumes, bind-mounted host paths, DNS records, Compose source files and
the general Docker image cache are preserved unless a dedicated ownership proof
makes cleanup safe.

### Discovery and migration

**Settings → Server Migration** performs a read-only scan before any workload
is changed. The inventory combines:

- running and stopped Docker containers;
- Docker images, networks, volumes, mounts, ports, health and restart state;
- inactive application, service and database definitions from the optional
  Coolify migration reader;
- selected server-owned `systemd` and WireGuard resources;
- known routes, dependencies and ownership evidence.

The scan keeps repeated instances separate and explains whether each resource
is already server-owned, ready for migration, missing evidence or blocked by a
safety rule. The operator chooses which eligible resources to migrate. FoxOS
then rechecks drift and processes the selection serially with health and
rollback verification.

Supported production paths include reviewed stateless web workloads and a
bounded stateful path with named-volume restore proof. FoxOS can preserve the
old runtime as a cold rollback source while moving the active application to a
readable, controller-neutral server runtime. It does not rename applications to
`foxos-stateless-*`, expose provider UUIDs as user-facing names or require the
old provider after independence is verified.

Linux-host services are already owned by the server. They do not need a Coolify
migration; FoxOS manages only their explicitly supported lifecycle controls.

## Supported hosts

| Environment | Status | Notes |
| --- | --- | --- |
| Linux server with Docker Engine and Compose v2 | Supported | FoxOS manages the actual host |
| x86_64 or ARM64 Linux | Supported | Images must also support the host architecture |
| macOS with Docker Desktop | Not supported for host management | FoxOS would see Docker Desktop's Linux VM, not macOS |
| Windows with Docker Desktop | Not supported for host management | FoxOS would see Docker Desktop's Linux VM, not Windows |
| Linux server without Docker | Not yet supported | No native systemd-only installer exists |

FoxOS does not depend on a particular host package manager. Ubuntu, Debian,
Fedora, Rocky Linux, AlmaLinux, Arch and other distributions can work when they
provide a compatible Docker Engine, Compose v2 and the Linux namespace features
used by the agent.

## Installation

### Requirements

- A Linux server
- Docker Engine
- Docker Compose v2 (`docker compose`)
- Git
- A user that can access the Docker daemon

No domain, Cloudflare account, object-storage account, control panel or payment
method is required.

### Install the stable channel

```bash
git clone --branch main --single-branch https://github.com/OddAna/FoxOS.git
cd FoxOS
chmod +x install.sh
./install.sh
```

The installer validates Docker and Compose, prepares the local persistent data
directory, builds the FoxOS image and starts the agent. It does not install or
modify the host operating system.

For an immutable checkout of this exact release:

```bash
git clone --branch v0.0.2 --depth 1 https://github.com/OddAna/FoxOS.git
```

### Connect safely

FoxOS binds to `127.0.0.1:8080` by default because its authenticated session has
root-equivalent server access. From your own computer:

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-server-ip
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080) and create the first owner
account. Passwords must be at least 10 characters.

Do not bind FoxOS directly to a public interface without a trusted HTTPS and
network-access boundary. If you already use a private VPN or an HTTPS reverse
proxy, copy `.env.example` to `.env` and review the bind and secure-cookie
settings before recreating the agent.

### Optional FoxOS-owned public HTTPS

FoxOS can operate its own HTTPS gateway without Coolify, Cloudflare or a paid
certificate service. You need a hostname whose `A`/`AAAA` records point to the
server and inbound TCP ports `80` and `443`.

```bash
chmod +x install-gateway.sh
./install-gateway.sh
```

The gateway installer asks for the FoxOS hostname and ACME contact email. It
keeps the direct agent port on loopback, enables secure session cookies and
starts the isolated gateway on ports `80` and `443`. It is never called by the
base installer.

If another proxy already owns ports `80` and `443`, do not stop it first. Move
ingress authority only through a verified cutover so existing application
routes remain available.

## How it works

```text
Browser
  │ authenticated HTTP or HTTPS
  ▼
FoxOS-owned gateway (optional Caddy)
  │ private Compose network
  ▼
FoxOS agent (Node.js API + React interface)
  ├── host namespaces through nsenter
  ├── host filesystem mounted at /host
  ├── Docker socket mounted read/write
  ├── server-owned registry, secrets and operation history in /data
  └── sibling application containers managed through Docker Engine
```

The agent is packaged in a Debian-based container, but that container is not a
new operating system for the server. Host terminal operations enter PID 1's
namespaces and use the host's own shell, files, processes and networking.

FoxOS keeps desired state and observed state separate. A scan records what the
host and Docker currently report. A plan binds an intended change to those exact
observations. Apply rechecks for drift, performs only the approved operation and
records enough evidence to report or roll back the result.

## Persistent data

FoxOS control data is stored under `.foxos-data/` on the host and mounted as
`/data` inside the agent. It contains authentication state, desktop layout,
application identities, encrypted secrets, route state, migration evidence,
operation receipts and gateway state.

Application data remains in the application's own Docker volumes or explicit
host paths. Do not delete `.foxos-data/`, application volumes or gateway data
when rebuilding the FoxOS image.

Before major host changes, back up both:

- `.foxos-data/` and any separately configured FoxOS gateway/ingress state;
- every application volume, bind-mounted data directory and external database
  required by the applications.

Recovery configuration is intentionally explicit. A missing external recovery
adapter does not block login or ordinary management, but FoxOS may block a
destructive adoption or migration path that cannot prove a usable restore.

## Updating FoxOS

FoxOS never silently updates itself. Stable installations follow `main`; the
`v0.0.2` tag is immutable.

From an unmodified stable checkout:

```bash
git fetch origin main
git merge --ff-only origin/main
docker compose build foxos
docker compose up -d --no-deps foxos
```

Review release notes and back up `.foxos-data/` before updating. `develop` is a
preview/integration branch and is not the public stable channel.

## Operations

### Status and logs

```bash
docker compose ps
docker compose logs -f foxos
curl --fail http://127.0.0.1:8080/api/health
```

### Restart only the agent

```bash
docker compose restart foxos
```

This does not restart sibling application containers.

### Change the private port

```bash
cp .env.example .env
```

Set `FOXOS_PORT` and keep `FOXOS_BIND_ADDRESS=127.0.0.1` unless a reviewed
private-network or HTTPS design requires another bind. Then run:

```bash
docker compose up -d
```

### Reset the owner account

```bash
docker compose exec foxos node /app/server.js --reset-auth
```

Restart the agent and create a new owner account. This resets FoxOS
authentication; it does not delete applications or their data.

## Security model

FoxOS intentionally has root-equivalent host access. The agent mounts the Docker
socket, host root filesystem and host namespaces. Anyone who controls an
authenticated FoxOS session should be treated as a server administrator.

- Keep the default loopback bind or place FoxOS behind a trusted private VPN or
  properly configured HTTPS gateway.
- Use a unique owner password and protect SSH access to the server.
- Do not expose the Docker socket or FoxOS data directory to unrelated
  containers.
- Give optional provider tokens the smallest possible scope. For Cloudflare,
  use only zone read and DNS edit access for the required zones.
- Treat Full Server Codex as an authenticated root shell: review approval
  details, protect the FoxOS owner session and return Codex to read-only when
  the task is finished.
- Back up encryption and recovery material separately from the server.
- Read [SECURITY.md](SECURITY.md) before internet exposure or production
  migration.

Please report vulnerabilities privately through GitHub's security reporting
flow rather than opening a public issue with exploit details or secrets.

## Current limitations

- `v0.0.2` is alpha software intended for an informed, hands-on server owner.
- FoxOS is a single-server control plane; clustering, high availability and
  multi-user roles are not implemented.
- The agent is privileged by design. A browser or authentication compromise can
  become a full host compromise.
- Docker Engine with Compose v2 is required for installation.
- Host-service support is intentionally narrow and does not expose arbitrary
  systemd commands or WireGuard configuration.
- Discovery is broad, but migration is not universal. Unsupported mounts,
  ambiguous dependencies, missing secrets, unsafe privileges, unproven health
  or missing rollback evidence stop the operation.
- Zero-unavailable cutover is proven only for eligible stateless HTTP
  migrations. It is not a blanket guarantee for databases or every stateful
  application.
- Application updates require a provable upstream image and a supported
  Compose or migrated-runtime contract. Private registry authentication and
  arbitrary custom build systems are not a general update path yet.
- Compose editing changes source only; it does not automatically deploy the
  edited file.
- Cloudflare automation supports only the explicitly connected, accessible
  zones. Manual DNS and any other DNS provider remain valid alternatives.
- Some recovery and adoption operations require an explicitly configured
  off-host target because completing them without restore proof would be
  unsafe.
- Public `80`/`443` ingress can have only one authority at a time. Existing
  proxies must be migrated carefully before retirement.

The detailed safety contracts and remaining work are tracked in
[ARCHITECTURE.md](ARCHITECTURE.md) and [ROADMAP.md](ROADMAP.md).

## Development and releases

- `main` — current stable public alpha (`v0.0.2`)
- `develop` — active integration branch used by the development server
- `feature/*` — temporary isolated work based on `develop`
- `vX.Y.Z` — immutable released snapshots

FoxOS does not force public users to follow development. A new version reaches
`main` only after an explicitly approved release and the full validation suite.
See [DEVELOPMENT.md](DEVELOPMENT.md) for the release contract.

Local development:

```bash
git clone https://github.com/OddAna/FoxOS.git
cd FoxOS
git switch develop

cd backend
npm ci
npm test
npm run check

cd ../frontend
npm ci
npm run lint
npm run build
```

Never commit credentials, private domains, server IP addresses, application
environment values, backup material or production operation records.

## Project structure

```text
FoxOS/
├── backend/                   privileged server agent and safety transactions
├── frontend/                  desktop-style React interface
├── gateway/                   optional FoxOS-owned Caddy HTTPS gateway
├── ingress/                   server-owned application ingress
├── pilot/                     disposable validation fixtures only
├── docker-compose.yml         base agent service
├── docker-compose.gateway.yml optional public HTTPS service
├── docker-compose.ingress.yml optional application ingress service
├── install.sh                 clean base installer
├── install-gateway.sh         opt-in HTTPS installer
├── ARCHITECTURE.md            ownership and migration safety contracts
├── ROADMAP.md                 implemented and remaining milestones
├── SECURITY.md                threat model and operating guidance
└── DEVELOPMENT.md             branch, validation and release policy
```

## License

[MIT](LICENSE)
