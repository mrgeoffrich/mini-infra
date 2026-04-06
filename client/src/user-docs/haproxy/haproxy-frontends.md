---
title: Managing HAProxy Frontends
category: haproxy
order: 2
description: How to view, create, and configure HAProxy frontends in Mini Infra
tags:
  - haproxy
  - frontends
  - load-balancer
  - routing
  - ssl
---

# Managing HAProxy Frontends

The Frontends page lists all HAProxy frontend connections across your environments. From here you can view details, create new manual connections, and manage existing frontends.

## Viewing Frontends

The frontends table shows each frontend's name, hostname routes, environment, status, and SSL state. Use the filter controls to narrow the list:

- **Type** --- Filter by Deployment, Manual, or Shared.
- **Environment** --- Show frontends from a specific environment.
- **Status** --- Filter by Active, Pending, or Failed.
- **Search** --- Search by frontend name, hostname, or container name.

Click any row to open the frontend details page.

## Frontend Types

| Type | Description | Editable? |
|------|-------------|-----------|
| Shared | Routes traffic to multiple containers by hostname | View routes |
| Manual | User-created connection to a specific container | Edit / Delete |
| Deployment | Auto-managed by the deployment system | Read-only |

## Connecting a Container

Click **Connect Container** to launch the step-by-step wizard:

### Step 1: Select Environment

Choose the HAProxy environment where the connection will be created.

### Step 2: Choose Container

A list of eligible containers is shown with status indicators:

- **Can Connect** --- The container is on the HAProxy network and ready.
- **Needs Network Join** --- The container is not on the HAProxy network but can be joined automatically.
- **Cannot Connect** --- The container cannot be connected (for example, it is not running).

Select a container and set the port it listens on.

### Step 3: Configure Frontend

- **Hostname** --- The domain name for routing traffic to this container.
- **Enable SSL/TLS** --- When enabled, a TLS certificate is automatically found or issued.
- **Health Check Path** --- The HTTP path HAProxy uses to verify the container is healthy (defaults to `/`).

### Step 4: Review and Create

Review the full configuration summary including any validation checks (container running, network connectivity, hostname availability). Click **Create Frontend** to start the connection process.

The system will:

1. Join the container to the HAProxy network (if needed).
2. Validate container connectivity.
3. Find or issue a TLS certificate (if SSL is enabled).
4. Deploy the certificate to HAProxy.
5. Create the backend, frontend, and routing rule.

A progress dialog shows each step in real time.

## Frontend Details

The details page shows:

- **Overview** --- Type, status, environment, and timestamps.
- **Routing Configuration** --- Bind address, port, and SSL settings.
- **Container Details** --- Container name, ID, and port (manual frontends).
- **Routes Table** --- All hostname-based routes (shared frontends).

If the frontend has a failed status, the error message is displayed in the overview section.

## Editing a Manual Frontend

On the details page for a manual frontend, click **Edit** to change:

- **Hostname** --- Update the routing hostname.
- **SSL/TLS** --- Enable or disable SSL, and select a specific TLS certificate.

The environment, container, and port cannot be changed. To connect a different container, delete the frontend and create a new one.

## Deleting a Manual Frontend

Click **Delete** on the details page. The confirmation dialog lists what will be removed:

- Routing rule and ACL on the shared frontend.
- Backend and server entries in HAProxy.
- TLS termination configuration (the certificate file itself is retained).

The container will keep running after deletion --- only the HAProxy routing is removed.
