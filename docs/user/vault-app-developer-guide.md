# Developer Guide: Building Applications that Use Vault

This guide is for developers writing applications that want to read secrets from Mini Infra's managed Vault (OpenBao) at runtime. It covers how Mini Infra hands credentials to your container, what your container has to do to turn those credentials into a usable token, and exactly what the stack template needs to look like.

If you're an operator setting Vault up for the first time, see [secrets-vault-plan.md](../planning/shipped/secrets-vault-plan.md) for the high-level model and [secrets-vault-implementation.md](../planning/shipped/secrets-vault-implementation.md) for the implementation phases.

## The one-line summary

Mini Infra runs OpenBao as a system stack. When you bind a stack to a `VaultAppRole`, Mini Infra mints a short-lived **wrapped secret_id** on each deploy and injects it into your container as an env var alongside `VAULT_ADDR` and `VAULT_ROLE_ID`. Your container unwraps the secret_id, logs in via AppRole, and reads the secrets it's authorised for. Nothing long-lived ever touches the container filesystem or the stack snapshot.

## How the credential flow works

```
  Mini Infra (stack apply)                       Your container (at boot)
  ──────────────────────────                     ──────────────────────────
  read role_id for AppRole       ───────►        VAULT_ROLE_ID
  mint wrapped secret_id         ───────►        VAULT_WRAPPED_SECRET_ID  (TTL: 300s default)
  resolve vault internal addr    ───────►        VAULT_ADDR

                                                 POST /v1/sys/wrapping/unwrap
                                                   header X-Vault-Token: $VAULT_WRAPPED_SECRET_ID
                                                   → plain secret_id

                                                 POST /v1/auth/approle/login
                                                   body: { role_id, secret_id }
                                                   → client_token (policy-bound, renewable)

                                                 use token to read secret/data/…, renew periodically
```

Key properties:

- **Wrapped secret_id is one-shot.** Once unwrapped it's useless to anyone else. It expires after its TTL (300s by default) if not consumed.
- **No secret ever lands in the stack snapshot or drift hash.** `dynamicEnv` values are resolved at apply time and explicitly excluded from the definition hash and applied snapshot, so re-applies always re-mint fresh credentials without spurious drift.
- **Fail-closed is the default.** If Vault is unreachable at apply time and the AppRole binding hasn't changed, Mini Infra can degrade to passing `VAULT_ADDR` + `VAULT_ROLE_ID` only — your container can retry the login loop until Vault comes back. If the binding changed, the apply aborts.

## Walkthrough: from nothing to a deployed Vault-backed app

This section mirrors what you actually click through in Mini Infra, end-to-end. Skip to *Prerequisites* below if you've already done this once.

### Step 1 — Make sure Vault is ready (*Settings → Vault*)

Open the Vault page. You'll see a **Status** card with four badges:

| Badge | What it means |
| --- | --- |
| **Bootstrapped** | Yes once the init-and-unseal ceremony has run |
| **Reachable** | Mini Infra can hit the Vault container over the vault network |
| **Seal** | `unsealed` / `sealed` |
| **Passphrase** | `unlocked` / `locked` — the operator passphrase guards cached credentials |

You need **Bootstrapped: yes**, **Reachable: yes**, **Seal: unsealed**, **Passphrase: unlocked**. Depending on what's missing:

