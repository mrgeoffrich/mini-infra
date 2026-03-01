---
title: Deployment Lifecycle
description: A step-by-step guide to what happens during a deployment in Mini Infra.
category: Deployments
order: 3
tags:
  - deployments
  - docker
  - blue-green
  - health-checks
  - haproxy
---

# Deployment Lifecycle

When you trigger a deployment in Mini Infra, it runs through a series of steps to replace your running container with a new one without dropping any incoming traffic.

## Triggering a deployment

Click **Deploy** on a deployment configuration row, or click **New** if the previous deployment completed successfully. The deployment starts immediately and a progress panel tracks it in real time.

## Deployment steps

| Step | Description |
|------|-------------|
| **Pull Docker Image** | Downloads the configured image and tag from the registry |
| **Create Container** | Creates a new container alongside the current one (if any) |
| **Start Container** | Starts the new container |
| **Health Check** | Polls the health check endpoint until it passes or the max wait time is reached |
| **Switch Traffic** | Updates the HAProxy frontend to route traffic to the new container |
| **Cleanup Old Container** | Stops and removes the previous container |

Each step shows its status, duration, and any error messages in the progress panel.

## Progress tracking

The deployment detail page at `/deployments/:id` shows:

- **Overall progress bar** — colored by status (blue for in progress, green for complete, red for failed, orange for rolling back)
- **Step list** — each step with its status badge, timing, and expandable log output
- **Metrics** — total duration and traffic downtime
- **Real-time logs** — a live log stream from the deployment process

## Rollback

If the health check fails and automatic rollback is enabled (the default), Mini Infra runs a **Rollback** step:

1. Removes the new container
2. Leaves the old container running and in service in HAProxy
3. Marks the deployment as `rolledback`

If the deployment is still in progress (in the `deploying`, `health_checking`, `switching_traffic`, or `failed` states), you can trigger a manual rollback by clicking the **Rollback** button on the deployment detail page.

## Status progression

```
pending → preparing → deploying → health_checking → switching_traffic → cleanup → completed
                                                    ↓ (if health check fails)
                                               rolling_back → rolledback
```

## After a successful deployment

- The new container is running and serving traffic.
- The old container has been removed (unless **Keep Old Container** was enabled).
- The **Last Deployment** column on the deployments list shows `completed` in green.
- A **New** button appears on the configuration row to trigger another deployment.

## DNS configuration

If the deployment has a **hostname** configured, the detail page shows a **DNS Configuration** section that tracks DNS record status for each hostname. DNS status values:

| Status | Meaning |
|--------|---------|
| `active` | DNS record is resolving correctly |
| `pending` | Record has been created but not yet propagated |
| `failed` | Record creation or update failed |
| `removed` | Record was deleted |

## What to watch out for

- **Health check timeouts** are the most common cause of deployment failures. If the new container takes longer than the configured timeout to become ready, the deployment fails and rolls back.
- Traffic downtime should be near zero, but it is not guaranteed to be exactly zero. A small number of in-flight requests during the HAProxy switch may be dropped.
- If HAProxy is not configured, the deployment creates and starts the container but traffic routing does not occur. The deployment will still show as `completed` but no external traffic will reach the container.
- Deployments cannot be paused — once started, they run to completion or failure.
