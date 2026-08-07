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

The observation boundary now has three independent readers. Docker inventory
uses `GET /containers/json?all=1`, so stopped containers remain visible. An
optional Coolify migration reader uses an encrypted local token to project only
safe application/service/database definition fields; it recovers inactive
definitions that have no remaining container and never becomes runtime
authority. A fixed Linux-host reader observes administrator systemd units and
WireGuard interface/unit/config-file presence. It does not read service file
contents, WireGuard configuration contents, keys, peers, addresses or endpoints.
If the optional Coolify reader is not configured, no Coolify request is made and
normal FoxOS discovery remains Docker- and host-owned.

### Implemented boundary: Server-owned access links for observed web apps

FoxOS may give a discovered, running web application multiple server-owned HTTPS
access links without first claiming ownership of the workload. This is a narrow
routing capability, not adoption: the provider's existing route, metadata,
network and runtime authority remain untouched and the application stays
`observed`.

Planning accepts only a stable Registry resource ID, the exact running container
ID and one unambiguous private TCP web port. It performs public DNS and route
collision checks without Docker or ingress mutation. Apply rechecks the same
container and Registry binding under the persistent operation lock, verifies the
internal labeled routing network, connects only that container under a
deterministic private alias, stages the new Caddy route and proves route identity,
TLS and application response both internally and through the resolved public
address. The desired access-link record and exact target container binding are
stored locally under the FoxOS data root.

The previous provider address and every earlier server-owned alias remain live;
the newest verified link becomes the displayed primary address. The authenticated
application page lists all active links and performs read-only planning when the
operator clicks **Ekle**, so a validation error is reported before any mutation.
Failed proof removes only the newly staged route and the exact network
attachment created by the operation. Explicit rollback restores the previous
FoxOS access route, or deletes the preference and returns to the observed
provider address when this was the first FoxOS link. A recreated container,
missing route attachment, ambiguous multi-port service, stopped workload or
Registry drift fails closed instead of silently pointing the saved link at a
different process. No Coolify API, proxy, network or metadata write is part of
this path.

An optional provider-neutral DNS automation boundary now backs the same access-
link transaction. Its first adapter is Cloudflare and is configured only through
the authenticated **Bağlantılar** page. The restricted API Token is encrypted
with the server-local AES-256-GCM master key, stored with owner-only permissions
and never included in a status, plan or operation response. The server keeps the
desired hostname, address, route and exact prior-record snapshot as its own
transaction state; Cloudflare is only the replaceable mechanism used to publish
that state.

Planning lists only the exact hostname records and performs no DNS write. Apply
revalidates the token connection, zone, public IPv4 and record fingerprint before
creating or updating one DNS-only A record and removing exact-hostname AAAA
records. CNAME conflicts, multiple A records, inaccessible zones and record drift
fail closed. A failed DNS, TLS, route or application proof restores the prior A
and AAAA snapshot before removing the staged route; explicit rollback uses the
same drift-checked DNS receipt. Disconnecting the adapter deletes only the local
encrypted token/configuration and preserves published DNS records. Clean install,
startup and ordinary host management still require no Cloudflare account, API
token, network call or paid service.

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

### Implemented boundary: Application shortcuts, updates and Compose source editing

The canonical application inventory now carries one server-persisted desktop
shortcut preference per stable application ID. Hiding a shortcut changes only
that projection. It creates or deletes no host file, image, container, volume,
route or application and remains stable across browsers and agent rebuilds.

The same inventory includes inactive application, service and database
definitions recovered by an optional migration reader even when they have no
current Docker container. These are truthful installation records, not invented
runtimes: they report stopped, expose declared non-secret type/address metadata,
remain off the desktop by default and have no start/stop/restart, update-check,
Compose or route capability until reconstruction produces a verifiable runtime.
An operator may explicitly create a desktop shortcut to the record. Duplicate
metadata-less definitions use stable resource identity and readable ordinals;
provider UUIDs never become their primary name.

Host-native records discovered by the Linux reader are projected into the same
Application Manager with their stable resource ID, systemd unit and observed
active/failed/stopped state. They remain off the desktop by default and do not
receive Docker lifecycle, update, Compose or route capabilities. This is an
inventory projection only: it does not read unit contents, WireGuard
configuration or key material and does not adopt or mutate a host service.
Host-service management requires the dedicated manifest, continuity and exact
rollback gates tracked in the roadmap.

