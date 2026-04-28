# mini-infra-egress-sidecar

Per-environment DNS firewall sidecar for Mini Infra. Runs as a container on each environment's applications bridge network, filters DNS queries against stack egress policies, and logs every decision as structured JSON.

## How it works

Each managed container in an environment has its DNS resolver set to the sidecar's pinned gateway IP. The mini-infra-server pushes rules (stack policies) and a container-IP-to-stack/service map via the admin HTTP API. On each DNS query, the sidecar:

1. Looks up the source IP in the container map to identify which stack/service is querying.
2. Looks up that stack's egress policy and matches the queried domain against the rule trie.
3. In **detect mode**: forwards upstream regardless of the match, but logs what the decision _would_ have been.
4. In **enforce mode**: forwards if allowed; returns NXDOMAIN if blocked. AAAA queries always return NXDOMAIN (IPv4-only).
5. Emits one JSON log line per decision (with dedup windowing to prevent log flooding).

Mini-infra-server tails container logs to ingest these decisions as audit events.

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 53 | UDP + TCP | DNS server |
| 8054 | TCP | Admin HTTP API |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DNS_PORT` | `53` | DNS server listen port |
| `ADMIN_PORT` | `8054` | Admin HTTP API listen port |
| `UPSTREAM_DNS` | `1.1.1.1,8.8.8.8` | Upstream resolvers (comma-separated, tried in order) |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `DEDUP_WINDOW_MS` | `1000` | Rate-limit window (ms) for identical DNS log entries |
| `QUERY_TIMEOUT_MS` | `2000` | Per-query upstream timeout (ms) |

## Admin API

- `POST /admin/rules` — full snapshot replace of all stack policies
- `POST /admin/container-map` — full snapshot replace of the container-IP map
- `GET /admin/health` — health check with version and upstream status
- `GET /admin/stats` — query counters since startup

## Build

```bash
cd egress-sidecar
npm install
npm run build
```

## Docker

Build from the repo root (same directory as this README's parent):

```bash
docker build -t mini-infra-egress-sidecar egress-sidecar/
```

## Tests

```bash
cd egress-sidecar
npm test
```
