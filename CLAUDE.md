# Mini Infra - Claude Code Context

## Browser Automation & Testing

For browser automation and browser testing tasks, use the Playwright CLI skill defined in `.claude/skills/playwright-cli/SKILL.md`. This skill provides browser interaction capabilities including navigation, form filling, screenshots, and web testing.

When opening the site in playwrite use `playwright-cli open --persistent --headed)` and browse to http://localhost:3005

## Restarting the Dev Server

Run `touch .restart-dev` in the project root to trigger a full dev server restart (lib, server, and client). The file is automatically deleted after the restart is triggered.

## Important Instructions

* Always use http://localhost:3005 for all frontend and backend requests as this is a vite server that will proxy through to the backend. If you need to test the proxy, use http://localhost:5005 for what it connects to.
* **Always run commands from the project root**. Never `cd` into `client/`, `server/`, or `lib/` subdirectories. Use `-w <workspace>` flags instead (e.g., `npm test -w server`).
* **Sidecar folders are NOT in the npm workspace**. `update-sidecar/` and `agent-sidecar/` are standalone packages — you must `cd` into them to run npm commands (e.g., `cd agent-sidecar && npm test`), then `cd` back to the project root afterwards.
* NOTE: NEVER run `docker-compose` as it no longer exists, instead run `docker compose`
* You can directly access all API endpoints in this application using the automatically generated development API key. Here's how:
* Run this command to display your development API key:
```bash
npm run show-dev-key -w server
```

### Use the API Key
Add one of these headers to your HTTP requests:
- **Authorization Header**: `Authorization: Bearer <your-api-key>`
- **x-api-key Header**: `x-api-key: <your-api-key>`

### Example Usage
```bash
curl -H "x-api-key: <your-api-key>" http://localhost:3005/api/containers
curl -H "x-api-key: <your-api-key>" http://localhost:3005/api/stacks
```

⚠️  **Important**: This only works in development mode. The API key is automatically created when you start the server with `npm run dev`.

## Project Overview

Mini Infra is a web application designed to manage a single Docker host and its associated infrastructure. It provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using HAProxy, and Cloudflare tunnel monitoring.

For a complete glossary of project-specific concepts and terminology, see [`client/src/user-docs/getting-started/concepts.md`](client/src/user-docs/getting-started/concepts.md). This file is the single source of truth — it is also embedded in the agent sidecar system prompt and displayed in the user-facing help docs.

## Technology Stack

### Frontend
- **Build Tool**: Vite
- **UI Framework**: React with React DOM
- **Routing**: React Router DOM
- **Styling**: Tailwind CSS with shadcn/ui components via Radix UI
- **UI Components**:
  - Radix UI primitives (dialog, dropdown, select, etc.)
  - Tabler Icons and Lucide React
  - Custom shadcn/ui components with class-variance-authority
- **Forms**: React Hook Form with Zod validation
- **State Management**: TanStack Query (React Query)
- **Data Tables**: @tanstack/react-table for container data display
- **Date Handling**: date-fns with date-fns-tz for timezone support
- **Charts**: Recharts for data visualization
- **Notifications**: Sonner for toast notifications
- **Drag & Drop**: @dnd-kit suite for sortable interfaces
- **Theming**: next-themes for dark/light mode
- **Virtualization**: react-window for large lists

### Backend
- **API Framework**: Express.js
- **Database**: SQLite with Prisma ORM
- **Authentication**: Passport with Google OAuth 2.0 strategy
- **Validation**: Zod for runtime type checking
- **Logging**: Pino with multi-file domain-specific logging architecture
  - pino-http for HTTP request logging
  - pino-pretty for development formatting
  - pino-roll for production log rotation
- **Security**:
  - Helmet for HTTP security headers
  - CORS for cross-origin requests
  - crypto-js for data encryption
  - jsonwebtoken for JWT tokens
- **External API Integrations**:
  - dockerode for Docker API
  - @azure/storage-blob for Azure Storage
  - cloudflare for Cloudflare API
  - pg for PostgreSQL connectivity
- **Scheduling**: node-cron with cron-parser
- **Caching**: node-cache for in-memory caching

### Development Tools
- **Language**: TypeScript
- **Package Manager**: npm with workspaces
- **Linting**: ESLint with TypeScript ESLint
- **Code Formatting**: Prettier
- **Testing**: Vitest with Supertest for API testing
- **Build & Development**:
  - tsx for TypeScript execution and watching
  - cross-env for cross-platform environment variables
  - rimraf for cross-platform file cleanup
- **Shared Types**: Centralized TypeScript definitions in `@mini-infra/types` package

## Development Environment Notes

- **Platform Detection**: If Claude is unsure about the platform, run `uname -s 2>/dev/null || echo "Windows"` to detect the operating system reliably
- **Path Handling**: Use Unix-style paths when using the Bash tool (convert C:\path to /c/path) if you running git bash on windows. Otherwise use windows path style if you are using powershell on Windows.
- **Shell**: Git Bash expects forward slashes and Unix-style drive references

## Project Structure

