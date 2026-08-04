# FoxOS server-owned control plane

## Core decision

FoxOS is not a second UI for another control panel. It is the server-owned
control plane. The durable description needed to run, route, update, back up
and recover a resource belongs to the server running FoxOS.

Coolify and similar products are migration inputs. FoxOS may inspect their
labels, APIs, databases and proxy configuration, but an adopted resource must
remain fully understandable and recoverable after that provider disappears.

FoxOS itself has zero Coolify runtime dependency. A clean installation and its
normal host management, authentication, deployment, routing, TLS, storage,
backup and recovery paths must not call or join Coolify APIs, databases, proxy,
networks, files or containers. Coolify support is an optional, removable
migration reader for rescuing legacy workloads; it is disabled when absent and
is never the FoxOS gateway.

## Clean-install and billing contract

A clone of the stable public branch must install on a clean supported Linux
server with only Docker Engine, Compose v2 and Docker-daemon access. Base setup
must not require an account, domain, API token, object store, DNS provider,
cloud provider, third-party panel, payment method or network call beyond pulling
the repository and container images.

FoxOS installers must never create, subscribe to or enable a remote or billable
service. External DNS, certificate, Git, registry and backup systems are
explicitly configured adapters only. `S3-compatible` is a protocol boundary,
not an AWS, Cloudflare or other vendor dependency. A missing backup adapter
blocks only operations whose safety contract requires an off-host restore proof;
it must not block startup, login, host management, Docker control, Files,
Terminal or App Store.

## Authority model

| Concern | FoxOS-owned authority | Replaceable input or adapter |
| --- | --- | --- |
| Applications and dependencies | Versioned resource manifest and relationship graph | Coolify metadata, Docker labels, Compose, catalog definitions |
| Deployments and updates | Desired revision, immutable history, health proof and rollback target | Git host, webhook, container registry, build method |
| Domains and routes | Domain-to-resource mapping, route policy and conflict state | Registrar or DNS API used to publish records |
| TLS | Certificate policy, private material location, renewal and failure state | Public certificate authority or imported certificate |
| Environment and secrets | Local environment revisions and encrypted secret references | Provider export or user-supplied value |
| Persistence | Volume/bind ownership, backup policy and restore proof | Existing provider paths or external backup target |
| Runtime | Desired resource state and reconciliation history | Docker Engine today; other runtimes may be adapters later |

Public domain registration and browser-trusted certificates necessarily involve
outside infrastructure. That does not make those providers the source of truth:
FoxOS keeps the desired records, keys, mappings, policy and recovery metadata on
the server, then applies them through a replaceable adapter. A future
self-hosted authoritative DNS adapter can use the same local records.

## Provider-neutral resource manifest

Every manageable instance receives a stable FoxOS resource ID. A versioned
manifest must describe, without provider-specific identifiers as requirements:

- resource kind and relationships;
- image digest or source/build input;
- desired revision and runtime state;
- ports, health checks and restart policy;
- domains, routes and TLS policy;
- ordinary environment values and encrypted secret references;
- volumes, bind mounts, ownership and backup policy;
- CPU, memory and storage limits;
- imported provenance, last observed state and migration status.

Provider IDs and labels are preserved only as provenance and lookup hints. They
cannot be the primary key or the only way to reconstruct a resource.

## Ownership lifecycle

1. **Observed** — FoxOS discovers a live resource and may perform only the
   already-authorized limited lifecycle actions. The external provider remains
   authoritative.
2. **Import draft** — FoxOS creates a redacted provider-neutral proposal. It
   reports missing secrets, route conflicts, storage paths and dependencies but
   changes no runtime state.
3. **Adopted** — an explicit operation stores the validated manifest, backup and
   rollback plan locally. The old runtime can still carry traffic during
   migration.
4. **FoxOS managed** — FoxOS reconciles runtime, routing, certificates,
   deployment and recovery from its own state.
5. **Independent** — removal of the old provider has passed application health,
   route/TLS, restart, update/rollback and restore verification.

Discovery never skips directly to adoption. A container is not FoxOS-owned just
because FoxOS can see or start it.

## Desired and observed state

FoxOS must keep these separate:

- **Desired state** is the local manifest and revision chosen by the operator.
- **Observed state** is what Docker, the host, a proxy or an import provider
  currently reports.
- **Plan** is a deterministic, reviewable diff between them.
- **Apply** performs only the approved plan and records each result.

This model prevents an imported provider from silently overwriting FoxOS state
and makes drift, partial migration and rollback visible.

## Local durability boundary

