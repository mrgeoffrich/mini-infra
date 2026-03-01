---
title: Managing HAProxy Frontends
description: How to view, create, and configure HAProxy frontends in Mini Infra.
category: Deployments
order: 5
tags:
  - haproxy
  - deployments
  - networking
  - ssl
  - configuration
---

# Managing HAProxy Frontends

HAProxy frontends define how incoming traffic is accepted and routed. Mini Infra manages frontends at [/haproxy/frontends](/haproxy/frontends).

## Frontend types

| Type | Description |
|------|-------------|
| **Deployment** | Created automatically when a deployment configuration has a hostname configured |
| **Manual** | Created by you to connect a specific container to HAProxy |
| **Shared** | A shared frontend that can route to multiple backends |

## Frontends list

The frontends list at `/haproxy/frontends` shows:

| Column | Description |
|--------|-------------|
| **Frontend Name** | The name of the HAProxy frontend |
| **Routes** | Hostnames that route through this frontend (up to 3 shown) |
| **Environment** | Environment this frontend belongs to |
| **Status** | Current state of the frontend |
| **SSL** | Whether SSL/TLS is enabled (green shield if yes) |

### Filter options

- **Type** — All Types, Deployment, Manual, Shared
- **Environment** — filter by environment name
- **Status** — All Statuses, Active, Pending, Failed
- **Search** — text search by frontend name

### Status values

| Status | Color | Meaning |
|--------|-------|---------|
| `active` | Green | Frontend is running and accepting traffic |
| `pending` | Yellow | Frontend is being configured |
| `failed` | Red | Frontend encountered an error |

## Frontend detail page

Click a frontend to open its detail page at `/haproxy/frontends/:frontendName`. The page shows:

- **Type badge** and **status badge**
- **Overview** — type, status, environment, created and updated timestamps
- **Routing Configuration** — frontend name, bind address and port, SSL status
- **Container Details** (manual frontends) — container name, ID, and port
- **Deployment Details** (deployment frontends) — link to the deployment configuration
- **Status Card** — live status with refresh button

## Creating a manual frontend

Click **Connect Container** on the frontends list page. This opens a 4-step wizard:

### Step 1 — Select Environment

Choose the environment where HAProxy is running. HAProxy must be deployed in the selected environment.

### Step 2 — Choose Container

Select the container you want to connect to HAProxy. Only containers on the same Docker network as HAProxy are eligible. Enter the **Container Port** the container listens on (1–65535).

### Step 3 — Frontend Configuration

| Field | Description |
|-------|-------------|
| **Hostname** | The domain name for this frontend (e.g., `app.example.com`) |
| **Enable SSL/TLS** | Whether to serve this frontend over HTTPS |
| **TLS Certificate** | Select an active certificate (appears if SSL is enabled) |
| **Health Check Path** | Endpoint HAProxy uses to check container health (e.g., `/`) |

### Step 4 — Review & Create

The wizard shows a summary of your configuration and runs validation checks:

- Container is running
- Network connectivity is confirmed
- Hostname is not already in use
- Certificate is valid (if SSL enabled)

Click **Create Frontend** to create the frontend.

## Editing a manual frontend

From the detail page, click **Edit** (manual frontends only). You can update:

- **Hostname** — changing this updates HAProxy routing rules
- **SSL/TLS** — enable or disable HTTPS
- **TLS Certificate** — select a different certificate

The container, environment, and port cannot be changed. To connect a different container, delete the frontend and create a new one.

## Deleting a frontend

From the frontend detail page or the list actions dropdown, click **Delete** (manual frontends only). Deployment-managed frontends are removed via the deployment **Remove** action.

## What to watch out for

- Changing a frontend's hostname immediately updates HAProxy routing — existing traffic to the old hostname will stop being routed.
- Deployment-managed frontends cannot be edited or deleted directly; manage them through the deployment configuration.
- If SSL is enabled, an active TLS certificate must be available. Issue a certificate first at [/certificates](/certificates).
