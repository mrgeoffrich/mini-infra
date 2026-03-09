---
title: HAProxy Instances
description: How to monitor HAProxy health across environments and remediate or migrate instances in Mini Infra.
category: Deployments
order: 7
tags:
  - haproxy
  - deployments
  - networking
  - environments
  - monitoring
---

# HAProxy Instances

The **HAProxy Instances** page at [/haproxy/instances](/haproxy/instances) shows a consolidated view of HAProxy health across all environments. Use it to check which environments have HAProxy running, whether configuration is healthy, and to take corrective action when needed.

## Instances table

The table lists every environment that has an HAProxy service configured. Each row shows:

| Column | Description |
|--------|-------------|
| **Environment** | Environment name (links to the environment detail page) |
| **Type** | Environment type badge — `Production` (red) or `Staging` (blue) |
| **Env Status** | Current environment status (`running`, `stopped`, `degraded`, etc.) |
| **HAProxy Health** | Health status of the HAProxy instance (see below) |
| **Frontends** | Number of shared frontends configured |
| **Routes** | Total number of routing rules |
| **Actions** | Available operations (Remediate or Migrate) |

Click **Refresh** in the top-right to reload the table.

## Health status values

| Status | Color | Meaning |
|--------|-------|---------|
| **Healthy** | Green | HAProxy configuration matches the expected state |
| **Needs Remediation** | Yellow | Configuration has drifted and needs to be resynced |
| **Needs Migration** | Orange | Environment uses the older HAProxy deployment and should be migrated to stack-managed |
| **Unavailable** | Red | HAProxy health could not be determined (environment may be starting or in an error state) |
| **—** | Gray | Environment is stopped — health is not checked |

## Remediation

When an HAProxy instance shows **Needs Remediation**, its configuration has drifted from the expected state (e.g., missing frontends, stale backends, or incorrect routing rules).

Click **Remediate** to open the remediation dialog, which shows a preview of the changes that will be applied. Review the proposed fixes and confirm to resync the HAProxy configuration.

## Migration to stack-managed

Environments that were created before the stacks feature show a **Needs Migration** badge. These use the older HAProxy deployment method and should be migrated to stack-managed HAProxy for better reliability and consistency.

Click **Migrate to Stack** to open the migration dialog. The dialog walks through the migration steps:

1. Preview of what will change
2. Confirmation to proceed
3. Execution with step-by-step progress
4. Results summary showing success or any errors

Migration converts the environment's HAProxy from the older service-based deployment to a stack-managed deployment. Existing frontends, backends, and routes are preserved.

## What to watch out for

- Stopped environments show dashes for all health and count columns — HAProxy health is only checked for running environments.
- If no environments have HAProxy configured, the page shows an empty state with a link to the environments list.
- Remediation applies changes to the live HAProxy configuration immediately. Traffic routing may briefly change during remediation.
- Migration is a one-way operation — once an environment is migrated to stack-managed HAProxy, it cannot be reverted to the previous model.
