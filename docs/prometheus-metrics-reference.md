# Prometheus Metrics Reference

## Stack Overview

- **Prometheus**: `prom/prometheus:v3.3.0` on port `9090`
- **Telegraf**: `telegraf:latest` on port `9273`
- **Config**: `deployment/monitoring/`

## Active Scrape Targets

| Job | URL | Status |
|-----|-----|--------|
| `telegraf` | `http://monitoring-telegraf:9273/metrics` | up |
| `haproxy` | `http://host.docker.internal:8404/metrics` | up |

**Telegraf** uses the `inputs.docker` plugin (reads `/var/run/docker.sock`) and exposes metrics via `outputs.prometheus_client` on `:9273/metrics`.

**HAProxy** exposes metrics via its native Prometheus exporter (built-in `prometheus-exporter` service on the stats frontend, port `8404`). This is managed automatically by mini-infra remediation.

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

## HAProxy Metrics Reference

These metrics come from HAProxy's native Prometheus exporter. Labels include `proxy` (frontend/backend name) and `server` (server name within a backend).

### HAProxy Process

| Metric | Description |
|--------|-------------|
| `haproxy_process_uptime_seconds` | Process uptime |
| `haproxy_process_start_time_seconds` | Process start timestamp |
| `haproxy_process_build_info` | Build version info |
| `haproxy_process_nbthread` | Number of threads |
| `haproxy_process_current_connections` | Current active connections |
| `haproxy_process_connections_total` | Total connections accepted |
| `haproxy_process_current_connection_rate` | Current connection rate |
| `haproxy_process_max_connection_rate` | Max observed connection rate |
| `haproxy_process_max_connections` | Configured connection limit |
| `haproxy_process_hard_max_connections` | Hard connection limit |
| `haproxy_process_requests_total` | Total requests processed |
| `haproxy_process_current_session_rate` | Current session rate |
| `haproxy_process_max_session_rate` | Max observed session rate |
| `haproxy_process_current_ssl_connections` | Current SSL connections |
| `haproxy_process_ssl_connections_total` | Total SSL connections |
| `haproxy_process_current_ssl_rate` | Current SSL rate |
| `haproxy_process_max_ssl_rate` | Max SSL rate |
| `haproxy_process_max_ssl_connections` | Max concurrent SSL connections |
| `haproxy_process_current_frontend_ssl_key_rate` | Frontend SSL key rate |
| `haproxy_process_current_backend_ssl_key_rate` | Backend SSL key rate |
| `haproxy_process_frontend_ssl_reuse` | Frontend SSL session reuse ratio |
| `haproxy_process_ssl_cache_lookups_total` | SSL cache lookups |
| `haproxy_process_ssl_cache_misses_total` | SSL cache misses |
| `haproxy_process_bytes_out_total` | Total bytes sent |
| `haproxy_process_bytes_out_rate` | Current byte output rate |
| `haproxy_process_spliced_bytes_out_total` | Spliced bytes (zero-copy) |
| `haproxy_process_http_comp_bytes_in_total` | Compression input bytes |
| `haproxy_process_http_comp_bytes_out_total` | Compression output bytes |
| `haproxy_process_limit_connection_rate` | Configured connection rate limit |
| `haproxy_process_limit_session_rate` | Configured session rate limit |
| `haproxy_process_limit_ssl_rate` | Configured SSL rate limit |
| `haproxy_process_limit_http_comp` | Compression rate limit |
| `haproxy_process_current_run_queue` | Tasks in run queue |
| `haproxy_process_current_tasks` | Total tasks |
| `haproxy_process_idle_time_percent` | Idle time percentage |
| `haproxy_process_jobs` | Current jobs |
| `haproxy_process_unstoppable_jobs` | Unstoppable jobs |
| `haproxy_process_listeners` | Active listeners |
| `haproxy_process_active_peers` | Active peers |
| `haproxy_process_connected_peers` | Connected peers |
| `haproxy_process_pool_allocated_bytes` | Memory pool allocated |
| `haproxy_process_pool_used_bytes` | Memory pool in use |
| `haproxy_process_pool_failures_total` | Pool allocation failures |
| `haproxy_process_max_fds` | Max file descriptors |
| `haproxy_process_max_sockets` | Max sockets |
| `haproxy_process_max_pipes` | Max pipes |
| `haproxy_process_pipes_used_total` | Pipes in use |
| `haproxy_process_pipes_free_total` | Free pipes |
| `haproxy_process_current_zlib_memory` | Current zlib memory |
| `haproxy_process_max_zlib_memory` | Max zlib memory |
| `haproxy_process_max_memory_bytes` | Configured memory limit |
| `haproxy_process_dropped_logs_total` | Dropped log messages |
| `haproxy_process_recv_logs_total` | Received log messages |
| `haproxy_process_failed_resolutions` | Failed DNS resolutions |
| `haproxy_process_busy_polling_enabled` | Busy polling flag |
| `haproxy_process_stopping` | Stopping flag (0/1) |
| `haproxy_process_nbproc` | Number of processes |
| `haproxy_process_relative_process_id` | Relative process ID |
| `haproxy_process_total_warnings` | Total warnings emitted |
| `haproxy_process_max_backend_ssl_key_rate` | Max backend SSL key rate |
| `haproxy_process_max_frontend_ssl_key_rate` | Max frontend SSL key rate |
| `haproxy_process_node` | Node name info label |

