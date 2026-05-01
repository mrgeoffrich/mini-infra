---
title: Using Vault from your app
description: How to declare Vault policies and AppRoles in a stack template, get credentials injected at deploy time, and read secrets from your application code.
tags:
  - vault
  - secrets
  - openbao
  - approle
  - applications
  - integration
  - templates
---

# Using Vault from your app

Mini Infra runs a managed Vault (OpenBao) instance for storing secrets. App authors don't need to provision policies or AppRoles by hand --- declare them in your stack template and the apply orchestrator pushes them to Vault and wires the auth credentials into your container.

This page is the consumer-side companion to the admin-focused [Vault Overview](/vault/overview), [Policies](/vault/policies), and [AppRoles](/vault/approles) pages. Read those if you want the dashboard view; read this if you're writing a template.

## What you can do from a template

| You want… | Add this to your template |
|---|---|
| A Vault policy for your app | `vault.policies[]` |
| An AppRole tied to that policy | `vault.appRoles[]` |
| Pre-populated KV secrets at deploy time | `vault.kv[]` |
| Auth credentials injected into the container | `dynamicEnv` of kind `vault-addr`, `vault-role-id`, `vault-wrapped-secret-id` |
| A specific KV field read at apply time and exposed as a plain env var | `dynamicEnv` of kind `vault-kv` |

## Pattern A --- AppRole login (recommended for apps that read secrets at runtime)

This is the right pattern when your app needs Vault tokens at runtime --- e.g. to read rotating secrets, write audit data, or call other policy-gated paths.

### 1. Declare a policy

```json
{
  "vault": {
    "policies": [
      {
        "name": "myapp-read",
        "scope": "environment",
        "body": "path \"secret/data/myapp/*\" { capabilities = [\"read\"] }"
      }
    ]
  }
}
```

`scope` (`host` / `environment` / `stack`) controls how broadly the policy is shared. Most app policies are `environment`-scoped.

### 2. Declare an AppRole bound to the policy

```json
{
  "vault": {
    "policies": [ /* … */ ],
    "appRoles": [
      {
        "name": "myapp",
        "policy": "myapp-read",
        "scope": "environment",
        "secretIdNumUses": 1,
        "secretIdTtl": "10m",
        "tokenTtl": "1h"
      }
    ]
  }
}
```

### AppRole fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | AppRole name in Vault; referenced from `services[].vaultAppRoleRef`. |
| `policy` | yes | Policy name from `vault.policies[]` (or an existing policy in Vault). |
| `scope` | yes | `host`, `environment`, or `stack`. |
| `tokenTtl` | no | Token TTL (duration string, e.g. `1h`). |
| `tokenMaxTtl` | no | Hard cap on token TTL. |
| `tokenPeriod` | no | If set, tokens are renewable indefinitely with this period. Use for long-running services. |
| `secretIdTtl` | no | TTL of the wrapped `secret_id` (e.g. `10m`). |
| `secretIdNumUses` | no | How many times the `secret_id` can be used. `1` is the safest default for boot-once. |

### 3. Bind the service and inject login env vars

```json
{
  "services": [
    {
      "serviceName": "app",
      "vaultAppRoleRef": "myapp",
      "containerConfig": {
        "image": "ghcr.io/example/myapp:1.0.0",
        "dynamicEnv": {
          "VAULT_ADDR": { "kind": "vault-addr" },
          "VAULT_ROLE_ID": { "kind": "vault-role-id" },
          "VAULT_WRAPPED_SECRET_ID": { "kind": "vault-wrapped-secret-id", "ttlSeconds": 300 }
        }
      }
    }
  ]
}
```

At apply time, the orchestrator:

1. Pushes the policy and AppRole to Vault.
2. Reads back the static `role_id`.
3. Generates a fresh **wrapped** `secret_id` (one-time-use, expires in `ttlSeconds`) and injects the wrapping token.

### 4. Log in from your app

The boot sequence is fixed by Vault's response-wrapping protocol:

```ts
// 1. Unwrap the one-time-use secret_id
const unwrapRes = await fetch(`${process.env.VAULT_ADDR}/v1/sys/wrapping/unwrap`, {
  method: 'POST',
  headers: { 'X-Vault-Token': process.env.VAULT_WRAPPED_SECRET_ID! },
});
const { data: { secret_id } } = await unwrapRes.json();

// 2. Login with role_id + secret_id
const loginRes = await fetch(`${process.env.VAULT_ADDR}/v1/auth/approle/login`, {
  method: 'POST',
  body: JSON.stringify({ role_id: process.env.VAULT_ROLE_ID, secret_id }),
});
const { auth: { client_token, lease_duration } } = await loginRes.json();

// 3. Read secrets
const secretRes = await fetch(`${process.env.VAULT_ADDR}/v1/secret/data/myapp/db`, {
  headers: { 'X-Vault-Token': client_token },
});
const { data: { data } } = await secretRes.json();
```

