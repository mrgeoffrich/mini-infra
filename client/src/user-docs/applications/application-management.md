---
title: Managing Applications
description: How to create, deploy, update, and manage applications in Mini Infra
tags:
  - applications
  - deployment
  - docker
  - configuration
---

# Managing Applications

Applications in Mini Infra are configuration templates that define Docker services. Each application specifies an image, ports, environment variables, volumes, and optional routing. When deployed, an application creates a running stack in its environment.

## Key Concepts

- **Application** --- A reusable template defining how a Docker service should run.
- **Stack** --- A running instance of an application, created when you deploy.
- **Environment** --- The target environment where the stack runs.

## Viewing Applications

The Applications page shows all applications as cards in a responsive grid. Each card displays:

- Application name and optional description.
- Category and environment badges.
- Deployment status (Running, Pending, Deploying, or no stacks yet).
- Application URL (shown when a running stack has a configured hostname).
- Action buttons for Deploy, Update, and Stop.

## Creating an Application

Click **Add Application** to open the creation form. The form is organized into sections:

### Basic Information

- **Display Name** --- A human-readable name for the application.
- **Description** --- Optional text describing the application.

### Service Configuration

- **Service Name** --- Used as the container name prefix. Must be lowercase with hyphens.
- **Service Type**:
  - **Stateful** --- For databases, caches, and services that do not need external HTTP routing.
  - **StatelessWeb** --- For web applications and APIs that need HAProxy routing.
- **Environment** --- The target environment for deployment.

### Container Configuration

- **Docker Image** and **Tag** --- The image to pull and run.
- **Restart Policy** --- How Docker handles container restarts (Always, Unless Stopped, On Failure, or No).

### Health Check (optional)

Enable to configure a Docker health check with a command, interval, timeout, retries, and start period.

### Port Mappings

Map host ports to container ports with protocol selection (TCP or UDP).

### Environment Variables

Define key-value pairs passed to the container at runtime.

### Volumes

Named Docker volumes with mount paths for persistent data.

### Routing (StatelessWeb only)

When the service type is StatelessWeb:

- **Hostname** --- The domain name for routing traffic.
- **Listening Port** --- The port the container listens on. Use **Detect Ports** to auto-detect from the image.
- **SSL/TLS** --- Automatically creates a TLS certificate and DNS record (for local networks).
- **Cloudflare Tunnel** --- Automatically creates a tunnel ingress (for internet networks).

### Deploy Immediately

Toggle whether to deploy the application right after creation, or just save the template for later.

## Deploying an Application

If the application has no running stacks, click the **Deploy** button on its card. This instantiates the template as a stack in the configured environment and applies the configuration.

## Updating an Application

Click **Update** on a running application's card to pull the latest Docker image and redeploy. For StatelessWeb services, the update uses zero-downtime deployment so traffic is not interrupted.

## Stopping an Application

Click **Stop** to destroy all stacks for the application. The containers are removed but the application template is preserved and can be redeployed later.

## Editing an Application

Open the dropdown menu on an application card and select **Edit** to modify the template configuration. Changes take effect on the next deployment or update. The environment cannot be changed after creation.

## Deleting an Application

Open the dropdown menu and select **Delete**. This permanently removes the application template. Running stacks should be stopped first.
