---
title: Load Balancer Overview
description: An overview of how HAProxy load balancing works in Mini Infra
tags:
  - haproxy
  - load-balancer
  - networking
  - routing
---

# Load Balancer Overview

Mini Infra uses HAProxy to route external traffic to your Docker containers. HAProxy acts as a reverse proxy and load balancer, handling incoming HTTP and HTTPS requests and forwarding them to the correct backend containers based on hostname.

## Key Concepts

### Frontends

A frontend defines how HAProxy listens for incoming traffic. Each frontend is bound to an address and port and uses hostname-based routing rules to direct requests to the right backend.

There are three types of frontends:

- **Shared** --- A load-balancing frontend that routes traffic to multiple containers by hostname. This is the main entry point for HTTP/HTTPS traffic in an environment.
- **Manual** --- A user-created connection between a specific container and HAProxy, routed through a shared frontend via hostname rules.
- **Deployment** --- Automatically created and managed by the deployment system. These are read-only.

### Backends

A backend is a group of servers (container endpoints) that receive traffic from a frontend. Each backend has a load-balancing algorithm (round robin, least connections, or source IP) and health check configuration.

### Instances

Each HAProxy-enabled environment has an HAProxy instance. The Instances page shows the health status of all instances and provides remediation and migration tools.

### Routes

Routes are hostname-based rules on a shared frontend that map incoming requests to specific backends. When you connect a container via the manual frontend wizard, a route is automatically created on the shared frontend.

## How Traffic Flows

1. A request arrives at the HAProxy shared frontend on the configured port.
2. HAProxy inspects the hostname in the request.
3. The matching route forwards the request to the correct backend.
4. The backend selects a server based on the configured load-balancing algorithm.
5. The server (your container) handles the request and returns the response.

## SSL/TLS

When SSL is enabled on a frontend connection, HAProxy terminates TLS at the edge. Mini Infra can automatically find an existing certificate or issue a new one during the connection process. Certificates are managed on the [TLS Certificates](/help/networking/tls-certificates) page.

## Getting Started

- **Connect a container** --- Go to **Frontends** and click **Connect Container** to create a manual frontend connection with the step-by-step wizard.
- **View backends** --- Go to **Backends** to see all backend server groups and their health.
- **Check instance health** --- Go to **Instances** to monitor HAProxy health across environments and run remediation if needed.
