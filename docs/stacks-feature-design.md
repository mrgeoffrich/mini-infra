# Stacks Feature Design

## Overview

A **Stack** is a declarative definition of one or more containers, their config files, shared resources (networks/volumes), and optional HAProxy routing. Stacks replace the current hardcoded `IApplicationService` implementations with data-driven definitions that support drift detection, diffing, and plan/apply semantics.

## Goals

- Define container infrastructure as structured data (not imperative TypeScript)
- Detect drift between desired state and running containers
- Show a clear diff ("plan") before applying changes
- Per-service updates within a stack
- Unified model for HAProxy routing alongside container definitions
- Config file content stored in DB and editable via UI
- Full version snapshots for rollback

## Phase 1 Scope

- Stack and StackService data models
- Stack reconciler (plan/apply engine)
- Seed utility to convert existing MonitoringService and HAProxyService into stacks
- Plan/Apply diff UI bolted onto existing environment/monitoring pages
- Config file templating with variable interpolation
- Init commands for volume prep (chown, mkdir, etc.)

## Phase 2 (Future)

- Migrate DeploymentConfiguration to stacks
- Full stack management UI (create/edit stacks from scratch)
- Import from docker-compose YAML
- Secret store for environment variables

---

## Data Model

### Stack

| Field | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| name | String | Unique per environment |
| description | String? | Human-readable description |
| environmentId | String | FK to Environment |
| version | Int | Increments on every definition change |
| status | Enum | synced, drifted, pending, error, undeployed |
| lastAppliedVersion | Int? | Version that is currently running (null if never deployed) |
| lastAppliedAt | DateTime? | When last apply completed |
| lastAppliedSnapshot | Json? | Frozen copy of full stack definition at apply time |
| networks | Json | Array of { name, driver?, options? } |
| volumes | Json | Array of { name, driver?, options? } |
| createdAt | DateTime | |
| updatedAt | DateTime | |

### StackService

| Field | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| stackId | String | FK to Stack |
| serviceName | String | e.g. "telegraf", "prometheus", "haproxy" |
| serviceType | Enum | `Stateful` or `StatelessWeb` (extensible — more types can be added later) |
| dockerImage | String | e.g. "prom/prometheus" |
| dockerTag | String | e.g. "v3.3.0" |
| containerConfig | Json | Full container configuration (see below) |
| configFiles | Json? | Files to write to volumes before container start |
| dependsOn | Json | Array of service names within this stack |
| order | Int | Deploy order (lower = first) |
| routing | Json? | HAProxy routing config (required for StatelessWeb, forbidden for Stateful) |
| createdAt | DateTime | |
| updatedAt | DateTime | |

**Unique constraint**: (stackId, serviceName)

### Service Types

The `serviceType` field on StackService determines deployment strategy, routing requirements, and validation rules. Designed to be extensible — new types can be added as needs evolve.

| Type | Routing | Deployment Strategy | Use Case |
|---|---|---|---|
| `Stateful` | Forbidden | Stop old, start new (simple replace) | Databases, monitoring, message queues, any service that owns persistent data or doesn't need zero-downtime |
| `StatelessWeb` | Required | Blue-green via existing orchestrator | Web apps, APIs, any service that needs zero-downtime updates behind HAProxy |

**Validation rules:**
- `StatelessWeb` services **must** have a `routing` block — they exist to serve traffic
- `Stateful` services **must not** have a `routing` block — they're internal/infrastructure
- `serviceType` determines which apply strategy the reconciler uses (see Apply section)

**Future types (not in scope for Phase 1):**
- `CronJob` — scheduled containers that run and exit
- `Sidecar` — lifecycle tied to another service
- `Worker` — stateless but no routing (e.g. queue consumers), could use rolling restart

### containerConfig Schema

```typescript
interface StackContainerConfig {
  command?: string[];
  entrypoint?: string[];
  user?: string;
  env?: Record<string, string>;
  ports?: { containerPort: number; hostPort: number; protocol: 'tcp' | 'udp' }[];
  mounts?: { source: string; target: string; type: 'volume' | 'bind'; readOnly?: boolean }[];
  labels?: Record<string, string>;
  restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  healthcheck?: {
    test: string[];
    interval: number;   // seconds
    timeout: number;    // seconds
    retries: number;
    startPeriod: number; // seconds
  };
  logConfig?: {
    type: string;
    maxSize: string;
    maxFile: string;
  };
}
```

