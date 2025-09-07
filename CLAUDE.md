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
- **Logging**: Pino with multi-file domain-specific logging architecture
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
│   │   │   │   └── system/  # Docker registry settings
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
│   │   │   ├── auth.ts     # Google OAuth authentication
│   │   │   ├── containers.ts # Docker management
│   │   │   ├── settings.ts   # System settings CRUD
│   │   │   ├── system-settings.ts # Docker registry config
│   │   │   ├── azure-settings.ts  # Azure Storage config
│   │   │   ├── cloudflare-settings.ts # Cloudflare API config
│   │   │   ├── azure-connectivity.ts  # Azure health status
│   │   │   ├── cloudflare-connectivity.ts # Cloudflare status
│   │   │   ├── postgres-databases.ts  # PostgreSQL CRUD
│   │   │   ├── postgres-backup-configs.ts # Backup scheduling
│   │   │   ├── postgres-backups.ts    # Backup execution
│   │   │   ├── postgres-restore.ts    # Restore operations
│   │   │   ├── postgres-progress.ts   # Operation progress
│   │   │   ├── user-preferences.ts    # User settings
│   │   │   └── api-keys.ts # API key management
│   │   ├── services/       # Business logic layer
│   │   │   ├── configuration-base.ts   # Abstract config base
│   │   │   ├── configuration-factory.ts # Service factory
│   │   │   ├── docker-config.ts        # Docker configuration
│   │   │   ├── azure-config.ts         # Azure Storage config
│   │   │   ├── cloudflare-config.ts    # Cloudflare API config
│   │   │   ├── docker.ts              # Docker API integration
│   │   │   ├── docker-executor.ts     # Docker operations
│   │   │   ├── postgres-config.ts     # PostgreSQL connection
│   │   │   ├── backup-config.ts       # Backup configuration
│   │   │   ├── backup-executor.ts     # Backup execution
│   │   │   ├── restore-executor.ts    # Restore operations
│   │   │   ├── user-preferences.ts    # User settings service
│   │   │   └── progress-tracker.ts    # Progress monitoring
│   │   ├── lib/            # Core utilities and middleware
│   │   │   ├── prisma.ts   # Prisma client configuration
│   │   │   ├── logger-factory.ts # Multi-domain logging
│   │   │   ├── logging-config.ts # Logging configuration
│   │   │   ├── api-logger.ts     # API request logging
│   │   │   ├── connectivity-scheduler.ts # Health monitoring
│   │   │   ├── auth-middleware.ts # Authentication middleware
│   │   │   └── validation.ts      # Request validation
│   │   └── __tests__/      # Test files
│   ├── prisma/
│   │   ├── schema.prisma   # Database schema definition
│   │   └── dev.db          # SQLite database file
│   ├── config/
│   │   └── logging.json    # Logging configuration
│   ├── logs/               # Log files (excluded from git)
│   │   ├── app.log         # Application events
│   │   ├── app-http.log    # HTTP requests/responses
│   │   ├── app-prisma.log  # Database operations
│   │   ├── app-services.log # Service layer operations
│   │   └── app-dockerexecutor.log # Docker operations
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

## Database Schema

The application uses Prisma ORM with SQLite for data persistence with comprehensive models for authentication, system configuration, and operational data.

### Database Configuration
- **Provider**: SQLite
- **File Location**: `server/prisma/dev.db`
- **Client Location**: `server/node_modules/.prisma/client`
- **Schema File**: `server/prisma/schema.prisma`

### Core Models

#### Authentication System
- **User**: Google OAuth user profile data with relations to preferences and operations
- **ApiKey**: Webhook authentication system with hashed keys and metadata
- **UserPreference**: User-specific settings including timezone preferences and UI customizations

#### System Configuration
- **SystemSettings**: Encrypted key-value configuration storage for all external service settings
- **ConnectivityStatus**: External service health monitoring with status history and metadata

#### Docker Management
- **ContainerCache**: Cached Docker container information with TTL for performance optimization

