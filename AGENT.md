# Mini Infra - Codex Agent Guide

## Quick Orientation
- Mini Infra manages Docker-hosted infrastructure: container lifecycle, PostgreSQL backups, declarative stacks with blue-green deployment via HAProxy, and Cloudflare tunnel monitoring.
- The repository uses pnpm workspaces with four packages (`client/`, `server/`, `lib/`, `acme/`). TypeScript is everywhere; double-check type safety before shipping changes. Sidecar packages (`update-sidecar/`, `agent-sidecar/`) are deliberately standalone and stay on npm.
- Logs, generated assets, and Prisma clients live under `server/`. Avoid checking build output into git.
- Default assumption: development runs on Windows, commands executed through Git Bash or PowerShell. Convert paths when necessary (`C:\repo` -> `/c/repo` for Bash tools).

## Command & Tooling Expectations
- Prefer `pnpm` scripts defined in each workspace; they wrap tsx, Vitest, ESLint, and Prisma so you do not have to remember raw invocations.
- Testing uses Vitest 4 with Supertest. Keep unit/integration tests colocated under `server/src/__tests__/` and `client/src/__tests__/`.
- Linting and formatting rely on ESLint 9.x and Prettier 3. Run `pnpm --filter mini-infra-server lint` or `pnpm --filter mini-infra-server format:check` before handing work back.
- Prisma controls the SQLite schema. Update `server/prisma/schema.prisma` first, then run `pnpm --filter mini-infra-server exec prisma migrate dev` or `pnpm --filter mini-infra-server exec prisma db push` as appropriate.

## API Access (Dev Only)
Use the built-in development API key when talking to the backend.

```bash
pnpm --filter mini-infra-server run show-dev-key
```

Recreate the key if needed:

```bash
pnpm --filter mini-infra-server run show-dev-key -- --recreate
```

Pass the key to requests with either header:
- `Authorization: Bearer <key>`
- `x-api-key: <key>`

Example endpoints worth probing during debugging:
- `GET /api/stacks`
- `GET /api/containers`
- `GET /api/environments`

The dev key appears when `pnpm dev` is running.

## Project Highlights
### Frontend (client/)
- Vite 7 + React 19, Tailwind 4, shadcn/ui components, TanStack Query 5, React Hook Form + Zod. Keep UI state minimal; rely on TanStack Query for data fetching.
- Date handling uses `date-fns` + `date-fns-tz`; keep everything UTC in transit.

### Backend (server/)
- Express 5 with Passport (Google OAuth) and API key auth. Services follow dependency injection patterns under `server/src/services/`.
- SQLite via Prisma 6.15.0. Pino handles logging with domain-specific files in `server/logs/` (`app.log`, `app-http.log`, etc.).
- External integrations: dockerode, Azure Blob Storage, Cloudflare, PostgreSQL health checks, HAProxy orchestration.

### Shared Types (lib/)
- Holds TypeScript definitions consumed by both client and server. Always build or watch after changing shared types (`pnpm --filter @mini-infra/types dev` or `pnpm --filter @mini-infra/types build`).

## High-Value Workflows
- **Run whole stack in dev**: `pnpm dev` (from repo root). Starts lib watcher, acme watcher, server, and client simultaneously.
- **Server only**: `pnpm --filter mini-infra-server dev`
- **Client only**: `pnpm --filter mini-infra-client dev`
- **Build everything**: `pnpm build:all`
- **Vitest tests**: `pnpm --filter mini-infra-server test`; run a single file with `pnpm --filter mini-infra-server exec vitest run <filename>`.
- **Lint**: `pnpm --filter mini-infra-server lint` (or whichever workspace).
- **Format**: `pnpm format` (root, targets server) or `pnpm format:check`.

## Data & Persistence Notes
- SQLite database file resides under `server/prisma`. Use Prisma Studio (`pnpm --filter mini-infra-server exec prisma studio`) for quick inspections.
- Seed data lives in `server/prisma/seed.ts`. Keep it aligned with migrations; update seeds whenever schema changes.
- Backups leverage Azure Blob Storage. Local development expects `.env` variables; check `.env.example` files before adding new config.

