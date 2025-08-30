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
- **Settings Types** (`lib/types/settings.ts`): System settings, connectivity status, validation and configuration service interfaces
- **Azure Types** (`lib/types/azure.ts`): Azure Storage specific request/response types, connection metadata, account info, container data, and error handling
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

### Security Features
- **Secure Redirects**: Proper OAuth callback handling with frontend/backend coordination
- **Error Handling**: Comprehensive error parsing and user-friendly error messages
- **Session Security**: Secure cookie configuration with appropriate flags and expiration
- **Data Validation**: Zod schemas for request/response validation

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
- **Configuration Source**: Uses DockerConfigService to retrieve host and API version settings exclusively from database (no environment variable fallbacks)
- **Dependencies**: dockerode, @types/dockerode, node-cache for container API integration and caching
- **Features**: Container listing, detailed inspection, real-time event subscription, data transformation
- **Caching**: 3-second TTL in-memory cache with event-based invalidation
- **Security**: Data sanitization, timeout protection (5s), connection validation
- **Error Handling**: Graceful degradation with database recording, automatic reconnection logic, comprehensive error messages
- **Graceful Failure**: Server continues startup even if Docker connection fails, with degraded functionality and automatic retry attempts
- **Dynamic Reconfiguration**: Automatically refreshes connection when settings change through DockerConfigService
- **Connectivity Monitoring**: Records connection status and errors in ConnectivityStatus database table
- **API Endpoints**: `server/src/routes/containers.ts` - RESTful endpoints with authentication, filtering, pagination
- **Testing**: Comprehensive unit and integration tests covering Docker service, API endpoints, error scenarios, caching, and data transformation

### Settings Service Layer Architecture
- **Base Class**: `server/src/services/configuration-base.ts` - Abstract ConfigurationService with database integration
- **Service Factory**: `server/src/services/configuration-factory.ts` - Factory pattern for creating configuration service instances
- **Docker Configuration Service**: `server/src/services/docker-config.ts` - Docker host validation and management
- **Cloudflare Configuration Service**: `server/src/services/cloudflare-config.ts` - Cloudflare API key validation and tunnel management
- **Type Definitions**: Extended `@mini-infra/types` with ValidationResult, ServiceHealthStatus, and IConfigurationService interfaces
- **Database Integration**: Built-in support for SystemSettings and ConnectivityStatus models
- **Connectivity Monitoring**: Built-in methods for recording and retrieving service health status
- **Azure Configuration Service**: `server/src/services/azure-config.ts` - Azure Storage validation and management
- **Error Handling**: Comprehensive error logging with structured Pino logging integration
- **Background Connectivity Monitoring**: `server/src/lib/connectivity-scheduler.ts` - Automated health checking scheduler with circuit breaker and exponential backoff patterns

### Settings API Endpoints Implementation
- **API Router**: `server/src/routes/settings.ts` - RESTful CRUD endpoints for system settings management
- **Authentication**: Protected by JWT authentication middleware with proper user context extraction
- **CRUD Operations**: Complete Create, Read, Update, Delete operations for system settings
- **Filtering & Pagination**: Support for filtering by category, active status, validation status with pagination (max 100 items per page)
- **Request Validation**: Comprehensive Zod schema validation for all request parameters and bodies
- **Error Handling**: Standardized error responses with proper HTTP status codes and structured error messages
- **Security Features**: Sensitive value redaction in logs, encrypted storage support, proper authorization checks
- **API Endpoints**: 
  - `GET /api/settings` - List settings with filtering and pagination
  - `GET /api/settings/:id` - Get specific setting by ID
  - `POST /api/settings` - Create new system setting
  - `PUT /api/settings/:id` - Update existing setting
  - `DELETE /api/settings/:id` - Delete system setting
- **Type Safety**: Full TypeScript integration with `@mini-infra/types` for request/response interfaces

### Docker Configuration Service Implementation
- **Service Class**: `server/src/services/docker-config.ts` - Complete Docker configuration management service
- **Features**: Docker host validation, API connectivity testing, version information retrieval, health status monitoring
- **Configuration Support**: Supports Unix sockets, Windows named pipes, and TCP connections with Docker API
- **Validation Methods**: Real-time Docker API connectivity testing with timeout protection (5s default)
- **Error Handling**: Comprehensive error mapping to connectivity status with Docker-specific error codes
- **Caching**: Automatic Docker client cache invalidation when configuration changes
- **Integration**: Built on existing dockerode library with full compatibility with current Docker service patterns