The application update check remains separate from every apply transaction and
performs Docker and registry reads only. A
direct tagged image is compared by repository digest. For a Compose-built
service, FoxOS resolves only the exact Compose files and service recorded in the
container labels, follows the final external Dockerfile base, and may compare
the running image's OCI version with anonymous public Docker Hub metadata. It
does not pull an image, populate the image cache, build, restart, recreate,
change desired state or claim that an ambiguous source is current. When it
finds a verified update, the UI creates a separate no-mutation application
update plan and asks for explicit confirmation.

The confirmed application update transaction currently accepts only an exact,
running Docker Compose project resolved from the selected container's labels.
It binds the current container and image identities, Compose file revisions and
remote digest; selects the application service plus transitive reverse-dependent
sidecars; and rejects scaled services, writable bind mounts, FoxOS core and
`/opt/foxos`. Previous image IDs receive local recovery tags before build/pull.
After preparation, the bounded service group stops and each writable named
volume is streamed through AES-256-GCM into owner-only local state. Compose then
recreates the exact service group and must prove Docker health plus the public
endpoint. Any failed cutover restores the encrypted pre-update volume snapshots
and prior images automatically. A completed operation retains the same evidence
for an explicit manual rollback. Only one application update may mutate the
server at a time.

The Compose editor is an authenticated source-file operation, not deployment or
ownership adoption. File paths come only from `com.docker.compose.*` metadata;
the client cannot supply a path. Sources must be bounded regular YAML files
under the mounted host root. FoxOS core containers and `/opt/foxos` are blocked.
Every write requires the last-read content digest, bounded YAML parsing, a
surviving selected service and explicit UI confirmation. The previous plaintext
is encrypted with the server master key into owner-only FoxOS state before an
atomic replacement preserving the original owner and mode. The operation record
contains fingerprints and metadata, never Compose content.

Saving a Compose source does not run `docker compose`, pull, build, restart or
recreate a service. The update transaction is a separate operation and never
interprets an editor save as deployment approval. An external-provider path
remains externally authoritative and is marked as overwrite-prone until
migration produces a server-owned manifest/source. Direct-container updates,
writable-bind restoration, scaled Compose services and host-service updates
remain incomplete safety contracts.

### Implemented boundary: Application Manifest

Application Manifest joins the previously separate resource, environment,
secret-reference, route, recovery, image-operation, source-deployment and
Compose-deployment records into one local desired-state document per stable
resource ID. Docker, Compose and Coolify data remain observed inputs and
provenance; no provider identifier is required by the desired document.

The compiler reads the latest registry snapshot and FoxOS-owned records. It
persists an owner-only import draft containing one immutable source union:
repository-digest OCI, the fixed public-Git build revision, or a service within
the fixed strict Compose graph revision. The same document includes runtime
state and limits, environment revision reference, encrypted secret metadata,
persistence policy, FoxOS route/TLS references, dependencies and
health/update/rollback evidence. Ordinary environment values remain in the
environment revision; secret values remain encrypted and neither appears in
the manifest API or files.

Every Compose service retains a separate stable resource ID and embeds the same
immutable graph digest, manifest digest, service build inputs and current image
IDs. Only normalized `depends_on` edges are required manifest dependencies and
are finalized in dependency order. Shared Docker networks, volumes and provider
projects remain observed relationships; they do not invent dependency direction
or imply ownership.

Import drafting never writes to Docker or a provider. Finalization also makes
no runtime change: it is allowed only for an already FoxOS-managed resource
whose complete evidence passes every gate, then writes an immutable revision
and current pointer under `.foxos-data/application-manifests/`. An external
workload remains blocked on external authority plus any missing image,
environment, dependency, route, persistence/restore, resource-limit, health or
update/rollback evidence. Adoption, reconciliation and provider detachment are
separate future transactions.

### Implemented boundary: deterministic workload classification and read-only independence audit

Resource Registry records separate three concepts that cannot safely be
collapsed into one role string. `workloadRole` describes application, database,
worker, agent, proxy, core, internal service or unknown behavior. `stateClass`
describes stateless, stateful, database or unknown storage behavior.
`authorityClass` independently records FoxOS-owned or provider-owned authority.