- **Not bootstrapped** → click *Bootstrap Vault*. Fill in a Vault address (leave default) and an Operator Passphrase. The dialog shows progress step-by-step; at the end it displays the **unseal keys**, the revoked root token (for record-keeping), and the **operator login** (`mini-infra-operator` + a generated password). Download the credentials file — this is your only copy.
- **Locked passphrase** → click *Unlock Passphrase* and paste it in. Needed before any apply can mint wrapped secret_ids.
- **Sealed** → click *Unseal Now* (only shows up if Mini Infra can't auto-unseal for some reason).

Once the status is all green, you'll also see an **Operator Credentials** card further down with username/password for logging into the Vault UI itself. Click *Reveal password* to grab it; this is how you'll write secret values in Step 4.

### Step 2 — Write a policy (*Vault → Policies*)

Click *Manage Policies* from the main vault page (or navigate to `/vault/policies`). The list shows existing policies with a **published vN** or **draft** badge.

Click **New Policy**. The dialog has:

- **Name** — lowercase/alphanum/hyphen (e.g. `my-app-read`). This is the Vault-side policy name.
- **Display Name** — for humans.
- **Description** — optional.
- **HCL Body** — the policy itself. A template is pre-filled with a `path "secret/data/example/*"` block as a starting point. Narrow this to just what your app needs:

  ```hcl
  path "secret/data/my-app/*" {
    capabilities = ["read"]
  }
  ```

Click *Create*. Back on the list, find your policy and click the **Publish** button (upload icon). Publishing is what actually writes it to Vault — unpublished drafts don't exist in Vault yet.

### Step 3 — Create an AppRole (*Vault → AppRoles*)

From the main vault page click *Manage AppRoles*, then **New AppRole**. The dialog has:

- **Name** — e.g. `my-app`.
- **Policy** — dropdown of existing policies (format: *Display Name (name)*). Pick the one from Step 2.
- **secret_id_num_uses** — leave at `1`. This is the "boot-once" model: each wrapped secret_id can only be unwrapped + used once. (`0` means unlimited — avoid unless you know why.)
- **token_period** — optional. For long-running apps that should renew indefinitely, set something like `1h`.

Click *Create*, then on the list click the **Apply** button for your new AppRole. Apply is what pushes it into Vault and reads back the `role_id`. Until you've applied, the status shows "not applied" and the role_id column is blank.

Click the AppRole name to open the detail page. You'll see:

- **Configuration** card with the real `role_id` (UUID), `secret_id_num_uses`, token settings, and `lastAppliedAt`.
- **Bound Stacks** card — empty for now. This is where your stack will show up once you bind it.

Copy the AppRole's **internal ID** from the URL (`/vault/approles/<id>`) — you'll need it for the bind call in Step 5. *(This is different from the `role_id` UUID shown on the page; the URL id is Mini Infra's FK, the role_id is Vault's identity.)*

### Step 4 — Write your secret values

Mini Infra has no KV-write UI yet, so use the Vault UI directly:

1. Open the Vault UI at the address shown on the Vault status card (default `http://<host>:8200`).
2. Log in with method **userpass**, username `mini-infra-operator`, and the password from the Operator Credentials card in Step 1.
3. Navigate to the **secret/** KV engine.
4. Create a secret under the path your policy allows (e.g. `secret/my-app/db` with keys `host`, `password`, etc.).

Remember KV v2 semantics: the UI path is `secret/my-app/db`, but the API path your container reads is `secret/data/my-app/db`, and the response nests your values under `.data.data`.

### Step 5 — Deploy your stack and bind it

Create or instantiate your stack in the usual way (Stacks or Applications page). In the template JSON, include the three bits from *Stack template: the three things that matter* below — `resourceInputs` for the vault network, `joinResourceNetworks: ["vault"]`, and the `dynamicEnv` block.

Then bind the stack to the AppRole. **There's no UI for this yet** — use the API:

```bash
curl -X PATCH https://<mini-infra>/api/stacks/<your-stack-id> \
  -H "Authorization: Bearer <your-api-token>" \
  -H "Content-Type: application/json" \
  -d '{ "vaultAppRoleId": "<approle-id-from-url-in-step-3>", "vaultFailClosed": true }'
```

To verify the binding took: go back to *Vault → AppRoles → your-app*. Your stack should now appear in the **Bound Stacks** card.

### Step 6 — Apply the stack and watch it work

Trigger an apply from the stack's page. The apply flow runs as normal — there's no special Vault indicator in the task tracker — but under the hood:

1. Mini Infra reads the role_id (cached) and mints a wrapped secret_id with a 300s TTL.
2. Three env vars get injected into every service with a `dynamicEnv` block.
3. Your container starts, unwraps the secret_id, logs in, reads secrets, and does its thing.

Check the container logs: if you see a successful `auth/approle/login` response with a `client_token`, you're done. If the container crash-loops with "permission denied", double-check the policy paths in Step 2 match the KV paths in Step 4. If you see "wrapping token is not valid or does not exist", the 300s TTL elapsed before unwrap — bump `ttlSeconds` or speed up your image pull.

---

## Prerequisites

Before you can deploy a Vault-backed application:

1. **The Vault stack is deployed.** Go to *Settings → Vault*, deploy the system `vault` template if it isn't already, and run the bootstrap flow. This leaves Vault initialised, unsealed, and with `approle/` + `userpass/` auth methods plus a KV v2 mount at `secret/`.
2. **A `VaultPolicy` exists.** Write an HCL policy that grants your app exactly the paths it needs. Keep it narrow — one policy per app is the norm. Example:

   ```hcl
   path "secret/data/my-app/*" {
     capabilities = ["read"]
   }
   ```
3. **A `VaultAppRole` exists, referencing that policy.** Create it from the Vault AppRoles page. Reasonable defaults:

   | Field | Typical value |
   | --- | --- |
   | `secretIdNumUses` | `1` (secret_id is consumed once) |
   | `secretIdTtl` | `"0"` (the wrap TTL bounds freshness) |
   | `tokenPeriod` | `"24h"` (renewable indefinitely so long as the app renews) |
   | `tokenTtl` | unset (derived from period) |
   | `tokenMaxTtl` | unset |
4. **Your secrets are written in Vault.** Use the Vault UI or operator CLI to put values under `secret/data/<path>` matching your policy.

## Stack template: the three things that matter

There are exactly three additions to a normal stack template:

### 1. Join the vault network

The vault stack publishes a host-scoped Docker network under `purpose: "vault"`. Declare it as a `resourceInput` at the stack level so your stack won't deploy without it, then join it on each service that talks to Vault:

```json
{
  "resourceInputs": [
    { "type": "docker-network", "purpose": "vault", "optional": false }
  ],
  "services": [
    {
      "containerConfig": {
        "joinResourceNetworks": ["vault"]
      }
    }
  ]
}
```

Containers on that network resolve Vault at `http://mini-infra-vault-vault:8200` — that's the value Mini Infra injects as `VAULT_ADDR`.

### 2. Declare `dynamicEnv`

In each service's `containerConfig`, add a `dynamicEnv` block alongside (not overlapping with) `env`:

```json
{
  "env": { "APP_PORT": "8080" },
  "dynamicEnv": {
    "VAULT_ADDR":              { "kind": "vault-addr" },
    "VAULT_ROLE_ID":           { "kind": "vault-role-id" },
    "VAULT_WRAPPED_SECRET_ID": { "kind": "vault-wrapped-secret-id", "ttlSeconds": 300 }
  }
}
```

Supported `kind` values (defined in [lib/types/stacks.ts:45](lib/types/stacks.ts:45)):

| `kind` | What it resolves to |
| --- | --- |
| `vault-addr` | Internal Vault URL (`http://mini-infra-vault-vault:8200`) |
| `vault-role-id` | The AppRole's role_id (stable; cached after first read) |
| `vault-wrapped-secret-id` | Fresh response-wrapped secret_id minted at apply time. Optional `ttlSeconds` (default 300, per [DEFAULT_WRAPPED_SECRET_ID_TTL_SECONDS](server/src/services/vault/vault-credential-injector.ts:12)). |

Env var *names* are up to you — the keys on the left of `dynamicEnv` become the env var names inside the container. The names above (`VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_WRAPPED_SECRET_ID`) are the convention the Vault CLI and most libraries already recognise, so stick with them unless you have a reason not to.

Rule: keys in `dynamicEnv` must not collide with keys in `env`. Validation will reject the stack if they do.

### 3. Bind the stack to an AppRole

This is **not** part of the template JSON — it's set on the stack record itself, after instantiation. The binding maps to two columns on `Stack` ([schema.prisma:1085](server/prisma/schema.prisma:1085)):

- `vaultAppRoleId` — FK to `VaultAppRole`.
- `vaultFailClosed` — boolean. `true` = abort apply if Vault is unreachable and the binding is new; `false` = tolerate degraded applies where only role_id is injected.

Both fields are accepted by the stack update API ([server/src/services/stacks/schemas.ts:337](server/src/services/stacks/schemas.ts:337)):

```bash
curl -X PATCH https://<mini-infra>/api/stacks/<stack-id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "vaultAppRoleId": "<approle-id-from-vault-approles-page>", "vaultFailClosed": true }'
```

> **Heads up — no stack-edit UI for this yet.** At time of writing there is no form in the Mini Infra client that exposes `vaultAppRoleId` / `vaultFailClosed`. You bind via the API call above (or via a one-off `prisma studio` update). The *AppRoles* page shows a "Bound Stacks" list per AppRole so you can verify it took effect. A UI is tracked for a future phase.

Without a binding, the `dynamicEnv` block is a no-op and nothing gets injected.

## Full working example

This is the built-in `hello-vault` example template ([server/templates/hello-vault/template.json](server/templates/hello-vault/template.json)). It unwraps the secret_id, logs in, reads a KV secret, and echoes it. Everything a real app does, minus the HTTP server:

```json
{
  "name": "hello-vault",
  "displayName": "Hello Vault (demo)",
  "scope": "environment",
  "category": "examples",
  "parameters": [
    {
      "name": "kv-path",
      "type": "string",
      "default": "hello-vault",
      "description": "KV v2 secret path (under secret/data/) to read"
    }
  ],
  "resourceInputs": [
    { "type": "docker-network", "purpose": "vault", "optional": false }
  ],
  "networks": [],
  "volumes": [],
  "services": [
    {
      "serviceName": "hello",
      "serviceType": "Stateful",
      "dockerImage": "alpine/curl",
      "dockerTag": "latest",
      "containerConfig": {
        "entrypoint": ["/bin/sh", "-c"],
        "command": [
          "set -eu; SECRET_ID=$(curl -fsS -X POST -H \"X-Vault-Token: $VAULT_WRAPPED_SECRET_ID\" $VAULT_ADDR/v1/sys/wrapping/unwrap | sed -n 's/.*\"secret_id\":\"\\([^\"]*\\)\".*/\\1/p'); TOKEN=$(curl -fsS -X POST -d '{\"role_id\":\"'$VAULT_ROLE_ID'\",\"secret_id\":\"'$SECRET_ID'\"}' $VAULT_ADDR/v1/auth/approle/login | sed -n 's/.*\"client_token\":\"\\([^\"]*\\)\".*/\\1/p'); curl -fsS -H \"X-Vault-Token: $TOKEN\" $VAULT_ADDR/v1/secret/data/{{params.kv-path}}; while true; do sleep 30; done"
        ],
        "env": {},
        "dynamicEnv": {
          "VAULT_ADDR":              { "kind": "vault-addr" },
          "VAULT_ROLE_ID":           { "kind": "vault-role-id" },
          "VAULT_WRAPPED_SECRET_ID": { "kind": "vault-wrapped-secret-id", "ttlSeconds": 300 }
        },
        "joinResourceNetworks": ["vault"],
        "restartPolicy": "no"
      },
      "order": 1
    }
  ]
}
```

Deploy it, bind it to an AppRole whose policy allows `read` on `secret/data/hello-vault`, write a secret at that path in the Vault UI, then check the container logs.

## Container-side: what your app has to implement

You're free to use any Vault client library, but the minimum contract is the same.

### Bootstrap sequence (pseudo-code)

```ts
const addr       = process.env.VAULT_ADDR!;
const roleId     = process.env.VAULT_ROLE_ID!;
const wrappedSid = process.env.VAULT_WRAPPED_SECRET_ID; // may be absent in degraded mode

