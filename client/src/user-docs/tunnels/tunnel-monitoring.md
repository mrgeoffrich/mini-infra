---
title: Monitoring Cloudflare Tunnels
description: How to monitor Cloudflare tunnel health and manage hostnames in Mini Infra.
category: Tunnels
order: 1
tags:
  - tunnels
  - cloudflare
  - monitoring
  - dns
---

# Monitoring Cloudflare Tunnels

The **Cloudflare Tunnels** page at [/tunnels](/tunnels) shows the health and configuration of your Cloudflare tunnels, their active connections, and their public hostname routing rules.

## Prerequisites

Cloudflare must be configured before tunnel data is available. Go to [Connected Services → Cloudflare](/connectivity-cloudflare) to enter your API token and Account ID.

## Tunnel list

Each tunnel appears as an expandable row. The collapsed view shows:

- **Status indicator dot** — colored by tunnel health
- **Tunnel name**
- **Connection count** — number of active connections
- **Status badge**

### Tunnel status values

| Status | Dot color | Meaning |
|--------|-----------|---------|
| `healthy` | Green | Tunnel is connected and all connections are healthy |
| `degraded` | Yellow | Tunnel is connected but some connections are unhealthy |
| `inactive` | Gray | Tunnel has no active connections |
| `down` | Red | Tunnel is not connected |

## Tunnel details (expanded)

Click a tunnel row to expand it and see:

- **Tunnel ID** — unique identifier (monospace)
- **Created** — creation date of the tunnel
- **Active Connections** — count with details for each connection
- **Public Hostnames & Services** — routing rules mapping hostnames to backend services
- **Catch-All Rule** — default backend service if no hostname matches
- **Configuration version** and source

## Managing public hostnames

From the expanded tunnel view, click **Add Hostname** (plus icon) to add a new public hostname routing rule.

### Add Hostname dialog

| Field | Required | Description |
|-------|----------|-------------|
| **Hostname** | Yes | Domain name to expose (e.g., `app.example.com` or `*.example.com` for wildcards) |
| **Backend Service** | Yes | URL or `address:port` of the backend service (e.g., `http://localhost:3000`) |
| **Path Pattern** | No | Optional path filter (e.g., `/api/*`) |

Click **Add Hostname** to create the routing rule.

To delete a hostname routing rule, click the **trash icon** on its row in the expanded tunnel view.

## Refreshing tunnel data

Click **Refresh** in the tunnel list card header to reload the latest tunnel data from Cloudflare.

## Configuring Cloudflare settings

Click **Configure Cloudflare** in the page header to navigate to the Cloudflare settings page where you can update your API token and Account ID.

## What to watch out for

- Tunnel monitoring is **read-only except for hostname management**. You cannot create or delete tunnels from Mini Infra — those operations are done in the Cloudflare dashboard.
- Wildcard hostnames (`*.example.com`) match any subdomain but require your domain to have the wildcard DNS record pointing to the tunnel.
- Deleting a hostname routing rule removes it from the tunnel configuration immediately and traffic to that hostname will stop being routed to the backend service.
- If Cloudflare is not connected, the Tunnels page will show a configuration prompt instead of tunnel data.
