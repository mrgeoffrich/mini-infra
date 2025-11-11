# Mini Infra Iconography Guide

This document defines the icon system used throughout the Mini Infra application to ensure consistent visual language and user experience.

## Icon Library

The application uses **Tabler Icons** (`@tabler/icons-react`) exclusively for all iconography needs.

### Tabler Icons (`@tabler/icons-react`)
- **Usage**: All icons throughout the application
- **Style**: Consistent stroke width, modern, clean design optimized for technical/infrastructure applications
- **Import**: `import { IconName } from "@tabler/icons-react"`
- **Documentation**: https://tabler.io/icons
- **Count**: 5,800+ free MIT-licensed icons
- **Advantages**:
  - Comprehensive brand icon library (Docker, Azure, Cloudflare, PostgreSQL, etc.)
  - Designed for developer tools and infrastructure applications
  - Consistent visual language across all icon types
  - Excellent tree-shaking support (import only what you use)
  - Fully compatible with React 19+

## Icon Categories

### 1. Brand Icons ⭐ NEW

Brand icons provide official logo representations for third-party services and technologies.

#### Infrastructure & Cloud Services
- **`IconBrandDocker`** - Docker containers and containerization
  - Context: Container management, Docker-related features
  - Official Docker whale logo
- **`IconBrandAzure`** - Microsoft Azure cloud services
  - Context: Azure Blob Storage, Azure services integration
  - Official Microsoft Azure logo
- **`IconBrandCloudflare`** - Cloudflare services
  - Context: Cloudflare Tunnels, CDN, cloud connectivity
  - Official Cloudflare logo
- **`IconBrandPostgresql`** - PostgreSQL database
  - Context: Database management, PostgreSQL operations
  - Official PostgreSQL elephant logo

**Usage Example:**
```tsx
import { IconBrandDocker, IconBrandAzure, IconBrandCloudflare, IconBrandPostgresql } from "@tabler/icons-react";

// In route config
{
  '/containers': {
    icon: IconBrandDocker,
    title: 'Docker Containers'
  },
  '/postgres': {
    icon: IconBrandPostgresql,
    title: 'PostgreSQL'
  }
}
```

### 2. Navigation Icons

Main navigation icons used in the sidebar and routing configuration.

#### Application Navigation
- **`IconInnerShadowTop`** or **`IconAppWindow`** - Application logo and brand mark
  - Used in: Sidebar header, branding
  - Size: `className="size-5"`

- **`IconDashboard`** - Dashboard / System Overview
  - Context: Main system overview and status page

- **`IconBrandDocker`** - Docker Containers *(Brand Icon)*
  - Context: Container management and monitoring

- **`IconBrandPostgresql`** or **`IconDatabase`** - PostgreSQL / Database
  - Context: Database management, backups, and restoration
  - Prefer brand icon for PostgreSQL-specific pages

- **`IconRocket`** - Deployments
  - Context: Zero-downtime deployment orchestration

- **`IconServer`** - Environments
  - Context: Environment and infrastructure configuration

- **`IconCloud`** - Cloudflare Tunnels / Cloud Services
  - Context: Tunnel monitoring and cloud connectivity
  - Alternative: `IconBrandCloudflare` for Cloudflare-specific sections

- **`IconKey`** - API Keys / Credentials
  - Context: Authentication and credential management

- **`IconNetwork`** - Connectivity / Networking
  - Context: Service connectivity and network configuration

- **`IconSettings`** - Settings
  - Context: System and user configuration

#### Contextual Navigation Variants
- **`IconCloudComputing`** - Cloud service configuration
  - Context: Cloudflare settings (sub-navigation)

- **`IconBrandAzure`** - Azure Storage *(Brand Icon)*
  - Context: Azure-specific configuration pages

### 3. Action Icons

Common actions and CRUD operations throughout the application.

#### Primary Actions
- **`IconPlus`** - Add / Create new resource
  - Context: Create database, add API key, new deployment

- **`IconRefresh`** - Refresh / Reload data
  - Context: Refresh lists, retry operations

- **`IconPlayerPlay`** - Execute / Start operation
  - Context: Run backup, start deployment

- **`IconTrash`** - Delete / Remove
  - Context: Delete resources, remove items

- **`IconEdit`** or **`IconPencil`** - Edit / Modify
  - Context: Edit configurations, modify settings

