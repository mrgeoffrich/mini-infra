# Mini Infra - Claude Code Context

## Project Overview

Mini Infra is a web application designed to manage a single Docker host and its associated infrastructure. It provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using Traefik, and Cloudflare tunnel monitoring.

## Technology Stack

### Frontend
- **Framework**: Vite
- **UI Library**: React 19+
- **Routing**: React Router DOM v7+
- **Styling**: shadcn 3 and Tailwind CSS 4
- **Icons**: Heroicons and Tabler Icons
- **Forms**: React Hook Form with Zod validation
- **State Management**: React Query (TanStack Query)
- **Data Tables**: @tanstack/react-table for container data display
- **Date Handling**: date-fns for timestamp formatting
- **Protected Routes**: ProtectedRoute and PublicRoute components with authentication guards

### Backend
- **API**: Express.js 5
- **Database**: SQLite
- **ORM**: Prisma
- **Authentication**: Passport with Google OAuth
- **Validation**: Zod for runtime type checking
- **Logging**: Pino (high-performance structured logging)
- **Security**: Helmet, CORS, secure sessions
- **Middleware**: Request correlation IDs, error handling, graceful shutdown

### Development Tools
- **Language**: TypeScript
- **Package Manager**: npm (with workspaces)
- **Linting**: ESLint
- **Testing**: Jest + React Testing Library
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
### 5. Authentication & Authorization
- **Full OAuth 2.0 with Google Integration**: Complete end-to-end authentication flow with seamless redirects
- **Session Management**: Secure session handling with database persistence and automatic cleanup
- **API Key Authentication**: For webhooks and programmatic access with proper validation
- **Cross-Tab Synchronization**: Authentication state synchronized across browser tabs using BroadcastChannel API
- **Comprehensive Error Handling**: User-friendly error messages with proper error boundaries and recovery options
- **Toast Notifications**: Real-time feedback for authentication events (login success, logout, errors)
- **Route Protection**: Protected and public route components with authentication guards and loading states
- **Session Persistence**: Authentication state persists across browser sessions with localStorage backup
- **Team Support**: Multiple users with proper user context management and profile display

## Project Structure

```
mini-infra/
├── client/                   # Frontend React application
│   ├── src/
│   │   ├── app/             # Application pages
│   │   │   ├── dashboard/   # Dashboard components and data
│   │   │   └── login/       # Login page
│   │   ├── components/      # Reusable UI components
│   │   │   ├── ui/          # shadcn UI components
│   │   ├── hooks/           # Custom React hooks (useAuth, useUser, useContainers, etc.)
│   │   └── lib/             # Frontend utilities
│   ├── public/              # Static assets
│   ├── dist/                # Build output
│   └── package.json         # Frontend dependencies
├── server/                  # Backend Express.js application
│   ├── src/
│   │   ├── app.ts          # Express app configuration
│   │   ├── server.ts       # Server entry point
│   │   ├── lib/
│   │   │   └── prisma.ts   # Prisma client configuration
│   │   └── generated/      # Generated Prisma client
│   ├── prisma/
│   │   └── schema.prisma   # Database schema definition
│   ├── dist/                # Backend build output
│   └── package.json         # Backend dependencies
├── lib/                     # Shared TypeScript types package (@mini-infra/types)
│   ├── types/              # TypeScript type definitions
│   ├── dist/               # Compiled JavaScript and declaration files
│   ├── package.json        # Shared types package configuration
│   └── tsconfig.json       # TypeScript configuration for lib
├── projectmanagement/       # Project documentation
├── CLAUDE.md                # Claude Code context and instructions
└── package.json             # Root package.json with workspaces
```

## Shared Types Architecture

The project uses a centralized shared types package (`@mini-infra/types`) that provides TypeScript definitions shared between the client and server applications.

### Build Dependencies
- **Build Order**: lib must compile before client/server builds
- **Scripts**: `build:lib` → `build:client` / `build:server`
- **Watch Mode**: All three services run in parallel during development
- **Type Safety**: Ensures consistent type definitions across full-stack

## Database Schema

### Authentication Models

The application uses Prisma ORM with SQLite for data persistence.

### Database Configuration
- **Provider**: SQLite
- **File Location**: `server/dev.db`
- **Client Location**: `server/src/generated/prisma`
- **Schema File**: `server/prisma/schema.prisma`

## Authentication System Implementation

### Frontend Authentication
- **Auth Context Provider**: Centralized authentication state management with React Query integration
- **Custom Hooks**: useAuth, useLogin, useLogout, useAuthStatus, useUser for easy authentication access
- **Error Components**: Comprehensive error display components with retry functionality and user guidance
- **Route Guards**: ProtectedRoute and PublicRoute components with loading states and redirects
- **Session Storage**: Local storage utilities for session persistence and user preferences
- **Cross-Tab Sync**: BroadcastChannel API integration for synchronized authentication across browser tabs

