# Mini Infra - Claude Code Context

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
curl -H "x-api-key: <your-api-key>" http://localhost:5000/api/containers
curl -H "x-api-key: <your-api-key>" http://localhost:5000/api/deployments/configs
```

⚠️  **Important**: This only works in development mode. The API key is automatically created when you start the server with `npm run dev`.

## 🧪 HAProxy DataPlane Integration Tests

To run HAProxy DataPlane API integration tests:

### Quick Start
```bash
cd server
RUN_INTEGRATION_TESTS=true npm test -- haproxy-dataplane-client.integration.test.ts
```

### Prerequisites

Use docker compose to start haproxy for the integration tests:
```bash
cd server/docker-compose
docker compose -f docker-compose.haproxy.yml up -d
```

### Troubleshooting
- Tests will be skipped if `RUN_INTEGRATION_TESTS` not set
- Check `docker ps --filter "label=mini-infra.service=haproxy"` for labeled containers
- Tests automatically find HAProxy by image name as fallback

---

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
- **Deployment Infrastructure**:
  - js-yaml 4.1.0 for YAML configuration parsing
  - HAProxy v3.2 for load balancing and traffic routing

### Development Tools
- **Language**: TypeScript 5.8.3 (client) / 5.1.6 (server/lib)
- **Package Manager**: npm with workspaces
- **Linting**: ESLint 9.33.0+ with TypeScript ESLint 8.39.0+
- **Code Formatting**: Prettier 3.6.2
- **Testing**: Jest 30.1.1 with Supertest 7.1.4 for API testing
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
│   ├── src/
│   │   ├── app/             # Application pages (route-based)
│   │   │   ├── dashboard/   # Main dashboard overview
│   │   │   ├── login/       # Authentication page
│   │   │   ├── containers/  # Docker container management
│   │   │   ├── postgres/    # PostgreSQL database management
│   │   │   ├── tunnels/     # Cloudflare tunnel monitoring
│   │   │   ├── connectivity/ # Service health monitoring
│   │   │   │   ├── overview/ # Connectivity dashboard
│   │   │   │   ├── docker/   # Docker service status
│   │   │   │   ├── azure/    # Azure service status
│   │   │   │   └── cloudflare/ # Cloudflare service status
│   │   │   ├── settings/    # System configuration
│   │   │   │   └── system/  # Docker registry and deployment infrastructure settings
│   │   │   └── user/        # User preferences
│   │   │       └── settings/ # Personal settings (timezone)
│   │   ├── components/      # Reusable UI components
│   │   │   ├── ui/          # shadcn UI components
│   │   │   ├── postgres/    # PostgreSQL-specific components
│   │   │   ├── deployments/ # Zero-downtime deployment components
│   │   │   └── cloudflare/  # Cloudflare tunnel components
│   │   ├── hooks/           # Custom React hooks
│   │   └── lib/             # Frontend utilities and configuration
│   ├── public/              # Static assets
│   ├── dist/                # Build output (→ ../server/public)
│   ├── package.json         # Frontend dependencies
│   ├── vite.config.ts       # Vite configuration
│   └── tailwind.config.js   # Tailwind CSS configuration
├── server/                  # Express.js 5 + Prisma backend
│   ├── src/
│   │   ├── app.ts           # Express app configuration
│   │   ├── server.ts        # Server entry point
│   │   ├── routes/          # API endpoints
│   │   ├── services/        # Business logic layer
│   │   ├── services/haproxy # Business logic layer for haproxy
│   │   ├── lib/             # Core utilities and middleware
│   │   └── __tests__/       # Test files
│   ├── prisma/
│   │   ├── schema.prisma    # Database schema definition
│   │   └── dev.db           # SQLite development database file
│   ├── config/
│   │   └── logging.json     # Logging configuration
│   ├── logs/                # Log files (excluded from git)
│   ├── public/              # Static files served by Express
│   ├── dist/                # Backend build output
│   ├── package.json         # Backend dependencies
│   ├── .env                 # Environment variables (not in git)
│   └── .env.example         # Environment template
├── lib/                   # Shared TypeScript types (@mini-infra/types)
│   ├── types/             # TypeScript type definitions shared between client and server
│   ├── dist/              # Compiled JavaScript and declarations
│   ├── package.json       # Shared types package configuration
│   └── tsconfig.json      # TypeScript configuration
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

## Timezone and Date Display System

The application implements a comprehensive timezone-aware date and time display system that respects user preferences across the entire application.

### Frontend Date Formatting

#### Core Components

**User Preferences Hook** (`client/src/hooks/use-user-preferences.ts`)
- **Storage**: User timezone preference stored in database via user preferences API
- **Caching**: React Query with 5-minute stale time for optimal performance
- **Cache Invalidation**: Automatic invalidation on preference updates via `useUpdateUserPreferences`
- **API Endpoints**: 
  - `GET /api/user/preferences` - Retrieve user preferences including timezone
  - `PUT /api/user/preferences` - Update user preferences with cache invalidation
  - `GET /api/user/timezones` - Get list of available timezones for selection

**Formatted Date Hook** (`client/src/hooks/use-formatted-date.ts`)
- **Primary Hook**: `useFormattedDate()` - Returns timezone-aware formatting functions
- **Specialized Hooks**: 
  - `useFormattedDateTime(date)` - Memoized date-time formatting for specific dates
  - `useFormattedContainerDate(date)` - Optimized for container dashboard displays
- **Functions Provided**:
  - `formatDateTime(date, options?)` - Full date and time with user's timezone
  - `formatDate(date, options?)` - Date only with user's timezone  
  - `formatTime(date, options?)` - Time only with user's timezone
  - `formatDateWithPrefix(date, prefix, options?)` - Prefixed date formatting
  - `formatContainerDate(date, options?)` - Container-specific formatting

**Date Utilities** (`client/src/lib/date-utils.ts`)
- **Core Functions**: Underlying timezone-aware date formatting using `date-fns-tz`
- **Options Support**: Configurable display options (showSeconds, custom formats, etc.)
- **Timezone Handling**: Automatic timezone conversion from UTC to user preference

## Service Layer Architecture

The backend implements a sophisticated service layer with dependency injection, configuration management, and comprehensive external API integration in `server/src/services`

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
- `npm test` - Run Jest test suite
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npx jest <filename>` - Run a single test file (e.g., `npx jest src/__tests__/environment-manager.test.ts`)
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint:fix` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting

### Shared Types (lib/)
- `npm run dev` - TypeScript watch mode (auto-recompile on changes)
- `npm run build` - Compile TypeScript to JavaScript + declarations
- `npm run clean` - Remove dist/ build output

### Database (server/)
- `npx prisma db push` - Sync database schema
- `npx prisma studio` - Open database GUI
- `npx prisma generate` - Generate Prisma client
- `npx prisma migrate dev` - Create and apply new migration

## Docker Deployment

The application includes a production-ready Docker build that containerizes both the Express.js server and the built frontend application. The Docker image is automatically built and published to GitHub Container Registry on every push to the main branch.

### Building the Docker Image

#### Local Build

Build the Docker image locally:

```bash
# Build the image
docker build -t mini-infra:latest .

