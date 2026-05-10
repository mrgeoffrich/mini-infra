# Service Addons — Pool integration (Phase 6)

**Status:** the Service Addons framework and the two v1 Tailscale addons shipped through Phases 1–5 (#364, #379, #383, #394, #396), plus follow-up fixes #398, #403, #404. Phase 6 — extending addons to pool services — is the only remaining phase. Caddy-auth and OIDC scopes were cancelled. Deferred items surfaced during smoke-testing live in [`addons-egress-followups.md`](./addons-egress-followups.md).
**Builds on:** the shipped addon framework under [`server/src/services/stack-addons/`](../../../server/src/services/stack-addons/) (the `addons:` block on `stackServiceDefinitionSchema`, the `expandAddons()` render pass, the `AddonDefinition` / `AddonMergeStrategy` contracts, and the `tailscale-ssh` / `tailscale-web` addons), plus the existing `Pool` service type plumbing ([`PoolConfig`](../../../lib/types/stacks.ts), [`pool-spawner.ts`](../../../server/src/services/stacks/pool-spawner.ts), [`pool-instance-reaper.ts`](../../../server/src/services/stacks/pool-instance-reaper.ts)).
**Vendor reference:** [docs/architecture/vendor/tailscale-auth.md](../../architecture/vendor/tailscale-auth.md) — Tailscale credential and ACL mechanics.

---

## 1. Background

Phases 1–5 built the addon framework around the trick that the user's authored stack is never modified by addons — instead a render pass runs before the reconciler, expanding `addons:` declarations into rendered `StackServiceDefinition`s flagged `synthetic: true`. The two v1 Tailscale addons attach as sidecars to `Stateful` and `StatelessWeb` services, mint per-application authkeys, and register tailnet devices under a `{stack-name}-{service-name}-{env-name}` hostname (sanitised to `[a-z0-9-]`, ≤63 chars, with an FNV-1a-32 hash fallback when oversized).

Pool services (the existing `Pool` service type — a container blueprint that's instantiated on demand) were always part of the framework's intended scope but were deferred from the v1 ship to keep static-service Phases 1–5 reviewable. With static-service addons now stable in dev and production, Phase 6 closes the loop.

## 2. Phase 6 — Pool integration

**Goal:** addons declared on a pool service materialise per pool instance at spawn time, so each pool worker gets its own sidecar identity, per-instance hostname, and per-instance credentials.

Deliverables:
- `pool-spawner.ts` invokes the addon render pipeline with `instance: { instanceId }` populated, producing per-instance provisioned credentials and per-instance `StackServiceDefinition`s for each addon application. The addon framework already plumbs `ExpansionContext.instance` for this case — the gap is on the spawner side.
- Per-instance hostname rule `{stack-name}-{service-name}-{env-name}-{instance-id}` (sanitised, ≤63 chars; FNV-1a-32 hash fallback when oversized). Re-uses `sanitizeTailscaleHostname` with the instance-id appended as a fourth segment.
- Per-instance addon sidecars carry `mini-infra.stack-id`, `mini-infra.service`, `mini-infra.pool-instance-id`, `mini-infra.addon: <kind-or-id>`, and `mini-infra.synthetic: true` labels.
- `pool-instance-reaper.ts` extension: invokes addon `cleanup()` hooks and removes addon sidecar containers when instances are reaped.
- Per-instance addon sidecars emit `containerConfig.requiredEgress` flowing into the env's policy reconcile the same way static addon services do, so per-instance sidecars work in firewalled envs without manual policy edits.
- Connect panel pool-row disclosure: pool service rows expand to show per-instance rows with their own `ssh` / HTTPS actions.
- Per-instance hostname displayed alongside the existing instance-id column on the pool detail page.

Reversibility: safe — pool addon support is additive. Pools without `addons:` declarations are unaffected. Per-instance provisioning failures fall through the existing pool-spawn error path.

UI changes:
- Stack detail Connect panel: pool service rows expand to per-instance rows, each with their own `ssh` / HTTPS actions. [design needed] — disclosure pattern for a pool with N instances; how to handle 50-instance pools without flooding the panel.
- Containers page: per-instance addon sidecars appear with `mini-infra.synthetic` and `mini-infra.pool-instance-id` labels visible. [no design] — fits existing container-row label rendering.
- Pool detail: per-instance hostname (`{stack}-{service}-{env}-{instance-id}`) shown alongside the existing instance-id column. [no design].

Schema changes: none.

Done when: a pool service with `addons: { tailscale-ssh: {} }` spawns N instances, each registers as its own tailnet device with the per-instance hostname pattern, an operator can SSH into a specific instance by name, and idle reaping removes both the worker container and the sidecar (and the device from the tailnet via ephemeral cleanup) — including in a firewalled env where per-instance sidecars must reach the tailnet without manual policy edits.

Verify in prod: at least one production pool service with `tailscale-ssh` shows N tailnet devices for N instances, names match the `{stack-name}-{service-name}-{env-name}-{instance-id}` pattern, and idle reaping removes both worker and sidecar within the ephemeral-cleanup window without orphan devices.

## 3. Open questions

- **Pool instance Tailscale state volume.** Per-instance state volumes are cheap, but pool instances are short-lived and authkeys are minted per-spawn. With ephemeral nodes auto-cleaning, the volume is effectively write-only. Validate that skipping the volume on pool instances doesn't introduce a re-registration race; pick the cleaner of the two paths.

## 4. mk tracking

- MINI-48 — Phase 6: Pool integration
