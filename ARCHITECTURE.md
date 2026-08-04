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
root and exposes authenticated scan/read/redacted-export APIs. It deliberately
does not create desired manifests, adopt resources, change labels, detach a
provider or mutate Docker runtime state. Those actions remain gated by the next
import-draft and adoption-plan milestone.
