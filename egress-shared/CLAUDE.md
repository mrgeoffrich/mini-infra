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
└── state/
    └── container_map.go  # ContainerMap: container IP → environment metadata
```

## Conventions

- **Keep this module tiny.** Only put code here when *both* binaries need to agree on the shape (logger, container map, event types). Anything single-binary belongs in that binary's `internal/`.
- **No external dependencies** beyond the Go standard library if at all possible — this module is pulled into two separate binaries and any heavy dep lands in both.
- **No business logic.** Types, constants, and small utilities only.

## Building

There is nothing to build directly — this module is consumed by `egress-gateway` and `egress-fw-agent` via the workspace. Test changes by building those binaries:

```bash
cd egress-gateway && go build ./...
cd egress-fw-agent && go build ./...
```
