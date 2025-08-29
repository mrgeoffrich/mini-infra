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
- **Security**: Helmet, rate limiting, CORS, secure sessions
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
- **Container Dashboard**: Full-featured React dashboard for monitoring containers at `/containers` route
- **Real-time Updates**: Live container status with 5-second polling intervals
- **Container Information**: Complete container details including name, status, image, ports, volumes, IP address, creation timestamps
- **Advanced Filtering**: Debounced search by container name and image (300ms delay)
- **Status Filtering**: Filter containers by status (running, stopped, exited, paused, restarting)
- **Sorting & Pagination**: Sort by any field with 50 containers per page
- **Visual Status Indicators**: Color-coded status badges with dot indicators
- **Data Interaction**: Copy container IDs, names, and IP addresses to clipboard
- **Responsive Design**: Mobile-optimized layout with proper responsive breakpoints
- **Error Handling**: User-friendly error messages with retry functionality
- **Business Event Logging**: Container list view events for analytics
- **Request Correlation**: Debug support with request correlation IDs

### 2. PostgreSQL Database Management
- Database connection string storage
- Backup configuration with Azure Storage Account integration
- Manual and scheduled backups (cron expressions)
- Restore operations from Azure Storage backups

### 3. Zero-Downtime Deployment System
- Traefik integration for load balancing
- Blue-green deployment process with health checks
- Automated container deployment and rollback
- Configuration management per application

### 4. Cloudflare Tunnel Management
- Read-only monitoring of existing tunnels
- Tunnel health and connection status
- API integration for real-time updates

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

### 6. Activity Logging & Monitoring
- Comprehensive activity logs for all operations
- Real-time updates and progress tracking
- Structured logging with Pino

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

### Type Organization
- **Authentication Types** (`lib/types/auth.ts`): User profiles, sessions, API keys, OAuth data
- **API Types** (`lib/types/api.ts`): Request/response interfaces, error handling types
- **Container Types** (`lib/types/containers.ts`): Docker container data structures and status enums
- **Utility Types** (`lib/types/index.ts`): Serialization helpers, conditional types, partial/required utilities

### Workspace Configuration
- **Package**: `@mini-infra/types` (private workspace package)
- **Location**: `lib/` directory with own `package.json` and `tsconfig.json`
- **Build Output**: Compiled to `lib/dist/` with `.js` and `.d.ts` files
- **Dependencies**: Client and server reference as `"@mini-infra/types": "file:../lib"`

### Development Integration
- **Import Pattern**: Both projects import via `@mini-infra/types` alias
- **TypeScript Mapping**: Path resolution configured in client/server `tsconfig.json`
- **Vite Alias**: Client uses Vite alias pointing to `../lib/dist`
- **Hot Reload**: TypeScript watch mode (`tsc --watch`) rebuilds types automatically
- **Dev Chain**: `npm run dev` runs lib watch + server + client concurrently

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
- **Session Management**: Express-session with custom Prisma store and automatic cleanup
- **API Endpoints**: RESTful authentication endpoints (/auth/google, /auth/status, /auth/logout)
- **Middleware**: Authentication and authorization middleware for route protection
- **CSRF Protection**: Cross-site request forgery protection with token validation
- **Rate Limiting**: Request rate limiting for authentication endpoints

### Security Features
- **Secure Redirects**: Proper OAuth callback handling with frontend/backend coordination
- **Error Handling**: Comprehensive error parsing and user-friendly error messages
- **Session Security**: Secure cookie configuration with appropriate flags and expiration
- **Data Validation**: Zod schemas for request/response validation
- **Audit Logging**: Structured logging for all authentication events and operations

## Container Data Fetching Implementation

### Frontend Container Hooks
- **useContainers**: Custom React Query hook for fetching container data with real-time polling
  - 5-second polling interval for real-time updates
  - Automatic retry logic with exponential backoff
  - Authentication error handling (no retry on 401/Unauthorized)
  - Request correlation ID for debugging support
  - Configurable options for enabling/disabling, custom intervals, and retry behavior
  
- **useContainerFilters**: State management hook for container filtering and sorting
  - Filter by status, name, and image with debounced input
  - Sorting by any field (name, status, created date, etc.) with ascending/descending order
  - Pagination controls with configurable page size (default: 50)
  - Reset filters functionality
  - Automatic page reset when filters or sorting change

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

## External Integrations

- **Docker API**: Container management via dockerode library with singleton service pattern
- **Traefik API**: Load balancer configuration
- **Cloudflare API**: Tunnel monitoring (read-only)
- **Azure Storage API**: Backup/restore operations
- **Google OAuth API**: User authentication

### Docker Integration Implementation
- **Service Class**: `server/src/services/docker.ts` - Singleton Docker service with automatic reconnection
- **Dependencies**: dockerode, @types/dockerode, node-cache for container API integration and caching
- **Features**: Container listing, detailed inspection, real-time event subscription, data transformation
- **Caching**: 3-second TTL in-memory cache with event-based invalidation
- **Security**: Data sanitization, timeout protection (5s), connection validation
- **Error Handling**: Graceful degradation, automatic reconnection logic, comprehensive error messages
- **API Endpoints**: `server/src/routes/containers.ts` - RESTful endpoints with authentication, rate limiting, filtering, pagination
- **Testing**: Comprehensive unit and integration tests covering Docker service, API endpoints, error scenarios, caching, and data transformation

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
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Docker Configuration
DOCKER_HOST=/var/run/docker.sock
DOCKER_API_VERSION=1.41
CONTAINER_CACHE_TTL=3000
CONTAINER_POLL_INTERVAL=5000
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

## Security Considerations

- HTTPS enforcement for all communications
- Encrypted storage for sensitive configuration
- Automatic data redaction in logs (passwords, tokens, cookies)
- Secure OAuth implementation
- API key generation and validation

## Success Criteria

- 99% successful zero-downtime deployments
- Real-time updates respond within 1 second
- Complete audit trail for all infrastructure operations
- Team members can operate without documentation