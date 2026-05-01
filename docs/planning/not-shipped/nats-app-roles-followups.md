# NATS App Roles & Subject Scoping — Deferred Follow-Ups

**Status:** Tracking doc for work intentionally not in the initial PR.
**Companion to:** [`docs/planning/shipped/nats-app-roles-plan.md`](../shipped/nats-app-roles-plan.md)

The first PR landed Phases 1, 2, 3, and 5 of the design — the type surface,
validation, prefix allowlist, role materialization, and cross-stack
imports/exports. The items below were either explicitly out of scope, blocked
on a discrete prerequisite, or surfaced as code-level TODOs during
implementation. Each is sized so it can be picked up independently.

---

## Phase 0 — Live account-JWT propagation (PREREQUISITE for Phase 4)

**Why it's blocking.** The current `vault-nats` stack runs NATS with
`resolver: MEMORY` and a static `resolver_preload` block written into
`nats.conf`. Account JWTs in this mode load once at process start and **do
not hot-reload**. Scoped signing keys (the cryptographic primitive that
makes `signers` safe) live inside the account JWT, so adding/rotating/
revoking a signer means re-issuing the account JWT and getting the live
`nats-server` to load the new one. Today the only options are to restart
the server (disruptive) or `SIGHUP` (still a reload event).

**Recommended path.** Switch `vault-nats` to the full account resolver
(`resolver: { type: full, dir: ... }`) and use the NATS account-server
protocol (`$SYS.REQ.CLAIMS.UPDATE`) to push updated account JWTs over the
wire. No reload, no downtime.

**Touch points** (verified during planning):
- [server/src/services/nats/nats-config-renderer.ts](../../../server/src/services/nats/nats-config-renderer.ts) — make resolver mode a parameter; render `dir` for full mode.
- [server/src/services/nats/nats-control-plane-service.ts](../../../server/src/services/nats/nats-control-plane-service.ts) — add a system-account-authenticated connection (`mintSystemUserCreds()` + `withSystemNats()` helper) and `updateAccountClaim(publicKey, jwt)` method. **Zero existing system-account plumbing today** — must build from scratch.
- [server/src/services/nats/nats-key-manager.ts](../../../server/src/services/nats/nats-key-manager.ts) — add `mintSystemUserCreds()` (sys account, broad `$SYS.>` permissions).
- [server/templates/vault-nats/template.json](../../../server/templates/vault-nats/template.json) — bump version; mint system-user creds at apply; write account JWTs to `/data/accounts/` on the existing `nats_data` volume.
- Apply orchestrator: after `reissueAccountJwt()`, call `updateAccountClaim()` instead of relying on config rewrite.

**Verification (must run against a real NATS server):**
- Account JWT changes propagate within <2s of `updateAccountClaim()`.
- Revoking a scoped signing key (re-issuing the account JWT without it) invalidates user JWTs signed by that key on next connect.
- Backwards-compat: existing system stacks that don't declare new fields still apply cleanly under the full resolver.

**Estimated effort:** 2–3 engineer-days. The largest unknown in the plan.

**Pause point.** End-of-phase review before starting Phase 4. If
propagation latency turns out unacceptable or system-user plumbing is
brittle, fall back to `SIGHUP` reload (option 2 in design §1.3) as the
cheap path.

---

## Phase 4 — Signers materialization (depends on Phase 0)

**Why deferred.** The Phase 1 type surface for `nats.signers[]` is shipped
and validated, but the apply-time materialization is not. Without Phase 0,
adding a scoped signing key to the shared account JWT can't be
hot-reloaded into the live server, so a signer would be cryptographically
inert until the next NATS restart.

**What's still TBD when picked up:**
- Extend `NatsKeyManager` with `generateScopedSigningKey()` distinct from `mintUserCreds`. Use `nats-jwt`'s `newScopedSigner(signingKey, role, { pub: { allow: [<scoped>] }, sub: { allow: [<scoped>, '_INBOX.>'] } })`.
- For each signer at apply: compute `<prefix>.<subjectScope>.>`, generate ED25519 keypair, add to `Account.signing_keys`, re-issue account JWT, propagate via Phase 0 mechanism, persist seed in Vault KV at `shared/nats-signers/<stackId>-<signerName>`, persist `NatsSigningKey` row (model already shipped in Phase 1).
- New `nats-signer-seed` branch in `NatsCredentialInjector.resolve()` that reads from Vault KV at the canonical path. The `maxTtlSeconds` cap is enforced by NATS itself via the scope template — no client-side policing.
- Auto-inject `NATS_SIGNER_SEED` dynamicEnv when a service declares `natsSigner`.
- Destroy path: delete `NatsSigningKey` row, delete seed from Vault KV, **and** re-issue account JWT with the signing key removed + propagate. Without the re-issue, a revoked signing key remains valid until the next account-JWT refresh.

