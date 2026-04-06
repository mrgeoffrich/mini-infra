---
title: Managing HAProxy Backends
description: How to view and configure HAProxy backends and servers in Mini Infra
tags:
  - haproxy
  - backends
  - load-balancer
  - servers
---

# Managing HAProxy Backends

A backend is a group of servers that receive traffic forwarded by an HAProxy frontend. The Backends page shows all backend server groups across your environments.

## Viewing Backends

The backends table displays each backend's name, environment, server count, load-balancing algorithm, source type, and status. Use the filters to narrow the list:

- **Environment** --- Show backends from a specific environment.
- **Status** --- Filter by Active, Failed, or Removed.
- **Source Type** --- Filter by Deployment (auto-managed) or Manual (user-created).
- **Search** --- Search by backend name.

Click any row to open the backend details page.

## Backend Details

The details page has three sections:

### Overview

Shows the backend name, environment, source type, status, timestamps, and any error messages.

### Configuration

Displays and allows editing of:

- **Balance Algorithm** --- How traffic is distributed across servers:
  - **Round Robin** --- Requests are distributed evenly in order.
  - **Least Connections** --- Requests go to the server with the fewest active connections.
  - **Source** --- Requests from the same client IP always go to the same server.
- **Check Timeout** --- How long to wait for a health check response (milliseconds).
- **Connect Timeout** --- How long to wait when establishing a connection to a server (milliseconds).
- **Server Timeout** --- How long to wait for a response from a server (milliseconds).

Click **Edit Configuration** to change these values.

### Servers

Lists all servers in the backend with their address, port, weight, health check configuration, status, maintenance mode, and enabled state.

Each server can be edited individually:

- **Weight** (0--256) --- Controls how much traffic this server receives relative to others.
- **Enabled** --- Whether the server accepts new traffic.
- **Maintenance Mode** --- Puts the server in maintenance, draining existing connections.
- **Health Check Path** --- The HTTP path used for health checks.
- **Health Check Interval** --- How often health checks run (milliseconds).
- **Rise** --- Number of consecutive successful checks before marking the server as up.
- **Fall** --- Number of consecutive failed checks before marking the server as down.

Weight, enabled, and maintenance changes are applied to HAProxy immediately. Health check changes are applied on the next sync.

## Server Statuses

| Status | Description |
|--------|-------------|
| Active | Server is healthy and receiving traffic |
| Draining | Server is in maintenance mode, existing connections are being drained |
| Removed | Server has been removed from the backend |
