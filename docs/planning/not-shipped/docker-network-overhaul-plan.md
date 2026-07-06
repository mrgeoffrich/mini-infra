# Docker Network Overhaul — Single-Owner Plumbing, Then Declarative Membership

**Status:** planned, not implemented. Phased rollout — each phase ships as a separate PR.
**Builds on:** [docs/designs/docker-network-management-redesign.md](../../designs/docker-network-management-redesign.md) (the audit + two-option design this plan implements), and the egress subnet direction shipped in #440 (Docker IPAM owns subnet selection).
**Excludes:** egress firewall *policy* work — only the egress network attach mechanics are touched here.

---

## 1. Background

Docker network handling in Mini Infra grew feature-by-feature into roughly ten separate mechanisms spread across ~15 server files, with no single owner: three wrapper layers plus raw dockerode calls, eleven distinct `network.connect()` sites, and idempotency implemented by substring-matching Docker error messages. A code audit ([docker-network-management-redesign.md](../../designs/docker-network-management-redesign.md)) confirmed four classes of defect: leaked networks on stack destroy and environment delete, drift blindness (networks participate in neither the definition hash nor the plan), fragile plumbing (two `removeNetwork` implementations with different safety semantics, `exists()` that reports "absent" on Docker outages), and a three-times-copy-pasted attach pipeline. The design doc proposes Option A (a single-owner `NetworkManager` with label-driven lifecycle) and Option B (networks and membership as desired state converged by a reconciler); this plan implements both in sequence, with A built as B's substrate. Phases 1–4 land A and fix every known leak; Phases 5–9 land B (desired state, reconciliation, visibility UI); Phase 10 optionally collapses the four template declaration mechanisms into one.

## 2. Goals

1. **Zero leaked networks.** Destroying a stack or deleting an environment removes every Docker network it owns, and a GC keeps the host clean of historical orphans.
2. **One owner.** Every Docker network operation in the codebase flows through a single service with uniform idempotency, alias, and safety semantics.
3. **Drift visibility.** Network existence and container membership participate in stack Synced/Drifted exactly like containers do.
4. **Self-healing membership.** Containers recreated out-of-band — including the mini-infra server itself — regain their network attachments without bespoke workarounds.
5. **Explainability.** Operators can see who is attached to any managed network and *why* (source + creator) from the UI.

## 3. Non-goals

- **Subnet allocation.** Docker IPAM remains the allocator of record (the MINI-64 direction); nothing in this plan prescribes subnets.
- **A general-purpose Docker network editor.** The raw networks tab keeps list + delete; creating/editing arbitrary unmanaged networks is not a product goal.
- **Touching unmanaged networks.** GC and the reconciler act only on networks Mini Infra owns (by label or registry); anything else on the host is invisible to them — worktree hosts share daemons with other projects.
- **Multi-host / overlay networking.** Single Docker host, bridge driver, as today.
- **Removing the legacy template fields.** `networks[]`, `resourceOutputs`/`resourceInputs` (docker-network), `joinNetworks`, and `joinResourceNetworks` keep working throughout; the unified shape (Phase 10) is additive translation, not a breaking change.
- **HAProxy dataplane behaviour.** Only how HAProxy-related code discovers and joins networks changes; frontend/backend/routing logic is untouched.

## 4. Ownership labels & naming (shared concept)

Referenced by Phases 1–4 and 7–8.

Every network the system creates is stamped at creation time:

| Label | Value |
|---|---|
| `mini-infra.managed` | `true` |
| `mini-infra.owner-kind` | `stack` \| `environment` \| `host` |
| `mini-infra.owner-id` | stack id / environment id (omitted for `host`) |
| `mini-infra.purpose` | resource purpose (`applications`, `egress`, …) or `_stack` for stack-owned networks |

Lifecycle operations (destroy, GC) query Docker by these labels rather than re-deriving names. Existing naming conventions are preserved verbatim (`${projectName}_${name}`, `${env}-${purpose}`, `mini-infra-${purpose}`) and derived in exactly one module — no network is renamed, so no container is restarted by this plan.

**Constraint:** Docker network labels are immutable after creation, so label queries only cover networks created after Phase 1. Destroy and GC therefore keep a fallback that matches pre-existing networks by registry/derived name. The fallback is permanent code but exercised less over time.

## 5. Desired-state model (shared concept)

Referenced by Phases 5–10. Contract sketch (field types finalised in the Phase 5 migration):

