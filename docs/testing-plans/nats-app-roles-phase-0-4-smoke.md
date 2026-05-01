# NATS App Roles — Phase 0+4 Smoke Test Plan

**Companion to:** [`docs/planning/shipped/nats-app-roles-plan.md`](../planning/shipped/nats-app-roles-plan.md)
and the Phase 0+4 follow-up PR.

The automated tests in `server/src/__tests__/*.external.test.ts` cover the
cryptographic guarantees in isolation against `testcontainers`. They do
NOT cover:

- the actual `vault-nats` template entrypoint script
- the real orchestrator + reconciler + pool-spawner wiring
- multi-account real-Docker scenarios
- stack destroy with a real container recycle
- the first-ever-apply bootstrap path

These dev-environment smoke tests target exactly those gaps. Run them in
order — earlier tiers are blockers for later tiers to be meaningful.

## Setup

```bash
pnpm worktree-env start --description "phase 0+4 smoke"
URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
API_KEY=$(xmllint --xpath 'string(//environment/credentials/apiKey)' environment-details.xml)
```

Apply the `vault-nats` stack from the UI before running Tier 1.

---

## Tier 1 — vault-nats v2 boots cleanly (blocker)

**Validates:** the new entrypoint script (`set -e; mkdir -p /data/accounts; ...`)
runs in real Docker. Without this, NATS doesn't start and every other
tier is moot.

```bash
docker exec mini-infra-vault-nats-nats cat /etc/nats/nats.conf | grep -E 'type: full|allow_delete: false'
docker exec mini-infra-vault-nats-nats ls /data/accounts/
docker logs mini-infra-vault-nats-nats 2>&1 | grep -iE "account resolver|jwt"
```

**Pass:**
- `nats.conf` shows `type: full` and `allow_delete: false`.
- `/data/accounts/` contains at least one `<pubkey>.jwt` file.
- Logs say "Managing all jwt in exclusive directory" or equivalent.

---

## Tier 2 — system creds round-trip via $SYS

**Validates:** the live-propagation path. If system creds are wrong or the
system-account isn't configured, every account update silently goes
through cold-start only — Phase 0 is effectively disabled.

```bash
# Pull the system creds from Vault and connect as $SYS
docker exec -it mini-infra-vault-nats-vault \
  bao kv get -mount=secret -field=creds shared/nats-system-creds > /tmp/sys.creds
# From host using nats CLI:
nats --creds /tmp/sys.creds --server nats://localhost:<host-port> account info
```

**Pass:** `account info` returns the SYS account details; no auth violation.

---

## Tier 3 — claim propagates within seconds

**Validates:** the load-bearing claim of Phase 0. If propagation latency is
multi-minute or push silently fails, signers are useless.

```bash
# Trigger a re-apply of the NATS config (no template change, just churn).
curl -X POST -H "Authorization: Bearer $API_KEY" "$URL/api/nats/apply"

# In a separate shell, watch logs:
docker logs -f mini-infra-vault-nats-nats 2>&1 | grep -iE "claim updated|account.*updated"
```

**Pass:** within ~2 seconds of the POST returning, NATS logs an
"Account [...] updated" line.

---

## Tier 4 — signer end-to-end with a fixture stack

**Validates:** real orchestrator + real template loader + real reconciler +
real pool-spawner injector wiring. The testcontainers tests skip all of
that. This is the highest-value smoke check — it catches bugs in the
glue between subsystems that unit tests can't.

Add a tiny fixture template under `server/templates/_smoke-signer/template.json`
that declares one role + one signer. Apply via the UI.

```bash
STACK_ID=$(curl -sH "Authorization: Bearer $API_KEY" "$URL/api/stacks" \
  | jq -r '.[] | select(.templateId=="_smoke-signer") | .id')

# DB row exists with the expected scoped subject
docker exec -it mini-infra-server sqlite3 /app/data/dev.db \
  "SELECT name, scopedSubject, publicKey FROM nats_signing_keys WHERE stackId='$STACK_ID';"

# Vault KV seed exists
docker exec -it mini-infra-vault-nats-vault \
  bao kv get -mount=secret shared/nats-signers/$STACK_ID-<signerName>

# Container env var populated
docker exec <fixture-service-container> env | grep NATS_SIGNER_SEED
```

**Pass:** all three present; the publicKey in the DB row matches the public
key derived from the seed in Vault KV (cross-check via `nkey` CLI).

---

## Tier 5 — scope trim works against the real stack

**Validates:** the cryptographic guarantee end-to-end on the production
code paths (mint-from-seed, user JWT, publish, server-side trim) — not
the testcontainers shortcut.

Inside the fixture container:

