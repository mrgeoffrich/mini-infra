# Docker Network Management — Redesign Options

**Status:** Decided — both options will be implemented in sequence (A as B's substrate). Execution is scoped in the phased plan: [docs/planning/not-shipped/docker-network-overhaul-plan.md](../planning/not-shipped/docker-network-overhaul-plan.md) (Phases 1–4 = Option A, Phases 5–9 = Option B, Phase 10 = optional declaration-surface collapse). Two adjustments made when combining: Option A's standalone plan-time drift check (§2.4) is folded into B's report-only reconciler phase, and A's `InfraResource` registry work is kept minimal since `ManagedNetwork` supersedes it.
**Scope:** How Docker networks are created, joined, tracked, reconciled, and destroyed across environments, stacks, applications, pools, egress, HAProxy, and the mini-infra server itself.

---

## 1. Current state — how networks are actually managed today

There is no single "network subsystem". Network behaviour is spread across **at least ten mechanisms** in ~15 files, each of which grew out of a specific feature:

| # | Mechanism | Naming | Created by | Tracked in DB? |
|---|-----------|--------|-----------|----------------|
| 1 | Stack-owned `networks[]` | `${projectName}_${name}` | `stack-reconciler.ts:167-183` (and a duplicate loop at `:515-537`) | No |
| 2 | Auto-synthesised `default` network (≥2 container-bearing services, empty `networks[]`) | `${projectName}_default` | `utils.ts:508-526` via apply | No |
| 3 | Infra-resource networks (`resourceOutputs[]` type `docker-network`) | `${env}-${purpose}` / `mini-infra-${purpose}` | `stack-infra-resource-manager.ts:27-98` during apply | `InfraResource` |
| 4 | Per-service `joinNetworks` (literal names; also the vehicle for the app "connect to a container's network" feature, PR #473) | caller-supplied | hot-attach post-create, `stack-service-handlers.ts:588-604` | Buried in `containerConfig` JSON |
| 5 | Per-service `joinResourceNetworks` (purpose lookup) | resolved from `InfraResource` | `stack-infra-resource-manager.ts:153-182` — **reimplemented inline** in `pool-spawner.ts:410-470` | Buried in `containerConfig` JSON |
| 6 | Egress auto-attach (every non-bypass container in a gateway-enabled env) | `${env}-egress` | `egress-injection.ts:119-143`; network itself created eagerly by `environment-manager.ts:654-931` *and* as a fallback by mechanism 3 | `InfraResource` + `Environment.egressGatewayIp` |
| 7 | HAProxy manual-frontend join | discovered by **substring heuristic** `name.includes("haproxy") \|\| name.includes("network")`, 3 copies in `manual-frontend-manager.ts` (`:65`, `:214`, `:360`) | raw `network.connect()` | HAProxy tables only |
| 8 | Pool worker + pool addon sidecar attach | reimplements the whole create→attach→start dance (`pool-spawner.ts:356-501`, `pool-addon-sidecar.ts:162-229`), incl. implicit vault/nats joins | raw `connect()` loops | No |
| 9 | Self/monitoring joins (mini-infra server attaches itself) | `joinSelf` on resource outputs; `monitoring-service.ts:422`; `environment-manager.ts:761,978` | raw `connect()` | No |
| 10 | Boot-time `self-network-reattach.ts` | re-derives from `InfraResource` + `joinSelf` | boot + Docker `onConnect` | — |

On top of that there are **two parallel DB models**: the legacy `EnvironmentNetwork` table (rows are pure metadata — `dockerId` is never written, its REST router `environment-networks.ts` is **never mounted**) and the current `InfraResource` table. Environment deletion still iterates the *legacy* table (`environment-manager.ts:486-518`), so `deleteNetworks=true` typically deletes nothing.

### 1.1 Concrete defects found (verified in source)

**Leaks and orphans**

- **L1 — Host-scoped stack destroy orphans networks/volumes.** The live destroy path computes `projectName` without the `mini-infra-` prefix (`stacks-destroy-route.ts:96-98`), while creation used `getStackProjectName()` (`template-engine.ts:74-81`). `networkExists` therefore misses, and the network is silently left behind. The *correct* logic exists — in the dead `destroyStackInner` (`stack-reconciler.ts:1015-1163`, explicitly marked dead code).
- **L2 — The synthesised `default` network is never reaped.** Destroy reads the raw `networks[]` array (`stacks-destroy-route.ts:99`) without calling `synthesiseDefaultNetworkIfNeeded`, so multi-service stacks orphan `${project}_default` on every destroy.
- **L3 — Environment delete leaks every real network.** It deletes Docker networks from `EnvironmentNetwork` rows (which don't exist for modern envs) and lets `InfraResource` rows cascade-delete in the DB while **never removing the underlying Docker networks** (egress, applications, tunnel, dataplane, vault, nats…).
- **L4 — No code path anywhere deletes an `InfraResource` row** (grep: only create/update). A destroyed owning stack leaves the row dangling with `stackId` SET NULL.

**Blind spots**

- **B1 — Networks are invisible to drift detection.** The definition hash (`definition-hash.ts:78-138`) never includes the stack-level `networks[]`; the plan computer never calls `networkExists`. A `docker network rm` out from under a running stack produces a `no-op` plan.
- **B2 — Existing networks are never reconciled.** Every creation site is `exists ? skip : create` — a changed driver, label, or option on redeploy is silently ignored. `stackNetworkSchema.options` is accepted by the schema and never passed to Docker at all.
- **B3 — Membership is only enforced during apply.** If a container (including the mini-infra server itself) is recreated out-of-band, nothing re-attaches it. `self-network-reattach.ts` is a boot-time workaround that patches *only* the server's own case.

**Fragility**

- **F1 — Idempotency by error-message substring matching**, with *different string sets per site*: `self-network-reattach.ts:26`, `stack-infra-resource-manager.ts:177`, `egress-injection.ts:136`, `environment-manager.ts:765`, `pool-spawner.ts:454,465`.
- **F2 — Two `removeNetwork` implementations with different safety semantics.** `DockerService.removeNetwork` (`docker.ts:987-1022`) inspects first, refuses when containers are attached, applies 5 s timeouts, invalidates cache. `InfrastructureManager.removeNetwork` (`infrastructure-manager.ts:196-211`) calls `network.remove()` blind. Env-delete and stack-destroy use the **unsafe** one; only the REST DELETE uses the safe one.
- **F3 — `networkExists()` returns `false` on *any* error** (`infrastructure-manager.ts:138-152`), so a Docker hiccup is indistinguishable from "missing" and triggers create attempts.
- **F4 — `resolveEgressContext` swallows all errors bare** (`egress-injection.ts:69-71`) — a DB blip silently disables egress wiring for a container, which then can't resolve `egress-gateway:3128`.
- **F5 — Semantics differ by service type.** DNS aliases only on stack-owned networks (`long-running-container.ts:189-217`); on resource networks only for `egressBypass` services; `joinNetworks` wasn't applied to AdoptedWeb until PR #473 patched it.
- **F6 — 11 distinct raw `network.connect()` call sites across 8 files**; the create→attach→start race mitigation is copy-pasted three times with an explanatory comment each time.

**History confirms the pattern.** The last year of network commits is almost entirely corrective: re-attach server on boot (#443), attach networks before start (#307), gateway IP double-claimed (#292), orphaned bridges on worktree delete (#275), egress subnet pool overlaps breaking env provisioning (#439/#440). Each fix patched one call site; none addressed the shape of the system.

### 1.2 Root causes

1. **No single owner.** Three wrapper layers (`DockerService`, `InfrastructureManager`, `StackContainerManager.connectToNetwork`) plus raw dockerode, with no one API responsible for idempotency, safety, or bookkeeping.
2. **No desired-state record of membership.** "Which containers should be on which networks" is computed imperatively, per feature, at attach time — so it can't be re-checked, re-applied, drift-detected, or explained. Every symptom in B1–B3 and the boot-reattach hack follows from this.
3. **Names encode semantics.** `${env}-${purpose}`, `${projectName}_${name}`, and substring heuristics are the *only* way code finds networks, so any naming divergence (L1) or rename becomes a leak, and discovery (HAProxy) is guesswork. Labels exist (`mini-infra.managed`, `mini-infra.stack-id`, …) but nothing queries by them.
4. **Asymmetric lifecycle.** Creation is idempotent, lazy, and duplicated; deletion is best-effort name-reconstruction with swallowed errors; there is no GC at all.

---

## 2. Option A — Single-owner `NetworkManager` + label-driven lifecycle (consolidation)

**Thesis:** keep the current conceptual model (stack networks, shared purpose networks, per-service joins) but move *every* Docker network operation behind one service, make **labels + one registry table** the source of truth for ownership, and make deletion/GC label-driven instead of name-reconstruction. This is the low-risk option: it fixes every defect in §1.1 without changing the stack-definition surface or user-visible behaviour.

### 2.1 The new module: `server/src/services/networks/`

```
networks/
├── network-manager.ts     # the ONLY place that talks to Docker's network API
├── network-names.ts       # the ONLY place names are derived
├── network-gc.ts          # label-driven sweep
└── index.ts
```

**`NetworkManager`** (singleton, initialised alongside `DockerService`):

```ts
interface EnsureNetworkSpec {
  name: string;
  owner: NetworkOwner;              // { kind: 'stack'|'environment'|'host', id?: string }
  purpose?: string;                 // for shared/resource networks
  driver?: string;                  // default 'bridge'
  options?: Record<string, string>; // finally actually passed to Docker
  extraLabels?: Record<string, string>;
}

class NetworkManager {
  ensure(spec: EnsureNetworkSpec): Promise<EnsureResult>;   // create-if-missing + verify + record
  connect(containerId: string, network: string, opts?: {
    aliases?: string[]; staticIp?: string;
  }): Promise<ConnectResult>;                               // idempotent by inspection, not string-matching
  disconnect(containerId: string, network: string, opts?: { force?: boolean }): Promise<void>;
  remove(network: string, opts?: { forceDisconnect?: boolean }): Promise<RemoveResult>;
  removeByOwner(owner: NetworkOwner): Promise<RemoveResult[]>;  // label query, see 2.3
  listManaged(filter?: { owner?: NetworkOwner; purpose?: string }): Promise<ManagedNetworkInfo[]>;
}
```

Behavioural contract, applied uniformly:

- **Idempotent connect done properly.** Before connecting, inspect the container's endpoints (one call, cached briefly); if already attached with matching aliases → no-op success. Docker errors are classified by `statusCode` (403/409/404), never by message substrings. One implementation replaces the five divergent string-matchers (F1).
- **One `remove` with the safe semantics** — inspect first, refuse (or force-disconnect when explicitly asked) when containers are attached, 5 s timeouts, cache invalidation. `InfrastructureManager.removeNetwork` and the network parts of `DockerService` are deleted/delegated (F2).
- **`ensure` verifies as well as creates.** If the network exists, compare driver/labels/options against the spec and log a structured warning on mismatch (surfaced as a stack warning — see drift below). `options` finally reaches Docker (B2, partially — full "recreate on mismatch" is deferred to Option B).
- **Errors are tri-state.** `exists(): 'present' | 'absent' | 'unknown'` — Docker being unreachable is `unknown` and callers must not treat it as absent (F3).
- **One attach helper for services.** `attachServiceNetworks(containerId, serviceDef, ctx)` encapsulates the full ordered sequence (stack networks at create, then joinNetworks → joinResourceNetworks → egress, then start) and is called by the static-service handlers, the pool spawner, the pool addon sidecar, and AdoptedWeb alike. The three copy-pasted pipelines and the divergent per-service-type semantics collapse into one (F5, F6). Alias policy becomes explicit and uniform: alias = service name on stack-owned networks, opt-in alias on shared networks.

**`network-names.ts`** — the single derivation point for `stackNetworkName()`, `resourceNetworkName()`, `egressNetworkName()`. The inline copies in `stacks-destroy-route.ts` (the L1 bug), `pool-spawner.ts`, and `pool-addon-sidecar.ts` are deleted. `synthesiseDefaultNetworkIfNeeded` is called in exactly two places: apply and destroy — fixing L2 by construction.

### 2.2 One registry, labels as ground truth

- **Every** managed network gets, at `ensure` time:
  `mini-infra.managed=true`, `mini-infra.owner-kind=stack|environment|host`, `mini-infra.owner-id=<stackId|envId>`, `mini-infra.purpose=<purpose|_stack>`.
- `InfraResource` becomes the **only** DB record (now also recording `dockerId` and inspected subnet/gateway in `metadata`, as egress already does). The `EnvironmentNetwork` table, its never-mounted router, its never-written `dockerId`, and the client types are **deleted** (a migration drops the table; `system-stack-migrations.ts` backfill goes with it).
- The DB row is a *cache of Docker's truth for display and purpose-lookup* — Docker labels are what lifecycle operations query.

### 2.3 Label-driven deletion and GC

- **Stack destroy:** `removeByOwner({kind:'stack', id})` — query Docker for `label=mini-infra.owner-id=<stackId>` and remove what's found. No name reconstruction → L1 and L2 are fixed *by construction*, not by patching the string bug. Shared (purpose) networks are skipped unless refcount-free (below).
- **Environment delete:** `removeByOwner({kind:'environment', id})` removes egress/applications/tunnel/etc. Docker networks before the DB cascade — fixing L3. Delete also removes the matching `InfraResource` rows explicitly (L4).
- **`network-gc.ts`:** a periodic sweep (piggybacking the existing scheduler) lists `mini-infra.managed=true` networks, resolves each owner against the DB, and removes networks whose owner is gone and which have no attached containers. Orphans accumulated by the historical bugs get cleaned retroactively. Dry-run mode + an admin endpoint (`POST /api/docker/networks/gc`) for visibility.

### 2.4 Drift, minimal version

Add a cheap network check to the plan computer: for each desired network (stack-owned + declared resource inputs/outputs), `exists()`; for each service, compare its container's actual endpoints against its computed desired set. Missing network / missing membership → a `network-drift` plan item (repair = re-run the idempotent ensure/attach, no container recreate needed). This closes B1/B3 for the common cases without a new data model — including replacing `self-network-reattach.ts` with "run the membership check for the server's own container at boot", which handles *all* containers, not just self.

### 2.5 What Option A does **not** fix

- Membership desired-state still lives implicitly in `containerConfig` JSON + feature code; "why is this container on this network" is still answered by reading code, not data.
- The four declaration mechanisms (`networks[]`, resource outputs/inputs, `joinNetworks`, `joinResourceNetworks`) remain — consistent now, but still four.
- Reconciliation is apply/boot/plan-triggered, not continuous.

### 2.6 Effort & migration

Roughly 4 PR-sized phases, each independently shippable and safe to revert:
1. `NetworkManager` + `network-names.ts`; port stack apply/attach paths (mechanisms 1–5) onto it; delete the duplicated pipelines.
2. Port environment/egress/HAProxy/monitoring/self paths (6–10); replace the HAProxy substring heuristic with a purpose lookup (`dataplane`) via `InfraResource`.
3. Label-driven destroy + env delete + `InfraResource` row deletion; drop `EnvironmentNetwork`.
4. GC sweep + plan-time network drift check; delete `self-network-reattach.ts`.

No stack-definition schema changes; no client changes except removing dead types. Existing networks lacking the new labels are handled by `ensure` back-labelling on next apply, and GC ignores unlabelled networks (never touches non-mini-infra networks).

---

## 3. Option B — Declarative network membership + reconciler (desired-state model)

**Thesis:** networks and network membership become first-class desired state, exactly like the stack/plan/apply model the product already uses for containers. Every feature *declares* memberships; a single reconciler converges Docker to that state — during apply, at boot, on Docker events, and on a periodic sweep. This is the structural fix: leaks, boot-reattach, drift blindness, and "who's on this network and why" all stop being possible categories of bug rather than individually patched.

### 3.1 Data model

```prisma
model ManagedNetwork {
  id            String   @id @default(cuid())
  scope         String   // 'host' | 'environment' | 'stack'
  environmentId String?  // set for scope=environment
  stackId       String?  // set for scope=stack (owner)
  purpose       String   // 'applications', 'egress', 'default', user-defined…
  name          String   @unique          // derived once at creation, then immutable
  driver        String   @default("bridge")
  options       Json?
  dockerId      String?                    // recorded from inspect
  subnet        String?                    // recorded, never prescribed (per MINI-64)
  status        String   @default("pending") // pending|present|missing|error
  memberships   NetworkMembership[]
  @@unique([scope, environmentId, stackId, purpose])
}

model NetworkMembership {
  id             String  @id @default(cuid())
  networkId      String
  network        ManagedNetwork @relation(...)
  // who should be attached — exactly one of:
  stackServiceId String? // managed service (resolved to live container(s) at reconcile time)
  containerName  String? // adopted/external container, or 'self' sentinel for the server
  aliases        Json?   // string[]
  staticIp       String? // egress gateway only
  source         String  // 'template' | 'user' | 'egress' | 'haproxy' | 'system'
  createdBy      String? // userId for source='user' — audit trail
  @@unique([networkId, stackServiceId, containerName])
}
```

Key properties:

- **Identity is `(scope, owner, purpose)`, not the name.** The name is derived once and stored; nothing ever re-derives a name to find or delete a network again (kills the whole L1 class). Discovery is a DB lookup — the HAProxy heuristic becomes `where purpose='dataplane', environmentId=X`.
- **Membership rows resolve to containers at reconcile time.** A `stackServiceId` membership matches whatever container(s) currently carry that service's labels — so blue-green replacements, pool workers (matched via their parent service), and recreated containers are re-converged automatically without per-feature attach code.
- **`source` + `createdBy` make every attachment explainable and auditable.** The app "connect to a database's network" feature (PR #473) becomes a `source='user'` membership row instead of a network name spliced into `containerConfig.joinNetworks` JSON — editable, listable, and shown in the UI with provenance.

### 3.2 Producers write rows; one reconciler acts

Everything that today calls `connect()` becomes a *declaration*:

| Today | Becomes |
|---|---|
| Stack apply network loops ×2 + resource outputs | Template compiler upserts `ManagedNetwork` + per-service memberships |
| `joinNetworks` / `joinResourceNetworks` / synthesised default | Compiled into membership rows (same compiler) |
| Egress injection attach | `source='egress'` memberships maintained per env policy (bypass services simply get no row) |
| HAProxy manual-frontend join | `source='haproxy'` membership on the dataplane network |
| App connect-to-container-network | `source='user'` membership written by the API route |
| `joinSelf`, monitoring self-join, `self-network-reattach.ts` | `containerName='self'` memberships; the boot hack is **deleted** |

**`NetworkReconciler.reconcile(scope?)`** — the single actor:

1. **Networks:** for each `ManagedNetwork`, ensure existence (create with labels, Docker-owned subnet), inspect and record `dockerId`/`subnet`/`status`. Detect spec mismatch (driver/options) and either warn or — when the network has no live members — recreate.
2. **Memberships:** resolve each row to live container IDs, diff against actual endpoints (one `listContainers` + endpoint scan), then connect missing / disconnect stale (only endpoints that a `mini-infra.managed` membership once created — never touches attachments made outside the system unless a row says so).
3. **GC:** a `ManagedNetwork` whose owner row is gone, or a stack network whose stack was destroyed, is removed once it has zero desired members — refcounted, ordered after disconnects, force-disconnect only for containers mini-infra owns.

Triggers: stack apply (scoped), server boot (full — replaces self-reattach with a *general* re-converge), Docker `network`/container `start` events (debounced, scoped), periodic sweep, and a manual `POST /api/networks/reconcile` for operators.

**Ordering guarantee preserved:** for *new* containers, the create→attach→start sequence stays (the reconciler exposes `converge(containerId)` used by the container-create path before `start`), so the documented DNS bootstrap race doesn't regress.

### 3.3 Plan/apply and UI integration

- The plan computer gains a **networks section** sourced from the reconciler's dry-run diff: `network missing`, `membership missing`, `stale membership`, `spec mismatch` — networks finally participate in Synced/Drifted like containers do (closes B1–B3 completely).
- The Networks tab upgrades from "list + delete" to showing, per network: owner, purpose, desired vs actual members, each membership's `source`/creator, and one-click reconcile. Environment detail generalises the existing egress card to all env networks.

### 3.4 Simplifying the declaration surface (optional follow-on)

With memberships as the runtime model, the four template mechanisms can collapse into one input shape:

```yaml
networks:
  - purpose: default            # scope defaults to stack
  - purpose: applications
    scope: environment          # replaces resourceInputs/outputs for docker-network
services:
  - name: api
    networks: [default, applications]   # replaces joinNetworks/joinResourceNetworks
```

Old fields remain accepted indefinitely and compile to the same rows — this is a reader-side translation, not a breaking change.

### 3.5 Risks and costs

- **Bigger blast radius**: schema migration + backfill (from `InfraResource`, stack `networks[]`, and every `containerConfig.joinNetworks/joinResourceNetworks`), and every producer path touched. Needs Option A-style phasing anyway (the reconciler *is* a NetworkManager plus a diff loop — A's module is reusable inside B).
- **Disconnect logic must be conservative.** Wrongly removing a "stale" endpoint is worse than today's leaks. Mitigation: phase 1 runs connect-only + report; disconnects gated behind a per-network `enforceMemberships` flag until trusted.
- **Blue-green/pool churn**: membership resolution by service labels must be well-tested against deployment green/blue container sets and pool spawn/reap.
- Roughly 6–8 phased PRs vs A's 4, and the schema is forward-only.

---

## 4. Comparison and recommendation

| Concern (§1.1) | Option A | Option B |
|---|---|---|
| L1/L2 destroy orphans | Fixed by label-driven removal | Fixed by identity-not-name model |
| L3/L4 env-delete leaks, dangling rows | Fixed (explicit removal + row delete + GC) | Fixed (refcounted GC) |
| B1 drift blindness | Basic (plan-time existence/membership check) | Complete (networks in plan/Synced/Drifted) |
| B3 out-of-band recreate / boot reattach | Improved (boot membership check) | Eliminated (continuous reconcile; hack deleted) |
| F1–F4 fragility (string-matching, dual remove, exists-on-error, silent egress catch) | Fixed | Fixed (inherits A's plumbing) |
| F5/F6 divergent semantics, 11 connect sites | Unified behind one API | Unified *and* declarative |
| "Why is this container on this network?" | Still code-archaeology | First-class, audited, in the UI |
| Template surface (4 mechanisms) | Unchanged | Optional collapse to 1 |
| Schema changes | Drop one dead table | New tables + backfill |
| Effort / risk | ~4 PRs, low risk, each revertible | ~6–8 PRs, medium risk, forward-only schema |

**Recommendation.** Do **Option A first, designed as Option B's substrate** — its `NetworkManager`, naming module, labels, and GC are exactly the plumbing B's reconciler needs, and A alone stops the bleeding (all ten leak/fragility defects) within a few low-risk PRs. Then decide on B based on trajectory: given how fast network-touching features are accumulating (egress firewall, NATS, Vault, pools, app-links, addons — each of which grew its own attach code), the membership model will pay for itself the next time one of them ships; the `source` column is also the natural hook for the egress firewall and future policy work. If only one will ever be funded, A is the pragmatic choice; B is the one that ends the whack-a-mole.

---

## Appendix — file inventory of today's network logic

- **Create:** `stack-reconciler.ts:167-183`, `:515-537` (duplicate), `stack-infra-resource-manager.ts:27-98`, `environment-manager.ts:654-931`; impl `docker-executor/infrastructure-manager.ts:18-83`.
- **Connect (11 raw sites):** `stack-container-manager.ts:260-270` (wrapper used by 5 callers), `self-network-reattach.ts:21`, `pool-spawner.ts:393,450,461,481`, `pool-addon-sidecar.ts:202`, `monitoring-service.ts:422`, `environment-manager.ts:761,978`, `manual-frontend-manager.ts:222`.
- **Disconnect:** `environment-manager.ts:972` (only site).
- **Remove:** safe `docker.ts:987-1022` (REST only); unsafe `infrastructure-manager.ts:196-211` (used by env delete `environment-manager.ts:498`, destroy `stack-destroy-helpers.ts:235`, dead `stack-reconciler.ts:1112`).
- **Dead/legacy:** `environment-networks.ts` router (never mounted), `EnvironmentNetwork.dockerId` (never written), `stack-reconciler.destroyStackInner` (dead but *correct*), `stackNetworkSchema.options` (accepted, never applied), `application-service-factory.ts` (legacy stub).
