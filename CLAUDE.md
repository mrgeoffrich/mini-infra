# Mini Infra - Claude Code Context

## Project Overview

Mini Infra is a web application designed to manage a single Docker host and its associated infrastructure. It provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using Traefik, and Cloudflare tunnel monitoring.

## Technology Stack

### Frontend
- **Framework**: Vite
- **UI Library**: React 19+
- **Styling**: shadcn 3 and Tailwind CSS 4
- **Icons**: Heroicons
- **Forms**: React Hook Form with Zod validation
- **State Management**: React Query (TanStack Query)

### Backend
- **API**: Express.js
- **Database**: SQLite
- **ORM**: Prisma
- **Authentication**: Passport with Google OAuth
- **Validation**: Zod for runtime type checking
- **Logging**: Pino (high-performance structured logging)
- **Security**: Helmet, rate limiting, CORS, secure sessions
- **Middleware**: Request correlation IDs, error handling, graceful shutdown

#### Express Server Foundation (✅ Completed)
The Express.js server foundation has been established with:
- **Security Middleware**: Helmet for security headers, express-rate-limit for API protection
- **Structured Logging**: Pino with request correlation IDs and automatic data redaction
- **Environment Configuration**: Zod-based validation with development/production configurations
- **Error Handling**: Comprehensive error middleware with proper HTTP status codes
- **Session Management**: Express session configuration for authentication
- **Request Tracking**: UUID-based request correlation across the system
- **Graceful Shutdown**: Proper cleanup and shutdown handling

#### Google OAuth Authentication (✅ Completed)
The Google OAuth backend implementation has been completed with:
- **Passport.js Integration**: Configured with Google OpenID Connect strategy
- **User Management**: Automatic user creation and profile updates from Google OAuth
- **Session Handling**: Secure user serialization and deserialization for sessions
- **TypeScript Support**: Comprehensive type definitions for authentication flow
- **API Endpoints**: Complete authentication routes including login, callback, logout, and status
- **Security**: Proper error handling and logging for authentication events
- **Database Integration**: User data storage with Prisma ORM and SQLite

### Development Tools
- **Language**: TypeScript
- **Package Manager**: npm
- **Linting**: ESLint
- **Testing**: Jest + React Testing Library

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
- OAuth 2.0 with Google
- API key-based authentication for webhooks
- Team support for multiple users

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
│   │   │   └── dashboard/   # Dashboard components and data
│   │   ├── components/      # Reusable UI components
│   │   │   └── ui/          # shadcn UI components
│   │   ├── hooks/           # Custom React hooks
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
- **Relations**: One-to-many with Sessions and ApiKeys

#### Session Model
- **Purpose**: Manages secure user sessions for web authentication
- **Fields**: id (CUID), sessionToken (unique), userId, expires, timestamps
- **Relations**: Many-to-one with User (cascade delete)

#### ApiKey Model
- **Purpose**: Provides API key authentication for webhooks and programmatic access
- **Fields**: id (CUID), name, key (unique), userId, active status, lastUsedAt, timestamps
- **Relations**: Many-to-one with User (cascade delete)

### Database Configuration
- **Provider**: SQLite
- **File Location**: `server/dev.db`
- **Client Location**: `server/src/generated/prisma`
- **Schema File**: `server/prisma/schema.prisma`

## Testing Strategy

- **Jest** for backend API testing
- **@testing-library/user-event** for user interaction simulation
- **Unique test data** using CUID2 for concurrent test isolation
- **Mocked authentication** with NextAuth
- **Database isolation** with user-scoped test data

## External Integrations

- **Docker API**: Container management
- **Traefik API**: Load balancer configuration
- **Cloudflare API**: Tunnel monitoring (read-only)
- **Azure Storage API**: Backup/restore operations
- **Google OAuth API**: User authentication

## Environment Variables

```bash
# Database
DATABASE_URL="file:./dev.db"

# Authentication
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
SESSION_SECRET=your_session_secret_key

# Server Configuration
NODE_ENV=development
PORT=5000

# Logging
LOG_LEVEL=debug

# Security & CORS
CORS_ORIGIN=http://localhost:3000
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
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