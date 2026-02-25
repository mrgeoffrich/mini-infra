---
title: Viewing Containers
description: How the container list works, what each column means, and how to filter and sort.
category: Containers
order: 2
tags:
  - containers
  - docker
  - filtering
  - sorting
  - status
---

# Viewing Containers

The Containers page shows every container on your Docker host — running, stopped, and paused. Navigate to **Containers** in the sidebar to open it.

## How it works

Mini Infra queries the Docker daemon directly through the Docker socket. The container list reflects the actual state of Docker on the host, not a cached copy. Data refreshes automatically every 30 seconds, and you can force an immediate refresh with the **Refresh** button in the top-right corner of the table.

## The container table

The main **Containers** tab displays a paginated table with up to 50 containers per page. Each row shows:

| Column | What it shows |
|--------|--------------|
| **Name** | The container name as assigned by Docker or the compose project |
| **Status** | A coloured badge — green for Running, red for Exited, yellow for Paused, blue for Restarting |
| **Image** | The image name and tag the container was started from |
| **Ports** | Published port mappings (e.g. `8080:3000/tcp`). If a container publishes more than two ports, a popover shows the full list |

Click any container name to open its detail page.

## Filtering

Two filters work together to narrow the list:

- **Search box** — Filters by container name or image name. Type part of a name and the table updates immediately.
- **Status dropdown** — Show only containers in a specific state (running, stopped, etc.).

These filters are additive. You can search for `api` with the status set to `running` to find only running containers with "api" in the name or image.

## Sorting

Click any column header to sort the table by that column. Click the same header again to reverse the sort direction. The current sort state persists for the duration of your browser session.

## Pagination

When you have more than 50 containers, pagination controls appear at the bottom of the table. The display shows which range of containers you're viewing (e.g. "Showing 1 to 50 of 73 containers").

## Networks and Volumes tabs

The Containers page has two additional tabs alongside the main container list:

- **Networks** — Lists all Docker networks with their driver type, scope, and which containers are attached to each.
- **Volumes** — Lists all named Docker volumes with their size, creation time, and which containers reference them.

## Auto-refresh

The container list fetches fresh data from Docker every 30 seconds. The refresh happens in the background without disrupting your current scroll position or filter state. To refresh immediately, click the **Refresh** button.

## What to watch out for

- Containers created outside Mini Infra (via `docker run` or `docker compose`) still appear in the list. Mini Infra sees everything Docker sees.
- The status shown is the Docker-reported state. A container showing as "Running" might still be unhealthy at the application level if its health check is failing.
- Port mappings only show published ports. Containers using host networking or exposing ports without publishing them won't display port information.
