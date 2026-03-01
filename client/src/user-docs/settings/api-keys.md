---
title: Managing API Keys
description: How to create, manage, and revoke API keys for programmatic access to Mini Infra.
category: Settings
order: 1
tags:
  - api-keys
  - authentication
  - settings
  - security
---

# Managing API Keys

API keys let you access Mini Infra's API programmatically without Google OAuth. You can assign fine-grained permissions to each key so that automated tools and integrations only have the access they need.

## The API Keys page

Go to [/api-keys](/api-keys) to view all API keys associated with your account. The page shows:

- A summary of all keys (count, active keys)
- A table of individual keys with their names, creation dates, and last-used timestamps
- Action buttons to manage each key

## Creating an API key

Click **Create API Key** to go to [/api-keys/new](/api-keys/new).

### Key Details

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | A descriptive name (1–100 characters, alphanumeric plus spaces, hyphens, and underscores) |

### Permissions

Select the permissions this key will have. You can:

- **Choose a preset** — select a pre-defined permission set from the dropdown
- **Customize manually** — expand permission groups and select individual permissions

Permissions are grouped by domain. Each domain has a `read` scope and a `write` scope (write implies read). A key with no permissions selected cannot be created.

### After creation

Mini Infra shows the generated API key value **once**. Copy it immediately — you will never be able to see it again.

An alert confirms: "This is the only time you'll be able to see this API key."

## Using API keys

Add the key to HTTP requests using either header:

```
Authorization: Bearer <your-api-key>
```

or

```
x-api-key: <your-api-key>
```

## Permission domains

| Domain | Read scope | Write scope |
|--------|-----------|------------|
| Containers | View containers, logs | Start, stop, restart, delete |
| Docker Resources | List networks, volumes | Remove networks, volumes |
| Deployments | View configurations, history | Create, trigger, delete |
| Environments | View environments, services | Create, update, delete |
| Load Balancer | View frontends, backends | Create, update, delete |
| PostgreSQL | View databases, backups | Create databases, trigger backups, restore |
| TLS Certificates | View certificates | Issue, renew, revoke |
| Settings | View all settings | Update settings, test connections |
| Events | View events | Create, delete events |
| API Keys | List keys | Create, revoke, delete keys |
| User Preferences | View preferences | Update preferences |
| AI Agent | — | Create agent sessions |
| Self-Backups | View backup history | Trigger, delete backups |
| Registry Credentials | View credentials | Create, update, delete |

## Revoking and deleting keys

From the API Keys page, use the actions on each key to:

- **Revoke** — disables the key immediately (it can no longer be used)
- **Delete** — permanently removes the key record

## What to watch out for

- **Save your key immediately after creation.** There is no way to retrieve the key value after you leave the creation page.
- Keys are scoped to the user who created them. If that user account is removed, the keys are also removed.
- Granting `settings:write` to a key effectively gives it access to all external service credentials. Only grant this permission to trusted automation.
- The `*` (full access) scope bypasses all permission checks. Reserve it for admin tools only.
