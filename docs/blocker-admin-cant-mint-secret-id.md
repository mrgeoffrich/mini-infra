# Blocker: `mini-infra-admin` AppRole token can't mint secret-ids for tenant AppRoles

## Resolution (post-mortem)

Root cause was investigation path #4: the in-memory admin token does not
survive a server restart. The operator passphrase wraps the AppRole creds at
rest and locks itself in memory at boot, so `authenticateAsAdmin()` is gated
on a human visiting `/vault` and re-entering the passphrase. With no admin
token, every authenticated Vault call (including `auth/approle/role/<x>/secret-id`)
goes out without a valid token and Vault correctly returns `permission denied`.

Fixed in dev by auto-unlocking the operator passphrase on every
`worktree_start.sh` invocation — the seeder bootstraps the managed Vault
with a fixed dev passphrase and the worktree-start script re-runs the unlock
step on already-seeded paths after a restart. See
[deployment/development/lib/seeder.ts](../deployment/development/lib/seeder.ts)
(`ensureVaultUnlocked`) and the audit/log lines below for the exact
"unreachable" / "permission denied" mapping that should be tightened in
`vault-credential-injector.ts` separately.

The investigation notes below are kept as a record of how the bug presented
end-to-end (worker crash-loop → missing secret-id → permission denied → admin
token never acquired) so future Vault auth issues can be diagnosed faster.

## TL;DR

After Vault is bootstrapped and mini-infra hands its HTTP client off from the
root token to the `mini-infra-admin` AppRole token, calls that mint a wrapped
secret-id for any tenant AppRole (e.g. `navi-slackbot`) return
`permission denied` from Vault. This breaks **every** stack apply / pool spawn
that uses `dynamicEnv: { kind: vault-wrapped-secret-id }`, because the
`VaultCredentialInjector` quietly degrades to "role_id only" mode and the
spawned container has no way to AppRole-login at runtime — it dies on the
first secret read.

The exact failing request:

```
Vault POST /v1/auth/approle/role/navi-slackbot/secret-id failed: permission denied
```

The same call **succeeded** during the initial install at 22:49 (the
worker-channel container holds a valid wrapped secret-id from that window).
After that point — and certainly after the mini-infra container restart
during today's `worktree_start.sh` rebuild — every subsequent attempt fails.

## Symptom in user-facing terms

- Slackbot deploys cleanly the first time (worker-channel comes up healthy).
- DMs trigger a per-DM pool worker spawn. The spawn **half-succeeds**:
  - Container is created and joins the right networks.
  - `VAULT_ADDR` and `VAULT_ROLE_ID` are injected.
  - `VAULT_WRAPPED_SECRET_ID` is **missing**.
- Worker container crash-loops: `Error: Missing required env var: ANTHROPIC_API_KEY`
  (it can't AppRole-login to Vault, so the Vault fetch in `worker/src/config.ts`
  silently fails and `required('ANTHROPIC_API_KEY')` throws).
- Manager times out at 30s waiting for the worker's NATS ready signal.
- A fresh `POST /api/stacks/<id>/apply` for the same stack hits the **same**
  permission denied — proving this is not pool-spawner-specific.

## Evidence

### From the mini-infra app log (`/app/server/logs/app.1.log`)

Pool spawn at 23:17:

```json
{"level":"warn","time":"2026-04-25T23:17:54.892Z","component":"platform","subcomponent":"vault-credential-injector","err":"Vault POST /v1/auth/approle/role/navi-slackbot/secret-id failed: permission denied","approle":"navi-slackbot","msg":"Vault unreachable while resolving dynamic env"}
```

Re-apply of the existing slackbot stack at 23:22 (same problem, three
services trying in parallel):

```json
{"level":"warn","time":"2026-04-25T23:22:13.602Z","component":"platform","subcomponent":"vault-credential-injector","err":"Vault POST /v1/auth/approle/role/navi-slackbot/secret-id failed: permission denied","approle":"navi-slackbot","msg":"Vault unreachable while resolving dynamic env"}
{"level":"info","time":"2026-04-25T23:22:13.602Z","component":"platform","subcomponent":"vault-credential-injector","approleId":"cmoewture019407kpjht44i6r","msg":"Vault unreachable; proceeding with role_id only (stable binding, cached role_id)"}
```

