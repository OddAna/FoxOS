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
docker compose exec -T foxos node /app/secretCli.js put pilot-token \
  --value-stdin < /tmp/foxos-pilot-token

docker compose exec -T foxos node /app/secretCli.js environment RESOURCE_ID \
  --ordinary FOXOS_PILOT_MODE=disposable \
  --secret FOXOS_PILOT_TOKEN=pilot-token

rm -f /tmp/foxos-pilot-token
```

Configure the off-host S3-compatible target with
`backend/recoveryCli.js configure-s3` as documented in the main README. The
access identity should have object read/write access to only the FoxOS backup
bucket. Planning remains blocked until this target is ready.

## Plan, apply and roll back

Run these commands from the FoxOS repository. They execute inside the running
agent so route verification uses the FoxOS-owned internal network and the same
`/data` state as the authenticated API.

```bash
docker compose exec -T foxos node /app/adoptionCli.js plan foxos-adoption-lab \
  --confirm-disposable --health-port 80 --health-path /

docker compose exec -T foxos node /app/adoptionCli.js apply PLAN_ID \
  --confirm "ADOPT DISPOSABLE RESOURCE_ID"

docker compose exec -T foxos node /app/adoptionCli.js rollback OPERATION_ID \
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

## Disposable source deployment canary

`source-deployment-canary/v1` and `v2` are the only reviewed contexts intended
for Source Deployment v1. They are tiny dependency-free Node HTTP servers built
from the same digest-pinned base image and differ only in their response marker.
They contain no persistence, environment values, secrets, routes or provider
configuration.

The source flow is not an adoption flow: it creates only the fixed
`foxos-deployment-lab` FoxOS-owned canary. It resolves the public repository ref
to a commit, pins both context and Dockerfile digests, builds without network or
secrets, starts a loopback-only candidate, proves the marker, and only then
preserves/promotes the active revision. Apply v1, then v2, then roll back the v2
operation to prove restoration of v1. Exact commands and confirmation strings
are in the main README.

Do not copy production code, credentials or real data into these directories.
Do not rename another container to `foxos-deployment-lab` or reuse its
`com.foxos.deployment.disposable=true` label.

## Disposable Compose deployment canary

`compose-deployment-canary/v1` and `v2` are the only reviewed graphs intended
for the strict Compose pilot. Each graph contains a `web` ingress and an `api`
dependency, both built from small digest-pinned Dockerfiles. The web response
includes the API version, so the health proof verifies both service startup and
the isolated service-name dependency path.

FoxOS parses these manifests itself. It does not run `docker compose up` and it
does not accept the normal Compose surface: no images, environment, secrets,
args, commands, published ports, volumes, configs, custom networks, privilege
or host access. It builds both services without build networking, creates only
the fixed `foxos-compose-lab*` containers and project network, exposes only the
web ingress on dynamic loopback and processes apply through the persisted
serial queue.

Apply v1, then v2, then roll back the v2 operation. A successful proof ends with
both v1 services running and both v2 services parked as rollback history. Exact
commands and confirmations are in the main README. Do not put real code, data
or credentials in this graph and do not reuse
`com.foxos.compose-deployment.disposable=true` outside this pilot.

## Disposable image update canary

`image-update-canary.json` records the only repository, tag/digest pairs,
runtime constraints and health marker accepted by the first controlled image
update proof. FoxOS resolves each reviewed tag through Docker Engine, pins and
pulls its immutable digest, starts a constrained loopback-only candidate, and
preserves the previous healthy container and its dedicated network for exact
rollback.

Apply `v1.10.3`, then `v1.11.0`, then roll back the second operation. The final
active digest and HTTP proof must match `v1.10.3`; the newer revision remains
stopped as history. Exact commands and confirmations are in the main README.

This canary has no persistence, credentials, secrets, environment, domain,
provider network or production data. Do not reuse
`com.foxos.image-update.disposable=true` on another container and do not expand
the reviewed tag set without repeating digest, platform, runtime, health,
cutover and rollback review.
