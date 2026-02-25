---
title: What is Mini Infra?
description: An overview of Mini Infra and what it manages on your Docker host.
category: Getting Started
order: 1
tags:
  - overview
  - getting-started
  - introduction
---

# What is Mini Infra?

Mini Infra is a web application for managing a single Docker host and the infrastructure around it. It gives you a unified interface for Docker containers, PostgreSQL database backups, zero-downtime deployments via HAProxy, and Cloudflare tunnel monitoring — without the overhead of Kubernetes or full-featured platforms like Portainer.

## What it manages

Mini Infra covers five areas of your infrastructure:

- **Docker containers** — View, start, stop, restart, and inspect every container on the host. Stream logs in real time and browse volume contents.
- **PostgreSQL backups** — Schedule automated backups of PostgreSQL databases to Azure Blob Storage. Browse stored backups and restore them to the same or a new database.
- **Zero-downtime deployments** — Deploy Docker images using a blue-green model with HAProxy handling traffic switching. Health checks run before cutover, and rollback is automatic if they fail.
- **Cloudflare tunnels** — Monitor the status of Cloudflare tunnels that expose your services to the internet.
- **Connectivity monitoring** — Track the health of external service connections: Docker daemon, Azure Storage, Cloudflare API, and GitHub.

## Logging in

Mini Infra uses Google OAuth for authentication. On the login page, click **Continue with Google** and sign in with your Google account. After authentication, you're redirected to the dashboard.

Sessions last 24 hours. When your session expires, you'll be redirected to the login page automatically.

## The dashboard

After login, the dashboard shows a high-level summary of your Docker host:

- **Container summary cards** — Total containers, running count, stopped count, and paused count at a glance.
- **Recently died containers** — An alert showing containers that exited in the last 24 hours, so you can spot unexpected failures quickly.
- **Connectivity indicators** — Small status dots in the header for Docker, Cloudflare, Azure, and GitHub. Green means connected; red means the service is unreachable.

## Finding your way around

The sidebar organises features into sections:

| Section | What's there |
|---------|-------------|
| **Applications** | Containers, Deployments, Environments |
| **Databases** | PostgreSQL Servers, PostgreSQL Backups |
| **Networking** | Cloudflare Tunnels, Load Balancer (HAProxy), TLS Certificates |
| **Monitoring** | Events log |
| **Connected Services** | Docker, Cloudflare, Azure, GitHub connectivity status |
| **Administration** | System Settings, Security, Registry Credentials, Self-Backup, TLS Settings, GitHub Settings |

Each page has a **?** button in the top-right corner of the header. Click it to open the relevant help article for the page you're on.

## What to know before you start

- Mini Infra connects directly to the Docker daemon on the host via the Docker socket. It can see and control all containers.
- Backup and restore operations require Docker images for `pg_dump` and `pg_restore` to be configured in System Settings before use.
- Deployment configs define how an application is deployed but don't trigger a deploy on their own — you start deploys manually from the deployment detail page.