### configFiles Schema

```typescript
interface StackConfigFile {
  volumeName: string;       // which volume to write to
  path: string;             // path within the volume, e.g. "/config/prometheus.yml"
  content: string;          // file content (supports template interpolation)
  permissions?: string;     // e.g. "666"
  ownerUid?: number;        // chown uid
  ownerGid?: number;        // chown gid
}
```

### initCommands Schema

For arbitrary volume preparation beyond config file writes:

```typescript
interface StackInitCommand {
  volumeName: string;       // volume to mount
  mountPath: string;        // where to mount it in the init container
  commands: string[];       // shell commands to run, e.g. ["mkdir -p /data", "chown -R 65534:65534 /data"]
}
```

These are stored alongside `configFiles` in a `initCommands` Json field on StackService.

### routing Schema (StatelessWeb only)

```typescript
interface StackServiceRouting {
  hostname: string;
  listeningPort: number;       // container port HAProxy routes to
  enableSsl?: boolean;
  tlsCertificateId?: string;
  backendOptions?: {
    balanceAlgorithm?: 'roundrobin' | 'leastconn' | 'source';
    checkTimeout?: number;
    connectTimeout?: number;
    serverTimeout?: number;
  };
  dns?: {
    provider: 'cloudflare' | 'external';  // "external" = manually managed, skip creation
    zoneId?: string;                       // cloudflare zone
    recordType?: 'A' | 'CNAME';           // default: A
    proxied?: boolean;                     // cloudflare orange-cloud proxy
  };
}
```

DNS is part of the routing block because it serves the same concern: "make this service reachable at this hostname." The reconciler uses the environment's `networkType` to decide behavior:
- `local` environment + `cloudflare` provider: create/update/remove Cloudflare A record pointing to Docker host
- `internet` environment or `external` provider: skip DNS creation (assumes externally managed)

DNS records are created after the container and HAProxy route are confirmed healthy. On service removal, the DNS record is cleaned up.

---

## Config File Templating

Config file `content` supports variable interpolation using `{{variable}}` syntax. Variables are resolved at **plan time** (before apply).

### Available Variables

| Variable | Resolves To | Example |
|---|---|---|
| `{{stack.name}}` | Stack name | `monitoring` |
| `{{stack.projectName}}` | Environment-prefixed project name | `prod-monitoring` |
| `{{services.<name>.containerName}}` | Full container name for a service | `prod-monitoring-loki` |
| `{{services.<name>.image}}` | Full image:tag | `grafana/loki:3.6.0` |
| `{{env.<key>}}` | Environment variable from the service | |
| `{{volumes.<name>}}` | Resolved volume name (with env prefix) | `prod-monitoring-loki_data` |
| `{{networks.<name>}}` | Resolved network name | `prod-monitoring-monitoring_network` |

### Example

Alloy config references the Loki container name:

```
loki.write "local" {
  endpoint {
    url = "http://{{services.loki.containerName}}:3100/loki/api/v1/push"
  }
}
```

Prometheus config references the Telegraf container:

```yaml
scrape_configs:
  - job_name: telegraf
    static_configs:
      - targets: ['{{services.telegraf.containerName}}:9273']
```

---

## Stack Reconciler

### plan(stack) -> StackPlan

1. Resolve all template variables in config files
2. For each StackService, compute a **definition hash** from:
   - dockerImage + dockerTag
   - containerConfig (normalized/sorted JSON)
   - resolved configFiles content
   - initCommands
   - routing
3. Find matching running container by project labels (`mini-infra.stack`, `mini-infra.service`)
4. Compare:
   - No container found -> action: `create`
   - Container found, image differs -> action: `recreate`, reason: "image changed X -> Y"
   - Container found, config hash differs -> action: `recreate`, reason: specific diff fields
   - Config file content changed -> action: `recreate`, reason: "config file X changed"
   - Everything matches -> action: `no-op`
5. Running containers with stack labels but no matching service definition -> action: `remove`

### StackPlan Shape

```typescript
interface StackPlan {
  stackId: string;
  stackName: string;
  stackVersion: number;
  planTime: Date;
  actions: ServiceAction[];
  hasChanges: boolean;         // convenience: any action != no-op
}

interface ServiceAction {
  serviceName: string;
  action: 'create' | 'recreate' | 'remove' | 'no-op';
  reason?: string;
  diff?: FieldDiff[];          // what specifically changed
  currentImage?: string;       // what's running now
  desiredImage?: string;       // what would be deployed
}

interface FieldDiff {
  field: string;               // e.g. "dockerTag", "configFiles[0].content", "containerConfig.env.LOG_LEVEL"
  old: string | null;
  new: string | null;
}
```