## Stacks & Infrastructure
- **Stacks** are the declarative infrastructure-as-code system. A stack defines a group of Docker containers with plan/apply semantics (similar to Terraform). Code lives in `server/src/services/stacks/` with routes in `server/src/routes/stacks.ts`.
- Stacks support two service types: **Stateful** (stop/start replacement) and **StatelessWeb** (blue-green deployment via HAProxy).
- **Stack templates** provide versioned blueprints for creating stacks. Built-in templates (monitoring, haproxy) are defined as JSON files in `server/templates/`.
- The **monitoring stack** (Telegraf, Prometheus, Loki, Alloy) is deployed as a host-level stack and powers the Container Metrics and Container Logs pages.

## Stacks & HAProxy
- Stack orchestration lives under `server/src/services/stacks/` with plan/apply semantics (similar to Terraform).
- HAProxy integration code sits in `server/src/services/haproxy/`. This handles all load-balancing behavior for zero-downtime deployments. HAProxy is deployed as a stack-managed service.
- Cron-based jobs use `node-cron`; scheduling definitions live in `server/src/services/scheduler/`.

## Logging & Diagnostics
- Single entry point: `getLogger(component, subcomponent)` from `server/src/lib/logger-factory.ts`. Components: `http`, `auth`, `db`, `docker`, `stacks`, `deploy`, `haproxy`, `tls`, `backup`, `integrations`, `agent`, `platform`.
- All server logs land in **one NDJSON file** at `server/logs/app.<N>.log` (rotated daily + size cap via `pino-roll`; highest `<N>` is newest). No per-domain files.
- Every line carries `component`, `subcomponent`, and — inside a request scope — `requestId` (+ `userId` once auth resolves). Long-running operations (backups, restores, cert issuance/renewal, stack apply/update/stop/destroy, scheduler ticks) also carry `operationId` via `runWithContext` / `withOperation` from `server/src/lib/logging-context.ts`.
- Grep by structured field, not by filename:
  ```bash
  tail -f server/logs/app.*.log | jq -c '{t:.time, lvl:.level, c:.component, s:.subcomponent, m:.msg, r:.requestId, op:.operationId}'
  grep -h '"component":"tls"' server/logs/app.*.log | jq -c .
  grep -h '"subcomponent":"acme-client-manager"' server/logs/app.*.log | jq -c .
  grep -h '"requestId":"<id>"' server/logs/app.*.log | jq -c .         # one HTTP request end-to-end
  grep -h '"operationId":"stack-apply-<id>"' server/logs/app.*.log | jq -c .  # one long-running op end-to-end
  ```
- Per-env levels (per component) in `server/config/logging.json` under `development` / `production` / `test`. Loaded once at boot — no runtime tuning, no UI, no hot reload. Change the JSON and restart the container to retune.
- Console output is reserved for pre-logger boot code (`server.ts`, `app-factory.ts`, `prisma.ts`, `config-new.ts`, `logging-config.ts` fallback), scripts, and tests. Don't add new `console.*` calls elsewhere.

## Working Agreements for Codex
- Stay within ASCII unless the file already uses Unicode characters.
- Prefer incremental edits with clear git diffs; never revert user changes without direction.
- Add lightweight comments only when logic is non-obvious or asynchronous flow needs a reminder.
- Validate work via tests or targeted scripts whenever possible; mention skipped validations explicitly in hand-off notes.
- When touching infrastructure or data scripts, document breaking changes in `docs/` or relevant README files.

## Quick Reference
- Root dev server port: backend on 5005, frontend on 3005.
- Default credentials rely on Google OAuth in production; dev mode uses API key auth.
- `.env` loading handled through `dotenv-flow`; keep secrets out of committed files.
- Backup executors: `server/src/services/backup/backup-executor.ts` and `server/src/services/backup/self-backup-executor.ts`.
- Progress tracking utilities: `server/src/services/progress-tracker.ts`.

Happy shipping! Keep diffs tight, explain behavior changes in PR summaries, and lean on existing scripts for repeatable workflows.
