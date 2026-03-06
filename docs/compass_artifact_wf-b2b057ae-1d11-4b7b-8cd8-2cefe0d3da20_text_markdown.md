# Docker container metrics on macOS and Windows without cAdvisor

**The Docker Engine API is the cross-platform answer.** Tools that query `/containers/{id}/stats` via the Docker socket work identically on macOS, Windows, and Linux — unlike cAdvisor, which reads Linux cgroup/proc filesystems directly and breaks on Docker Desktop. The best practical options in 2025 are **Telegraf with its Docker input plugin** (most mature and flexible) or a lightweight dedicated exporter like **davidborzek/docker-exporter** (simplest to deploy). Both provide per-container CPU, memory, network, and I/O metrics in Prometheus format by mounting only the Docker socket.

## Why cAdvisor fails on Docker Desktop — and can't be fixed

cAdvisor reads container metrics directly from Linux kernel interfaces: `/sys/fs/cgroup` for CPU and memory, `/proc` for process info, `/var/lib/docker` for filesystem layers, and `/dev/kmsg` for OOM events. Docker Desktop on macOS and Windows runs containers inside a lightweight Linux VM, creating a fundamental mismatch between what cAdvisor expects and what's actually accessible from bind mounts.

On **macOS Intel**, cAdvisor runs with significant degradation — warnings about missing NVM devices, OOM detection failure, and cgroup permission errors. Removing the `/var/lib/docker` mount eliminates some errors, and cAdvisor "degrades gracefully" to report partial metrics. On **Apple Silicon Macs (M1/M2/M3/M4), cAdvisor fatally crashes** because it cannot parse the ARM-format `/proc/cpuinfo` (which lacks the `cpu MHz` field it expects). This bug was reported as GitHub issue #3187 and **closed as "not planned"** — the cAdvisor team does not prioritize Docker Desktop compatibility. On **Windows with WSL2**, the `/var/lib/docker` path points to an empty directory because Docker Desktop stores data at a different WSL path, requiring a manual `drvfs` mount workaround.

The minimal cAdvisor configuration that partially works on macOS Intel is:

```yaml
services:
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.49.1
    privileged: true
    ports:
      - "8080:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:rw
      - /sys:/sys:ro
      # Deliberately omitting /var/lib/docker to avoid errors
```

This loses filesystem-per-container metrics and still produces warnings. **No maintained fork exists to fix these issues.** For any team with Apple Silicon Macs or Windows machines, cAdvisor is simply not viable.

## Docker's built-in Prometheus endpoint is daemon-only

Docker Engine has a native Prometheus metrics endpoint configured via `daemon.json`. On Docker Desktop, enable it through **Settings → Docker Engine**:

```json
{
  "metrics-addr": "127.0.0.1:9323"
}
```

This exposes metrics at `http://host.docker.internal:9323/metrics` from within containers. However, **these are engine-level metrics only** — container counts by state, daemon action durations, builder stats, and Go runtime metrics. It does not expose per-container CPU, memory, network, or I/O. Think of it as monitoring Docker itself, not your containers. It's useful as a complement to a container metrics exporter, but it cannot replace one.

## Telegraf is the most robust cross-platform solution

Telegraf's `inputs.docker` plugin queries the Docker Engine API through the socket, collecting comprehensive per-container metrics: **CPU usage (total, kernel, user, throttling), memory (usage, limit, cache, RSS, swap), network (rx/tx bytes, packets, errors per interface), and block I/O (read/write bytes per device)**. It labels everything with container name, image, ID, and Docker Compose project. The `outputs.prometheus_client` plugin then exposes these as a standard `/metrics` endpoint.

With **16,600+ GitHub stars** and active maintenance by InfluxData, Telegraf is the most battle-tested option. Its platform support is listed as "all" and it only needs the Docker socket — no `/proc`, `/sys`, or `/var/lib/docker`.

```toml
# telegraf.conf
[agent]
  interval = "10s"
  flush_interval = "10s"

[[inputs.docker]]
  endpoint = "unix:///var/run/docker.sock"
  gather_services = false
  perdevice = true
  total = false
  timeout = "5s"
  docker_label_include = []
  docker_label_exclude = []

[[outputs.prometheus_client]]
  listen = ":9273"
  metric_version = 2
  path = "/metrics"
```

The Docker Compose configuration is straightforward:

