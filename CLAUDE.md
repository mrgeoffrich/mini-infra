# Mini Infra - Claude Code Context

Important: When making changes, if we are on main branch, switch to a branch. All changes should not go into main unless the user specifically mentions they want the changes on main.

All changes should be submitted as PRs when they are ready.

## Planning Guidelines

After the first round of exploration and planning try to do more exploration for flow on effects.

When designing the solution make sure you pick a DRY and well though out solution to reduce duplication and keep the code base maintainable.

## Worktree Development Workflow

For parallel dev work, each git worktree runs its own fully isolated Mini Infra instance on its own Colima VM. This is the default flow — use it instead of fighting over a single dev daemon when you have multiple WIPs in flight.

1. **Spin up.** From the worktree root, run `deployment/development/worktree_start.sh --description "<short summary of what this worktree is for>"`. The `--description` flag (≤10 words) is required on the first run for a new worktree — without it the script drops into an interactive prompt. Optionally also pass `--long-description "<≤50 words>"`. Subsequent re-runs reuse the stored description, so the flag is only needed once. This creates (or reuses) a Colima profile named after the worktree directory, allocates stable UI/registry ports from `~/.mini-infra/worktrees.yaml`, builds + starts the stack, then seeds credentials from `~/.mini-infra/dev.env` so the onboarding wizard is skipped.

2. **Find the URL.** The script writes `environment-details.xml` at the worktree root with the UI URL, Vault URL, Docker host, seeded resource IDs, and connected-service status. Read from it instead of assuming a port (see Browser Automation below for the one-liner). Worktree-unique ports are allocated for the UI (3100-3199), local registry (5100-5199), and Vault (8200-8299) — every parallel instance gets its own slot so multiple Vaults don't collide on `localhost:8200`.

3. **Edit code normally.** The `server/` / `client/` / `lib/` layout and workspace rules below still apply.

4. **Rebuild after changes.** Re-run `deployment/development/worktree_start.sh`. It's idempotent — profile stays up, image rebuilds, container recreates, seeder skips already-seeded steps.

5. **Test.** Use the `test-dev` or `diagnose-dev` skills; both resolve the URL from `environment-details.xml` automatically.

6. **List everything.** Run `deployment/development/worktree_list.sh` from anywhere to see every registered environment (URL, admin login, path, seed status) in a table. `--wide` also prints the API key and admin password; `--json` emits the raw registry.

7. **Tear down.** `colima delete <profile> --data --force` removes the entire VM for that worktree. The profile name is the worktree directory basename (lowercased, sanitised to `[a-z0-9-]`).

Run `git` commands from inside the worktree directory, not the main checkout — mixing shells between the two is the main way commits land on the wrong branch.

See [docs/colima-reference.md](docs/colima-reference.md) for Colima command/config detail and gotchas.

## Browser Automation & Testing

For browser automation and browser testing tasks, use the Playwright CLI skill defined in `.claude/skills/playwright-cli/SKILL.md`. This skill provides browser interaction capabilities including navigation, form filling, screenshots, and web testing.

When opening the site in playwright, read the current dev UI URL from `environment-details.xml` at the project root rather than hardcoding a port — each worktree instance listens on a different host port:

```bash
MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
playwright-cli open --persistent "$MINI_INFRA_URL"
```

## Important Instructions

* Always resolve the frontend/backend URL via `environment-details.xml` (see above) instead of hardcoding a localhost port — Vite proxies client traffic to the backend through whichever port the current worktree instance is bound to.
* **Package manager is pnpm** (pinned in `package.json` via the `packageManager` field). On a fresh checkout run `corepack enable` once, then `pnpm install`. Don't use `npm install` at the repo root — it will fight with the pnpm lockfile.
* **Always run commands from the project root**. Never `cd` into `client/`, `server/`, or `lib/` subdirectories. Use `--filter <workspace>` flags instead (e.g., `pnpm --filter mini-infra-server test`).
* **Sidecar folders are NOT in the pnpm workspace and still use npm.** `update-sidecar/` and `agent-sidecar/` are standalone packages with their own `package-lock.json` — you must `cd` into them to run npm commands (e.g., `cd agent-sidecar && npm test`), then `cd` back to the project root afterwards.
* When a change is made for the local dev environment rebuild the containers — run `deployment/development/worktree_start.sh` for per-worktree instances (writes the `environment-details.xml`), or the legacy `deployment/development/start.sh` if you're on the single-instance flow.

