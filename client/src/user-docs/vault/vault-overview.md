---
title: Vault Overview
description: An overview of the managed OpenBao secrets vault in Mini Infra — bootstrap, seal state, and operator credentials.
tags:
  - vault
  - secrets
  - openbao
  - administration
  - security
---

# Vault Overview

Mini Infra includes a managed [OpenBao](https://openbao.org/) secrets vault. OpenBao is an open-source fork of HashiCorp Vault that provides encrypted key-value secret storage, policy-based access control, and short-lived authentication tokens for applications.

The Vault page gives you a single place to bootstrap the vault instance, monitor its seal state, manage the operator passphrase, and navigate to policies and AppRoles.

## Prerequisites

Before bootstrapping Vault, the Vault stack must be deployed as a running container on your Docker host. If the stack is not yet running, the status card will show **Reachable: No**. Deploy the Vault stack via the [Stacks](/environments) or [Applications](/applications) page first.

## Understanding Vault Status

The **Status** card shows four indicators:

| Indicator | Values | Meaning |
|-----------|--------|---------|
| **Bootstrapped** | Yes / No | Whether `bao init` has been run and unseal keys have been generated. |
| **Reachable** | Yes / No | Whether Mini Infra can reach the Vault HTTP API. |
| **Seal** | `unsealed` / `sealed` / `unknown` | Whether the vault is currently accepting requests. |
| **Passphrase** | `unlocked` / `locked` | Whether the operator passphrase is held in memory for auto-unsealing. |

Vault must be **bootstrapped**, **reachable**, and **unsealed** to store and retrieve secrets.

## Bootstrapping Vault

If the vault has not been bootstrapped (Bootstrapped shows **No**):

1. Make sure the Vault container is running.
2. Click **Bootstrap Vault**.
3. Follow the bootstrap dialog — Mini Infra runs `bao init`, generates unseal keys, and stores them encrypted with the passphrase you provide.

You will be prompted to set and confirm an **operator passphrase**. Store this passphrase securely — it is required to unseal Vault after a restart and to decrypt operator credentials.

## Unlocking the Passphrase

The operator passphrase is kept in server memory to enable automatic unsealing. When the server restarts, the passphrase is cleared and must be re-entered.

If Passphrase shows **Locked**:

1. Click **Unlock Passphrase**.
2. Enter the passphrase you set during bootstrap.
3. If Vault is sealed, Mini Infra automatically unseals it once the passphrase is unlocked.

## Locking the Passphrase

Click **Lock Passphrase** to remove the passphrase from memory. This has these effects:

- **Auto-unseal stops.** If Vault restarts or is manually sealed, Mini Infra cannot unseal it until you unlock the passphrase again.
- **Operator credentials become unreadable.** The stored password cannot be decrypted while the passphrase is locked.
- The active admin token continues to work until it expires (1 hour).

## Manual Unseal

If Vault is sealed and the passphrase is unlocked, click **Unseal Now** to manually trigger the unseal process.

## Operator Credentials

When the vault is bootstrapped and the passphrase is unlocked, the **Operator Credentials** card appears. It shows the credentials for the `mini-infra-operator` Vault userpass account — useful for logging into the Vault UI directly.

Click **Reveal password** to decrypt and display the password. Use the copy icon to copy it to the clipboard.

## Policies and AppRoles

From the Vault overview page, navigate to:

- **[Manage Policies](/vault/policies)** — Create and publish HCL policy documents that define what paths and capabilities a token can access.
- **[Manage AppRoles](/vault/approles)** — Create AppRole credentials that applications use to mint short-lived tokens.

## What to watch out for

- **Losing the passphrase is unrecoverable.** If you lose the operator passphrase, the unseal keys cannot be decrypted and the vault cannot be unsealed. There is no recovery path short of reinitialising Vault (which destroys all secrets).
- **Vault stack must stay running.** If the Vault container is stopped, all secret access from applications using AppRole tokens will fail until the container is restarted and unsealed.
- **Admin tokens expire after 1 hour.** The operator admin token Mini Infra holds is renewed automatically while the passphrase is unlocked. If the passphrase is locked and the token expires, Mini Infra loses its admin access to Vault until the passphrase is unlocked again.