### apply(plan, options) -> ApplyResult

Options allow per-service targeting:

```typescript
interface ApplyOptions {
  serviceNames?: string[];     // if provided, only apply these services (default: all)
  dryRun?: boolean;            // validate only, don't execute
}
```

**Apply steps for a single service (determined by `serviceType`):**

1. **recreate — Stateful**:
   - Stop old container (graceful shutdown with timeout)
   - Run init commands if changed (temp Alpine container)
   - Write config files if changed (temp Alpine container)
   - Pull image if needed
   - Create new container with full config
   - Start container
   - Wait for healthcheck to pass (with timeout)
   - If healthcheck fails: log error, mark service as failed, do NOT remove old container (keep for debugging)

2. **recreate — StatelessWeb** (blue-green):
   - Run init commands if changed (temp Alpine container)
   - Write config files if changed (temp Alpine container)
   - Pull image if needed
   - Start new container alongside old
   - Wait for healthcheck to pass on new container
   - Update HAProxy backend to point to new container
   - Drain connections from old container
   - Remove old container
   - If healthcheck fails on new: remove new container, keep old running, mark as failed

3. **create**:
   - Run init commands (temp Alpine container)
   - Write config files (temp Alpine container)
   - Pull image
   - Create and start container
   - Wait for healthcheck
   - If routing defined: add HAProxy route

4. **remove**:
   - If routing defined: remove HAProxy route
   - Stop and remove container

**After all service actions:**

5. Reconcile HAProxy: sync all routes from StackServices with `routing` fields
6. Store `lastAppliedSnapshot` = full frozen stack definition
7. Set `lastAppliedVersion` = current `version`
8. Update `status` = `synced`

### ApplyResult Shape

```typescript
interface ApplyResult {
  success: boolean;
  stackId: string;
  appliedVersion: number;
  serviceResults: ServiceApplyResult[];
  duration: number;            // total ms
}

interface ServiceApplyResult {
  serviceName: string;
  action: string;
  success: boolean;
  duration: number;
  error?: string;
  containerId?: string;        // new container ID if created
}
```

---

## Container Labels

Stack-managed containers get these labels for discovery:

| Label | Example |
|---|---|
| `mini-infra.stack` | `monitoring` |
| `mini-infra.stack-id` | `clx123...` |
| `mini-infra.service` | `telegraf` |
| `mini-infra.environment` | `prod-env-id` |
| `mini-infra.definition-hash` | `sha256:abc123...` |
| `mini-infra.stack-version` | `3` |

The `definition-hash` label on the running container enables fast drift detection without needing to `docker inspect` every field — just compare the label hash to the computed hash from the current definition.

---

## Seeding: Converting Existing Services to Stacks

A `seedStackFromService()` utility creates Stack records from the current hardcoded implementations:

### Monitoring Stack Seed

```
Stack: "monitoring"
  networks: [{ name: "monitoring_network", driver: "bridge" }]
  volumes: [{ name: "prometheus_data" }, { name: "loki_data" }]

  StackService: "telegraf"
    serviceType: Stateful
    image: telegraf:latest
    configFiles: [{ volumeName: "prometheus_data", path: "/config/telegraf.conf", content: <telegraf.conf> }]
    dependsOn: ["prometheus"]

  StackService: "prometheus"
    serviceType: Stateful
    image: prom/prometheus:v3.3.0
    configFiles: [{ volumeName: "prometheus_data", path: "/config/prometheus.yml", content: <prometheus.yml>, ownerUid: 65534, ownerGid: 65534 }]
    initCommands: [{ volumeName: "prometheus_data", mountPath: "/prometheus", commands: ["mkdir -p /prometheus/config /prometheus/data", "chown -R 65534:65534 /prometheus/data"] }]

  StackService: "loki"
    serviceType: Stateful
    image: grafana/loki:3.6.0
    configFiles: [{ volumeName: "loki_data", path: "/config/local-config.yaml", content: <loki.yaml> }]
    initCommands: [{ volumeName: "loki_data", mountPath: "/loki", commands: ["mkdir -p /loki/config /loki/rules /loki/chunks /loki/compactor", "chown -R 10001:10001 /loki"] }]

  StackService: "alloy"
    serviceType: Stateful
    image: grafana/alloy:latest
    configFiles: [{ volumeName: "loki_data", path: "/config/config.alloy", content: <alloy.conf with {{services.loki.containerName}} template> }]
    dependsOn: ["loki"]
```

