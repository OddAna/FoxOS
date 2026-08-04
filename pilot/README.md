# Disposable adoption pilot

This directory contains the only workload accepted by FoxOS Disposable
Adoption v1. It is test infrastructure, not a template for production apps.

## Safety boundary

- exact `foxos-adoption-lab*` name;
- explicit `com.foxos.adoption.disposable=true` label;
- direct Docker or Compose observation, never Coolify-managed;
- one loopback-only TCP port;
- one read-only named volume;
- no existing provider route, dependency, conflict, environment override or
  privileged access;
- immutable repository digest available before planning.

Do not put real data in this resource and do not apply the disposable label to
a real workload.

## Run the lab

```bash
docker compose -f pilot/docker-compose.adoption-lab.yml up -d --pull always
docker compose -f pilot/docker-compose.adoption-lab.yml ps
```

The source web test listens only at `http://127.0.0.1:18088` on the server.
With the FoxOS gateway installed, a successful apply publishes the target at
`https://<FOXOS_DOMAIN>:<FOXOS_HTTPS_PORT>/_foxos/apps/foxos-adoption-lab/`.

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
ready plan changes no runtime state. Apply first proves backup restore, then
preserves the original source as a stopped rollback container, verifies the new
target, attaches it to the FoxOS-owned routing network and proves its HTTPS
route. Rollback first removes and verifies the route, then restores the source
and verifies it. The FoxOS gateway must be installed before creating this plan.

## Remove the lab

Roll back any applied operation first. Then remove only the disposable Compose
project and its test volume:

```bash
docker compose -f pilot/docker-compose.adoption-lab.yml down --volumes
```
