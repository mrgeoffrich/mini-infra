# Feature: Settings and Configuration Management

## User Story 1: Create SystemSettings Database Model

**Goal:** Create the database schema for storing system settings including Docker, Cloudflare, and Azure configurations with encryption support and validation status tracking.

**Status:** ✅ Completed

**Tasks:**

1. Add SystemSettings model to `server/prisma/schema.prisma` with fields for category, key, value, encryption status, validation status, and audit fields
2. Create unique constraint on category/key combination
3. Add proper indexing for efficient queries
4. Run `npx prisma db push` to apply schema changes
5. Update `@mini-infra/types` package with SystemSettings TypeScript interface
6. Build the types package to generate updated type definitions

**Acceptance Criteria:**

- Run prettier over all new files to format them
- Run build to ensure no errors
- Run linter to ensure no errors
- Update CLAUDE.md with new details
- Mark the story as done in the markdown file for it.

## User Story 2: Create SettingsAudit Database Model

**Goal:** Create the database schema for tracking all configuration changes with complete audit trail including user context and change details.

**Status:** ✅ Completed

**Tasks:**

1. Add SettingsAudit model to `server/prisma/schema.prisma` with fields for tracking configuration changes
2. Include user ID, IP address, user agent, action type, and success/failure status
3. Add proper indexing for efficient audit log queries
4. Run `npx prisma db push` to apply schema changes
5. Update `@mini-infra/types` package with SettingsAudit TypeScript interface
6. Build the types package to generate updated type definitions

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 3: Create ConnectivityStatus Database Model

**Goal:** Create the database schema for tracking external service connectivity status and health monitoring results.

**Status:** ✅ Completed

**Tasks:**

1. Add ConnectivityStatus model to `server/prisma/schema.prisma` with service status tracking
2. Include response time, error messages, error codes, and service-specific metadata fields
3. Add proper indexing for service lookups and time-based queries
4. Run `npx prisma db push` to apply schema changes
5. Update `@mini-infra/types` package with ConnectivityStatus TypeScript interface
6. Build the types package to generate updated type definitions

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 4: Create Settings Service Layer Architecture

**Goal:** Implement the abstract configuration service architecture with base classes, validation interfaces, and encryption utilities.

**Status:** ✅ Completed

**Tasks:**

1. Create abstract `ConfigurationService` base class in `server/src/services/configuration-base.ts`
2. Define validation result and health status interfaces
3. Implement encryption/decryption utilities for sensitive data
4. Create service factory for instantiating specific configuration services
5. Add TypeScript type definitions for service interfaces to `@mini-infra/types`
6. Build the types package to generate updated type definitions

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 5: Implement Docker Configuration Service

**Goal:** Create the Docker configuration service that validates Docker host connectivity and manages Docker-specific settings.

**Status:** ✅ Completed

**Tasks:**

1. Install any additional Docker-related dependencies if needed
2. Create `DockerConfigService` extending the base configuration service in `server/src/services/docker-config.ts`
3. Implement Docker host validation using existing dockerode integration
4. Add methods for testing Docker API connectivity and retrieving version info
5. Implement settings storage and retrieval with encryption for sensitive data
6. Add comprehensive error handling for Docker connectivity issues

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 6: Implement Cloudflare Configuration Service

**Goal:** Create the Cloudflare configuration service that validates API keys and manages Cloudflare tunnel settings.

**Status:** ✅ Completed

**Tasks:**

1. Install Cloudflare npm library: `npm install cloudflare @types/cloudflare`
2. Create `CloudflareConfigService` extending the base configuration service in `server/src/services/cloudflare-config.ts`
3. Implement Cloudflare API key validation by making test API calls
4. Add methods for testing tunnel access and retrieving account information
5. Implement settings storage and retrieval with encryption for API keys
6. Add comprehensive error handling for Cloudflare API errors and rate limits

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 7: Implement Azure Configuration Service

**Goal:** Create the Azure configuration service that validates storage account credentials and manages backup settings.

**Status:** ✅ Completed

**Tasks:**

