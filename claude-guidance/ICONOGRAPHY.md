# Mini Infra Iconography Guide

This document defines the icon system used throughout the Mini Infra application to ensure consistent visual language and user experience.

## Icon Libraries

The application uses two complementary icon libraries:

### Primary: Tabler Icons (`@tabler/icons-react`)
- **Usage**: Navigation, branding, and major feature representation
- **Style**: Consistent stroke width, modern, clean design
- **Import**: `import { IconName } from "@tabler/icons-react"`
- **Documentation**: https://tabler.io/icons

### Secondary: Lucide React (`lucide-react`)
- **Usage**: UI actions, inline controls, status indicators, and UI components
- **Style**: Lightweight, consistent with modern UI patterns
- **Import**: `import { IconName } from "lucide-react"`
- **Documentation**: https://lucide.dev

## Icon Usage by Context

### 1. Navigation Icons (Tabler Icons)

All navigation icons use Tabler Icons for visual consistency in the sidebar.

#### Brand Identity
- **`IconInnerShadowTop`** - Application logo and brand mark
  - Used in: Sidebar header, branding

#### Main Navigation
- **`IconDashboard`** - Dashboard / Overview
  - Context: Main system overview and status page
- **`IconBrandDocker`** - Docker Containers
  - Context: Container management and monitoring
- **`IconDatabase`** - PostgreSQL / Database
  - Context: Database management, backups, and restoration
- **`IconRocket`** - Deployments
  - Context: Zero-downtime deployment orchestration
- **`IconServer`** - Environments
  - Context: Environment and infrastructure configuration
- **`IconCloud`** - Cloudflare Tunnels / Cloud Services
  - Context: Tunnel monitoring and cloud connectivity
- **`IconKey`** - API Keys / Credentials
  - Context: Authentication and credential management
- **`IconNetwork`** - Connectivity / Networking
  - Context: Service connectivity and network configuration
- **`IconSettings`** - Settings
  - Context: System and user configuration

#### Contextual Navigation Variants
- **`IconCloudComputing`** - Cloudflare Settings (sub-navigation)
  - Context: Specific cloud service configuration
- **`IconCloud`** - Azure Storage (sub-navigation)
  - Context: Cloud storage configuration

### 2. Action Icons (Lucide React)

Common actions throughout the application using Lucide icons.

#### Primary Actions
- **`Plus`** - Add / Create new resource
  - Context: Create database, add API key, new deployment
- **`RefreshCw`** - Refresh / Reload data
  - Context: Refresh lists, retry operations
- **`Play`** - Execute / Start operation
  - Context: Run backup, start deployment
- **`Trash2`** - Delete / Remove
  - Context: Delete resources, remove items
- **`Edit` / `Pencil`** - Edit / Modify
  - Context: Edit configurations, modify settings
- **`Download`** - Download / Export
  - Context: Download backups, export data

#### Navigation Actions
- **`ArrowLeft`** - Back / Return
  - Context: Navigate to previous page
- **`ArrowRight`** - Forward / Next step
  - Context: Multi-step forms, wizards
- **`Home`** - Navigate to home/dashboard
  - Context: Breadcrumb navigation

#### Secondary Actions
- **`Settings`** - Configure / Settings
  - Context: Item-specific settings, configuration dialogs
- **`MoreHorizontal`** - More options / Context menu
  - Context: Dropdown menus, additional actions
- **`X`** - Close / Cancel / Clear
  - Context: Close dialogs, clear filters, cancel operations
- **`Copy`** - Copy to clipboard
  - Context: Copy API keys, connection strings
- **`Eye`** / **`EyeOff`** - Show / Hide sensitive data
  - Context: Toggle password visibility, hide credentials

### 3. Status & Indicator Icons (Lucide React)

Visual feedback and state indicators.

#### Status Indicators
- **`AlertCircle`** - Warning / Attention needed
  - Context: Validation errors, warnings
- **`AlertTriangle`** - Critical alert / Danger
  - Context: Destructive actions, critical errors
- **`Check`** / **`CheckIcon`** - Success / Confirmed
  - Context: Successful operations, selected items
- **`Info`** - Information / Help
  - Context: Informational messages, help text