```yaml
services:
  telegraf:
    image: telegraf:latest
    volumes:
      - ./telegraf.conf:/etc/telegraf/telegraf.conf:ro
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "9273:9273"

  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"
```

With the Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: telegraf
    scrape_interval: 15s
    static_configs:
      - targets: ["telegraf:9273"]
```

Telegraf's plugin architecture is its biggest advantage — you can add system metrics, application metrics, or other inputs without deploying additional containers. The tradeoff is a larger image size (~250MB) compared to purpose-built exporters.

## Lightweight dedicated exporters for simpler setups

If Telegraf feels heavyweight for a dev monitoring stack, several single-purpose Go exporters wrap the Docker API stats endpoint into Prometheus format. The three most viable options:

**davidborzek/docker-exporter** is actively maintained, written in Go, and supports Docker Socket Proxy for security. It collects CPU percentage, memory usage/limit, network rx/tx, and block I/O per container. It requires zero configuration — just mount the socket:

```yaml
services:
  docker-exporter:
    image: ghcr.io/davidborzek/docker-exporter:latest
    user: root
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "8080:8080"
```

**jan4843/docker_stats_exporter** produces clean, well-named metrics that follow Prometheus conventions closely (`docker_container_cpu_seconds_total`, `docker_container_memory_usage_bytes`, `docker_container_blkio_read_bytes_total`). It supports Go template labels, allowing you to extract Docker Compose project names:

```yaml
services:
  docker_stats_exporter:
    build: https://github.com/jan4843/docker_stats_exporter.git
    environment:
      LABEL_compose_project: '{{index .Container.Labels "com.docker.compose.project"}}'
    ports:
      - "9338:9338"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

**OpenTelemetry Docker Stats Receiver** is the forward-looking choice, built into the OpenTelemetry Collector Contrib distribution. It queries the Docker stats API and can export to Prometheus via the OTel Prometheus exporter. It's more complex to configure but aligns with the broader observability ecosystem direction:

```yaml
receivers:
  docker_stats:
    endpoint: unix:///var/run/docker.sock
    collection_interval: 10s

exporters:
  prometheus:
    endpoint: "0.0.0.0:9464"

service:
  pipelines:
    metrics:
      receivers: [docker_stats]
      exporters: [prometheus]
```

## Complete recommended monitoring stack for Docker Desktop

For a dev environment Docker Compose monitoring stack that works identically across macOS, Windows, and Linux:

```yaml
services:
  # Your application containers...
  app:
    image: your-app:latest
    # ...

  # Container metrics exporter (pick one)
  docker-exporter:
    image: ghcr.io/davidborzek/docker-exporter:latest
    user: root
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "9417:8080"

  # Metrics storage and querying
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    ports:
      - "9090:9090"

  # Optional: dashboards
  grafana:
    image: grafana/grafana:latest
    volumes:
      - grafana-data:/var/lib/grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin

volumes:
  prometheus-data:
  grafana-data:
```

For enhanced security, use **Tecnativa/docker-socket-proxy** instead of mounting the Docker socket directly — it restricts which API endpoints the exporter can access:

```yaml
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      CONTAINERS: 1
      POST: 0
    ports:
      - "2375:2375"

  docker-exporter:
    image: ghcr.io/davidborzek/docker-exporter:latest
    environment:
      DOCKER_HOST: tcp://docker-socket-proxy:2375
    depends_on:
      - docker-socket-proxy
```

## Conclusion

The fundamental insight is simple: **anything that reads Linux kernel filesystems directly will break on Docker Desktop; anything that uses the Docker Engine API through the socket works everywhere.** cAdvisor chose the kernel-direct path for performance and depth on production Linux servers, making it unsuitable for cross-platform dev environments.

For most teams, **Telegraf with the Docker input plugin** offers the best balance of maturity, metric depth, flexibility, and cross-platform reliability. Teams wanting minimal overhead should use **davidborzek/docker-exporter** — a single lightweight container that just works. Both approaches produce identical results on macOS, Windows, and Linux because they talk to the same Docker API regardless of what's underneath.

The Docker daemon's built-in Prometheus endpoint (`metrics-addr`) is worth enabling as a complement for engine health visibility, but it cannot replace a container metrics exporter. Docker Desktop Extensions like the Grafana Cloud integration offer a zero-config GUI experience but lock you into Grafana Cloud's SaaS. For self-hosted Prometheus stacks, the socket-based exporters are the clear path forward.