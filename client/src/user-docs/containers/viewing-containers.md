---
title: Viewing and Filtering Containers
description: How to view, search, and filter Docker containers in Mini Infra.
tags:
  - containers
  - docker
  - monitoring
---

# Viewing and Filtering Containers

The **Containers** page at `/containers` gives you a real-time view of all Docker containers on your host. Data refreshes automatically every 5 seconds.

## Page layout

The Containers page has three tabs:

| Tab | Contents |
|-----|---------|
| **Containers** | List of all Docker containers with status, image, and ports |
| **Networks** | Docker networks with connected container counts |
| **Volumes** | Docker volumes with mount points and usage status |

## Container table

Each row in the container table shows:

| Column | Description |
|--------|-------------|
| **Container Name** | The name of the container |
| **Status** | Current runtime status (see Status values below) |
| **Image** | Docker image name and tag |
| **Ports** | Published port mappings (hover for full list if more than 3) |
| **Actions** | Context-specific actions (e.g., Manage for PostgreSQL containers) |

## Status values

| Status | Color | Meaning |
|--------|-------|---------|
| `Running` | Green | Container is active and executing |
| `Stopped` | Gray | Container was stopped cleanly |
| `Exited` | Red | Container exited (check exit code for errors) |
| `Paused` | Yellow | Container processes are suspended |
| `Restarting` | Blue | Container is in a restart loop |

## Filtering and searching

Use the filter bar above the table to narrow down the container list:

- **Search by container name** — type to filter by name
- **Search by image name** — type to filter by Docker image
- **Status filter** — dropdown: All Statuses, Running, Stopped, Exited, Paused, Restarting
- **Deployment filter** — dropdown: All Containers, Deployment-managed, Not managed
- **Sort by** — sort by name, status, creation time, or image name (ascending or descending)

To clear all active filters, click the **Reset** button (appears when any filter is active). Active filters are shown as chips above the table.

## Container groups

Containers are grouped in the table:

- **Managed Postgres Servers** — PostgreSQL containers that have been added to Mini Infra's postgres management
- **Environment name** — containers belonging to a named environment (production, staging, etc.)
- **Unmanaged** — containers not associated with any environment

Environment groups show a badge indicating the environment type (red for production, blue for others) and a container count.

## Networks tab

The Networks tab lists all Docker networks with:

- **Name** — network name
- **Driver** — Docker network driver (bridge, overlay, host, etc.)
- **Scope** — local or swarm
- **Containers** — count of connected containers and their names
- **Subnet** — IP subnet in CIDR notation

You can delete networks that have no connected containers and are not system networks (bridge, host, none). A confirmation dialog appears before deletion.

## Volumes tab

The Volumes tab lists all Docker volumes with:

- **Name** — volume name
- **Driver** — Docker volume driver
- **Mount Point** — path on the host filesystem
- **Size** — disk usage (if inspected)
- **In Use** — whether any container is currently using the volume

You can **Inspect** a volume to load its size and file details, **View** its file listing, or **Delete** it if it has no connected containers.

## What to watch out for

- Deleting a network or volume is **permanent and cannot be undone**.
- Volumes in use cannot be deleted until all containers using them are stopped and removed.
- System networks (`bridge`, `host`, `none`) cannot be deleted.
- Container data refreshes every 5 seconds automatically; the filter state is preserved between refreshes.