## Project Overview

Mini Infra is a web application designed to manage a single Docker host and its associated infrastructure. It provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using HAProxy, and Cloudflare tunnel monitoring.

### Key Concepts

- **Container** — a Docker container on the managed host. Status: Running, Stopped, Paused, Exited, Restarting.
- **Application** — a logical concept that provides a simplified UX for managing services. Under the hood, an application is just a stack. The application layer handles creating the stack definition from user inputs (image, ports, env vars, volumes, routing) and exposes deploy/update/stop actions. All actual container orchestration happens at the stack level.
- **Stack** — a collection of containers and supporting infrastructure (networks, volumes, config files) managed as a single unit with plan/apply semantics. Can be host-level or environment-scoped. Status: Synced, Drifted, Pending, Undeployed, Error, Removed.
- **Stack Definition** — a versioned snapshot of a stack's desired state. Compared against running containers to detect drift and generate plans. Tracks latest version, running version, and lastAppliedSnapshot.
- **Stack Template** — a reusable blueprint for stacks with draft-and-publish versioning. Scoped to Host or Environment. Source: System (built-in) or User (custom).
- **Service** — an individual container definition within a stack. Type: Stateful (stop/start replacement) or StatelessWeb (zero-downtime blue-green via HAProxy).
- **Deployment (Blue-Green)** — zero-downtime release strategy. Blue = current containers, Green = new release. Phases: deploy green → health check → switch traffic → drain blue → remove blue. Auto-rollback on failure.
- **Environment** — a named grouping (e.g., production, staging) with a type (production/nonproduction) and network type: Local (Docker host only) or Internet (publicly routable via Cloudflare tunnel).
- **HAProxy** — load balancer configured via Data Plane API (no reload needed). Key objects: Instance (running process), Frontend (listener — Manual or Shared with routes), Backend (server group with balance algorithm), Server (container endpoint).
- **PostgreSQL Backup** — scheduled or manual encrypted database backups stored in Azure Blob Storage. Configurable cron, retention, format (custom/sql), and compression.
- **TLS Certificate** — automated SSL/TLS via ACME (Let's Encrypt). DNS-01 challenge via Cloudflare. Stored in Azure Blob Storage. Auto-renewed 30 days before expiry. Status: Pending, Active, Renewing, Expired, Error.
- **Cloudflare Tunnel** — Argo Tunnel providing public internet access without open firewall ports. Linked to internet-type environments via UUID and service URL.
- **Connected Service** — external integration (Docker, Azure Storage, Cloudflare, GitHub) with connectivity status tracking (connected/failed/timeout/unreachable) and response time.
- **DNS Zone** — Cloudflare-managed domain. Records can be proxied or DNS-only. Auto-created for ACME challenges and tunnel config.
- **Volume** — Docker volume with optional inspection (Alpine container scans filesystem, catalogs files, supports content retrieval up to 1 MB).
- **Docker Network** — bridge-driver network for container communication. Environment-scoped networks use `{environment}-{purpose}` naming.
- **API Key** — programmatic access token with permission scopes (`resource:action`). Presets: Reader, Editor, Admin. Supports rotation and last-used tracking.
- **Event** — audit log entry for long-running operations. Tracks type, category, status progression, trigger source, progress, user, and duration. Streams via Socket.IO.
- **Self-Update** — in-place upgrade via sidecar health-check pattern. Pulls new image, validates, swaps containers. Auto-rollback on failure. Data preserved on mounted volumes.
- **Agent Sidecar** — optional AI operations assistant in a separate container. Natural language interface to Docker, Mini Infra API, and docs. Per-user conversations with SSE streaming.

## Project Structure

```
mini-infra/
├── client/                # Vite + React 19 frontend application
├── server/                # Express.js 5 + Prisma backend
├── lib/                   # Shared TypeScript types (@mini-infra/types)
├── update-sidecar/        # Self-update sidecar container (mini-infra-sidecar)
├── agent-sidecar/         # AI agent sidecar container (mini-infra-agent-sidecar)
├── pg-az-backup/          # PostgreSQL Azure backup container
├── deployment/            # Deployment configurations
├── scripts/               # Utility scripts (see below)
├── docs/                  # Project documentation and specs
├── claude-guidance/       # Claude Code guidance files
├── .claude/               # Claude Code configuration
├── package.json           # Root workspace configuration
├── pnpm-workspace.yaml    # pnpm workspace packages + overrides
└── .npmrc                 # pnpm settings (hoisted linker, peer deps, etc.)
```

### Utility Scripts (`scripts/`)
- `generate-ui-manifest.mjs` — Scans `client/src/` for `data-tour` attributes and generates `client/src/user-docs/ui-elements/manifest.json`, mapping UI element IDs to routes for the AI agent's `highlight_element` tool. Run via `pnpm generate:ui-manifest`.
- `top-files-by-lines.sh` — Lists the top N files of a given extension by line count. Usage: `./scripts/top-files-by-lines.sh ts 20`

## Shared Types Architecture

The project uses a centralized shared types package (`@mini-infra/types`) that provides TypeScript definitions shared between the client and server applications.

### Build Dependencies
- **Build Order**: lib must compile before client/server builds
- **Scripts**: `build:lib` → `build:client` / `build:server`
- **Watch Mode**: All three services run in parallel during development
- **Type Safety**: Ensures consistent type definitions across full-stack
- **Testing**: The shared types package must be built (`pnpm build:lib`) before running tests, otherwise type imports will fail

## Socket.IO Conventions

Note: Socket IO is not required for the self patching or updating feature.

### Client-Side Data Fetching
- **No polling when socket is connected.** Rely on socket events to invalidate TanStack Query caches. Set `refetchInterval` to `false` when connected, fall back to polling only when disconnected.
- **Use `refetchOnReconnect: true`** so data refreshes automatically after a socket reconnect (covers any events missed during disconnection).
- **Use `useSocketChannel()`** to subscribe/unsubscribe to a channel on mount/unmount, and **`useSocketEvent()`** to listen for events and invalidate queries.
- See `client/src/hooks/useContainers.ts` for the reference pattern.

### Server-Side Emission
- **Emitters are standalone functions** (e.g., `emitConnectivityStatus()`) that query the DB and call `emitToChannel()`. Follow the pattern in `server/src/services/container-socket-emitter.ts`.
- **Wrap emission calls in try/catch** so failures never break the caller (schedulers, executors, route handlers).
- **Extract shared logic** (e.g., health calculators) into separate modules so both REST routes and socket emitters can reuse them.
- **Event types and channel constants** are defined in `lib/types/socket-events.ts` — always use `Channel.*` and `ServerEvent.*` constants, never raw strings.

### Task Tracker for Long-Running Operations
- Long-running operations (certificate issuance, container connect, stack deploys, container removal, HAProxy migrations) are tracked via a **global task tracker** in the frontend.
- The tracker lives in `client/src/components/task-tracker/` with a context provider (`TaskTrackerProvider`), popover UI (`TaskTrackerPopover`), and detail dialog (`TaskDetailDialog`).
- Each task type is defined in the **task type registry** (`client/src/lib/task-type-registry.ts`) which maps task types to labels, icons, step definitions, and Socket.IO channel/event bindings.
- To add a new tracked task type: add an entry to the registry in `task-type-registry.ts` and call `trackTask()` from the relevant dialog/hook.
- The tracker subscribes to Socket.IO events to show live step-by-step progress and persists task state across navigation.

## Key Commands

### Root Project (pnpm workspaces)
- `pnpm install` - Install all workspace dependencies (replaces `npm install`)
- `pnpm dev` - Start all services: lib watch + acme watch + server + client
- `pnpm build` - Build server, then client (production build for frontend)
- `pnpm build:all` - Build lib, acme, then client, server, sidecar, and agent-sidecar in parallel
- `pnpm build:lib` - Build shared types package only
- `pnpm build:server` - Build lib + acme + server
- `pnpm build:sidecar` - Build self-update sidecar (npm under the hood — sidecars are standalone)
- `pnpm build:agent-sidecar` - Build AI agent sidecar (npm under the hood — sidecars are standalone)

### Frontend (client/) — run from project root
- `pnpm --filter mini-infra-client dev` - Start development server (Vite)
- `pnpm --filter mini-infra-client build` - Build for production
- `pnpm --filter mini-infra-client test` - Run tests (when tests exist)
- `pnpm --filter mini-infra-client lint` - Run linting

### Backend (server/) — run from project root
- `pnpm --filter mini-infra-server dev` - Start development server with hot reload (tsx watch)
- `pnpm --filter mini-infra-server build` - Build TypeScript to JavaScript
- `pnpm --filter mini-infra-server start` - Start production server
- `pnpm --filter mini-infra-server test` - Run Vitest test suite
- `pnpm --filter mini-infra-server test:watch` - Run tests in watch mode
- `pnpm --filter mini-infra-server test:coverage` - Run tests with coverage report
- `pnpm --filter mini-infra-server exec vitest run <filename>` - Run a single test file (e.g., `pnpm --filter mini-infra-server exec vitest run src/__tests__/environment-manager.test.ts`)
- `pnpm --filter mini-infra-server lint` - Run ESLint on TypeScript files
- `pnpm --filter mini-infra-server lint:fix` - Run ESLint with auto-fix
- `pnpm --filter mini-infra-server format` - Format code with Prettier
- `pnpm --filter mini-infra-server format:check` - Check code formatting

### Self-Update Sidecar (update-sidecar/) — standalone, uses npm
- `cd update-sidecar && npm install && npm run build`
- `cd update-sidecar && npm test`

### Agent Sidecar (agent-sidecar/) — standalone, uses npm
- `cd agent-sidecar && npm install && npm run build`
- `cd agent-sidecar && npm test`

### Shared Types (lib/) — run from project root
- `pnpm --filter @mini-infra/types dev` - TypeScript watch mode (auto-recompile on changes)
- `pnpm --filter @mini-infra/types build` - Compile TypeScript to JavaScript + declarations
- `pnpm --filter @mini-infra/types clean` - Remove dist/ build output

### Database — run from project root
- `pnpm --filter mini-infra-server exec prisma migrate dev --name <description>` - Create and apply new migration (use this after schema changes)
- `pnpm --filter mini-infra-server exec prisma generate` - Regenerate Prisma client after schema changes
- `pnpm --filter mini-infra-server exec prisma migrate status` - Check migration status and detect drift
- `pnpm --filter mini-infra-server exec prisma migrate resolve --applied <migration_name>` - Mark an existing migration as applied (useful when fixing drift)

## Critical Coding Patterns

These are the most commonly missed patterns. See `server/CLAUDE.md` for the full service guide.

* **Never use raw `docker.pull()`** — always use `DockerExecutorService.pullImageWithAutoAuth()` which handles registry credential lookup, authentication, and token refresh automatically.
* **Never create Docker clients directly** — use `DockerService.getInstance()` (singleton with caching, event streaming, and timeout protection).
* **Never use raw dockerode calls** — use `DockerService` wrappers (e.g., `listContainers()`, `getContainer()`) which add caching, error handling, and sensitive label redaction.
* **Always use `ConfigurationServiceFactory`** to create config services — never instantiate `DockerConfigService`, `AzureStorageService`, etc. directly.
* **All configuration mutations require `userId`** for audit trail — `set()`, `delete()`, and `create()` methods all track who made the change.
* **Use `Channel.*` and `ServerEvent.*` constants** for Socket.IO — never use raw strings for event names or channels.
* In typescript avoid the use of any. This is OK to clean up later but its good to have strongly typed variables.