### HAProxy Frontend

Labels: `proxy` (frontend name, e.g. `stats`, `http_frontend_<id>`)

| Metric | Description |
|--------|-------------|
| `haproxy_frontend_status` | Frontend status (1=OPEN, 0=STOP) |
| `haproxy_frontend_current_sessions` | Current active sessions |
| `haproxy_frontend_sessions_total` | Total sessions |
| `haproxy_frontend_current_session_rate` | Current session rate |
| `haproxy_frontend_max_session_rate` | Max observed session rate |
| `haproxy_frontend_max_sessions` | Max concurrent sessions |
| `haproxy_frontend_limit_sessions` | Configured session limit |
| `haproxy_frontend_limit_session_rate` | Configured session rate limit |
| `haproxy_frontend_bytes_in_total` | Total bytes received |
| `haproxy_frontend_bytes_out_total` | Total bytes sent |
| `haproxy_frontend_connections_total` | Total connections |
| `haproxy_frontend_connections_rate_max` | Max connection rate |
| `haproxy_frontend_http_requests_total` | Total HTTP requests |
| `haproxy_frontend_http_requests_rate_max` | Max HTTP request rate |
| `haproxy_frontend_http_responses_total` | HTTP responses by status code |
| `haproxy_frontend_http_cache_hits_total` | HTTP cache hits |
| `haproxy_frontend_http_cache_lookups_total` | HTTP cache lookups |
| `haproxy_frontend_http_comp_bytes_in_total` | Compression input bytes |
| `haproxy_frontend_http_comp_bytes_out_total` | Compression output bytes |
| `haproxy_frontend_http_comp_bytes_bypassed_total` | Compression bypassed bytes |
| `haproxy_frontend_http_comp_responses_total` | Compressed responses |
| `haproxy_frontend_request_errors_total` | Request errors |
| `haproxy_frontend_requests_denied_total` | Denied requests (ACL) |
| `haproxy_frontend_responses_denied_total` | Denied responses (ACL) |
| `haproxy_frontend_denied_connections_total` | Denied connections |
| `haproxy_frontend_denied_sessions_total` | Denied sessions |
| `haproxy_frontend_intercepted_requests_total` | Intercepted requests (redirect/stats) |
| `haproxy_frontend_failed_header_rewriting_total` | Failed header rewrites |
| `haproxy_frontend_internal_errors_total` | Internal errors |

### HAProxy Backend

Labels: `proxy` (backend name, e.g. `test-nginx`)

