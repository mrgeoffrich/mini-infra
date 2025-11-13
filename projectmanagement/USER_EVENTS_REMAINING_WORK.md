# User Events Feature - Remaining Work

## Status: Backend Core Complete ✅

The User Events feature backend infrastructure is fully implemented and functional. This document outlines the remaining work to complete the feature.

---

## Phase 4: Integration Examples (Instrumentation)

### Overview
Add User Events logging to existing long-running operations to demonstrate the instrumentation pattern. This will serve as a reference for future integrations.

### Tasks

#### 4.1 Integrate with Deployment Orchestrator
**File**: `server/src/services/deployment-orchestrator.ts`

**What to do**:
1. Import `UserEventService` and create an instance
2. At the start of `executeDeployment()`, create a UserEvent:
   ```typescript
   const userEvent = await userEventService.createEvent({
     eventType: 'deployment',
     eventCategory: 'infrastructure',
     eventName: `Deploy ${config.applicationName}`,
     userId: deployment.triggeredBy || undefined,
     triggeredBy: deployment.triggerType,
     resourceId: deployment.id,
     resourceType: 'deployment',
     resourceName: config.applicationName,
     description: `Deploying ${dockerImage}`,
     metadata: {
       applicationName: config.applicationName,
       dockerImage,
       environmentName: 'unknown', // Can be populated if available
       deploymentId: deployment.id,
       configurationId: deployment.configurationId,
     },
   });
   ```

3. Update progress at key milestones:
   - After pulling image: `progress: 20`
   - After creating container: `progress: 40`
   - After health checks pass: `progress: 80`
   - After traffic switch: `progress: 100`

4. Append logs at key steps:
   ```typescript
   await userEventService.appendLogs(
     userEvent.id,
     `[${new Date().toISOString()}] Step completed: ${stepName}`
   );
   ```

5. On completion (success or failure):
   ```typescript
   await userEventService.updateEvent(userEvent.id, {
     status: isSuccess ? 'completed' : 'failed',
     progress: 100,
     resultSummary: isSuccess
       ? `Successfully deployed ${config.applicationName}`
       : `Failed to deploy: ${errorMessage}`,
     errorMessage: isSuccess ? undefined : errorMessage,
     errorDetails: isSuccess ? undefined : errorDetails,
   });
   ```

**Locations to instrument**:
- `server/src/services/deployment-orchestrator.ts:642-699` (deployment creation)
- State machine actions in `server/src/services/haproxy/actions/`

---

#### 4.2 Integrate with Container Lifecycle Manager
**File**: `server/src/services/container-lifecycle-manager.ts`

**What to do**:
1. In `cleanupOrphanedContainers()` method (line 746), create a UserEvent:
   ```typescript
   const userEvent = await userEventService.createEvent({
     eventType: 'container_cleanup',
     eventCategory: 'maintenance',
     eventName: 'Cleanup Orphaned Containers',
     userId: undefined, // System-triggered
     triggeredBy: 'system',
     description: `Cleaning up containers older than ${ageThresholdHours} hours`,
     metadata: {
       dryRun,
       ageThresholdHours,
     },
   });
   ```

2. Update with results:
   ```typescript
   await userEventService.updateEvent(userEvent.id, {
     status: 'completed',
     resultSummary: `Removed ${results.removed.length} containers, ${results.failed.length} failures`,
     metadata: {
       containersIdentified: results.identified.length,
       containersRemoved: results.removed.length,
       containersFailed: results.failed.length,
       dryRun,
     },
     logs: JSON.stringify(results, null, 2),
   });
   ```

**Alternative**: Create events for individual container operations if granularity is desired.

---

#### 4.3 Integrate with Environment Operations
**Files**:
- `server/src/services/application-service-factory.ts`
- Environment-related services

**What to do**:
1. Add events for:
   - `environment_start` - When starting an environment
   - `environment_stop` - When stopping an environment
   - `environment_create` - When creating a new environment
   - `environment_delete` - When deleting an environment