```prisma
model ManagedNetwork {
  scope         String   // 'host' | 'environment' | 'stack'
  environmentId String?
  stackId       String?
  purpose       String
  name          String   @unique   // derived once at creation, then immutable
  driver        String   @default("bridge")
  options       Json?
  dockerId      String?            // recorded from inspect, never prescribed
  subnet        String?            // recorded, never prescribed
  status        String   @default("pending") // pending|present|missing|error
  enforceMemberships Boolean @default(false) // added in Phase 8
  @@unique([scope, environmentId, stackId, purpose])
}

model NetworkMembership {
  networkId      String
  stackServiceId String?  // managed service — resolved to live container(s) by label at reconcile time
  containerName  String?  // adopted/external container, or the 'self' sentinel for the server
  aliases        Json?
  staticIp       String?  // egress gateway only
  source         String   // 'template' | 'user' | 'egress' | 'haproxy' | 'system'
  createdBy      String?  // userId when source = 'user'
  @@unique([networkId, stackServiceId, containerName])
}
```

Semantics that must hold across phases:

- **Identity is `(scope, owner, purpose)`, never the name.** Nothing re-derives a name to find or delete a network once the row exists.
- **Memberships resolve at reconcile time.** A `stackServiceId` row matches whatever containers currently carry that service's labels — blue-green replacements and pool workers converge without per-feature attach code.
- **`source` is the provenance contract** consumed by the Phase 9 UI and by any future policy work; producers must set it honestly.

## 6. Phased rollout

Phases land strictly in order; each ships as one PR via the standard worktree flow.

### Phase 1 — NetworkManager core + stack network lifecycle

**Goal:** all stack-subsystem network operations flow through one service, and stack destroy stops orphaning networks.

Deliverables:
- A `NetworkManager` service (new `server/src/services/networks/` module) owning ensure/connect/disconnect/remove — idempotency decided by Docker status codes rather than message substrings, tri-state existence (`present`/`absent`/`unknown` — daemon outage is not "absent"), the safe remove semantics (inspect first, attached-container guard, timeout, cache invalidation) as the sole remove implementation, and §4 ownership labels stamped on every network it creates.
- A single naming module — the only place network names are derived; the divergent inline derivations (including the host-scoped destroy mismatch) are gone by construction.
- An `attachServiceNetworks` helper encapsulating the ordered create → attach → start sequence with a uniform alias policy, used by the static-service create/recreate paths.
- Stack apply/update network creation deduplicated into one path; stack destroy reaps networks by owner label with a name-derived fallback (§4), including the synthesised `default` network.
- The dead reconciler copy of the destroy logic removed.

Reversibility: safe — revert the PR and the current call sites return.

UI changes: none

Schema changes: none

Done when: destroying a host-scoped multi-service stack in dev leaves none of that stack's Docker networks on the host.

Verify in prod: stack destroys stop emitting "Failed to remove network, continuing" warnings in the logs.

### Phase 2 — Pools and sidecars onto the shared attach pipeline

**Goal:** pool workers, pool addon sidecars, and AdoptedWeb targets attach through the same pipeline as static services.

Deliverables:
- Pool worker spawn attaches via `attachServiceNetworks` — the reimplemented join/resource-network/egress loops and inline project-name derivation are deleted; the implicit vault/nats attach behaviour becomes an explicit, documented input to the shared helper.
- Pool addon sidecar peer-network join through the same helper.
- AdoptedWeb attach (HAProxy network + `joinNetworks` + `joinResourceNetworks`) through the same helper.

Reversibility: safe — revert the PR; the duplicated pipelines return.

UI changes: none

Schema changes: none

Done when: a pool worker spawned in dev resolves both its sibling service and `egress-gateway` by DNS, having been attached exclusively through the shared pipeline.

Verify in prod: pool spawn success rate is unchanged and spawn logs show no new attach warnings after rollout.

### Phase 3 — Environment, egress, HAProxy, and self-joins onto NetworkManager

**Goal:** no code outside the networks module talks to Docker's network API.

Deliverables:
- Egress provisioning (network create/inspect, server self-attach, gateway static-IP reassignment), the monitoring self-join, and the manual HAProxy frontend join all operate through `NetworkManager`.
- HAProxy network discovery by purpose lookup (`dataplane`) replacing the `name.includes("haproxy")` heuristic.
- Egress context resolution surfaces errors as structured warnings instead of a bare catch that silently skips egress wiring.
- A CI gate (lint rule or test) that fails on Docker network API usage outside `services/networks/`.
- Network methods on the two legacy owners (`DockerService`, `InfrastructureManager`) delegated or removed, leaving one remove implementation.

Reversibility: safe — revert the PR.

UI changes: none

Schema changes: none

Done when: the CI gate proving no Docker network API call exists outside `services/networks/` passes.

Verify in prod: previously-silent egress wiring failures appear as structured warnings in the logs while manual HAProxy frontend setups continue to succeed.

### Phase 4 — Label-driven deletion and GC; drop `EnvironmentNetwork`

**Goal:** deleting an environment removes everything it owned, and historical orphans get cleaned up.

