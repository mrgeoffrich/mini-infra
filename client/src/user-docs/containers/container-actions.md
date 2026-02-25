---
title: Container Actions
description: What Start, Stop, Restart, and Remove do at the Docker level.
category: Containers
order: 2
tags:
  - containers
  - docker
  - start
  - stop
  - restart
  - remove
---

# Container Actions

Mini Infra exposes four lifecycle actions for Docker containers: Start, Stop, Restart, and Remove. Each maps directly to a Docker API operation.

## How to access actions

Actions are available in two places:

- **Container list** — Click the three-dot menu on any container row.
- **Container detail page** — Action buttons appear in the header next to the container name.

Buttons are enabled or disabled based on the container's current state. You can't start a container that's already running, and you can't remove a container that's still running.

## Start

Starts a stopped container using its existing configuration (image, environment variables, volumes, network settings). This is the equivalent of `docker start`.

The container resumes with the same filesystem state it had when it was stopped. Any data written inside the container (not in a volume) is preserved from the previous run.

## Stop

Sends `SIGTERM` to the container's main process, giving it 10 seconds to shut down gracefully. If the process doesn't exit within that window, Docker sends `SIGKILL` to force termination.

This matches the behaviour of `docker stop` with the default timeout.

## Restart

Performs a stop followed by a start. The container goes through the full shutdown sequence (SIGTERM, grace period, SIGKILL if needed) before starting again.

Use restart when you need a container to pick up configuration changes or recover from a stuck state.

## Remove

Deletes the container entirely. This is equivalent to `docker rm` and is irreversible.

Remove is only available when the container is stopped. You must stop a running container before you can remove it.

**What gets deleted:**

- The container's writable filesystem layer (any files created or modified inside the container that aren't in a volume).
- The container's metadata and configuration.

**What is preserved:**

- Named volumes attached to the container remain intact. They can be reattached to a new container.
- The Docker image the container was based on is not removed.

## PostgreSQL container integration

Mini Infra automatically detects containers running PostgreSQL images. These containers show additional buttons in the container list:

- **Add** — Registers the PostgreSQL container in Mini Infra's database management system, making it available for backup configuration and monitoring.
- **Manage** — Appears for containers already registered. Links directly to the PostgreSQL server management page for that instance.

## What to watch out for

- Stop gives the process 10 seconds. Applications that need longer to drain connections or flush data may be killed before completing their shutdown sequence.
- Remove cannot be undone. If you need the container's filesystem contents, inspect and copy them before removing.
- Removing a container does not free up the port it was using immediately in all cases. If you recreate a container on the same port right after removal, you may see a brief "port in use" error. Wait a moment and try again.
