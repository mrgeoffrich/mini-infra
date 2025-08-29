# Feature: Container Dashboard

## User Story 1: Database Schema Updates for Container Dashboard

**Goal:** Add database models to support user preferences and optional container data caching for the Container Dashboard feature

**Status:** ✅ Completed

**Tasks:**

1. Update Prisma schema to add UserPreference model with container-specific fields (sort, filters, columns)
2. Add ContainerCache model for optional database caching with expiration support
3. Add proper relations between UserPreference and existing User model
4. Run `npx prisma db push` to apply schema changes
5. Regenerate Prisma client with `npx prisma generate`

**Acceptance Criteria:**

- Run prettier over all new files to format them
- Run build to ensure no errors
- Run linter to ensure no errors
- Update CLAUDE.md with new details
- Mark the story as done in the markdown file for it.

## User Story 2: Backend Docker Service Integration

**Goal:** Create Docker service layer for communicating with Docker Engine API and managing container data

**Status:** ✅ Completed

**Tasks:**

1. Install required dependencies: dockerode, @types/dockerode, node-cache
2. Create Docker integration service class with singleton pattern in `server/src/services/docker.ts`
3. Implement connection management with automatic reconnection logic
4. Add methods for listing containers and getting container details
5. Implement error handling for Docker API connectivity issues
6. Add Docker event subscription for cache invalidation
7. Create container data transformation utilities
8. Add environment variable configuration for Docker host connection

**Acceptance Criteria:**

- Run prettier over all new files to format them
- Run build to ensure no errors
- Run linter to ensure no errors
- Update CLAUDE.md with new details
- Mark the story as done in the markdown file for it.

## User Story 3: Backend Container API Endpoints and Type Definitions

**Goal:** Create REST API endpoints for container data with proper TypeScript definitions and caching implementation

**Status:** ✅ Completed

**Tasks:**

1. Define ContainerInfo interface with all required fields (id, name, status, image, ports, volumes, etc.)
2. Define ContainerListResponse interface for API responses
3. Create GET /api/containers endpoint with authentication middleware
4. Implement in-memory caching with 3-second TTL using node-cache
5. Add rate limiting (60 requests per minute per user) for container endpoints
6. Implement data sanitization to remove sensitive environment variables
7. Add proper error handling and timeout configuration (5 seconds) for Docker API calls
8. Add request correlation logging for container operations
9. Implement pagination support (50 containers per page)

**Acceptance Criteria:**

- Run prettier over all new files to format them
- Run build to ensure no errors
- Run linter to ensure no errors
- Update CLAUDE.md with new details
- Mark the story as done in the markdown file for it.

## User Story 4: Backend Tests for Container API

**Goal:** Ensure container API endpoints work correctly with comprehensive unit and integration tests

**Status:** Not Started

**Tasks:**

1. Create unit tests for Docker service connection handling in `server/src/services/__tests__/docker.test.ts`
2. Test data transformation logic and cache operations
3. Create integration tests for API endpoints in `server/src/api/__tests__/containers.test.ts`
4. Test API endpoint authentication and authorization
5. Validate response format compliance with TypeScript interfaces
6. Test rate limiting behavior and error scenarios
7. Mock Docker API responses for reliable testing
8. Test error handling scenarios (Docker daemon unavailable, API timeouts)

**Acceptance Criteria:**

- Run prettier over all new files to format them
- Run build to ensure no errors
- Run linter to ensure no errors
- Update CLAUDE.md with new details
- Mark the story as done in the markdown file for it.

## User Story 5: Frontend Container Data Fetching Hook

**Goal:** Create React Query hook for fetching container data with real-time polling and proper error handling

**Status:** Not Started

**Tasks:**

1. Install frontend dependencies: @tanstack/react-table, date-fns
2. Create useContainers custom hook in `client/src/hooks/useContainers.ts`
3. Implement React Query integration with 5-second polling interval
4. Add proper TypeScript types matching backend ContainerInfo interface
5. Implement loading, error, and success states
6. Add automatic retry logic and error boundary integration
7. Create useContainerFilters hook for managing filter state
8. Add request correlation ID support for debugging

**Acceptance Criteria:**

- Run prettier over all new files to format them
- Run build to ensure no errors
- Run linter to ensure no errors
- Update CLAUDE.md with new details
- Mark the story as done in the markdown file for it.

## User Story 6: Frontend Container Dashboard Components

**Goal:** Build comprehensive UI components for displaying and interacting with container information

**Status:** Not Started

**Tasks:**

1. Create ContainerDashboard main component in `client/src/app/containers/ContainerDashboard.tsx`
2. Build ContainerTable component with @tanstack/react-table integration
3. Implement sorting and filtering capabilities with debounced input (300ms delay)
4. Create ContainerStatusBadge component for visual status indicators
5. Build ContainerFilters component with status and name filtering
6. Add proper loading states and error handling with user-friendly messages
7. Implement responsive design with proper mobile support
8. Add new "Containers" navigation item to main navigation
9. Create protected route for /containers path
10. Add container list viewed business event logging
11. Implement virtual scrolling for performance with large container lists (>100)

**Acceptance Criteria:**

- Run prettier over all new files to format them
- Run build to ensure no errors
- Run linter to ensure no errors
- Update CLAUDE.md with new details
- Mark the story as done in the markdown file for it.