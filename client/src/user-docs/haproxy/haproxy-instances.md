---
title: HAProxy Instances
category: haproxy
order: 4
description: How to monitor HAProxy health across environments and remediate or migrate instances in Mini Infra
tags:
  - haproxy
  - instances
  - health
  - remediation
  - migration
---

# HAProxy Instances

The Instances page shows the health status of every HAProxy instance across your environments. Use it to monitor health, trigger a full remediation, or migrate legacy instances to stack management.

## Instance Health

Each instance shows one of four health states:

| State | Description |
|-------|-------------|
| Healthy | HAProxy configuration is in sync with the database |
| Needs Remediation | Configuration has drifted and should be rebuilt |
| Needs Migration | Legacy instance that should be migrated to stack management |
| Unavailable | Could not fetch status (check Docker connectivity) |

The table also shows the environment type (Production or Staging), the number of shared frontends, and the total route count.

## Remediation

When an instance shows **Needs Remediation** (or even if it is healthy and you want to force a rebuild), click **Remediate** to open the remediation dialog.

The dialog shows:

1. **Preview** --- Current configuration and the planned changes including frontends to create, routes to add, and backends to recreate.
2. **Warning** --- Traffic may be briefly disrupted during the rebuild.
3. **Progress** --- Each rebuild step is shown in real time with its completion status.

Remediation rebuilds the full HAProxy runtime state from the database, restoring TLS certificates, frontends, backends, and routing rules.

## Migration

Legacy HAProxy instances that were created before stack management was available show **Needs Migration**. Click **Migrate to Stack** to open the migration dialog.

Migration performs these steps:

1. Remove the legacy HAProxy container.
2. Remove legacy volumes.
3. Deploy a new HAProxy instance via the stack system.
4. Reuse the existing network.
5. Recreate all backends and servers.
6. Redeploy TLS certificates.
7. Configure shared frontends and routes.

A downtime warning is displayed because traffic will be interrupted during migration. Progress is tracked in real time via the task tracker.
