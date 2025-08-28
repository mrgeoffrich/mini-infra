# Medication Tracker App - Technical Specification

## Technology Stack

### Frontend

- **Framework**: Vite
- **UI Library**: React 19+
- **Styling**: shadcn 3 and Tailwind CSS 4
- **Components**: React Components used to compose pages
- **Icons**: Heroicons
- **Forms**: React Hook Form with Zod validation

### Backend

- **API**: Expressjs
- **Database**: Sqlite
- **ORM**: Prisma
- **Authentication**: Passport with Google OAuth
- **Validation**: Zod for runtime type checking
- **Logging**: Pino (high-performance structured logging with request correlation)
- **Security**: Cloudflare Turnstile integration for bot protection
- **Email Service**: SMTP2GO for transactional emails
- **State Management**: React Query (TanStack Query)

### Development Tools

- **Language**: TypeScript
- **Package Manager**: npm
- **Linting**: ESLint
- **Testing**: Jest + React Testing Library (optional initially)
- **Logging**: Pino + Pino-Pretty (development pretty-printing)

### Core Testing Framework

- **Jest**: JavaScript testing framework

### Additional Testing Tools

- **@testing-library/user-event**: Realistic user interaction simulation
- **jest-environment-jsdom**: DOM testing environment
- **@types/jest**: TypeScript support for Jest
- **prisma-test-environment**: Database testing utilities

## Database Schema (Prisma)

Look in @prisma/schema.prisma for the latest schema.

## Logging System

### Overview

The application implements a comprehensive logging strategy using **Pino**, a high-performance structured logging library specifically optimized for Node.js applications. The logging system provides request correlation, performance tracking, business event logging, and security-focused data redaction.

### Key Features

- **High Performance**: 5x faster than Winston with minimal overhead
- **Structured JSON Logging**: Machine-readable logs for production environments
- **Request Correlation**: Unique request IDs for tracing API calls across the system
- **Security-First**: Automatic redaction of sensitive data (passwords, tokens, cookies)
- **Environment Awareness**: Pretty-printed logs in development, JSON in production
- **Business Events**: Structured logging for key actions (pill_logged, medication_created)

### Core Components

#### 1. Logger Configuration (`server/src/lib/logger.ts`)

```typescript
// Environment-aware logger setup
const logger = process.env.NODE_ENV === 'development' 
  ? pino({
      transport: { 
        target: 'pino-pretty',
        options: { colorize: true }
      },
      level: 'debug'
    })
  : pino({ 
      level: 'info',
      redact: ['password', 'token', 'authorization']
    });
```

**Features:**
- **Development**: Pretty-printed, colorized output with debug level
- **Production**: Structured JSON output with info level
- **Test Environment**: Silent logging to avoid noise
- **Automatic Redaction**: Removes sensitive data from logs
- **Configurable Levels**: Environment variable overrides

#### 2. API Logger Utilities (`server/src/lib/api-logger.ts`)

**Capabilities:**
- **Request Context**: Automatic extraction of user ID, IP, user agent
- **Performance Tracking**: Automatic API response time measurement
- **Business Events**: Structured logging for key application events
- **Error Context**: Rich error information with stack traces and context
- **Authentication Logging**: Detailed auth failure tracking

#### 3. Request Correlation (`server/src/lib/request-id.ts` + `middleware.ts`)

**Benefits:**
- **Request Tracing**: Follow requests across your entire API
- **Debugging**: Correlate frontend errors with backend logs
- **Performance Monitoring**: Track request flow through middleware
- **Client Integration**: Request IDs available in response headers

### Security & Privacy

#### Automatic Data Redaction
```typescript
const REDACT_FIELDS = [
  'password', 'token', 'accessToken', 'refreshToken',
  'authorization', 'cookie', 'sessionToken',
  '*.password', '*.token', 'req.headers.authorization',
  'req.headers.cookie'
];
```

**Protected Data:**
- Authentication tokens and session data
- User passwords and credentials  
- Authorization headers and cookies
- Sensitive request/response data
- Custom redaction patterns supported

#### Privacy Compliance
- **No PII in Logs**: Personal information automatically filtered
- **Configurable Redaction**: Custom patterns for sensitive data
- **Audit Trail**: Business events without exposing private data
- **GDPR Ready**: Structured for compliance requirements

### Configuration

#### Environment Variables
```bash
# Logging configuration
LOG_LEVEL=debug          # trace, debug, info, warn, error, fatal, silent
NODE_ENV=development     # Affects default log level and format

# Development: debug level with pretty-print
# Production: info level with JSON output  
# Test: silent level (no output)
```


### Benefits for Production

1. **Debugging**: Request correlation allows tracing issues across the stack
2. **Monitoring**: Structured data integrates with log aggregation tools (ELK, Splunk)
3. **Performance**: Automatic API response time tracking
4. **Security**: Audit trail for authentication and authorization events
5. **Business Intelligence**: Structured events for analytics and reporting
6. **Compliance**: Proper data handling and privacy protection

## Environment Variables

```bash
# Authentication
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
```

## State Management

### React Query Setup

Look in `@client/src/lib/providers.tsx`

### Custom Hooks

Custom hook in `@client/src/hooks/`

## Testing

### Jest Configuration (`__tests__/setup/jest.config.backend.js`)

- **Test Environment**: Node.js
- **Global Setup**: `__tests__/setup/global.setup.ts`
- **Setup Files**: `__tests__/setup/env.setup.ts` (environment variables)
- **Setup After Env**: `__tests__/setup/jest.setup.ts` (mocks and global test client)
- **Test Pattern**: Currently focused on `**/__tests__/api/**/*.test.ts`

### Test Database Setup

#### Global Setup (`global.setup.ts`)

- Sets test environment variables:
  - `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Runs `npx prisma db push --force-reset` before tests to ensure clean database schema

#### Jest Setup (`jest.setup.ts`)

- Mocks NextAuth authentication system
- Mocks Prisma adapter for NextAuth
- Creates global Prisma client for tests

### Unique Test Data Generation

The tests avoid concurrency conflicts by generating **unique identifiers** for each test run.

Test Data:

1. **CUID2 Generation**: Uses `@paralleldrive/cuid2` to generate unique IDs
2. **Per-Test Isolation**: Each test creates its own unique user and medication data
3. **Email Uniqueness**: Test emails are generated as `{userId}@example.com`
4. **Valid Dates**: When creating dates for test data use the current date plus or minus few days to ensure the dates are in the future or past by at least a few days. For historical data ensure dates are in the past.
5. **Mock out current user**: To handle auth in tests use the jest mock for the getServerSession to return the test user id.

### Database Isolation Methods

1. **Unique User Creation**: Each test creates its own user with unique CUID2 ID
2. **User-Scoped Data**: All medications and pill logs are scoped to the specific test user
3. **No Global Test Data**: Avoids shared fixtures that could cause race conditions
4. **Clean Test Database**: Global setup ensures fresh database schema

## Test Data Patterns

### Core Test Data Structure

Each test typically creates:

- **Unique User**: With CUID2 ID and corresponding email
- **Test Medications**: Associated with the specific test user
- **Pill Logs**: Linked to test medications and users
- **Authentication Mock**: Set to return the specific test user ID

### Key Test Concurrency Prevention Features

1. **No Shared Test Data**: Each test creates its own complete dataset
2. **Unique Identifiers**: CUID2 ensures globally unique IDs even across parallel tests
3. **User-Scoped Operations**: All database operations are filtered by user ID
4. **Isolated Authentication**: Each test mocks its own user session
5. **Fresh Database**: Global setup ensures clean state