```js
// /tmp/mint.mjs
import { createUser, fromSeed } from "nkeys.js";
import { encodeUser, fmtCreds } from "nats-jwt";
import { connect, credsAuthenticator } from "nats";

const signerKp = fromSeed(new TextEncoder().encode(process.env.NATS_SIGNER_SEED));
const u = createUser();
const jwt = await encodeUser("smoke", u, signerKp,
  { issuer_account: process.env.NATS_ACCOUNT_PUBLIC },
  { exp: Math.floor(Date.now() / 1000) + 60, scopedUser: true });
const creds = new TextDecoder().decode(fmtCreds(jwt, u));
const nc = await connect({
  servers: process.env.NATS_URL,
  authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
});
nc.publish(`app.${process.env.STACK_ID}.<scope>.in`, new TextEncoder().encode("ok"));
nc.publish("escape.evil", new TextEncoder().encode("nope"));
await nc.flush();
await nc.drain();
```

Subscribe a privileged listener (account-admin creds, `sub: [">"]`) on the
host:

```bash
nats --creds /tmp/admin.creds --server nats://localhost:<port> sub ">"
```

**Pass:** the listener receives the in-scope publish but NOT
`escape.evil`. (If trim is broken, the listener sees both.)

---

## Tier 6 — orphan profile cleanup

**Validates:** the FK migration backfill + the apply diff-prune work on
real data, not just the integration test fixtures.

```bash
# Edit the fixture template: rename role "gateway" → "frontdoor". Re-apply.
docker exec -it mini-infra-server sqlite3 /app/data/dev.db \
  "SELECT name FROM nats_credential_profiles WHERE stackId='$STACK_ID';"
```

**Pass:** only `<stackid>-frontdoor` exists; `<stackid>-gateway` is gone.

---

## Tier 7 — destroy revokes end-to-end

**Validates:** the security-sensitive destroy path. Confirms (a) DB rows
removed, (b) Vault KV cleared, (c) live NATS no longer trusts the
revoked signing key. Without (c), a leaked seed is exploitable until
manual restart — that's the bug class the review caught.

```bash
# Capture the seed BEFORE destroy.
SEED=$(docker exec -it mini-infra-vault-nats-vault \
  bao kv get -mount=secret -field=seed shared/nats-signers/$STACK_ID-<name>)
ACCOUNT_PUB=$(curl -sH "Authorization: Bearer $API_KEY" "$URL/api/nats/accounts" \
  | jq -r '.[0].publicKey')

# Destroy the stack via UI. Then:
docker exec -it mini-infra-server sqlite3 /app/data/dev.db \
  "SELECT count(*) FROM nats_signing_keys WHERE stackId='$STACK_ID';"   # → 0
docker exec -it mini-infra-vault-nats-vault \
  bao kv get -mount=secret shared/nats-signers/$STACK_ID-<name>   # → not found

# Mint a fresh JWT with the captured seed — connection should fail.
SEED=$SEED ACCOUNT_PUB=$ACCOUNT_PUB node /tmp/mint-and-connect.mjs
```

**Pass:** DB clean, Vault KV clean, connect fails with "Authorization
Violation".

---

## Tier 8 — recycle fallback (manual fault injection)

**Validates:** the recycle path only fires when propagation fails. To
exercise it deterministically, force a failure.

```bash
# Stop NATS before destroying a stack with signers.
docker stop mini-infra-vault-nats-nats

# Destroy the fixture stack via UI. Watch server logs:
docker logs -f mini-infra-server 2>&1 | grep -iE "recycle|revoke|critical"
```

**Expected log lines:**
- `"NATS account claim re-push during stack destroy failed; will recycle the NATS container to apply revocation"`
- `"Recycling vault-nats NATS container to complete signer revocation"`
- `"Recycled vault-nats NATS container to complete signer revocation"`

**Pass:** logs show the recycle path fired; Tier-7 assertions still hold.

---

## What's deliberately NOT in this plan

- Anything covered by `*.external.test.ts` (basic claim propagation, basic
  trim) — duplicating at the dev-env level adds time without catching new
  bug classes.
- Performance / latency benchmarks — out of scope for smoke.
- Concurrency stress (parallel applies racing destroy) — covered by the
  `applyChain` serialisation; not worth a manual smoke pass.

## Future automation

Tiers 4 + 5 are the highest-value-to-test wiring and the most likely to
silently break under future refactors. Worth scripting as a single
`smoke-test-nats.sh` that runs against a fresh `pnpm worktree-env`
instance, callable from CI.

---

## First execution results (2026-05-01)

All 8 tiers passed. One critical bug surfaced and was fixed during
execution:

