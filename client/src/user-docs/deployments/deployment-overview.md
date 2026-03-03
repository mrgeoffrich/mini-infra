---
title: Deployments Overview
description: An overview of how zero-downtime deployments work in Mini Infra.
category: Deployments
order: 1
tags:
  - deployments
  - docker
  - blue-green
  - haproxy
---

# Deployments Overview

Mini Infra's deployment system lets you deploy Docker containers to your host with zero downtime using a blue-green strategy. Each deployment replaces the old container only after the new one passes health checks, then routes traffic to the new container through HAProxy.

## How deployments work

A **deployment configuration** defines what to deploy and how to deploy it:

- Which Docker image and tag to use
- Which **environment** the application belongs to (production, staging, etc.)
- How to perform a **health check** on the new container before switching traffic
- Whether to **automatically roll back** if the health check fails
- The public **hostname** the application is reachable at

When you trigger a deployment, Mini Infra runs these steps in order:

1. **Pull Docker Image** — pulls the configured image and tag
2. **Create Container** — creates a new container alongside the existing one
3. **Start Container** — starts the new container
4. **Health Check** — polls the health check endpoint until it passes or times out
5. **Switch Traffic** — updates HAProxy to route traffic to the new container
6. **Cleanup Old Container** — stops and removes the previous container

If any step fails (and automatic rollback is enabled), Mini Infra rolls back by removing the new container and keeping the old one in service.

## The Deployments page

Go to [/deployments](/deployments) to see all deployment configurations. The page shows:

| Column | Description |
|--------|-------------|
| **Application Name** | Name of the deployed application |
| **Environment** | Environment the application runs in |
| **Docker Image** | Configured image and tag |
| **Status** | Whether the configuration is Active or Inactive |
| **Last Deployment** | Status and timestamp of the most recent deployment |

## Deployment status values

| Status | Color | Meaning |
|--------|-------|---------|
| `completed` | Green | Deployment finished successfully |
| `failed` | Red | Deployment failed; review logs |
| `rolling_back` | Orange | Automatic rollback in progress |
| `rolledback` | Orange | Rollback completed |
| `pending` | Yellow | Deployment queued |
| `preparing` | Yellow | Setting up before pulling image |
| `deploying` | Blue | Pulling image or creating container |
| `health_checking` | Blue | Waiting for health check to pass |
| `switching_traffic` | Blue | Updating HAProxy routing |
| `uninstalled` | Gray | Application removed from HAProxy |

## Actions on a deployment configuration

From the deployments list you can:

- **Deploy** — trigger a new deployment immediately
- **New** — trigger a new deployment when the last one completed successfully
- **Remove** — stop and remove the currently running containers (only available if a deployment is complete and containers are running)
- **View Details** — open the deployment detail page
- **Edit Configuration** — change the Docker image, health check, or rollback settings
- **Delete Configuration** — remove the configuration entirely (only if no containers are running)

## What to watch out for

- You need a running **HAProxy environment** and **HAProxy frontend** for traffic switching to work. If HAProxy is not configured, the deployment will create and start the container but traffic routing will not be set up.
- The **environment** for a deployment configuration **cannot be changed** after creation.
- Deleting a configuration while containers are running is blocked. Remove the deployment first, then delete the configuration.