#### Loading States
- **`Loader2`** - Loading / Processing (with spin animation)
  - Context: Async operations, data fetching
- **`IconLoader2`** - Loading (Tabler variant)
  - Context: Alternative loading indicator

#### Trend Indicators
- **`IconTrendingUp`** - Positive trend / Increase
  - Context: Metrics, statistics
- **`IconTrendingDown`** - Negative trend / Decrease
  - Context: Metrics, statistics
- **`TrendingUp`** - Growth indicator (Lucide variant)
  - Context: Statistics cards

### 4. Resource Type Icons

Icons representing specific resource types.

#### Infrastructure Resources (Mixed)
- **`Server`** - Physical/virtual server, environment
  - Context: Environment management, server configuration
- **`Container`** - Docker container
  - Context: Container-specific actions
- **`Database`** - Database instance
  - Context: Database operations
- **`Network`** - Network resource
  - Context: Network configuration, connectivity
- **`HardDrive`** - Storage volume
  - Context: Volume management
- **`Globe`** - Public endpoint, web access
  - Context: Public-facing services

#### Security & Access
- **`Key`** - API key, credential
  - Context: API key management
- **`Shield`** - Security, protection, authentication
  - Context: Auth guards, security features
- **`Ban`** - Blocked, denied access
  - Context: Disabled features, revoked access
- **`LogIn`** / **`LogOut`** - Authentication actions
  - Context: User login/logout

#### Data & Activity
- **`Activity`** - Real-time activity, monitoring
  - Context: Progress indicators, monitoring
- **`History`** - Historical data, logs
  - Context: Backup history, audit logs
- **`Zap`** - Fast operation, performance
  - Context: Performance metrics
- **`Calendar`** - Date/time information
  - Context: Timestamps, scheduling

### 5. UI Component Icons (Lucide React)

Icons used within UI components and controls.

#### Dropdown & Selection
- **`ChevronDown`** / **`ChevronDownIcon`** - Expand dropdown
- **`ChevronsUpDown`** / **`ChevronsUpDownIcon`** - Combo box, sortable
- **`ChevronLeft`** / **`ChevronRight`** - Pagination, navigation
- **`ChevronRightIcon`** - Breadcrumb separator, submenu indicator
- **`ArrowUpDown`** - Sortable column

#### Search & Filtering
- **`Search`** / **`SearchIcon`** - Search input
- **`Filter`** - Filter controls
- **`X`** - Clear search/filter

#### Forms & Input
- **`CircleIcon`** - Radio button indicator
- **`CheckIcon`** - Checkbox indicator
- **`XIcon`** - Close dialog, remove item

#### User & Profile
- **`User`** - User profile, account
- **`IconDotsVertical`** - User menu, more options

### 6. Testing & Utility Icons

- **`TestTube`** - Test connection, validation
  - Context: Connection testing, validation checks

## Icon Size Guidelines

### Navigation Icons
```tsx
// Sidebar main items (default)
<IconDashboard />

// Sidebar header (larger)
<IconInnerShadowTop className="!size-5" />
```

### Action Icons
```tsx
// Standard button icon (16x16)
<Plus className="h-4 w-4" />

// Large action button
<RefreshCw className="h-5 w-5" />

// Icon-only button (with proper accessibility)
<Settings className="h-4 w-4" />
```

### Status Icons
```tsx
// Inline with text
<AlertCircle className="h-4 w-4" />

// Large status indicator
<AlertTriangle className="h-6 w-6" />
```

### Loading Icons
```tsx
// Standard loading spinner
<Loader2 className="h-4 w-4 animate-spin" />

// Large loading state
<Loader2 className="h-8 w-8 animate-spin" />
```

## Animation Guidelines

### Spinning Loaders
Always use the `animate-spin` utility class for loading indicators:
```tsx
<Loader2 className="h-4 w-4 animate-spin" />
<IconLoader2 className="size-4 animate-spin" />
```

### Hover States
Icons in interactive elements should use transition utilities:
```tsx
className="transition-colors hover:text-primary"
```

## Consistency Rules