The classifier is a pure local function over redacted observations. Trusted
safe labels and explicit FoxOS identities outrank image/name heuristics;
database, agent and worker evidence is role-specific; published routes/ports
identify application surfaces; writable mounts identify stateful resources.
Incomplete inspection and unknown mounts produce `unknown`. Every result has a
stable revision and reason codes. It neither changes the legacy observed role
nor treats shared networks/projects as directed dependencies.

Application Manifest schema 2 embeds the classification revision. Only
classified `application` and `internal-service` roles can finalize through the
current lifecycle. Database and other unsupported roles fail closed even when
their other evidence looks complete. The source union accepts OCI, FoxOS-owned
public-Git/strict-Compose deployment revisions and the authenticated encrypted
workload-source archive described below.

The independence-audit manager considers only running, fully inspected,
provider-owned stateless applications as read-only candidates. It compiles the
current manifest gates into an owner-only checklist covering source,
environment/secrets, routes/TLS, dependencies, runtime/health/update and
backup/restore. Report creation writes metadata but performs no Docker request,
route mutation, provider call, apply approval or detach approval. This creates
a reviewable first-real-workload planning surface without widening the fixed
disposable adoption or deployment pilots.

### Implemented boundary: Resource Migration Orchestrator v1 planning

The first orchestrator slice compiles the latest Resource Registry snapshot and
every provider-neutral Application Manifest into one deterministic whole-server
migration plan. It does not invent a second source of resource truth. Each
resource entry carries its stable FoxOS ID, classification, observed authority,
target lifecycle, migration strategy, availability contract, redacted manifest
evidence, observed relationships/conflicts and separate authority, evidence and
implementation blockers.

Strategies are selected by resource class rather than product name. Stateless
applications and internal services require a zero-pause blue/green plus atomic
route transaction. Stateful applications currently require a separately
approved bounded-quiesce budget and preserve zero-downtime continuous sync or
application-aware replication as post-roadmap work. Databases require a
database-specific consistent backup/replication and primary-handoff policy.
Workers and agents require drain semantics; provider proxies retire last.
Inactive provider definitions use a separate recovery strategy, and host-native
network/systemd resources use separate adoption strategies. Protected and
unknown resources fail closed with a concrete evidence or implementation
blocker rather than being flattened into an unexplained version-unsupported
bucket.

The planner treats shared networks, volumes and provider projects only as
coordination hints. They do not create dependency direction or execution order.
Only explicit manifest dependencies may become ordering authority. The
displayed planning order is deterministic but is never represented as an apply
order.

Planning requires an exact confirmation, persists one owner-only plan under
`.foxos-data/migration-orchestrator/`, and returns the same plan ID for the same
compiled snapshot. It performs no Docker request itself, changes no runtime,
route or provider state, contains no ordinary environment or secret values and
has no apply endpoint. A resource whose evidence is complete is reported as
`evidence-complete-apply-unavailable`, never as migrated or approved.

Selection for preparation is deliberately earlier than execution readiness. A
running, fully inspected, provider-owned stateless application may be marked
`reviewEligible` and selected so the operator can work through its missing
source, environment, route and proof requirements. `evidenceComplete` remains a
separate, stricter state. Selection changes no runtime and can never bypass the
one-time authenticated approval or execution preflight gates.

### Implemented boundary: stateless production transaction

The apply-side transaction accepts only an unprotected, provider-owned resource
classified as `stateless` with the
`blue-green-atomic-route` strategy. Planning binds the whole-server plan,
registry snapshot, manifest evidence, classification, dependencies and
conflicts into a deterministic evidence fingerprint.

The production adapter creates a separate constrained Docker candidate from the
exact content-addressed image, resolves encrypted environment references only
in memory, and places the candidate on FoxOS-owned internal routing plus a
dedicated egress network. Server-local URL dependencies are reached through
operation-scoped TCP bridges that span the observed source network and
`foxos-routing`; the candidate itself never joins a provider network. Bridge
aliases include the operation identity so common names such as `db` cannot
cross-connect unrelated migrations.

The application runtime itself receives a user-readable, controller-neutral
`<domain-or-app>` identity. FoxOS prefers the clearest reviewed public
domain, ignores temporary `sslip.io`, `nip.io` and test domains, and otherwise
uses the observed application service name. Migration mode and operation hashes
remain internal evidence; they are not exposed as the application's name.
Required TCP helpers follow `<app>-<service>-bridge` so a supporting Postgres or
Redis bridge is attributable without exposing a provider or controller brand.

