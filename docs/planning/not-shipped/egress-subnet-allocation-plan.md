# Egress network subnet allocation — delegate to Docker, record and surface the result

**Status:** Draft — awaiting review before `plan-to-mk` seed.

## 1. Background

The per-environment egress network is the only Docker network Mini Infra creates with a subnet it picks itself: `EgressNetworkAllocator` carves a `/24` out of a hardcoded `172.30.0.0/16` pool and persists it so the egress-gateway stack reuses it. On any host shared with other Docker Compose projects this pool collides — an unrelated project's network can already own `172.30.0.0/16`, and because the allocator only checks for *exact network-address* matches (not true CIDR overlap) it keeps handing out `172.30.x.0/24` subnets that sit inside the existing range. Docker rejects each one with `invalid pool request: Pool overlaps with other one on this address space`, so the egress network is never created, and the dependent HAProxy stack then fails with `network <env>-egress not found`. Every other Mini Infra network sidesteps this entirely by letting Docker's IPAM assign the subnet. This project makes the egress network behave the same way — Docker chooses the subnet, the app records what Docker chose, and operators can see the result on the environment detail screen — so environment provisioning stops breaking on shared hosts while the network stays manageable.

We do not want a predictable, repeatable per-environment subnet plan — only that the network is allocated reliably, recorded, and visible. The gateway still needs a stable, known IP for managed containers to route through (`<env>-egress` gateway at a fixed address; `egress-gateway:3128` resolves from any app/pool/StatelessWeb container), but that requirement is already satisfied by `EgressNetworkAllocator.allocateGatewayIp()`, which derives the gateway container IP by inspecting the live network — it does not depend on the app choosing the subnet.

## 2. Goals

1. Environment creation never fails because the egress subnet overlaps an existing Docker network on the host.
2. Docker is the single allocator of record for the egress subnet, consistent with how every other Mini Infra network is created.
3. The subnet and gateway Docker assigns are recorded against the environment so they can be read back programmatically.
4. Operators can see an environment's egress network — subnet, gateway IP, and health — from the UI without using the Docker CLI.
5. Existing healthy environments are unaffected by the change.

## 3. Non-goals

- **A predictable / repeatable per-environment subnet plan.** Explicitly out of scope — the requirement is reliable allocation and visibility, not deterministic ranges or audited IP plans.
- **Changing allocation for non-egress networks.** Dataplane, database, applications, monitoring, vault, and nats networks already delegate to Docker; they are not touched.
- **A general Docker-network management UI.** Only the egress network is surfaced, and only on the environment detail screen.
- **Manual subnet selection or editing.** Operators cannot pick or override the subnet; Docker owns selection.
- **IPv6 egress networks.** Out of scope; egress remains IPv4 bridge.
- **Migrating already-broken environments automatically.** Recovery of existing broken environments is handled by recreation (today) or the optional re-provision phase (later), not a one-shot data migration.

## 4. Subnet ownership model

The change establishes one rule, applied to the egress network the same way it already applies to every other Mini Infra network:

- **Docker owns subnet selection.** The egress network is created with no IPAM config; Docker's IPAM assigns a non-overlapping subnet from its configured `default-address-pools`. Docker never double-allocates within a daemon and already skips ranges that overlap host routes (on the reference host it skipped `192.168.0.0/20` because it contains the host LAN address and started Mini Infra's networks at `192.168.16.0/20`).
- **The app records, it does not prescribe.** Immediately after creation the network is inspected and the assigned subnet + bridge gateway are written to the egress `InfraResource.metadata`. That record is a cache of Docker's truth, refreshed from inspect — never a value passed back into network creation.
- **The only app-owned address is the gateway container IP.** `allocateGatewayIp()` picks the gateway's host address (`.2` upward) by inspecting the live network and is retained unchanged. It works off whatever subnet exists, so it is independent of who chose the subnet.

This deletes the hardcoded pool, the `MINI_INFRA_EGRESS_POOL_CIDR` env var, and the whole class of overlap failures, while keeping every value an operator or downstream component needs.

## 5. Phased rollout

Phase 1 is the foundation and lands first. Phases 2 and 3 both build on it; Phase 3 is optional and parked in the backlog.

### Phase 1 — Delegate egress subnet selection to Docker

**Goal:** The per-environment egress network is created without a prescribed subnet, and the app records the subnet and gateway Docker assigns.

