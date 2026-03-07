# Loki + Alloy Logging Plan

## Overview

Add centralised log collection to the existing monitoring Docker Compose stack using **Grafana Alloy** (collector) and **Grafana Loki** (storage/query engine). Alloy replaces the now-EOL Promtail and collects logs via the Docker socket API — no Linux-specific filesystem paths, so it works identically on Docker Desktop (macOS/Windows) and native Linux.

**Phase 1** captures stdout/stderr from every container automatically. **Phase 2** adds file-based log tailing for specific containers (e.g. HAProxy access logs written to files inside the container).

---

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Container A │    │  Container B │    │  HAProxy     │
│  (stdout)    │    │  (stdout)    │    │  (stdout +   │
│              │    │              │    │   log files)  │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       └───────────┬───────┘                   │
                   │                           │
            Docker Socket API           Shared Volume
                   │                    (Phase 2 only)
                   ▼                           │
          ┌────────────────┐                   │
          │  Grafana Alloy │◄──────────────────┘
          │  (collector)   │
          └───────┬────────┘
                  │ HTTP push
                  ▼
          ┌────────────────┐
          │  Grafana Loki  │
          │  (log store)   │
          │  :3100         │
          └───────┬────────┘
                  │ LogQL queries
                  ▼
          ┌────────────────┐
          │  Your App      │
          │  (Logs Page)   │
          │  queries Loki  │
          │  HTTP API      │
          └────────────────┘
```

---

## Phase 1: Stdout/Stderr Collection from All Containers

### 1.1 Add Loki to Docker Compose

Loki runs in monolithic (single-process) mode, which is appropriate for development and small-scale production.

```yaml
  loki:
    image: grafana/loki:3.6.0
    command: -config.file=/etc/loki/local-config.yaml
    volumes:
      - ./monitoring/loki-config.yaml:/etc/loki/local-config.yaml:ro
      - loki-data:/loki
    ports:
      - "3100:3100"
    restart: unless-stopped
```

Add `loki-data` to the `volumes:` section at the bottom of the Compose file.

### 1.2 Loki Configuration File

Create `monitoring/loki-config.yaml`:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: "2024-04-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 168h          # 7 days — adjust as needed
  max_query_length: 721h

compactor:
  working_directory: /loki/compactor
  delete_request_store: filesystem
  retention_enabled: true
  compaction_interval: 10m
  retention_delete_delay: 2h
```

### 1.3 Add Alloy to Docker Compose

Alloy discovers containers via the Docker socket and pulls their stdout/stderr logs through the Docker API (not the filesystem).

```yaml
  alloy:
    image: grafana/alloy:latest
    user: root                          # Needed for Docker socket access
    volumes:
      - ./monitoring/config.alloy:/etc/alloy/config.alloy:ro
      - /var/run/docker.sock:/var/run/docker.sock
    command: run /etc/alloy/config.alloy --server.http.listen-addr=0.0.0.0:12345
    ports:
      - "12345:12345"                   # Alloy debug/status UI
    depends_on:
      - loki
    restart: unless-stopped
```

### 1.4 Alloy Configuration File (Phase 1)

Create `monitoring/config.alloy`:

```hcl
// ============================================================
// Phase 1: Collect stdout/stderr from ALL Docker containers
// ============================================================

// Discover every running container via the Docker socket
discovery.docker "local" {
  host = "unix:///var/run/docker.sock"
}

// Extract useful labels from container metadata
discovery.relabel "docker_labels" {
  targets = discovery.docker.local.targets

  // Clean container name (strip leading slash)
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/(.*)"
    target_label  = "container"
  }

  // Image name
  rule {
    source_labels = ["__meta_docker_container_image_name"]
    target_label  = "image"
  }

  // Docker Compose service name (if present)
  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]
    target_label  = "compose_service"
  }

  // Docker Compose project name (if present)
  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]
    target_label  = "compose_project"
  }
}

// Collect logs via the Docker API (NOT filesystem — cross-platform safe)
loki.source.docker "stdout" {
  host          = "unix:///var/run/docker.sock"
  targets       = discovery.docker.local.targets
  relabel_rules = discovery.relabel.docker_labels.rules
  forward_to    = [loki.write.local.receiver]
}

// Ship logs to Loki
loki.write "local" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}
```

### 1.5 Verify It Works

After `docker compose up -d`:

1. **Alloy debug UI** — visit `http://localhost:12345` to see the component graph and confirm `loki.source.docker` is healthy and targets are discovered.
2. **Loki direct query** — `curl -s "http://localhost:3100/loki/api/v1/labels" | jq` should return labels like `container`, `image`, `compose_service`.
3. **Query logs** — `curl -sG "http://localhost:3100/loki/api/v1/query_range" --data-urlencode 'query={compose_service=~".+"}' --data-urlencode 'limit=10' | jq` should return log entries.

