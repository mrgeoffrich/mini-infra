---
title: Managing Containers
description: Learn how to view, start, stop, and inspect Docker containers in Mini Infra.
category: Getting Started
order: 2
tags:
  - docker
  - containers
  - getting-started
---

# Managing Containers

Mini Infra gives you a unified view of all Docker containers running on your host. From the Containers page you can monitor status, manage lifecycle operations, and drill into container details including logs, environment variables, and volume mounts.

## Viewing Containers

Navigate to **Containers** in the sidebar. The page opens on the **Containers** tab, which displays a table of every container Docker knows about — including stopped containers.

Each row shows:

| Column | Description |
|--------|-------------|
| Name | The container name as assigned by Docker |
| Image | The image and tag the container was started from |
| Status | Running, Exited, Paused, or Restarting |
| Uptime | How long the container has been in its current state |
| Ports | Published port mappings |

Use the search box to filter by name or image. Use the **Status** dropdown to show only running or only stopped containers.

## Starting and Stopping Containers

Click the three-dot menu on any container row to reveal lifecycle actions:

- **Start** — starts a stopped container
- **Stop** — sends `SIGTERM` then `SIGKILL` after a grace period
- **Restart** — equivalent to stop + start
- **Remove** — removes the container (not the image)

> **Note**: Remove is irreversible. Any data stored inside the container filesystem (not in a named volume) will be lost.

## Inspecting a Container

Click the container **Name** or choose **View Details** from the row menu to open the container detail page. This page is divided into sections:

### Overview

Shows the full container metadata: image digest, creation time, restart policy, network mode, and entry point command.

### Logs

The **Logs** tab streams recent output from the container's stdout and stderr. You can:

- Toggle timestamps on each log line
- Filter log output using the search box (supports plain text)
- Set the number of lines to tail (50, 100, 500)

Logs update in real time using a server-sent events (SSE) connection.

### Environment Variables

Lists all environment variables passed to the container at start time. Values are shown in plain text — take care when sharing screenshots.

### Volumes

Shows all volume mounts attached to the container. Click **Inspect** on any named volume to browse its contents.

## Networks and Volumes Tabs

The Containers page also includes **Networks** and **Volumes** tabs in the top tab bar.

- **Networks** lists all Docker networks, their driver, scope, and which containers are attached
- **Volumes** lists all named volumes with size, creation time, and which containers reference them

## Filtering and Sorting

The container table supports column sorting. Click any column header to sort ascending; click again to sort descending. Sort state persists for the duration of your session.

The **Status** filter is additive with the search box — you can combine `status=running` with a search term to find running containers by name.

## Refreshing Data

Data is fetched from the Docker API when you load the page and refreshed every 30 seconds automatically. Click the **Refresh** button in the top-right of the table to force an immediate update.