1. Install Azure Storage SDK: `npm install @azure/storage-blob`
2. Create `AzureConfigService` extending the base configuration service in `server/src/services/azure-config.ts`
3. Implement Azure Storage connection string validation
4. Add methods for testing blob container access and listing containers
5. Implement settings storage and retrieval with encryption for connection strings
6. Add comprehensive error handling for Azure API errors and authentication failures

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 8: Create Settings API Endpoints

**Goal:** Implement RESTful API endpoints for CRUD operations on system settings with proper authentication and validation.

**Status:** ✅ Completed

**Tasks:**

1. Create settings router in `server/src/routes/settings.ts`
2. Implement GET, POST, PUT, DELETE endpoints for system settings
3. Add proper authentication middleware using existing auth system
4. Implement request validation using Zod schemas
5. Add rate limiting for settings endpoints
6. Update `@mini-infra/types` with API request/response interfaces

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 9: Create Settings Validation API Endpoints

**Goal:** Implement API endpoints for real-time validation of external service connectivity and configuration correctness.

**Status:** ✅ Completed

**Tasks:**

1. Add validation endpoints to settings router: `/api/settings/validate/:service`
2. Implement real-time connectivity testing for Docker, Cloudflare, and Azure
3. Add proper error handling and timeout protection
4. Implement debounced validation to prevent excessive API calls
5. Store validation results in ConnectivityStatus database
6. Update `@mini-infra/types` with validation API interfaces

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 10: Create Settings Audit API Endpoints

**Goal:** Implement API endpoints for retrieving configuration change history and audit logs with filtering capabilities.

**Status:** ✅ Completed

**Tasks:**

1. Add audit endpoints to settings router: `/api/settings/audit`
2. Implement audit log retrieval with pagination and filtering
3. Add search functionality by user, action type, and date range
4. Integrate with existing Pino logging system for structured audit events
5. Implement proper user context extraction for audit logging
6. Update `@mini-infra/types` with audit API interfaces

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 12: Add Background Connectivity Monitoring

**Goal:** Implement scheduled background jobs to periodically test external service connectivity and update health status.

**Status:** ✅ Completed

**Tasks:**

1. Create background job scheduler in `server/src/lib/connectivity-scheduler.ts`
2. Implement periodic health checks every 5 minutes for configured services
3. Update ConnectivityStatus database with check results
4. Add circuit breaker pattern to prevent cascading failures
5. Implement exponential backoff for failed connections
6. Add proper error logging and monitoring

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 13: Write Tests for Settings Services

**Goal:** Create comprehensive unit tests for all settings service classes including validation logic and error handling.

**Status:** ✅ Completed

**Tasks:**

1. Create test files for each configuration service in `server/src/services/__tests__/`
2. Write unit tests for Docker, Cloudflare, and Azure configuration services
3. Mock external API calls and test validation logic
4. Test encryption/decryption functionality with various scenarios
5. Test error handling and timeout scenarios
6. Ensure test coverage meets project standards

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 14: Write Tests for Settings API Endpoints

**Goal:** Create integration tests for all settings API endpoints including authentication, validation, and audit logging.

**Status:** ✅ Completed

**Tasks:**

1. Create test files for settings APIs in `server/src/routes/__tests__/settings.test.ts`
2. Write integration tests for CRUD operations on system settings
3. Test validation endpoints with various service configurations
4. Test audit endpoint functionality and filtering
5. Mock external service calls and test error scenarios
6. Test authentication and authorization for settings endpoints

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 15: Create Settings Data Fetching Hooks

**Goal:** Implement React Query hooks for fetching, caching, and mutating settings data with proper error handling.

**Status:** ✅ Completed

**Tasks:**

1. Create settings hooks in `client/src/hooks/use-settings.ts`
2. Implement `useSystemSettings` hook for fetching configuration data
3. Add `useSettingsValidation` hook for real-time validation status
4. Create `useSettingsAudit` hook for audit log retrieval
5. Implement proper React Query caching and invalidation strategies
6. Add comprehensive error handling and loading states

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 16: Create Settings Validation Hooks

**Goal:** Implement React hooks for real-time validation feedback and connectivity status monitoring.

**Status:** ✅ Completed

**Tasks:**

