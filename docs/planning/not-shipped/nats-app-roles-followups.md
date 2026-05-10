# NATS App Roles & Subject Scoping — Deferred Follow-Ups

**Status:** Tracking doc for work intentionally not in the initial PR.
**Companion to:** [`docs/planning/shipped/nats-app-roles-plan.md`](../shipped/nats-app-roles-plan.md)

The first PR landed Phases 1, 2, 3, and 5 of the design — the type surface,
validation, prefix allowlist, role materialization, and cross-stack
imports/exports. A follow-up PR landed **Phases 0 and 4** plus the
**`NatsCredentialProfile` orphan-profile cleanup** hardening item: the
`vault-nats` stack now runs the full account resolver (v2), the control
plane pushes account-JWT updates over `$SYS.REQ.CLAIMS.UPDATE`, scoped
signing keys materialize on apply with seeds in Vault KV at
`shared/nats-signers/<stackId>-<name>`, the `nats-signer-seed` injector
branch is wired through the reconciler and pool spawner, and stack destroy
revokes signers end-to-end (re-issue + push + Vault KV wipe). Real-NATS
external-integration tests under `server/src/__tests__/*.external.test.ts`
cover the cryptographic guarantees with a `testcontainers`-managed
`nats:2.12.8-alpine` server.

The items below remain — explicitly out of scope, blocked on a discrete
prerequisite, or surfaced as code-level TODOs during implementation. Each
is sized so it can be picked up independently.

---

## Phase 6 — Slackbot migration (external repo)

**Goal.** Validate the design end-to-end by porting the
`slackbot-agent-sdk` repo's hand-rolled NATS plumbing onto the new
`roles` + `signers` surface. Litmus test for whether the DSL covers a real
third-party app's needs without escape hatches.

**Tasks** (in `slackbot-agent-sdk`, not this repo):
- Replace bespoke NKey/JWT minting in `manager/src/nats-jwt-minter.ts` with reads of `NATS_SIGNER_SEED` env var.
- Update template to declare `roles: [gateway, manager]` and `signers: [worker-minter]` per the design's §2.3 example.
- Decide between default `app.<stack-id>.*` prefix or admin-allowlisted `navi` retention.
- Validate the ~686-line installer shrinks meaningfully (deletes NATS account material handling).

**Verification:** existing slackbot integration tests pass; `_INBOX.>`
request/reply round-trips work without explicit declaration.

**Blocker:** ~~Phase 4 (signers) must ship first~~ — Phase 4 has shipped.
The slackbot can now be ported.

---

## Operational hardening — discovered during implementation

These came up during code review of Phases 1–5. None are blocking, all are
worth doing before the first non-trivial third-party app onboards.

### ~~Cycle detection in cross-stack imports~~ — shipped

Shipped: `resolveImport` now BFS-walks the producer's
`lastAppliedNatsSnapshot.imports[]` (environment-scoped) before resolving
the import. If any transitive import references the consumer's stack
name, apply fails with the cycle path in the error message
(`A → B → C → A`). Pre-existing producer-side cycles that don't include
the consumer (e.g. B↔C while A is the new consumer) are tolerated — the
visited set bounds the search so the BFS terminates, but the error only
fires for cycles introduced by *this* apply. Coverage in
[server/src/__tests__/stack-nats-apply-orchestrator-imports.integration.test.ts](../../../server/src/__tests__/stack-nats-apply-orchestrator-imports.integration.test.ts)
covers direct (A↔B), transitive (A→B→C→A), diamond (no false positive),
and the producer-side-cycle-not-involving-consumer case.

### ~~Global NATS-apply lock (concurrency hardening)~~ — shipped

Shipped: a module-scoped chain promise in
`stack-nats-apply-orchestrator.ts` serializes `runStackNatsApplyPhase`
calls on a single Node process. Producer + consumer applies can no longer
race on `lastAppliedNatsSnapshot` mid-rotation. Errors from one apply are
isolated from the chain so a single failure doesn't poison subsequent
applies. Coverage in
[server/src/__tests__/stack-nats-apply-lock.integration.test.ts](../../../server/src/__tests__/stack-nats-apply-lock.integration.test.ts):
two concurrent applies stay at max-in-flight = 1, a forced failure on
one apply leaves the next apply unaffected, and the chain drains cleanly
after all in-flight work finishes.

