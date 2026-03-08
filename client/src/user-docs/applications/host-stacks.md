---
title: Host Infrastructure Stacks
description: How to manage host-level infrastructure stacks with plan and apply semantics in Mini Infra.
category: Applications
order: 1
tags:
  - stacks
  - docker
  - infrastructure
  - configuration
---

# Host Infrastructure Stacks

The **Host** page lets you manage infrastructure stacks that run at the host level, outside of any environment. Stacks use a declarative model with plan/apply semantics — you define your desired container state, review a plan of changes, and apply it.

## What is a stack?

A stack is a collection of Docker containers and their supporting infrastructure (networks, volumes, configuration files) defined as a single unit. Each stack has **services** — individual containers with their image, environment variables, port mappings, and other Docker settings.

Stacks support two service types:

- **Stateful** — standard stop/start replacement, suited for databases and infrastructure services
- **StatelessWeb** — zero-downtime blue-green deployment via HAProxy, suited for web applications

## Viewing stacks

Navigate to **Host** in the sidebar under **Applications**. The page displays a **Stacks** card listing all host-level stacks. Each stack shows:

| Field | Description |
|-------|-------------|
| **Name** | The stack's unique identifier |
| **Status** | Current sync state (see below) |
| **Latest Version** | The most recent version of the stack definition |
| **Running Version** | The version currently deployed (shown in orange if it differs from latest) |
| **Services** | Number of containers in the stack |
| **Last Applied** | Timestamp of the most recent successful apply |

Click the **Refresh** button in the card header to re-fetch the stacks list.

## Stack status values

| Status | Color | Meaning |
|--------|-------|---------|
| **Synced** | Green | Running containers match the stack definition |
| **Drifted** | Orange | Running containers differ from the desired state |
| **Pending** | Yellow | Definition has been updated but changes have not been applied |
| **Error** | Red | The last apply operation failed |
| **Undeployed** | Gray | Stack has never been deployed |

## Reviewing a plan

Click a stack to expand it and view the **plan** — a comparison between the desired state and the current running containers. The plan header shows the stack name, version, and when it was last computed. Click **Refresh Plan** to recompute.

### Action summary

At the top of the plan, colored badges summarize the operations:

- **Create** (green) — containers that will be created
- **Recreate** (orange) — containers that will be stopped, removed, and rebuilt
- **Remove** (red) — containers that will be deleted
- **Unchanged** (gray) — containers with no differences

### Service details

Each service in the plan shows:

- **Service name** and the planned **action**
- **Image change** — old and new image tags when an update is detected (e.g. `telegraf:1.32 → telegraf:1.33`)
- **Action reason** — a short explanation such as "image tag changed" or "environment variable updated"
- **Diff view** — click **Show Diff** to see field-by-field changes. Removed values appear in red, new values in green.

## Applying changes

Once you've reviewed the plan, you can apply it:

- **Apply All** — applies every planned change in the correct order
- **Apply Selected** — check individual services and apply only those (available when services with changes are visible)

### Apply progress

During apply, a progress view shows each service's result:

- A green check or red X indicating success or failure
- The action performed (create, recreate, remove)
- Duration of the operation
- Error details if a service failed

After apply completes, click **View Updated Plan** to refresh and confirm the stack is now **Synced**.

## Service configuration fields

When stacks are created or edited, each service supports these settings:

| Field | Description |
|-------|-------------|
| **Service Name** | Unique name within the stack |
| **Service Type** | `Stateful` or `StatelessWeb` |
| **Docker Image** | Image name (e.g. `prom/prometheus`) |
| **Docker Tag** | Image tag (e.g. `v3.3.0`) |
| **Environment Variables** | Key-value pairs passed to the container |
| **Ports** | Host-to-container port mappings |
| **Mounts** | Volume and bind mount definitions |
| **Command / Entrypoint** | Override the container's default command |
| **Restart Policy** | Container restart behavior |
| **Health Check** | Command, interval, and timeout for health monitoring |
| **Config Files** | Files written to volumes before the container starts |
| **Init Commands** | Shell commands for volume preparation (mkdir, chown, etc.) |
| **Depends On** | Services that must start before this one |
| **Order** | Numeric deployment order (lower values deploy first) |

For **StatelessWeb** services, additional routing fields configure HAProxy integration: hostname, listening port, SSL settings, certificate, load balancing algorithm, and optional Cloudflare DNS management.

## What to watch out for

- The monitoring stack (Telegraf, Prometheus, Loki, Alloy) is deployed as a host-level stack — removing it will stop container metrics and log collection across the application.
- **Apply** operations stop and remove containers before recreating them. For **Stateful** services, there will be brief downtime during the recreate.
- If a service fails during apply, other services that depend on it may also fail. Check the error details and resolve the issue before re-applying.
- Stacks with **StatelessWeb** services require a running HAProxy stack for traffic routing.
