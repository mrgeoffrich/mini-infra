# Mini Infra - Claude Code Context

## Docker Compose

NOTE: NEVER run `docker-compose` as it no longer exists, instead run `docker compose`

## 🤖 Claude API Access Instructions

**FOR CLAUDE**: You can directly access all API endpoints in this application using the automatically generated development API key. Here's how:

### Step 1: Get Your API Key
Run this command to display your development API key:
```bash
cd server && npm run show-dev-key -- --recreate
```

### Step 2: Use the API Key
Add one of these headers to your HTTP requests:
- **Authorization Header**: `Authorization: Bearer <your-api-key>`
- **x-api-key Header**: `x-api-key: <your-api-key>`

### Step 3: All Endpoints should be Available

#### Deployment API Endpoints
The application now includes comprehensive deployment API endpoints:

- **GET /api/deployments/configs** - List deployment configurations
- **POST /api/deployments/configs** - Create deployment configuration
- **GET /api/deployments/configs/:id** - Get deployment configuration
- **PUT /api/deployments/configs/:id** - Update deployment configuration
- **DELETE /api/deployments/configs/:id** - Delete deployment configuration
- **POST /api/deployments/trigger** - Trigger a new deployment
- **GET /api/deployments/:id/status** - Get deployment status with progress
- **POST /api/deployments/:id/rollback** - Rollback a deployment
- **GET /api/deployments/history** - Get deployment history

### Example Usage
```bash
curl -H "x-api-key: <your-api-key>" http://localhost:5000/api/containers
curl -H "x-api-key: <your-api-key>" http://localhost:5000/api/deployments/configs
```

⚠️  **Important**: This only works in development mode. The API key is automatically created when you start the server with `npm run dev`.

---

## Project Overview

Mini Infra is a web application designed to manage a single Docker host and its associated infrastructure. It provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using Traefik, and Cloudflare tunnel monitoring.

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
  - Traefik v3.0 for load balancing and traffic routing

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

## Core Features

### 1. Docker Container Management
### 2. PostgreSQL Database Management
### 3. Zero-Downtime Deployment System
### 4. Cloudflare Tunnel Management

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

#### Data Storage and Retrieval

**Timezone Storage**:
- **Format**: IANA timezone identifiers (e.g., "America/New_York", "Europe/London", "UTC")
- **Validation**: Server-side validation ensures only valid timezone strings are stored
- **Default Value**: UTC used as fallback when no preference is set

**API Response Format**:
- **Dates**: All API responses return dates in ISO 8601 format (UTC)
- **Client Conversion**: Frontend converts UTC timestamps to user's timezone for display
- **Consistency**: Ensures consistent date handling regardless of server timezone

## External Integrations

- **Docker API**: Container management via dockerode library with singleton service pattern
- **Traefik API**: Load balancer configuration and traffic routing
- **Cloudflare API**: Tunnel monitoring (read-only)
- **Azure Storage API**: Backup/restore operations
- **PostgreSQL API**: Direct database connectivity for health checks and backup/restore operations
- **Google OAuth API**: User authentication

### Deployment Infrastructure Integration

- **Docker Network Management**: Automated creation and management of Docker networks for deployment isolation
- **Traefik Container Deployment**: Automated Traefik load balancer container deployment with configuration
- **Infrastructure Status Monitoring**: Real-time monitoring of network and Traefik container status
- **Zero-Downtime Deployment Support**: Infrastructure for blue-green deployment strategies

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

## API Route Development Guide

### Creating New Routes

When creating new API routes in `server/src/routes/`, follow this pattern:

#### 1. Basic Route Structure
```typescript
import express, { Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
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
// GET endpoint with authentication
router.get('/', requireSessionOrApiKey, async (req, res) => {
  const user = getAuthenticatedUser(req);
  const userId = getCurrentUserId(req);

  try {
    // Your business logic here
    const result = await someService.getData(userId);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error({ error, userId }, "Error in route handler");
    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});
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

❌ **DON'T** import auth functions directly from lib:
```typescript
// WRONG - Don't do this
import { requireSessionOrApiKey } from "../lib/api-key-middleware";
import { getAuthenticatedUser } from "../lib/auth-middleware";
```

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

### SQLite3 Binary Download Instructions

#### Windows
1. Go to https://sqlite.org/download.html
2. Under "Precompiled Binaries for Windows", download:
   - `sqlite-tools-win32-x86-*.zip` (for 32-bit) or
   - `sqlite-tools-win64-x64-*.zip` (for 64-bit)
3. Extract the zip file
4. Copy `sqlite3.exe` to the `server/` directory

#### Linux
**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install sqlite3
```

**CentOS/RHEL/Fedora:**
```bash
sudo yum install sqlite3  # CentOS/RHEL 7
sudo dnf install sqlite3  # Fedora/RHEL 8+
```

#### macOS
**With Homebrew (recommended):**
```bash
brew install sqlite3
```

**With MacPorts:**
```bash
sudo port install sqlite3
```

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
