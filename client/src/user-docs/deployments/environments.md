---
title: Managing Environments
description: How to create and manage environments that group services and infrastructure in Mini Infra.
category: Deployments
order: 4
tags:
  - deployments
  - environments
  - docker
  - haproxy
  - configuration
---

# Managing Environments

Environments group your applications, services, networks, and volumes into logical units (e.g., `production`, `staging`). Each environment has its own HAProxy instance, Docker networks, and volumes. Deployments are always associated with a specific environment.

## The Environments page

Go to [/environments](/environments) to see all environments. Click an environment name to open its detail page.

## Environment detail page

The detail page at `/environments/:id` shows:

### Overview cards

| Card | Information |
|------|-------------|
| **Services** | Total service count, healthy service count |
| **Networks** | Number of Docker networks in this environment |
| **Volumes** | Number of Docker volumes in this environment |
| **Stacks** | Number of infrastructure stacks, synced count |

### Environment status

Each environment has a status badge:

| Status | Meaning |
|--------|---------|
| `running` | Environment is active and services are running |
| `stopped` | Environment has been stopped |
| `degraded` | Environment is running but one or more services are unhealthy |
| `failed` | Environment encountered an error |
| `uninitialized` | Environment has been created but not yet started |

### Service health

Individual services within an environment show:

| Health value | Meaning |
|-------------|---------|
| `healthy` | Service is passing health checks |
| `unhealthy` | Service is failing health checks |
| `unknown` | Health status cannot be determined |

## Managing services

Click **Add Service** (in the top-right dropdown or in the Services tab) to add a service to the environment. Services represent individual components managed within the environment (e.g., HAProxy, individual containers).

Each service in the list shows its name, type, last error (if any), creation time, start time, status, and health.

## Networks and volumes

The **Networks** and **Volumes** tabs show Docker networks and volumes scoped to this environment. These are managed automatically when services are deployed.

## Stacks

The **Stacks** tab shows infrastructure stacks scoped to this environment. Stacks use a declarative plan/apply model to manage groups of containers. See [Host Infrastructure Stacks](/help/applications/host-stacks) for details on how stacks work — the same plan, diff, and apply workflow applies to environment-scoped stacks.

## HAProxy status

If the environment includes an HAProxy service, a **HAProxy Status** card appears on the detail page. If HAProxy configuration has drifted or encountered an error, a **Remediate** option appears to restore it.

## Creating and editing environments

Use the **Edit Environment** option in the top-right dropdown to rename an environment or update its description.

To delete an environment, use **Delete Environment** from the dropdown. Deletion is blocked if the environment is currently running.

## What to watch out for

- The **environment type** (`production` or other) is set when the environment is created and affects how it appears in the UI (production environments show a red badge). This cannot be changed after creation.
- Deleting an environment does not automatically remove Docker containers, networks, or volumes — those must be cleaned up separately.
- Each deployment configuration is permanently linked to one environment and **cannot be moved** to a different environment after creation.
