---
title: Managing HAProxy Backends
description: How to view and configure HAProxy backends in Mini Infra.
category: Deployments
order: 6
tags:
  - haproxy
  - deployments
  - networking
  - configuration
---

# Managing HAProxy Backends

HAProxy backends define the pool of servers that receive traffic from frontends. Mini Infra manages backends at [/haproxy/backends](/haproxy/backends).

## Backends list

The backends list at `/haproxy/backends` shows:

| Column | Description |
|--------|-------------|
| **Name** | Backend name (monospace) |
| **Environment** | Environment this backend belongs to |
| **Servers** | Number of server instances in the backend pool (green badge if > 0) |
| **Balance** | Load balancing algorithm (e.g., `roundrobin`) |
| **Source** | Whether the backend was created by a deployment or manually |
| **Status** | Current state of the backend |

### Filter options

- **Environment** — filter by environment name
- **Status** — All Statuses, Active, Removed, Failed
- **Source Type** — All Sources, Deployment, Manual
- **Search** — text search by backend name

### Status values

| Status | Color | Meaning |
|--------|-------|---------|
| `active` | Green | Backend is configured and healthy |
| `failed` | Red | Backend encountered a configuration error |

### Source types

| Source | Icon | Description |
|--------|------|-------------|
| **Deployment** | Rocket icon | Managed automatically by a deployment configuration |
| **Manual** | Settings icon | Manually configured |

## Backend detail page

Click a backend to open its detail page at `/haproxy/backends/:backendName`. The page shows:

- **Name** (monospace), **source badge**, and **status badge**
- **Overview** — environment link, source type, deployment config link (if applicable), created and updated timestamps, error message (if failed)
- **Configuration** — load balancing mode and algorithm, check/connect/server timeouts
- **Servers** — list of server instances in the pool

## Configuration fields

| Field | Description |
|-------|-------------|
| **Mode** | Protocol mode (e.g., `http`) |
| **Balance Algorithm** | How traffic is distributed across servers (e.g., `roundrobin`, `leastconn`) |
| **Check Timeout** | Timeout for health check connections |
| **Connect Timeout** | Timeout for establishing connections to backend servers |
| **Server Timeout** | Timeout for responses from backend servers |

Click **Edit Configuration** on the detail page to update these settings.

## Backends created by deployments

Most backends are created automatically when a deployment configuration has a hostname and HAProxy is set up. These backends are labeled **Deployment** source and contain the containers managed by that deployment. They are updated automatically during deployments (blue-green switch).

## What to watch out for

- Deployment-managed backends are controlled by the deployment lifecycle. Editing them manually may cause conflicts when the next deployment runs.
- A backend with zero servers (`Servers: 0`) will cause HAProxy to return a 503 error for requests routed to it. This can happen briefly during a deployment while traffic is switching.
- Removing a backend that is still referenced by a frontend will cause routing errors. Remove or update the frontend first.
