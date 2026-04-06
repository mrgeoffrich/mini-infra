---
title: Volume Management
description: How to inspect, browse, and manage Docker volumes in Mini Infra.
tags:
  - containers
  - docker
  - volumes
---

# Volume Management

Docker volumes provide persistent storage that survives container restarts and deletions. Mini Infra lets you list, inspect, browse, and delete volumes from the **Volumes** tab on the Containers page.

## Viewing volumes

Navigate to [/containers](/containers) and click the **Volumes** tab. The volumes table shows:

| Column | Description |
|--------|-------------|
| **Name** | Volume name |
| **Driver** | Docker volume driver (usually `local`) |
| **Mount Point** | Absolute path on the Docker host where the volume is stored |
| **Size** | Disk usage (only available after inspecting) |
| **In Use** | Whether any container is currently using the volume |

## Inspecting a volume

Click the **Inspect** button (scan icon) on a volume row to load its usage details and disk size. The size column updates after inspection completes.

## Browsing volume files

After inspecting a volume, click the **View** button (eye icon) to browse the volume's file listing. This opens `/containers/volumes/:name/files/` where you can navigate directories and view individual file contents.

## Volume file content

Navigate into the file browser to open individual files. The content is displayed read-only in a code viewer. This is useful for inspecting configuration files, logs stored in volumes, or checking data integrity without connecting to a running container.

## Deleting a volume

Click the **Delete** button (trash icon) on a volume row to delete it. A confirmation dialog appears before the volume is removed.

Volumes can only be deleted when **not in use** by any container. If the volume is in use, the delete button is disabled.

## What to watch out for

- **Deleting a volume permanently destroys its data.** There is no undo.
- Volumes used by stopped containers still count as "in use" — stop and remove the container first.
- The `Mount Point` path is the path on the Docker host, not inside any container. If Mini Infra runs inside Docker itself, this path may not be accessible from the Mini Infra container.
- Size is only populated after you click **Inspect**. Inspecting a large volume may take a moment.
