---
title: Creating a Deployment Configuration
description: How to create and configure a new zero-downtime deployment in Mini Infra.
category: Deployments
order: 2
tags:
  - deployments
  - docker
  - blue-green
  - configuration
  - haproxy
---

# Creating a Deployment Configuration

A deployment configuration defines how Mini Infra should deploy, health-check, and route traffic to a Docker container. Create one at [/deployments/new](/deployments/new).

## Step 1 — Select an environment

Before filling in the Docker tab, select the **environment** this application belongs to. The environment determines which HAProxy instance manages traffic routing. The environment cannot be changed after the configuration is saved.

## Step 2 — Docker tab

### Application settings

| Field | Required | Description |
|-------|----------|-------------|
| **Application Name** | Yes | Lowercase alphanumeric and hyphens, max 255 characters. Used as the container name prefix. |
| **Docker Registry** | No | Registry hostname (e.g., `ghcr.io`). Leave blank to use Docker Hub. |
| **Docker Image** | Yes | Image name without tag (e.g., `nginx`, `myorg/myapp`). |
| **Docker Tag** | Yes | Image tag to deploy (default: `latest`). |
| **Listening Port** | No | The port your application listens on inside the container. Used for health checks and traffic routing. |

### Hostname

Enter a public **hostname** (e.g., `api.example.com`) if you want HAProxy to route external traffic to this application. Leave it blank to deploy without public routing.

Enable **SSL/TLS** to automatically provision and manage a certificate for the hostname using Let's Encrypt (requires TLS settings to be configured).

### Ports, volumes, and environment variables

Use the **Port Editor**, **Volume Editor**, and **Environment Variable Editor** sections to configure:

- Additional port mappings (`containerPort:hostPort/protocol`)
- Volume mounts (`hostPath:containerPath` with read/write or read-only mode)
- Environment variables (uppercase names, any value)

## Step 3 — Health Check tab

The health check determines whether the new container is ready to receive traffic before HAProxy switches over.

| Field | Default | Description |
|-------|---------|-------------|
| **Health Check Endpoint** | — | URL path the new container must respond to (e.g., `/health`) |
| **HTTP Method** | GET | HTTP method to use for the check |
| **Response Validation Pattern** | — | Optional regex the response body must match |
| **Timeout** | 10000 ms | How long to wait for each response |
| **Retries** | 3 | Number of failed checks before giving up |
| **Interval** | 5000 ms | Time between checks |

## Step 4 — Rollback tab (optional)

| Field | Default | Description |
|-------|---------|-------------|
| **Enable Automatic Rollback** | On | If the health check fails, automatically remove the new container |
| **Max Wait Time** | 300000 ms | Maximum time to wait for the health check before failing |
| **Keep Old Container** | Off | Keep the old container stopped rather than removing it after a successful deployment |

## Saving and deploying

Click **Create Configuration** to save. You are returned to the deployments list.

To start a deployment, click **Deploy** on the configuration row. See [Deployment Lifecycle](/deployments/deployment-lifecycle) for what happens next.

## What to watch out for

- The **Application Name** must be unique within its environment.
- If you enter `image:tag` in the Docker Image field (with a colon), Mini Infra will split it automatically into image and tag fields.
- **Environment variables** with sensitive values (passwords, API keys) are stored in the database. Use Docker secrets or a secrets management tool for highly sensitive values in production.
- The **Listening Port** is used for the health check URL. If your application's health endpoint is on a different port than its main traffic port, set the listening port to the health check port.