```
mini-infra/
├── client/                # Vite + React 19 frontend application
├── server/                # Express.js 5 + Prisma backend
├── lib/                   # Shared TypeScript types (@mini-infra/types)
├── update-sidecar/        # Self-update sidecar container (mini-infra-sidecar)
├── agent-sidecar/         # AI agent sidecar container (mini-infra-agent-sidecar)
├── docs/                  # Project documentation and specs
├── .claude/               # Claude Code configuration
├── CLAUDE.md              # Claude Code context and instructions
├── README.md              # Project documentation
└── package.json           # Root workspace configuration
```

## Shared Types Architecture

The project uses a centralized shared types package (`@mini-infra/types`) that provides TypeScript definitions shared between the client and server applications.

### Build Dependencies
- **Build Order**: lib must compile before client/server builds
- **Scripts**: `build:lib` → `build:client` / `build:server`
- **Watch Mode**: All three services run in parallel during development
- **Type Safety**: Ensures consistent type definitions across full-stack
- **Testing**: The shared types package must be built (`npm run build:lib`) before running tests, otherwise type imports will fail

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

### Root Project (npm workspaces)
- `npm run dev` - Start all three services: lib watch + server + client (recommended for development)
- `npm run build` - Build lib, server, then client (production build for frontend)
- `npm run build:all` - Build lib then client, server, sidecar, and agent-sidecar in parallel
- `npm run build:lib` - Build shared types package only
- `npm run build:server` - Build lib then server
- `npm run build:sidecar` - Build self-update sidecar
- `npm run build:agent-sidecar` - Build AI agent sidecar
- `npm install` - Install all workspace dependencies

### Frontend (client/) — run from project root
- `npm run dev -w client` - Start development server (Vite)
- `npm run build -w client` - Build for production
- `npm test -w client` - Run tests
- `npm run lint -w client` - Run linting

### Backend (server/) — run from project root
- `npm run dev -w server` - Start development server with hot reload (tsx watch)
- `npm run build -w server` - Build TypeScript to JavaScript
- `npm start -w server` - Start production server
- `npm test -w server` - Run Vitest test suite
- `npm run test:watch -w server` - Run tests in watch mode
- `npm run test:coverage -w server` - Run tests with coverage report
- `npx -w server vitest run <filename>` - Run a single test file (e.g., `npx -w server vitest run src/__tests__/environment-manager.test.ts`)
- `npm run lint -w server` - Run ESLint on TypeScript files
- `npm run lint:fix -w server` - Run ESLint with auto-fix
- `npm run format -w server` - Format code with Prettier
- `npm run format:check -w server` - Check code formatting

### Self-Update Sidecar (update-sidecar/) — run from project root
- `npm run build -w update-sidecar` - Build TypeScript to JavaScript
- `npm test -w update-sidecar` - Run tests

### Agent Sidecar (agent-sidecar/) — run from project root
- `npm run build -w agent-sidecar` - Build TypeScript to JavaScript
- `npm test -w agent-sidecar` - Run tests

### Shared Types (lib/) — run from project root
- `npm run dev -w lib` - TypeScript watch mode (auto-recompile on changes)
- `npm run build -w lib` - Compile TypeScript to JavaScript + declarations
- `npm run clean -w lib` - Remove dist/ build output

### Database — run from project root
- `npx -w server prisma migrate dev --name <description>` - Create and apply new migration (use this after schema changes)
- `npx -w server prisma generate` - Regenerate Prisma client after schema changes
- `npx -w server prisma migrate status` - Check migration status and detect drift
- `npx -w server prisma migrate resolve --applied <migration_name>` - Mark an existing migration as applied (useful when fixing drift)

#### Host Docker Socket Mount (Recommended)

```bash
-v /var/run/docker.sock:/var/run/docker.sock
```

**Pros**: Simple, direct access to host Docker daemon
**Cons**: Security risk - container has full Docker control
**Use Case**: Trusted environments, development, single-host deployments

## Critical Coding Patterns

These are the most commonly missed patterns. See `server/CLAUDE.md` for the full service guide.

* **Never use raw `docker.pull()`** — always use `DockerExecutorService.pullImageWithAutoAuth()` which handles registry credential lookup, authentication, and token refresh automatically.
* **Never create Docker clients directly** — use `DockerService.getInstance()` (singleton with caching, event streaming, and timeout protection).
* **Never use raw dockerode calls** — use `DockerService` wrappers (e.g., `listContainers()`, `getContainer()`) which add caching, error handling, and sensitive label redaction.
* **Always use `ConfigurationServiceFactory`** to create config services — never instantiate `DockerConfigService`, `AzureStorageService`, etc. directly.
* **All configuration mutations require `userId`** for audit trail — `set()`, `delete()`, and `create()` methods all track who made the change.
* **Use `Channel.*` and `ServerEvent.*` constants** for Socket.IO — never use raw strings for event names or channels.

## Logging Architecture

The application uses a sophisticated multi-file logging architecture built on Pino for high-performance structured logging with domain separation.

Logs are found in `server/logs/` directory with the following files:
 - `app.log.*` - Application logs
 - `app-http.log.*` - http request and response logs
 - `app-services.log.*` - log from services that run from `server/src/service/*.ts`
 - `app-dockerexecutor.log.*` - logs from container execution
 - `app-prisma.log.*` - log from prisma
 - `app-loadbalancer.log.*` - logs from the haproxy service
 - `app-tls.log.*` - logs from the certificate management service