### HAProxy Stack Seed

```
Stack: "haproxy"
  networks: [{ name: "haproxy_network", driver: "bridge" }]
  volumes: [{ name: "haproxy_data" }, { name: "haproxy_run" }, { name: "haproxy_config" }, { name: "haproxy_certs" }]

  StackService: "haproxy"
    serviceType: Stateful
    image: haproxytech/haproxy-alpine:3.2
    configFiles: [
      { volumeName: "haproxy_config", path: "/haproxy.cfg", content: <haproxy.cfg> },
      { volumeName: "haproxy_config", path: "/dataplaneapi.yml", content: <dataplaneapi.yml> },
      { volumeName: "haproxy_config", path: "/domain-backend.map", content: <domain-backend.map> }
    ]
```

---

## API Endpoints

### Stack Plan & Apply

| Method | Path | Description |
|---|---|---|
| GET | `/api/stacks/:stackId/plan` | Compute and return the plan (no side effects) |
| POST | `/api/stacks/:stackId/apply` | Apply changes (body: `{ serviceNames?: string[], dryRun?: boolean }`) |
| GET | `/api/stacks/:stackId/status` | Current status with per-service container state |
| GET | `/api/stacks/:stackId/history` | List of applied version snapshots |
| GET | `/api/stacks/:stackId/history/:version` | Specific snapshot with diff from previous |

### Stack CRUD (for Phase 2 full UI, but build the API now)

| Method | Path | Description |
|---|---|---|
| GET | `/api/stacks` | List all stacks (filterable by environmentId) |
| GET | `/api/stacks/:stackId` | Get stack with all services |
| POST | `/api/stacks` | Create new stack |
| PUT | `/api/stacks/:stackId` | Update stack definition (bumps version) |
| DELETE | `/api/stacks/:stackId` | Delete stack (must be undeployed) |
| PUT | `/api/stacks/:stackId/services/:serviceName` | Update single service definition |

---

## UI: Plan/Apply Diff View (Phase 1)

The plan/apply UI is a component that can be embedded in the existing environment or monitoring pages.

### Plan View

Shows a list of services with their planned action:

```
Stack: monitoring (v3 -> v4)
--------------------------------------------
  prometheus     no change
  telegraf       RECREATE  "image tag changed: 1.32 -> 1.33"
  loki           RECREATE  "config file changed: local-config.yaml"
  alloy          no change
--------------------------------------------
[Apply All]  [Apply Selected]
```

Clicking a service with changes expands to show the diff:

```
telegraf - RECREATE
  Image: telegraf:1.32 -> telegraf:1.33

loki - RECREATE
  Config file: /config/local-config.yaml
  - retention_period: 168h
  + retention_period: 336h
```

### Apply Progress

After clicking Apply, show real-time progress:

```
Applying stack: monitoring (v4)
  telegraf    [stopping old...]
  telegraf    [writing config files...]
  telegraf    [pulling image...]
  telegraf    [starting container...]
  telegraf    [healthcheck passed]     OK
  loki        [stopping old...]
  loki        [writing config files...]
  loki        [starting container...]
  loki        [healthcheck passed]     OK

Applied successfully in 34s
```

---

## Migration Strategy

1. **Build Stack/StackService Prisma models** and reconciler engine
2. **Build seed utility** that creates Stack records from current MonitoringService/HAProxyService
3. **Add plan/apply API endpoints**
4. **Build plan/apply diff UI component**, embed in environment page
5. **Run in parallel**: existing IApplicationService still handles start/stop, stacks are used for updates/drift detection
6. **Cut over**: environment start/stop delegates to stack reconciler
7. **Remove** hardcoded MonitoringService/HAProxyService deploy methods (keep health check and status logic)

---

## Open Design Decisions

- **Rollback UX**: Dont worry about rollback.
- **Concurrent applies**: Lock per-stack to prevent concurrent applies? Probably yes via a simple DB flag.
- **Health check timeout**: How long to wait for healthcheck before marking as failed? Configurable per-service with a sensible default (60s?) - this is configured against the StackContainerConfig
- **Image pull policy**: Always pull.
