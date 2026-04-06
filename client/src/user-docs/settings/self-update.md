---
title: System Update
category: settings
order: 8
description: How to update Mini Infra to a new version using the sidecar update mechanism
tags:
  - settings
  - update
  - sidecar
  - administration
---

# System Update

Mini Infra can update itself to a new version using a sidecar container mechanism. The System Update page lets you trigger an update, monitor progress, and view the result.

## How It Works

When you trigger an update, Mini Infra:

1. Pulls the latest Docker images for the application, update sidecar, and agent sidecar.
2. Launches the update sidecar container.
3. The sidecar stops the current Mini Infra container, creates a new one from the updated image, and runs health checks.
4. If health checks pass, the new container takes over.
5. If health checks fail, the sidecar automatically rolls back to the previous version.

All active connections are interrupted during the update, but the process is automatic and typically completes in under a minute.

## Update Channels

Two update channels are available:

- **Latest** --- The most recent build.
- **Production** --- A stable, tested release.

## Triggering an Update

1. Optionally click **Check Docker Status** to verify Docker is available.
2. Click **Update to Latest** or **Update to Production**.
3. Review the confirmation dialog, which warns that active connections will be interrupted.
4. Click **Start Update** to begin.

## Monitoring Progress

Once the update starts, the page shows a real-time progress display with each step:

- Checking for updates
- Pulling new image
- Inspecting container
- Stopping current container
- Creating new container
- Health-checking new container
- Update sidecar running

Each step shows a status indicator (completed, in progress, failed, or skipped). The page automatically reconnects to the server after the restart.

## Update Results

After the update completes, a banner shows the result:

- **Success** --- The update completed and Mini Infra is running the new version.
- **Rolled back** --- The update failed health checks and the previous version was automatically restored. The error reason is displayed.
- **Failed** --- The update failed. Check the error message for details.