Deliverables:
- Environment delete removes all Docker networks owned by the environment (label query + §4 fallback) along with their `InfraResource` rows.
- Stack destroy and environment delete remove matching `InfraResource` rows — the first deletion path that table has ever had.
- A GC sweep — scheduled plus on-demand via an admin endpoint, dry-run by default — that removes managed networks whose owner no longer exists and which have no attached containers; unlabelled/unknown networks are never touched.
- The `EnvironmentNetwork` model, its never-mounted router, its client types, and the boot-time backfill deleted.

Reversibility: forward-only — the table drop and orphan removals are repaired forward, not by revert.

UI changes: none (GC is API-only until Phase 9)

Schema changes:
- drop table `environment_networks` (model `EnvironmentNetwork`) — dead legacy model; its rows were never reflected in Docker
- Prisma migration: `pnpm --filter mini-infra-server exec prisma migrate dev --name drop-environment-networks`

Done when: deleting an environment in dev leaves no Docker networks owned by that environment on the host.

Verify in prod: the first GC dry-run reports the historical orphan count, and subsequent runs report zero new orphans.

### Phase 5 — Desired-state schema

**Goal:** the `ManagedNetwork` and `NetworkMembership` tables exist — empty and unused — so later phases read/write without coupling DDL to feature rollout.

Deliverables:
- The two Prisma models from §5, with no readers or writers.

Reversibility: safe — by construction; the tables are untouched until Phase 6.

UI changes: none

Schema changes:
- new table `managed_networks`: `scope` string, `environmentId` string nullable, `stackId` string nullable, `purpose` string, `name` string unique, `driver` string default `"bridge"`, `options` Json nullable, `dockerId` string nullable, `subnet` string nullable, `status` string default `"pending"`; unique index on (`scope`, `environmentId`, `stackId`, `purpose`)
- new table `network_memberships`: `networkId` FK → `managed_networks`, `stackServiceId` string nullable, `containerName` string nullable, `aliases` Json nullable, `staticIp` string nullable, `source` string, `createdBy` string nullable; unique index on (`networkId`, `stackServiceId`, `containerName`)
- Prisma migration: `pnpm --filter mini-infra-server exec prisma migrate dev --name managed-network-membership`

Done when: the migration applies cleanly on a dev database and the server boots with both tables empty and untouched.

Verify in prod: n/a — internal only.

### Phase 6 — Producers declare memberships + backfill

**Goal:** every code path that attaches a container also records the attachment as desired state, with provenance.

Deliverables:
- A membership compiler in the stack apply pipeline: stack definitions (`networks[]`, docker-network resource outputs/inputs, `joinNetworks`, `joinResourceNetworks`, the synthesised default) upsert `ManagedNetwork` and per-service membership rows with `source='template'`.
- Egress auto-attach recorded as `source='egress'` rows; the manual HAProxy frontend join as `source='haproxy'`; the application connect-to-container-network feature as `source='user'` rows carrying the acting user; server self-joins and the monitoring join as `containerName='self'` rows.
- A backfill seeding rows from `InfraResource`, current stack definitions, and stored `containerConfig` join fields; memberships referencing networks that no longer exist are flagged rather than invented.
- Existing imperative attach behaviour unchanged — rows are written alongside it; nothing reads them yet.

Reversibility: safe — rows are inert; reverting simply stops the writes.

UI changes: none

Schema changes: none

Done when: an integration test applying a representative stack in dev finds every network attachment the apply performed mirrored by a membership row with the correct source.

Verify in prod: n/a — internal only (write-only this phase).

### Phase 7 — Reconciler in report-only mode

**Goal:** network drift is visible — missing networks, missing or stale memberships, and spec mismatches surface in stack plans and status.