# The build process uses multi-stage builds:
# Stage 1: Build shared types library (lib)
# Stage 2: Build frontend application (client)
# Stage 3: Build backend application (server)
# Stage 4: Create production runtime image
```

#### Automated Builds (CI/CD)

GitHub Actions automatically builds and pushes images on:
- **Push to main branch**: Builds and pushes to ghcr.io with tags: `latest`, `main-<sha>`
- **Pull requests**: Builds only (validates Docker build without pushing)
- **Manual dispatch**: Can trigger builds manually from GitHub Actions UI

### Running the Container

#### Basic Usage

```bash
# Run with minimal configuration
docker run -d \
  --name mini-infra \
  -p 5000:5000 \
  -v mini-infra-data:/app/data \
  -e SESSION_SECRET=your_session_secret_here \
  -e API_KEY_SECRET=your_api_key_secret_here \
  ghcr.io/mrgeoffrich/mini-infra:latest
```

#### Production Usage with Docker Socket Access

Since Mini Infra manages Docker containers, it needs access to the Docker daemon:

```bash
docker run -d \
  --name mini-infra \
  -p 5000:5000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v mini-infra-data:/app/data \
  -v mini-infra-logs:/app/server/logs \
  -e SESSION_SECRET=your_session_secret \
  -e API_KEY_SECRET=your_api_key_secret \
  -e GOOGLE_CLIENT_ID=your_google_client_id \
  -e GOOGLE_CLIENT_SECRET=your_google_client_secret \
  ghcr.io/mrgeoffrich/mini-infra:latest
```

**Security Warning**: Mounting the Docker socket (`/var/run/docker.sock`) gives the container full control over the host Docker daemon. Only run in trusted environments.

### Required Environment Variables

#### Critical (Must Configure)

These environment variables are required for the application to function:

- **`SESSION_SECRET`** - Secret key for JWT session token signing (must be unique per deployment)
- **`API_KEY_SECRET`** - Secret key for API key hashing (must be unique per deployment)
- **`DATABASE_URL`** - Database connection string (default: `file:/app/data/production.db`)

#### Authentication (Optional - for Google OAuth)

- **`GOOGLE_CLIENT_ID`** - Google OAuth 2.0 client ID
- **`GOOGLE_CLIENT_SECRET`** - Google OAuth 2.0 client secret
- **`GOOGLE_CALLBACK_URL`** - OAuth callback URL (default: `http://localhost:5000/auth/google/callback`)

