# Feature: Cloudflare Settings and Connectivity

## User Story 1: Fix Frontend Key Mapping Issues

**Goal:** Fix the existing Cloudflare settings page key mapping between api_token/apiToken to ensure proper data flow between frontend and backend

**Status:** ✅ Done

**Tasks:**

1. Update the Cloudflare settings page component to use correct field names (api_token instead of apiToken)
2. Ensure form validation matches backend expected field names
3. Verify data transformation between camelCase (frontend) and snake_case (backend) conventions
4. Test that settings save and load correctly with proper key mapping

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 2: Create Cloudflare Settings API Endpoints

**Goal:** Implement dedicated RESTful API endpoints for Cloudflare configuration management

**Status:** ✅ Done

**Tasks:**

1. Create `server/src/routes/cloudflare-settings.ts` with CRUD endpoints
2. Implement POST `/api/settings/cloudflare` for create/update with encryption support
3. Implement GET `/api/settings/cloudflare` for retrieving current configuration
4. Implement DELETE `/api/settings/cloudflare` for removing configuration
5. Implement POST `/api/settings/cloudflare/test` for manual connectivity testing
6. Add proper authentication middleware to all endpoints
7. Add request/response validation using Zod schemas

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 3: Implement Cloudflare Connectivity API Endpoints

**Goal:** Add API endpoints for retrieving Cloudflare connectivity status and history

**Status:** ✅ Done

**Tasks:**

1. Create `server/src/routes/cloudflare-connectivity.ts` for connectivity endpoints
2. Implement GET `/api/connectivity/cloudflare` for latest status retrieval
3. Implement GET `/api/connectivity/cloudflare/history` for historical data with pagination
4. Add proper error handling and status code responses
5. Integrate with ConnectivityStatus table for data persistence
6. Add response caching with 5-minute TTL for performance

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 4: Add Cloudflare Tunnel API Endpoints

**Goal:** Implement API endpoints for retrieving Cloudflare tunnel information

**Status:** ✅ Done

**Tasks:**

1. Add tunnel endpoints to cloudflare-settings.ts or create dedicated tunnel routes
2. Implement GET `/api/cloudflare/tunnels` for listing all tunnels
3. Implement GET `/api/cloudflare/tunnels/:id` for specific tunnel details
4. Add tunnel data transformation and filtering logic
5. Implement response caching with 60-second TTL
6. Handle Cloudflare API errors with proper error messages

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 5: Create Frontend Hooks for Cloudflare Settings

**Goal:** Implement React Query hooks for Cloudflare settings management and connectivity testing

**Status:** Not Started

**Tasks:**

1. Create `client/src/hooks/use-cloudflare-settings.ts` with React Query hooks
2. Implement useCloudflareSettings() for retrieving current settings
3. Implement useUpdateCloudflareSettings() for updating configuration
4. Implement useTestCloudflareConnection() for manual connectivity testing
5. Implement useCloudflareConnectivity() for status retrieval
6. Implement useCloudfareTunnels() for tunnel information
7. Add proper error handling and loading states

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 6: Implement Tunnel Status Display Component

**Goal:** Create React component to display Cloudflare tunnel information and status

**Status:** Not Started

**Tasks:**

1. Create `client/src/components/cloudflare/tunnel-status.tsx` component
2. Implement tunnel list display with name, status, and connections
3. Add real-time status indicators (healthy, degraded, offline)
4. Implement expandable details view for each tunnel
5. Add refresh button for manual data updates
6. Integrate component into existing Cloudflare settings page

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 7: Integrate Cloudflare with Background Scheduler

**Goal:** Add Cloudflare service to the existing background connectivity monitoring system

**Status:** Not Started

**Tasks:**

1. Update connectivity scheduler to register Cloudflare as a monitored service
2. Implement periodic health check function for Cloudflare API
3. Add exponential backoff for failed connectivity attempts
4. Configure check interval (default 5 minutes) with environment variable support
5. Ensure proper logging of connectivity events
6. Test scheduler integration with manual trigger support

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 8: Add Comprehensive Error Handling and Circuit Breaker

**Goal:** Implement robust error handling with circuit breaker pattern for Cloudflare API calls

**Status:** Not Started

**Tasks:**

1. Implement circuit breaker logic in CloudflareConfigService
2. Add failure threshold tracking (open circuit after 5 consecutive failures)
3. Implement cooldown period (5 minutes) before retry attempts
4. Add specific error handling for 401, 403, 429, and 5xx errors
5. Implement request deduplication within 1-second window
6. Add comprehensive error logging with proper redaction
7. Test circuit breaker behavior under various failure scenarios

**Acceptance Criteria:**

- Run `npm run justfix` in either project after changes to fix linting and formatting before running any linter or build.
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.