Deliverables:
- A `NetworkReconciler` dry-run diff: desired state (rows) vs actual (Docker inspect) → typed drift items; no mutations in this phase.
- The plan computer includes network drift items in plan output, and stack Synced/Drifted reflects network state. (This absorbs Option A's interim plan-time drift check — it lands here once, on the desired-state model.)
- Reconciler status and last diff exposed via API for the Phase 9 UI.

Reversibility: safe — reporting only.

UI changes:
- Stack plan view lists network drift items (missing network, unattached container, stale attachment) alongside the existing container actions [no design]

Schema changes: none

Done when: removing a managed network out-of-band in dev causes the owning stack's plan to show a network-drift item.

Verify in prod: stacks whose networks were externally deleted report Drifted instead of Synced.

### Phase 8 — Enforcement and boot convergence

**Goal:** the reconciler converges reality to desired state, and the boot-time self-reattach workaround is deleted.

Deliverables:
- Reconciler converge: ensure networks and connect missing memberships during stack apply, at server boot, on relevant Docker events (debounced), and on a periodic sweep — for new containers the existing create → attach → start ordering is preserved.
- Stale-endpoint disconnects gated behind the per-network `enforceMemberships` flag, default off.
- The boot-time self-network-reattach workaround deleted, replaced by the general boot converge.
- A manual reconcile trigger endpoint.

Reversibility: feature-flagged — disconnects sit behind the per-network flag; connect-only convergence reverts cleanly with the PR.

UI changes: none (the flag is API-set until Phase 9)

Schema changes:
- `managed_networks`: `enforceMemberships` Boolean, default `false` — per-network gate for stale-endpoint disconnects
- Prisma migration: `pnpm --filter mini-infra-server exec prisma migrate dev --name network-enforce-flag`

Done when: recreating the mini-infra server container out-of-band in dev results in all of its managed network attachments being restored by the boot converge.

Verify in prod: no post-self-update incidents of the server unable to reach Vault/NATS/databases, with the boot converge logging restored-attachment counts.

### Phase 9 — Network visibility UI

**Goal:** operators can answer "what networks exist, who's on them, and why" from the UI.

Deliverables:
- The networks tab shows managed networks with owner, purpose, status, desired-vs-actual members, and per-membership source/creator, plus reconcile, GC, and enforce-flag actions.
- Environment detail generalises the existing egress card into a panel covering all of the environment's networks.
- Application detail shows the app's network connections with source labels.

Reversibility: safe — read/action surface; revert the PR to remove it.

UI changes:
- Networks tab: managed-network detail with membership/provenance table and reconcile / GC / enforce actions [design needed]
- Environment detail: networks panel generalising the existing egress card [no design]
- Application detail: connected-networks list with source labels [no design]

Schema changes: none

Done when: an operator in dev can open a managed network and see its owner, purpose, and desired-vs-actual member list with each membership's source.

Verify in prod: "why is container X on network Y" is answerable from the network detail page without the Docker CLI.

### Phase 10 — Unified template network declaration (optional, deferred)

**Goal:** one input shape for declaring networks and attachments in templates, compiling to the same desired-state rows as the legacy fields.

Deliverables:
- A unified `networks` declaration (purpose + scope at stack level; a per-service network list) accepted by the template/stack schemas and compiled to §5 rows.
- Legacy fields remain accepted indefinitely, translated to the same rows.
- The stack definition reference documents the unified shape.

Reversibility: safe — reader-side translation only.

UI changes: none

Schema changes: none

Done when: a snapshot test shows a template written with the unified shape produces an apply result identical to its legacy-field equivalent.

Verify in prod: n/a — internal only (input-surface change).

## 7. Risks & open questions

- **Label immutability.** Docker networks cannot be relabelled, so the name-based fallback (§4) is permanent code, not a transition shim. It must stay covered by tests even once most networks carry labels.
- **Disconnect safety.** Wrongly removing a "stale" endpoint is worse than today's leaks — hence the report-only → connect-only → per-network-flag progression (Phases 7–8). Open question: what criteria justify flipping `enforceMemberships` on by default, and does that ever happen for adopted containers?
- **Blue-green and pool churn.** Membership resolution against deployment green/blue container sets and pool spawn/reap needs dedicated integration tests before Phase 8 enforcement lands.
- **Backfill fidelity.** Stored `containerConfig.joinNetworks` entries may reference networks that no longer exist; the Phase 6 backfill flags these rather than creating networks. Open question: whether flagged rows get a `status` field or are simply logged and skipped.
- **Boot ordering.** Converge-at-boot requires Docker connectivity; the degraded-worktree case where Docker connects after boot must reuse the existing onConnect hook pattern the current workaround relies on.
- **CI gate mechanics (Phase 3).** ESLint restriction vs a grep-based test — decided at execution time; the requirement is only that it runs in CI and fails loudly.
- **Shared-daemon hosts.** Worktree dev hosts run other projects' networks on the same daemon; GC and reconciler matching must remain strictly label/registry-based (never name-pattern-based) to avoid touching foreign networks.

## 8. Phase tracking

Manual checklist — check a box when that phase's PR merges.

- [ ] Phase 1: NetworkManager core + stack network lifecycle
- [ ] Phase 2: Pools and sidecars onto the shared attach pipeline
- [ ] Phase 3: Environment, egress, HAProxy, and self-joins onto NetworkManager
- [ ] Phase 4: Label-driven deletion and GC; drop `EnvironmentNetwork`
- [ ] Phase 5: Desired-state schema
- [ ] Phase 6: Producers declare memberships + backfill
- [ ] Phase 7: Reconciler in report-only mode
- [ ] Phase 8: Enforcement and boot convergence
- [ ] Phase 9: Network visibility UI
- [ ] Phase 10: Unified template network declaration (optional, deferred)