### Backend Authentication
- **OAuth Integration**: Complete Passport.js setup with Google OAuth 2.0 strategy
- **Session Management**: JWT tokens
- **API Endpoints**: RESTful authentication endpoints (/auth/google, /auth/status, /auth/logout)
- **Middleware**: Authentication and authorization middleware for route protection

### Security Features
- **Secure Redirects**: Proper OAuth callback handling with frontend/backend coordination
- **Error Handling**: Comprehensive error parsing and user-friendly error messages
- **Session Security**: Secure cookie configuration with appropriate flags and expiration
- **Data Validation**: Zod schemas for request/response validation

### Frontend Container Data Flow
1. **Data Fetching**: useContainers hook polls `/api/containers` endpoint every 5 seconds
2. **Caching**: React Query manages local cache with 2-second stale time
3. **Error Handling**: Automatic retry with exponential backoff, no retry on auth errors
4. **Real-time Updates**: Polling ensures fresh data with configurable intervals
5. **State Management**: useContainerFilters manages UI state for filtering and sorting
6. **Debugging**: Request correlation IDs track requests across client/server boundary

## Testing Strategy

- **Jest** for backend API testing
- **@testing-library/user-event** for user interaction simulation
- **Unique test data** using CUID2 for concurrent test isolation
- **Mocked authentication** with PassportJS mocking
- **Database isolation** with user-scoped test data

### Settings API Endpoints Testing
- **Comprehensive Integration Tests**: Complete test coverage for all settings API endpoints (`server/src/routes/__tests__/settings.test.ts`)
- **CRUD Operations Testing**: Full coverage of Create, Read, Update, Delete operations for system settings
- **Authentication Testing**: All endpoints properly require authentication with comprehensive auth failure scenarios
- **Validation Testing**: Request/response validation using Zod schemas with malformed data scenarios
- **Database Integration**: Mock Prisma database operations with proper error handling scenarios
- **Security Features Testing**: Sensitive data redaction in logs
- **Error Handling Testing**: Comprehensive error scenarios including database failures, validation errors, and unauthorized access
- **Request Correlation Testing**: Proper request ID handling and logging correlation
- **IP Address Handling**: Proper handling of IPv4-mapped IPv6 addresses in test environment
- **Pagination Testing**: Filtering, sorting, and pagination scenarios with edge cases
- **Encryption Support Testing**: Handling of encrypted vs unencrypted settings
- **Configuration Service Testing**: Comprehensive unit tests for all settings services with mocked external APIs, validation logic, error handling, timeout scenarios, and database operations
- **Background Scheduler Testing**: Complete test coverage for connectivity monitoring with circuit breaker patterns, exponential backoff, and parallel execution scenarios

## External Integrations

- **Docker API**: Container management via dockerode library with singleton service pattern
- **Traefik API**: Load balancer configuration
- **Cloudflare API**: Tunnel monitoring (read-only)
- **Azure Storage API**: Backup/restore operations
- **Google OAuth API**: User authentication

### Docker Integration Implementation
- **Service Class**: `server/src/services/docker.ts` - Singleton Docker service with database-driven configuration and automatic reconnection

### Settings Service Layer Architecture
- **Code**: `server/src/services/**` - all the settings code

### Settings API Endpoints Implementation
- **API Router**: `server/src/routes/settings.ts` - RESTful CRUD endpoints for system settings management

### Docker Configuration Service Implementation
- **Service Class**: `server/src/services/docker-config.ts` - Complete Docker configuration management service

### Cloudflare Configuration Service Implementation
- **Service Class**: `server/src/services/cloudflare-config.ts` - Complete Cloudflare API configuration management service
- **Features**: API token validation, account information retrieval, tunnel connectivity testing

### Azure Configuration Service Implementation
- **Service Class**: `server/src/services/azure-config.ts` - Complete Azure Storage configuration management service
- **Features**: Connection string validation, container access testing with retry logic and caching, storage account information retrieval
- **API Integration**: Uses official Azure Storage Blob SDK with timeout protection (15s default) and error handling

### Azure Settings API Endpoints Implementation
- **API Router**: `server/src/routes/azure-settings.ts` - RESTful Azure-specific endpoints for configuration management

### Azure Connectivity Status API Endpoints Implementation
- **API Router**: `server/src/routes/azure-connectivity.ts` - RESTful endpoints for Azure connectivity status retrieval

