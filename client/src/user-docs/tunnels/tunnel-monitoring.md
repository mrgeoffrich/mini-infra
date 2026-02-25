---
title: Tunnel Monitoring
description: What the Cloudflare Tunnels page shows, how tunnel status works, and how to manage public hostnames.
category: Tunnels
order: 1
tags:
  - cloudflare
  - tunnels
  - monitoring
  - hostnames
  - networking
---

# Tunnel Monitoring

The Cloudflare Tunnels page shows the status of tunnels that expose your services to the internet through Cloudflare's network.

## How tunnels work

Cloudflare Tunnels create an outbound connection from your infrastructure to Cloudflare's edge. Traffic from the internet flows through Cloudflare to your tunnel, then to the backend service — without opening inbound ports on your firewall. Mini Infra connects to the Cloudflare API to read tunnel status and manage public hostname routes.

## What you need

Before the tunnels page shows anything, you need to configure Cloudflare credentials:

- Go to **Cloudflare** under Connected Services.
- Enter your Cloudflare API Token and Account ID.
- Click **Validate** to test the connection.

If Cloudflare isn't configured, the tunnels page shows a **Configure Cloudflare** button that links to the settings page.

## The tunnels page

Navigate to **Cloudflare Tunnels** in the sidebar. The page lists every tunnel associated with your Cloudflare account. Each tunnel shows:

- **Status indicator** — A coloured dot showing health: green (healthy), yellow (degraded), grey (inactive), or red (down).
- **Tunnel name** — The name assigned when the tunnel was created in Cloudflare.
- **Active connections** — How many connector instances are currently connected.
- **Status badge** — Text label matching the indicator colour.

Click a tunnel to expand its details.

## Tunnel details

The expanded view shows:

- **Tunnel ID** — The unique identifier from Cloudflare.
- **Created** — When the tunnel was first created.
- **Active Connections** — Count of live connections, with details for each: client version, origin IP, and whether it's the primary connection.
- **Configuration version** and source.

## Public hostnames

Each tunnel can have public hostnames that route internet traffic to backend services. The expanded tunnel view lists all configured hostnames and provides management controls:

### Viewing hostnames

Each hostname entry shows:

- The public hostname (e.g. `app.example.com`).
- The backend service URL the hostname routes to (e.g. `http://localhost:8080`).
- An optional path pattern for path-based routing.

Wildcard hostnames (like `*.example.com`) are marked with a badge.

If the tunnel has a catch-all rule (a route with no specific hostname), it appears at the bottom of the list.

### Adding a hostname

Click **Add Hostname** in the tunnel's hostname section. Enter:

- **Hostname** — The public domain to route. Supports wildcards.
- **Backend Service URL** — Where traffic should be forwarded to.
- **Path Pattern** — Optional. Restricts the route to a specific path prefix.

The hostname is created via the Cloudflare API and appears in the list immediately.

### Removing a hostname

Click the delete button next to any hostname. A confirmation dialog appears before the hostname is removed from the tunnel configuration.

## What to watch out for

- Tunnel status reflects Cloudflare's view of the connection, not the health of the services behind it. A "healthy" tunnel means the connector is connected to Cloudflare, not that your backend is responding correctly.
- Mini Infra reads and manages tunnel configuration through the Cloudflare API. If you modify tunnels directly in the Cloudflare dashboard, the changes appear here after a refresh.
- Removing a hostname from a tunnel stops routing traffic for that domain. Existing DNS records in Cloudflare may still point to the tunnel — you may need to clean those up separately.
- The number of active connections depends on how many `cloudflared` connector instances are running. A single connection is normal for most setups; multiple connections indicate redundancy.