Note the misleading log message — Vault is **reachable** (the request
returned a response). It just denied the action. The injector treats any
exception in this code path as "vault unreachable" and falls back to
degraded mode.

Code at fault for the misleading message:
[server/src/services/vault/vault-credential-injector.ts:111-119](../server/src/services/vault/vault-credential-injector.ts) —
the `catch` block logs `Vault unreachable` regardless of root cause.

### From the spawned worker container

Env vars actually injected (confirmed via `docker inspect`):

```
NATS_URL=nats://nats:4222
DATA_DIR=/data
VAULT_ADDR=http://mini-infra-vault-vault:8200
VAULT_ROLE_ID=295a60c9-a8e0-c89e-4232-0d631ba4a348
WORKER_ID=w-49b29bfaef64e724
NATS_CREDS=<…>
```

Crash loop:

```
Error: Missing required env var: ANTHROPIC_API_KEY
    at required (file:///app/worker/dist/config.js:6:15)
    at file:///app/worker/dist/config.js:22:22
```

The worker calls `loadSharedSecretsIntoEnv()` first, which depends on a
working AppRole login (which needs `VAULT_WRAPPED_SECRET_ID`). The login
fails, the fetch fails silently, and then `required('ANTHROPIC_API_KEY')`
throws.

### From the openbao server log

`docker logs mini-infra-vault-vault` shows almost nothing relevant —
OpenBao OSS doesn't log permission denials by default. There's a single
line about a previous secret-id lease being revoked, then silence.
**Enabling an audit device on Vault would be the fastest way to confirm
the actual policy attached to the failing request.**

## What's known about the surrounding state

### Policies (per `GET /api/vault/policies`)

`mini-infra-admin` policy is present, marked published, with `lastAppliedAt`
populated. `draftHclBody` matches `publishedHclBody` (no drift in mini-infra's
DB). The HCL body matches the hardcoded constant in
[server/src/services/vault/vault-admin-service.ts:31-49](../server/src/services/vault/vault-admin-service.ts):

```hcl
path "auth/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}
```

Per Vault path-matching rules, `auth/*` should match
`auth/approle/role/navi-slackbot/secret-id`. So either:

- The policy in Vault doesn't actually match the source HCL (publish step
  silently failed, or got rolled back, or was never run), **or**
- The `mini-infra-admin` AppRole token is bound to a *different* policy
  than `mini-infra-admin`, **or**
- The token mini-infra is presenting isn't the admin token at all (e.g.
  fell back to a more limited token after a renewal/re-login).

### AppRoles (per `GET /api/vault/approles`)

`navi-slackbot` AppRole exists, last applied at 22:49:07 (during install).
Looks healthy from mini-infra's DB perspective.

### Timing

| Time | Event |
|---|---|
| 22:20 | Vault stack deployed (`vault v2`) |
| 22:49 | Slackbot stack first applied — **worked**, worker-channel got valid `VAULT_WRAPPED_SECRET_ID` |
| 22:57 | First DM-pool spawn — failed (template substitution bug, since fixed) |
| ~23:15 | mini-infra container rebuilt + restarted via `worktree_start.sh` |
| 23:17 | Second DM-pool spawn — **first observation of `permission denied`** |
| 23:22 | Stack re-apply — **same permission denied** |

The break correlates exactly with the mini-infra restart. That points at
the in-memory admin auth flow rather than persistent Vault state.

## What was ruled out

- **Not a pool-spawner-specific bug.** Confirmed by reproducing the same
  permission denied on a stack re-apply (which uses the same
  `VaultCredentialInjector` code path on stateful services).
- **Not network connectivity to Vault.** The HTTP request reached Vault
  and got a structured `permission denied` response, not a connection
  error.
- **Not an obvious draft/published mismatch.** `mini-infra-admin` policy
  has both bodies set and they look identical via the API.
- **Not the `mini-infra-vault-net` typo** in pool-spawner.ts. That's a
  separate bug (now fixed in source — see "Related fixes" below) — it
  prevented network attachment but not credential injection.

## Investigation paths

In rough order of cost / likely return:

### 1. Confirm what policy the running admin token actually has

