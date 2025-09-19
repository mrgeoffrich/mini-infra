# Mini Infra - Codex Agent Guide

## Quick Orientation
- Mini Infra manages Docker-hosted infrastructure: container lifecycle, PostgreSQL backups, blue/green deployments via HAProxy, and Cloudflare tunnel monitoring.
- The repository uses npm workspaces with three packages (`client/`, `server/`, `lib/`). TypeScript is everywhere; double-check type safety before shipping changes.
- Logs, generated assets, and Prisma clients live under `server/`. Avoid checking build output into git.
- Default assumption: development runs on Windows, commands executed through Git Bash or PowerShell. Convert paths when necessary (`C:\repo` -> `/c/repo` for Bash tools).

## Command & Tooling Expectations
- Prefer `npm` scripts defined in each workspace; they wrap tsx, Jest, ESLint, and Prisma so you do not have to remember raw invocations.
- Testing uses Jest 30 with Supertest. Keep unit/integration tests colocated under `server/src/__tests__/` and `client/src/__tests__/`.
- Linting and formatting rely on ESLint 9.x and Prettier 3. Run `npm run lint` or `npm run format:check` before handing work back.
- Prisma controls the SQLite schema. Update `server/prisma/schema.prisma` first, then run `npx prisma migrate dev` or `npx prisma db push` as appropriate.

## API Access (Dev Only)
Use the built-in development API key when talking to the backend.

```bash
cd server && npm run show-dev-key
```

Recreate the key if needed:

```bash
cd server && npm run show-dev-key -- --recreate
```

Pass the key to requests with either header:
- `Authorization: Bearer <key>`
- `x-api-key: <key>`

Example endpoints worth probing during debugging:
- `GET /api/deployments/configs`
- `POST /api/deployments/trigger`
- `GET /api/containers`

The dev key appears when `npm run dev` is running.

## Project Highlights
### Frontend (client/)
- Vite 7 + React 19, Tailwind 4, shadcn/ui components, TanStack Query 5, React Hook Form + Zod. Keep UI state minimal; rely on TanStack Query for data fetching.
- Date handling uses `date-fns` + `date-fns-tz`; keep everything UTC in transit.

### Backend (server/)
- Express 5 with Passport (Google OAuth) and API key auth. Services follow dependency injection patterns under `server/src/services/`.
- SQLite via Prisma 6.15.0. Pino handles logging with domain-specific files in `server/logs/` (`app.log`, `app-http.log`, etc.).
- External integrations: dockerode, Azure Blob Storage, Cloudflare, PostgreSQL health checks, HAProxy orchestration.

### Shared Types (lib/)
- Holds TypeScript definitions consumed by both client and server. Always build or watch after changing shared types (`npm run dev` or `npm run build` inside `lib/`).

## High-Value Workflows
- **Run whole stack in dev**: `npm run dev` (from repo root). Starts lib watcher, server, and client simultaneously.
- **Server only**: `cd server && npm run dev`
- **Client only**: `cd client && npm run dev`
- **Build everything**: `npm run build:all`
- **Jest tests**: `cd server && npm test`; add `-- runInBand` when debugging.
- **Lint**: `npm run lint` (root), or workspace-specific variants.
- **Format**: `npm run format` (root) or `npm run format:check`.

## Data & Persistence Notes
- SQLite database file resides under `server/prisma`. Use Prisma Studio (`npx prisma studio`) for quick inspections.
- Seed data lives in `server/prisma/seed.ts`. Keep it aligned with migrations; update seeds whenever schema changes.
- Backups leverage Azure Blob Storage. Local development expects `.env` variables; check `.env.example` files before adding new config.

## Deployment & Infrastructure Hooks
- Deployment configs and progress tracking live under `server/src/services/deployments/` and `server/src/services/progress-tracker.ts`.
- HAProxy integration code sits in `server/src/services/haproxy/`. This handles all load-balancing behavior for zero-downtime deployments.
- Cron-based jobs use `node-cron`; scheduling definitions live in `server/src/services/scheduler/`.

## Logging & Diagnostics
- Pino logger is configured in `server/src/lib/logger.ts` with per-domain transports. Use context-rich log messages (`logger.child({ service: "xyz" })`).
- HTTP logs go to `server/logs/app-http.log`, service logs to `server/logs/app-services.log`. Tail them when debugging long-running jobs.

## Working Agreements for Codex
- Stay within ASCII unless the file already uses Unicode characters.
- Prefer incremental edits with clear git diffs; never revert user changes without direction.
- Add lightweight comments only when logic is non-obvious or asynchronous flow needs a reminder.
- Validate work via tests or targeted scripts whenever possible; mention skipped validations explicitly in hand-off notes.
- When touching infrastructure or data scripts, document breaking changes in `docs/` or relevant README files.

## Quick Reference
- Root dev server port: backend on 5000, frontend on 3000.
- Default credentials rely on Google OAuth in production; dev mode uses API key auth.
- `.env` loading handled through `dotenv-flow`; keep secrets out of committed files.
- Backup/restore executors: `server/src/services/backup-executor.ts` and `server/src/services/restore-executor.ts`.
- Progress tracking utilities: `server/src/services/progress-tracker.ts`.

Happy shipping! Keep diffs tight, explain behavior changes in PR summaries, and lean on existing scripts for repeatable workflows.
