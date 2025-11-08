# Self-Backup UI and Health Monitoring Implementation (Phases 5, 6, 7)

## Overview

This PR completes the frontend implementation of the self-backup feature for Mini Infra, adding a comprehensive settings page, health monitoring indicator, and all necessary UI components for managing automated SQLite database backups to Azure Blob Storage.

## What's Implemented

### Phase 5: Frontend Settings Page

**New Page: `/settings/self-backup`**
- **Comprehensive Configuration Form**
  - Azure Storage container selection with live container fetching
  - Cron schedule input with quick preset buttons:
    - Hourly (0 * * * *)
    - Every 6 Hours (0 */6 * * *)
    - Daily at Midnight (0 0 * * *)
    - Daily at 2 AM (0 2 * * *)
  - Timezone selector with common timezones
  - Enable/disable scheduled backups toggle
  - Next scheduled backup time display

- **Manual Backup Trigger**
  - One-click "Backup Now" button
  - Real-time status updates during backup
  - Immediate feedback with toast notifications

- **Backup History Table**
  - Paginated backup history (10 per page)
  - Status filtering (All, Completed, Failed, In Progress)
  - Columns:
    - Started At (timezone-aware formatting)
    - Status (color-coded badges)
    - File Name (monospace font)
    - File Size (human-readable format)
    - Duration (formatted: ms, s, m, h)
    - Triggered By (scheduled/manual badges)
    - Actions (view error details or Azure blob URL)
  - Error details modal for failed backups
  - Real-time refresh button

- **Azure Storage Integration Check**
  - Alert when Azure is not connected
  - Direct link to Azure configuration page
  - Container validation before enabling backups

### Phase 6: Health Monitoring

**Site Header Indicator (4th Indicator)**
- **Status Colors:**
  - 🟢 Green: Backups running normally
  - 🟡 Yellow: Warning (1-2 failures in 24h or last backup failed)
  - 🔴 Red: Error (3+ failures in 24h or no successful backup in 48h)
  - ⚪ Gray: Not configured or disabled

- **Interactive Behavior:**
  - Tooltip shows detailed health message
  - Clickable when status is not healthy (navigates to settings)
  - Auto-refreshes every 60 seconds

- **Health Calculation Logic:**
  - Checks if backup is configured and enabled
  - Tracks failures in last 24 hours
  - Monitors time since last successful backup
  - Displays meaningful status messages

### Phase 7: Bug Fixes and Polish

**Backend Route Fix**
- Fixed route ordering in `self-backups.ts` - moved `/health` endpoint before `/:id` to prevent route collision
- Removed duplicate health endpoint definition

**Type System Improvements**
- Added `error` field to all response types for consistent error handling:
  - `SelfBackupConfigResponse`
  - `BackupHistoryResponse`
  - `BackupHealthResponse`

**Utility Functions**
- `formatBytes()`: Converts bytes to human-readable format (B, KB, MB, GB, TB)
- `formatDuration()`: Converts milliseconds to human-readable format (ms, s, m, h)

**React Hook Fixes**
- Fixed incorrect `useState` usage → `useEffect` in settings page
- Added proper dependency arrays

## Technical Implementation

### New Files Created
1. **`client/src/app/settings/self-backup/page.tsx`** (679 lines)
   - Complete settings page with all features
   - React Hook Form with Zod validation
   - TanStack Query for data fetching
   - Comprehensive error handling

2. **`client/src/hooks/use-self-backup.ts`** (449 lines)
   - React Query hooks for all self-backup API endpoints
   - Automatic cache invalidation on mutations
   - Configurable refetch intervals
   - Type-safe API calls

### Modified Files
1. **`client/src/components/site-header.tsx`**
   - Added `BackupHealthIndicator` component
   - Integrated with health API endpoint
   - Responsive status display

2. **`client/src/lib/route-config.ts`**
   - Added self-backup route to settings section
   - Configured navigation menu item with database icon

3. **`client/src/lib/utils.ts`**
   - Added `formatBytes()` utility function
   - Added `formatDuration()` utility function

4. **`lib/types/self-backup.ts`**
   - Added optional `error` field to response interfaces

5. **`server/src/routes/self-backups.ts`**
   - Fixed route ordering (health before :id)
   - Removed duplicate endpoint

## UI/UX Features

### Form Validation
- Required field validation for all configuration inputs
- Cron expression validation
- Container selection validation
- Real-time form state tracking

### User Feedback
- Toast notifications for all actions (success/error)
- Loading spinners during async operations
- Disabled states for invalid operations
- Clear error messages in modals

### Responsive Design
- Mobile-friendly layout
- Adaptive table design
- Proper spacing and alignment
- Consistent with existing Mini Infra design system

### Accessibility
- Semantic HTML structure
- Proper ARIA labels
- Keyboard navigation support
- Color-blind friendly status indicators

## API Integration