### Cloudflare Configuration Service Implementation
- **Service Class**: `server/src/services/cloudflare-config.ts` - Complete Cloudflare API configuration management service
- **Features**: API token validation, account information retrieval, tunnel connectivity testing
- **API Integration**: Uses official Cloudflare SDK with timeout protection (10s default)
- **Validation Methods**: Real-time Cloudflare API connectivity testing with user profile and account validation
- **Tunnel Management**: Retrieval of tunnel information including status, connections, and configuration details
- **Security Features**: API token redaction in logs, encrypted storage support
- **Error Handling**: Comprehensive error parsing with Cloudflare-specific error codes (timeout, unauthorized, network errors)
- **Configuration Management**: Secure API token and account ID storage with validation and removal capabilities

### Azure Configuration Service Implementation
- **Service Class**: `server/src/services/azure-config.ts` - Complete Azure Storage configuration management service
- **Features**: Connection string validation, container access testing, storage account information retrieval
- **API Integration**: Uses official Azure Storage Blob SDK with timeout protection (15s default) and error handling
- **Validation Methods**: Real-time Azure Storage connectivity testing with account validation and container listing
- **Container Management**: Retrieval of container information including metadata, access testing, and storage account details
- **Security Features**: Connection string redaction in logs, encrypted storage support
- **Error Handling**: Comprehensive error parsing with Azure-specific error codes (authentication, network errors, invalid credentials)
- **Configuration Management**: Secure connection string storage with validation and removal capabilities

### Azure Settings API Endpoints Implementation
- **API Router**: `server/src/routes/azure-settings.ts` - RESTful Azure-specific endpoints for configuration management
- **Authentication**: Protected by JWT authentication middleware with proper user context extraction
- **API Endpoints**: 
  - `GET /api/settings/azure` - Retrieve current Azure configuration with validation status
  - `PUT /api/settings/azure` - Update Azure configuration with connection string validation
  - `POST /api/settings/azure/validate` - Test Azure connection with optional temporary connection string
  - `DELETE /api/settings/azure` - Remove Azure configuration and record disconnection status
  - `GET /api/settings/azure/containers` - List Azure Storage containers with metadata
  - `POST /api/settings/azure/test-container` - Test access to specific Azure Storage container
- **Request Validation**: Comprehensive Zod schema validation for all request parameters and bodies
- **Error Handling**: Standardized error responses with proper HTTP status codes and structured error messages
- **Security Features**: Connection string redaction in logs, encrypted storage integration, proper authorization checks
- **Type Safety**: Full TypeScript integration with `@mini-infra/types` for request/response interfaces
- **Integration**: Direct integration with existing AzureConfigService for all storage operations
- **Comprehensive Testing**: Complete test coverage in `server/src/routes/__tests__/azure-settings.test.ts` including:
  - Authentication requirement tests for all endpoints (GET, PUT, POST, DELETE)
  - Successful CRUD operations testing with proper mocking of AzureConfigService
  - Validation endpoint testing with mock Azure responses and error scenarios
  - Error handling tests for invalid connection strings, network failures, timeouts, and database errors
  - Concurrent access testing for simultaneous validation and configuration update requests
  - Request validation testing with Zod schemas and malformed data scenarios
  - Container listing and access testing with proper metadata handling
  - Service isolation through comprehensive mocking of all external dependencies

### Azure Connectivity Status API Endpoints Implementation
- **API Router**: `server/src/routes/azure-connectivity.ts` - RESTful endpoints for Azure connectivity status retrieval
- **Authentication**: Protected by JWT authentication middleware with proper user context extraction
- **API Endpoints**: 
  - `GET /api/connectivity/azure` - Get latest Azure connectivity status with caching (30s TTL)
  - `GET /api/connectivity/azure/history` - Get Azure connectivity history with pagination, filtering, and sorting
- **Request Validation**: Comprehensive Zod schema validation for query parameters including pagination, date ranges, and status filtering
- **Response Caching**: NodeCache implementation with appropriate TTL (30s for latest status, 2 minutes for history)
- **Filtering Support**: Filter by connectivity status, date ranges (startDate/endDate) with flexible query parameters
- **Pagination**: Full pagination support with configurable page size (max 100), total counts, and navigation metadata
- **Sorting**: Sortable by checkedAt, status, responseTimeMs with ascending/descending order
- **Error Handling**: Standardized error responses with proper HTTP status codes and structured error messages
- **Database Integration**: Direct integration with ConnectivityStatus database model for Azure service records
- **Type Safety**: Full TypeScript integration with `@mini-infra/types` connectivity status interfaces

