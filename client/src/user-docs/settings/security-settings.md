---
title: Security Settings
description: How to manage and regenerate security secrets in Mini Infra.
category: Settings
order: 4
tags:
  - settings
  - security
  - authentication
  - api-keys
---

# Security Settings

The **Security Settings** page at [/settings-security](/settings-security) lets you view and regenerate the two core security secrets used by Mini Infra.

## Security secrets

Mini Infra uses two secrets for authentication and encryption:

| Secret | Used for | Effect of regeneration |
|--------|---------|----------------------|
| **Session Secret** | Signing and verifying JWT authentication tokens | Invalidates **all active user sessions** — everyone must log in again |
| **API Key Secret** | Hashing API keys and encrypting sensitive configuration data | **Breaks all existing API keys** — all keys must be recreated |

Both secrets are displayed masked (`••••••••`) on the settings page.

## Regenerating a secret

Click **Regenerate** next to a secret to generate a new random value. A confirmation dialog appears with a clear warning about the consequences:

- **Session Secret**: "Regenerating will invalidate all active user sessions"
- **API Key Secret**: "Regenerating will break all existing API keys"

Click **Regenerate** in the dialog to confirm. The new secret is applied immediately.

## When to regenerate secrets

Regenerate a secret if:

- You suspect the secret has been compromised
- You are rotating secrets as part of a security audit
- You need to force all users to re-authenticate (session secret)
- You need to invalidate all API keys immediately (API key secret)

## What to watch out for

- **Regenerating the Session Secret logs out all current users immediately**, including yourself. You will need to log in again after the operation.
- **Regenerating the API Key Secret permanently breaks all existing API keys.** Any automation, scripts, or integrations using API keys will stop working. You must create new API keys and update all consumers.
- There is no way to recover a previous secret value. If you accidentally regenerate a secret, you must create new API keys for all consumers.
- These operations take effect immediately with no grace period.