async function login(): Promise<Token> {
  if (!wrappedSid) throw new DegradedError("no wrapped secret_id yet");

  // 1. Unwrap (one-shot)
  const { data: { secret_id } } = await post(`${addr}/v1/sys/wrapping/unwrap`, {
    headers: { "X-Vault-Token": wrappedSid }
  });

  // 2. Login
  const { auth } = await post(`${addr}/v1/auth/approle/login`, {
    body: { role_id: roleId, secret_id }
  });

  return { token: auth.client_token, leaseDuration: auth.lease_duration };
}
```

### Renewal

The AppRole's `tokenPeriod` makes the token renewable forever as long as you renew before expiry. Run a background loop that calls `POST /v1/auth/token/renew-self` at roughly half the lease duration.

### Handling degraded mode

If `VAULT_WRAPPED_SECRET_ID` is missing but `VAULT_ROLE_ID` is present, Mini Infra deployed you while Vault was unreachable. Your app should:

1. Start up and serve whatever traffic doesn't need secrets (or degrade gracefully).
2. Periodically attempt to fetch a new secret_id out-of-band — e.g. by having a sidecar or cron job request a new wrapped secret_id from Mini Infra's API and write it into a shared tmpfs.

Most apps can simply retry: catch the startup failure, sleep, and try again. On the next successful apply Mini Infra will restart your container with fresh credentials anyway.

### Handling container restarts

A wrapped secret_id is **single-use**. The unwrap call on first boot consumes it. Any later restart of the same container (Docker auto-restart, host reboot, manual `docker restart`) hits a Vault that no longer recognises the token, and unwrap fails with `wrapping token is not valid or does not exist`.

If your container is on `restartPolicy: "always"` or `"unless-stopped"`, that error will spam the logs every few seconds — burying the *original* failure (e.g. an invalid Slack token or a misconfigured AppRole policy) under a wall of misleading wrapper-token errors. Mini Infra rejects this combo at template/draft validation time so you can't accidentally ship it.

Pick one of these instead:

- **`restartPolicy: "no"`** *(recommended)* — if first boot fails, the container stays dead and the original error is the last thing in `docker logs`. Redeploy the stack to mint a fresh wrapped token and try again.
- **`restartPolicy: "on-failure"`** — Docker retries on non-zero exit. Same caveat applies (each retry will see the consumed token and fail), but the operator has explicitly opted into the retry semantics. Useful if your entrypoint persists the unwrapped credential to a tmpfs or volume on first success.
- **Cache the unwrapped client_token on a persistent volume** and renew via `POST /v1/auth/token/renew-self` rather than re-logging in. Only the first boot ever calls unwrap. Be aware this makes the volume sensitive.

The TTL (default 300s) is a separate concern: even with the right restartPolicy, if the wrapped token expires before your entrypoint reaches the unwrap call, you'll need a redeploy.

## Secrets engine and paths

Mini Infra enables **KV v2** at the `secret/` mount. Conventions:

- API paths are `/v1/secret/data/<path>` (read/write) and `/v1/secret/metadata/<path>` (versions, delete).
- CLI and UI show `secret/<path>` (the KV v2 driver hides the `/data/` infix).
- The response body nests your data under `.data.data`.
- Version every secret you care about — you get history for free; use `PATCH` to update fields without clobbering siblings.

Design policies around the logical path:

```hcl
# app: payments-api
path "secret/data/payments-api/*" {
  capabilities = ["read"]
}
path "secret/metadata/payments-api/*" {
  capabilities = ["list"]
}
```

Keep one policy + one AppRole per application. Don't share AppRoles across apps — blast radius matters.

## Operational checklist before deploying

- [ ] Vault stack deployed and unsealed (*Settings → Vault* shows "Unsealed").
- [ ] Operator passphrase is unlocked — otherwise Vault-dependent applies will fail closed.
- [ ] A `VaultPolicy` covering the exact paths your app needs is **published**.
- [ ] A `VaultAppRole` references that policy and has been applied (has a `cachedRoleId`).
- [ ] Your secret values are written at the expected KV paths.
- [ ] Stack template declares the `vault` resource input and joins the network.
- [ ] Each service that needs secrets has a `dynamicEnv` block.
- [ ] Stack (or application) is bound to the AppRole in the UI.
- [ ] Decide fail-closed policy: leave it on unless you have a clear reason to tolerate degraded applies.

## Gotchas

- **Binding changes are fail-closed without exception.** If you repoint a stack to a different AppRole, the next apply refuses to run in degraded mode even if `vaultFailClosed` is off — we don't trust a new binding until Vault confirms it.
- **No interpolation in `dynamicEnv` values.** The `kind` discriminator is literal; you can't reference `{{params.*}}` inside a dynamic env source.
- **Static env wins validation, not runtime.** If you accidentally declare the same key in both `env` and `dynamicEnv`, the stack won't save. Fix the collision in the template.
- **Wrapping TTL is a ceiling, not a guarantee.** Your image pull + container start must complete within the TTL (default 300s). If you pull huge images on slow networks, bump `ttlSeconds` — but keep it tight. 300–600s is the sweet spot.
- **Response-wrapped tokens are one-shot.** If you unwrap twice (e.g. a sidecar races your app), the second call fails. Centralise unwrapping in a single init step.
- **Nothing persists secrets for you.** The injector only sets env vars at boot. If you need rotation without restart, your app must renew its own token — Mini Infra doesn't redeploy you just because a token is nearing expiry.

## Reference: files and routes

| Concern | Where |
| --- | --- |
| Template schema (`dynamicEnv`, `joinResourceNetworks`) | [lib/types/stacks.ts:45](lib/types/stacks.ts:45) |
| Credential injector (mint/wrap logic, fail-closed) | [server/src/services/vault/vault-credential-injector.ts](server/src/services/vault/vault-credential-injector.ts) |
| Reconciler integration | [server/src/services/stacks/stack-reconciler.ts:523](server/src/services/stacks/stack-reconciler.ts:523) |
| Vault stack template | [server/templates/vault/template.json](server/templates/vault/template.json) |
| Example app template | [server/templates/hello-vault/template.json](server/templates/hello-vault/template.json) |
| DB binding columns | [server/prisma/schema.prisma:1085](server/prisma/schema.prisma:1085) |
| Admin/policy/approle services | [server/src/services/vault/](server/src/services/vault/) |
| UI entry point | [client/src/app/vault/page.tsx](client/src/app/vault/page.tsx) |