2. Pattern:
   ```typescript
   const userEvent = await userEventService.createEvent({
     eventType: 'environment_start',
     eventCategory: 'infrastructure',
     eventName: `Start Environment: ${environmentName}`,
     userId: userId,
     triggeredBy: 'manual',
     resourceId: environmentId,
     resourceType: 'environment',
     resourceName: environmentName,
     metadata: {
       environmentName,
       environmentType: env.type,
       networkType: env.networkType,
       services: env.services.map(s => s.serviceName),
     },
   });
   ```

---

#### 4.4 Integrate with Certificate Operations
**File**: `server/src/services/tls/certificate-lifecycle-manager.ts`

**What to do**:
1. Add events for:
   - `certificate_create` - When creating a new certificate
   - `certificate_renew` - When renewing a certificate
   - `certificate_revoke` - When revoking a certificate

2. Example for certificate creation:
   ```typescript
   const userEvent = await userEventService.createEvent({
     eventType: 'certificate_create',
     eventCategory: 'security',
     eventName: `Create TLS Certificate for ${primaryDomain}`,
     userId: userId,
     triggeredBy: 'manual',
     resourceId: certificateId,
     resourceType: 'certificate',
     resourceName: primaryDomain,
     metadata: {
       domains: domains,
       primaryDomain: primaryDomain,
       certificateType: 'ACME',
       acmeProvider: provider,
     },
   });
   ```

3. Append logs during ACME challenge process
4. Update with certificate details on success

---

#### 4.5 Create Instrumentation Documentation
**File**: `server/docs/USER_EVENTS_INSTRUMENTATION.md`

**What to include**:
- When to create User Events (long-running operations > 5 seconds)
- How to choose event types and categories
- Best practices for progress tracking
- Log formatting guidelines
- Metadata structure recommendations
- Error handling patterns
- Code examples for common scenarios

---

## Phase 5: Frontend (Basic UI)

### 5.1 Events List Page
**Path**: `client/src/app/events/page.tsx`

**Features**:
- Table with columns:
  - Event Name
  - Type (with badge/color coding)
  - Status (with icon)
  - Started At (formatted with user timezone)
  - Duration
  - Triggered By
  - Actions (View Details button)

- Filters (sidebar or top bar):
  - Event Type (multi-select dropdown)
  - Event Category (multi-select dropdown)
  - Status (multi-select dropdown)
  - Date Range (start date, end date)
  - Search (by event name, description, resource name)

- Pagination:
  - Show 50 results per page
  - Page navigation controls
  - Total count display

- Sorting:
  - Click column headers to sort
  - Default: newest first (startedAt DESC)

**API Integration**:
```typescript
// Use React Query
const { data, isLoading } = useQuery({
  queryKey: ['events', filters, page],
  queryFn: () => fetch('/api/events?' + new URLSearchParams({
    ...filters,
    limit: '50',
    offset: (page * 50).toString(),
  })).then(r => r.json()),
});
```

**Components to create**:
- `EventsListPage.tsx` - Main page component
- `EventsTable.tsx` - Table component
- `EventsFilters.tsx` - Filter sidebar
- `EventStatusBadge.tsx` - Status badge component
- `EventTypeBadge.tsx` - Type badge component

---

### 5.2 Event Detail Page
**Path**: `client/src/app/events/[id]/page.tsx`

**Features**:

1. **Event Metadata Card**:
   - Event Name (large heading)
   - Status (with icon and color)
   - Type and Category badges
   - Progress bar (if in progress)
   - Timestamps (Started, Completed, Duration)
   - Triggered by (user or system)
   - Resource info (type, name, link if applicable)

2. **Metadata Viewer**:
   - JSON viewer (formatted and collapsible)
   - Use a library like `react-json-view` or create custom component
   - Read-only display

3. **Logs Viewer**:
   - Monospace font
   - Scrollable container (max height with scroll)
   - Search within logs (highlight matches)
   - Line numbers (optional)
   - Copy to clipboard button
   - Download logs button

4. **Error Details** (if failed):
   - Error message prominently displayed
   - Error details (expandable JSON)
   - Suggested actions (if applicable)

5. **Actions**:
   - Back to list button
   - Delete event button (with confirmation)
   - Refresh button (for in-progress events)