Deliverables:
- Egress provisioning creates the egress Docker network with no IPAM config and reads the assigned subnet and bridge gateway back via network inspect, persisting them to the egress `InfraResource.metadata`.
- The egress-specific path in the stack infra-resource reconciler that replays `metadata.subnet` to create the network with an explicit subnet is removed; the egress network is created like every other Mini Infra network.
- `EgressNetworkAllocator.allocateSubnet()` and the `MINI_INFRA_EGRESS_POOL_CIDR` pool configuration are removed; `allocateGatewayIp()` (gateway container IP derived from live inspect) is retained.
- The existing "network already exists → adopt its subnet" behaviour is preserved so healthy environments with a previously created egress network are untouched.

Reversibility: safe — revert the PR and new environments fall back to pool allocation; no data migration, and existing networks keep working either way.

UI changes: none

Schema changes: none

Done when: creating an environment on a host where the old default pool (`172.30.0.0/16`) is fully occupied succeeds, with the egress network on a Docker-assigned, non-overlapping subnet recorded in the egress `InfraResource.metadata`.

Verify in prod: a newly created environment reaches the egress-gateway stack `synced` state with no `Pool overlaps with other one on this address space` events in the audit log.

### Phase 2 — Surface the egress network on the environment detail screen

**Goal:** Operators can see an environment's egress network subnet, gateway IP, and health from the UI.

Deliverables:
- The environment detail API exposes the egress network's recorded subnet, bridge gateway, gateway container IP (from `Environment.egressGatewayIp`), and a derived status (present / missing / error).
- The environment detail screen shows an egress-network panel rendering those values and the status.

Reversibility: safe — read-only surface; revert the PR to remove it.

UI changes:
- Environment detail page gains an "Egress network" panel showing the subnet, gateway IP, and a health status indicator. [no design]

Schema changes: none

Done when: opening an environment with a provisioned egress gateway shows its real subnet and gateway IP with a healthy status, and an environment whose egress network is missing or failed shows an error state.

Verify in prod: operators can read the egress subnet and gateway IP for a live environment on its detail page.

### Phase 3 — Egress network re-provision / repair action (optional, deferred)

**Goal:** A broken or missing egress network on an existing environment can be rebuilt in place, without deleting and recreating the environment.

Deliverables:
- A service + endpoint that re-runs egress provisioning for an existing environment: creates the network if missing (Docker-assigned subnet), refreshes the recorded subnet/gateway, re-applies the egress-gateway stack, and re-attaches the gateway container at its IP. Idempotent when the network is already healthy.
- A "Re-provision egress" action on the environment detail egress panel, wired to the endpoint with progress feedback.

Reversibility: safe — the rebuild is idempotent; reverting removes the action and endpoint.

UI changes:
- Environment detail egress panel gains a "Re-provision" action with progress feedback. [no design]

Schema changes: none

Done when: triggering re-provision on an environment whose egress network was deleted recreates it on a Docker-assigned subnet and brings the egress-gateway and dependent HAProxy stacks back to `synced`.

Verify in prod: an operator recovers a broken egress network from the UI and watches the dependent stacks return to `synced`.

## 6. Risks & open questions

- **Recovering the environments already broken on the reference host.** Provisioning only runs at environment-creation time, so the two environments currently carrying a bad `172.30.x` subnet won't self-heal from the Phase 1 code alone. Because both are empty (`stackCount: 0`), the immediate recovery is to delete and recreate them after Phase 1 ships; Phase 3 provides the durable, in-place alternative.
- **Docker default-address-pool exhaustion.** On a very full host Docker's own IPAM could eventually run out of pool space. Mitigation is host-level daemon configuration (`default-address-pools`), not app code — worth a note in operator docs but out of scope here.
- **Status derivation for the visibility panel.** Phase 2's "present / missing / error" status is derived from the egress `InfraResource` + a Docker network existence check; the exact health signal (does it cross-check the gateway container is attached at its IP?) is an implementation detail to settle during Phase 2.

## 8. mk tracking

Tracked under the `egress-subnet-allocation` feature in mk (run `mk feature show egress-subnet-allocation` to view).

- MINI-64 — Phase 1: Delegate egress subnet selection to Docker
- MINI-65 — Phase 2: Surface the egress network on the environment detail screen  [blocks-by: 1]
- MINI-66 — Phase 3: Egress network re-provision / repair action (optional, deferred)  [blocks-by: 1]
