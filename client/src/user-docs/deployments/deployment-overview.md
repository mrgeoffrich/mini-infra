---
title: Deployment Overview
description: How zero-downtime deployments work with the blue-green model and HAProxy traffic switching.
category: Deployments
order: 1
tags:
  - deployments
  - blue-green
  - haproxy
  - zero-downtime
  - overview
---

# Deployment Overview

Mini Infra deploys Docker images using a blue-green model with HAProxy handling traffic switching. The goal is zero downtime — your application keeps serving requests while a new version starts up and takes over.

## How it works

A deployment in Mini Infra has two parts: a **deployment configuration** that defines what to deploy, and the **deployment itself** which is the act of pulling the image, starting the container, and switching traffic.

### Deployment configurations

A deployment configuration describes an application:

- Which Docker image and tag to use.
- Which environment to deploy into (an environment is a group of Docker resources with an HAProxy instance).
- Health check settings so Mini Infra can verify the new container is working before sending it traffic.
- An optional hostname for public access, with optional SSL/TLS.

Configurations are reusable. You define them once and trigger deployments from them as many times as needed.

### Environments

Deployments run inside environments. Each environment is a logical grouping of Docker services, networks, and volumes, with an HAProxy instance acting as the load balancer. The environment must be running and its HAProxy service must be healthy before you can deploy into it.

Navigate to **Environments** in the sidebar to manage them.

## The blue-green model

When you deploy an application that's already running, Mini Infra uses a blue-green deployment strategy:

1. **Blue** is the currently running container, actively serving traffic.
2. **Green** is the new container being deployed.

Both containers run simultaneously during the deployment. Traffic switches from blue to green only after the green container passes health checks. If anything goes wrong, the blue container is still there as a fallback.

The first deployment of an application is simpler — there's no existing container, so Mini Infra starts the container, runs health checks, and opens traffic.

## What HAProxy does

HAProxy is the load balancer that sits in front of your deployed applications. During a deployment:

- It registers the new container as a backend server.
- After health checks pass, it routes incoming traffic to the new container.
- It drains connections from the old container gracefully — existing requests finish before the old container is shut down.
- If a hostname is configured, HAProxy sets up hostname-based routing so requests to `app.example.com` reach the right container.

## The Deployments page

Navigate to **Deployments** in the sidebar. The page shows all deployment configurations in either a list view or a card view.

**List view** shows a table with application name, environment, Docker image, status, and last deployment time.

**Card view** shows richer information per application: the latest deployment status, container details, quick stats (last deploy, duration, success/failure), and action buttons.

Both views support filtering by application name, Docker image, and active/inactive status.

## What to watch out for

- The environment must be running with a healthy HAProxy instance before deploying. If HAProxy is down, the deployment will fail during the traffic switching step.
- Health checks are mandatory. If your application doesn't respond to the configured health endpoint, the deployment will fail and roll back.
- Deployments are triggered manually. Creating or updating a configuration doesn't start a deployment on its own.
- Each deployment configuration is tied to one environment. To deploy the same application to multiple environments, create separate configurations.
