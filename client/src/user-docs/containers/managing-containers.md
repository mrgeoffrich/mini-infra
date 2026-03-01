---
title: Managing a Container
description: How to view details, run actions, and inspect a specific container.
category: Containers
order: 2
tags:
  - containers
  - docker
  - configuration
---

# Managing a Container

Click any container name in the container list to open its **detail page** at `/containers/:id`. The detail page gives you full information about a single container and lets you control its lifecycle.

## Container information

The top of the page shows:

- Container **name** and **ID**
- Current **status badge**

Below that, a two-column card displays:

| Field | Description |
|-------|-------------|
| **Image** | Full image name and tag |
| **IP Address** | Container's IP on its Docker network, or `N/A` |
| **Created** | Date and time the container was created |
| **Started** | Date and time the container last started |
| **Ports** | All port mappings in `host:container/protocol` format |
| **Environment** | Associated environment (if any) |
| **Deployment** | Associated deployment configuration and container role (if any) |

## Action buttons

The top-right of the page has action buttons to control the container:

| Button | Available when | Effect |
|--------|---------------|--------|
| **Start** | Container is stopped or exited | Starts the container |
| **Stop** | Container is running | Stops the container gracefully |
| **Restart** | Any state | Restarts the container |
| **Delete** | Container is stopped or exited | Permanently removes the container |

Buttons show a loading spinner while the action is in progress and disable themselves to prevent double-clicks.

## Volumes

If the container has mounted volumes, a **Volumes** card appears below the container info. Each volume shows:

- **Source** path (on the host)
- **Destination** path (inside the container)
- **Mode** badge: `Read/Write` or `Read Only`

## Container logs

The bottom of the page embeds a log viewer showing the container's standard output and error streams. See [Viewing Container Logs](/containers/container-logs) for details on using the log viewer.

## What to watch out for

- **Delete is permanent.** Removing a container deletes it from Docker; any data stored inside the container's writable layer is lost. Persistent data in named volumes is not affected.
- You can only delete a container that is **stopped or exited**. Stop it first if it is running.
- If the container is managed by a deployment, stopping or deleting it outside of the deployment workflow may cause the deployment to show an inconsistent state. Use the deployment's **Remove** action instead.