Trade-off (deviation from the design's "scope tight" note): the lock is
held across the slow `applyConfig` / `applyJetStreamResources` NATS
network calls. Splitting the lock into "DB-only-locked, NATS-unlocked,
DB-write-locked" phases would refactor the orchestrator's monolithic
`try` block — meaningful churn for a perf concern that doesn't matter at
single-host single-process scale (concurrent applies are already rare).
Documented as a follow-up if contention surfaces.

### Forced revocation path for in-flight JWTs

**Open question from §5 of the design.** Re-applying with a changed
`subjectScope` rotates the signing key (old removed from account JWT, new
one added), but in-flight user JWTs minted by the old key remain valid
until their TTL expires — NATS validation is stateless.

**Approach (if a real compliance ask appears).** Track per-signer "epoch"
in the account JWT's claim metadata; bump the epoch on rotation. The
signer's connect-time check rejects JWTs from earlier epochs. Adds
complexity (custom claim parsing on every connection) and trades latency
for correctness — only worth it if compliance demands it.

---

## Ergonomics — nice-to-haves

### CLI helper for the prefix allowlist

The Phase 2 admin API works (POST/PUT/DELETE on
`/api/nats/prefix-allowlist`), but a `mini-infra nats allowlist add ...`
CLI helper would make the usual workflow (allowlist a non-default prefix
for a specific template) one command instead of two API calls. Punted in
favor of "ship the API, write the CLI when an admin asks."

### Per-user credential observability UI

The design's §2.1 explicitly opts out: mini-infra is intentionally blind
once a signer's seed is delegated. NATS's own connection logs cover who
connected with what JWT; the manager service is responsible for its own
audit log if it needs one. Worth revisiting if a real compliance ask
appears.

### ~~JetStream-for-apps (`roles[].streams`)~~ — shipped

Shipped: app-author roles can now declare `streams[]` and `consumers[]`
nested on the role. Stream subjects + consumer `filterSubject` are written
relative to the stack's `subjectPrefix` and the orchestrator prepends at
apply time. The role's credentials gain the matching JetStream API grants
(`$JS.API.STREAM.INFO.<stream>`, `$JS.API.CONSUMER.{INFO,CREATE,MSG.NEXT}.<stream>.<consumer>`,
`$JS.ACK.<stream>.<consumer>.>`) so a service bound to the role can
publish, bind the durable consumer, pull, and ACK without any extra
plumbing. `NatsStream` rows now carry a `stackId` so cascade-delete +
`pruneOrphanRoleStreams` clean up renames and removals. The mixing rule
extends to streams/consumers — top-level `nats.streams[]` and
`nats.consumers[]` cannot coexist with `nats.roles[]` in the same
template; declare them via `nats.roles[].streams` instead. Real-NATS
external coverage in
[server/src/__tests__/nats-role-streams.external.test.ts](../../../server/src/__tests__/nats-role-streams.external.test.ts).

Known follow-up: removing a role-stream from a template deletes the
`NatsStream` DB row but does not delete the underlying JetStream stream
in NATS itself (the orchestrator only adds/updates via
`applyJetStreamResources`). Stale streams stop receiving traffic because
nothing else publishes to the prefixed subjects, but they leak storage
until manually pruned. A reconciliation step that lists JetStream
streams and deletes any that aren't in the DB is the natural fix; punted
out of this PR to keep the change focused.

No system templates need to migrate to the new surface. The shared
system JetStream streams (`EgressFwEvents`, `BackupHistory`, etc.) and KV
buckets (`egress-fw-health`) are bootstrapped server-side at boot via
`bus.jetstream.ensureStream(...)` in
[server/src/services/nats/nats-system-bootstrap.ts](../../../server/src/services/nats/nats-system-bootstrap.ts) —
not from any template. Their lifecycle is "server up", not "stack
applied", which is the right shape for shared infra streams that
multiple stack instances and the server itself consume from. The two
NATS-using system templates that exist (`egress-fw-agent`,
`egress-gateway`) already declare `roles[]` with allowlisted prefixes
(`mini-infra.egress.fw` / `.gw`) and don't declare any streams in the
template. `roles[].streams` is purely additive for future app
templates that want their own per-stack JetStream.

### ~~Drift detection in `lastAppliedNatsSnapshot`~~ — shipped

Shipped: the snapshot now also stores `subjectPrefixRaw` + `exportsRaw`
alongside the existing resolved fields, so `detectNatsDrift` does pure
raw-to-raw comparisons (no template re-rendering at every list call) of
`natsRoles`, `natsSigners`, `natsExports`, `natsImports`, and
`natsSubjectPrefix`. The detector returns
`NatsDriftInfo { drifted, reasons[] }`, surfaced as `StackInfo.natsDrift`
on the stack list + get routes. The stacks-list UI renders a small
"NATS out of sync" badge alongside the existing status badge, with a
tooltip listing which fields drifted. Independent from `stack.status`
because container-level sync and NATS-section sync are orthogonal — a
stack can be `synced` yet still report drift if the template was edited
and not yet re-applied. Pre-bump snapshots that don't carry the raw
fields surface as `baseline-incomplete` so a single re-apply refreshes
the baseline cleanly. Coverage in
[server/src/__tests__/nats-drift-detector.integration.test.ts](../../../server/src/__tests__/nats-drift-detector.integration.test.ts).

Known limitation: drift driven purely by stack-parameter renaming or
admin-allowlist edits isn't detected (raw-to-raw doesn't catch
substitution drift). Re-rendering the template at every list call is the
straightforward fix; punted until anyone observes a real false-negative.

---

## How to pick something up

1. **Read** [docs/planning/shipped/nats-app-roles-plan.md](../shipped/nats-app-roles-plan.md) §2 for the design rationale.
2. **Find the relevant section above** for the entry point file and rough approach.
3. **The shipped phases** ([server/src/services/stacks/stack-nats-apply-orchestrator.ts](../../../server/src/services/stacks/stack-nats-apply-orchestrator.ts), [server/src/services/nats/nats-prefix-allowlist-service.ts](../../../server/src/services/nats/nats-prefix-allowlist-service.ts), the schema/validator additions) are the closest patterns to follow.
4. **Tests** — every phase added integration tests under `server/src/__tests__/`. Match that style. Real-NATS integration tests for Phase 4 are a hard requirement (the cryptographic guarantees can't be verified against mocks).
