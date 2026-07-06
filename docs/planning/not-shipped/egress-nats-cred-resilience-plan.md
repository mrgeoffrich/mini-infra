# Egress Agent NATS Credential Resilience — Surviving Restarts and Identity Rotation

**Status:** planned, not implemented. Phased rollout — each phase ships as a separate PR.
**Builds on:** the `vault-nats` stack + `NatsControlPlaneService` (see [shipped/internal-nats-messaging-plan.md](../shipped/internal-nats-messaging-plan.md)), the NATS App Roles / credential-profile plumbing, and the `nats.IgnoreAuthErrorAbort()` reconnect-through-auth-errors fix (#486) already in `egress-shared/natsbus/bus.go`.
**Excludes:** hardening of non-egress NATS clients (server bus, system creds) beyond Phase 1's identity guard — see §3.

---

## 1. Background

On every mini-infra restart, Vault auto-unseal automatically triggers NATS `applyConfig()` (`vault-health-watcher.ts`). That function reads the operator and account **seeds** from Vault KV and — in the same code path — treats "seed genuinely absent (first boot)" identically to "seed unexpectedly missing (a transient Vault 404 from a durability blip or post-unseal read race)". A spurious 404 therefore causes a **silent regeneration** of the operator/account identity: Vault, `natsState`, and the live NATS account JWTs are overwritten with a new identity, and every already-running egress agent's baked-in `NATS_CREDS` is instantly orphaned. The agents then loop forever on `authentication error`, because their creds are baked into container env at create-time, the stacks read `synced` (so the reconciler never recreates them), and their health is reported **in-band** over the very NATS link that's broken — making "auth-failing" indistinguishable from "still starting." A single production incident left both egress gateways and the fw-agent dead for ~15 hours this way. This plan makes the two egress agents robust against that trigger and against any future identity rotation or loss, across five defensive layers: never re-key implicitly, keep the identity durable, surface auth failure out-of-band, self-heal automatically, and refresh creds without a container recreate.

*Planning note: Phase 3 is intentionally a single vertical slice (agent `/healthz` + server scrape + status badge) rather than layer-split; its `[design needed]` badge is scoped within the phase.*

## 2. Goals

1. **A restart never rotates identity implicitly.** `applyConfig` only ever generates identity on a genuine first boot; a missing-but-expected seed fails loudly and leaves the running identity untouched.
2. **The identity is durable and recoverable.** Operator/account seeds survive Vault data loss and can be restored without minting a new identity.
3. **Auth failure is visible.** An agent that's running but can't authenticate to NATS is distinguishable from one that's still starting, and operators can see it.
4. **Agents self-heal.** After any identity/cred rotation, egress agents return to healthy without operator action.
5. **Creds refresh without a recreate.** A rotation reaches running agents by refreshing their credential in place, not by rebuilding the container.

## 3. Non-goals

- **Scheduled or proactive key rotation.** This plan makes rotation *safe*, it does not add routine rotation. Adding a rotation schedule is separate work that should build on this resilience, not precede it.
- **Hardening non-egress NATS clients.** The server bus and system creds benefit from Phase 1's identity guard, but the client-side self-heal (Phases 3–6) is scoped to the two egress agents — generalising it to every NATS client is out of scope until the egress pattern is proven.
- **Cross-host / HA NATS.** Single NATS instance on the managed host, unchanged. No leaf nodes or clustering.
- **Replacing the in-band KV heartbeat.** The `egress-fw-health` KV heartbeat stays as the functional-health signal; Phase 3 *adds* an out-of-band connection-state signal alongside it rather than replacing it.

## 4. Shared concepts

Three contracts are referenced by two or more phases and are fixed here so the phases don't each re-invent them.

### 4.1 NATS identity and the "re-key hazard"

The NATS identity is the **operator seed** (Vault KV `shared/nats-operator`) plus the **per-account seeds** (each account's `seedKvPath`). The authoritative record of *which* identity is current lives in the DB: `natsState.operatorPublic` / `natsState.systemAccountPublic` and `natsAccount.publicKey`. Two states must be told apart:

- **First boot** — the DB holds no recorded public key. Generating a fresh identity is correct.
- **Re-key hazard** — the DB records a public key, but Vault returns no seed for it. This is data loss or a read race, **never** a reason to generate. Regenerating here orphans every credential minted against the recorded identity.

`applyConfig` today conflates these; Phase 1 splits them.

### 4.2 Out-of-band connection health

A per-agent connection-state signal — one of `connected` / `reconnecting` / `auth-failed` / `disconnected`, plus last-heartbeat age — reported over a local HTTP `/healthz` on the agent, **independent** of the NATS link. Distinct from the in-band KV heartbeat (which requires a working NATS connection and so cannot report auth failure). Referenced by Phase 3 (produces + surfaces it) and Phase 4 (consumes it as the self-heal trigger).

### 4.3 Credential delivery contract

The `nats-creds` `dynamicEnv` resolver mints a `.creds` blob per the bound `natsRole`. Today it is delivered as the `NATS_CREDS` env var and loaded once via static `nats.UserJWTAndSeed(jwt, seed)` in `egress-shared/natsbus/bus.go` (the single chokepoint both agents share). The new contract delivers the `.creds` to a **file** the agent re-reads on every reconnect via `nats.UserCredentials(<file>)`. Referenced by Phase 5 (establishes file delivery + reload) and Phase 6 (refreshes the file in place on rotation).

**Delivery mechanism — as built (Phase 5).** A **new opt-in `nats-creds-file` `dynamicEnv` kind** carries the file-based delivery; the existing `nats-creds` (env blob) is left **unchanged**, so non-egress consumers (`pg-az-backup`, restore-executor, `_smoke-signer`, user apps) keep working — per §3. Each egress stack declares its **own per-stack named volume** (`<projectName>_nats_creds`, materialised like `vault`'s `openbao_data`), mounted **read-only** at `/etc/nats-creds`; the minted `.creds` is written to `<stackId>.creds` and the env carries only `NATS_CREDS_FILE=/etc/nats-creds/<stackId>.creds` (never the secret). The server writes the file via a **one-shot helper container** (`server/src/services/nats/nats-creds-volume.ts` → `writeNatsCredsFiles`, reusing `ContainerExecutor` binds; base64-decodes the blob) — the mini-infra server's own deployment stays untouched. `bus.go` prefers `NATS_CREDS_FILE` → `nats.UserCredentials(path)` (re-reads on every reconnect) and falls back to the `NATS_CREDS` env blob on version skew; it logs `creds=file|env|none`. Per-stack volumes (over one shared volume) give per-agent isolation and reuse the template's existing volume provisioning + teardown, with no cross-stack external-volume mechanism. A `builtinVersion` bump on both templates drives the recreate that adopts the new mount/env. Rejected alternatives (see §6): an authenticated re-fetch endpoint (needs a bootstrap credential that must itself survive rotation) and `docker exec` writes (fragile across restarts). Phase 6 rewrites the same `<stackId>.creds` file via the same helper to refresh creds live.

## 5. Phased rollout

Phases 1, 2, 3, and 5 are independent and can start in any order. Phase 4 depends on Phase 3's health signal; Phase 6 depends on Phase 5's file-based reload. The set is committed as one body of work — see §7 for the dependency graph.

### Phase 1 — Guarded NATS identity: split bootstrap from apply

**Goal:** `applyConfig` reconciles JWTs and config from existing seeds and never regenerates identity; a missing-but-expected seed fails loudly instead of silently re-keying.

Deliverables:
- A guard in the NATS control plane so operator/account seed **generation** runs only when the DB holds no recorded public key (`natsState.operatorPublic` / `natsAccount.publicKey` unset) — a genuine first boot per §4.1.
- A typed `NatsIdentityMissing` failure raised when the DB records a public key but Vault returns no seed: `applyConfig` aborts, leaves the running NATS accounts/config untouched, and emits a loud alarm (UserEvent + error log).
- A post-unseal seed-presence assertion on the Vault→NATS auto-apply path (`vault-health-watcher`): expected KV paths (`shared/nats-operator` and each account `seedKvPath`) are confirmed present before apply proceeds.
- (optional) A seed↔DB consistency check: a seed whose derived public key ≠ the DB-recorded public key aborts with the same `NatsIdentityMissing` failure.

Reversibility: safe — server-only logic change; behaviour only diverges on the previously-silent regeneration path, so the PR reverts cleanly.

UI changes:
- The events/audit log and the NATS status surface show a "NATS identity seed missing — refusing to re-key" alarm when the guard trips [no design].

Schema changes:
- none

Done when: with `natsState.operatorPublic` set and the operator seed absent from Vault KV, `applyConfig` raises `NatsIdentityMissing` and makes no `generateOperator`/`generateAccount` call.

Verify in prod: across a production restart, `GET /api/nats/status` returns the same `operatorPublic`/`systemAccountPublic` as before the restart, with no re-key alarm raised.

### Phase 2 — Identity seed backup & durability

**Goal:** the operator and account seeds survive Vault data loss and can be restored without minting a new identity.

Deliverables:
- A backup mechanism that exports the NATS identity seeds (operator + accounts) to durable off-Vault storage, on a schedule and on demand.
- A restore path that writes the backed-up seeds back into Vault KV at their canonical paths.
- Durability hardening of the `vault` stack's data volume so KV survives a host/container restart, with the persistence confirmed rather than assumed.

Reversibility: safe — additive backup/restore plus volume configuration; the running apply path is unchanged.

UI changes:
- The NATS/Vault status surface shows the last identity-seed backup time [no design].

Schema changes:
- none

Done when: restoring the seed backup into an emptied Vault and then running `applyConfig` yields the same `operatorPublic` as before the wipe (no regeneration).

Verify in prod: the identity-seed backup artifact appears in the configured backup store after each scheduled run.

### Phase 3 — Out-of-band agent health

**Goal:** an egress agent that's running but can't authenticate to NATS is distinguishable from one that's still starting, and is visible to operators.

Deliverables:
- A local HTTP `/healthz` on each egress agent (implemented once in `egress-shared`) reporting the §4.2 connection state and last-heartbeat age.
- Server-side scraping of each agent's `/healthz` alongside the existing container health check, feeding the fw-agent and gateway status endpoints.
- The fw-agent status (`available`/`health`) distinguishes `auth-failing` from `starting`/`stale`.
- A status badge on the egress-fw-agent settings card and the gateway status showing the `auth-failing` state.

Reversibility: safe — additive health surface, no change to existing behaviour.

UI changes:
- The egress-fw-agent settings card and gateway status show a distinct "NATS auth failing" state instead of a generic "unavailable" [design needed].

Schema changes:
- none

Done when: when an agent's NATS connection is rejected with an auth error, its `/healthz` reports `auth-failed` and the server status endpoint reflects `auth-failing` within one scrape interval.

Verify in prod: during a forced or real auth-failure, operators see the `auth-failing` badge rather than a silent "unavailable," and it clears when the agent recovers.

### Phase 4 — Self-heal supervisor

**Goal:** an egress stack stuck auth-failing recovers automatically without operator action.

Deliverables:
- A server-side supervisor that watches the egress NATS-client stacks and, when one is `containerRunning: true` but `auth-failing` beyond a threshold, force-recreates it (re-minting creds), reusing the `recycleManagedNatsContainer` recreate pattern generalised to the egress stacks.
- Exponential backoff plus a per-stack recreate cap to prevent recreate storms.
- A feature flag to disable auto-remediation.
- Auto-recreate actions recorded in the events/audit log.

Reversibility: feature-flagged — the supervisor is gated; flip the flag off to disable, no rollback PR needed.

UI changes:
- Auto-recreate actions appear in the events log, and a settings toggle enables/disables auto-remediation [no design].

Schema changes:
- none

Done when: a stack forced into a persistent auth-failing state is force-recreated once per backoff window, returns to healthy, and stops being recreated after the cap.

Verify in prod: an auth-failing egress stack self-recovers with no human action (an auto-recreate event fires and health returns to green), and the recreate-attempt counter stays within the cap.

### Phase 5 — File-based cred delivery + reload-on-reconnect

**Goal:** egress agents authenticate from a creds file they re-read on reconnect, replacing the static baked-in env credential.

Deliverables:
- A shared named docker volume for creds (per §4.3), and the `nats-creds` `dynamicEnv` resolver writes the minted `.creds` into it as a per-stack file (`<stackId>.creds`) instead of setting the `NATS_CREDS` env var.
- The server-side write path into that volume — direct mount into the server container vs a one-shot helper container (reusing `ContainerExecutor`), decided at implementation per §6.
- `egress-shared/natsbus/bus.go` switches from static `nats.UserJWTAndSeed(jwt, seed)` to `nats.UserCredentials(<file>)`, so nats.go re-reads the file on each (re)connect.
- Both egress templates (`server/templates/egress-*/template.json`) mount the shared creds volume read-only instead of declaring the `NATS_CREDS` env.

Reversibility: forward-only — the cred-delivery contract changes; running containers must be recreated to adopt it and a revert is a forward-fix.

UI changes:
- none

Schema changes:
- none

Done when: an agent authenticates using the mounted creds file, and replacing that file's contents with a freshly-minted cred lets it reconnect successfully without a container restart.

Verify in prod: both egress agents connect via file creds (a `creds source=file` log line) after their next recreate, with no regression in NATS connectivity.

### Phase 6 — Live cred refresh on rotation

**Goal:** a NATS identity/cred rotation reaches running egress agents without recreating their containers.

Deliverables:
- A server mechanism that, on cred rotation, rewrites the freshly-minted `.creds` in the shared named volume (per §4.3) for each affected running agent.
- Agents pick up the new creds on their next reconnect via Phase 5's reload-on-reconnect, with no recreate.
- A feature flag gating live-push, falling back to the Phase 4 recreate path when disabled or when a push fails.

Reversibility: feature-flagged — live-push is gated; disabled, recovery falls back to recreate-based self-heal.

UI changes:
- none

Schema changes:
- none

Done when: after a simulated key rotation, running agents reconnect with valid creds and no container is recreated.

Verify in prod: a production cred rotation results in agents recovering with zero container churn (no recreate events) and clean reconnect logs.

## 6. Risks & open questions

- **Cred delivery mechanism — resolved in Phase 5** (§4.3). Both sub-choices landed on the least-blast-radius options: (a) *write path* — a **one-shot helper container** (not a server mount), so the mini-infra server's own deployment is untouched; (b) *volume topology* — **per-stack volumes** (not one shared volume), giving per-agent isolation and reusing the template's existing volume provisioning/teardown. Additionally, rather than repurpose the shared `nats-creds` env-blob kind (which `pg-az-backup`, restore, and user apps depend on — changing it would breach §3), Phase 5 added a **new opt-in `nats-creds-file` kind** used only by the egress templates. Residual note: file naming is keyed on `stackId` (`<stackId>.creds`), which assumes one `nats-creds-file` service per stack — true for the egress agents; a future multi-service-per-stack consumer would need per-service naming.
- **Root-cause of the original 404 — partially identified.** Phase 2 found a concrete silent-drop path: stack destroy removed the vault stack's named `openbao_data` volume unprotected (now guarded via `PROTECTED_DATA_VOLUMES`). Whether the production incident was that path, a Vault re-init, or a post-unseal read race is still not confirmed from logs; Phase 1's guard makes the system robust regardless.
- **Self-heal (Phase 4) and live-refresh (Phase 6) overlap as recovery paths.** This is intentional defense-in-depth — Phase 4 is the recreate-based backstop, Phase 6 the graceful in-place path. Keeping both means a live-push failure still recovers via recreate.
- **Supervisor tuning is deferred to implementation.** Threshold, backoff curve, and recreate cap values for Phase 4 are set at implementation time, not fixed here.

## 7. Phase tracking

Manual checklist — check a box when that phase's PR merges. Bracketed `[blocks-by: …]` edges encode the dependency graph; bracket-free phases have no blockers and can start any time.

- [ ] Phase 1: Guarded NATS identity — split bootstrap from apply
- [ ] Phase 2: Identity seed backup & durability
- [ ] Phase 3: Out-of-band agent health
- [ ] Phase 4: Self-heal supervisor  [blocks-by: 3]
- [ ] Phase 5: File-based cred delivery + reload-on-reconnect
- [ ] Phase 6: Live cred refresh on rotation  [blocks-by: 5]
