# Egress Firewall Agent

Host-level firewall agent that enforces L3/L4 egress rules via nftables and emits NFLOG events for visibility into blocked/allowed traffic. Companion to `egress-gateway` (which enforces the L7 hostname allowlist).

The server pushes rule changes to the agent over a Unix-domain socket admin API; the agent applies them to nftables and persists them so they survive agent restarts (boot-time reconcile).

## Structure

```
egress-fw-agent/
├── cmd/
│   └── main.go              # Entry point: admin API + NFLOG reader + boot reconcile
├── internal/
│   ├── config/              # LoadAgentConfig — socket path, env-var driven
│   ├── events/              # Event shaping for NFLOG → server
│   └── fw/
│       ├── server.go        # Unix socket admin API
│       ├── reconciler.go    # Boot-time re-apply of persisted rules
│       ├── nflog.go         # NFLOG netlink reader
│       └── store.go         # Persistent env→rules state
├── Dockerfile
└── go.mod
```

## Build & Run

```bash
# Build via root pnpm wrapper
pnpm build:egress-fw-agent

# Or directly
cd egress-fw-agent && go build ./cmd/...
cd egress-fw-agent && go test ./...
```

The agent must run on the Docker host with `NET_ADMIN` and access to the host network namespace — it manipulates nftables and reads NFLOG groups.

## Architecture Notes

- **Unix socket, not TCP.** The admin API is a Unix socket so only processes on the host (the server) can push rules. The socket path is configurable via env.
- **Boot-time reconcile.** Rules are persisted in the env store; on restart, `Reconciler.ReconcileAll()` re-applies them so a crashed agent doesn't drop the firewall.
- **Container map** (from `egress-shared/state`) maps container IPs → environment so NFLOG events can be attributed correctly.
- **NFLOG on WSL2 is an open spike.** The agent logs but does not fatal if NFLOG is unavailable, since dev WSL2 setups don't always expose it.

## Conventions

- **Pair changes with `egress-gateway`.** When you add a new rule type, decide whether it's L3/L4 (here) or L7 (gateway). Don't duplicate enforcement.
- **Don't bypass the store.** All rule mutations go through `EnvStore` so reconcile stays correct.
