---
title: Concepts and Terminology
description: A glossary of Mini Infra concepts — what each feature is, how it works, and the terminology used throughout the application.
tags:
  - concepts
  - glossary
  - terminology
  - reference
---

# Concepts and Terminology

This page explains the core concepts in Mini Infra and the terminology used throughout the application.

## Containers

Mini Infra connects to a single Docker host and provides a UI and API for the full container lifecycle. You can view, start, stop, restart, and delete containers, inspect their configuration (environment variables, ports, volumes, networks, labels), and tail logs.

Containers have a **status** that mirrors the Docker daemon: Running, Stopped, Paused, Exited, or Restarting. The dashboard highlights **recently died containers** — any that exited in the last 24 hours — so problems are visible at a glance.

Labels that contain sensitive keywords (password, token, secret, key, credential) are automatically redacted in API responses.

## Applications

An **application** is a configuration template that defines how a Docker service should run — including image, ports, environment variables, volumes, and optional routing. Applications are the primary way users create and manage services in Mini Infra.

When you **deploy** an application, Mini Infra instantiates the template as a running stack in the target environment. You can **update** a running application (pull the latest image and redeploy) or **stop** it (tear down the stack while preserving the template for redeployment).

Each application targets an **environment** and has a **service type**:

- **Stateful** — for databases, caches, and services that do not need external HTTP routing.
- **StatelessWeb** — for web applications and APIs that need HAProxy routing. Updates to StatelessWeb services use zero-downtime deployment.

StatelessWeb applications also configure **routing** — a hostname, listening port, and optional TLS certificate and Cloudflare tunnel ingress.

The relationship between the layers is: **Application** (template) → **Stack** (running instance) → **Containers** (Docker processes).

## Stacks

A **stack** is a collection of Docker containers and their supporting infrastructure (networks, volumes, configuration files) managed as a single unit. Stacks use a declarative model with **plan/apply semantics** — you define your desired state, review a plan of changes, and apply it.

Stacks can be **host-level** (infrastructure that runs outside any environment, like HAProxy or monitoring) or **environment-scoped** (application stacks deployed within an environment).

Each stack has a **status** that tracks whether its running state matches its declaration:

| Status | Meaning |
|--------|---------|
| **Synced** | Running containers match the stack definition |
| **Drifted** | Running containers differ from the desired state |
| **Pending** | Definition updated but changes not yet applied |
| **Undeployed** | Declared but never deployed |
| **Error** | Last apply failed |
| **Removed** | Stack resources have been torn down |

Stacks contain **services**, which come in two types:

- **Stateful** — standard stop/start replacement, suited for databases and infrastructure services. There is brief downtime during recreate.
- **StatelessWeb** — zero-downtime blue-green deployment via HAProxy, suited for web applications.

When you review a **plan**, each service shows a planned action: **Create** (new container), **Recreate** (stop, remove, rebuild), **Remove** (delete), or **No-op** (unchanged). You can **Apply All** changes or **Apply Selected** services individually.

## Stack Definitions

A **stack definition** is the versioned snapshot of a stack's desired state. It contains everything needed to reconcile the stack: service configurations, networks, volumes, TLS certificates, DNS records, tunnel ingress rules, and parameter values.

Mini Infra compares the current stack definition against the running containers to detect **drift** and generate a **plan**. Each stack tracks both its **latest version** (most recent definition) and its **running version** (what was last applied). When these differ, the stack shows as Drifted or Pending.

The stack definition also records a **lastAppliedSnapshot** — a frozen copy of the definition at the time of the last successful apply — so drift detection always compares against what was actually deployed, not just what was declared.

## Stack Templates

A **stack template** is a reusable blueprint for deploying stacks. Templates define services, parameters, networks, and volumes in a structured format.

Templates have two **scopes**:

- **Host** — for host-level infrastructure stacks (HAProxy, monitoring, etc.).
- **Environment** — for application stacks deployed within a specific environment.

Templates can be **System** (built-in, shipped with Mini Infra) or **User** (custom-created).

Templates use a **draft-and-publish** versioning workflow:

1. **Create Draft** — start editing from the current published version.
2. **Edit** — changes are saved automatically.
3. **Publish Draft** — finalize as a new version with optional release notes.
4. **Discard Draft** — abandon changes and return to the last published version.

