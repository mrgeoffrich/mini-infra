---
title: Deployment Lifecycle
description: What happens during a deployment from image pull to traffic switch, and how rollback works.
category: Deployments
order: 3
tags:
  - deployments
  - lifecycle
  - blue-green
  - rollback
  - haproxy
  - health-checks
  - progress
---

# Deployment Lifecycle

This page covers what happens from the moment you click Deploy to the point where your new container is serving traffic.

## Initial deployment steps

The first deployment of an application follows this sequence:

1. **Pull Docker image** — Downloads the image from the configured registry. If using a private registry, credentials from Registry Credentials settings are used automatically.
2. **Create container** — Creates a Docker container with the configured environment variables, volume mounts, and network settings.
3. **Start container** — Starts the container and waits for it to reach a running state.
4. **Register with HAProxy** — Adds the container as a backend server in HAProxy using the container's internal IP address.
5. **Health check** — Sends HTTP requests to the configured health endpoint. Retries according to the retry and interval settings until the check passes or all retries are exhausted.
6. **Configure frontend** — If a hostname is configured, creates an HAProxy frontend with hostname-based routing.
7. **Configure DNS** — If Cloudflare is connected and a hostname is set, creates or updates the DNS record.
8. **Enable traffic** — Opens the HAProxy route so incoming requests reach the container.

## Blue-green deployment steps

Subsequent deployments add traffic draining and old container cleanup:

1. **Pull Docker image** — Same as initial.
2. **Create green container** — The new container is created alongside the existing (blue) one.
3. **Start green container** — Both containers are now running.
4. **Register green with HAProxy** — The new container is added as a backend server, but doesn't receive traffic yet.
5. **Health check green** — Validates the new container is responding correctly.
6. **Configure frontend** — Updates HAProxy routing to point to the green container.
7. **Configure DNS** — Updates DNS if needed.
8. **Switch traffic** — HAProxy begins sending new requests to the green container. This is the zero-downtime moment — the switch is instant from the client's perspective.
9. **Drain blue** — HAProxy stops sending new connections to the old container while allowing in-flight requests to complete.
10. **Monitor drain** — Waits for all active connections on the blue container to finish.
11. **Remove blue from HAProxy** — Unregisters the old container from the load balancer.
12. **Stop blue container** — Stops the old container.
13. **Remove blue container** — Deletes the old container.
14. **Cleanup** — Marks the deployment as complete.

## Monitoring progress

While a deployment is running, the deployment detail page shows real-time progress:

- **Status text** — The current phase (Deploying, Health Checking, Switching Traffic, etc.).
- **Progress bar** — Visual progress with percentage.
- **Step list** — Each step shows its status (pending, running, completed, or failed) with timestamps and duration.
- **Error details** — If a step fails, the error message appears inline.
- **Logs** — A scrollable terminal-style log showing all deployment messages as they happen.

The deployments list page also shows the latest deployment status for each configuration, with active deployments polling every 5 seconds for updates.

## Rollback

Rollback can happen automatically or manually.

### Automatic rollback

If a health check fails during a blue-green deployment, the system automatically rolls back:

1. Traffic is restored to the blue (old) container.
2. The green (new) container's traffic is disabled.
3. HAProxy configuration for the green container is removed.
4. The green container is stopped and removed.
5. The deployment is marked as "rolled back".

The blue container continues serving traffic as if nothing happened.

### Manual rollback

While a deployment is in progress (during the deploying, health checking, or switching traffic phases), a **Rollback** button appears on the deployment detail page. Clicking it triggers the same rollback sequence as an automatic rollback.

The rollback button is disabled once the deployment completes successfully, since the old container has already been removed.

## Deployment states

A deployment moves through these states:

| State | Meaning |
|-------|---------|
| **Pending** | Queued, waiting to start |
| **Preparing** | Setting up the environment context |
| **Deploying** | Pulling image, creating and starting the container |
| **Health Checking** | Running health checks against the new container |
| **Switching Traffic** | Reconfiguring HAProxy to route to the new container |
| **Cleanup** | Draining and removing the old container |
| **Completed** | Deployment finished successfully |
| **Failed** | Something went wrong; check the error details |
| **Rolling Back** | Reverting to the previous container |
| **Rolled Back** | Rollback completed, old container is serving traffic again |

## What to watch out for

- During a blue-green deployment, both containers are running simultaneously. Make sure the host has enough resources (memory, CPU) for two instances of your application.
- The drain phase waits for active connections to finish. Long-lived connections (like WebSockets) may delay the cleanup step.
- If a deployment fails after traffic has switched but before the old container is removed, you may end up with both containers running. Use **Remove Deployment** to clean up.
- Rollback is only possible during a deployment. Once a deployment completes and the old container is removed, the only way to go back is to deploy the previous image tag.