Hit `auth/token/lookup-self` from inside mini-infra using its current
admin token. Look at the `policies` field on the response. If it's not
`["mini-infra-admin"]` (plus `default`), the AppRole→policy binding is
the bug.

The cleanest way to do this without bypass-code:

```ts
// Add a temporary diagnostic route in server/src/routes/vault-routes.ts:
//
//   router.get('/api/vault/admin/whoami', async (req, res) => {
//     const client = getVaultServices().admin.getClient();
//     const me = await client.request('GET', '/v1/auth/token/lookup-self');
//     res.json(me);
//   });
//
// Hit it with the admin API key, inspect, then revert.
```

### 2. Confirm what policy is on the AppRole in Vault

```
GET /v1/auth/approle/role/mini-infra-admin
```

Check `token_policies` on the response. Should include `mini-infra-admin`.

### 3. Re-publish the `mini-infra-admin` policy from the UI

Settings → Vault → Policies → mini-infra-admin → Publish.

If the publish silently no-ops (because draft == published) but the
underlying call to Vault re-syncs the policy body, this might unblock
without a code change. Cheap to try.

### 4. Trace the bootstrap → admin handover path

Read [server/src/services/vault/vault-admin-service.ts:200-330](../server/src/services/vault/vault-admin-service.ts)
end to end. The interesting block is the bootstrap flow:

- `initRes.root_token` →
- writes mini-infra-admin policy + AppRole →
- mints a secret_id →
- AppRole-logs-in to get `loginRes.auth.client_token` →
- `client.setToken(adminToken)` → done.

Audit whether step 4 always completes successfully *and* whether the
in-memory admin token survives the restart vs. needing to re-derive from
stored AppRole creds at boot. The "stored AppRole creds" path is in
`authenticateAsAdmin()` (line 383) — does it use the right policy?

Hypothesis worth checking: after bootstrap, the admin AppRole is rebound
or re-policied somewhere, and on subsequent boots `authenticateAsAdmin`
gets a token with reduced policy.

### 5. Enable a Vault audit device

```
POST /v1/sys/audit/file
{ "type": "file", "options": { "file_path": "/openbao/logs/audit.log" } }
```

Then trigger the failing call again. The audit log will show the exact
token accessor, its policies, the request path, and which policy rule
denied it. This is the surest answer to "why is this denied".

## Related fixes shipped during this debug session

While diagnosing this, three independent bugs in `pool-spawner.ts` were
patched. Two are deployed; one is in source but needs a
`worktree_start.sh` cycle to ship:

| # | Bug | Status |
|---|---|---|
| 1 | `service.dockerImage` / `dockerTag` reached Docker as raw `{{params.X}}` template strings | Fixed: `resolveServiceConfigs` is called and resolved values are used. Deployed. |
| 2 | Pool spawn didn't include the synthesised `<project>_default` network → no DNS to `nats` | Fixed: `synthesiseDefaultNetworkIfNeeded` now called consistently with stack-reconciler. Deployed. |
| 3 | Hardcoded vault network name `mini-infra-vault-net` (actual: `mini-infra-vault`) | Fixed: now resolves from `infraResource` table. **Not yet deployed.** |

All three were in [server/src/services/stacks/pool-spawner.ts](../server/src/services/stacks/pool-spawner.ts).
The last one is gated on this Vault permission blocker — no point burning
another rebuild cycle until tenant AppRole secret-ids can actually be
minted.

## Reproduction

1. Worktree: `bold-raman-95d3c9` (Colima profile +
   `unix:///Users/geoff/.colima/bold-raman-95d3c9/docker.sock`).
2. Slackbot stack id: `cmoexllek01bk07kp6bkrjkka`.
3. Trigger:
   ```bash
   curl -s -X POST -H "x-api-key: <admin-key>" \
     "http://localhost:3101/api/stacks/cmoexllek01bk07kp6bkrjkka/apply" -d '{}'
   sleep 3
   docker exec mini-infra-bold-raman-95d3c9-mini-infra-1 \
     tail -20 /app/server/logs/app.1.log | grep vault-credential
   ```
4. Expected: `permission denied` on `auth/approle/role/navi-slackbot/secret-id`,
   then `Vault unreachable; proceeding with role_id only (stable binding,
   cached role_id)`.