Templates support **parameters** — named input variables with types, defaults, and validation rules that let you instantiate the same template with different configurations.

## Deployments (Blue-Green)

Mini Infra uses a **blue-green** deployment strategy for zero-downtime releases.

- **Blue** is the current production set of containers.
- **Green** is the new release being deployed.

A deployment follows these phases:

1. Start green containers with the new image
2. Run health checks against green
3. Register green as a backend in HAProxy
4. Switch traffic from blue to green
5. **Drain** blue — stop accepting new connections while in-flight requests complete (configurable timeout)
6. Remove blue containers

If any phase fails, Mini Infra automatically **rolls back** by switching traffic back to blue and removing green.

Deployment configuration includes health check settings (endpoint, method, expected status, retries, interval), container port mappings, environment variables, volumes, and the TLS certificate for the frontend.

## Environments

An **environment** is a named grouping of containers, stacks, and services — for example "production", "staging", or "development". Environments provide logical isolation and have a **type**: `production` or `nonproduction`.

Each environment has a **network type**:

- **Local** — services communicate over the Docker host network only.
- **Internet** — services are publicly routable via a Cloudflare tunnel.

Internet environments are associated with a **Cloudflare tunnel UUID** and a **service URL** that routes external traffic through the tunnel to HAProxy.

Mini Infra creates dedicated **Docker networks** per environment, named with the pattern `{environment}-{purpose}` (e.g., `production-applications`, `staging-tunnel`).

## HAProxy (Load Balancer)

Mini Infra manages HAProxy for traffic routing and load balancing. All configuration changes are applied at runtime via the **HAProxy Data Plane API** — no reload is needed.

### Instances

An **HAProxy instance** is a running HAProxy process that Mini Infra manages. Configuration includes the Data Plane API address (typically port 5555) and credentials.

### Frontends

A **frontend** defines where HAProxy listens for incoming traffic (port, protocol, TLS certificate). Frontends come in two types:

- **Manual** — a single container fronting one frontend.
- **Shared** — a single frontend with multiple **routes**, where each route maps a hostname to a different backend (with optional per-route TLS via SNI).

### Backends

A **backend** is a group of **servers** (container endpoints) that receive traffic from a frontend. Configuration includes:

- **Balance algorithm** — `roundrobin` (default), `leastconn`, or `source` (IP hash).
- **Health checks** — interval, timeout, and rise/fall counts (consecutive successes/failures to mark a server UP or DOWN).
- **Server weight** — relative proportion of traffic each server receives.

### Servers

A **server** is an individual container endpoint within a backend. Servers can be set to **maintenance mode** for graceful removal from the pool, or marked as **draining** to finish existing connections without accepting new ones.

## PostgreSQL Backups

Mini Infra can schedule and manage encrypted backups of PostgreSQL databases, stored in the configured storage backend (Azure Blob Storage today, with Google Drive arriving in a later phase).

### Backup Configuration

Each backup configuration defines:

- A **cron schedule** with timezone (e.g., `0 2 * * *` for 2 AM daily).
- A **retention policy** — automatically delete backups older than N days (default 30).
- **Format** — `custom` (pg_dump -Fc, compressed binary, faster) or `sql` (plain text, portable).
- **Compression level** — 0 (none) through 9 (maximum), default 6.
- The **storage location** (Azure container or Drive folder) and **path prefix** within it.

Backups can be triggered **manually** or run on their **schedule**. Each backup is encrypted with AES before upload.

### Restoring

You can restore a backup to the original database or to a new database with a different name. Mini Infra tracks restore progress with percentage and step-by-step logging. Failed restores are automatically cleaned up.

## TLS Certificates

