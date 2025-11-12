
## Timezone and Date Display System

The application implements a comprehensive timezone-aware date and time display system that respects user preferences across the entire application.

### Frontend Date Formatting

#### Core Components

**User Preferences Hook** (`client/src/hooks/use-user-preferences.ts`)
- **Storage**: User timezone preference stored in database via user preferences API
- **Caching**: React Query with 5-minute stale time for optimal performance
- **Cache Invalidation**: Automatic invalidation on preference updates via `useUpdateUserPreferences`
- **API Endpoints**: 
  - `GET /api/user/preferences` - Retrieve user preferences including timezone
  - `PUT /api/user/preferences` - Update user preferences with cache invalidation
  - `GET /api/user/timezones` - Get list of available timezones for selection

**Formatted Date Hook** (`client/src/hooks/use-formatted-date.ts`)
- **Primary Hook**: `useFormattedDate()` - Returns timezone-aware formatting functions
- **Specialized Hooks**: 
  - `useFormattedDateTime(date)` - Memoized date-time formatting for specific dates
  - `useFormattedContainerDate(date)` - Optimized for container dashboard displays
- **Functions Provided**:
  - `formatDateTime(date, options?)` - Full date and time with user's timezone
  - `formatDate(date, options?)` - Date only with user's timezone  
  - `formatTime(date, options?)` - Time only with user's timezone
  - `formatDateWithPrefix(date, prefix, options?)` - Prefixed date formatting
  - `formatContainerDate(date, options?)` - Container-specific formatting

**Date Utilities** (`client/src/lib/date-utils.ts`)
- **Core Functions**: Underlying timezone-aware date formatting using `date-fns-tz`
- **Options Support**: Configurable display options (showSeconds, custom formats, etc.)
- **Timezone Handling**: Automatic timezone conversion from UTC to user preference
