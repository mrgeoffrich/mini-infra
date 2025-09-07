# Mini Infra - Claude Code Context

## 🤖 Claude API Access Instructions

**FOR CLAUDE**: You can directly access all API endpoints in this application using the automatically generated development API key. Here's how:

### Step 1: Get Your API Key
Run this command to display your development API key:
```bash
cd server && npm run show-dev-key
```

If you need a new key, use:
```bash
cd server && npm run show-dev-key -- --recreate
```

### Step 2: Use the API Key
Add one of these headers to your HTTP requests:
- **Authorization Header**: `Authorization: Bearer <your-api-key>`
- **x-api-key Header**: `x-api-key: <your-api-key>`

### Step 3: All Endpoints should be Available

### Example Usage
```bash
curl -H "x-api-key: <your-api-key>" http://localhost:5000/api/containers
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

- **Platform**: Windows with Git Bash
- **Path Handling**: Use Unix-style paths when using the Bash tool (convert C:\path to /c/path). Otherwise use windows path style.
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
│   │   │   └── cloudflare/  # Cloudflare tunnel components
│   │   ├── hooks/           # Custom React hooks
│   │   │   ├── use-auth.ts  # Authentication hooks
│   │   │   ├── use-containers.ts # Docker container hooks
│   │   │   ├── use-settings.ts   # Settings management hooks
│   │   │   ├── use-user-preferences.ts # User preference hooks
│   │   │   ├── use-formatted-date.ts   # Timezone-aware date formatting
│   │   │   └── use-*.ts     # Various specialized hooks
│   │   └── lib/             # Frontend utilities and configuration
│   │       ├── routes.tsx   # Application routing configuration
│   │       ├── date-utils.ts # Date formatting utilities
│   │       └── utils.ts     # General utilities
│   ├── public/              # Static assets
│   ├── dist/                # Build output (→ ../server/public)
│   ├── package.json         # Frontend dependencies
│   ├── vite.config.ts       # Vite configuration
│   └── tailwind.config.js   # Tailwind CSS configuration
├── server/                  # Express.js 5 + Prisma backend
│   ├── src/
│   │   ├── app.ts          # Express app configuration
│   │   ├── server.ts       # Server entry point
│   │   ├── routes/         # API endpoints
│   │   ├── services/       # Business logic layer
│   │   ├── lib/            # Core utilities and middleware
│   │   └── __tests__/      # Test files
│   ├── prisma/
│   │   ├── schema.prisma   # Database schema definition
│   │   └── dev.db          # SQLite database file
│   ├── config/
│   │   └── logging.json    # Logging configuration
│   ├── logs/               # Log files (excluded from git)
│   ├── public/             # Static files served by Express
│   ├── dist/               # Backend build output
│   ├── package.json        # Backend dependencies
│   ├── .env                # Environment variables (not in git)
│   └── .env.example        # Environment template
├── lib/                    # Shared TypeScript types (@mini-infra/types)
│   ├── types/             # TypeScript type definitions
│   │   ├── auth.ts        # Authentication types
│   │   ├── containers.ts  # Docker container types
│   │   ├── settings.ts    # Configuration types
│   │   ├── azure.ts       # Azure Storage types
│   │   ├── cloudflare.ts  # Cloudflare API types
│   │   ├── postgres.ts    # PostgreSQL operation types
│   │   ├── api.ts         # API response types
│   │   └── index.ts       # Utility types
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

The backend implements a sophisticated service layer with dependency injection, configuration management, and comprehensive external API integration.

### Configuration Services Framework

#### Base Architecture
- **ConfigurationBase** (`server/src/services/configuration-base.ts`): Abstract base class providing common functionality for all configuration services including validation, caching, and error handling
- **ConfigurationFactory** (`server/src/services/configuration-factory.ts`): Service factory with dependency injection pattern for creating and managing configuration service instances

#### External Service Configurations
- **DockerConfig** (`server/src/services/docker-config.ts`): Docker host and API configuration management with connection testing and singleton pattern
- **AzureConfig** (`server/src/services/azure-config.ts`): Azure Storage configuration with connection string validation, container access testing, and retry logic with caching
- **CloudflareConfig** (`server/src/services/cloudflare-config.ts`): Cloudflare API configuration with circuit breaker pattern (opens after 5 failures, 5-minute cooldown), request deduplication, and comprehensive error handling

### Business Logic Services

#### Docker Integration
- **DockerService** (`server/src/services/docker.ts`): Singleton Docker API integration with database-driven configuration and automatic reconnection
- **DockerExecutorService** (`server/src/services/docker-executor.ts`): Docker operations including image pulling, registry authentication testing, and container management with comprehensive error handling

#### PostgreSQL Database Management
- **PostgresConfigService** (`server/src/services/postgres-config.ts`): PostgreSQL database configuration management with connection string encryption/decryption, connection testing with timeout protection, and user-scoped database management
- **BackupConfigService** (`server/src/services/backup-config.ts`): Backup configuration management with cron expression validation, Azure container validation, and automated scheduling calculations
- **BackupExecutorService** (`server/src/services/backup-executor.ts`): Automated backup execution with progress tracking and Azure Storage integration
- **RestoreExecutorService** (`server/src/services/restore-executor.ts`): Database restore operations with progress monitoring and validation

#### Deployment Infrastructure Services
- **DeploymentInfrastructureService** (`server/src/services/deployment-infrastructure.ts`): Docker network and Traefik container management with automated deployment, status monitoring, and cleanup operations
- **TraefikIntegrationService** (`server/src/services/traefik-integration.ts`): Traefik label generation and traffic routing management for blue-green deployments including priority-based routing, container label management, configuration validation, and service discovery

## Frontend Architecture

### Application Routing Structure

The frontend uses React Router v7 with protected route guards and nested routing. All routes except `/login` require authentication.

#### Current Route Implementation (`client/src/lib/routes.tsx`)
```
/ → /dashboard (redirect)
/login (public route - Google OAuth)
/dashboard (main application dashboard)
/containers (Docker container management)
/postgres (PostgreSQL database management)
/tunnels (Cloudflare tunnel monitoring)
/connectivity/* (service health monitoring)
  ├─ /overview (connectivity dashboard)
  ├─ /docker (Docker service status)
  ├─ /azure (Azure service status)
  └─ /cloudflare (Cloudflare service status)
/settings/* (system configuration)
  └─ /system (Docker registry and deployment infrastructure configuration)
/user/settings (personal preferences including timezone)
```

## Environment Variables

Create a `.env` file in the `server/` directory using the provided `.env.example` template
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

## Logging Architecture

The application uses a sophisticated multi-file logging architecture built on Pino for high-performance structured logging with domain separation.

Logs are found in `server/logs/` directory with the following files:
 - `app.log` - Application logs
 - `app-all.log` - All logs aggregated together
 - `app-http.log` - http request and response logs
 - `app-services.log` - log from services that run from `server/src/service/*.ts`
 - `app-dockerexecutor.log` - logs from container execution
 - `app-prisma.log` - log from prisma