Mini Infra automates SSL/TLS certificate issuance and renewal via **ACME** (the protocol behind Let's Encrypt).

### Issuance

Certificates are requested using the **DNS-01 challenge** — Mini Infra creates a validation TXT record in Cloudflare DNS, proves domain ownership, and receives the certificate. Wildcard domains (e.g., `*.example.com`) are supported.

Certificates and private keys are stored encrypted in the **configured storage backend** (Azure Blob Storage today, with Google Drive arriving in a later phase).

### Auto-Renewal

A background job checks for certificates expiring within a configurable **renewal window** (default 30 days). Renewed certificates are automatically deployed to HAProxy.

### Certificate Status

| Status | Meaning |
|--------|---------|
| **Pending** | ACME order initiated |
| **Active** | Issued and deployed |
| **Renewing** | Renewal in progress |
| **Expired** | Past expiration date |
| **Error** | Issuance or renewal failed |

Supported **ACME providers**: Let's Encrypt (production), Let's Encrypt Staging (testing), Buypass, ZeroSSL.

## Cloudflare Tunnels

Mini Infra monitors **Cloudflare Argo Tunnels** that provide secure public internet access to containers without opening firewall ports.

A tunnel is identified by its **UUID** and associated with an internet-type environment. Traffic flows from public hostnames through the tunnel to the **service URL** (the HAProxy endpoint inside the tunnel network).

Mini Infra tracks tunnel **health status** (connected, failed, timeout, unreachable) and **response time**. Status is cached with a 5-minute TTL to reduce Cloudflare API calls.

## Connected Services

Mini Infra integrates with four external services. Each has a **connectivity status** (connected, failed, timeout, unreachable) with response time and last-successful-connection tracking.

| Service | Required For | Key Configuration |
|---------|-------------|-------------------|
| **Docker** | All container and deployment features | Daemon endpoint (TCP or socket), registry credentials for private images |
| **Storage backend** | Backups, TLS certificate storage | Provider-specific credentials (Azure connection string today; Google Drive credentials in a later phase) |
| **Cloudflare** | Tunnels, DNS, TLS challenges | API token and account ID |
| **GitHub** | Authentication, bug reporting, package registry | OAuth app credentials |

The GitHub integration includes a **circuit breaker** — after 5 consecutive API failures, requests fail fast for 5 minutes before retrying.

## DNS Zones

Mini Infra manages DNS records through **Cloudflare DNS zones**. Zones and records are cached locally (5-minute TTL) to support validation and routing configuration.

Records can be **proxied** (traffic flows through Cloudflare's network) or **DNS-only** (direct resolution). Mini Infra creates DNS records automatically during TLS certificate issuance (ACME challenge TXT records) and tunnel configuration.

## Volumes

Mini Infra can list, inspect, and delete Docker **volumes**. The **volume inspector** launches a temporary Alpine container with the volume mounted to scan its filesystem — cataloging files with their sizes, permissions, and modification times. You can then fetch individual file contents (up to 1 MB) from the inspection results.

Volumes can only be deleted when no containers are using them.

## Docker Networks

Mini Infra manages **Docker networks** for container-to-container communication. Networks use the **bridge** driver by default (isolated network on the Docker host). Environment-scoped networks follow the naming pattern `{environment}-{purpose}`.

Networks can only be deleted when no containers are attached.

## API Keys

**API keys** provide programmatic access to Mini Infra for webhooks, scripts, and external tools. Each key is assigned permissions through a **permission preset** or custom scope list.

Permission scopes follow the format `resource:action` (e.g., `containers:read`, `deployments:write`). Built-in presets include Reader, Editor, and Admin. A key with no scope restrictions (`null` permissions) has **full access**.

Keys can be **rotated** (revoke old + create new) and track their **last-used timestamp**.

## Events

The **event system** provides an audit log and progress tracker for long-running operations — deployments, backups, certificate renewals, and container lifecycle changes.

Each event records:

- **Type** and **category** (infrastructure, database, security, maintenance)
- **Status** progression: pending, running, completed, failed, or cancelled
- **Trigger source**: manual, scheduled (cron), webhook, or API
- **Progress** percentage and step-by-step detail
- The **user** who initiated the operation and **duration** in milliseconds

Events stream in real time via Socket.IO and are persisted for auditing.

## Self-Update

Mini Infra can **update itself** in-place when running inside a Docker container. The update process pulls the new image, launches a sidecar container to health-check it, then swaps the old container for the new one. If the new container fails health checks, Mini Infra **automatically rolls back** to the previous version.

Database and configuration are preserved across updates because they live on mounted volumes.

## Agent Sidecar

The **agent sidecar** is an optional AI operations assistant that runs alongside Mini Infra in a separate container. It accepts natural language prompts and can diagnose issues, answer questions about your infrastructure, and perform operational tasks.

The sidecar has access to the Docker socket, the Mini Infra API, and user documentation. Conversations are persisted per user and support multi-turn context. Responses stream in real time via Server-Sent Events (SSE).