**API Integration**:
```typescript
const { data: event, isLoading } = useQuery({
  queryKey: ['event', eventId],
  queryFn: () => fetch(`/api/events/${eventId}`).then(r => r.json()),
  refetchInterval: event?.status === 'running' ? 5000 : false, // Auto-refresh if running
});
```

**Components to create**:
- `EventDetailPage.tsx` - Main page component
- `EventMetadataCard.tsx` - Metadata display
- `EventLogsViewer.tsx` - Logs display with search
- `EventProgressBar.tsx` - Progress indicator
- `EventErrorCard.tsx` - Error details display

---

### 5.3 Add Retention Settings to System Settings UI
**File**: `client/src/app/settings/system/page.tsx`

**What to add**:
1. New section: "User Events Configuration"
2. Fields:
   - **Retention Days**: Number input (1-365)
     - Label: "Event Retention Period (days)"
     - Help text: "User events older than this will be automatically deleted"
     - Default: 30
   - **Cleanup Schedule**: Text input (cron expression)
     - Label: "Cleanup Schedule"
     - Help text: "Cron expression for automated cleanup (e.g., '0 2 * * *' for 2 AM daily)"
     - Validation: Check if valid cron expression
     - Optional: Add cron expression builder/picker

3. Validation:
   - Retention days: 1-365 range
   - Cron expression: valid format

4. Save button with confirmation
5. Show current disk usage estimate (optional)

**Settings keys**:
- `system.user_events_retention_days`
- `system.user_events_cleanup_schedule` (optional, defaults to '0 2 * * *')

---

### 5.4 Add Events Navigation Link
**File**: `client/src/components/layout/Sidebar.tsx` (or wherever main navigation is)

**What to add**:
1. Add new navigation item:
   - Label: "Events"
   - Icon: History icon or Activity icon (from @tabler/icons-react or lucide-react)
   - Link: `/events`
   - Position: After "Containers" or in a "Monitoring" section

2. Optional: Add badge showing count of failed events in last 24 hours

Example:
```typescript
{
  name: 'Events',
  href: '/events',
  icon: IconHistory, // or IconActivity
  badge: failedEventsCount > 0 ? failedEventsCount : undefined,
}
```

---

## Phase 6: Testing

### 6.1 Unit Tests for UserEventService
**File**: `server/src/__tests__/user-event-service.test.ts`

**Test cases**:
1. **createEvent()**:
   - Creates event with required fields
   - Sets default status to 'pending'
   - Sets default progress to 0
   - Stores metadata as JSON
   - Associates with user if userId provided
   - Handles missing optional fields

2. **updateEvent()**:
   - Updates status and progress
   - Auto-calculates duration on completion
   - Stores error details on failure
   - Appends logs correctly

3. **appendLogs()**:
   - Appends logs to existing content with newline
   - Handles first log append (no existing logs)

4. **listEvents()**:
   - Filters by event type (single and multiple)
   - Filters by event category
   - Filters by status
   - Filters by date range
   - Searches in name/description/resource name
   - Sorts by specified field
   - Paginates correctly
   - Returns correct total count

5. **deleteEvent()**:
   - Deletes event by ID
   - Throws error if not found

6. **cleanupExpiredEvents()**:
   - Deletes events older than retention period
   - Deletes events past expiresAt date
   - Returns correct count of deleted events
   - Doesn't delete recent events

7. **getStatistics()**:
   - Returns correct total count
   - Groups by status correctly
   - Groups by type correctly
   - Groups by category correctly
   - Calculates recent failures (last 24 hours)
   - Calculates average duration

**Mock Prisma**:
```typescript
jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    userEvent: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      groupBy: jest.fn(),
    },
  },
}));
```

---

### 6.2 API Integration Tests
**File**: `server/src/__tests__/events-api.test.ts`

**Test cases**:

1. **GET /api/events**:
   - Returns list of events with pagination
   - Filters by query parameters
   - Requires authentication
   - Returns 401 without auth

2. **GET /api/events/statistics**:
   - Returns statistics object
   - Requires authentication

3. **GET /api/events/:id**:
   - Returns single event
   - Returns 404 for non-existent event
   - Requires authentication

