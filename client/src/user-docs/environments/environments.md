---
title: Managing Environments
description: How to create and manage environments that group services and infrastructure in Mini Infra
tags:
  - environments
  - infrastructure
  - applications
  - configuration
---

# Managing Environments

Environments are groupings that organize your applications, Docker networks, and infrastructure stacks. Each environment has its own HAProxy instance and network configuration.

## Viewing Environments

The Environments page lists all configured environments. Each entry shows the environment name and type.

## Environment Types

- **Production** --- Intended for live, user-facing services.
- **Staging** --- Intended for testing and pre-production validation.

The type is a label that helps you identify the purpose of each environment. It does not enforce any runtime restrictions.

## Environment Details

Click an environment to view its details page, which shows:

- **Environment name and type** --- Displayed in the header with a color-coded badge.
- **Description** --- Optional text describing the environment's purpose.
- **Deployed Applications** --- A card listing all applications deployed in this environment with their current status (synced, pending, etc.).
- **Stacks** --- The full list of infrastructure stacks running in this environment.

The details page refreshes automatically every 10 seconds to show live status.

## Editing an Environment

Open the dropdown menu on the environment details page and select **Edit Environment** to update the name, type, or description.

## Deleting an Environment

Open the dropdown menu and select **Delete Environment**. A confirmation dialog will appear. Deleting an environment removes its configuration but does not automatically stop running containers.

## Egress Firewall

The **Egress** tab on the environment details page has an **Egress Firewall** toggle at the top. Turning it on installs kernel-level egress rules (via the firewall agent) for stacks in this environment and starts logging outbound connections in **observe mode** --- no traffic is blocked, only recorded. Turning it off tears those rules down.

Observe mode lets you see what your egress policies *would have* blocked without disrupting traffic --- useful for tuning policies before committing to enforcement. Actually dropping traffic (enforcement) is a future feature.

A confirmation dialog is shown when you turn the firewall **off**, since disabling stops the event stream for this environment until you turn it back on.

If the firewall agent is offline when you toggle, the change is saved immediately and the agent reconciles when it next reconnects.