Candidate startup is not copied blindly from a mutable process title or a
provider wrapper. FoxOS verifies that an observed argv begins with an executable
inside the source container and preserves its current working directory. For a
Next standalone runtime whose process deliberately overwrites `/proc/1/cmdline`
with a `next-server` title, FoxOS binds the observed executable, observed
standalone working directory and existing `server.js` directly, avoiding a
wrapper that may rerun database migrations. Unsupported titles fail closed with
an actionable, allowlisted operation error before route or traffic mutation.

FoxOS Caddy owns candidate routes and future ACME HTTP-01 renewal. For the first
legacy adapter, the exact matching browser-trusted certificate is imported from
readable Traefik ACME storage as one-time migration input without calling a
provider API or mutating the legacy proxy. FoxOS-owned HAProxy listens on
separate host ports and selects `foxos` or `legacy` per SNI/Host through a
runtime map. A temporary FoxOS TCP bridge carries unselected domains to the
still-running legacy proxy. Reversible host `iptables`/`ip6tables` chains place
HAProxy in front only at the traffic-switch phase.

The host ingress rule follows the firewall backend that owns Docker's active
`DOCKER` NAT chain instead of assuming that the system default, `legacy`, or
`nft` frontend is authoritative. When server-owned public authority is already
recorded, agent startup revalidates the owned gateway and ingress containers
and reasserts the reversible IPv4/IPv6 redirect on that active backend. The
resulting data path remains in the kernel and the separately running routing
containers; stopping the management agent does not remove it.

Execution proves candidate health before staging, validates TLS directly at
Caddy, then requires eight public browser-trusted samples to contain both the
expected FoxOS route identity and operation-bound candidate identity. One
unavailable or mismatched sample is failure and triggers automatic map rollback,
public source verification and exact operation-owned cleanup.

Candidate readiness is a bounded polling gate, not a single probe immediately
after Docker reports the process as running. For up to 30 seconds FoxOS probes
from the owned routing gateway, accepts only the reviewed `200-399` status
range, and exits early if the candidate process stops. The operation-scoped
adapter record retains only attempt count, HTTP status, running/exit/OOM state
and timestamps. It never stores a response body, header, environment value or
secret. A failed parent run keeps the exact stateless operation ID so the
owner-only diagnostic record remains traceable after candidate cleanup.

Every apply or rollback also requires a short-lived, one-time approval grant
whose source is `foxos-ui` and whose plan ID, resource ID and evidence
fingerprint match exactly. Raw approval material is never stored; only a
fingerprint and bounded metadata may enter the owner-only operation record.
Adapter proof objects are allowlisted before persistence so an unexpected
credential, environment value or response header cannot leak into plans,
operations, APIs or CLI output.

The adapter contract deliberately contains no pre-cutover source stop, source
recreation, provider mutation, provider detach or destructive source cleanup
capability. The original container remains continuously running through the
zero-unavailable traffic proof. After that proof, FoxOS may park only that exact
container as a stopped cold rollback target while retaining its image, metadata,
provider network and identity. Rollback starts and warms the exact source
through the preserved legacy proxy before switching traffic. The legacy proxy
remains running for unselected routes. Startup never replays an interrupted
operation; recovery requires a new explicit UI action.

The independent disposable Docker lab remains a regression adapter. It pulls
one reviewed immutable image digest, creates a separately
constrained candidate and an operation-owned TLS gateway on loopback ports,
uses only a reserved `.foxos.invalid` hostname and operation-scoped path, pins
the ephemeral certificate and hostname, and samples route availability and
upstream identity every 10 ms across the switch. Source container ID,
`StartedAt` and restart count remain invariant. The proof covers a clean switch
with zero unavailable samples, explicit rollback, an injected unavailable
sample with verified automatic rollback, and exact labeled cleanup.
It cannot accept a real domain or authorize a production transition.

### Implemented boundary: server-owned workload source and environment evidence

The workload-evidence source path is restricted to the same running, fully
inspected, provider-owned stateless application candidates used by read-only
independence audits. Environment-only evidence also accepts fully inspected,
running, provider-owned stateful applications. This does not expand source,
persistence, deployment or cutover authority: it creates local migration
evidence and never adopts the resource or changes runtime, route, provider or
detach state.