The implementation will keep its durable registry, manifests, revisions,
encrypted secrets, route state and audit records under the persistent FoxOS
data root (`/data` in the container and `.foxos-data/` on the host). Writes must
be atomic, schema-versioned, permission-restricted and included in backup and
restore procedures. Redacted exports must be sufficient to inspect the resource
graph without exposing secret values.

## Migration safety gates

A provider cannot be detached from a resource until FoxOS has verified:

- a complete local manifest and dependency graph;
- resolved secret references and environment configuration;
- persistent-data backup plus an actually tested restore;
- domain, route and TLS behavior;
- health check and host-restart behavior;
- a successful update/deployment and rollback path;
- a provider-independent recovery procedure.

Deleting provider data, networks, proxies or volumes is a separate destructive
operation after independence is proven. It is never part of import or adoption.

## First implementation slice

The first code milestone is deliberately read-only toward existing workloads:

1. Inventory Docker containers, images, networks, volumes, mounts, ports,
   health, restart policies and provider labels.
2. Parse existing proxy routes and group supporting containers into a resource
   relationship graph without treating them as Store applications.
3. Normalize observations into versioned provider-neutral resource records.
4. Persist a redacted local snapshot and expose it through authenticated APIs.
5. Report ownership, missing information, conflicts and adoption blockers.
6. Export a redacted migration plan that contains no secret values.
7. Cover normalization, redaction, atomic persistence and zero-mutation behavior
   with tests before adding adoption actions or UI controls.

UI work follows the data and safety contract and must preserve the existing
FoxOS visual language.

### Implemented boundary: Resource Registry v1

Resource Registry v1 implements the read-only observation half of this slice.
It stores provider-neutral resource records, stable local identities, inventory,
relationships, ownership status, blockers and conflicts under the FoxOS data
root and exposes authenticated scan/read/redacted-export APIs. A scan still
never creates desired state, changes labels or mutates Docker runtime state.

### Implemented boundary: Disposable adoption, route and recovery cutover

Disposable Adoption v1 adds the next import-draft and adoption-plan slice while
keeping real workloads out of scope. It accepts only an explicitly labeled
`foxos-adoption-lab*` application observed directly from Docker or Compose;
Coolify-managed resources and anything with routes, dependencies, conflicts,
unresolved environment overrides, dangerous host access, mutable pilot mounts
or unpinned images are rejected.

The deterministic manifest contains the immutable image digest, loopback port,
reviewed HTTP health proof, restart policy, resource limits, one named volume,
a pinned classified environment revision, encrypted secret references, a
FoxOS-owned HTTPS route and provider provenance. Provider IDs are not runtime
authority. Planning performs Docker reads only and persists no secret values.

Apply requires an exact operator confirmation and follows this transaction:

1. re-scan and reject drift from the planned source fingerprint;
2. archive the named volume, encrypt it locally, upload it to the configured
   off-host S3-compatible HTTPS target, download and authenticate it, then prove
   the downloaded archive in disposable Docker objects;
3. stop and rename the original source as a retained rollback container;
4. create the FoxOS target from the local manifest using the pinned digest,
   Docker bridge, loopback port, `no-new-privileges` and a reviewed health check;
5. attach only the target to the internal `foxos-routing` network under a fixed
   FoxOS alias;
6. publish the fixed pilot path through FoxOS Caddy and verify the public HTTPS
   response and trusted certificate before making rollback available.

Rollback verifies the FoxOS target identity, disconnects its route, proves that
the HTTPS path no longer serves the app, then removes the target, retains the
named volume, restores the original container name and state, and proves the
source runtime. Failed backup, target or route proof prevents cutover or
triggers an automatic source restoration attempt, depending on the transaction
stage. Secret values and off-host adapter credentials are decrypted only in
memory when required; local records, manifests, plans, operations and APIs
contain encrypted envelopes, references or non-sensitive metadata only. The
route record is schema-versioned under the
FoxOS data root and depends only on FoxOS Caddy, FoxOS state and Docker Engine.
This pilot does not import provider routes or TLS state, databases, write-heavy
persistence or provider networks, and it does not detach or delete provider
state. Scheduled retention, independently protected recovery-key export and
full-machine disaster restore remain outside this implemented boundary.

### Implemented boundary: Disposable source deployment

The first Milestone 5 slice is separate from migration/adoption and accepts only
the fixed `foxos-deployment-lab` canary. A generic public-HTTPS Git adapter
resolves a branch or tag to an immutable commit without using a Git-host API.
The plan also pins a deterministic bounded context digest, Dockerfile digest,
private port `8080`, HTTP path and response marker. Git provenance remains an
input; FoxOS owns the revision, operation, build log, image ID, health proof,
current pointer and rollback pointer under its local data root.