### Background Connectivity Monitoring Implementation
- **Scheduler Class**: `server/src/lib/connectivity-scheduler.ts` - Comprehensive background health checking system
- **Monitoring Interval**: Configurable periodic health checks (default: 5 minutes) for all configured services
- **Circuit Breaker Pattern**: Prevents cascading failures with configurable failure thresholds and timeout periods
- **Exponential Backoff**: Automatic retry logic with exponential delay to handle temporary service disruptions
- **Service Integration**: Utilizes existing configuration services (Docker, Cloudflare, Azure) for health validation
- **Database Updates**: Automatic ConnectivityStatus database updates with detailed health metrics and timestamps
- **Server Integration**: Integrated with server startup (`server/src/server.ts`) and graceful shutdown processes
- **Monitoring Features**: Real-time status tracking, circuit breaker state management, failure counting, and detailed logging
- **Error Handling**: Comprehensive error logging with structured Pino integration and connection status classification
- **Parallel Execution**: All service health checks run concurrently to minimize overall check duration

### Settings Data Fetching Hooks Implementation
- **Settings Hooks File**: `client/src/hooks/use-settings.ts` - Comprehensive React Query hooks for settings management
- **useSystemSettings Hook**: Fetches system settings with filtering, pagination, and caching (5s stale time)
- **useSystemSetting Hook**: Fetches individual setting by ID with proper error handling
- **Settings Mutation Hooks**: useCreateSystemSetting, useUpdateSystemSetting, useDeleteSystemSetting for CRUD operations
- **useSettingsValidation Hook**: Real-time validation with debounced requests and extended cache time (30s stale time)
- **useValidateService Hook**: Manual service validation with mutation pattern for on-demand testing
- **useConnectivityStatus Hook**: Real-time connectivity monitoring with 30s polling interval
- **Filter Management**: useSettingsFilters, useConnectivityFilters for state management
- **Error Handling**: Comprehensive error handling with authentication error detection and exponential backoff
- **React Query Integration**: Proper cache invalidation, optimistic updates, and query key management
- **TypeScript Support**: Full type integration with `@mini-infra/types` for all API interactions
- **Request Correlation**: Debug support with correlation IDs for all API requests

### Settings Validation Hooks Implementation
- **Validation Hooks File**: `client/src/hooks/use-settings-validation.ts` - Specialized React Query hooks for real-time validation and connectivity monitoring
- **useConnectivityStatus Hook**: Real-time connectivity status monitoring with 30s polling interval for service health tracking
- **useSettingsValidator Hook**: Debounced validation with configurable delay (500ms default) to prevent excessive API calls
- **useServiceConnectivity Hook**: Service-specific connectivity monitoring with real-time polling for individual services
- **useValidateService Hook**: Manual validation trigger with mutation pattern for on-demand connectivity testing
- **useOptimisticValidation Hook**: Optimistic updates for validation results with pending states and timestamp tracking
- **useValidationRecovery Hook**: Automatic retry logic with exponential backoff and circuit breaker patterns for failed validations
- **useAdvancedSettingsValidation Hook**: Combined validation hook with integrated debouncing, polling, retry logic, and optimistic updates
- **Real-time Features**: Live connectivity status updates, automatic recovery from failures, and comprehensive error handling
- **Performance Optimization**: Debounced validation requests, intelligent caching strategies, and request correlation for debugging

### Azure Settings Hooks Implementation
- **Azure Hooks File**: `client/src/hooks/use-azure-settings.ts` - Comprehensive React Query hooks for Azure Storage management
- **useAzureSettings Hook**: Fetches current Azure configuration with connectivity status and account information (5s stale time)
- **useUpdateAzureSettings Mutation**: Updates Azure Storage connection string and configuration with automatic cache invalidation
- **useValidateAzureConnection Mutation**: Tests Azure connectivity with optional temporary connection string for validation
- **useDeleteAzureSettings Mutation**: Removes Azure configuration and clears related caches (containers, connectivity status)
- **useAzureContainers Hook**: Fetches Azure Storage container list with metadata (30s stale time, no auto-refetch on focus)
- **useTestAzureContainerAccess Mutation**: Tests access to specific Azure Storage containers with response time metrics
- **useAzureConnectivityStatus Hook**: Real-time Azure connectivity monitoring with 30s polling interval
- **useAzureConnectivityHistory Hook**: Fetches paginated Azure connectivity history with filtering and sorting support
- **Filter Management Hooks**: useAzureContainerFilters and useAzureConnectivityFilters for state management
- **Error Handling**: Comprehensive retry logic with authentication error detection and Azure-specific error handling
- **React Query Integration**: Proper cache invalidation, optimistic updates, and query key management for all Azure operations
- **TypeScript Support**: Full type integration with `@mini-infra/types` Azure-specific interfaces
- **Request Correlation**: Debug support with correlation IDs for all Azure API requests
- **Performance Features**: Intelligent caching strategies, configurable polling intervals, and selective auto-refetch behavior

