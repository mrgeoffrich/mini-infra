---
title: Container Actions Reference
description: Reference for all actions you can perform on Docker containers in Mini Infra.
category: Containers
order: 5
tags:
  - containers
  - docker
  - configuration
---

# Container Actions Reference

Mini Infra exposes lifecycle actions for individual containers from the container detail page at `/containers/:id`. This article describes each action, its preconditions, and its effect.

## Available actions

| Action | Button label | Available when | Effect |
|--------|-------------|---------------|--------|
| **Start** | Start | Stopped or Exited | Starts the container using `docker start` |
| **Stop** | Stop | Running | Sends `SIGTERM` to the container, then `SIGKILL` after the stop timeout |
| **Restart** | Restart | Any state | Equivalent to stop then start |
| **Delete** | Delete | Stopped or Exited | Removes the container from Docker (`docker rm`) |

## Container states after each action

| Starting state | Action | Resulting state |
|---------------|--------|----------------|
| Stopped / Exited | Start | Running |
| Running | Stop | Stopped or Exited |
| Any | Restart | Running (briefly Restarting) |
| Stopped / Exited | Delete | Container no longer exists |

## PostgreSQL container actions

Containers identified as PostgreSQL servers have an additional action in the containers **list** (not the detail page):

- **Add** — links the unmanaged PostgreSQL container to Mini Infra's postgres management. After clicking, you complete the database connection form.
- **Manage** — navigates to the PostgreSQL server detail page for a container that is already managed.

## What to watch out for

- **Delete is irreversible.** Any data stored in the container's writable layer is lost permanently. Named volumes attached to the container are unaffected, but the container definition is removed.
- **Restart does not recreate the container.** It uses the existing container definition (same image, same config). To deploy a new image version, use a Deployment instead.
- Actions are disabled while another action is in progress on the same container. Wait for the current action to complete before triggering another.
- If a container is managed by a Mini Infra deployment, controlling it directly (stop, delete) may cause the deployment to show an inconsistent state. Use the deployment's **Remove** action to safely take containers out of service.