---

## Loki Storage: Does It Need Persistent Storage?

**Yes.** Without a volume, all ingested logs are lost when the container restarts. Loki writes two things to disk:

- **Chunks** — the actual compressed log data, stored at `/loki/chunks`
- **TSDB index** — the label index used to find log streams quickly, stored alongside chunks

The `loki-data` named Docker volume in the Compose config above handles this. Named volumes persist across container restarts and `docker compose down` (they are only removed by `docker compose down -v` or `docker volume rm`).

**Storage sizing estimate:** Loki compresses aggressively. A typical Docker Compose dev environment generating ~50 MB/day of raw logs will use roughly 5–10 MB/day on disk after compression. With the 7-day retention configured above, expect ~50–100 MB of persistent storage in a dev environment.

For production, consider setting `retention_period` based on your compliance needs and monitoring disk usage on the volume.

---

## The Logs Page: Querying Loki

### How It Works

Loki exposes a REST API that accepts **LogQL** queries (syntax modelled after PromQL). Your app's Logs page sends HTTP requests to Loki and renders the results.

### Key Loki API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /loki/api/v1/query_range` | Query logs over a time range (main endpoint) |
| `GET /loki/api/v1/query` | Query logs at a single point in time |
| `GET /loki/api/v1/labels` | List all available label names |
| `GET /loki/api/v1/label/{name}/values` | List values for a specific label |
| `GET /loki/api/v1/tail` | WebSocket endpoint for live log streaming |

### Query Examples (LogQL)

```
# All logs from a specific container
{container="haproxy"}

# All logs from a compose service
{compose_service="api"}

# Full-text filter (case-sensitive contains)
{compose_service="api"} |= "error"

# Case-insensitive regex filter
{compose_service="api"} |~ "(?i)(error|warn|fatal)"

# Exclude noisy lines
{container="haproxy"} != "health_check"

# Multiple filters chained
{compose_service="api"} |= "error" != "expected"

# Parse JSON logs and filter on a field
{compose_service="api"} | json | level="error"

# Parse HAProxy log format and filter by response time > 500ms
{container="haproxy"} | pattern "<_> <_> <frontend>/<backend> <Tq>/<Tw>/<Tc>/<Tr>/<Tt>" | Tt > 500
```

### Logs Page Implementation Approach

The Logs page in your app queries Loki's HTTP API directly. Here is the basic flow:

**1. Fetch available containers (for the filter dropdown):**

```
GET http://localhost:3100/loki/api/v1/label/compose_service/values
→ ["api", "haproxy", "postgres", "redis"]
```

**2. Query logs for a selected service and time range:**

```
GET http://localhost:3100/loki/api/v1/query_range
  ?query={compose_service="api"} |= "error"
  &start=1709640000000000000    // nanosecond epoch
  &end=1709726400000000000
  &limit=500
  &direction=backward           // newest first
```

**Response structure:**

```json
{
  "status": "success",
  "data": {
    "resultType": "streams",
    "result": [
      {
        "stream": {
          "container": "myapp-api-1",
          "compose_service": "api",
          "image": "myapp:latest"
        },
        "values": [
          ["1709726399000000000", "2024-03-06T12:00:00Z ERROR: connection refused"],
          ["1709726398000000000", "2024-03-06T11:59:59Z ERROR: timeout exceeded"]
        ]
      }
    ]
  }
}
```

Each entry in `values` is a `[timestamp_nanos, log_line]` pair.

**3. Live tail (optional, via WebSocket):**

```
WS ws://localhost:3100/loki/api/v1/tail?query={compose_service="api"}
```

This streams new log lines as they arrive — useful for a "follow" mode on the Logs page.

### UI Recommendations

The Logs page should provide:

- **Service/container dropdown** — populated from `/label/compose_service/values` or `/label/container/values`
- **Time range selector** — last 15m, 1h, 6h, 24h, or custom range
- **Search text input** — injected into the LogQL query as `|= "search term"` or `|~ "regex"`
- **Log level filter** — if your containers output structured/JSON logs, filter on `| json | level="error"`
- **Direction toggle** — newest-first vs oldest-first (the `direction` param)
- **Auto-refresh / live tail** — use the WebSocket tail endpoint for real-time streaming
- **Log line expansion** — click a log line to see full text + labels (container, image, timestamp)

---

## Phase 2: Adding File-Based Log Collection

Some containers write logs to files inside the container rather than (or in addition to) stdout. HAProxy with rsyslog, Nginx with access/error logs, and custom apps with file-based logging are common examples.

### Strategy: Shared Named Volumes

