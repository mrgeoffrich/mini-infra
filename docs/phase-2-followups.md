# Phase 2 Follow-up Work

Phase 2 ([design doc](stack-bundles-and-installer-improvements.md)) shipped
across five PRs. This file tracks what remains: small mini-infra
clean-ups, the slackbot-side migration, and Phase 3 stretch items.

## Status as of merge

| PR | Title | Status |
|---|---|---|
| [#248](https://github.com/mrgeoffrich/mini-infra/pull/248) | Phase 2 PR 1 — schema extension, ingest, permission gate | Merged |
| [#249](https://github.com/mrgeoffrich/mini-infra/pull/249) | Phase 2 PR 2 — apply-time Vault reconciliation | Merged |
| [#250](https://github.com/mrgeoffrich/mini-infra/pull/250) | Phase 2 PR 3 — system templates extended, `BUNDLES_DRIVE_BUILTIN` flag | Merged |
| [#251](https://github.com/mrgeoffrich/mini-infra/pull/251) | Phase 2 PR 4 — snapshot rollback on partial failure | Merged |
| [#252](https://github.com/mrgeoffrich/mini-infra/pull/252) | Phase 2 PR 5 — DELETE cascade with sharing rules | Merged |
| Flag-flip in dev compose | This PR | Merged |

The `BUNDLES_DRIVE_BUILTIN` flag is now **on by default in the worktree
dev environment**. With no system templates currently declaring a
non-empty `vault: {…}` section beyond `hello-vault` (which is
environment-scoped and only deployed if explicitly instantiated), the
flag flip is a no-op for the existing dev catalogue — it primes the
codepath for future system-template additions.

## Mini-infra TODO

### 1. Flag rip — remove the `BUNDLES_DRIVE_BUILTIN` guard

**Trigger:** after the flag has been on in dev for one soak week with
no surfaced regressions.

**Scope:** small cleanup PR.

- Remove the `if (BUNDLES_DRIVE_BUILTIN)` block from
  [`server/src/server.ts`](../server/src/server.ts) (around the
  `Running builtin vault reconcile` startup banner).
- Remove the exported `BUNDLES_DRIVE_BUILTIN` constant from
  [`server/src/services/stacks/builtin-vault-reconcile.ts`](../server/src/services/stacks/builtin-vault-reconcile.ts).
- Remove the env var line from
  [`deployment/development/docker-compose.worktree.yaml`](../deployment/development/docker-compose.worktree.yaml)
  (added in this PR).
- Remove the boot-ordering integration test that asserts the flag-gate
  in [`server/src/__tests__/builtin-vault-reconcile-boot-order.integration.test.ts`](../server/src/__tests__/builtin-vault-reconcile-boot-order.integration.test.ts).
  Or update it to assert the unconditional execution.
- Update [`docs/slackbot-installer-migration.md`](slackbot-installer-migration.md)
  references that mention the flag (none currently — verify).

Estimated impact: ~20 lines removed, 1 test updated.

### 2. Cross-stack dep check on DELETE

**Background:** PR 5's brief assumed `DELETE /api/stacks/:id` would
return `409` if another stack consumes this stack's outputs (via the
existing `resourceOutputs/Inputs` mechanism). The implementing agent
found that `StackResourceInput` doesn't carry a `sourceStackId` field,
so there's no way to query "which stacks consume this stack's
outputs?" cleanly. The check was deferred.

**Scope:** one small PR.

- Add `StackResourceInput.sourceStackId String?` (FK to `Stack.id`)
  to the Prisma schema.
- Backfill: at instantiate time when a `resourceInputs[]` entry binds
  to a `resourceOutputs[]` entry, write the source stack ID.
- In `stack-vault-deleter.ts` (or the surrounding DELETE route), refuse
  with `409 stack_outputs_in_use` if any other stack has a
  `StackResourceInput` row pointing at this stack.
- Tests: cross-stack consumer present → 409; consumer absent → cascade
  proceeds.

**Trigger:** before the first real cross-stack consumer ships. Today
no system stack consumes another's outputs across instances; this is
not a current regression. Worth bundling with the slackbot installer
work if slackbot grows to consume haproxy outputs (e.g. a tunnel URL).

### 3. `POST /api/stack-templates` accepting `vault` and `inputs` directly

**Background:** PR 4's smoke discovered that the create endpoint
schema rejects `vault` and `inputs` fields — they must be submitted
via `POST /:id/draft` separately. This forces external installers
into a 5-call sequence (create → draft → publish → instantiate →
apply) when 4 calls (create-with-spec → publish → instantiate →
apply) would suffice.

**Scope:** small DX win.

- Extend `createStackTemplateSchema` in
  [`server/src/services/stacks/stack-template-schemas.ts`](../server/src/services/stacks/stack-template-schemas.ts)
  to accept `vault` and `inputs` and the full service shape. If
  present, the create handler internally upserts the metadata row
  AND seeds an initial draft with the body.
- Permission gate: same `template-vault:write` requirement applies.
- Tests: create-with-spec shipping a draft, create-without-spec still
  works (backwards compatible).

**Trigger:** at slackbot installer migration time, if the team
prefers fewer round-trips. Otherwise can wait.

### 4. Optional `POST /api/stack-templates/:name/install` shim

**Background:** Phase 2 design doc §3.A floated a thin DX endpoint
that wraps publish + instantiate + apply for "POST one document, get
a running stack" semantics. Optional — nothing in mini-infra requires
it.

**Scope:** ~50 line route handler that composes existing endpoints.
Not new mechanism. Could land alongside slackbot installer work.

**Trigger:** if slackbot or other external installers want a one-shot
endpoint. Skip if 5 calls is acceptable.

## Slackbot side

### PR 6 — slackbot installer reduction

**Lives in:** `slackbot-agent-sdk` repo (separate from mini-infra).

**Owner:** slackbot-agent-sdk maintainer.

**Goal:** collapse [`environment/install-mini-infra.ts`](../../slackbot-agent-sdk/environment/install-mini-infra.ts)
from 686 lines to ~190 by adopting the bundle-shaped flow.

**Guide:** [docs/slackbot-installer-migration.md](slackbot-installer-migration.md)
in this repo. Self-contained — slackbot maintainer should not need to
read mini-infra's PR descriptions to migrate.

**Blocking dependencies:** none. All required mini-infra capabilities
are merged. Cross-stack dep check (mini-infra TODO #2 above) is a
soft prereq if slackbot grows to consume haproxy outputs.

## Phase 3 stretch goals

These were sized in the [Phase 2 design doc §4](stack-bundles-and-installer-improvements.md)
as "operational quality of life" — independent, can land any order,
none blocking. Listed here in priority lean.

| Item | Effort | Slackbot benefit |
|---|---|---|
| **Streaming/blocking apply** (`POST /api/stacks/:id/apply?wait=jsonl`) | S | Replaces the slackbot installer's 3-second polling loop with a single long-poll. Better fidelity, simpler client. |
| **`@mini-infra/sdk` package** | M (mostly mechanical) | Replaces the hand-rolled fetch wrapper in `slackbot-agent-sdk/environment/install/mini-infra-api.ts`. |
| **Non-interactive Vault bootstrap** | S | Slackbot installer's reachability check currently bails with "go to UI" if Vault isn't initialised. Bundle apply could lazily trigger bootstrap with a passphrase from install config. |
| **Pool token introspection** (`GET /api/stacks/:id/pools/:svc/management-token-meta`) | S | Lets the slackbot installer's post-apply reachability check validate the pool token resolved without trusting the apply. |
| **`POST /api/images/build`** | M (genuinely new) | Lets CI delegate `docker build` to mini-infra rather than mounting `/var/run/docker.sock` into the runner. Local-dev users likely don't need it. Skip unless a real CI use case shows up. |

None of these are scheduled. They're tracked here so they don't fall
out of the design conversation.

## Soak window plan

1. **Now (flag flipped in dev):** the `BUNDLES_DRIVE_BUILTIN=true` path
   exercises on every dev container restart. It's a no-op for the
   current system stack catalogue but the codepath sees real boot
   sequencing.

2. **+1 week:** if no regressions surface in dev, propagate the flag
   flip to any production deploy compose (out of scope for this PR;
   manual operator action depending on deploy environment).

3. **+2 weeks:** rip the flag (mini-infra TODO #1).

4. **In parallel:** slackbot installer migration begins whenever the
   slackbot maintainer picks it up.

## References

- [Phase 1 design doc](stack-bundles-and-installer-improvements.md)
- [Slackbot installer migration guide](slackbot-installer-migration.md)
- Original Phase 1 friction list: `slackbot-agent-sdk/docs/mini-infra-installer-future.md` (in the slackbot repo)
