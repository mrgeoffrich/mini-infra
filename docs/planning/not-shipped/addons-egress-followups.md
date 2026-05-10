# Addons + Egress Integration — Deferred Follow-Ups

**Status:** Tracking doc for work intentionally not in PR #398.
**Companion to:** [`docs/planning/not-shipped/service-addons-plan.md`](./service-addons-plan.md)

PR #398 landed nine commits that took the Service Addons framework from
"applies cleanly in unit tests" to "an end-to-end nginx + tailscale-web
stack joins the tailnet, traverses the egress firewall, and is no-op on
re-apply." Every commit was driven by a real failure surfaced while
smoke-testing the addon end-to-end against a worktree dev env, so the
PR's scope grew beyond the original "make the addon framework work in
plan + apply" into the egress data plane that addon-derived sidecars
depend on.

The items below were surfaced during that smoke and are explicitly out
of scope for #398. Each is sized so it can be picked up independently —
none is load-bearing on another.

---

## Synthetic services in `reconciler.update` and `pool-spawner`

**Symptom.** PR #398 made `reconciler.plan` and `reconciler.apply`
synthetic-aware (dryRun expansion, planStub, plan-computer iterates
rendered defs, Stateful handler tolerates `svc: null`). Two siblings still
call `resolveServiceConfigs` without `connectedServices` and without
`dryRun: true`:

- `server/src/services/stacks/stack-reconciler.ts:497` — inside `updateInner`,
  the body of `reconciler.update()` (force-pull update flow).
- `server/src/services/stacks/pool-spawner.ts:115` — pool-instance spawn.

Either path will reproduce the original "Addon expansion failed on
service X (addons: tailscale-*): requires connected service tailscale but
it is not configured" error if used against an addon-using stack.

**Tasks.**
- Build the same `addonExpansion = { connectedServices: { tailscale: new TailscaleService(prisma) }, progress: ... }` value that the apply route already constructs, and pass it through both call paths.
- For `pool-spawner` specifically: pool services may want addon expansion to run with a per-instance synthetic service-name suffix; the existing addon framework supports that via `ExpansionContext.instance` (already plumbed for spawner callers).
- Add a regression test covering each path with the noop test addon registry, mirroring the existing `definition-hash-addons.test.ts` pattern.

**Verification.** A stack with `addons: { tailscale-web: {...} }`
applied through `POST /api/stacks/:id/update` (the route that drives
`reconciler.update`) succeeds and the synthetic sidecar is recreated with
a fresh authkey. A pool-service stack with addons spawned via the
existing pool-spawn API materializes per-instance synthetics.

---

## Apply-route setup-failure path doesn't write `lastFailureReason`

**Symptom.** When `reconciler.plan(stackId)` throws inside
`runApplyInBackground` — which is the failure surface for "addon
expansion failed" plus any other pre-reconciler error — the catch at
`server/src/routes/stacks/stacks-apply-route.ts:343-352` logs an `error`,
calls `userEvent.fail(error)`, and emits `STACK_APPLY_FAILED` on the
socket channel. It does **not** write `lastFailureReason` to the `Stack`
row, and the row's `status` stays at whatever it was before the apply
(typically `undeployed` for a fresh stack).

To an operator polling `GET /api/stacks/:id` or watching the UI without
the task tracker open, the apply looks like a silent stall — the route
returned `{started: true}`, the row never moves off `undeployed`, and
the failure is only visible in server logs or as an ephemeral socket
event that's gone the next time the page loads.

**Tasks.**
- In the outer catch block (`stacks-apply-route.ts:353-366`), before
  calling `emitStackApplyFailed`, write `lastFailureReason` and possibly
  flip `status` to `error` so the row reflects the failure.
- Decide whether the inner reconciler-failure catch (line 342-352) should
  do the same writeback, or leave that to the reconciler itself.
- Match whatever convention `reconciler.apply`'s success path uses for
  clearing `lastFailureReason` on a subsequent successful apply — the
  fix shouldn't leave an old failure reason lingering after recovery.
- Add a regression test that POSTs an apply against a stack designed to
  fail in the setup phase (e.g. an unregistered addon id) and asserts
  `GET /api/stacks/:id` shows `status: "error"` and a populated
  `lastFailureReason` afterwards.

**Verification.** After an addon-expansion failure or any other
pre-reconciler throw, `GET /api/stacks/:id` reflects the failure for
operators who don't have the task tracker open.

---

## Dev-startup Vault auto-unlock

**Symptom.** Every `pnpm worktree-env start` (and every `docker restart
mini-infra-bold-lynx-mini-infra-1` in dev) leaves Vault sealed. Until
the operator manually `POST`s `/api/vault/passphrase/unlock`, the
server's NATS bus can't fetch its own creds, every NATS-dependent
subsystem times out (egress rule push, container map push, jetstream
bootstrap), and downstream features fail in confusing ways. PR #398's
`fix(nats): wait up to 5 min for bus before giving up on system
bootstrap` papered over the worst symptom (the EgressFwEvents stream
silently never seeding) but the root ergonomic issue remains.

The dev seeder writes `~/.mini-infra/dev.env` containing a Vault
passphrase, and `vaultServices.passphrase.tryAutoUnlockFromEnv()` is
already called at server start
(`server/src/server.ts:353`). Either the env var isn't being seeded into
the container, the auto-unlock logic isn't reading the right key, or
there's a race where the unlock runs before the env var is loaded.

**Tasks.**
- Audit `tryAutoUnlockFromEnv` against the dev seeder's env-var output:
  is the passphrase exposed under the expected key
  (`MINI_INFRA_VAULT_PASSPHRASE` or similar)?
- Confirm the env var actually lands in the running app container — check
  `docker inspect` against the dev compose file and the worktree-env's
  env-injection path.