### Endpoints Used
- `GET /api/settings/self-backup` - Fetch configuration
- `PUT /api/settings/self-backup` - Update configuration
- `POST /api/settings/self-backup/enable` - Enable scheduled backups
- `POST /api/settings/self-backup/disable` - Disable scheduled backups
- `POST /api/settings/self-backup/trigger` - Trigger manual backup
- `GET /api/settings/self-backup/schedule-info` - Get next run time
- `GET /api/self-backups` - List backup history
- `GET /api/self-backups/health` - Get health status
- `GET /api/settings/azure/containers` - List Azure containers

### Data Flow
1. **Configuration Changes**
   ```
   User Input → Form Validation → API Call → Cache Invalidation → UI Update → Toast
   ```

2. **Manual Backup**
   ```
   Button Click → API Call → History Refresh → Health Update → Toast
   ```

3. **Health Monitoring**
   ```
   60s Interval → API Call → Status Calculation → Indicator Update
   ```

## Testing Recommendations

### Manual Testing Checklist
- [ ] Navigate to `/settings/self-backup` page loads correctly
- [ ] Azure connection check displays appropriate alert
- [ ] Container dropdown populates from API
- [ ] Cron preset buttons set correct values
- [ ] Form validation works for all fields
- [ ] Save configuration updates successfully
- [ ] Enable/disable toggle works correctly
- [ ] Next scheduled time displays correctly
- [ ] "Backup Now" button triggers backup
- [ ] Backup history table displays records
- [ ] Pagination works correctly
- [ ] Status filter works correctly
- [ ] Error details modal opens for failed backups
- [ ] Health indicator appears in site header
- [ ] Health indicator color reflects status
- [ ] Health indicator tooltip shows message
- [ ] Clicking indicator navigates to settings
- [ ] All date/times formatted with user timezone

### Integration Testing
- [ ] Configuration changes persist after page reload
- [ ] Health status updates after backup completion
- [ ] History table updates after manual backup
- [ ] Navigation menu item appears in sidebar
- [ ] Route-based breadcrumbs work correctly

### Error Scenarios
- [ ] Handle Azure disconnection gracefully
- [ ] Display API errors in toast notifications
- [ ] Show error details for failed backups
- [ ] Handle empty backup history
- [ ] Handle no containers available

## Performance Considerations

- **Query Caching**: TanStack Query caches all API responses with appropriate stale times
- **Conditional Fetching**: Health endpoint only polls when enabled
- **Optimistic Updates**: UI updates immediately with loading states
- **Pagination**: Limits history queries to 10 records per page
- **Lazy Loading**: Components load only when navigating to settings page

## Dependencies

### New Dependencies
None - all features use existing dependencies

### Existing Dependencies Used
- `react-hook-form` - Form management
- `zod` - Schema validation
- `@tanstack/react-query` - Data fetching
- `@tabler/icons-react` - Icons
- `sonner` - Toast notifications
- `date-fns` - Date formatting

## Breaking Changes

None - this is a pure addition with no breaking changes to existing functionality.

## Future Enhancements (Out of Scope)

- Email notifications on backup failure
- Backup restoration UI
- Retention policy configuration
- Backup size trends visualization
- Multiple backup destinations
- Incremental backups

## Screenshots

### Settings Page
![Self-Backup Settings](screenshots/self-backup-settings.png)
*Comprehensive configuration form with cron presets, timezone selection, and enable/disable toggle*

### Backup History
![Backup History Table](screenshots/backup-history.png)
*Paginated table showing backup operations with status, file size, and duration*

### Health Indicator
![Health Indicator](screenshots/health-indicator.png)
*Site header with 4 status indicators including self-backup (rightmost)*

### Error Details
![Error Modal](screenshots/error-details.png)
*Detailed error information modal for failed backups*

## Related PRs

This PR builds on the backend implementation completed in previous phases:
- Phase 1-2: Database schema and executor service
- Phase 3-4: Scheduler service and API routes

## Checklist

- [x] Code follows project style guidelines
- [x] All TypeScript types are properly defined
- [x] No console errors or warnings
- [x] Build passes without errors
- [x] Navigation menu updated
- [x] Route configuration updated
- [x] Health indicator integrated
- [x] All API endpoints tested
- [x] Error handling implemented
- [x] Loading states implemented
- [x] Toast notifications added
- [x] Timezone-aware formatting used
- [x] Responsive design implemented

## Deployment Notes

1. **Prerequisites**: Ensure backend routes and services from previous phases are deployed
2. **Build Order**: Build `lib` → `client` → `server`
3. **No Database Migrations**: Schema was added in previous phases
4. **No Environment Variables**: Uses existing Azure configuration
5. **Cache Considerations**: Browser cache may need clearing for route changes

## Documentation Updates Needed

- [ ] Add self-backup settings page to user documentation
- [ ] Document cron expression format and presets
- [ ] Update site header indicator documentation
- [ ] Add backup health status definitions

---

**Note**: This PR completes the self-backup feature implementation. All phases (1-7) are now complete and ready for production deployment.