**Verification (real NATS server, not mocks):**
- JWT minted by a scoped signer with permissions broader than its scope is silently trimmed by the server.
- JWT with claimed TTL > `maxTtlSeconds` is rejected.
- Seed redacted in logs (`getLogger("nats", ...)` filters).
- Destroying a stack with a signer revokes the key end-to-end.

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

**Blocker:** Phase 4 (signers) must ship first — the slackbot's `manager`
service is the canonical signer use case.

---

## Operational hardening — discovered during implementation

These came up during code review of Phases 1–5. None are blocking, all are
worth doing before the first non-trivial third-party app onboards.

### Orphan profile cleanup on role rename

**Problem.** A role is keyed by `<stackId>-<roleName>` in
`NatsCredentialProfile`. Renaming `gateway` → `frontdoor` in a template
leaves the old profile row in the DB; apply creates a new row but never
deletes the old one. Same applies to deleting a role outright.

**Where flagged:**
- [server/src/services/stacks/stack-nats-apply-orchestrator.ts](../../../server/src/services/stacks/stack-nats-apply-orchestrator.ts) — TODO comment in `materializeRole`.

**Approach.** Add a per-stack "desired roles" diff at the end of the apply
phase: enumerate existing `NatsCredentialProfile` rows owned by this stack
(via the `<stackId>-` prefix or, better, a `stackId` FK on the profile
table — small migration), compare against the rendered `roles[]` set,
delete any orphans. Same pattern would later cover signer rotation when
Phase 4 ships.

### Cycle detection in cross-stack imports

**Problem.** Stack A imports from B; B imports from A. The Phase 5
orchestrator has no cycle check. Both apply in some order: each generation
sees the other's *prior* snapshot, so they ping-pong eventually-
consistent rather than failing fast. This was acknowledged in the design
(§6) but no implementation yet.

**Where flagged:**
- [server/src/services/stacks/stack-nats-apply-orchestrator.ts](../../../server/src/services/stacks/stack-nats-apply-orchestrator.ts) — TODO comment in `resolveImport`.

**Approach.** Before resolving an import, walk the producer's `imports[]`
recursively (DFS through `lastAppliedNatsSnapshot.imports`) looking for the
consumer's stack name. Refuse to apply if found, surface the cycle path.
Cheap because cross-stack import depth is small in practice.

### Global NATS-apply lock (concurrency hardening)

**Problem.** Phase 5's `resolveImport` is a plain Prisma read of the
producer's `lastAppliedNatsSnapshot`. If producer + consumer apply
simultaneously, the consumer can race on a stale snapshot. The design
recommended a global NATS-apply lock; v1 takes the eventual-consistency
tradeoff (consumer's next apply picks up the new snapshot).

**Approach.** A single advisory lock keyed by `"nats-apply"` taken at
the top of `runStackNatsApplyPhase`. Cheap, single-host system, contention
is rare. Implementation note: keep the lock scope tight (don't hold across
the legacy `applyConfig`/`applyJetStreamResources` since those touch a
live NATS connection that may be slow).

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

### JetStream-for-apps (`roles[].streams`)

V1 keeps `streams` as a legacy-only template field with absolute
subjects, system-template-only path. Apps that want JetStream are blocked
by the mixing rule. Slackbot doesn't need it, but the next NATS-using app
might. Adding `roles[].streams` (relative subjects, auto-prefixed) is
straightforward once a use case appears — the materialization path
already exists, just needs prefix-prepending in
`stack-nats-apply-orchestrator.ts` legacy-streams branch.

### Drift detection in `lastAppliedNatsSnapshot`

The snapshot writes accounts/credentials/streams/consumers/roles/exports/
imports/resolved-prefix on every apply, but no consumer compares against
it for drift. Once the orchestrator's snapshot is rich enough (it is now,
post-Phase 5), the next planned change is a drift detector that compares
the rendered roles + resolved prefix against the snapshot and surfaces
"out of sync" in the stack list.

---

## How to pick something up

1. **Read** [docs/planning/shipped/nats-app-roles-plan.md](../shipped/nats-app-roles-plan.md) §2 for the design rationale.
2. **Find the relevant section above** for the entry point file and rough approach.
3. **The shipped phases** ([server/src/services/stacks/stack-nats-apply-orchestrator.ts](../../../server/src/services/stacks/stack-nats-apply-orchestrator.ts), [server/src/services/nats/nats-prefix-allowlist-service.ts](../../../server/src/services/nats/nats-prefix-allowlist-service.ts), the schema/validator additions) are the closest patterns to follow.
4. **Tests** — every phase added integration tests under `server/src/__tests__/`. Match that style. Real-NATS integration tests for Phase 4 are a hard requirement (the cryptographic guarantees can't be verified against mocks).
