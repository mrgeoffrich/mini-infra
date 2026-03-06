# Plan: Container Metrics Service (Prometheus + cAdvisor)

## Overview

Add a host-level monitoring service to Mini Infra that captures Docker container metrics over time using cAdvisor and Prometheus. Unlike existing services (e.g., HAProxy) which are scoped per-environment, this is a **host-level service** - one instance monitors all containers across all environments.

## Architecture

```
Docker Host
├── mini-infra (manages everything)
├── cadvisor (scrapes Docker API for container metrics)
├── prometheus (scrapes cadvisor, stores time-series)
├── Environment: production
│   ├── haproxy
│   └── app containers...
└── Environment: nonproduction
    ├── haproxy
    └── app containers...
```

**Data flow:** Docker socket -> cAdvisor (collects) -> Prometheus (scrapes every 15s, stores)

## Key Metrics Captured

Per container, cAdvisor exposes:
- `container_cpu_usage_seconds_total` - CPU time consumed
- `container_memory_usage_bytes` - Current memory usage
- `container_memory_working_set_bytes` - Memory actually in use (excludes cache)
- `container_network_receive_bytes_total` / `container_network_transmit_bytes_total` - Network I/O
- `container_fs_reads_bytes_total` / `container_fs_writes_bytes_total` - Disk I/O
- `container_last_seen` - Container liveness

## Docker Compose Setup

Created at `deployment/monitoring/docker-compose.yaml` with:
- **cAdvisor v0.51.0** - mounts host filesystems read-only, exposes metrics on port 8080
- **Prometheus v3.3.0** - scrapes cAdvisor, stores to persistent volume, 30-day retention (configurable)
- Health checks on both services
- Configurable ports via environment variables (`CADVISOR_PORT`, `PROMETHEUS_PORT`)
- Configurable retention via `PROMETHEUS_RETENTION`

## Implementation Plan

### Phase 1: Standalone Deployment (docker-compose only)

Already done. The `deployment/monitoring/` directory contains a working docker-compose setup that can be deployed independently:

```bash
cd deployment/monitoring
docker compose up -d
```

This works today with zero code changes to Mini Infra.

### Phase 2: Host-Level Service Concept

The current `IApplicationService` interface and `ServiceRegistry` are designed for environment-scoped services. To support host-level services, we need a new concept.

#### New "HostService" abstraction (like HAProxy pattern)

Introduce a parallel concept to environment services, where Mini Infra manages cAdvisor and Prometheus containers via Dockerode - the same way it manages HAProxy:

1. **New interface** `IHostService` in `server/src/services/interfaces/` - similar to `IApplicationService` but without environment binding. Lifecycle methods: `initialize()`, `start()`, `stop()`, `getStatus()`.

2. **New Prisma model** `HostService` - stores host-level service state:
   ```prisma
   model HostService {
     id          String   @id @default(cuid())
     serviceName String   @unique  // e.g., "monitoring"
     serviceType String              // e.g., "MonitoringService"
     status      String   @default("stopped")
     health      String   @default("unknown")
     config      String?  // JSON configuration
     startedAt   DateTime?
     stoppedAt   DateTime?
     lastError   String?
     createdAt   DateTime @default(now())
     updatedAt   DateTime @updatedAt
   }
   ```

3. **New `MonitoringService`** implementing `IHostService` - manages cAdvisor + Prometheus containers via Dockerode (same pattern as `HAProxyService` managing its containers).

4. **New API routes** under `/api/host-services` or `/api/monitoring`:
   - `GET /api/monitoring/status` - service health and Prometheus connection status
   - `POST /api/monitoring/start` - start cAdvisor + Prometheus
   - `POST /api/monitoring/stop` - stop the monitoring stack
   - `GET /api/monitoring/query` - proxy PromQL queries to Prometheus

### Phase 3: Prometheus Query API

Expose a backend endpoint that proxies queries to Prometheus's HTTP API, so the frontend can fetch metrics without direct Prometheus access.

Key endpoints to proxy:
- `GET /api/v1/query` - instant query (current value)
- `GET /api/v1/query_range` - range query (time series for charts)
- `GET /api/v1/targets` - scrape target health

Useful PromQL queries for the UI:
```promql
# CPU usage rate per container (last 5 minutes)
rate(container_cpu_usage_seconds_total{name!=""}[5m])

# Memory usage per container
container_memory_working_set_bytes{name!=""}

# Network receive rate per container
rate(container_network_receive_bytes_total{name!=""}[5m])

# Top 5 CPU consumers
topk(5, rate(container_cpu_usage_seconds_total{name!=""}[5m]))
```

### Phase 4: Frontend Dashboard

Add a metrics/monitoring page to the frontend:

1. **Container metrics overview** - table or card view showing current CPU, memory, network for each container (extends the existing containers page)
2. **Time-series charts** - using Recharts (already a dependency) to plot metrics over time
3. **Per-container detail view** - drill into a specific container's historical metrics
4. **Environment-level aggregation** - aggregate metrics by environment using container labels

### Phase 5: Alerting (Future)

Define Prometheus alerting rules for:
- Container memory exceeding threshold
- Container restart loops
- Container CPU sustained high usage
- Container stopped unexpectedly

Alerts can be surfaced through the existing Mini Infra notification system.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Metrics store | Prometheus | Industry standard for container metrics, native cAdvisor integration, powerful query language |
| Collector | cAdvisor | Google's standard tool, zero-config per-container metrics, Prometheus-native export |
| Service scope | Host-level (not per-environment) | One cAdvisor + Prometheus instance monitors all containers regardless of environment |
| Container management | Via Dockerode (like HAProxy) | Consistent with existing patterns, no external docker-compose dependency at runtime |
| Retention | 30 days default, configurable | Balance between storage cost and useful history |
| Frontend charting | Recharts | Already in the project dependencies |

## File Changes Summary

### New Files
- `deployment/monitoring/docker-compose.yaml` - standalone deployment (done)
- `deployment/monitoring/prometheus.yml` - Prometheus scrape config (done)
- `server/src/services/interfaces/host-service.ts` - IHostService interface
- `server/src/services/host/monitoring-service.ts` - MonitoringService implementation
- `server/src/routes/monitoring.ts` - API routes
- `client/src/pages/monitoring/` - Frontend dashboard

### Modified Files
- `server/prisma/schema.prisma` - add HostService model
- `server/src/routes/index.ts` - register monitoring routes
- `client/src/router.tsx` - add monitoring page route
- `lib/types/` - add monitoring-related types

## Resolved Decisions

1. **Prometheus managed by Mini Infra** - Yes. Just like Mini Infra manages HAProxy containers via Dockerode, it should manage the deployment of cAdvisor and Prometheus the same way. The docker-compose file in `deployment/monitoring/` serves as a reference/standalone option, but the primary path is Mini Infra managing these containers directly.
2. **No Grafana** - Charts will be built natively in the React frontend using Recharts.
3. **Permissions** - New `monitoring:read` / `monitoring:write` permissions, matching the API routes we add.
4. **No resource limits** - cAdvisor and Prometheus containers run without memory/CPU constraints.