The cross-platform approach is to use a **Docker named volume** shared between the application container and Alloy. Named volumes are managed by Docker's storage driver and work identically on Linux, macOS Docker Desktop, and Windows Docker Desktop.

### Step 2.1: Add the Shared Volume

In Docker Compose, add a named volume and mount it into both the app container and Alloy:

```yaml
  haproxy:
    image: haproxy:2.9
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - haproxy-logs:/var/log/haproxy           # HAProxy writes here

  alloy:
    image: grafana/alloy:latest
    user: root
    volumes:
      - ./monitoring/config.alloy:/etc/alloy/config.alloy:ro
      - /var/run/docker.sock:/var/run/docker.sock
      - haproxy-logs:/var/log/haproxy:ro        # Alloy reads here (read-only)

volumes:
  haproxy-logs:
```

### Step 2.2: Extend the Alloy Configuration

Append to `config.alloy` below the Phase 1 config:

```hcl
// ============================================================
// Phase 2: Tail log FILES from shared volumes
// ============================================================

// --- HAProxy file-based logs ---
local.file_match "haproxy_logs" {
  path_targets = [
    { "__path__" = "/var/log/haproxy/*.log" },
  ]
  sync_period = "5s"
}

loki.source.file "haproxy_logs" {
  targets    = local.file_match.haproxy_logs.targets
  forward_to = [loki.process.haproxy_labels.receiver]
}

loki.process "haproxy_labels" {
  forward_to = [loki.write.local.receiver]

  stage.static_labels {
    values = {
      job       = "haproxy-files",
      component = "haproxy",
      source    = "file",
    }
  }
}
```

### Step 2.3: Adding More File Sources Later

To add another container's file-based logs, follow the same pattern:

1. Create a named volume in Docker Compose
2. Mount it (read-write) into the app container at the path it writes logs
3. Mount it (read-only) into Alloy
4. Add a `local.file_match` + `loki.source.file` + `loki.process` block to config.alloy

Example for Nginx:

```hcl
local.file_match "nginx_logs" {
  path_targets = [
    { "__path__" = "/var/log/nginx/access.log" },
    { "__path__" = "/var/log/nginx/error.log" },
  ]
}

loki.source.file "nginx_logs" {
  targets    = local.file_match.nginx_logs.targets
  forward_to = [loki.process.nginx_labels.receiver]
}

loki.process "nginx_labels" {
  forward_to = [loki.write.local.receiver]

  stage.static_labels {
    values = {
      job       = "nginx-files",
      component = "nginx",
      source    = "file",
    }
  }
}
```

The `source` label ("file" vs the default "docker" from Phase 1) lets you distinguish on the Logs page whether a log line came from stdout or a file.

### Alternative: Syslog Receiver (Network-Based, No Volumes)

For containers that support syslog output natively (like HAProxy), Alloy can receive syslog over TCP/UDP. This avoids shared volumes entirely:

Add to `config.alloy`:

```hcl
loki.source.syslog "network" {
  listener {
    address  = "0.0.0.0:1514"
    protocol = "tcp"
    labels   = { job = "syslog", source = "syslog" }
  }
  forward_to = [loki.write.local.receiver]
}
```

Expose port 1514 on the Alloy container, then configure HAProxy to log to `alloy:1514` via syslog. This is fully cross-platform since it is plain TCP between containers.

---

## Checklist

### Phase 1 — Stdout/Stderr
- [ ] Create `monitoring/loki-config.yaml`
- [ ] Create `monitoring/config.alloy` (Phase 1 section)
- [ ] Add `loki` service to Docker Compose
- [ ] Add `alloy` service to Docker Compose
- [ ] Add `loki-data` named volume to Docker Compose
- [ ] `docker compose up -d` and verify Alloy UI at :12345
- [ ] Verify Loki labels endpoint returns data at :3100
- [ ] Build Logs page querying Loki `/api/v1/query_range`
- [ ] Add live tail via Loki WebSocket `/api/v1/tail`

### Phase 2 — File-Based Logs
- [ ] Add shared named volume(s) to Docker Compose
- [ ] Mount volumes into app containers (rw) and Alloy (ro)
- [ ] Add `local.file_match` + `loki.source.file` blocks to config.alloy
- [ ] Verify file-sourced logs appear in Loki with `source="file"` label
- [ ] Update Logs page to allow filtering by `source` label

---

## Quick Reference

| Service | Port | URL | Purpose |
|---------|------|-----|---------|
| Loki | 3100 | `http://localhost:3100` | Log storage + query API |
| Alloy | 12345 | `http://localhost:12345` | Collector debug UI + component graph |
| Alloy syslog | 1514 | (TCP, no browser UI) | Syslog receiver (Phase 2) |