#### PostgreSQL Database Management
- **PostgresDatabase**: Database connection configurations with encrypted connection strings
- **BackupConfiguration**: Automated backup scheduling with cron expressions and retention policies
- **BackupOperation**: Individual backup execution records with status tracking and file metadata
- **RestoreOperation**: Database restore operations with progress tracking and validation

### Key Schema Features
- **Encryption Support**: Sensitive data automatically encrypted using crypto-js AES encryption
- **User Scoping**: All user-related data properly scoped via userId foreign keys
- **Operation Tracking**: Comprehensive audit trail for all backup/restore operations
- **Relationship Management**: Full Prisma relations between related entities
- **Unique Constraints**: Proper indexing and unique constraints for data integrity

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

#### Implementation Patterns

**Component Integration**
```typescript
// Import the hook
import { useFormattedDate } from "@/hooks/use-formatted-date";

// In component function
const { formatDateTime, formatDate, formatTime } = useFormattedDate();

// Replace direct date-fns usage
// OLD: format(new Date(date), "MMM d, yyyy HH:mm")
// NEW: formatDateTime(date)

// For memoized formatting
const formattedDate = useFormattedDateTime(operation.startedAt);
```

**Memoization Strategy**
- **Performance**: Formatted dates are memoized to prevent unnecessary re-renders
- **Dependencies**: Memoization keys include date value, formatting function, and user's timezone
- **React.memo**: Compatible with `React.memo` for component-level optimization

#### Updated Components

**PostgreSQL Components**:
- `components/postgres/database-table.tsx` - Database health check timestamps
- `components/postgres/operation-history-list.tsx` - Backup/restore operation times  
- `components/postgres/active-operations-display.tsx` - Real-time operation progress
- `components/postgres/backup-configuration-modal.tsx` - Backup scheduling and history

**Container Management**:
- `app/containers/ContainerTable.tsx` - Container creation and status times
- `app/containers/ContainerDashboard.tsx` - Docker connectivity status
- `app/dashboard/ContainerSummary.tsx` - Dashboard summary timestamps

**Settings and Connectivity**:
- `app/settings/SettingsOverview.tsx` - Service connectivity timestamps
- `app/settings/azure/page.tsx` - Azure service status times
- `app/settings/cloudflare/page.tsx` - Cloudflare service status times
- `components/connectivity-status.tsx` - System connectivity displays
- `components/AzureConnectivityStatus.tsx` - Azure-specific connectivity
- `components/cloudflare/tunnel-status.tsx` - Cloudflare tunnel monitoring

### Backend Date Handling

#### User Preferences Service

**Service Class** (`server/src/services/user-preferences.ts`)
- **CRUD Operations**: Complete user preference management with timezone validation
- **Timezone Validation**: Validates timezone strings against standard IANA timezone database
- **Default Handling**: Automatic UTC default for users without timezone preference
- **Database Integration**: Stores timezone preference in UserPreference model

**API Endpoints** (`server/src/routes/user-preferences.ts`)
- **Authentication**: All endpoints require user authentication via JWT middleware
- **Validation**: Zod schema validation for preference updates including timezone
- **Error Handling**: Comprehensive error handling with specific timezone validation messages
- **Timezone List**: Provides common timezone options for frontend selection

#### Database Schema

**UserPreference Model** (`server/prisma/schema.prisma`)
```prisma
model UserPreference {
  id                 String   @id @default(cuid())
  userId             String   @unique
  timezone           String?  @default("UTC")
  // ... other preferences
}
```

#### Data Storage and Retrieval

**Timezone Storage**:
- **Format**: IANA timezone identifiers (e.g., "America/New_York", "Europe/London", "UTC")
- **Validation**: Server-side validation ensures only valid timezone strings are stored
- **Default Value**: UTC used as fallback when no preference is set

**API Response Format**:
- **Dates**: All API responses return dates in ISO 8601 format (UTC)
- **Client Conversion**: Frontend converts UTC timestamps to user's timezone for display
- **Consistency**: Ensures consistent date handling regardless of server timezone

### User Experience Flow