A source plan resolves a credential-free or encrypted-credential HTTPS Git ref
to an immutable commit and hashes a bounded, symlink-free context and
Dockerfile. Private credentials are revision-pinned encrypted secret references.
Git receives the decrypted value only through a temporary `askpass` environment,
never through a URL or process argument. Exact-confirmation capture reclones and
rejects drift, creates the bounded context archive, encrypts it with the local
FoxOS key, writes owner-only ciphertext and immediately decrypts/authenticates
the stored result. The current revision is therefore reconstructable from local
FoxOS state even when the Git adapter is unavailable.

An environment plan reads the exact observed container once through Docker
`GET`. It stores names, classification and a server-keyed fingerprint, not
values. Exact-confirmation capture repeats the read, rejects container or
environment drift, writes ordinary configuration to a local environment
revision and converts every sensitive or explicitly classified name into an
encrypted secret revision. Returned plans, captures, manifests and audits expose
names/references only. Provider-injected `COOLIFY_*`, `SERVICE_FQDN_*`,
`SERVICE_URL_*` and `SERVICE_NAME_*` variables are retained only as
excluded-name evidence with `provider-runtime-metadata` reason codes; their
values and provider-specific desired configuration are not carried forward.

The source archive is immutable source evidence, not proof that the provider's
current image came from that source. Application Manifest records
`source-runtime-binding-missing` until a later FoxOS build produces an immutable
image, verifies health and proves update/rollback. External provider authority
also remains blocking. This boundary therefore improves independence evidence
without widening production deployment or cutover authority.

### Implemented boundary: stateful restore rehearsal

The stateful-rehearsal manager is the first production-resource mutation that
addresses one persistence gate without taking workload authority. It accepts
only a running, fully inspected, provider-owned `application` classified as
`stateful`, with one to four writable named volumes, an existing healthy Docker
health check or an explicit bounded internal HTTP path, a captured FoxOS
environment revision and an explicitly selected observed TCP port. The HTTP
fallback requests only the temporary candidate's Docker-observed private address
on the FoxOS-created, verified internal network; it publishes no host port and
accepts neither arbitrary hosts nor commands. Every named volume must be
classified as persistent or empty-ephemeral. Databases,
bind/unknown/read-only mounts, protected resources, custom
command/entrypoint/user/workdir overrides and privileged or host-level runtime
access are outside this boundary.

Planning is read-only and stores resource/runtime/environment/health
fingerprints plus names and references, never environment or secret values. An
operation-specific confirmation starts a second drift check. FoxOS persists the
pause intent, briefly pauses the exact source container while reading bounded
volume archives and unpauses in an immediate cleanup path. It does not stop,
recreate, rename or relabel the source and makes no route, traffic, provider or
detach change.

Persistent archives are authenticated server-local AES-256-GCM ciphertext. A
temporary candidate uses the exact observed image ID, the resolved FoxOS-managed
environment in memory, temporary named volumes, an internal Docker bridge and a
private RFC1918 address with no published host port and fixed CPU, memory and PID
limits. Restored content digests, candidate health/isolation and source health
must all pass. Every exact temporary container, volume and network is then
removed before a current proof is published. Crash recovery can unpause and
clean recorded objects but never replays an interrupted transaction.

Application Manifest may use a matching current proof to close only
`restore-proof-missing`. The proof fingerprint intentionally excludes volatile
uptime and health-status text while binding stable resource identity,
classification, container/image, mounts, ports, constraints and environment
evidence. `recovery-target-unavailable` remains blocking because the archive and
master key are on the same host. Off-host recovery, retention, key escrow,
database consistency, route cutover, provider detachment and full-machine
disaster recovery remain separate unimplemented gates.

### Implemented boundary: persistent stateful shadow

The stateful-shadow manager turns a current authenticated stateful-rehearsal
snapshot into a persistent but non-authoritative FoxOS runtime. It is generic to
the rehearsal contract and does not contain a Beszel-, Coolify- or provider-
specific deployment path. Planning binds the source resource fingerprint,
container and immutable image IDs, FoxOS environment revision, rehearsal
operation, volume policies, archive digests, private port and health contract.
An operation-specific exact confirmation revalidates all of them.

