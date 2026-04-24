---
title: Managing Vault AppRoles
description: How to create, apply, and manage Vault AppRole credentials for applications in Mini Infra.
tags:
  - vault
  - secrets
  - openbao
  - approle
  - authentication
  - administration
  - security
---

# Managing Vault AppRoles

Vault AppRoles are the primary way Mini Infra-managed applications authenticate to Vault and obtain short-lived tokens. Each AppRole is bound to a [policy](/vault/policies) that defines what secrets the application can access.

Applications authenticate using a `role_id` (static, public) and a `secret_id` (short-lived, single-use). Mini Infra manages the AppRole lifecycle — you create and configure it here, then apply it to push the definition to Vault.

## Understanding AppRole Status

Each AppRole in the list shows:

| Badge | Meaning |
|-------|---------|
| `policy:{name}` | The Vault policy this AppRole is bound to. |
| `applied` | The AppRole exists in Vault and has a `role_id`. |
| `not applied` | The AppRole is defined in Mini Infra but not yet pushed to Vault. |

When an AppRole is applied, its `role_id` is shown below the name — copy this for your application's configuration.

## Creating an AppRole

1. Click **New AppRole**.
2. Fill in the fields:
   - **Name** — The Vault AppRole name (e.g. `my-app`).
   - **Policy** — Select the policy from the dropdown. Only published policies are available.
   - **secret_id_num_uses** — How many times a `secret_id` can be used before it expires. `0` = unlimited; `1` = boot-once (recommended for most apps that fetch a `secret_id` on startup).
   - **token_period** (optional) — A duration string (e.g. `1h`) that makes tokens renewable indefinitely for long-running services. Leave blank for the Vault default TTL.
3. Click **Create**.

The AppRole is saved in Mini Infra as `not applied` until you apply it.

## Applying an AppRole

Click **Apply** next to an AppRole to push it to Vault. Applying:

- Creates or updates the AppRole in Vault using the configured policy and parameters.
- Fetches and caches the `role_id` from Vault.
- Changes the status badge to `applied`.

You can re-apply after changing configuration to update the AppRole in Vault.

## Using AppRole Credentials in an Application

After applying an AppRole, your application needs two values to authenticate:

1. **role_id** — Visible in the AppRole list once applied.
2. **secret_id** — Generated on demand from Vault using the `role_id`. Mini Infra does not store `secret_id` values; your application (or deployment tooling) generates them via the Vault API.

A typical boot sequence for an application:
1. The app calls `POST /v1/auth/approle/login` with `role_id` and `secret_id`.
2. Vault returns a short-lived token.
3. The app uses that token to read secrets from its allowed paths.
4. Before the token expires, the app renews it (or re-logs in to get a fresh token).

## Deleting an AppRole

Click the trash icon next to an AppRole and confirm the deletion.

This removes the AppRole from Mini Infra. If the AppRole was applied, it also needs to be removed from Vault separately (via the Vault UI or API) — Mini Infra does not automatically delete it from Vault on deletion.

## What to watch out for

- **Apply before using.** An unapplied AppRole does not exist in Vault. Your application will receive an authentication error until the AppRole is applied.
- **secret_id_num_uses = 1 is safest.** A single-use `secret_id` limits the blast radius if credentials are intercepted. Applications that restart frequently may need `0` (unlimited) instead.
- **token_period for long-running services.** Without `token_period`, Vault tokens have a maximum TTL after which the application must re-authenticate. Services that run continuously for days or weeks typically set a `token_period` so they can renew indefinitely.
- **Deleting in Mini Infra does not delete in Vault.** After deleting an AppRole here, any existing `role_id` and `secret_id` credentials for that AppRole continue to work in Vault until the AppRole is also removed from Vault directly.
- **Policy must be published first.** The dropdown only shows policies that exist in Mini Infra, including unpublished drafts. If you apply an AppRole that references an unpublished policy, Vault will reject the apply because the policy does not exist in Vault yet.