- If everything is wired correctly but the unlock simply hasn't been
  attempted yet at the right moment, retry on the bus's first connect
  attempt or wire it into the same `bootstrapNatsSystemResources` retry
  loop that PR #398 added.

**Verification.** `pnpm worktree-env start` followed by hitting the API
without a manual unlock call shows: bus connects within ~5s, the system
bootstrap fires within its existing 5-min budget, every NATS-dependent
subsystem comes up cleanly. No manual `curl POST /api/vault/passphrase/unlock`
needed for the smoke loop.

---

## `forcePull` should recreate the container when only role permissions change

**Symptom.** While verifying the fw-agent role-perms fix (commit
`1debc9a`), `forcePull: true` on `POST /api/stacks/:id/apply` ran the
image pull, found the image SHA unchanged (the role-perm fix was
server-side TS, not in the agent's Go binary), saw no other definition
delta, and emitted `noOps:1`. The fw-agent container kept running with
its old JWT — the new role permissions in NATS were materialized but the
container's `dynamicEnv.NATS_CREDS` was still the JWT minted at the
last container-create. The fix was to manually
`docker rm -f mini-infra-egress-fw-agent-egress-fw-agent` and trigger a
re-apply, which the plan computer correctly saw as `service not deployed`
→ `create`.

The architectural gap: the role-permission delta affects only the
service's `dynamicEnv` resolution, which is intentionally not part of
the definition hash (so transient secrets don't trigger spurious
recreates). But that exclusion catches BOTH "secret rotated"
(legitimately should not recreate) AND "role permissions changed"
(should recreate so the service picks up the new JWT).

**Tasks.**
- Distinguish "permission delta" from "secret-content delta" on the
  role-credential path. One option: hash the role's `publishAllow` /
  `subscribeAllow` (which IS part of the materialized
  `NatsCredentialProfile` row, not the per-mint JWT) into the service
  definition hash so the plan picks up perm changes as `recreate`.
- Or: make the apply path detect that the materialized role profile's
  permissions changed since the last applied state and promote the
  no-op to recreate — analogous to the existing `promoteStalePullActions`
  helper that handles the image-SHA case.
- Add a regression test against the noop addon registry: change the
  role's permission set, verify the next apply emits `recreate` for the
  bound service.

**Verification.** Bumping a role's `publish`/`subscribe` list in a
template re-applies the stack as `recreate`, the container comes up with
a freshly-minted JWT carrying the new permissions, and operators don't
have to remember to `docker rm -f` to pick up the change.

---

## `reconcileTemplateRules`-on-apply may double-up on hot-path latency

**Symptom (theoretical).** PR #398 added
`egressLifecycle.reconcileTemplateRules(stackId, ...)` to the apply
route's hot path
(`server/src/routes/stacks/stacks-apply-route.ts`). The reconciler is
cheap when nothing changed — just a few SELECTs and a no-op compare —
but on every apply it ALSO triggers a gateway push if there's any delta.
On a busy env where many stacks apply together (e.g. a stack-template
update that touches dozens of stacks), every apply will fire its own
push. The gateway already coalesces by debouncing, but the server-side
push code path runs unconditionally per apply.

**Tasks.**
- Measure: how often does `reconcileTemplateRules` actually find a delta
  on apply? In steady state (no addon code changes) it should be zero.
- If the cost is real, debounce or coalesce server-side per env (the
  container-map pusher already does this — see
  `egress-container-map-pusher.ts:135-147`). Otherwise leave as-is.

**Verification.** Apply latency p50/p99 in steady state is unchanged
after the apply-time reconciliation lands.

---

## Addon-expansion warnings on the apply path are not surfaced to operators

**Symptom.** When dryRun expansion fails inside
`reconcileTemplateRules` (e.g. an addon implementation throws during
`planStub`), the catch block logs a `warn` and falls back to authored-
services-only rule promotion. The apply itself succeeds. But the operator
has no way of knowing their addon's `requiredEgress` was silently
dropped from the rule set — `enforce_would_deny` would suddenly start
firing on production traffic if the env was in enforce mode.

**Tasks.**
- Plumb a non-fatal warning back through the apply pipeline so the
  task tracker / event log shows "addon expansion partial — N synthetic
  patterns dropped" with the underlying error.
- Or: emit a dedicated socket event the UI can render as a banner on the
  stack detail page.

**Verification.** A planStub-throwing test addon registered alongside a
real addon results in: apply still succeeds with the real addon's rules
in place, but the failure is visible in the task tracker / event log.

---

## Test seam for the `enforce_would_deny` regression

**Symptom.** The `enforce_would_deny` symptom from PR #398's
investigation was a real architectural defect (apply didn't trigger
`reconcileTemplateRules`, so existing stacks frozen with empty
allowlists), but there's no automated test that would have caught it.
The existing addon tests exercise expansion in isolation; the existing
egress tests exercise the rule reconciler with mocked stacks. Nothing
hits the apply → reconcile → push → gateway-decision pipeline together.

**Tasks.**
- Stand up an integration-style test against `testcontainers`
  `nats:2.12.8-alpine` + a stub HTTP "smokescreen" — apply a stack with
  a synthetic-service requiredEgress, assert the gateway sees a CONNECT
  for the right hostname with `decision_reason: "host matched allowed
  domain in rule"` and `enforce_would_deny: false`.
- Or, lighter-weight: an integration test against the apply route that
  inspects `prisma.egressRule.findMany` after an apply against a
  noop-addon stack and asserts the rules exist with the right patterns
  and targets.

**Verification.** A regression where `reconcileTemplateRules` stops
running on apply (or stops harvesting synthetic services) is caught in
CI rather than at smoke-test time.