The source is read through Docker `GET` only and is never paused, stopped,
recreated, renamed, relabeled or detached. The shadow receives a distinct,
deterministic FoxOS resource ID plus separate named volumes and an internal-only
bridge. It publishes no host port, joins no external or provider network, creates
no route and receives no production traffic. Provider-injected environment
metadata classified as excluded is not copied. Persistent data comes from the
rehearsal's authenticated encrypted point-in-time archive; plaintext exists only
in memory during restore.

The shadow uses the exact observed image, a resilient `unless-stopped` policy,
`no-new-privileges` and fixed CPU, memory and PID limits. Restored content,
health, internal address, absent port bindings, labels, limits, mounts and
network isolation must pass before a new read-only Resource Registry scan may
recognize the distinct FoxOS identity. Only that registry-verified record is a
current shadow proof. Store discovery excludes shadow containers so a no-traffic
copy cannot replace or duplicate the user-facing source application.

Application Manifest may use a matching current shadow to close
`foxos-health-proof-missing` and `runtime-resource-limits-missing` with tested
FoxOS-owned desired-state evidence. It does not close
`external-provider-authority`, `foxos-route-missing`,
`recovery-target-unavailable` or `update-rollback-proof-missing`. It is neither
live replication nor cutover: later source writes are not synchronized and the
provider remains authoritative. Failure and startup recovery remove only exact
resources recorded as created by the interrupted shadow operation and never
replay it.

### Implemented boundary: controlled stateful shadow refresh

The refresh path consumes a newer authenticated stateful-rehearsal proof for the
same source identity, image, environment revision, health contract and volume
classification. It never mutates the active shadow volumes in place. A refresh
plan binds the current shadow operation/fingerprint and the newer rehearsal,
then allocates separately named candidate volumes, network and container while
preserving the same stable FoxOS shadow resource ID.

The previous healthy shadow remains running and current while the new generation
is restored, digest-checked, started on its own internal-only bridge and verified
for exact labels, mounts, restart policy, security and CPU/memory/PID limits. A
fresh Resource Registry scan must identify the candidate container under the
stable shadow resource ID before the current pointer can change. Both generations
may therefore be observed briefly during proof, but the pointer still names the
old container until candidate verification succeeds.

Promotion atomically writes the new current record before deleting anything from
the previous generation. Cleanup checks the exact previous operation label on
every container, volume and network; foreign or raced objects are preserved and
reported as cleanup-required. Before promotion, any failure removes only the
candidate. Startup recovery reads the current pointer: an unpromoted interrupted
candidate is removed, while an already promoted generation is kept and only the
previous exact-owned objects are reconciled.

Refresh is explicitly a newer point-in-time snapshot, not live replication.
`finalSynchronizationProven` remains false and source writes may continue after
the separate rehearsal pause. The path creates no route, changes no traffic,
calls no provider control plane and authorizes no provider detach. Final source
quiesce/synchronization must be coupled to a later reversible FoxOS-owned route
cutover transaction rather than inferred from this refresh proof.

### Implemented boundary: reversible stateful cutover rehearsal

The first stateful cutover transaction extends the reusable restore rehearsal
without claiming production authority. Planning is Docker-GET-only, requires a
separate exact confirmation and binds the same resource/container/image,
environment, health, private-port and volume-policy evidence. The initial
reviewed canary is deliberately restricted to private port `8090` and the fixed
FoxOS gateway path `/_foxos/migrations/stateful-cutover/_/`; general domains and
arbitrary upstream ports remain outside this boundary.

At apply, the source stays paused from archive capture through authenticated
restore, candidate health, temporary connection of that exact operation-labeled
candidate to the internal FoxOS routing network, authorized HTTPS proof and
verified route removal. Only after the public canary path is unavailable again
does FoxOS unpause and re-prove the original source. No host port is published,
the real application domain and DNS are unchanged, no provider API or metadata
is mutated, and the temporary candidate, volumes and network are removed after
proof.

The operation records `coupledCutoverRehearsalProven=true` only when both route
activation and rollback succeed while the source remains paused. It always
records `productionTrafficCutover=false` and
`finalSynchronizationProven=false` after rollback, so it cannot close the real
route or external-authority blockers. If route removal cannot be proved, source
availability is restored but candidate cleanup is deferred; new rehearsals are
blocked until startup recovery retries route removal and exact cleanup. An
interrupted transaction is never replayed.

