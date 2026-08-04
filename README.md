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

### 1. Clone and start

```bash
git clone https://github.com/OddAna/FoxOS.git
cd FoxOS
chmod +x install.sh
./install.sh
```

The installer validates the environment and starts FoxOS. It does not install or
modify the host operating system.

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
| `GET /api/adoptions` | Read locally stored plans and operations |
| `POST /api/adoptions/plans/:planId/apply` | Apply an explicitly confirmed disposable plan |
| `POST /api/adoptions/:operationId/rollback` | Restore the preserved source container for an applied pilot operation |

Environment values, arbitrary provider labels, middleware credentials and
secret-bearing health-check commands are never copied into registry snapshots
or exports; long token-like route path segments are replaced by stable redacted
fingerprints. Stable FoxOS resource IDs survive normal container recreation by
using locally stored, hashed identity aliases. Existing external resources stay
in the `observed` stage unless an operator uses the narrowly gated disposable
adoption pilot described below.

## Disposable adoption pilot

FoxOS now has the first provider-neutral import draft, dry-run plan, apply and
rollback engine. It is intentionally **not a general migration button** and is
not exposed in the Store UI yet. The engine accepts only a resource whose name
starts with `foxos-adoption-lab`, whose
`com.foxos.adoption.disposable=true` label was deliberately set, and whose
runtime passes every pilot safety gate. Coolify-managed resources are rejected.

The included `pilot/docker-compose.adoption-lab.yml` creates the isolated test
resource. It publishes only on `127.0.0.1:18088`, uses one read-only named
volume and has no real domain route or dependency. Before runtime mutation,
FoxOS writes a versioned manifest, pins the image digest, archives the volume
and restores that archive into a temporary volume to prove it can be read back.
Only then does it stop and preserve the source container, create the
FoxOS-managed target and require a healthy result. An exact confirmation string
is required for both apply and rollback. If target verification fails, FoxOS
attempts to restore the source automatically.

The old source container is retained stopped under a distinct rollback name;
it is not shown as a second Store application. Rolling back deletes only the
FoxOS-managed target, keeps the named volume, restores the source name, starts
it if it was previously running and verifies its runtime. Pilot manifests,
plans, operation records and backup archives live under
`.foxos-data/adoption/` with owner-only permissions. See
[`pilot/README.md`](pilot/README.md) for the operator procedure.

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

Stop FoxOS and back up the local `.foxos-data/` directory. It contains the
authentication record, FoxOS desktop files, and trash.

## Current limitations

- Linux hosts only
- Docker Engine and Docker Compose v2 are required
- The terminal is command-based and not yet a full interactive PTY, so programs
  such as `vim`, `top`, and password prompts are not suitable yet
- File operations are synchronous; very large copy/move operations can take time
- No multi-user roles or permission levels
- No audit log yet
- The Resource Registry is read-only observation and migration planning; it
  does not yet adopt resources or replace provider-owned deployment/proxy state
- The App Store catalog is intentionally small and reviewed; arbitrary Compose
  files and untrusted install scripts are not accepted through the UI
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