1. Create validation hooks in `client/src/hooks/use-settings-validation.ts`
2. Implement `useConnectivityStatus` hook for service health monitoring
3. Add `useSettingsValidator` hook with debounced validation
4. Create real-time polling for connectivity status updates
5. Implement optimistic updates for validation results
6. Add proper error recovery and retry logic

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 17: Create Settings Navigation and Routing

**Goal:** Add settings pages to the application routing and integrate with the existing sidebar navigation.

**Status:** ✅ Completed

**Tasks:**

1. Update app routing in `client/src/lib/routes.tsx` to include settings pages
2. Add settings navigation items to the sidebar in `client/src/components/app-sidebar.tsx`
3. Create protected routes for all settings pages
4. Add proper navigation hierarchy for settings subsections
5. Implement breadcrumb navigation for settings pages
6. Add settings icons and proper visual hierarchy

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 18: Create Settings Overview Dashboard

**Goal:** Implement the main settings page that provides an overview of all system configurations and their status.

**Status:** ✅ Completed

**Tasks:**

1. Create settings overview page in `client/src/app/settings/page.tsx`
2. Display summary cards for Docker, Cloudflare, and Azure configurations
3. Show connectivity status indicators for each service
4. Add quick access buttons to individual configuration pages
5. Display recent configuration changes and audit highlights
6. Implement refresh functionality for real-time status updates

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 19: Implement Docker Settings Configuration Form

**Goal:** Create the Docker configuration form with validation, connectivity testing, and encrypted storage.

**Status:** ✅ Completed

**Tasks:**

1. Create Docker settings page in `client/src/app/settings/docker/page.tsx`
2. Implement form using React Hook Form with Zod validation schema
3. Add fields for Docker host URL, API version, and authentication if needed
4. Implement real-time connectivity testing with visual feedback
5. Add save functionality with optimistic updates
6. Display current connectivity status and last successful connection

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 20: Implement Cloudflare Settings Configuration Form

**Goal:** Create the Cloudflare configuration form with API key validation and tunnel management settings.

**Status:** ✅ Completed

**Tasks:**

1. Create Cloudflare settings page in `client/src/app/settings/cloudflare/page.tsx`
2. Implement secure form for Cloudflare API token input
3. Add real-time API key validation with account information display
4. Show connected tunnels and their status when API key is valid
5. Implement save functionality with encrypted storage
6. Add proper error handling for API failures and rate limits

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 21: Implement Azure Settings Configuration Form

**Goal:** Create the Azure Storage configuration form with connection string validation and backup settings.

**Status:** ✅ Completed

**Tasks:**

1. Create Azure settings page in `client/src/app/settings/azure/page.tsx`
2. Implement secure form for Azure Storage connection string input
3. Add real-time connection validation with storage account details
4. Display available containers and connection status
5. Implement save functionality with encrypted storage
6. Add comprehensive error handling for Azure API errors

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 22: Implement Connectivity Status Indicators

**Goal:** Create reusable UI components for displaying real-time connectivity status across all settings pages.

**Status:** ✅ Completed

**Tasks:**

1. Create connectivity status components in `client/src/components/connectivity-status.tsx`
2. Design status indicators with color-coded badges and icons
3. Add real-time status updates with polling functionality
4. Display response times, error messages, and last successful connection
5. Implement proper loading states during connectivity tests
6. Add click-to-refresh functionality for manual status checks

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 23: Create Settings Audit/History Viewer

**Goal:** Implement a comprehensive audit log viewer for tracking all configuration changes with filtering and search capabilities.

**Status:** ✅ Completed

**Tasks:**

1. Create audit viewer page in `client/src/app/settings/audit/page.tsx`
2. Implement data table with filtering by user, action type, service, and date range
3. Add search functionality for audit log entries
4. Display detailed change information with before/after values (excluding sensitive data)
5. Implement pagination for large audit logs
6. Add export functionality for audit reports

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 24: Make sure the main docker connectivity functionality now uses the new settings

**Goal:** Change the functionality to not use an environment variable but the settings in the database.

**Status:** Not Started

**Tasks:**

1. Change the main docker singleton to use the new settings
2. Fail gracefully if it cant connect and just record that in the database.
   
**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.