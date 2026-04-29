# Egress Gateway

Per-environment HTTP/HTTPS forward proxy. Containers in an environment with egress firewall enabled have their outbound traffic routed through this gateway, which enforces an allowlist on destination hostnames before letting requests leave.

Built on Stripe's [Smokescreen](https://github.com/stripe/smokescreen) — we own the proxy listener and admin server, and hot-swap ACL config via an `ACLSwapper` whenever the server pushes new rules.

## Structure

```
egress-gateway/
├── cmd/
│   └── main.go            # Entry point: load config → start admin + Smokescreen proxy
├── internal/
│   ├── config/            # Env-var-driven config (LoadGatewayConfig)
│   ├── admin/             # Admin HTTP API (rule push, container map sync, health)
│   ├── proxy/             # ACLSwapper + NDJSON log hook for canonical decisions
│   └── state/             # Per-env rule state (in-memory)
├── Dockerfile
└── go.mod
```

## Build & Run

```bash
# Build via root pnpm wrapper (preferred — produces image used by the server)
pnpm build:egress-gateway

# Or directly
cd egress-gateway && go build ./cmd/...
cd egress-gateway && go test ./...
```

## Architecture Notes

- **Shared module:** Imports `egress-shared/state` (container map) and `egress-shared/log`. Workspace wiring is in the repo-root `go.work`.
- **ACL hot-swap:** `proxy.NewACLSwapper()` lets the admin API replace the in-memory ACL atomically without restarting the proxy listener.
- **Log shape:** Smokescreen's `CANONICAL-PROXY-DECISION` entries are intercepted by `NewNDJSONLogHook()` and re-emitted in the `EgressEvent` shape that the server's log ingester consumes. Do not change the log shape without updating the ingester.
- **State sync:** The admin API receives container-map updates from the server (which container IPs map to which environment) so the gateway can attribute requests to environments.

## Conventions

- **Companion to `egress-fw-agent`.** The agent enforces L3/L4 (nftables) on the host; the gateway enforces L7 (hostname allowlist) for HTTP/HTTPS. Keep responsibilities in the right module.
- Don't add database access here — the gateway is a stateless proxy fed by the server. All durable state lives server-side.
