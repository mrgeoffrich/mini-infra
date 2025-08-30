# Feature: Azure Settings and Connectivity Management

## User Story 1: Add Azure Settings API Type Definitions

**Goal:** Define comprehensive TypeScript types for Azure settings API operations including requests, responses, and metadata

**Status:** ✅ Done

**Tasks:**

NOTE: Use the existing SystemSettings and ConnectivityStatus tables do not create new ones

1. Add Azure-specific request types to @mini-infra/types (CreateAzureSettingRequest, UpdateAzureSettingRequest, ValidateAzureConnectionRequest)
2. Add Azure-specific response types (AzureSettingResponse, AzureValidationResponse, AzureContainerListResponse)
3. Add Azure metadata types (AzureAccountInfo, AzureContainerInfo, AzureConnectionMetadata)
4. Update existing settings types to include Azure-specific validation statuses and error codes
5. Export all new types from the main index.ts file

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 2: Create Azure Settings API Endpoints

**Goal:** Implement RESTful API endpoints for Azure settings CRUD operations and validation

**Status:** ✅ Done

**Tasks:**

NOTE: Use the existing SystemSettings and ConnectivityStatus tables do not create new ones

1. Create /api/settings/azure route file with authentication middleware
2. Implement GET endpoint to retrieve current Azure configuration
3. Implement PUT endpoint to update Azure configuration with validation
4. Implement POST /api/settings/azure/validate endpoint for connection testing
5. Implement DELETE endpoint to remove Azure configuration
6. Add request/response validation using Zod schemas
7. Integrate with existing AzureConfigService for all operations
8. Add proper error handling and logging for all endpoints

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 3: Create Azure Connectivity Status API Endpoints

**Goal:** Implement API endpoints for retrieving Azure connectivity status and history

**Status:** ✅ Done

**Tasks:**

NOTE: Use the existing SystemSettings and ConnectivityStatus tables do not create new ones

1. Create GET /api/connectivity/azure endpoint for latest status
2. Implement GET /api/connectivity/azure/history endpoint with pagination
3. Add filtering support by date range and status type
4. Integrate with ConnectivityStatus database model
5. Add response caching with appropriate TTL
6. Implement proper error handling and request validation

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 4: Add Azure Settings API Tests

**Goal:** Create comprehensive test coverage for Azure settings API endpoints

**Status:** ✅ Done

**Tasks:**

NOTE: Use the existing SystemSettings and ConnectivityStatus tables do not create new ones

1. Create azure-settings.test.ts file in server/src/routes/__tests__
2. Write tests for authentication requirements on all endpoints
3. Add tests for successful CRUD operations
4. Test validation endpoint with mock Azure responses
5. Add tests for error scenarios (invalid connection string, network failures, timeouts)
6. Test concurrent access and rate limiting behavior
7. Mock AzureConfigService methods for isolated testing

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 5: Create Azure Settings React Hooks

**Goal:** Implement React Query hooks for Azure settings management in the frontend

**Status:** ✅ Done

**Tasks:**

1. Create use-azure-settings.ts file in client/src/hooks
2. Implement useAzureSettings hook for fetching current configuration
3. Create useUpdateAzureSettings mutation hook
4. Add useValidateAzureConnection mutation hook for testing connections
5. Implement useAzureConnectivityStatus hook with polling support
6. Add useAzureContainers hook for fetching container metadata
7. Include proper error handling and loading states in all hooks

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 6: Enhance Azure Settings Form Validation

**Goal:** Add real-time validation and connection testing to the Azure settings form

**Status:** ✅ Done

**Tasks:**

1. Add Zod schema for Azure connection string validation
2. Implement real-time validation feedback as user types
3. Add connection test button with loading state
4. Display validation results with appropriate success/error messages
5. Show connection metadata (account name, SKU) on successful validation
6. Add visual indicators for connection status (green/red/yellow badges)
7. Implement auto-save functionality with debouncing

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 7: Create Azure Container Metadata Display Component

**Goal:** Build a component to display Azure Storage container information

**Status:** ✅ Done

**Tasks:**

1. Create AzureContainerList component with table display
2. Add columns for container name, last modified, lease status
3. Implement pagination for large container lists
4. Add search/filter functionality for container names
5. Display container count and storage account information
6. Add loading skeletons while fetching data
7. Handle empty state when no containers exist

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 8: Add Azure Connectivity Status Display

**Goal:** Create a component to show real-time Azure connectivity status and history

**Status:** ✅ Done

**Tasks:**

1. Create ConnectivityStatusCard component for current status
2. Add response time display with visual chart
3. Implement status history timeline view
4. Add color-coded status indicators (connected/failed/timeout)
5. Display last successful connection timestamp
6. Show error messages and codes when connection fails
7. Add auto-refresh with configurable interval

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 9: Integrate Azure Monitoring with Background Scheduler

**Goal:** Ensure Azure connectivity monitoring is properly integrated with the background scheduler

**Status:** Not Started

**Tasks:**

1. Verify AzureConfigService is registered in configuration factory
2. Add Azure service to connectivity scheduler monitoring list
3. Configure monitoring interval and timeout settings
4. Test circuit breaker functionality for Azure service
5. Verify exponential backoff works correctly
6. Ensure connectivity status is properly recorded in database
7. Add logging for all monitoring events

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.

## User Story 10: Add Azure Container Access Testing

**Goal:** Implement functionality to test access to specific Azure Storage containers

**Status:** Not Started

**Tasks:**

1. Add API endpoint POST /api/settings/azure/test-container
2. Implement container access verification in AzureConfigService
3. Create UI component for container access testing
4. Add dropdown to select container from list
5. Display test results with detailed error messages
6. Add retry logic for transient failures
7. Cache test results with appropriate TTL

**Acceptance Criteria:**

- Run prettier over all new files to format them if they are ts or tsx files
- Run linter to ensure no errors
- Run build to ensure no errors
- Update CLAUDE.md with new details if theres information that relates to this in the file already - ignore database changes
- Mark the story as done in the markdown file for it.