4. **POST /api/events**:
   - Creates new event with valid data
   - Returns 400 for invalid data
   - Uses authenticated user ID if not provided
   - Requires authentication

5. **PATCH /api/events/:id**:
   - Updates event fields
   - Returns 404 for non-existent event
   - Validates status enum
   - Requires authentication

6. **POST /api/events/:id/logs**:
   - Appends logs to event
   - Returns 400 without logs field
   - Returns 404 for non-existent event
   - Requires authentication

7. **DELETE /api/events/:id**:
   - Deletes event
   - Returns 404 for non-existent event
   - Requires authentication

**Use Supertest**:
```typescript
import request from 'supertest';
import app from '../app';

describe('Events API', () => {
  it('should list events', async () => {
    const response = await request(app)
      .get('/api/events')
      .set('x-api-key', 'test-api-key')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.data)).toBe(true);
  });
});
```

---

### 6.3 Frontend Component Tests
**Files**: Various `*.test.tsx` files in `client/src/`

**Test cases**:
1. EventsListPage:
   - Renders table with events
   - Shows loading state
   - Shows empty state when no events
   - Filters work correctly
   - Pagination works
   - Navigates to detail page on row click

2. EventDetailPage:
   - Renders event metadata
   - Shows logs viewer
   - Shows error details for failed events
   - Auto-refreshes for running events
   - Shows progress bar for running events

3. EventStatusBadge:
   - Renders correct color for each status
   - Shows correct icon

**Use React Testing Library**:
```typescript
import { render, screen, waitFor } from '@testing-library/react';
import EventsListPage from './page';

describe('EventsListPage', () => {
  it('renders events table', async () => {
    render(<EventsListPage />);
    await waitFor(() => {
      expect(screen.getByText('Event Name')).toBeInTheDocument();
    });
  });
});
```

---

## Phase 7: Documentation

### 7.1 Update CLAUDE.md
**File**: `CLAUDE.md`

**Section to add**: After the "Logging Architecture" section

```markdown
## User Events Architecture

The application uses a centralized User Events system for tracking logs and outcomes of important long-running operations.

### Overview

User Events provide:
- **Centralized logging** for long-running operations (deployments, backups, certificate renewals, etc.)
- **Progress tracking** with 0-100 percentage
- **Full text log storage** in database for easy querying
- **Configurable retention** with automated cleanup
- **Flexible metadata** for operation-specific details

### Database Model

**Table**: `user_events` (`server/prisma/schema.prisma:795-848`)

**Key Fields**:
- `eventType` - Operation type (deployment, backup, certificate_create, etc.)
- `eventCategory` - Category (infrastructure, database, security, maintenance)
- `status` - Current status (pending, running, completed, failed, cancelled)
- `progress` - 0-100 percentage for in-progress operations
- `logs` - Full text logs stored directly in database
- `metadata` - JSON stringified operation-specific data
- `resourceId/resourceType` - Link to related resources
- `expiresAt` - Optional expiration for custom retention

### Services

**UserEventService** (`server/src/services/user-event-service.ts`):
- CRUD operations for events
- Filtering, sorting, pagination
- Log appending
- Automated cleanup of old events

**UserEventCleanupScheduler** (`server/src/services/user-event-cleanup-scheduler.ts`):
- Daily automated cleanup (default: 2 AM UTC)
- Configurable retention period (default: 30 days)
- Reads settings from `SystemSettings`

### API Endpoints

All endpoints require authentication (session or API key).

- `GET /api/events` - List events with filtering and pagination
- `GET /api/events/statistics` - Get aggregated statistics
- `GET /api/events/:id` - Get single event details
- `POST /api/events` - Create new event
- `PATCH /api/events/:id` - Update event
- `POST /api/events/:id/logs` - Append logs
- `DELETE /api/events/:id` - Delete event

### Instrumentation Pattern

To add User Events tracking to a new operation:

1. **Import and initialize service**:
   ```typescript
   import { UserEventService } from './services/user-event-service';
   const userEventService = new UserEventService(prisma);
   ```

2. **Create event at operation start**:
   ```typescript
   const userEvent = await userEventService.createEvent({
     eventType: 'operation_name',
     eventCategory: 'infrastructure', // or database, security, maintenance
     eventName: 'Human-readable operation name',
     userId: userId, // User who triggered, or undefined for system
     triggeredBy: 'manual', // or scheduled, webhook, api, system
     resourceId: resourceId, // Optional
     resourceType: 'deployment', // Optional
     resourceName: 'my-app', // Optional
     description: 'Brief description',
     metadata: { /* operation-specific data */ },
   });
   ```

3. **Update progress during operation**:
   ```typescript
   await userEventService.updateEvent(userEvent.id, {
     progress: 50,
   });
   ```

4. **Append logs at key steps**:
   ```typescript
   await userEventService.appendLogs(
     userEvent.id,
     `[${new Date().toISOString()}] Step completed: pulling image`
   );
   ```

5. **Complete event**:
   ```typescript
   await userEventService.updateEvent(userEvent.id, {
     status: 'completed', // or 'failed'
     resultSummary: 'Operation completed successfully',
     errorMessage: undefined, // Set if failed
     errorDetails: undefined, // Set if failed
   });
   ```

### Event Types

Common event types:
- `deployment` - Application deployments
- `deployment_rollback` - Deployment rollbacks
- `deployment_uninstall` - Application uninstallations
- `environment_start` - Environment startup
- `environment_stop` - Environment shutdown
- `certificate_create` - TLS certificate creation
- `certificate_renew` - TLS certificate renewal
- `backup` - Database backups
- `restore` - Database restores
- `container_cleanup` - Orphaned container cleanup
- `system_maintenance` - System maintenance operations

### Configuration

System settings (category='system'):
- `user_events_retention_days` - Days to keep events (default: 30)
- `user_events_cleanup_schedule` - Cron expression for cleanup (default: '0 2 * * *')

### Frontend

- Events list page: `/events`
- Event detail page: `/events/:id`
- System settings: `/settings/system` (retention configuration)
```

