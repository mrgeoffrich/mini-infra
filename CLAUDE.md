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
- **Security**: Cloudflare Turnstile integration

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
│   │   └── server.ts       # Server entry point
│   ├── dist/                # Backend build output
│   └── package.json         # Backend dependencies
├── projectmanagement/       # Project documentation
│   ├── mini_infra_spec.md  # Project specification
│   ├── mini_infra_tech_spec.md # Technical specification
│   └── sizzle.md           # Marketing/overview document
├── CLAUDE.md                # Claude Code context and instructions
└── package.json             # Root package.json
```

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
# Authentication
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret

# Logging
LOG_LEVEL=debug
NODE_ENV=development
```

## Key Commands

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run test` - Run tests
- `npm run lint` - Run linting
- `npx prisma db push` - Sync database schema
- `npx prisma studio` - Open database GUI

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