| Tier | Result | Notes |
|------|--------|-------|
| 1 | ✅ | NATS logs `Managing all jwt in exclusive directory /data/accounts`; `nats.conf` shows `type: full`, `allow_delete: false`. |
| 2 | ✅ | Apply returned `unpropagated: 0` — system creds connect to `$SYS` and the claim push round-tripped. |
| 3 | ✅ | Apply→propagation latency < 200 ms; no `unpropagated` accounts on subsequent applies. |
| 4 | ✅ | `_smoke-signer` template instantiated; `NatsSigningKey` row, Vault KV at `shared/nats-signers/<stackId>-worker-minter`, and container env all present. Public key in DB matches Vault KV blob. |
| 5 | ✅ | Privileged listener received in-scope publish; out-of-scope publish from scoped user returned `PERMISSIONS_VIOLATION` from the server. |
| 6 | ✅ | Synthetic orphan `<stackid>-old-role` inserted via Prisma; re-apply pruned it leaving only `<stackid>-gateway`. |
| 7 | ✅ (after fix) | Pre-fix: destroy completed but the captured seed *still authenticated* — confirming the bug class the review caught. After moving the revocation hook into the actual destroy path, the seed was rejected with `Authorization Violation`. |
| 8 | ✅ | NATS stopped → destroy issued → server logged `unpropagated: 1` → `Recycling vault-nats NATS container to complete signer revocation` → `Recycled vault-nats NATS container...`. KV seed wiped end-to-end. |

### Bug found + fixed during execution

**Symptom (Tier 7, first attempt):** A signer seed captured before destroy
*continued to authenticate* against NATS after the stack was destroyed.

**Root cause:** The `revokeStackNatsSigningKeys` helper from the prior
commit lived on `StackReconciler.destroyStack`, but the production destroy
flow runs through `stacks-destroy-route.ts` → `runDestroyInBackground` (a
separate "removal state machine" path). `StackReconciler.destroyStack`
is dead code — never called from production routes. So the revocation
hook never fired during a real destroy.

**Fix:** Extracted the helper into a new shared module
[`server/src/services/stacks/stack-nats-revocation.ts`](../../server/src/services/stacks/stack-nats-revocation.ts)
and called it from `stacks-destroy-route.ts` between egress-policy
archival and `prisma.stack.delete`. Verified end-to-end on the dev env:

- Tier 7 retest after fix: capture seed → destroy → fresh JWT signed by
  the seed gets `Authorization Violation` from the server.
- Tier 8 fault injection: stop NATS → destroy → server logs
  `Recycling vault-nats NATS container to complete signer revocation`
  and `Recycled vault-nats NATS container...`. The cold-start path
  picks up the regenerated `accounts-index` and the seed is dead.

### Other observations

- The vault passphrase locks on every server restart. Each rebuild of the
  worktree-env requires unlocking via
  `POST /api/vault/passphrase/unlock` before any Vault-touching API call
  (apply, destroy, KV read). Not a bug — security feature — but worth
  capturing in operator runbooks.
- After `pnpm worktree-env start` rebuild, the mini-infra container loses
  its docker-network membership for `mini-infra-vault` and
  `mini-infra-nats`. Manual `docker network connect` was required.
  Pre-existing worktree-env quirk; out of scope for this PR.

### Fixture template

The [`_smoke-signer`](../../server/templates/_smoke-signer/template.json)
template was added under `server/templates/` to support Tiers 4–8.
Declares one role (`gateway`) and one signer (`worker-minter` scoped to
`agent.worker`), idles in a `sleep 30` loop, exposes `NATS_URL`,
`NATS_CREDS`, and `NATS_SIGNER_SEED` for inspection.

---

## Second execution (2026-05-01, fresh-from-scratch)

After landing the destroy-hook fix, deleted the worktree-env entirely
(`pnpm worktree-env delete --force`, which unregisters the WSL distro
and wipes volumes) and recreated from scratch (`start --seed`).

All 8 tiers pass cleanly. No code-level surprises. Two operator-flow
quirks worth capturing:

### Quirk 1 — Vault passphrase locks on every server start

The Vault admin client only authenticates while the operator passphrase
is unlocked. The seeder unlocks it as part of bootstrap, but the unlock
state is in-process memory: the next request — including the very first
post-seeder API call from outside — sees a re-locked passphrase, and
any Vault-KV-touching call (apply, KV read) fails with
`permission denied`.

Workaround in the smoke flow: call `POST /api/vault/passphrase/unlock`
once after the seeder finishes (or after any server restart). Not a bug,
intended security behaviour. Worth a note in operator runbooks: an
external automation (e.g. a CI smoke-runner) must be prepared to unlock
before any further Vault-touching API call.

### Quirk 2 — Rebuild-in-place loses docker-network membership

Observed on the previous (rebuild) run: after `pnpm worktree-env start`
recreated the mini-infra container in place, it lost membership in
`mini-infra-vault` and `mini-infra-nats` networks and could no longer
reach the running vault-nats stack. Required manual
`docker network connect` to recover.

Did NOT recur on the fresh-from-scratch flow (delete + start --seed) —
the seeder rebuilt all containers and networks in correct order. So
this is specific to the rebuild-in-place path and out of scope for
this PR.

### Final result

Both runs confirm: vault-nats v2 boots correctly, the live propagation
path works end-to-end, signers are wired through the orchestrator into
the running container, scope trim is enforced server-side, orphan
profiles get pruned, destroy revokes signers, and the recycle fallback
kicks in correctly when live propagation fails.
