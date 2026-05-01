# Egress Shared

Go module shared between `egress-gateway` and `egress-fw-agent`. Holds types and helpers that must agree across both binaries — keeping them here prevents drift between the L7 proxy and the L3/L4 firewall agent.

Wired into the repo via `go.work` at the project root:

```
use (
    ./egress-shared
    ./egress-gateway
    ./egress-fw-agent
)
```

## Structure

```
egress-shared/
├── go.mod
├── log/
│   └── log.go            # Shared structured logger (used by both binaries)
├── natsbus/
│   ├── subjects.go       # NATS subject constants (mirror of lib/types/nats-subjects.ts)
│   ├── client.go         # NATS connection + lifecycle
│   ├── pubsub.go         # Publish / Request / Subscribe / Respond helpers
│   └── jetstream.go      # JetStream Publish + KV helpers
└── state/
    └── container_map.go  # ContainerMap: container IP → environment metadata
```

## Conventions

- **Keep this module tiny.** Only put code here when *both* binaries need to agree on the shape (logger, container map, event types, NATS bus). Anything single-binary belongs in that binary's `internal/`.
- **External dependencies are minimised but allowed when both binaries need them.** Currently the only non-stdlib dep is `github.com/nats-io/nats.go` — both `egress-gateway` (Phase 3) and `egress-fw-agent` (Phase 2) talk to NATS, so it lives here rather than getting added to two `go.mod`s independently.
- **No business logic.** Types, constants, and small utilities only.
- **NATS access goes through `natsbus.Client`** — no raw `nats.Connect()` from sidecar code. Mirrors the `NatsBus` chokepoint rule on the TS server side.

## Building

There is nothing to build directly — this module is consumed by `egress-gateway` and `egress-fw-agent` via the workspace. Test changes by building those binaries:

```bash
cd egress-gateway && go build ./...
cd egress-fw-agent && go build ./...
```
