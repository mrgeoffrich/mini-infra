---
title: Managing Vault Policies
description: How to create, edit, publish, and delete HCL policy documents for the managed Vault in Mini Infra.
tags:
  - vault
  - secrets
  - openbao
  - policies
  - administration
  - security
---

# Managing Vault Policies

Vault policies are HCL documents that control which secret paths a token can access and what operations it can perform. Every AppRole in Vault is bound to a policy, and the policy determines what that application can read, write, or list.

Mini Infra manages policies with a draft-and-publish model: you write or edit a policy locally, then publish it to the Vault instance when it is ready.

## Understanding Policy Status

Each policy in the list shows one of two states:

| Badge | Meaning |
|-------|---------|
| `draft` | The policy has been created but not yet pushed to Vault. |
| `published v{N}` | The policy has been published; the number is the version count. |

System policies (marked with a `system` badge) are built-in policies created by Mini Infra during bootstrap. They can be published but not deleted.

## Creating a Policy

1. Click **New Policy**.
2. Fill in the required fields:
   - **Name** — Lowercase alphanumeric characters and hyphens only (e.g. `my-app-secrets`). This becomes the Vault policy name.
   - **Display Name** — Human-readable label shown in the Mini Infra UI.
   - **Description** — Optional free-text description.
   - **HCL Body** — The policy document in HashiCorp Configuration Language.
3. Click **Create**.

The policy is saved as a draft. It is not pushed to Vault until you publish it.

### HCL Policy Syntax

A policy grants capabilities on a path pattern. Example:

```hcl
path "secret/data/my-app/*" {
  capabilities = ["read", "list"]
}

path "secret/metadata/my-app/*" {
  capabilities = ["list"]
}
```

Common capabilities: `read`, `list`, `create`, `update`, `delete`. Use `*` as a wildcard in path segments.

## Publishing a Policy

Click **Publish** next to a policy to push its current HCL body to Vault. Publishing:

- Creates or updates the named policy in Vault.
- Increments the published version counter.
- Any AppRole bound to this policy immediately uses the updated rules.

You can re-publish after editing a policy to push the latest changes.

## Editing a Policy

Click a policy's name to open the policy detail page, where you can edit the HCL body and view the version history. Save your changes as a new draft, then publish when ready.

## Deleting a Policy

Click the trash icon next to a non-system policy and confirm the deletion.

Deleting a policy:
- Removes it from Mini Infra's database.
- **Does not** automatically remove it from Vault — publish a removal or clean up the Vault policy separately if needed.
- Any AppRole that referenced this policy in Mini Infra will need to be updated.

System policies cannot be deleted.

## What to watch out for

- **Publish before using in AppRoles.** A draft policy does not exist in Vault yet. AppRoles bound to an unpublished policy will fail to authenticate until the policy is published.
- **Policy changes take effect immediately.** As soon as you publish, all existing tokens bound to this policy gain (or lose) the capabilities in the updated HCL.
- **Deleting in Mini Infra does not delete in Vault.** The Vault policy persists in Vault even after you delete the Mini Infra record. If you want to fully remove a policy, you must also delete it directly in Vault (via the Vault UI or API).
- **System policies cannot be deleted.** Built-in Mini Infra policies are marked `system` and do not have a delete button.