### Implemented boundary: generic stateless manifest execution contract

The normal stateless planning path now recompiles the latest Application
Manifest immediately before it creates a review plan. The registry snapshot,
whole-server plan evidence and manifest revision must match exactly; drift or a
corrupt identity fails before any contract is written. The source boundary
accepts an immutable OCI repository digest or the exact local content-addressed
Docker image ID bound to the observed running container. Writable mounts,
required dependency transactions,
privileged runtimes, incomplete inspection, invalid or redacted routes and
ambiguous upstream ports remain blocking.

Resource Registry retains the private service port published by Traefik's
provider-neutral router-to-service labels. The compiler can therefore preserve
multiple domain/path routes and bind each route to its exact container port
without copying provider credentials or making the provider an authority. Every
compiled route requires HTTP-to-HTTPS redirect, FoxOS-owned desired authority,
browser-trusted TLS and an explicit replaceable certificate adapter selection.
No Cloudflare, DNS vendor, certificate authority or paid service is selected by
the contract.

The candidate specification contains the immutable image ID, no host ports, no
writable mounts, explicit or conservative reviewable CPU/memory/PID limits,
resilient restart policy, non-privileged execution, no-new-privileges and
dropped capabilities. Environment state contains only ordinary names,
revision-pinned encrypted secret references and allowlisted provider-metadata
exclusions. Values are resolved only during a later candidate-creation
transaction and never enter the plan, API, fingerprint or operation record.

Application Manifest blockers that the blue/green transaction itself must prove
are separated from true preconditions. Route ownership, candidate health,
restart policy, candidate limits, exact rollback and the external-authority
transition no longer create a planning catch-22; immutable source,
environment, persistence, dependency and classification failures still block.
The contract is fingerprinted into the stateless review plan and cannot be
changed after UI approval without invalidating that approval.

Production construction also exposes a Settings review interface. The Registry
may extract only a credential-free local HTTP port and path from an existing
Docker health check; it never stores or replays the health command. When that
bounded target matches an observed route port, the compiler prefers it over the
public route path and the review binds a route exposing the same port. Otherwise
an unambiguous observed route remains the fallback health target. The interface
displays and confirms the complete compiler-owned candidate runtime
specification and requires separate confirmation plus a replaceable certificate
adapter choice for every compiled route. The browser is not authority: the
allowlisted record is owner-only on the server and is bound to the stateless
plan, whole-server plan, registry snapshot, resource, manifest revision,
evidence fingerprint and execution contract. Registry or contract drift makes
it stale.

The one-click run may populate the same allowlisted review automatically from
unambiguous observed routes and compiler-owned runtime defaults. This is not a
browser-side bypass: it occurs on the server after fresh evidence capture and
is bound to the newly compiled contract before the one-time grant is issued.

The scan screen does not call an evidence-incomplete candidate ready to run. It
calls the safe read-only audit class eligible for migration preparation and
keeps unresolved contract evidence visible in the same detail page. Checkbox
state alone is not authority and is not a terminal user action.

### Implemented boundary: one-click migration run coordinator

The authenticated Settings action is now `Geçişi Başlat`, not a separate
selection-save action. One request atomically persists the exact selected IDs as
server-local intent, binds them to the whole-server plan and current Registry
snapshot, and creates an owner-only run under `.foxos-data/migration-runs/`.
Snapshot drift stops the run before any runtime action. Every selected resource
is prepared and preflighted before the first candidate can be created, so a
blocked member prevents partial group execution.

Only explicit required-dependency edges may order selected resources; shared
networks and provider projects remain non-ordering observations. Once all
resources are ready, execution is serial. Each resource receives a just-in-time,
short-lived, one-use grant bound to the authenticated FoxOS session, exact plan,
resource and evidence fingerprint. The raw grant and session token stay in
memory and are never returned or persisted. The existing stateless transaction
retains zero-unavailable-sample health gates and automatic rollback.

The production Docker/route/TLS adapter is injected into this server path.
Evidence-incomplete or unsupported resources still finish preflight as
`blocked`, with zero candidate, route or traffic mutation. Eligible stateless
resources continue into the verified transaction. There is no separate approve
endpoint, pre-proof source stop, provider-detach or destructive-cleanup path.
After successful proof the exact source may be parked as a stopped cold rollback
target under the rules above.