| Metric | Description |
|--------|-------------|
| `haproxy_backend_status` | Backend status (1=UP, 0=DOWN) |
| `haproxy_backend_active_servers` | Active (non-backup) server count |
| `haproxy_backend_backup_servers` | Backup server count |
| `haproxy_backend_current_sessions` | Current active sessions |
| `haproxy_backend_sessions_total` | Total sessions |
| `haproxy_backend_current_session_rate` | Current session rate |
| `haproxy_backend_max_session_rate` | Max observed session rate |
| `haproxy_backend_max_sessions` | Max concurrent sessions |
| `haproxy_backend_limit_sessions` | Configured session limit |
| `haproxy_backend_bytes_in_total` | Total bytes received |
| `haproxy_backend_bytes_out_total` | Total bytes sent |
| `haproxy_backend_http_requests_total` | Total HTTP requests |
| `haproxy_backend_http_responses_total` | HTTP responses by status code |
| `haproxy_backend_http_cache_hits_total` | HTTP cache hits |
| `haproxy_backend_http_cache_lookups_total` | HTTP cache lookups |
| `haproxy_backend_http_comp_bytes_in_total` | Compression input bytes |
| `haproxy_backend_http_comp_bytes_out_total` | Compression output bytes |
| `haproxy_backend_http_comp_bytes_bypassed_total` | Compression bypassed bytes |
| `haproxy_backend_http_comp_responses_total` | Compressed responses |
| `haproxy_backend_connect_time_average_seconds` | Avg connect time |
| `haproxy_backend_response_time_average_seconds` | Avg response time |
| `haproxy_backend_queue_time_average_seconds` | Avg queue time |
| `haproxy_backend_total_time_average_seconds` | Avg total session time |
| `haproxy_backend_max_connect_time_seconds` | Max connect time |
| `haproxy_backend_max_response_time_seconds` | Max response time |
| `haproxy_backend_max_queue_time_seconds` | Max queue time |
| `haproxy_backend_max_total_time_seconds` | Max total session time |
| `haproxy_backend_current_queue` | Requests in queue |
| `haproxy_backend_max_queue` | Max queue depth |
| `haproxy_backend_connection_attempts_total` | Connection attempts to servers |
| `haproxy_backend_connection_reuses_total` | Connection reuses |
| `haproxy_backend_connection_errors_total` | Connection errors |
| `haproxy_backend_response_errors_total` | Response errors |
| `haproxy_backend_requests_denied_total` | Denied requests (ACL) |
| `haproxy_backend_responses_denied_total` | Denied responses (ACL) |
| `haproxy_backend_retry_warnings_total` | Retry warnings |
| `haproxy_backend_redispatch_warnings_total` | Redispatch warnings |
| `haproxy_backend_client_aborts_total` | Client-side aborts |
| `haproxy_backend_server_aborts_total` | Server-side aborts |
| `haproxy_backend_loadbalanced_total` | Times load-balanced |
| `haproxy_backend_downtime_seconds_total` | Total backend downtime |
| `haproxy_backend_check_up_down_total` | Health check transitions |
| `haproxy_backend_check_last_change_seconds` | Seconds since last status change |
| `haproxy_backend_last_session_seconds` | Seconds since last session |
| `haproxy_backend_failed_header_rewriting_total` | Failed header rewrites |
| `haproxy_backend_internal_errors_total` | Internal errors |
| `haproxy_backend_weight` | Total effective weight |
| `haproxy_backend_uweight` | Total initial weight |
| `haproxy_backend_agg_server_status` | Aggregated server status |
| `haproxy_backend_agg_server_check_status` | Aggregated server check status |
| `haproxy_backend_agg_check_status` | Aggregated check status |

### HAProxy Server

Labels: `proxy` (backend name), `server` (server name, e.g. `test-nginx-5d4ac1c1`)

