# Prometheus Metrics Reference

## Stack Overview

- **Prometheus**: `prom/prometheus:v3.3.0` on port `9090`
- **Telegraf**: `telegraf:latest` on port `9273`
- **Config**: `deployment/monitoring/`

## Active Scrape Target

| Job | URL | Status |
|-----|-----|--------|
| `telegraf` | `http://monitoring-telegraf:9273/metrics` | up |

Telegraf uses the `inputs.docker` plugin (reads `/var/run/docker.sock`) and exposes metrics via `outputs.prometheus_client` on `:9273/metrics`.

**Scrape interval**: 15s (Prometheus) / 10s (Telegraf agent flush)

**Telegraf collection settings** (`telegraf.conf`):
- `perdevice_include = ["cpu"]` — per-device CPU stats collected per container
- `total_include = ["cpu", "blkio", "network"]` — blkio and network collected as totals only

---

## Metrics Reference

### Docker Host Summary

| Metric | Description |
|--------|-------------|
| `docker_n_containers` | Total container count |
| `docker_n_containers_running` | Running containers |
| `docker_n_containers_paused` | Paused containers |
| `docker_n_containers_stopped` | Stopped containers |
| `docker_n_cpus` | Host CPU count |
| `docker_n_images` | Total image count |
| `docker_memory_total` | Host total memory bytes |
| `docker_n_goroutines` | Go runtime goroutines |
| `docker_n_used_file_descriptors` | Open file descriptors |
| `docker_n_listener_events` | Docker event listener count |

### Per-Container CPU

| Metric | Description |
|--------|-------------|
| `docker_container_cpu_usage_percent` | CPU usage % |
| `docker_container_cpu_usage_total` | Total CPU nanoseconds |
| `docker_container_cpu_usage_in_kernelmode` | Kernel mode CPU ns |
| `docker_container_cpu_usage_in_usermode` | User mode CPU ns |
| `docker_container_cpu_usage_system` | System CPU ns |
| `docker_container_cpu_throttling_periods` | Total throttling periods |
| `docker_container_cpu_throttling_throttled_periods` | Throttled periods count |
| `docker_container_cpu_throttling_throttled_time` | Total throttled time ns |

### Per-Container Memory

| Metric | Description |
|--------|-------------|
| `docker_container_mem_usage` | Current memory usage bytes |
| `docker_container_mem_usage_percent` | Memory usage % of limit |
| `docker_container_mem_limit` | Memory limit bytes |
| `docker_container_mem_max_usage` | Peak memory usage bytes |
| `docker_container_mem_active_anon` | Active anonymous memory |
| `docker_container_mem_inactive_anon` | Inactive anonymous memory |
| `docker_container_mem_active_file` | Active file-backed memory |
| `docker_container_mem_inactive_file` | Inactive file-backed memory |
| `docker_container_mem_pgfault` | Page faults (minor) |
| `docker_container_mem_pgmajfault` | Page faults (major) |
| `docker_container_mem_unevictable` | Non-evictable memory bytes |

### Per-Container Network (totals)

| Metric | Description |
|--------|-------------|
| `docker_container_net_rx_bytes` | Bytes received |
| `docker_container_net_tx_bytes` | Bytes transmitted |
| `docker_container_net_rx_packets` | Packets received |
| `docker_container_net_tx_packets` | Packets transmitted |
| `docker_container_net_rx_errors` | Receive errors |
| `docker_container_net_tx_errors` | Transmit errors |
| `docker_container_net_rx_dropped` | Dropped inbound packets |
| `docker_container_net_tx_dropped` | Dropped outbound packets |

### Per-Container Block I/O (totals)

| Metric | Description |
|--------|-------------|
| `docker_container_blkio_io_service_bytes_recursive_read` | Disk bytes read |
| `docker_container_blkio_io_service_bytes_recursive_write` | Disk bytes written |

### Per-Container Status

| Metric | Description |
|--------|-------------|
| `docker_container_status_pid` | Container process ID |
| `docker_container_status_restart_count` | Number of restarts |
| `docker_container_status_uptime_ns` | Uptime in nanoseconds |
| `docker_container_status_oomkilled` | OOM killed flag (0/1) |
| `docker_container_status_exitcode` | Last exit code |
| `docker_container_status_started_at` | Start timestamp |
| `docker_container_status_finished_at` | Finish timestamp |
| `docker_container_health_failing_streak` | Consecutive health check failures |

---

## Notes

- **Stale `container_*` metrics**: cAdvisor-format metrics (`container_cpu_*`, `container_memory_*`, etc.) may appear in Prometheus from a previous cAdvisor setup. They are no longer scraped — they will expire after the 30-day retention window.
- **Data retention**: 30 days (configured via `PROMETHEUS_RETENTION` env var, default `30d`)
- **Prometheus UI**: `http://localhost:9090`
- **Telegraf metrics endpoint**: `http://localhost:9273/metrics`