### Cloudflare Settings API Endpoints Implementation
- **API Router**: `server/src/routes/cloudflare-settings.ts` - RESTful Cloudflare-specific endpoints for configuration management
- **Features**: API token validation, account management, connectivity testing, CRUD operations for Cloudflare settings, tunnel listing and details retrieval with 60-second caching

### Cloudflare Connectivity Status API Endpoints Implementation
- **API Router**: `server/src/routes/cloudflare-connectivity.ts` - RESTful endpoints for Cloudflare connectivity status retrieval
- **Features**: Latest status retrieval, historical data with pagination, response caching with 5-minute TTL, error handling and status codes

### Background Connectivity Monitoring Implementation
- **Scheduler Class**: `server/src/lib/connectivity-scheduler.ts` - Comprehensive background health checking system

### Settings Data Fetching Hooks Implementation
- **Settings Hooks File**: `client/src/hooks/use-settings.ts` - Comprehensive React Query hooks for settings management

### Settings Validation Hooks Implementation
- **Validation Hooks File**: `client/src/hooks/use-settings-validation.ts` - Specialized React Query hooks for 

### Azure Settings Hooks Implementation
- **Azure Hooks File**: `client/src/hooks/use-azure-settings.ts` - Comprehensive React Query hooks for Azure Storage management

### Cloudflare Settings Hooks Implementation
- **Cloudflare Hooks File**: `client/src/hooks/use-cloudflare-settings.ts` - Comprehensive React Query hooks for Cloudflare management
- **Features**: Settings CRUD operations, connectivity testing, tunnel information retrieval, connectivity history, automatic cache invalidation, error handling with retry logic

### Cloudflare Tunnel Status Component Implementation
- **Tunnel Status Component**: `client/src/components/cloudflare/tunnel-status.tsx` - Real-time Cloudflare tunnel monitoring display
- **Features**: Tunnel list with health indicators, expandable details for each tunnel, active connection information, manual refresh capability, real-time status badges (healthy, degraded, inactive, down)

### Settings Navigation and Routing Implementation
- **Settings Routes**: Complete nested routing structure in `client/src/lib/routes.tsx` with protected settings pages
  - `/settings` - Redirects to settings overview
  - `/settings/overview` - Settings dashboard overview
  - `/settings/docker` - Docker configuration management
  - `/settings/cloudflare` - Cloudflare API and tunnel settings  
  - `/settings/azure` - Azure Storage configuration

## Environment Variables

Create a `.env` file in the `server/` directory using the provided `.env.example` template:

```bash
# Copy the example environment file
cp server/.env.example server/.env
```

Environment variables reference (see `server/.env.example`):

```bash
# Database
DATABASE_URL="file:./dev.db"

# Authentication
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
SESSION_SECRET=your_session_secret_key
API_KEY_SECRET=your_api_key_secret_for_hashing

# Server Configuration
NODE_ENV=development
PORT=5000

# Logging
LOG_LEVEL=debug

# Security & CORS
CORS_ORIGIN=http://localhost:3000

# Docker Configuration
# Note: Docker host and API version are now configured via database settings only
CONTAINER_CACHE_TTL=3000
CONTAINER_POLL_INTERVAL=5000

# Azure Configuration
# Note: Azure connection strings are configured via database settings only
AZURE_API_TIMEOUT=15000
CONNECTIVITY_CHECK_INTERVAL=300000
```

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

### SQLite3 Command Line Operations

The project uses SQLite as the database. For direct database inspection and operations, you can use the SQLite3 command line tool.

#### Installation on Windows
```bash
# Download and extract SQLite tools
curl -L -o sqlite3.zip https://www.sqlite.org/2024/sqlite-tools-win-x64-3460100.zip
powershell -Command "Expand-Archive -Path sqlite3.zip -DestinationPath sqlite3_tools"

# Use the extracted sqlite3.exe
./sqlite3_tools/sqlite3.exe server/prisma/dev.db
```

#### Common SQLite Commands
```bash
# Connect to database
sqlite3 server/prisma/dev.db

# List all tables
.tables

# Show table schema
.schema system_settings

# Query data
SELECT * FROM system_settings;
SELECT category, key, value FROM system_settings WHERE category = 'docker';

# Show column headers in output
.headers on

# Change output mode to table format
.mode table

# Export query results to CSV
.mode csv
.output settings.csv
SELECT * FROM system_settings;
.output stdout

# Get database info
.dbinfo

# Exit SQLite
.quit
```

#### Database File Locations
- **Development**: `server/prisma/dev.db`
- **Test**: `server/test-1.db` (when running tests)
- **Production**: Configured via `DATABASE_URL` environment variable

## Security Considerations

- HTTPS enforcement for all communications
- Encrypted storage for sensitive configuration
- Automatic data redaction in logs (passwords, tokens, cookies)
- Secure OAuth implementation
- API key generation and validation