#### External Services (Optional - configured via UI)

These services can be configured through the application UI after deployment:
- Docker host connection settings
- Azure Blob Storage credentials
- Cloudflare API credentials

#### Observability (Optional)

- **`LOG_LEVEL`** - Logging verbosity level (default: `info`, options: `trace`, `debug`, `info`, `warn`, `error`, `fatal`)
- **`OTEL_ENABLED`** - Enable OpenTelemetry tracing (default: `false`)
- **`OPENOBSERVE_URL`** - OpenObserve instance URL for observability

### Volume Mounts

#### Required Volumes

- **`/app/data`** - Database persistence (SQLite database file stored here)
  - Contains the production database file
  - Must be persisted across container restarts
  - Prisma migrations are automatically applied on startup

#### Recommended Volumes

- **`/app/server/logs`** - Application logs persistence
  - Contains structured Pino logs organized by domain
  - Useful for debugging and monitoring
  - Log rotation handled automatically

### Health Checks

The container includes a built-in health check:

- **Endpoint**: `http://localhost:5000/health`
- **Interval**: 30 seconds
- **Timeout**: 3 seconds
- **Start Period**: 40 seconds (allows for initialization and migrations)
- **Retries**: 3 attempts before marking unhealthy

The health check uses Node.js built-in HTTP module (no extra dependencies) and validates that the Express server is responding correctly.

### GitHub Container Registry

Production images are automatically built and published to GitHub Container Registry (ghcr.io):

#### Pulling Images

```bash
# Pull the latest image
docker pull ghcr.io/mrgeoffrich/mini-infra:latest

# Pull a specific commit SHA
docker pull ghcr.io/mrgeoffrich/mini-infra:main-abc1234

# Pull a specific version (if tagged)
docker pull ghcr.io/mrgeoffrich/mini-infra:1.0.0
```

#### Image Tags

The CI/CD pipeline creates multiple tags:
- **`latest`** - Latest build from main branch
- **`main-<sha>`** - Specific commit SHA from main branch
- **`<version>`** - Semantic version tags (if releases are tagged)

### Container Startup Process

When the container starts, it automatically:

1. **Runs Prisma Migrations**: `npx prisma migrate deploy`
   - Applies any pending database migrations
   - Safe for production (only applies committed migrations)
   - Idempotent (safe to run multiple times)

2. **Starts the Server**: `node dist/server.js`
   - Initializes Express.js application
   - Serves frontend from `/app/server/public`
   - Handles API requests at `/api/*`
   - Starts background schedulers and health monitors

### Database Considerations

#### Default: SQLite

- Uses file-based SQLite database at `/app/data/production.db`
- Requires volume mount at `/app/data` for persistence
- Good for single-instance deployments
- Automatic migrations on container startup

#### Alternative: PostgreSQL

The application supports PostgreSQL via Prisma:
- Set `DATABASE_URL` to PostgreSQL connection string
- Example: `postgresql://user:password@host:5432/database`
- Requires external PostgreSQL server or container

### Docker Socket Access

Since Mini Infra manages Docker containers on the host, it needs Docker daemon access:

#### Host Docker Socket Mount (Recommended)

```bash
-v /var/run/docker.sock:/var/run/docker.sock
```

**Pros**: Simple, direct access to host Docker daemon
**Cons**: Security risk - container has full Docker control
**Use Case**: Trusted environments, development, single-host deployments

#### Docker-in-Docker (Alternative)

For isolated environments, consider Docker-in-Docker (DinD):
- Run Docker daemon inside container
- Better isolation but more complex
- Higher resource usage

**Recommendation**: Only deploy with Docker socket access in trusted environments where container security is ensured through other means (network isolation, access controls, etc.).

### Image Optimization

The Docker image is optimized for size and security:

- **Base Image**: `node:20-alpine` (minimal footprint)
- **Multi-Stage Build**: Only runtime dependencies in final image
- **Size**: Approximately 300-400MB
- **Security**: Runs as non-root `node` user
- **No Source Code**: Only compiled JavaScript in production image
- **Layer Caching**: Optimized for fast rebuilds in CI/CD

### Example docker-compose.yml

