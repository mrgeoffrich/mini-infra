---
title: API Key Permission Presets
description: How to create and manage reusable permission templates for API keys.
category: Settings
order: 2
tags:
  - api-keys
  - authentication
  - settings
  - configuration
---

# API Key Permission Presets

Permission presets are named sets of API key permissions that you can apply quickly when creating new API keys. Instead of selecting individual permissions every time, you choose a preset and get a consistent, documented permission set.

## The Permission Presets page

Go to [/api-keys/presets](/api-keys/presets) to manage presets. You can also access it from the API Keys page via the **Manage Presets** button.

## Built-in presets

Mini Infra includes five built-in presets:

| Preset | Permissions | Use case |
|--------|-------------|----------|
| **Full Access** | `*` (all permissions) | Admin tools, unrestricted automation |
| **Read Only** | All `:read` scopes | Monitoring, dashboards, audit integrations |
| **AI Agent** | Most read scopes + `containers:write`, `agent:use` | AI assistant integrations |
| **Deployment Manager** | Full deployments, environments, HAProxy, TLS + read for containers, docker, events, registry | CI/CD pipelines |
| **Database Admin** | `postgres:read/write`, `backups:read/write`, `containers:read`, `events:read` | Database management tools |

## Creating a custom preset

Click **Create Preset** to define a new preset:

| Field | Description |
|-------|-------------|
| **Name** | Unique name for the preset (1–100 characters) |
| **Description** | Optional description of what this preset is for (max 500 characters) |
| **Permissions** | Select individual permissions using the grouped accordion |

Click **Save** to create the preset. It will appear in the preset dropdown when creating API keys.

## Editing a preset

Click **Edit** on any custom preset to update its name, description, or permissions.

> Note: Changing a preset does not retroactively update API keys that were already created with that preset. The key keeps the permissions it had at creation time.

## Deleting a preset

Click **Delete** on a preset to remove it. A confirmation dialog appears. Deleting a preset does not affect API keys that were created using it — those keys retain their assigned permissions.

## Applying a preset when creating a key

When creating a new API key at [/api-keys/new](/api-keys/new), open the **Preset** dropdown and select a preset. The permission checkboxes update automatically. You can then customize individual permissions before saving.

Choose **Custom** in the preset dropdown to start with no permissions selected and build from scratch.

## What to watch out for

- Preset names must be unique. You will get a conflict error if you try to create two presets with the same name.
- The built-in presets cannot be deleted or edited.
- Editing a preset **does not update** any existing API keys created from that preset. Update keys individually if you need to change their permissions.