#### Setting Timezone Preference
1. **User Navigation**: User navigates to `/user/settings`
2. **Timezone Selection**: Dropdown populated from `/api/user/timezones` endpoint
3. **Real-time Preview**: Live preview shows current time in selected timezone
4. **Preference Update**: `PUT /api/user/preferences` with new timezone
5. **Cache Invalidation**: React Query automatically invalidates user preferences cache
6. **Immediate Update**: All date displays across application update without page refresh

#### Cross-Tab Synchronization
- **BroadcastChannel**: User preference changes broadcast across browser tabs
- **Real-time Updates**: All open tabs immediately reflect timezone preference changes
- **Consistent Display**: Ensures consistent date formatting across all user sessions

### Technical Considerations

#### Performance Optimizations
- **React Query Caching**: User preferences cached with 5-minute stale time
- **Memoization**: Date formatting results memoized to prevent unnecessary recalculations
- **Lazy Loading**: Timezone list loaded on-demand when settings page is accessed
- **Background Updates**: Preference changes don't block user interface

#### Browser Compatibility
- **date-fns-tz**: Uses industry-standard library for reliable timezone conversion
- **Fallback Handling**: Graceful degradation when user preferences are unavailable
- **Loading States**: Proper loading indicators while preferences are being fetched

#### Security and Data Protection
- **Authentication**: All preference endpoints require user authentication
- **User Isolation**: Each user's timezone preference isolated via userId
- **Input Validation**: Server-side validation prevents invalid timezone injection
- **Logging**: Preference changes logged for audit purposes (timezone not considered sensitive)

## External Integrations

- **Docker API**: Container management via dockerode library with singleton service pattern
- **Traefik API**: Load balancer configuration
- **Cloudflare API**: Tunnel monitoring (read-only)
- **Azure Storage API**: Backup/restore operations
- **PostgreSQL API**: Direct database connectivity for health checks and backup/restore operations
- **Google OAuth API**: User authentication

### Docker Integration Implementation
- **Service Class**: `server/src/services/docker.ts` - Singleton Docker service with database-driven configuration and automatic reconnection

### PostgreSQL Database Configuration Service Implementation
- **Service Class**: `server/src/services/postgres-config.ts` - Complete PostgreSQL database configuration management service
- **Features**: CRUD operations for database configurations, connection string encryption/decryption using crypto-js, connection testing and health checks, user-scoped database management
- **Security**: AES encryption for sensitive connection strings, secure validation with timeout protection (10s connection, 5s query), comprehensive error handling with categorized error codes
- **Database Integration**: Uses PostgresDatabase, BackupConfiguration, BackupOperation, and RestoreOperation Prisma models with full relationship support

### PostgreSQL Backup Configuration Service Implementation
- **Service Class**: `server/src/services/backup-config.ts` - Complete backup configuration management service for PostgreSQL databases
- **Features**: CRUD operations for backup configurations, cron expression validation using node-cron, Azure container validation, retention policy management
- **Scheduling**: Automated next scheduled backup time calculation, support for enabling/disabling backup schedules
- **Integration**: Azure Storage container validation, comprehensive error handling and logging

### PostgreSQL Database API Endpoints Implementation
- **API Router**: `server/src/routes/postgres-databases.ts` - RESTful CRUD endpoints for PostgreSQL database configuration management
- **Endpoints**: 
  - `GET /api/postgres/databases` - List database configurations with filtering and pagination
  - `GET /api/postgres/databases/:id` - Get specific database configuration
  - `POST /api/postgres/databases` - Create new database configuration
  - `PUT /api/postgres/databases/:id` - Update existing database configuration
  - `DELETE /api/postgres/databases/:id` - Delete database configuration
  - `POST /api/postgres/databases/:id/test` - Test connection for existing database
  - `POST /api/postgres/test-connection` - Test connection with provided credentials (without saving)
- **Features**: Complete CRUD operations, Zod validation schemas, comprehensive error handling with categorized status codes, business event logging, sensitive data redaction in logs