The source adapter rejects credentials, redirects, private/local repository
hosts, submodules, symlinks and oversized contexts. The reviewed Dockerfile
subset requires digest-pinned base images and rejects `ADD` and build mounts.
Builds receive no secrets, use no build network, have bounded response/log size
and timeout, and produce an immutable Docker image ID before runtime creation.

Apply follows a health-before-cutover transaction:

1. clone the public ref again and reject commit, context or Dockerfile drift;
2. build the reviewed context through Docker Engine and persist a redacted log;
3. start a resource-limited candidate on a dynamic loopback-only host port;
4. prove HTTP status plus the expected body marker while the current revision
   remains running;
5. stop and rename the previous FoxOS-owned canary only after candidate proof;
6. promote the candidate and atomically update the server-owned current record.

A failed build or candidate proof removes only the candidate. A later applied
revision retains the previous healthy container stopped under a history-only
name. Exact-confirmation rollback verifies both container identities, restores
the previous name/runtime and repeats its original health proof. This pilot has
no provider API, Coolify, route, domain, TLS, secret, persistent volume or
off-host-backup dependency and cannot deploy a real workload.

### Implemented boundary: Disposable Compose deployment graph

The second Milestone 5 slice remains separate from adoption and from the
single-container source canary. It accepts only the fixed
`foxos-compose-lab` identity and a public-Git manifest containing two or three
source-built services. FoxOS parses and normalizes the manifest; it never hands
unreviewed input to `docker compose up`.

The accepted graph has simple acyclic dependencies, one private TCP port per
service and one ingress on port `8080`. Every service must be reachable from
that ingress. Images, environment, secrets, arguments, commands, entrypoints,
host/public ports, volumes, configs, provider networks, devices, capabilities,
privileged/host namespaces and arbitrary extensions are rejected. Build
contexts remain bounded, symlink-free, digest-pinned and networkless.

FoxOS builds every service into an immutable image ID, creates a fresh isolated
bridge, starts dependencies before the ingress and publishes only the ingress
to a dynamic loopback port. All containers are read-only-root, capability-free,
`no-new-privileges` and CPU/memory/PID limited. The previous group remains
running until the ingress returns the planned HTTP status and exact body marker.

Apply jobs enter a persistent single-worker queue. Queued cancellation is
immediate; running cancellation is cooperative at safe checkpoints before
cutover. An agent restart marks an in-progress job interrupted instead of
silently replaying it. Successful cutover preserves every previous service and
its isolated network. Exact rollback identity-checks the current and previous
group, starts the previous dependency order and repeats its original ingress
proof. Owner-only state is stored under `.foxos-data/compose-deployments/`.

This boundary does not support private Git, persistence, environment/secrets,
build packs, webhooks, parallel execution, arbitrary routes or real workloads.
Its isolated bridge allows ordinary container egress; egress policy is a
separate gate before untrusted or production workloads are eligible.

### Implemented boundary: Disposable image update

The third Milestone 5 slice accepts only `foxos-image-update-lab` and the two
reviewed `traefik/whoami` tag/digest pairs in the repository canary manifest.
Docker Engine is the registry adapter. FoxOS resolves the distribution
descriptor before planning, pins its immutable repository digest and supported
platforms, resolves it again at apply, and rejects tag, plan or current-state
drift before pulling the digest reference.

Apply creates a fresh dedicated bridge and one non-root candidate. The runtime
has no mounts, host access, environment or secrets; its root filesystem is
read-only, every capability is dropped, `no-new-privileges` is set and
CPU/memory/PID limits are fixed. Only a dynamic loopback host port is published.
The current revision remains running until the candidate returns the planned
HTTP status and response marker.

Successful cutover preserves the previous container and its network under a
history-only identity. Exact rollback validates both container and network
ownership, parks the newer revision, restores the previous one and repeats its
original health proof. A failed candidate is removed with its dedicated network;
a partial promotion attempts to restore and re-prove the previous revision.
Process locking prevents concurrent image transactions, and a stale running
operation becomes an explicit interrupted record after agent restart.

Owner-only plans, immutable revisions, operation history and the current pointer
are stored under `.foxos-data/image-updates/`. The registry is replaceable input;
FoxOS state is the update and rollback authority. This fixed lab is not approval
for arbitrary image repositories, credentials, persistent applications, routes,
production workloads or Store update controls.
