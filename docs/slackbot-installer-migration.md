# Slackbot Installer Migration to Mini Infra Stack Bundles

This guide walks the slackbot-agent-sdk team through migrating
[`environment/install-mini-infra.ts`](../../slackbot-agent-sdk/environment/install-mini-infra.ts)
from its current 686-line, 8-stage orchestrator to the bundle-shaped
flow now supported by Mini Infra Phase 2.

The target is roughly 100 lines: build images, push images, POST one
extended template, instantiate with input values, apply, poll for done.

## What changed in Mini Infra (Phase 2)

Five PRs landed (#248, #249, #250, #251, #252). Together they extend
the stack template resource to carry everything the slackbot installer
currently orchestrates externally:

| Capability | PR | Effect on the slackbot installer |
|---|---|---|
| `inputs[]` declaration list on templates | #248 | Slackbot's secrets (slack tokens, anthropic key, etc.) become declared input slots, supplied at instantiate time and encrypted at rest. |
| `vault: { policies, appRoles, kv }` sibling on templates | #248 | Slackbot's policies, AppRoles, and KV writes move into the template document. No more separate calls to create them. |
| `vault-kv` dynamicEnv kind | (Phase 1, #247) | Services that just need static secrets at boot can read straight from KV at apply time without needing AppRole client code. |
| Pre-service Vault reconciliation on apply | #249 | Stack apply upserts policies/AppRoles/KV before service reconcile. The 8-stage orchestration becomes a single transaction. |
| `vaultAppRoleRef` on `services[]` | #248 | Each service can bind to its own least-privilege AppRole — no more unioned `navi-slackbot` policy workaround. |
| `{{stack.id}}` substitution at apply | (Phase 1, #247) | `MINI_INFRA_STACK_ID` env var resolves automatically — no follow-up `PUT /api/stacks/:id` to backfill. |
| Atomic apply with rollback on failure | #251 | Partial failure restores the prior version's policies/AppRoles/KV. The system never sits in a half-applied state. |
| DELETE cascade with sharing rules | #252 | `DELETE /api/stacks/:id` tears down derived Vault objects in reverse order, leaving shared resources intact when other instances still own them. |

The slackbot installer's reachability check, build/push, and NATS
bootstrap stages remain external — they're slackbot-specific and not
expressible in a generic bundle. Everything else collapses.

## TL;DR — the new install flow

1. **Build** the four slackbot images locally (unchanged).
2. **Push** to the configured registry (unchanged).
3. **Build NATS bootstrap state** (operator + account JWT, nats.conf rendered) (unchanged — slackbot-specific cryptographic setup).
4. **POST `/api/stack-templates`** — create the template metadata row.
5. **POST `/api/stack-templates/:id/draft`** — submit the full bundle body (services + `vault: {…}` + `inputs: […]`).
6. **POST `/api/stack-templates/:id/publish`** — freeze the draft as a published version.
7. **POST `/api/stack-templates/:id/instantiate`** — create the stack with `inputValues: {…}`. Encrypted on the row.
8. **POST `/api/stacks/:id/apply`** — trigger the apply pipeline. Vault reconcile + service reconcile run in order.
9. **Poll `/api/stacks/:id/status`** until `synced` or `error` (existing behaviour).

Five mini-infra calls (steps 4–8) plus the polling loop. The current
installer makes 25+ calls across the 8 stages.

## The new template shape

The full schema lives at [`server/src/services/stacks/template-file-loader.ts`](../server/src/services/stacks/template-file-loader.ts).
Two siblings are added beside the existing `services`/`networks`/`volumes` blocks:

```jsonc
{
  "name": "slackbot",
  "displayName": "Slackbot",
  "scope": "environment",
  "category": "apps",
  "description": "Self-hosted Slack bot using the Claude Agent SDK.",
  "parameters": [ /* unchanged */ ],
  "networks":   [ /* unchanged */ ],
  "volumes":    [ /* unchanged */ ],
  "services":   [ /* unchanged + new vaultAppRoleRef field */ ],
  "configFiles": [ /* unchanged */ ],

  "inputs": [
    {
      "name": "slackBotToken",
      "description": "Slack bot user OAuth token (xoxb-…)",
      "sensitive": true,         // UI hint only; values are always encrypted at rest
      "required": true,
      "rotateOnUpgrade": false   // if true, must be re-supplied on every template-version bump
    }
    // …
  ],

  "vault": {
    "policies": [
      {
        "name": "slackbot-manager-read",
        "scope": "environment",  // host | environment | stack
        "description": "Allow the slackbot manager to read shared secrets.",
        "body": "path \"secret/data/shared/anthropic\" { capabilities = [\"read\"] }\npath \"secret/data/shared/slack\" { capabilities = [\"read\"] }\n"
      }
      // …
    ],
    "appRoles": [
      {
        "name": "slackbot-manager",
        "scope": "environment",
        "policy": "slackbot-manager-read",   // refers to vault.policies[].name
        "tokenPeriod": "1h",
        "tokenTtl": "1h",
        "tokenMaxTtl": "4h",
        "secretIdNumUses": 0,
        "secretIdTtl": "10m"
      }
      // …
    ],
    "kv": [
      {
        "path": "shared/slack",
        "fields": {
          "bot_token": { "fromInput": "slackBotToken" },   // resolves at apply time
          "app_token": { "fromInput": "slackAppToken" }
        }
      },
      {
        "path": "stacks/{{stack.id}}/local-config",         // {{stack.id}} substitutes at apply
        "fields": {
          "log_level": { "value": "info" }                  // literal, no input
        }
      }
      // …
    ]
  }
}
```

### Field reference — `inputs[]`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `name` | `string` (alphanumeric + `-_`, ≤100) | required | Referenced by `vault.kv.<path>.fields.<f>.fromInput` and (in future) `{{inputs.<name>}}` substitution. |
| `description` | `string` (≤500) | optional | Operator-facing label. |
| `sensitive` | `boolean` | `true` | UI masking hint. **Storage is always encrypted regardless.** |
| `required` | `boolean` | `true` | Apply rejects with 400 `input_required` if missing. |
| `rotateOnUpgrade` | `boolean` | `false` | Must be re-supplied on every template-version bump; otherwise stored values silently roll forward. |

### Field reference — `vault.policies[]`

| Field | Type | Purpose |
|---|---|---|
| `name` | `string` | Concrete name in Vault. May contain `{{stack.id}}` for per-instance scoping (resolved at apply). |
| `scope` | `'host' \| 'environment' \| 'stack'` | Sharing rule. `host`/`environment` = shared across instances of this template; `stack` = always per-instance. Default `environment`. |
| `body` | `string` (HCL) | Policy body. Substitution applies (`{{stack.id}}`, `{{environment.*}}`, `{{params.*}}`). |
| `description` | `string` (≤500) | Optional. |

### Field reference — `vault.appRoles[]`

| Field | Type | Purpose |
|---|---|---|
| `name` | `string` | Concrete name in Vault. May contain `{{stack.id}}`. |
| `scope` | `'host' \| 'environment' \| 'stack'` | Sharing rule. Default `environment`. |
| `policy` | `string` | Refers to a `vault.policies[].name` declared in the same template. |
| `tokenPeriod` | `string?` | Vault duration string (`1h`, `30m`, …). |
| `tokenTtl`, `tokenMaxTtl` | `string?` | Standard AppRole token TTLs. |
| `secretIdNumUses` | `number?` | 0 = unlimited. |
| `secretIdTtl` | `string?` | Vault duration string. |

### Field reference — `vault.kv[]`

| Field | Type | Purpose |
|---|---|---|
| `path` | `string` | Vault KV v2 path. May contain `{{stack.id}}`, `{{environment.*}}`, `{{params.*}}`, `{{inputs.<name>}}` (path only). Re-validated against `validateKvPath` on the resolved concrete path before the write. |
| `fields` | `Record<string, FieldValue>` | Per-field source. Each value is either `{ "fromInput": "<inputName>" }` or `{ "value": "<literal>" }`. |

### Field reference — `services[]` (relevant new field)

| Field | Type | Purpose |
|---|---|---|
| `vaultAppRoleRef` | `string?` | Symbolic reference to a `vault.appRoles[].name` in the same template. Resolved to a concrete `vaultAppRoleId` at apply time and written atomically with apply success. Replaces the current stack-level `vaultAppRoleId` workaround. |

## Worked example: `slackbot.template.json`

This is a sketch matching the slackbot's current four-service shape
(manager / slack-gateway / agent-gateway / worker), with per-service
AppRoles replacing the unioned `navi-slackbot` policy.

```jsonc
{
  "name": "slackbot",
  "displayName": "Slackbot",
  "scope": "environment",
  "category": "apps",
  "description": "Self-hosted Slack bot using the Claude Agent SDK.",
  "builtinVersion": 1,
  "parameters": [
    { "name": "image-tag", "type": "string", "defaultValue": "latest" },
    { "name": "manager-replicas", "type": "number", "defaultValue": 1 }
  ],
  "inputs": [
    { "name": "slackBotToken",   "sensitive": true, "required": true },
    { "name": "slackAppToken",   "sensitive": true, "required": true },
    { "name": "anthropicApiKey", "sensitive": true, "required": true,
      "rotateOnUpgrade": false },
    { "name": "githubToken",     "sensitive": true, "required": false },
    { "name": "natsAccountSeed", "sensitive": true, "required": true }
  ],
  "vault": {
    "policies": [
      {
        "name": "slackbot-manager-read",
        "scope": "environment",
        "body": "path \"secret/data/shared/anthropic\" { capabilities = [\"read\"] }\npath \"secret/data/shared/github\" { capabilities = [\"read\"] }\npath \"secret/data/shared/config\" { capabilities = [\"read\"] }\n"
      },
      {
        "name": "slackbot-slack-gateway-read",
        "scope": "environment",
        "body": "path \"secret/data/shared/slack\" { capabilities = [\"read\"] }\npath \"secret/data/shared/nats-account\" { capabilities = [\"read\"] }\n"
      },
      {
        "name": "slackbot-agent-gateway-read",
        "scope": "environment",
        "body": "path \"secret/data/shared/anthropic\" { capabilities = [\"read\"] }\npath \"secret/data/shared/nats-account\" { capabilities = [\"read\"] }\n"
      },
      {
        "name": "slackbot-worker-read",
        "scope": "environment",
        "body": "path \"secret/data/shared/anthropic\" { capabilities = [\"read\"] }\npath \"secret/data/shared/nats-account\" { capabilities = [\"read\"] }\npath \"secret/data/users/*\" { capabilities = [\"read\", \"create\", \"update\"] }\n"
      }
    ],
    "appRoles": [
      { "name": "slackbot-manager",       "scope": "environment", "policy": "slackbot-manager-read",        "tokenPeriod": "1h" },
      { "name": "slackbot-slack-gateway", "scope": "environment", "policy": "slackbot-slack-gateway-read",  "tokenPeriod": "1h" },
      { "name": "slackbot-agent-gateway", "scope": "environment", "policy": "slackbot-agent-gateway-read",  "tokenPeriod": "1h" },
      { "name": "slackbot-worker",        "scope": "environment", "policy": "slackbot-worker-read",         "tokenPeriod": "1h" }
    ],
    "kv": [
      {
        "path": "shared/slack",
        "fields": {
          "bot_token": { "fromInput": "slackBotToken" },
          "app_token": { "fromInput": "slackAppToken" }
        }
      },
      {
        "path": "shared/anthropic",
        "fields": { "api_key": { "fromInput": "anthropicApiKey" } }
      },
      {
        "path": "shared/github",
        "fields": { "token": { "fromInput": "githubToken" } }
      }
    ]
  },
  "networks": [ /* unchanged from current installer */ ],
  "volumes":  [ /* unchanged */ ],
  "services": [
    {
      "serviceName": "manager",
      "serviceType": "StatelessWeb",
      "dockerImage": "{{params.image-tag-prefix}}slackbot-manager",
      "dockerTag":   "{{params.image-tag}}",
      "vaultAppRoleRef": "slackbot-manager",
      "containerConfig": {
        "env": {
          "MINI_INFRA_STACK_ID":  "{{stack.id}}",
          "MINI_INFRA_HOST_URL":  "http://{{params.host-internal}}:{{params.port-internal}}"
        }
      },
      "dependsOn": [],
      "order": 0,
      "routing": { /* … */ }
    },
    {
      "serviceName": "slack-gateway",
      "serviceType": "Stateful",
      "dockerImage": "{{params.image-tag-prefix}}slackbot-slack-gateway",
      "dockerTag":   "{{params.image-tag}}",
      "vaultAppRoleRef": "slackbot-slack-gateway",
      "containerConfig": { /* … */ },
      "dependsOn": ["manager"],
      "order": 1
    }
    /* agent-gateway, worker similarly */
  ]
}
```

The shape is intentionally close to the current installer's
[`buildStackTemplateBody()`](../../slackbot-agent-sdk/environment/install/stack-template.ts).
The only mechanical changes:

1. Add the `inputs[]` block (declarations only — no values).
2. Add the `vault: { policies, appRoles, kv }` block, lifting from the current
   [`SLACKBOT_POLICIES`](../../slackbot-agent-sdk/environment/install/policies.ts)
   constants.
3. Add `vaultAppRoleRef: "<name>"` to each service that previously inherited
   the stack-level `vaultAppRoleId`.
4. Drop the `mini-infra-stack-id` parameter — `{{stack.id}}` now substitutes directly.

## API call sequence

Caller must hold an API key with both `stack-templates:write` and
`template-vault:write` scopes. The Editor preset has both; an `api-key`
created with the `stack-manager` preset also works.

### 1. Create template metadata

```bash
curl -sS -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "slackbot",
    "displayName": "Slackbot",
    "scope": "environment",
    "environmentId": "<env-id>",
    "category": "apps",
    "description": "Self-hosted Slack bot."
  }' \
  "$URL/api/stack-templates" \
  | jq '.data.id'
```

**Note:** `POST /api/stack-templates` accepts metadata only. The `vault`
and `inputs` sections are NOT accepted here — they go in via the draft
endpoint.

### 2. Submit the full bundle body via draft

```bash
curl -sS -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d @slackbot.template.json \
  "$URL/api/stack-templates/$TEMPLATE_ID/draft"
```

The submitted body is validated against the schema, with cross-validators
checking that AppRole `policy` refs resolve, KV `fromInput` refs resolve,
input names are unique, and KV paths are valid.

### 3. Publish

```bash
curl -sS -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "notes": "Slackbot v3 from installer" }' \
  "$URL/api/stack-templates/$TEMPLATE_ID/publish"
```

Pre-publish substitution validation runs here — typos like `{{stak.id}}`
or `{{environment.foo}}` (on host-scoped templates) are caught before
the version is frozen.

### 4. Instantiate with input values

```bash
curl -sS -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "slackbot",
    "environmentId": "<env-id>",
    "parameterValues": { "image-tag": "v3.1.0" },
    "inputValues": {
      "slackBotToken":   "xoxb-…",
      "slackAppToken":   "xapp-…",
      "anthropicApiKey": "sk-…",
      "githubToken":     "ghp_…",
      "natsAccountSeed": "SAA…"
    }
  }' \
  "$URL/api/stack-templates/$TEMPLATE_ID/instantiate" \
  | jq '.data.id'
```

The `inputValues` map is encrypted at rest using AES-256-GCM with a
key derived from the auth secret. **Get endpoints never return the
encrypted blob nor the decrypted values** — only `inputValueKeys: string[]`
listing which inputs have stored values.

### 5. Apply

```bash
curl -sS -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{}' \
  "$URL/api/stacks/$STACK_ID/apply"
```

The apply pipeline runs in order: `decrypt inputs → render names/paths
via substitution → upsert+publish policies → upsert+apply AppRoles →
write KV → atomic write of resolved vaultAppRoleId on services →
existing service reconcile`.

### 6. Poll for done

```bash
while true; do
  STATUS=$(curl -sS -H "X-API-Key: $KEY" "$URL/api/stacks/$STACK_ID/status" | jq -r '.data.stack.status')
  case "$STATUS" in
    synced) echo "done"; break;;
    error)
      curl -sS -H "X-API-Key: $KEY" "$URL/api/stacks/$STACK_ID" \
        | jq '{ status, lastFailureReason }'
      exit 1;;
  esac
  sleep 3
done
```

`lastFailureReason` is populated on failure with a human-readable
message including the failing phase and concrete entity name. See
**Failure semantics** below.

## Inputs

### Supplying values

Required, non-`rotateOnUpgrade` inputs MUST be supplied at instantiate
time. Subsequent `PUT /api/stacks/:id` calls (or PATCH-style updates
via the same route) accept partial `inputValues`; missing keys roll
forward from stored values (decrypt-merge-encrypt).

If a declaration has `rotateOnUpgrade: true`, every template-version
bump requires a fresh value; the apply route returns
`400 input_rotation_required` listing the missing inputs if not supplied.

### Storage and visibility

- Encrypted at rest with AES-256-GCM, key derived from the auth secret
  (same scheme as Mini Infra's existing registry credentials).
- Never returned by any GET endpoint.
- Audit events for KV writes that resolve `fromInput` references
  log the path + field names but not the values.

### Orphaned values

If a template version drops an input declaration that a previous
version had, the stored encrypted value is pruned at the end of the
next successful apply. No silent resurrection if a future version
reintroduces the same name.

## Substitution

Available namespaces in template strings (after PR 1 + PR 2):

| Namespace | Resolved at | Allowed in |
|---|---|---|
| `{{params.<key>}}` | apply | env values, configFile content, KV paths, policy bodies, AppRole names, KV field literal values |
| `{{stack.id}}` | apply | as above |
| `{{stack.name}}`, `{{stack.projectName}}` | apply | as above |
| `{{environment.id}}`, `{{environment.name}}`, `{{environment.type}}`, `{{environment.networkType}}` | apply | as above (rejected on host-scoped templates) |
| `{{volumes.<name>}}`, `{{networks.<name>}}` | apply | as above |
| `{{inputs.<name>}}` | apply | **`vault.kv[].path` only** (rejected elsewhere) |

`vault.kv[].fields[].fromInput` is the structured way to feed input
values into KV field VALUES — string substitution is reserved for paths
and other string-shaped fields. The field-value substitution does not go
via the substitution engine.

## Per-service AppRole binding

Today the installer ships a single `navi-slackbot` policy that grants
read access to every shared KV path because the reconciler used to only
consume the stack-level `vaultAppRoleId`. PR 1 made the reconciler
consume per-service binding via `StackTemplateService.vaultAppRoleRef`,
resolved to a concrete `vaultAppRoleId` at apply time.

To use it, declare per-service AppRoles in `vault.appRoles[]` and reference
them on each service:

```jsonc
{
  "vault": {
    "appRoles": [
      { "name": "slackbot-slack-gateway", "policy": "slackbot-slack-gateway-read", … }
    ]
  },
  "services": [
    {
      "serviceName": "slack-gateway",
      "vaultAppRoleRef": "slackbot-slack-gateway",
      …
    }
  ]
}
```

The reconciler resolves `vaultAppRoleRef` → concrete `vaultAppRoleId`
inside the apply transaction and writes it to `StackService.vaultAppRoleId`
atomically with apply success.

The fail-closed degradation logic (cached `role_id` returned when Vault
is briefly unreachable) keys by AppRole ID, so per-service binding doesn't
weaken availability vs the unioned policy.

## Failure semantics

### Apply rollback (#251)

If any phase of the apply pipeline fails after at least one resource
has been written, the reconciler walks the prior version's snapshot
and restores: KV → AppRoles → policies. The stack lands in
`status: 'error'` with `lastFailureReason` populated; running services
are unaffected.

The `Stack.lastAppliedVaultSnapshot` column carries the prior CONCRETE
state (HCL bodies, AppRole configs, KV plaintext field values) and is
encrypted at rest. Snapshots from before #251 (hashes-only) are
gracefully treated as "no rollback target available" — the failure
message says so and the operator must `DELETE /api/stacks/:id` to
clean up orphans.

### First-apply orphans

If the very first apply on a stack fails partway through, no prior
snapshot exists. The reconciler logs loudly but cannot roll back.
Orphan policies/AppRoles/KV may be left in Vault. `lastFailureReason`
includes the language: `"first apply failed; vault may have orphan
policies/approles/kv — delete the stack to clean up."`

### DELETE cascade (#252)

`DELETE /api/stacks/:id` runs a Vault cascade phase before removing
the Stack row:

1. KV paths owned by this stack — soft-deleted (history preserved per KV v2).
2. AppRoles — deleted IF not shared with another stack of the same template.
3. Policies — deleted IF not shared.
4. Stack row removed.

The sharing check uses a `StackVaultResource` index table populated at
apply time. Two instances of the same template share `host`/`environment`-scoped
resources; deleting one leaves the resources for the other. `stack`-scoped
resources or names containing `{{stack.id}}` are always per-instance.

Vault deletion failures during cascade are logged as failed audit
events but do not block the Stack row removal — orphans surface in
the events stream and can be cleaned via `DELETE /api/vault/policies/:id`
etc.

## Permissions

Two scopes required on the API key the installer uses:

| Scope | Required for |
|---|---|
| `stack-templates:write` | Any template create/update/draft/publish/instantiate. |
| `template-vault:write` | Submitting a bundle body containing a non-empty `vault: {…}` section. Returns 403 `template_vault_scope_required` if missing. |

Plus the existing `stacks:write` for `POST /api/stacks/:id/apply` and
`DELETE /api/stacks/:id`.

The `Editor` preset has all of these. The `Reader` preset has none of
the write scopes. For automation, create a dedicated API key with
exactly `stack-templates:write`, `template-vault:write`, `stacks:write`.

## Migration checklist

For [`slackbot-agent-sdk/environment/install-mini-infra.ts`](../../slackbot-agent-sdk/environment/install-mini-infra.ts):

1. **Move policy definitions** from
   [`SLACKBOT_POLICIES`](../../slackbot-agent-sdk/environment/install/policies.ts)
   into the new `vault.policies[]` block of `slackbot.template.json`.
   Drop the unioned `navi-slackbot` policy in favour of per-service
   policies.

2. **Move AppRole definitions** from `SLACKBOT_APPROLES` into
   `vault.appRoles[]`. Reference each AppRole's policy by name.

3. **Move KV writes** from the installer's `stageVaultKv` into
   `vault.kv[]`. Use `{ "fromInput": "<name>" }` to wire operator-supplied
   values; use `{ "value": "<literal>" }` for static defaults.

4. **Declare inputs** for each KV field that's currently filled by the
   installer's config secrets (`slackBotToken`, `slackAppToken`,
   `anthropicApiKey`, `githubToken`, `natsAccountSeed`, etc.). Mark
   them `sensitive: true` and `required: true`.

5. **Add `vaultAppRoleRef`** to each service in `services[]`,
   referencing the corresponding per-service AppRole name.

6. **Drop the `mini-infra-stack-id` parameter** and the follow-up
   `PUT /api/stacks/:id` that backfills it. `{{stack.id}}` now
   substitutes directly into env values.

7. **Replace the 8 stages with 5 calls** (steps 4–8 in the TL;DR
   above) plus the polling loop. Stages 1 (reachability), 2 (build
   images), 3 (push images), and the NATS bootstrap remain — those
   are slackbot-specific and not bundle-shaped.

8. **Update the API key permission scope** in your install config to
   include `template-vault:write`.

9. **Test the new flow** against a worktree dev instance. Smoke
   should match what mini-infra's PR 4 / PR 5 smoke covers: forward
   apply succeeds, deliberately broken HCL on a republish triggers
   rollback to prior state, DELETE cascades cleanly.

After step 9, the installer is roughly:

- ~50 lines of CLI flag parsing + config loading (unchanged).
- ~30 lines of build/push (unchanged).
- ~30 lines of NATS bootstrap (unchanged).
- ~50 lines of bundle-build (loading `slackbot.template.json`,
  applying parameter overrides).
- ~30 lines of the 5-call sequence + polling loop.

Roughly 190 lines vs the current 686. Specific cuts:

| Cut | Lines saved |
|---|---|
| `stageVaultPolicies` + `SLACKBOT_POLICIES` constants | ~80 |
| `stageVaultAppRoles` + `SLACKBOT_APPROLES` constants | ~70 |
| `stageVaultKv` and the operator-userpass Vault-token resolution helper | ~110 |
| `mini-infra-stack-id` follow-up `PUT` | ~20 |
| Per-stage `--skip` flag plumbing (stages collapse) | ~40 |
| `MiniInfraApi` envelope wrapper (replace with simpler ad-hoc fetch or a future `@mini-infra/sdk`) | ~50 |

## What's still missing (Phase 3)

These items are NOT shipped in Phase 2. They sit in
[`docs/stack-bundles-and-installer-improvements.md`](stack-bundles-and-installer-improvements.md)
as Phase 3 candidates.

| Item | Why it matters for slackbot |
|---|---|
| **`POST /api/images/build`** | Today the installer shells out to `docker build` against the local Docker host. CI environments would benefit from delegating the build to mini-infra. Skip if you're happy with local builds. |
| **Streaming apply (`?wait=jsonl` or SSE)** | Replaces the polling loop with a single long-poll call that streams per-service progress events. Useful for richer progress UI but not blocking. |
| **`@mini-infra/sdk`** | Generated TypeScript client from `@mini-infra/types`. Replaces the hand-rolled fetch wrapper in [`mini-infra-api.ts`](../../slackbot-agent-sdk/environment/install/mini-infra-api.ts). |
| **Non-interactive Vault bootstrap** | Today the installer special-cases `initialised: false` and bails. The bundle apply would lazily trigger bootstrap with a passphrase from the install config. |
| **Pool token introspection** | `GET /api/stacks/:id/pools/:svc/management-token-meta` — lets reachability checks confirm the manager's pool API token resolved correctly without trusting the apply. |

## References

- [Phase 1 design doc](stack-bundles-and-installer-improvements.md)
- [Phase 1 PR](https://github.com/mrgeoffrich/mini-infra/pull/247) — template context, per-service AppRole binding, vault-kv dynamicEnv, brokered KV API
- [Phase 2 PR 1](https://github.com/mrgeoffrich/mini-infra/pull/248) — `inputs[]` + `vault: {…}` schema + permission gate
- [Phase 2 PR 2](https://github.com/mrgeoffrich/mini-infra/pull/249) — apply-time Vault reconciliation
- [Phase 2 PR 3](https://github.com/mrgeoffrich/mini-infra/pull/250) — system templates extended
- [Phase 2 PR 4](https://github.com/mrgeoffrich/mini-infra/pull/251) — snapshot rollback on partial failure
- [Phase 2 PR 5](https://github.com/mrgeoffrich/mini-infra/pull/252) — DELETE cascade with sharing rules
- [Phase 2 follow-up tracker](phase-2-followups.md)
