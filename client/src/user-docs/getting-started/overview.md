---
title: Getting Started with Mini Infra
description: An introduction to Mini Infra and what you can do with it.
tags:
  - getting-started
  - dashboard
  - overview
  - docker
---

# Getting Started with Mini Infra

Mini Infra is a web application for managing a single Docker host and its supporting infrastructure. It brings container management, PostgreSQL backups, zero-downtime deployments, load balancer configuration, and external service monitoring into one place.

## What Mini Infra manages

Mini Infra connects to your Docker host and provides a UI and API for the following:

| Feature | What you can do |
|---------|----------------|
| **Containers** | View, start, stop, restart, and delete Docker containers. Inspect volumes and networks. |
| **Deployments** | Configure and run zero-downtime blue-green deployments with health checks and automatic rollback. |
| **Environments** | Group containers and services into named environments (e.g., production, staging). |
| **PostgreSQL Backups** | Schedule and restore encrypted backups of PostgreSQL databases to the configured storage backend. |
| **Load Balancer** | Manage HAProxy frontends and backends that route traffic to your containers. |
| **TLS Certificates** | Issue and auto-renew SSL/TLS certificates using Let's Encrypt. |
| **Tunnels** | Monitor Cloudflare tunnel health and manage public hostname routing. |
| **Events** | Track long-running operations like deployments, backups, and certificate renewals. |
| **API Keys** | Create programmatic access keys with fine-grained permissions. |

## The Dashboard

When you first log in, the **Dashboard** at `/dashboard` gives you an at-a-glance view of your infrastructure:

- **Container summary** — total container count plus counts for Running, Stopped, and Paused containers. If any containers exited in the last 24 hours, a **Recently Died Containers** alert appears with links to the affected containers.
- **Deployment summary** — counts for active deployment configurations, currently running deployments, and deployments that require attention.
- **Recent deployments** — a list of the last few deployments with status and timestamps.

If Docker is not yet connected, the dashboard shows a configuration prompt instead of container data. Go to [/connectivity-docker](/connectivity-docker) to configure the Docker connection.

## Prerequisites

Before using most features, you need to connect Mini Infra to external services:

| Service | Required for | Where to configure |
|---------|-------------|-------------------|
| **Docker** | All container and deployment features | [Connected Services → Docker](/connectivity-docker) |
| **Storage backend** | PostgreSQL backups, self-backups, TLS certificate storage | [Connected Services → Storage](/connectivity-storage) |
| **Cloudflare** | Tunnel monitoring, DNS record management | [Connected Services → Cloudflare](/connectivity-cloudflare) |
| **GitHub** | Bug reporting, package registry integration | [Connected Services → GitHub](/connectivity-github) |

## Navigating the application

The main navigation links to all major sections. See [Navigating the Dashboard](/getting-started/navigating-the-dashboard) for a full walkthrough of the interface.

## What to watch out for

- Mini Infra manages a **single Docker host**. It is not designed for multi-host or Kubernetes environments.
- The **Docker connection must be configured first**. Features that depend on Docker — containers, deployments, environments, and volumes — will show errors or empty states until Docker is connected.
- Running Mini Infra with direct access to `/var/run/docker.sock` gives it full control of the Docker daemon. Only deploy it in environments where that level of access is appropriate.
