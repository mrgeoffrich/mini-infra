# Mini Infra - Claude Code Context

## Browser Automation & Testing

For browser automation and browser testing tasks, use the Playwright CLI skill defined in `.claude/skills/playwright-cli/SKILL.md`. This skill provides browser interaction capabilities including navigation, form filling, screenshots, and web testing.

## Important Instructions

* NOTE: NEVER run `docker-compose` as it no longer exists, instead run `docker compose`
* You can directly access all API endpoints in this application using the automatically generated development API key. Here's how:
* Run this command to display your development API key:
```bash
cd server && npm run show-dev-key
```

### Use the API Key
Add one of these headers to your HTTP requests:
- **Authorization Header**: `Authorization: Bearer <your-api-key>`
- **x-api-key Header**: `x-api-key: <your-api-key>`

### Example Usage
```bash
curl -H "x-api-key: <your-api-key>" http://localhost:5005/api/containers
curl -H "x-api-key: <your-api-key>" http://localhost:5005/api/deployments/configs
```

⚠️  **Important**: This only works in development mode. The API key is automatically created when you start the server with `npm run dev`.

## Project Overview

Mini Infra is a web application designed to manage a single Docker host and its associated infrastructure. It provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using HAProxy, and Cloudflare tunnel monitoring.

## Technology Stack

### Frontend
- **Build Tool**: Vite 7.1.2
- **UI Framework**: React 19.1.1 with React DOM 19.1.1
- **Routing**: React Router DOM 7.8.2
- **Styling**: Tailwind CSS 4.1.12 with shadcn/ui components via Radix UI
- **UI Components**: 
  - Radix UI primitives (dialog, dropdown, select, etc.)
  - Tabler Icons 3.34.1 and Lucide React 0.542.0
  - Custom shadcn/ui components with class-variance-authority
- **Forms**: React Hook Form 7.62.0 with Zod 4.1.4 validation
- **State Management**: TanStack Query 5.85.5 (React Query)
- **Data Tables**: @tanstack/react-table 8.21.3 for container data display
- **Date Handling**: date-fns 4.1.0 with date-fns-tz 3.2.0 for timezone support
- **Charts**: Recharts 2.15.4 for data visualization
- **Notifications**: Sonner 2.0.7 for toast notifications
- **Drag & Drop**: @dnd-kit suite for sortable interfaces
- **Theming**: next-themes 0.4.6 for dark/light mode
- **Virtualization**: react-window 2.0.0 for large lists

### Backend
- **API Framework**: Express.js 5.1.0
- **Database**: SQLite with Prisma ORM 6.15.0
- **Authentication**: Passport 0.7.0 with Google OAuth 2.0 strategy
- **Validation**: Zod 4.1.4 for runtime type checking
- **Logging**: Pino 9.9.0 with multi-file domain-specific logging architecture
  - pino-http 10.5.0 for HTTP request logging
  - pino-pretty 13.1.1 for development formatting
  - pino-roll 3.1.0 for production log rotation
- **Security**: 
  - Helmet 8.1.0 for HTTP security headers
  - CORS 2.8.5 for cross-origin requests
  - crypto-js 4.2.0 for data encryption
  - jsonwebtoken 9.0.2 for JWT tokens
- **External API Integrations**:
  - dockerode 4.0.7 for Docker API
  - @azure/storage-blob 12.28.0 for Azure Storage
  - cloudflare 4.5.0 for Cloudflare API
  - pg 8.16.3 for PostgreSQL connectivity
- **Scheduling**: node-cron 4.2.1 with cron-parser 5.3.1
- **Caching**: node-cache 5.1.2 for in-memory caching

### Development Tools
- **Language**: TypeScript 5.8.3 (client) / 5.1.6 (server/lib)
- **Package Manager**: npm with workspaces
- **Linting**: ESLint 9.33.0+ with TypeScript ESLint 8.39.0+
- **Code Formatting**: Prettier 3.6.2
- **Testing**: Vitest 4.x with Supertest 7.1.4 for API testing
- **Build & Development**:
  - tsx 3.12.7 for TypeScript execution and watching
  - cross-env 10.0.0 for cross-platform environment variables
  - rimraf 6.0.1 for cross-platform file cleanup
- **Shared Types**: Centralized TypeScript definitions in `@mini-infra/types` package

## Development Environment Notes

- **Platform Detection**: If Claude is unsure about the platform, run `uname -s 2>/dev/null || echo "Windows"` to detect the operating system reliably
- **Path Handling**: Use Unix-style paths when using the Bash tool (convert C:\path to /c/path) if you running git bash on windows. Otherwise use windows path style if you are using powershell on Windows.
- **Shell**: Git Bash expects forward slashes and Unix-style drive references

## Project Structure

```
mini-infra/
├── client/                   # Vite + React 19 frontend application
├── server/                  # Express.js 5 + Prisma backend
├── lib/                   # Shared TypeScript types (@mini-infra/types)
├── projectmanagement/      # Project documentation and specs
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
- **Testing**: The shared types package must be built (`cd lib && npm run build`) before running tests, otherwise type imports will fail

## Key Commands

### Root Project (npm workspaces)
- `npm run dev` - Start all three services: lib watch + server + client (recommended for development)
- `npm run build` - Build lib then client (production build for frontend)
- `npm run build:all` - Build lib then both client and server in parallel
- `npm run build:lib` - Build shared types package only
- `npm run build:server` - Build lib then server
- `npm install` - Install all workspace dependencies

### Frontend (client/)
- `npm run dev` - Start development server (Vite)
- `npm run build` - Build for production
- `npm run test` - Run tests
- `npm run lint` - Run linting

### Backend (server/)
- `npm run dev` - Start development server with hot reload (tsx watch)
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm test` - Run Vitest test suite
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npx vitest run <filename>` - Run a single test file (e.g., `npx vitest run src/__tests__/environment-manager.test.ts`)
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint:fix` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting

### Shared Types (lib/)
- `npm run dev` - TypeScript watch mode (auto-recompile on changes)
- `npm run build` - Compile TypeScript to JavaScript + declarations
- `npm run clean` - Remove dist/ build output

### Database (server/)
- `npx prisma migrate dev --name <description>` - Create and apply new migration (use this after schema changes)
- `npx prisma generate` - Regenerate Prisma client after schema changes
- `npx prisma studio` - Open database GUI for data inspection
- `npx prisma migrate status` - Check migration status and detect drift
- `npx prisma migrate resolve --applied <migration_name>` - Mark an existing migration as applied (useful when fixing drift)

#### Host Docker Socket Mount (Recommended)

```bash
-v /var/run/docker.sock:/var/run/docker.sock
```

**Pros**: Simple, direct access to host Docker daemon
**Cons**: Security risk - container has full Docker control
**Use Case**: Trusted environments, development, single-host deployments

## Logging Architecture

The application uses a sophisticated multi-file logging architecture built on Pino for high-performance structured logging with domain separation.

Logs are found in `server/logs/` directory with the following files:
 - `app.log.1` - Application logs
 - `app-http.log.1` - http request and response logs
 - `app-services.log.1` - log from services that run from `server/src/service/*.ts`
 - `app-dockerexecutor.log.1` - logs from container execution
 - `app-prisma.log.1` - log from prisma
 - `app-deployments.log.1` - logs from deployment orchestrator and deployment operations
 - `app-loadbalancer.log.1` - logs from the haproxy service
 - `app-tls.log.1` - logs from the certificate management service
