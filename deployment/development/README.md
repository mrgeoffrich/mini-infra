# Mini Infra - Development Deployment

This folder contains the per-worktree development workflow for running a fully isolated Mini Infra instance locally — one VM, one set of containers, one set of ports per git worktree.

The legacy single-instance flow (`start.sh`/`docker-compose.yaml`) has been removed; the worktree flow is now the only supported path.

## Quick Start

From the worktree root (works on macOS, Linux, and Windows — same command everywhere):

```bash
pnpm worktree-env start --description "<short summary>"
```

On macOS this auto-selects Colima; on Windows it auto-selects WSL2 (first run also needs `scripts/build-wsl-base.ps1`).

`--description` is required on the first run; later re-runs reuse the stored description.

The script:

1. Picks a per-worktree VM driver (Colima on macOS, WSL2 on Windows) and creates the VM if needed.
2. Allocates per-worktree UI / registry / Vault / Docker ports from `~/.mini-infra/worktrees.yaml`.
3. Builds and pushes the **agent sidecar**, **egress gateway**, and **egress firewall agent** images to the per-worktree local Docker registry.
4. Builds the **main app** image with those image tags baked in as build args.
5. Runs `docker compose up` against `docker-compose.worktree.yaml` to bring up `registry` and `mini-infra`. The agent sidecar and the egress firewall agent are launched at runtime by the `mini-infra` server itself (not by compose), so they do not appear as compose services.
6. Seeds credentials from `~/.mini-infra/dev.env` and writes `environment-details.xml` at the worktree root with the URL, admin login, and seeded resource IDs.

## Architecture

The compose file brings up two containers per worktree:

| Container | Purpose | Port |
|-----------|---------|------|
| `<profile>-registry` | Per-worktree local Docker registry | UI-port-aligned (5100–5199 range) |
| `<profile>-mini-infra` | Main Mini Infra application | UI-port-aligned (3100–3199 range) |

Two more containers are spawned at runtime by the server inside that VM:

| Container | Purpose | Notes |
|-----------|---------|-------|
| `mini-infra-agent-sidecar` | AI agent sidecar | Created by `ensureAgentSidecar()` on boot |
| `mini-infra-egress-fw-agent` | Host firewall agent (network_mode: host, NET_ADMIN/NET_RAW, mounts `/var/run/mini-infra` + `/lib/modules`) | Created by `ensureFwAgent()` on boot |

Both runtime sidecars are managed end-to-end by `mini-infra-server`: pull image, create, start, health-check, restart on demand via the UI. Their image tags are baked into the main image at build time via `AGENT_SIDECAR_IMAGE_TAG` and `EGRESS_FW_AGENT_IMAGE_TAG`, with database settings (`agent-sidecar.image`, `egress-fw-agent.image`) able to override at runtime.

## Common Commands

All commands run from the worktree root via the unified `worktree-env` CLI.

```bash
# Bring up / rebuild
pnpm worktree-env start

# List all worktree environments (URL, admin login, seed status)
pnpm worktree-env list

# Tear down (containers + VM + registry entry)
pnpm worktree-env delete <profile>

# Sweep merged-PR worktrees (also runs hourly via launchd on macOS)
pnpm worktree-env cleanup --dry-run

# Install/uninstall the macOS launchd cleanup agent
pnpm worktree-env install-cleanup-agent
pnpm worktree-env install-cleanup-agent --remove

# Resolve the dev URL from the generated environment manifest
MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
```

Run `pnpm worktree-env <command> --help` for command-specific options.

## When to use this vs `pnpm dev`

| Scenario | Worktree flow | `pnpm dev` |
|----------|---------------|------------|
| Testing Docker builds, agent sidecar, egress firewall agent | ✅ Yes | ❌ No |
| Validating docker-compose configuration changes | ✅ Yes | ❌ No |
| Testing in production-like environment | ✅ Yes | ❌ No |
| Rapid code iteration with hot reload | ❌ No | ✅ Yes |