- **`IconDownload`** - Download / Export
  - Context: Download backups, export data

#### Navigation Actions
- **`IconArrowLeft`** - Back / Return
  - Context: Navigate to previous page

- **`IconArrowRight`** - Forward / Next step
  - Context: Multi-step forms, wizards

- **`IconHome`** - Navigate to home/dashboard
  - Context: Breadcrumb navigation

#### Secondary Actions
- **`IconSettings`** - Configure / Settings
  - Context: Item-specific settings, configuration dialogs

- **`IconDots`** or **`IconDotsHorizontal`** - More options / Context menu
  - Context: Dropdown menus, additional actions

- **`IconX`** - Close / Cancel / Clear
  - Context: Close dialogs, clear filters, cancel operations

- **`IconCopy`** - Copy to clipboard
  - Context: Copy API keys, connection strings

- **`IconEye`** / **`IconEyeOff`** - Show / Hide sensitive data
  - Context: Toggle password visibility, hide credentials

### 4. Status & Indicator Icons

Visual feedback and state indicators.

#### Status Indicators
- **`IconAlertCircle`** - Warning / Attention needed
  - Context: Validation errors, warnings, unreachable status

- **`IconAlertTriangle`** - Critical alert / Danger
  - Context: Destructive actions, critical errors

- **`IconCircleCheck`** - Success / Connected
  - Context: Successful operations, connected status

- **`IconCircleX`** - Failed / Disconnected
  - Context: Failed operations, disconnected status

- **`IconClock`** - Timeout / Pending
  - Context: Timeout status, pending operations

- **`IconCheck`** - Success / Confirmed
  - Context: Checkboxes, confirmations, selected items

- **`IconInfoCircle`** - Information / Help
  - Context: Informational messages, help text

#### Loading States
- **`IconLoader2`** or **`IconLoader`** - Loading / Processing
  - Context: Async operations, data fetching
  - Animation: Always use `animate-spin` class
  - Example: `<IconLoader2 className="size-4 animate-spin" />`

#### Trend Indicators
- **`IconTrendingUp`** - Positive trend / Increase
  - Context: Metrics, statistics, growth indicators

- **`IconTrendingDown`** - Negative trend / Decrease
  - Context: Metrics, statistics, decline indicators

### 5. Resource Type Icons

Icons representing specific infrastructure resource types.

#### Infrastructure Resources
- **`IconServer`** - Physical/virtual server, environment
  - Context: Environment management, server configuration

- **`IconBrandDocker`** - Docker container *(Brand Icon)*
  - Context: Container-specific actions

- **`IconDatabase`** or **`IconBrandPostgresql`** - Database instance
  - Context: Database operations

- **`IconNetwork`** - Network resource
  - Context: Network configuration, connectivity

- **`IconDeviceHardDrive`** - Storage volume
  - Context: Volume management, storage

- **`IconWorld`** or **`IconGlobe`** - Public endpoint, web access
  - Context: Public-facing services

#### Security & Access
- **`IconKey`** - API key, credential
  - Context: API key management

- **`IconShield`** - Security, protection, authentication
  - Context: Auth guards, security features

- **`IconBan`** - Blocked, denied access
  - Context: Disabled features, revoked access

- **`IconLogin`** / **`IconLogout`** - Authentication actions
  - Context: User login/logout

#### Data & Activity
- **`IconActivity`** - Real-time activity, monitoring
  - Context: Progress indicators, monitoring dashboards

- **`IconHistory`** - Historical data, logs
  - Context: Backup history, audit logs

- **`IconBolt`** - Fast operation, performance
  - Context: Performance metrics, quick actions

- **`IconCalendar`** - Date/time information
  - Context: Timestamps, scheduling

### 6. UI Component Icons

Icons used within UI components and controls.

#### Dropdown & Selection
- **`IconChevronDown`** - Expand dropdown
- **`IconChevronUp`** - Collapse dropdown
- **`IconChevronsUpDown`** or **`IconArrowsSort`** - Combo box, sortable
- **`IconChevronLeft`** / **`IconChevronRight`** - Pagination, navigation
- **`IconSelector`** - Breadcrumb separator, submenu indicator

#### Search & Filtering
- **`IconSearch`** - Search input
- **`IconFilter`** - Filter controls
- **`IconX`** - Clear search/filter