| Metric | Description |
|--------|-------------|
| `haproxy_server_status` | Server status (1=UP, 0=DOWN, etc.) |
| `haproxy_server_active` | Active server flag |
| `haproxy_server_backup` | Backup server flag |
| `haproxy_server_current_sessions` | Current active sessions |
| `haproxy_server_sessions_total` | Total sessions |
| `haproxy_server_current_session_rate` | Current session rate |
| `haproxy_server_max_session_rate` | Max observed session rate |
| `haproxy_server_max_sessions` | Max concurrent sessions |
| `haproxy_server_limit_sessions` | Configured session limit |
| `haproxy_server_bytes_in_total` | Total bytes received |
| `haproxy_server_bytes_out_total` | Total bytes sent |
| `haproxy_server_http_requests_total` | Total HTTP requests |
| `haproxy_server_http_responses_total` | HTTP responses by status code |
| `haproxy_server_connect_time_average_seconds` | Avg connect time |
| `haproxy_server_response_time_average_seconds` | Avg response time |
| `haproxy_server_queue_time_average_seconds` | Avg queue time |
| `haproxy_server_total_time_average_seconds` | Avg total session time |
| `haproxy_server_max_connect_time_seconds` | Max connect time |
| `haproxy_server_max_response_time_seconds` | Max response time |
| `haproxy_server_max_queue_time_seconds` | Max queue time |
| `haproxy_server_max_total_time_seconds` | Max total session time |
| `haproxy_server_current_queue` | Requests queued for this server |
| `haproxy_server_max_queue` | Max queue depth |
| `haproxy_server_queue_limit` | Queue limit |
| `haproxy_server_connection_attempts_total` | Connection attempts |
| `haproxy_server_connection_reuses_total` | Connection reuses |
| `haproxy_server_connection_errors_total` | Connection errors |
| `haproxy_server_response_errors_total` | Response errors |
| `haproxy_server_responses_denied_total` | Denied responses (ACL) |
| `haproxy_server_retry_warnings_total` | Retry warnings |
| `haproxy_server_redispatch_warnings_total` | Redispatch warnings |
| `haproxy_server_client_aborts_total` | Client-side aborts |
| `haproxy_server_server_aborts_total` | Server-side aborts |
| `haproxy_server_loadbalanced_total` | Times selected by load balancer |
| `haproxy_server_downtime_seconds_total` | Total server downtime |
| `haproxy_server_check_status` | Last health check status |
| `haproxy_server_check_code` | Last health check response code |
| `haproxy_server_check_duration_seconds` | Last health check duration |
| `haproxy_server_check_failures_total` | Health check failures |
| `haproxy_server_check_up_down_total` | Health check transitions |
| `haproxy_server_check_last_change_seconds` | Seconds since last status change |
| `haproxy_server_last_session_seconds` | Seconds since last session |
| `haproxy_server_current_throttle` | Current throttle percentage |
| `haproxy_server_idle_connections_current` | Idle connections |
| `haproxy_server_idle_connections_limit` | Idle connection limit |
| `haproxy_server_safe_idle_connections_current` | Safe idle connections |
| `haproxy_server_unsafe_idle_connections_current` | Unsafe idle connections |
| `haproxy_server_need_connections_current` | Needed connections |
| `haproxy_server_used_connections_current` | Used connections |
| `haproxy_server_failed_header_rewriting_total` | Failed header rewrites |
| `haproxy_server_internal_errors_total` | Internal errors |
| `haproxy_server_weight` | Effective weight |
| `haproxy_server_uweight` | Initial weight |

### HAProxy DNS Resolver

Labels: `nameserver`, `resolver`

| Metric | Description |
|--------|-------------|
| `haproxy_resolver_sent` | Queries sent |
| `haproxy_resolver_valid` | Valid responses |
| `haproxy_resolver_update` | DNS updates applied |
| `haproxy_resolver_cname` | CNAME responses |
| `haproxy_resolver_cname_error` | CNAME errors |
| `haproxy_resolver_any_err` | Any errors |
| `haproxy_resolver_nx` | NXDOMAIN responses |
| `haproxy_resolver_timeout` | Query timeouts |
| `haproxy_resolver_refused` | Refused responses |
| `haproxy_resolver_other` | Other response types |
| `haproxy_resolver_invalid` | Invalid responses |
| `haproxy_resolver_too_big` | Oversized responses |
| `haproxy_resolver_truncated` | Truncated responses |
| `haproxy_resolver_outdated` | Outdated responses |
| `haproxy_resolver_send_error` | Send errors |

---

## Notes

- **Stale `container_*` metrics**: cAdvisor-format metrics (`container_cpu_*`, `container_memory_*`, etc.) may appear in Prometheus from a previous cAdvisor setup. They are no longer scraped — they will expire after the 30-day retention window.
- **Data retention**: 30 days (configured via `PROMETHEUS_RETENTION` env var, default `30d`)
- **Prometheus UI**: `http://localhost:9090`
- **Telegraf metrics endpoint**: `http://localhost:9273/metrics`