### PostgreSQL Backup Configuration API Endpoints Implementation
- **API Router**: `server/src/routes/postgres-backup-configs.ts` - RESTful endpoints for backup configuration management
- **Endpoints**:
  - `GET /api/postgres/backup-configs/:databaseId` - Get backup configuration for a specific database
  - `POST /api/postgres/backup-configs` - Create new backup configuration
  - `DELETE /api/postgres/backup-configs/:id` - Delete backup configuration
- **Features**: Backup configuration CRUD operations, cron expression validation, Azure container validation, Zod validation schemas, comprehensive error handling, business event logging

### PostgreSQL Restore Operations API Endpoints Implementation
- **API Router**: `server/src/routes/postgres-restore.ts` - RESTful endpoints for restore operations management
- **Endpoints**:
  - `POST /api/postgres/restore/:databaseId` - Initiate restore operation for a specific database
  - `GET /api/postgres/restore/:operationId/status` - Get status of a specific restore operation  
  - `GET /api/postgres/restore/backups/:containerName` - Browse available backups in Azure container for restore
  - `GET /api/postgres/restore/:databaseId/operations` - List restore operations for a specific database
  - `GET /api/postgres/restore/:operationId/progress` - Get detailed progress information for a restore operation
- **Features**: Restore operation CRUD operations, backup browser for Azure Storage, restore confirmation workflow, progress tracking with detailed status updates, comprehensive error handling, business event logging, sensitive data redaction in logs

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

#### User Management
- **UserPreferencesService** (`server/src/services/user-preferences.ts`): User settings management with timezone validation, preference persistence, and cache invalidation
- **ProgressTrackerService** (`server/src/services/progress-tracker.ts`): Real-time operation progress tracking for backup/restore operations

### API Endpoints Architecture

#### Authentication & User Management
- **Authentication** (`server/src/routes/auth.ts`): Google OAuth 2.0 integration with JWT token management
- **User Preferences** (`server/src/routes/user-preferences.ts`): User settings API with timezone management and preference validation
- **API Keys** (`server/src/routes/api-keys.ts`): Webhook authentication system with key generation and management

#### System Configuration
- **Settings** (`server/src/routes/settings.ts`): Generic system settings CRUD with encrypted storage
- **System Settings** (`server/src/routes/system-settings.ts`): Docker registry configuration with connection testing
- **Azure Settings** (`server/src/routes/azure-settings.ts`): Azure Storage configuration management
- **Cloudflare Settings** (`server/src/routes/cloudflare-settings.ts`): Cloudflare API configuration with tunnel management

#### Connectivity Monitoring
- **Azure Connectivity** (`server/src/routes/azure-connectivity.ts`): Azure service health status retrieval
- **Cloudflare Connectivity** (`server/src/routes/cloudflare-connectivity.ts`): Cloudflare service status with caching and historical data

#### PostgreSQL Management
- **Postgres Databases** (`server/src/routes/postgres-databases.ts`): Database configuration CRUD with connection testing
- **Postgres Backup Configs** (`server/src/routes/postgres-backup-configs.ts`): Backup scheduling and configuration
- **Postgres Backups** (`server/src/routes/postgres-backups.ts`): Backup execution and monitoring
- **Postgres Restore** (`server/src/routes/postgres-restore.ts`): Restore operations with backup browsing
- **Postgres Progress** (`server/src/routes/postgres-progress.ts`): Real-time operation progress tracking

#### Container Management
- **Containers** (`server/src/routes/containers.ts`): Docker container management with real-time polling and caching

### Cloudflare Configuration Service Implementation
- **Service Class**: `server/src/services/cloudflare-config.ts` - Complete Cloudflare API configuration management service with circuit breaker pattern
- **Features**: API token validation, account information retrieval, tunnel connectivity testing, circuit breaker for resilient API communication (opens after 5 consecutive failures with 5-minute cooldown), request deduplication within 1-second window, comprehensive error handling with sensitive data redaction

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
- **Features**: Automatic monitoring of all registered services (Docker, Cloudflare, Azure), circuit breaker pattern, exponential backoff for retries, configurable check intervals via CONNECTIVITY_CHECK_INTERVAL environment variable (default 5 minutes)
- **Cloudflare Integration**: Automatically included via ConfigurationServiceFactory, performs periodic health checks using CloudflareConfigService.validate(), supports manual trigger via performHealthCheck('cloudflare')

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
  └─ /system (Docker registry configuration)