After that, renew or re-login before `lease_duration` expires. Most Vault SDKs handle the renew loop for you.

> **Why wrapped?** `VAULT_WRAPPED_SECRET_ID` is single-use --- the moment any process unwraps it, it's gone. If a second party reads `/proc/self/environ` after your app boots and tries to unwrap, they'll get a hard error and you'll know your env was leaked.

## Pattern B --- KV-only injection (no Vault SDK needed)

If your app just needs one or two static secrets at boot and you don't want to bundle a Vault client, use the `vault-kv` dynamicEnv kind. The orchestrator reads the KV path with the admin token at apply time and hands your container a plain env var.

```json
{
  "vault": {
    "kv": [
      {
        "path": "secret/data/myapp/config",
        "fields": {
          "db_url": { "fromInput": "database-url" },
          "api_key": { "value": "static-secret-here" }
        }
      }
    ]
  },
  "services": [
    {
      "serviceName": "app",
      "containerConfig": {
        "dynamicEnv": {
          "DB_URL":  { "kind": "vault-kv", "path": "secret/data/myapp/config", "field": "db_url" },
          "API_KEY": { "kind": "vault-kv", "path": "secret/data/myapp/config", "field": "api_key" }
        }
      }
    }
  ]
}
```

Use `fromInput` to populate KV fields from a template input (so the secret is provided at instantiation, not committed in the template). Use `value` for static defaults.

> **Trade-off.** KV-only is simpler --- no AppRole login flow, no token renewal --- but updates to the KV path don't propagate to the container until you re-apply the stack. Pattern A picks up new secrets on the next renew/login.

## Choosing between the two patterns

| Use Pattern A (AppRole) when… | Use Pattern B (KV-only) when… |
|---|---|
| You read secrets repeatedly at runtime | You only need a couple of static values at boot |
| Secrets rotate independently of stack apply | The values are stable until you re-apply anyway |
| You audit per-token access in Vault | You're OK with all reads going via the Mini Infra admin token |
| You're already running a Vault client | You don't want to depend on a Vault SDK |

You can use both in the same template if it makes sense.

## End-to-end example (AppRole + KV-only mix)

```json
{
  "vault": {
    "policies": [
      {
        "name": "myapp-rw",
        "scope": "environment",
        "body": "path \"secret/data/myapp/*\" { capabilities = [\"read\", \"update\"] }"
      }
    ],
    "appRoles": [
      {
        "name": "myapp",
        "policy": "myapp-rw",
        "scope": "environment",
        "secretIdNumUses": 1,
        "secretIdTtl": "10m"
      }
    ],
    "kv": [
      {
        "path": "secret/data/myapp/bootstrap",
        "fields": { "log_level": { "value": "info" } }
      }
    ]
  },
  "services": [
    {
      "serviceName": "myapp",
      "vaultAppRoleRef": "myapp",
      "containerConfig": {
        "image": "ghcr.io/example/myapp:2.0.0",
        "dynamicEnv": {
          "VAULT_ADDR":              { "kind": "vault-addr" },
          "VAULT_ROLE_ID":           { "kind": "vault-role-id" },
          "VAULT_WRAPPED_SECRET_ID": { "kind": "vault-wrapped-secret-id", "ttlSeconds": 300 },
          "LOG_LEVEL":               { "kind": "vault-kv", "path": "secret/data/myapp/bootstrap", "field": "log_level" }
        }
      }
    }
  ]
}
```

## What to watch out for

- **The wrapped `secret_id` is single-use.** Any process that touches `VAULT_WRAPPED_SECRET_ID` first wins. If your app crashes after unwrapping but before logging in, the next boot fails until you re-apply.
- **`vault-kv` reads happen at apply time.** Updating a KV value in Vault does not redeploy your container. Re-apply the stack to pick up new values.
- **Policies must be published before AppRoles can apply.** If you reference a policy that isn't yet pushed to Vault, the AppRole apply fails. The orchestrator handles this for in-template policies; for externally-managed policies, ensure they exist first.
- **`scope` is sticky.** A `stack`-scoped AppRole is removed when the stack is destroyed; an `environment`-scoped one survives. Pick deliberately.
- **No automatic token renewal.** Your app is responsible for renewing or re-logging in before `lease_duration` expires. Most Vault SDKs do this transparently.
- **Deleting the AppRole in the template doesn't remove it from Vault.** If you remove `vault.appRoles[]` and re-apply, the AppRole stays in Vault until an admin removes it. Same for policies.
- **Combine with NATS.** If your app needs both, see [Connecting your app to NATS](/nats/app-integration) --- the two integrations stack cleanly in one template.
