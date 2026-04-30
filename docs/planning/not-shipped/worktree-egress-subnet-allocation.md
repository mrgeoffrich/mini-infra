# Per-worktree egress subnet allocation (design)

Status: **planned, not implemented**. Follow-up to [#275](https://github.com/mrgeoffrich/mini-infra/pull/275) (orphan-bridge sweep on worktree delete).

## Problem

Two parallel WSL2 worktrees both pick `172.30.0.0/24` for their `local-applications` Docker network and stomp on each other in the kernel's FIB. PR #275 fixes the *cleanup* failure mode (orphan bridges left behind by partial teardown). It does not fix the *concurrent* failure mode: two running worktrees can still independently pick the same subnet today.

Root cause:

- WSL2's default NAT networking puts every running distro in **one shared kernel network namespace** (`readlink /proc/self/ns/net` returns the same id from every distro — verified empirically).
- Each worktree's `mini-infra-server` runs `EgressNetworkAllocator.allocateSubnet()` against its **own DB and its own Docker daemon's `network ls`**. It can't see what subnets siblings have used.
- Each worktree therefore picks slot 0 (`172.30.0.0/24`) for its first env. Two `br-<id>` bridges with the same `/24` route end up in the FIB; the kernel picks one round-robin per lookup; half the packets disappear into an empty veth.

The bridge sweep makes the problem visible at delete time. It doesn't help two daemons running side-by-side.

## Goals

1. Two concurrent worktrees never pick the same applications subnet — by construction, not by retry.
2. Zero coordination at `mini-infra-server` runtime. The allocator's per-DB view stays correct because the *pool* it draws from is already disjoint.
3. No global system config (no `.wslconfig`, no kernel modules). Mirrored mode is rejected separately on its own merits — see [#275 PR discussion](https://github.com/mrgeoffrich/mini-infra/pull/275).
4. Backwards compatible: existing worktrees keep their already-allocated subnets when the change rolls out.

## Non-goals

- Cross-host coordination. This is dev-tooling only; one developer's machine.
- Defending against malicious workloads inside the dev VM.
- Reclaiming subnets when a worktree is deleted. Slots are reused via the existing port-slot reuse path; subnet assignments follow the slot for free.

## Design

Slice the existing egress pool into per-worktree pools, keyed off the same slot the port allocator already uses.

```
Pool:      172.30.0.0/16          (existing default, ~65k addresses)
Per worktree slice: /22           (4 contiguous /24 subnets = 4 envs per worktree)
Slots:     64                     (256 / 4)

Slot 0  → 172.30.0.0/22           covers .0/.1/.2/.3 .0/24
Slot 1  → 172.30.4.0/22           covers .4/.5/.6/.7 .0/24
...
Slot 63 → 172.30.252.0/22         covers .252-.255 .0/24
```

Each worktree's `mini-infra-server` is launched with `MINI_INFRA_EGRESS_POOL_CIDR` set to its own `/22`. Inside that pool, the existing per-env allocator continues to hand out `/24`s sequentially. Two worktrees in slots 0 and 1 can both ask for "the lowest free /24 in my pool" and reach for `172.30.0.0/24` and `172.30.4.0/24` respectively — disjoint, no coordination.

### Why /22, not /20

A /22 gives 4 envs per worktree, which covers the realistic dev case (production + staging + maybe a couple of feature envs) and lets us fit 64 worktree slots into the default `172.30.0.0/16` pool without changing the wider net. The current port allocator advertises 100 slots but in practice we've never seen more than 5–6 concurrent. 64 is a safe ceiling for dev with comfortable headroom.

If we ever do need more than 64 concurrent worktrees with > 4 envs each, expand the pool (see [Future expansion](#future-expansion)).

### Why slot-keyed, not random

- **Stable across re-runs.** A worktree keeps the same slot across `pnpm worktree-env start` re-runs (the registry already enforces this for ports), so it keeps the same subnet pool. No DB migration churn each run.
- **Trivial to reason about.** "Slot 3 → ports 3103/5103/8203/2503 → subnet `172.30.12.0/22`" is mechanical. Operators can spot-check from `pnpm worktree-env list` output.
- **No global allocator state needed.** The slot is already in `~/.mini-infra/worktrees.yaml`. We just compute the CIDR from it on each start.

### Worktree registry

Add one field to `WorktreeEntry`:

```ts
export interface WorktreeEntry {
  // ...existing fields...

  /**
   * Per-worktree slice of the egress pool, derived from the worktree's
   * port slot. Empty until the worktree is started under a build that
   * supports per-worktree pool slicing — older entries fall through to
   * the default 172.30.0.0/16 pool and behave as today.
   */
  egress_pool_cidr?: string;
}
```

It's stored for visibility (operator can see "this worktree owns 172.30.12.0/22" in `pnpm worktree-env list`) and forensics, not as the source of truth. The source of truth is the slot.

### Allocator behavior

`PortAllocation` gains one field; the existing `allocatePorts(profile)` returns it alongside the ports:

```ts
export interface PortAllocation {
  // ...existing port fields...
  egress_pool_cidr: string; // e.g. "172.30.12.0/22" for slot 3
}
```

Math:

```
const slot = ...; // existing slot derivation
const baseInt = (172 << 24) | (30 << 16);
const sliceInt = (baseInt + slot * 4 * 256) >>> 0; // 4 /24s = 1024 addresses
const o2 = (sliceInt >> 8) & 0xff;
const o3 = sliceInt & 0xff;
const cidr = `172.30.${o2}.${o3}/22`;
```

If a profile is in slot `>= 64`, throw — pool exhausted, document the override.

### Server side

`server/src/services/egress/egress-network-allocator.ts` already reads the pool from `MINI_INFRA_EGRESS_POOL_CIDR`. No code change there.

### Compose plumbing

`deployment/development/docker-compose.worktree.yaml` adds the env var to the `mini-infra` service:

```yaml
environment:
  - LOG_LEVEL=debug
  - ALLOW_INSECURE=true
  - ENABLE_DEV_API_KEY_ENDPOINT=true
  - BUNDLES_DRIVE_BUILTIN=true
  - MINI_INFRA_EGRESS_POOL_CIDR=${EGRESS_POOL_CIDR}
```

`deployment/development/worktree-start.ts` adds it to `stackEnv` so the substitution resolves:

```ts
const stackEnv: NodeJS.ProcessEnv = {
  // ...existing vars...
  EGRESS_POOL_CIDR: egressPoolCidr,
};
```

### environment-details.xml

Add an `<egressPool>` field to the generated XML so test/CI scripts can read the assigned pool the same way they read ports.

## Implementation checklist

1. [ ] `lib/registry.ts`: extend `PortAllocation` with `egress_pool_cidr`, compute it from slot in `allocatePorts`, throw on slot ≥ 64.
2. [ ] `lib/registry.ts`: add `egress_pool_cidr?: string` to `WorktreeEntry`, persist via `upsertEntry`.
3. [ ] `worktree-start.ts`: pass `EGRESS_POOL_CIDR=<allocated>` into `stackEnv`.
4. [ ] `docker-compose.worktree.yaml`: add `MINI_INFRA_EGRESS_POOL_CIDR=${EGRESS_POOL_CIDR}` to the mini-infra service env.
5. [ ] `lib/env-details.ts`: emit `<egressPool>` in `environment-details.xml`.
6. [ ] `worktree-list.ts`: surface the pool in `--wide` output.
7. [ ] `wsl2-reference.md`: replace the sweep-remediation note with a "subnets are slot-allocated, no manual override needed" note.
8. [ ] Tests: a small unit test in `deployment/development/__tests__/registry.test.ts` (need to create the test setup; the dev scripts have none today) that asserts `slot N → 172.30.(4N).0/22`.

## Migration

- Worktrees existing at upgrade time keep running on their already-allocated app networks. The next time they're started, they'll get a `MINI_INFRA_EGRESS_POOL_CIDR` set to their slot's slice.
- The server-side allocator reuses the existing `local-applications` subnet if the network already exists (see `provisionEgressGateway` step 1 in `environment-manager.ts`). So an already-provisioned env won't churn its subnet — the new pool only governs *new* envs the worktree creates after the upgrade.
- For a clean cutover, a user can `pnpm worktree-env start --reset` to wipe the DB and let the env be re-created in the new pool. Optional, not required.

## Future expansion

If 64 worktrees × 4 envs is ever insufficient:

1. **Wider base, smaller slice.** Switch the default to `10.96.0.0/12` and allocate a /20 per slot. That's 4096 slots × 16 envs each. Painless to flip — `MINI_INFRA_EGRESS_POOL_CIDR` already controls the base; the slot→CIDR math swaps.
2. **Two-tier pool.** Reserve `172.30.0.0/16` for the first 64 worktrees (no env override needed; default just works), spill into a configured `MINI_INFRA_EGRESS_POOL_OVERFLOW_CIDR` for slots 64+.

Both are safely deferred. Not needed for shipping this.

## Alternatives considered

### A. Switch WSL2 to `networkingMode=mirrored`

Mirrored mode is documented as bridging WSL↔Windows, not isolating distro↔distro. Microsoft's docs use "shared network space" language consistently and the community has hit Docker compatibility issues with mirrored mode (TCP stalls — moby/moby#48201, port-forward breakage — microsoft/WSL#10494, local DNS interference). It also requires editing `~\.wslconfig`, which is a global change affecting every distro the user has, not just mini-infra. Rejected — solving a local problem with a global config change with known Docker incompatibilities is the wrong trade.

### B. Run dockerd inside its own netns per distro

`unshare -n` the dockerd inside each distro so its bridges live in a private netns. Genuinely isolates, but:

- Has to thread netns visibility through every `docker exec`, every container start, every tool that runs against the daemon. Compose, the registry, mini-infra itself.
- Loses `localhostForwarding` from Windows for free — we'd need to set up portmap/socat plumbing inside each isolated netns to make `localhost:<port>` work again on Windows.
- Future-fragile against WSL2 networking changes.

Rejected — high implementation cost, large surface area, fragile.

### C. Coordinate via an additional global lock file

`~/.mini-infra/subnets.yaml` records every active `(profile → cidr)`. Each `mini-infra-server` reads it at start and avoids subnets in use. Works, but:

- Creates a runtime dependency the server doesn't have today (reading host-side config from inside the container).
- Adds a coordination point that can drift from reality (file says X is in use, but the worktree was force-killed and never cleaned up).
- The slot-keyed approach gets the same outcome with strictly less moving state.

Rejected — overkill.

### D. Detect collision at server start, fail loudly, ask user to re-run

Cheap to build, terrible UX — bites the user every time they start a second worktree.

### E. Random subnet picker with retry

Allocator picks a random /24 not already in `docker network ls`, retries up to N times. Avoids slot bookkeeping but reintroduces the race: worktree A picks `.5.0/24`, worktree B independently picks `.5.0/24` between A's check and A's create. Rejected.

## Risks

- **Slot ≥ 64 panic.** A user with > 64 lifetime worktrees in `worktrees.yaml` (even if mostly inactive) could hit the throw. The existing port allocator caps at 100 slots, so the registry already grows to that ceiling. Mitigation: in `allocatePorts`, when computing the egress CIDR, if slot >= 64 fall back to the default pool *and* log a loud warning ("worktree N at slot ≥ 64 falls back to shared default pool — collision risk; clean up old worktrees with `pnpm worktree-env cleanup`"). Deferred; document for now.
- **Dev users with VPN/LAN on `172.30.0.0/16`.** If their corporate VPN allocates from `172.30.x.x`, all dev worktrees will collide with the VPN regardless of slicing. Mitigation: doc the `MINI_INFRA_EGRESS_POOL_CIDR` override; same as today.
- **The /22 size assumption.** If a single dev needs >4 envs in one worktree, they hit `Egress subnet pool exhausted` from the per-worktree allocator. Realistic? Unclear. Mitigation: revisit when it bites; meanwhile a user can override via `MINI_INFRA_EGRESS_POOL_CIDR` to a wider slice.

## Test plan

- Unit: slot N → CIDR mapping. `n=0 → 172.30.0.0/22`, `n=3 → 172.30.12.0/22`, `n=63 → 172.30.252.0/22`, `n=64 → throws`.
- Integration: spin two worktrees in parallel, verify `local-applications` networks have non-overlapping subnets via `wsl -d <distro> -- docker network inspect local-applications`.
- Regression: existing worktree at slot 0 with already-provisioned `172.30.0.0/24` keeps working — re-running `pnpm worktree-env start` doesn't migrate it, and inter-container connectivity is intact.
- Cross-test against #275 sweep: with two worktrees up and disjoint subnets, deleting one should sweep only its own bridges and leave the other's intact (the sweep already does this; this just confirms the math).
