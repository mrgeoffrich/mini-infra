---
title: Creating Deployments
description: How to set up a deployment configuration with Docker image, health checks, and hostname routing.
category: Deployments
order: 2
tags:
  - deployments
  - configuration
  - docker
  - health-checks
  - hostname
  - ssl
---

# Creating Deployments

A deployment configuration tells Mini Infra everything it needs to deploy your application: which image to pull, how to verify it's working, and how to route traffic to it.

## Creating a configuration

Click **New Configuration** on the Deployments page. The form has two tabs: Docker and Health Check.

### Docker tab

| Field | Description |
|-------|-------------|
| **Application Name** | A unique name for this deployment. Lowercase letters, numbers, hyphens, and underscores only. |
| **Environment** | Which environment to deploy into. Must have a running HAProxy instance. Cannot be changed after creation. |
| **Docker Registry** | Optional. Leave blank for Docker Hub, or enter a registry URL like `ghcr.io`. |
| **Docker Image** | The image name without the tag (e.g. `myapp` or `myorg/myapp`). |
| **Docker Tag** | The image tag. Defaults to `latest`. |
| **Listening Port** | The port your application listens on inside the container. HAProxy uses this to route traffic. |
| **Hostname** | Optional. A public hostname like `app.example.com`. If set, HAProxy creates hostname-based routing so requests to this domain reach your application. |
| **SSL/TLS** | Appears when a hostname is set. Enable to serve traffic over HTTPS. |
| **Volume Mounts** | Optional. Map host paths to container paths. Each mount can be read-write or read-only. |
| **Environment Variables** | Optional. Key-value pairs passed to the container at startup. |

### Health Check tab

Health checks determine whether the new container is ready to receive traffic. Every deployment configuration needs a health check.

| Field | Description |
|-------|-------------|
| **Health Check Endpoint** | The URL path to check (e.g. `/health` or `/api/status`). |
| **HTTP Method** | GET or POST. |
| **Response Validation Pattern** | Optional regex to match against the response body. |
| **Timeout** | How long to wait for a response before considering the check failed. 1–60 seconds. |
| **Retries** | How many times to retry a failed check before giving up. 0–10. |
| **Interval** | Time between retry attempts. 1–300 seconds. |

Click **Create** to save the configuration. This does not start a deployment — it only saves the definition.

## Editing a configuration

Click the edit button on any deployment configuration. All fields except the environment can be changed. Changes take effect on the next deployment — they don't affect any currently running containers.

## Triggering a deployment

### First deployment

Click **Deploy** on a configuration that hasn't been deployed before. Mini Infra pulls the image, starts a container, runs health checks, and opens traffic through HAProxy.

### Subsequent deployments

After the first deployment, click **New** to start a blue-green deployment. A dialog lets you optionally customize:

- **Container name** — Defaults to the application name.
- **Container label** — Optional metadata in `key=value` format.

The dialog shows a summary of what will happen: which image will be pulled, which health check endpoint will be used, and whether rollback is enabled. Click **Deploy** to start.

## DNS and hostname configuration

When a deployment configuration has a hostname and Cloudflare is connected, Mini Infra automatically creates DNS records pointing the hostname to the HAProxy instance.

The deployment detail page shows DNS records under the **DNS Configuration** section:

- Hostname, provider (Cloudflare or External), IP address, status, and last updated time.
- **Sync DNS** refreshes records from Cloudflare.
- DNS records can be deleted individually if needed.

## HAProxy frontend configuration

The deployment detail page also shows the **HAProxy Frontend Configuration**:

- Frontend name, hostname routing rule, backend name, bind address and ports, and SSL status.
- **Sync Configuration** reconciles the UI state with the actual HAProxy configuration. Use this if you suspect configuration drift.

## Removing a deployment

Click **Remove Deployment** to tear down a deployed application. This stops and removes all containers, deletes the HAProxy frontend configuration, and cleans up DNS records. The deployment configuration itself is preserved — you can deploy again later.

## What to watch out for

- The health check endpoint must return a success response (HTTP 200 by default) for the deployment to complete. If your app takes time to start up, set a generous timeout and retry count.
- Environment selection is permanent. If you need to move an application to a different environment, create a new configuration and remove the old one.
- Hostname validation checks against existing deployments and Cloudflare. You can't assign the same hostname to two different deployments.
- Volume mounts use host paths, which must exist on the Docker host before deploying.