/user/settings (personal preferences including timezone)
```

### Component Architecture

#### Core Layout Components
- **App** (`client/src/app/App.tsx`): Main application shell with authentication context
- **Layout** (`client/src/components/Layout.tsx`): Application layout with navigation and user profile
- **ProtectedRoute** (`client/src/components/ProtectedRoute.tsx`): Route guard with authentication checking
- **PublicRoute** (`client/src/components/PublicRoute.tsx`): Public route wrapper for login page

#### Page Components

**Dashboard & Navigation**
- **Dashboard** (`client/src/app/dashboard/page.tsx`): Main overview with service status and container summary
- **Login** (`client/src/app/login/page.tsx`): Google OAuth authentication interface

**Container Management**
- **Containers** (`client/src/app/containers/page.tsx`): Docker container management with real-time polling
- **ContainerTable** (`client/src/app/containers/ContainerTable.tsx`): Data table with filtering and sorting
- **ContainerDashboard** (`client/src/app/containers/ContainerDashboard.tsx`): Container overview with connectivity status

**PostgreSQL Management**
- **Postgres** (`client/src/app/postgres/page.tsx`): Database management dashboard
- **Database Components** (`client/src/components/postgres/`):
  - `database-table.tsx` - Database configuration table with health checks
  - `backup-configuration-modal.tsx` - Backup scheduling interface
  - `operation-history-list.tsx` - Backup/restore operation history
  - `active-operations-display.tsx` - Real-time operation progress

**Service Monitoring**
- **Connectivity Overview** (`client/src/app/connectivity/overview/page.tsx`): Service health dashboard
- **Docker Status** (`client/src/app/connectivity/docker/page.tsx`): Docker service connectivity
- **Azure Status** (`client/src/app/connectivity/azure/page.tsx`): Azure Storage service status
- **Cloudflare Status** (`client/src/app/connectivity/cloudflare/page.tsx`): Cloudflare API and tunnel status
- **Tunnels** (`client/src/app/tunnels/page.tsx`): Cloudflare tunnel monitoring with detailed status

**Configuration Management**
- **System Settings** (`client/src/app/settings/system/page.tsx`): Docker registry configuration with connection testing
- **User Settings** (`client/src/app/user/settings/page.tsx`): Personal preferences including timezone selection

#### Specialized Components

**Authentication Components**
- **Error Boundary** (`client/src/components/ErrorBoundary.tsx`): Application-level error handling
- **Auth Forms** (`client/src/components/auth/`): Login forms and authentication UI

**Service Status Components**
- **ConnectivityStatus** (`client/src/components/connectivity-status.tsx`): Generic service status display
- **AzureConnectivityStatus** (`client/src/components/AzureConnectivityStatus.tsx`): Azure-specific status monitoring
- **Cloudflare Tunnel Status** (`client/src/components/cloudflare/tunnel-status.tsx`): Tunnel monitoring with health indicators

### React Hooks Architecture

#### Authentication Hooks (`client/src/hooks/`)
- **useAuth** (`use-auth.ts`): Core authentication state management
- **useLogin** (`use-login.ts`): Google OAuth login flow
- **useLogout** (`use-logout.ts`): Session termination
- **useUser** (`use-user.ts`): Current user information

#### Data Management Hooks
- **useContainers** (`use-containers.ts`): Docker container data with 5-second polling
- **useUserPreferences** (`use-user-preferences.ts`): User settings with cache management
- **useFormattedDate** (`use-formatted-date.ts`): Timezone-aware date formatting

#### Configuration Hooks
- **useSettings** (`use-settings.ts`): Generic system settings management
- **useSystemSettings** (`use-system-settings.ts`): Docker registry configuration
- **useAzureSettings** (`use-azure-settings.ts`): Azure Storage configuration
- **useCloudflareSettings** (`use-cloudflare-settings.ts`): Cloudflare API configuration

#### Validation & Testing Hooks
- **useSettingsValidation** (`use-settings-validation.ts`): Configuration validation
- **useTestDockerRegistry** (`use-system-settings.ts`): Docker registry connection testing

### System Settings Implementation
- **System Settings Page**: `client/src/app/settings/system/page.tsx` - Docker container configuration management
- **Features**: 
  - Docker image configuration for backup and restore operations
  - Registry authentication with username/password fields
  - **Docker Registry Test Connection**: Test Docker registry connectivity and image access
  - Form validation with Zod schemas for Docker image format
  - Encrypted storage of registry passwords
- **Backend Routes**: `server/src/routes/system-settings.ts` - System-specific settings endpoints
  - `POST /api/settings/system/test-docker-registry` - Test Docker registry connection endpoint
- **Docker Integration**: Enhanced `DockerExecutorService` with `testDockerRegistryConnection()` method
  - Performs actual Docker image pull to verify registry access
  - Supports both public and private registries with authentication
  - Comprehensive error handling with specific error codes (AUTHENTICATION_REQUIRED, IMAGE_NOT_FOUND, TIMEOUT, NETWORK_ERROR)
  - Performance metrics and detailed test results
- **Frontend Hook**: `client/src/hooks/use-system-settings.ts` - React Query hooks for system settings operations
  - `useTestDockerRegistry()` mutation for testing registry connections
  - Error handling and loading states

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

## Logging Architecture

The application uses a sophisticated multi-file logging architecture built on Pino for high-performance structured logging with domain separation.

### Core Logging Components

#### Logger Factory (`server/src/lib/logger-factory.ts`)
- **Domain-Specific Loggers**: Separate logger instances for different application domains
- **Configuration-Driven**: Uses external JSON configuration for flexible log management
- **Environment Aware**: Different behaviors for development, production, and test environments
- **Log Rotation**: Built-in support for production log rotation using pino-roll

#### Configuration System (`server/src/lib/logging-config.ts`)
- **External Configuration**: JSON-based configuration file at `server/config/logging.json`
- **Environment-Specific Settings**: Separate configurations for dev/prod/test
- **Validation**: Zod schema validation for configuration integrity
- **Dynamic Loading**: Runtime configuration loading with fallback defaults

### Log File Structure

#### Development Environment
- **Pretty Printing**: Human-readable colored output with timestamps
- **File Destinations**: All logs written to separate files in `server/logs/`
- **Debug Level**: Detailed logging for development and troubleshooting

#### Production Environment
- **Structured JSON**: Machine-readable JSON format for log aggregation
- **Log Rotation**: Automatic rotation with 14-day retention and 10MB size limits
- **Optimized Levels**: Higher log thresholds for production performance
- **Sensitive Data Redaction**: Comprehensive redaction of passwords, tokens, and secrets

### Domain-Specific Logging

#### Application Logger (`logs/app.log`)
- **Purpose**: General application events, startup, shutdown, and core functionality
- **Usage**: Server initialization, connectivity scheduling, error handling
- **Level**: Debug (dev) / Info (prod)

#### HTTP Logger (`logs/app-http.log`)  
- **Purpose**: HTTP requests, responses, and API interactions
- **Usage**: Request/response middleware, API completion timing, business events
- **Level**: Info (all environments)
- **Features**: Request correlation IDs, response times, status codes

#### Prisma Logger (`logs/app-prisma.log`)
- **Purpose**: Database operations, queries, and ORM events
- **Usage**: SQL query logging, database connection events, query performance
- **Level**: Info (dev) / Warn (prod)
- **Features**: Query text, parameters, execution time, connection targets

#### Services Logger (`logs/app-services.log`)
- **Purpose**: Service layer operations and business logic
- **Usage**: All files in `server/src/services/` directory
- **Level**: Debug (dev) / Info (prod)
- **Features**: Service validation, external API calls, configuration updates

#### Docker Executor Logger (`logs/app-dockerexecutor.log`)
- **Purpose**: Docker operations and container management
- **Usage**: Docker image pulling, registry authentication, container operations
- **Level**: Debug (dev) / Info (prod)
- **Features**: Docker API calls, image pull progress, registry validation, error handling

### Security and Data Protection

#### Comprehensive Data Redaction
- **Sensitive Fields**: Passwords, tokens, API keys, connection strings, cookies
- **Header Protection**: Authorization headers, session tokens, set-cookie responses
- **Request Body Filtering**: Password fields and authentication data
- **Pattern Matching**: Wildcard patterns for nested object protection

#### Log File Security
- **Directory Exclusion**: `logs/` directory excluded from version control
- **File Permissions**: Appropriate file system permissions for log access
- **Rotation Cleanup**: Automatic cleanup of old log files in production

### Implementation Details

#### Service Integration
- **Centralized Import**: All service files import `servicesLogger` from logger factory
- **Consistent Usage**: Standardized logging patterns across all service classes
- **Context Preservation**: Maintains existing logging context and correlation IDs

#### HTTP Middleware Integration
- **Dedicated HTTP Logger**: Separate logger instance for HTTP-specific events
- **Request Correlation**: Maintains request ID correlation across log entries
- **Performance Tracking**: Request timing and response status logging

#### Backward Compatibility
- **Legacy Support**: `server/src/lib/logger.ts` maintained for backward compatibility
- **Seamless Migration**: Existing code continues to work without modifications
- **Gradual Adoption**: New code can gradually adopt domain-specific loggers

### Configuration Example

```json
{
  "development": {
    "services": {
      "level": "debug",
      "destination": "logs/app-services.log",
      "prettyPrint": true,
      "rotation": { "enabled": false }
    }
  },
  "production": {
    "services": {
      "level": "info", 
      "destination": "logs/app-services.log",
      "prettyPrint": false,
      "rotation": {
        "enabled": true,
        "maxFiles": "14d",
        "maxSize": "10m"
      }
    }
  }
}
```

### Usage Patterns

#### Service Layer Logging
```typescript
import { servicesLogger } from "../lib/logger-factory";

