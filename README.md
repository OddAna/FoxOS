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
  manage the real lifecycle of FoxOS-owned installations from the original
  FoxOS store interface
- **Host terminal** — commands run directly in the Linux host namespaces
- **Host file access** — the Files app contains a `Sunucu` entry linked to
  the host root filesystem
- **Persistent FoxOS workspace** — desktop and trash data live under
  `.foxos-data/` and survive rebuilds
- **Server-side authentication** — salted scrypt password hashing, HTTP-only
  session cookies, protected management APIs, and basic login rate limiting
- **Single production service** — the React UI is built once and served by the
  Node.js agent on port `8080`

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

## How it controls the host

```text
Browser
  │  authenticated, same-origin HTTP
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
- Open **Terminal** to execute commands on the host.
- Open **Dosyalar**, then **Sunucu**, to browse the host filesystem.
- Use **Masaüstü** for FoxOS-only workspace files that should persist without
  cluttering the host root.

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
appear as installed without being re-created. These discovered applications are
read-only in the store so FoxOS cannot accidentally remove a deployment owned by
another platform. Databases, workers, agents, reverse proxies, and other internal
dependency containers are not presented as standalone store applications.

## Operations

```bash
# Status
docker compose ps

# Logs
docker compose logs -f foxos

# Restart
docker compose restart foxos

# Stop
docker compose down

# Update after pulling new code
git pull
./install.sh
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
- The App Store catalog is intentionally small and reviewed; arbitrary Compose
  files and untrusted install scripts are not accepted through the UI
- App Store images are maintained by their respective third-party projects, not
  by FoxOS
- HTTPS must be provided by a reverse proxy or private access layer

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
├── install.sh                 # Environment checks and startup
├── SECURITY.md                # Deployment and disclosure guidance
├── backend/
│   ├── server.js              # Auth, files, host terminal, metrics, Docker API
│   ├── appCatalog.js          # Reviewed application definitions
│   ├── appManager.js          # Docker app validation and container payloads
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