```yaml
version: '3.8'

services:
  mini-infra:
    image: ghcr.io/mrgeoffrich/mini-infra:latest
    container_name: mini-infra
    ports:
      - "5000:5000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - mini-infra-data:/app/data
      - mini-infra-logs:/app/server/logs
    environment:
      - NODE_ENV=production
      - SESSION_SECRET=${SESSION_SECRET}
      - API_KEY_SECRET=${API_KEY_SECRET}
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - LOG_LEVEL=info
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:5000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 3s
      start_period: 40s
      retries: 3

volumes:
  mini-infra-data:
  mini-infra-logs:
```

### Graceful Shutdown

The application handles graceful shutdown properly:

- Listens for `SIGTERM` and `SIGINT` signals
- Stops schedulers and background services
- Closes database connections cleanly
- Shuts down OpenTelemetry exporters
- 30-second timeout before force termination

Docker respects this behavior:
- `docker stop` sends `SIGTERM`
- 10-second grace period (default)
- Container shuts down cleanly

### Troubleshooting

#### Container Won't Start

Check logs:
```bash
docker logs mini-infra
```

Common issues:
- Missing required environment variables (SESSION_SECRET, API_KEY_SECRET)
- Database migration failures
- Port 5000 already in use

#### Database Issues

Check database permissions:
```bash
docker exec mini-infra ls -la /app/data
```

Ensure volume is mounted and writable.

#### Health Check Failing

Check application health:
```bash
docker exec mini-infra node -e "require('http').get('http://localhost:5000/health', (r) => {r.on('data', d => console.log(d.toString()))})"
```

## API Route Development Guide

### Creating New Routes

When creating new API routes in `server/src/routes/`, follow this pattern:

#### 1. Basic Route Structure
```typescript
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import { z } from "zod";
import prisma from "../lib/prisma";

const logger = appLogger();
const router = express.Router();
// Your route handlers here...

export default router;
```

#### 2. Authentication Middleware Options

**ALWAYS import authentication middleware from `../middleware/auth`** - never import directly from lib files.

Available authentication middleware:
- **`requireSessionOrApiKey`** - Accepts either JWT session or API key (most common)
- **`requireAuth`** - Requires JWT session only (browser users)
- **`requireAuthorization`** - Advanced authorization checks
- **`requireOwnership(paramName)`** - Ensures user owns the resource

#### 3. Route Handler Pattern
```typescript

// POST endpoint with authentication
router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
```

#### 4. Validation with Zod
```typescript
const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional()
});

router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const validatedData = createSchema.parse(req.body);
    // Use validatedData...
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: error.errors
    });
  }
});
```

### Authentication Import Rules

✅ **DO** import all auth functions from the centralized middleware:
```typescript
// CORRECT - Always use this
import {
  requireSessionOrApiKey,
  getAuthenticatedUser,
  requireAuth,
  getCurrentUserId
} from "../middleware/auth";
```

This ensures consistent authentication patterns and maintainable code across all routes.

## Logging Architecture

The application uses a sophisticated multi-file logging architecture built on Pino for high-performance structured logging with domain separation.

Logs are found in `server/logs/` directory with the following files:
 - `app.log` - Application logs
 - `app-all.log` - All logs aggregated together
 - `app-http.log` - http request and response logs
 - `app-services.log` - log from services that run from `server/src/service/*.ts`
 - `app-dockerexecutor.log` - logs from container execution
 - `app-prisma.log` - log from prisma
 - `app-deployments.log` - logs from deployment orchestrator and deployment operations

## SQLite Database Access

The development database can be queried directly using the sqlite3 binary. The database file is located at `server/prisma/dev.db`.

## Running Queries against the database

### Single Query Mode on Windows (PowerShell)
```powershell
cd server
"SELECT * FROM users;" | .\sqlite3.exe prisma/dev.db
```

### Query with Headers and Formatting on Windows (PowerShell)
```powershell
cd server
@"
.headers on
.mode column
SELECT * FROM users;
"@ | .\sqlite3.exe prisma/dev.db
```

### File-based Queries on Windows (PowerShell)
Create a SQL file and run:
```powershell
cd server
Get-Content your_queries.sql | .\sqlite3.exe prisma/dev.db
```

### Single Query Mode on Linux
```bash
cd server
echo "SELECT * FROM users;" | sqlite3 prisma/dev.db
```

### Query with Headers and Formatting on Linux
```bash
cd server
printf ".headers on\n.mode column\nSELECT * FROM users;\n" | sqlite3 prisma/dev.db
```

### File-based Queries on Linux
Create a SQL file and run:
```bash
cd server
sqlite3 prisma/dev.db < your_queries.sql
```

**Note**: The sqlite3.exe binary is not checked into source control but should be downloaded and placed in the server directory for database access.