### 1. Library Selection
- **DO** use Tabler Icons for all navigation items
- **DO** use Lucide React for all action buttons and UI controls
- **DON'T** mix icon libraries within the same component group

### 2. Semantic Consistency
- **Always** use the same icon for the same action across the app
  - Example: `Plus` for all "create" actions
  - Example: `Trash2` for all delete operations
- **Don't** use different icons for the same semantic meaning

### 3. Size Consistency
- **Navigation icons**: Default size (no custom class needed)
- **Button icons**: `h-4 w-4` (16x16px)
- **Large actions**: `h-5 w-5` (20x20px)
- **Status badges**: `h-4 w-4` (16x16px)

### 4. Color Guidelines
Icons should inherit text color by default:
```tsx
// Good - inherits context color
<Plus className="h-4 w-4" />

// Good - explicit color when needed
<AlertTriangle className="h-4 w-4 text-destructive" />
```

### 5. Accessibility
Always provide context for icon-only buttons:
```tsx
// Good - includes accessible label
<Button aria-label="Add new item">
  <Plus className="h-4 w-4" />
</Button>

// Better - includes tooltip
<Button aria-label="Add new item" title="Add new item">
  <Plus className="h-4 w-4" />
</Button>

// Best - icon with visible text
<Button>
  <Plus className="h-4 w-4" />
  <span>Add Item</span>
</Button>
```

## Adding New Icons

When adding new functionality:

1. **Check existing icons first** - Reuse established patterns
2. **Choose the appropriate library**:
   - Navigation feature? → Tabler Icons
   - Action or UI control? → Lucide React
3. **Follow naming conventions**:
   - Tabler: `Icon` prefix (e.g., `IconDatabase`)
   - Lucide: PascalCase (e.g., `Database`)
4. **Update this guide** with the new icon and its usage context
5. **Use consistent sizing** based on the context guidelines above

## Icon Import Patterns

### Centralized Navigation Imports
Navigation icons are imported in `client/src/lib/route-config.ts`:
```tsx
import {
  type Icon,
  IconBrandDocker,
  IconCloud,
  IconCloudComputing,
  IconDashboard,
  IconDatabase,
  IconKey,
  IconNetwork,
  IconRocket,
  IconServer,
  IconSettings,
} from "@tabler/icons-react";
```

### Component-Level Imports
Action and UI icons are imported per component as needed:
```tsx
// Action icons
import { Plus, Trash2, Edit, RefreshCw } from "lucide-react";

// Status icons
import { AlertCircle, Check, Loader2 } from "lucide-react";
```

## Examples from the Application

### Sidebar Navigation (Tabler Icons)
```tsx
// From client/src/lib/route-config.ts
{
  '/dashboard': {
    icon: IconDashboard,
    title: 'Dashboard'
  },
  '/containers': {
    icon: IconBrandDocker,
    title: 'Containers'
  },
  '/postgres': {
    icon: IconDatabase,
    title: 'PostgreSQL'
  }
}
```

### Action Buttons (Lucide React)
```tsx
// Create new resource
<Button>
  <Plus className="h-4 w-4" />
  Add Database
</Button>

// Delete action
<Button variant="destructive">
  <Trash2 className="h-4 w-4" />
  Delete
</Button>

// Refresh data
<Button variant="outline">
  <RefreshCw className="h-4 w-4" />
  Refresh
</Button>
```

### Loading States
```tsx
// Button loading state
<Button disabled={isLoading}>
  {isLoading ? (
    <>
      <Loader2 className="h-4 w-4 animate-spin" />
      Creating...
    </>
  ) : (
    <>
      <Plus className="h-4 w-4" />
      Create
    </>
  )}
</Button>
```

### Status Indicators
```tsx
// Error state
<div className="flex items-center gap-2 text-destructive">
  <AlertCircle className="h-4 w-4" />
  <span>Connection failed</span>
</div>

// Success state
<div className="flex items-center gap-2 text-green-600">
  <Check className="h-4 w-4" />
  <span>Saved successfully</span>
</div>
```

## Maintenance

This iconography guide should be updated when:
- New navigation items are added
- New action patterns are established
- Icon usage patterns change
- New icon libraries are introduced

Last updated: 2025-11-09
