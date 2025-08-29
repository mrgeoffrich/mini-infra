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
- **Package Manager**: npm
- **Linting**: ESLint
- **Testing**: Jest + React Testing Library

## Development Environment Notes

- **Platform**: Windows with Git Bash
- **Path Handling**: Use Unix-style paths when using the Bash tool (convert C:\path to /c/path). Otherwise use windows path style.
- **Shell**: Git Bash expects forward slashes and Unix-style drive references

## Core Features

### 1. Docker Container Management
- Read-only dashboard for all running containers
- Real-time status updates via polling
- Container information: name, status, image, ports, volumes, IP, creation time

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
│   │   │   ├── protected-route.tsx    # Route protection component
│   │   │   ├── public-route.tsx       # Public route wrapper
│   │   │   ├── navigation-guard.tsx   # Navigation guards for sections
│   │   │   └── auth-error-boundary.tsx # Authentication error handling
│   │   ├── hooks/           # Custom React hooks (useAuth, useUser, etc.)
│   │   └── lib/             # Frontend utilities
│   │       ├── routes.tsx   # React Router configuration with protected routes
│   │       └── auth-context.tsx # Authentication context provider
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
│   ├── dev.db               # SQLite database file
│   └── package.json         # Backend dependencies
├── projectmanagement/       # Project documentation
│   ├── mini_infra_spec.md  # Project specification
│   ├── mini_infra_tech_spec.md # Technical specification
│   └── sizzle.md           # Marketing/overview document
├── CLAUDE.md                # Claude Code context and instructions
└── package.json             # Root package.json
```

## Database Schema

### Authentication Models

The application uses Prisma ORM with SQLite for data persistence. The authentication system includes three core models:

#### User Model
- **Purpose**: Stores Google OAuth user data and profile information
- **Fields**: id (CUID), email (unique), name, image, googleId (unique), timestamps
- **Relations**: One-to-many with Sessions and ApiKeys, One-to-one with UserPreference

#### Session Model
- **Purpose**: Manages secure user sessions for web authentication
- **Fields**: id (CUID), sessionToken (unique), userId, expires, timestamps
- **Relations**: Many-to-one with User (cascade delete)

#### ApiKey Model
- **Purpose**: Provides API key authentication for webhooks and programmatic access
- **Fields**: id (CUID), name, key (unique), userId, active status, lastUsedAt, timestamps
- **Relations**: Many-to-one with User (cascade delete)

### Container Dashboard Models

#### UserPreference Model
- **Purpose**: Stores user-specific preferences for container dashboard (sorting, filtering, column visibility)
- **Fields**: id (CUID), userId (unique), containerSortField, containerSortOrder, containerFilters (JSON), containerColumns (JSON), timestamps
- **Relations**: One-to-one with User (cascade delete)

#### ContainerCache Model
- **Purpose**: Provides optional database caching for container data with expiration support
- **Fields**: id (CUID), data (JSON), expiresAt (indexed), createdAt
- **Relations**: None (standalone caching table)

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

### Frontend (client/)
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run test` - Run tests
- `npm run lint` - Run linting

### Backend (server/)
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm test` - Run Jest test suite
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint:fix` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting

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