#### Forms & Input
- **`IconCircle`** - Radio button indicator
- **`IconCheck`** - Checkbox indicator
- **`IconX`** - Close dialog, remove item

#### User & Profile
- **`IconUser`** - User profile, account
- **`IconDotsVertical`** - User menu, more options (vertical)

### 7. Testing & Validation Icons

Testing icons use context-specific question mark variants to indicate validation and connection testing based on what's being tested.

#### Cloud & Infrastructure Testing
- **`IconCloudQuestion`** - Test cloud service connections
  - Context: Azure Blob Storage testing, Cloudflare API validation
  - Example: "Test Azure Connection", "Validate Cloudflare Token"

#### Settings & Configuration Testing
- **`IconSettingsQuestion`** - Test configuration settings
  - Context: Connection string validation, API endpoint testing
  - Example: "Test Connection String", "Validate Configuration"

#### Database Testing
- **`IconDatabaseSearch`** - Test database connections
  - Context: PostgreSQL connection validation, database credential testing
  - Example: "Test Database Connection"
  - Note: Uses search metaphor (probing/validating connection)

#### General Validation
- **`IconQuestionMark`** or **`IconHelpCircle`** - Generic testing/validation
  - Context: General validation, help prompts, unknown test contexts
  - Example: Generic "Test" buttons when context is unclear

**Usage Guidelines:**
- Always choose the most specific icon based on what's being tested
- Cloud services (Azure, Cloudflare) → `IconCloudQuestion`
- Settings, configs, connection strings → `IconSettingsQuestion`
- Database connections → `IconDatabaseSearch`
- When context is unclear → `IconQuestionMark` or `IconHelpCircle`

---

## Icon Size Guidelines

Tabler Icons use a consistent sizing system. Always use Tailwind's sizing utilities.

### Size Classes

```tsx
// Navigation icons (sidebar) - default size
<IconDashboard />

// Sidebar header (larger)
<IconInnerShadowTop className="size-5" />

// Standard button icon (16x16px)
<IconPlus className="size-4" />

// Large action button (20x20px)
<IconRefresh className="size-5" />

// Page header icon (24x24px)
<IconDashboard className="size-6" />

// Status badge icon (16x16px)
<IconAlertCircle className="size-4" />

// Large loading spinner (32x32px with animation)
<IconLoader2 className="size-8 animate-spin" />

// Inline with text (16x16px)
<IconCheck className="size-4" />
```

### Size Reference Table

| Context | Size Class | Pixels | Usage |
|---------|-----------|--------|-------|
| Navigation (default) | *(none)* | 16x16 | Sidebar navigation items |
| Sidebar header | `size-5` | 20x20 | App logo, brand mark |
| Button icon | `size-4` | 16x16 | Action buttons, controls |
| Large action | `size-5` | 20x20 | Prominent buttons |
| Page header | `size-6` | 24x24 | Page title sections |
| Status badge | `size-4` | 16x16 | Status indicators |
| Large loader | `size-8` | 32x32 | Loading states |
| Inline icon | `size-4` | 16x16 | Inline with text |

---

## Animation Guidelines

### Spinning Loaders

Always use the `animate-spin` utility class for loading indicators:

```tsx
// Standard loading spinner
<IconLoader2 className="size-4 animate-spin" />

// Large loading state
<IconLoader className="size-8 animate-spin" />
```

### Hover States

Icons in interactive elements should use transition utilities:

```tsx
className="transition-colors hover:text-primary"
```

---

## Consistency Rules

### 1. Single Library Policy
- **DO** use Tabler Icons exclusively for all icon needs
- **DON'T** mix icon libraries (no Lucide, Font Awesome, etc.)
- **REASON**: Ensures consistent visual language, smaller bundle size, better maintenance

### 2. Brand Icons Priority
- **DO** use brand icons when representing specific technologies:
  - `IconBrandDocker` for Docker containers
  - `IconBrandPostgresql` for PostgreSQL databases
  - `IconBrandAzure` for Azure services
  - `IconBrandCloudflare` for Cloudflare features
- **DON'T** use generic icons when brand icons exist
- **REASON**: Better recognition, professional appearance

### 3. Semantic Consistency
- **Always** use the same icon for the same action across the app:
  - `IconPlus` for all "create" actions
  - `IconTrash` for all delete operations
  - `IconRefresh` for all reload/refresh actions
  - `IconEdit` or `IconPencil` for edit operations (choose one and stick with it)
