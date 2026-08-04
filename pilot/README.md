# Disposable adoption pilot

This directory contains the only workload accepted by FoxOS Disposable
Adoption v1. It is test infrastructure, not a template for production apps.

## Safety boundary

- exact `foxos-adoption-lab*` name;
- explicit `com.foxos.adoption.disposable=true` label;
- direct Docker or Compose observation, never Coolify-managed;
- one loopback-only TCP port;
- one read-only named volume;
- no existing provider route, dependency, conflict or privileged access;
- every environment override classified in a pinned FoxOS environment revision;
- encrypted off-host backup configured and ready;
- immutable repository digest available before planning.

Do not put real data in this resource and do not apply the disposable label to
a real workload.

## Run the lab

```bash
umask 077
openssl rand -hex 32 > /tmp/foxos-pilot-token
FOXOS_PILOT_TOKEN="$(< /tmp/foxos-pilot-token)" \
  docker compose -f pilot/docker-compose.adoption-lab.yml up -d --pull always
docker compose -f pilot/docker-compose.adoption-lab.yml ps
```

The source web test listens only at `http://127.0.0.1:18088` on the server.
With the FoxOS gateway installed, a successful apply publishes the target at
`https://<FOXOS_DOMAIN>:<FOXOS_HTTPS_PORT>/_foxos/apps/foxos-adoption-lab/`.

## Classify the environment

Run a Resource Registry scan and take the lab's `res_...` ID from the result.
Store the disposable token as an encrypted secret, then pin both overrides to
that resource. Values are read from the temporary file but are never returned
by the secret CLI.

```bash
DATA_ROOT=.foxos-data node backend/secretCli.js put pilot-token \
  --value-file /tmp/foxos-pilot-token

DATA_ROOT=.foxos-data node backend/secretCli.js environment RESOURCE_ID \
  --ordinary FOXOS_PILOT_MODE=disposable \
  --secret FOXOS_PILOT_TOKEN=pilot-token

rm -f /tmp/foxos-pilot-token
```

Configure the off-host S3-compatible target with
`backend/recoveryCli.js configure-s3` as documented in the main README. The
access identity should have object read/write access to only the FoxOS backup
bucket. Planning remains blocked until this target is ready.

## Plan, apply and roll back

Run these commands from the FoxOS repository. The CLI uses the same local
manager and data root as the authenticated API; inside the FoxOS container its
data root is `/data`.

```bash
DATA_ROOT=.foxos-data node backend/adoptionCli.js plan foxos-adoption-lab \
  --confirm-disposable --health-port 80 --health-path /

DATA_ROOT=.foxos-data node backend/adoptionCli.js apply PLAN_ID \
  --confirm "ADOPT DISPOSABLE RESOURCE_ID"

DATA_ROOT=.foxos-data node backend/adoptionCli.js rollback OPERATION_ID \
  --confirm "ROLLBACK OPERATION_ID"
```

Use the exact IDs and confirmation text printed by the preceding command. A
ready plan changes no runtime state. Apply encrypts the volume archive before
local persistence or upload, downloads and authenticates the remote object,
proves the downloaded archive in a temporary volume, injects the pinned
environment revision, preserves the original source as a stopped rollback
container, verifies the new target, attaches it to the FoxOS-owned routing
network and proves its HTTPS route. Rollback first removes and verifies the
route, then restores the source and verifies it. The FoxOS gateway must be
installed before creating this plan.

## Remove the lab

Roll back any applied operation first. Then remove only the disposable Compose
project and its test volume:

```bash
docker compose -f pilot/docker-compose.adoption-lab.yml down --volumes
```