### Settings Navigation and Routing Implementation
- **Settings Routes**: Complete nested routing structure in `client/src/lib/routes.tsx` with protected settings pages
  - `/settings` - Redirects to settings overview
  - `/settings/overview` - Settings dashboard overview
  - `/settings/docker` - Docker configuration management
  - `/settings/cloudflare` - Cloudflare API and tunnel settings  
  - `/settings/azure` - Azure Storage configuration
- **Sidebar Navigation**: Expandable settings navigation in `client/src/components/app-sidebar.tsx` with hierarchical submenu
  - Main settings link with active state detection based on pathname
  - Expandable submenu showing all settings pages when active
  - Visual icons for each settings category (Docker, Cloudflare, Azure, etc.)
  - Proper active state highlighting for current settings page
- **Breadcrumb Navigation**: Dynamic breadcrumb system in `client/src/components/site-header.tsx`
  - Automatic breadcrumb generation for settings pages (Settings > Page Name)
  - Clickable breadcrumb links for easy navigation back to settings overview
  - Contextual page title display for non-settings pages
  - Responsive breadcrumb layout with proper spacing and visual hierarchy

### Settings Overview Dashboard Implementation
- **Settings Overview Page**: Comprehensive settings dashboard at `/settings/overview` implemented in `client/src/app/settings/`
- **Settings Summary Cards**: Real-time overview showing total settings, valid configurations, error counts, and configured categories
- **Service Configuration Cards**: Individual cards for Docker, Cloudflare, and Azure services showing:
  - Service description and configuration status
  - Real-time connectivity status with color-coded indicators
  - Response times and last checked timestamps
  - Direct navigation to service-specific configuration pages
- **Service Health Panel**: Live connectivity status for all services with response time metrics
- **Real-time Data**: Automatic polling of connectivity status (30s intervals) and settings data (5s cache)
- **Error Handling**: Comprehensive error displays with retry functionality and user-friendly error messages
- **Loading States**: Skeleton loading components for smooth UX during data fetching
- **Responsive Design**: Mobile-optimized layout with proper grid breakpoints for different screen sizes

### Cloudflare Settings Configuration Form Implementation
- **Cloudflare Settings Page**: Complete Cloudflare configuration form at `/settings/cloudflare` implemented in `client/src/app/settings/cloudflare/page.tsx`
- **Secure API Token Input**: Form field with show/hide toggle for Cloudflare API token input with proper validation
- **Real-time API Key Validation**: Integration with settings validation hooks for live connectivity testing and feedback
- **Encrypted Storage**: API tokens are automatically encrypted when saved to the database for security
- **Account ID Support**: Optional Account ID field for enhanced tunnel management capabilities
- **Zod Schema Validation**: Comprehensive client-side validation for API token format and Account ID format
- **Connection Testing**: Manual test connection button with real-time feedback and error handling
- **Status Indicators**: Color-coded connectivity status badges with response times and error messages
- **Form Integration**: Built on React Hook Form with proper error states and validation messaging
- **Security Features**: API token masking in UI, encrypted database storage, and secure form submission
- **Error Handling**: Comprehensive error handling for API failures and network issues
- **Loading States**: Proper loading indicators during validation, connection testing, and form submission
- **Responsive Design**: Mobile-optimized layout matching the existing settings page design patterns

### Azure Settings Configuration Form Implementation
- **Azure Settings Page**: Complete Azure Storage configuration form at `/settings/azure` implemented in `client/src/app/settings/azure/page.tsx`
- **Secure Connection String Input**: Form field with show/hide toggle for Azure Storage connection string input with proper validation
- **Real-time Storage Validation**: Integration with settings validation hooks for live connectivity testing and feedback
- **Encrypted Storage**: Connection strings are automatically encrypted when saved to the database for security
- **Zod Schema Validation**: Comprehensive client-side validation for connection string format including required fields (DefaultEndpointsProtocol, AccountName, AccountKey)
- **Connection Testing**: Manual test connection button with real-time feedback and error handling
- **Status Indicators**: Color-coded connectivity status badges with response times and error messages
- **Storage Account Details**: Display of storage account information including account name, SKU, container count when connected
- **Container Information**: Shows sample container names and counts when connection is validated
- **Form Integration**: Built on React Hook Form with proper error states and validation messaging
- **Security Features**: Connection string masking in UI, encrypted database storage, and secure form submission
- **Error Handling**: Comprehensive error handling for Azure API failures, authentication errors, and network issues
- **Loading States**: Proper loading indicators during validation, connection testing, and form submission
- **Responsive Design**: Mobile-optimized layout matching the existing settings page design patterns


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

## Success Criteria

- 99% successful zero-downtime deployments
- Real-time updates respond within 1 second
- Team members can operate without documentation