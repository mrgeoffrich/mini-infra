# HAProxy Data Plane API Configuration Reference

## File Format & Location
- **Format**: YAML
- **Version 2.8+**: `/etc/haproxy/dataplaneapi.yml`
- **Version ≤2.7**: `/etc/haproxy/dataplaneapi.hcl`
- **Required**: `config_version: 2`

## Minimal Configuration
```yaml
config_version: 2
dataplaneapi:
  host: 0.0.0.0
  port: 5555
  user:
    - name: admin
      password: adminpwd
      insecure: true
haproxy:
  config_file: /etc/haproxy/haproxy.cfg
  haproxy_bin: /usr/sbin/haproxy
```

## Structure Overview
```yaml
config_version: 2              # Required
name: <string>                  # Optional API server name
dataplaneapi:                   # API settings
  # ... API configuration
haproxy:                        # HAProxy settings
  # ... HAProxy configuration
log_targets:                    # Logging configuration
  # ... Log targets
```

## dataplaneapi Section

### Basic Settings
```yaml
dataplaneapi:
  host: 0.0.0.0                 # Listen address
  port: 5555                    # Listen port
  socket_path: <path>           # Unix socket path
  scheme:                       # Enabled listeners
    - http
    - https
  show_system_info: false       # Show system info on /info
  disable_inotify: false        # Disable config file watching
  uid: 1000                     # User ID to run as
  gid: 1000                     # Group ID to run as
  pid_file: /tmp/dataplane.pid  # PID file location
```

### Authentication
```yaml
dataplaneapi:
  # Simple user auth
  user:
    - name: admin
      password: adminpwd
      insecure: true            # Plain text password
  
  # HAProxy userlist auth
  userlist:
    userlist: controller        # Userlist name in HAProxy config
    userlist_file: /etc/haproxy/userlist.cfg
```

### TLS Configuration
```yaml
dataplaneapi:
  tls:
    tls_host: 0.0.0.0
    tls_port: 5555
    tls_certificate: /path/to/cert.pem
    tls_key: /path/to/key.pem
    tls_ca: /path/to/ca.pem     # Optional CA cert
    tls_keep_alive: 1m
    tls_listen_limit: 10
    tls_read_timeout: 10s
    tls_write_timeout: 10s
```

### Transaction Management
```yaml
dataplaneapi:
  transaction:
    transaction_dir: /etc/haproxy/transactions
    backups_number: 10          # Config backups to keep
    backups_dir: /etc/haproxy/backups
    max_open_transactions: 20   # Concurrent transactions limit
```

### Resource Directories
```yaml
dataplaneapi:
  resources:
    maps_dir: /etc/haproxy/maps
    ssl_certs_dir: /etc/haproxy/ssl
    general_storage_dir: /etc/haproxy/general
    spoe_dir: /etc/haproxy/spoe
    spoe_transaction_dir: /tmp/spoe-haproxy
    dataplane_storage_dir: /etc/haproxy/dataplane
    update_map_files: false     # Sync map files with runtime
    update_map_files_period: 10 # Seconds between syncs
```

### Timeouts & Limits
```yaml
dataplaneapi:
  read_timeout: 30s
  write_timeout: 60s
  graceful_timeout: 15s
  cleanup_timeout: 10s
  listen_limit: 1024            # Max connections
  max_header_size: 1MiB
```

### Advanced Settings
```yaml
dataplaneapi:
  advertised:                   # Advertised API address
    api_address: 10.2.3.4
    api_port: 80
  debug_socket_path: /var/run/dataplane-debug.sock
```

## haproxy Section

### Basic HAProxy Settings
```yaml
haproxy:
  config_file: /etc/haproxy/haproxy.cfg
  haproxy_bin: /usr/sbin/haproxy
  master_worker_mode: true      # Enable master-worker helpers
  master_runtime: /var/run/haproxy/master.sock
  fid: /etc/haproxy/fid         # File for Data Plane API ID
```

### Reload Configuration
```yaml
haproxy:
  reload:
    reload_delay: 5             # Min seconds between reloads
    reload_retention: 1         # Days to keep reload history
    reload_strategy: systemd    # systemd, s6, or custom
    service_name: haproxy       # Service name (systemd/s6)
    
    # Custom strategy commands
    reload_cmd: "systemctl reload haproxy"
    restart_cmd: "systemctl restart haproxy"
    status_cmd: "systemctl status haproxy"
    validate_cmd: /usr/local/bin/validate.sh
```

### Startup Delays
```yaml
haproxy:
  delayed_start_max: 30s        # Max wait for runtime socket
  delayed_start_tick: 500ms     # Check interval
```

## log_targets Section

### Multiple Log Targets
```yaml
log_targets:
  - log_to: stdout              # stdout, file, or syslog
    log_level: info             # trace, debug, info, warning, error
    log_format: json            # text or json
    log_types:                  # Log types to include
      - app
      - access
  
  - log_to: file
    log_file: /var/log/dataplaneapi.log
    log_level: debug
    log_format: text
    log_types:
      - app
  
  - log_to: syslog
    syslog_address: 127.0.0.1   # Address or socket path
    syslog_protocol: tcp        # tcp, tcp4, tcp6, unix, unixgram
    syslog_tag: dataplaneapi
    syslog_level: debug         # Syslog severity level
    syslog_facility: local0     # Syslog facility
    log_types:
      - access
```

## Common Patterns

### Production Setup
```yaml
config_version: 2
name: prod-dataplane
dataplaneapi:
  host: 0.0.0.0
  port: 5555
  scheme:
    - https
  tls:
    tls_host: 0.0.0.0
    tls_port: 5555
    tls_certificate: /etc/ssl/api.pem
    tls_key: /etc/ssl/api.key
  userlist:
    userlist: api_users
    userlist_file: /etc/haproxy/userlist.cfg
  transaction:
    transaction_dir: /var/lib/haproxy/transactions
    backups_number: 20
    max_open_transactions: 10
  resources:
    maps_dir: /etc/haproxy/maps
    ssl_certs_dir: /etc/haproxy/ssl
haproxy:
  config_file: /etc/haproxy/haproxy.cfg
  haproxy_bin: /usr/sbin/haproxy
  master_worker_mode: true
  reload:
    reload_delay: 5
    reload_strategy: systemd
    service_name: haproxy
log_targets:
  - log_to: file
    log_file: /var/log/haproxy-dataplane.log
    log_level: info
    log_types: [app, access]
```

### Development Setup
```yaml
config_version: 2
dataplaneapi:
  host: localhost
  port: 5555
  scheme: [http]
  user:
    - name: dev
      password: devpass
      insecure: true
  show_system_info: true
haproxy:
  config_file: ./haproxy.cfg
  haproxy_bin: haproxy
  reload:
    reload_delay: 1
    reload_strategy: custom
    reload_cmd: "haproxy -f haproxy.cfg -sf $(cat haproxy.pid)"
log_targets:
  - log_to: stdout
    log_level: debug
    log_format: text
    log_types: [app, access]
```

## Key Notes
- All paths must be absolute
- Timeouts accept duration strings (e.g., "30s", "1m", "500ms")
- Boolean values: true/false (lowercase)
- Arrays use YAML list syntax with `-`
- reload_strategy options: `systemd`, `s6`, `custom`
- log levels: `trace`, `debug`, `info`, `warning`, `error`
- Syslog facilities: `kern`, `user`, `mail`, `daemon`, `auth`, `syslog`, `lpr`, `news`, `uucp`, `cron`, `authpriv`, `ftp`, `local0-7`