const logger = servicesLogger();
logger.info({ configKey: "docker.host" }, "Configuration updated");
```

#### HTTP Request Logging
```typescript
import { createApiLogger, logApiCompletion } from "../lib/api-logger";

const { logger, context } = createApiLogger(req);
logger.info("Processing API request");
```

## Implementation Status & Feature Completeness

### Fully Implemented & Production Ready

#### ✅ Core Infrastructure
- **Authentication System**: Complete Google OAuth 2.0 integration with JWT tokens, secure session management, and cross-tab synchronization
- **Database Management**: Full Prisma ORM implementation with SQLite, comprehensive model relationships, and encrypted sensitive data storage
- **Logging Architecture**: Multi-file domain-specific logging with Pino, comprehensive data redaction, and production log rotation
- **Configuration Management**: Encrypted settings storage, external service configuration, and validation with timeout protection

#### ✅ Docker Container Management
- **Real-time Container Monitoring**: Live polling with 5-second intervals, container status tracking, and automatic cache refresh
- **Docker API Integration**: Singleton service pattern with database-driven configuration and automatic reconnection
- **Docker Registry Testing**: Registry authentication validation, image pull testing, and comprehensive error handling

#### ✅ PostgreSQL Database Operations
- **Database Configuration**: Complete CRUD operations with encrypted connection strings and connection testing
- **Automated Backup System**: Cron-based scheduling, Azure Storage integration, retention policies, and progress tracking
- **Restore Operations**: Database restoration with backup browsing, progress monitoring, and validation
- **Operation History**: Complete audit trail for all backup/restore operations with detailed metadata

#### ✅ External Service Integration
- **Azure Storage**: Connection validation, container access testing, blob operations, and retry logic with caching
- **Cloudflare API**: Circuit breaker pattern, tunnel monitoring, account management, and request deduplication
- **Service Health Monitoring**: Background connectivity checking with exponential backoff and configurable intervals

#### ✅ User Experience
- **Timezone-Aware Date Display**: Complete user preference system with real-time timezone conversion across all components
- **Responsive UI**: Modern React 19 + shadcn/ui interface with Tailwind CSS 4 and comprehensive component library
- **Real-time Updates**: Live data polling, progress tracking, and automatic UI updates without page refresh

### Partially Implemented Features

#### ⚠️ Settings Management
- **Current State**: System settings (Docker registry) fully implemented, but settings overview page redirects instead of showing dashboard
- **Missing**: General settings overview interface and navigation structure
- **Impact**: Users must navigate directly to specific settings categories

#### ⚠️ Cloudflare Tunnel Management  
- **Current State**: Comprehensive tunnel monitoring and status display with health indicators
- **Missing**: Tunnel configuration management (create/edit/delete tunnels)
- **Impact**: Read-only tunnel monitoring, no tunnel lifecycle management

### Documented But Not Implemented

#### ❌ Zero-Downtime Deployment System
- **Status**: Documented in project overview but no implementation found
- **Missing**: Traefik integration, deployment pipeline, rolling updates
- **Impact**: No automated deployment capabilities

#### ❌ Activity Logs Interface
- **Status**: Route exists (`/activity-logs`) but shows "Coming Soon" placeholder
- **Missing**: User activity tracking, system event logging interface, audit trail UI
- **Impact**: No visibility into system activities and user actions

#### ❌ General Settings Overview
- **Status**: Settings navigation redirects to system settings instead of overview
- **Missing**: Settings dashboard, category overview, quick access to all configurations
- **Impact**: Limited settings navigation experience

### Architecture Discrepancies

#### Route Structure Changes
- **Documentation**: Suggests `/settings/overview`, `/settings/docker`, `/settings/azure`, `/settings/cloudflare`
- **Implementation**: Uses `/connectivity/*` structure and `/settings/system` only
- **Impact**: Navigation differs from documented structure but provides better UX grouping

#### Service Health Monitoring
- **Enhancement**: Implemented more comprehensive connectivity monitoring than documented
- **Added Features**: Circuit breaker patterns, historical status data, and automated health checks
- **Impact**: Better than documented functionality

### Testing & Quality Assurance

#### ✅ Comprehensive Test Coverage
- **Backend Testing**: Jest + Supertest with comprehensive API endpoint coverage, service layer unit tests, and database integration tests
- **Test Isolation**: User-scoped test data, database cleanup, and concurrent test execution
- **Mocking Strategy**: External API mocking, authentication mocking, and service layer isolation

#### ✅ Code Quality
- **TypeScript**: Strict type checking across frontend and backend with shared types package
- **Linting**: ESLint configuration with automatic fixes and code formatting
- **Build System**: Proper dependency management and build ordering for monorepo

### Development Experience

#### ✅ Developer Workflow
- **Hot Reload**: Live recompilation for both frontend and backend during development
- **Concurrent Development**: All services run simultaneously with proper dependency management
- **Database Management**: Prisma Studio access, migration system, and schema synchronization

### Production Readiness Assessment

#### ✅ Production Ready Components
- Authentication, database operations, external service integrations, logging, monitoring, and core UI functionality

#### ⚠️ Needs Completion for Full Production
- Settings overview interface, activity logging UI, and deployment management system

#### 🚀 Ready for Initial Deployment  
The application is production-ready for Docker container management and PostgreSQL backup operations with comprehensive monitoring capabilities.

## Security Considerations

- **HTTPS Enforcement**: All communications secured with HTTPS
- **Encrypted Storage**: Sensitive configuration data encrypted using crypto-js AES encryption
- **Automatic Data Redaction**: Comprehensive logging redaction for passwords, tokens, and cookies
- **Secure OAuth Implementation**: Google OAuth 2.0 with proper token management and session security
- **API Key Generation**: Secure webhook authentication with hashed keys and metadata
- **Input Validation**: Zod schema validation for all API endpoints and user inputs
- **User Isolation**: All data properly scoped by user ID with secure access controls