- **Don't** use different icons for the same semantic meaning

### 4. Size Consistency
Follow the size guidelines table above. Key rules:
- **Navigation icons**: Default size (no custom class needed)
- **Button icons**: `size-4` (16x16px)
- **Large actions**: `size-5` (20x20px)
- **Status badges**: `size-4` (16x16px)
- **Page headers**: `size-6` (24x24px)

### 5. Color Guidelines

Icons should inherit text color by default:

```tsx
// Good - inherits context color
<IconPlus className="size-4" />

// Good - explicit color when needed
<IconAlertTriangle className="size-4 text-destructive" />

// Good - status colors
<IconCircleCheck className="size-4 text-green-600" />
<IconCircleX className="size-4 text-red-600" />
```

### 6. Accessibility

Always provide context for icon-only buttons:

```tsx
// Good - includes accessible label
<Button aria-label="Add new item">
  <IconPlus className="size-4" />
</Button>

// Better - includes tooltip
<Button aria-label="Add new item" title="Add new item">
  <IconPlus className="size-4" />
</Button>

// Best - icon with visible text
<Button>
  <IconPlus className="size-4" />
  <span>Add Item</span>
</Button>
```

---

## Import Patterns

### Centralized Navigation Imports

Navigation icons are imported in `client/src/lib/route-config.ts`:

```tsx
import {
  type Icon,
  IconBrandDocker,
  IconBrandPostgresql,
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
import { IconPlus, IconTrash, IconEdit, IconRefresh } from "@tabler/icons-react";

// Status icons
import { IconAlertCircle, IconCheck, IconLoader2 } from "@tabler/icons-react";

// Brand icons
import { IconBrandDocker, IconBrandAzure } from "@tabler/icons-react";
```

---

## Adding New Icons

When adding new functionality:

1. **Check existing icons first** - Reuse established patterns
2. **Search Tabler Icons** at https://tabler.io/icons - Search by keyword
3. **Prefer brand icons** when representing specific technologies
4. **Follow naming conventions**: All Tabler icons use `Icon` prefix (e.g., `IconDatabase`)
5. **Update this guide** with the new icon and its usage context
6. **Use consistent sizing** based on the context guidelines above

---

## Examples from the Application

### Sidebar Navigation (Brand Icons)

```tsx
// From client/src/lib/route-config.ts
{
  '/dashboard': {
    icon: IconDashboard,
    title: 'Dashboard'
  },
  '/containers': {
    icon: IconBrandDocker,  // ⭐ Brand icon
    title: 'Docker Containers'
  },
  '/postgres': {
    icon: IconBrandPostgresql,  // ⭐ Brand icon
    title: 'PostgreSQL'
  }
}
```

### Action Buttons

```tsx
// Create new resource
<Button>
  <IconPlus className="size-4" />
  Add Database
</Button>

// Delete action
<Button variant="destructive">
  <IconTrash className="size-4" />
  Delete
</Button>

// Refresh data
<Button variant="outline">
  <IconRefresh className="size-4" />
  Refresh
</Button>
```

### Loading States

```tsx
// Button loading state
<Button disabled={isLoading}>
  {isLoading ? (
    <>
      <IconLoader2 className="size-4 animate-spin" />
      Creating...
    </>
  ) : (
    <>
      <IconPlus className="size-4" />
      Create
    </>
  )}
</Button>
```

### Status Indicators

```tsx
// Error state
<div className="flex items-center gap-2 text-destructive">
  <IconAlertCircle className="size-4" />
  <span>Connection failed</span>
</div>

// Success state
<div className="flex items-center gap-2 text-green-600">
  <IconCircleCheck className="size-4" />
  <span>Saved successfully</span>
</div>
```

### Brand Icon Usage

```tsx
// Docker connectivity page
import { IconBrandDocker } from "@tabler/icons-react";

<Card>
  <CardHeader>
    <div className="flex items-center gap-2">
      <IconBrandDocker className="size-6" />
      <CardTitle>Docker Service Status</CardTitle>
    </div>
  </CardHeader>
</Card>
```

---

## Maintenance

This iconography guide should be updated when:
- New navigation items are added
- New action patterns are established
- Icon usage patterns change
- New features require specific brand icons
- Tabler Icons library adds new relevant icons

Last updated: 2025-01-09