---

### 7.2 Create Integration Guide
**File**: `server/docs/USER_EVENTS_INTEGRATION.md`

**Contents**:
- Detailed instrumentation examples
- When to create events vs. use logging
- Best practices for metadata structure
- Error handling patterns
- Testing instrumented code
- Performance considerations

---

## Timeline Estimates

| Phase | Tasks | Estimated Time |
|-------|-------|----------------|
| Phase 4 | Integration Examples | 2-3 hours |
| Phase 5 | Frontend UI | 4-6 hours |
| Phase 6 | Testing | 2-3 hours |
| Phase 7 | Documentation | 1 hour |
| **Total** | | **9-13 hours** |

---

## Priority Order

**If time is limited, implement in this order**:

1. ✅ **Backend Core** (Already complete)
2. **Phase 4.1**: Deployment orchestrator integration (demonstrates value immediately)
3. **Phase 5.1 & 5.2**: Frontend list and detail pages (makes feature usable)
4. **Phase 5.4**: Navigation link (discoverability)
5. **Phase 7.1**: Update CLAUDE.md (helps future development)
6. **Phase 4.2-4.4**: Other integrations (as needed)
7. **Phase 5.3**: Retention settings UI (nice-to-have)
8. **Phase 6**: Tests (important but can be done incrementally)

---

## Testing the Backend (Now)

The backend is fully functional. Test it with:

```bash
# Get development API key
cd server && npm run show-dev-key

# List events
curl -H "x-api-key: YOUR_KEY" http://localhost:5000/api/events

# Create an event
curl -X POST -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "test",
    "eventCategory": "maintenance",
    "eventName": "Test Event",
    "triggeredBy": "manual",
    "description": "Testing the API"
  }' \
  http://localhost:5000/api/events

# Get statistics
curl -H "x-api-key: YOUR_KEY" http://localhost:5000/api/events/statistics
```

---

## Notes

- All backend services are running and initialized on server startup
- Cleanup scheduler is active and will run daily at 2 AM UTC
- Database schema includes all necessary indexes for performance
- Type safety is enforced across the full stack with shared types
- The feature is designed to be extended easily with new event types
