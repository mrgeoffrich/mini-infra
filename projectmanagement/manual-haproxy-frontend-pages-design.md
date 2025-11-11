# Manual HAProxy Frontend Pages - Design Specification

## Overview

This document outlines the design for four new pages to support manual HAProxy frontend management:

1. **Enhanced Frontend List Page** - View and manage all frontends (deployment + manual)
2. **Manual Frontend Creation Page** - Create new manual frontend connections
3. **Frontend Details Page** - View detailed information about a specific frontend
4. **Manual Frontend Edit Page** - Edit existing manual frontend configuration

All pages follow the **Page Layout Design Guide** (`claude-guidance/page-layout-design-guide.md`) and use **Tabler Icons** per the **Iconography Guide** (`claude-guidance/ICONOGRAPHY.md`).

---

## Navigation Integration

### Sidebar Link Addition

**File:** `client/src/lib/route-config.ts`

Add new route to the main navigation group:

```typescript
'/haproxy': {
  path: '/haproxy',
  title: 'HAProxy',
  icon: IconNetwork,  // Network icon for HAProxy routing
  showInNav: true,
  navGroup: 'main',
  children: {
    'frontends': {
      path: '/haproxy/frontends',
      title: 'Frontends',
      showInNav: false,
    },
    'frontends/new/manual': {
      path: '/haproxy/frontends/new/manual',
      title: 'Connect Container',
      showInNav: false,
    },
  }
}
```

**Navigation Structure:**
- Main sidebar shows: "HAProxy" with `IconNetwork`
- Clicking navigates to `/haproxy/frontends` (frontend list page)
- Child routes handle creation and details pages

---

## Page 1: Enhanced Frontend List Page

**Route:** `/haproxy/frontends`

**File:** `client/src/app/haproxy/frontends/page.tsx`

### Purpose
Display all HAProxy frontends (both deployment and manual types) with filtering, search, and management actions.

### Layout Structure

```tsx
export default function FrontendsListPage() {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <HeaderWithAction />
      </div>

      {/* Filters and Search */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <FiltersCard />
      </div>

      {/* Frontends List */}
      <div className="px-4 lg:px-6">
        <FrontendsTable />
      </div>
    </div>
  );
}
```

### Component Hierarchy

```
FrontendsListPage
├── HeaderWithAction
│   ├── Icon: IconNetwork (blue background)
│   ├── Title: "HAProxy Frontends"
│   ├── Description: "Manage frontend connections and routing configuration"
│   └── Action Button: "Connect Container" → /haproxy/frontends/new/manual
│       └── Icon: IconPlus
│
├── FiltersCard (Card component)
│   ├── CardHeader: "Filter Frontends"
│   └── CardContent
│       ├── TypeFilter (Select dropdown)
│       │   └── Options: All | Deployment | Manual
│       ├── EnvironmentFilter (Select dropdown)
│       ├── StatusFilter (Select dropdown)
│       │   └── Options: All | Active | Pending | Failed
│       └── SearchInput
│           └── Icon: IconSearch
│
└── FrontendsTable (Card component)
    ├── CardHeader
    │   ├── CardTitle: "Frontends ({count})"
    │   └── Refresh Button
    │       └── Icon: IconRefresh
    │
    └── CardContent
        └── Table
            ├── Columns:
            │   ├── Type Badge (Deployment | Manual)
            │   ├── Frontend Name
            │   ├── Hostname
            │   ├── Backend/Source (deployment name or container name)
            │   ├── Environment
            │   ├── Status Badge
            │   ├── SSL Indicator (IconShield if enabled)
            │   └── Actions (DropdownMenu)
            │       ├── View Details → /haproxy/frontends/[name]
            │       ├── Edit (manual only) → /haproxy/frontends/[name]/edit
            │       └── Delete (manual only, with confirmation)
            │
            └── EmptyState
                ├── Icon: IconNetwork (size-12)
                └── Message: "No frontends found"
```

### Loading State

```tsx
if (isLoading) {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
      </div>
      <div className="px-4 lg:px-6">
        <Skeleton className="h-[500px] w-full" />
      </div>
    </div>
  );
}
```

### Hooks Required

#### Existing Hooks (Reuse)
- `useAllFrontends()` - Fetches all frontends (from `use-haproxy-frontend.ts`)

#### New Hooks to Develop
**File:** `client/src/hooks/use-manual-haproxy-frontend.ts`

```typescript
// 1. Delete manual frontend
export function useDeleteManualFrontend() {
  // DELETE /api/haproxy/manual-frontends/:frontendName
  // Invalidates: ["haproxy-frontends"] query
  // Shows success/error toasts
}

// 2. Get all environments (for filter)
export function useEnvironments() {
  // GET /api/environments
  // Query key: ["environments"]
  // Returns: Array<{ id, name }>
}
```

### Icons Used
- **`IconNetwork`** - Page header icon (blue background: `bg-blue-100 dark:bg-blue-900`)
- **`IconPlus`** - "Connect Container" button
- **`IconRefresh`** - Refresh frontends list
- **`IconSearch`** - Search input
- **`IconShield`** - SSL enabled indicator
- **`IconEye`** - View details action
- **`IconEdit`** - Edit action (manual frontends)
- **`IconTrash`** - Delete action (manual frontends)
- **`IconDots`** - Actions dropdown menu

### State Management
- **Filters State:** React state for type, environment, status, search query
- **Table State:** `@tanstack/react-table` for sorting, pagination
- **Delete Confirmation:** Dialog state for delete confirmation

---

## Page 2: Manual Frontend Creation Page

**Route:** `/haproxy/frontends/new/manual`

**File:** `client/src/app/haproxy/frontends/new/manual/page.tsx`

### Purpose
Guide users through creating a manual frontend connection to an existing Docker container.

### Layout Structure

```tsx
export default function CreateManualFrontendPage() {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <PageHeader />
      </div>

      {/* Step Indicator */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <StepIndicator currentStep={step} />
      </div>

      {/* Form Content */}
      <div className="px-4 lg:px-6 max-w-7xl">
        {step === 1 && <EnvironmentSelectionCard />}
        {step === 2 && <ContainerSelectionCard />}
        {step === 3 && <FrontendConfigurationCard />}
        {step === 4 && <ValidationAndCreationCard />}
      </div>

      {/* Navigation Buttons */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <NavigationButtons />
      </div>
    </div>
  );
}
```

### Component Hierarchy

```
CreateManualFrontendPage
├── PageHeader
│   ├── Back Button → /haproxy/frontends
│   │   └── Icon: IconArrowLeft
│   ├── Icon: IconPlus (orange background)
│   ├── Title: "Connect Container to HAProxy"
│   └── Description: "Create a manual frontend connection to an existing Docker container"
│
├── StepIndicator (horizontal stepper)
│   ├── Step 1: "Select Environment" (IconServer)
│   ├── Step 2: "Choose Container" (IconBrandDocker)
│   ├── Step 3: "Configure Frontend" (IconSettings)
│   └── Step 4: "Review & Create" (IconCheck)
│
├── EnvironmentSelectionCard (Step 1)
│   ├── CardHeader
│   │   ├── CardTitle: "Select Environment"
│   │   └── CardDescription: "Choose the environment where HAProxy is running"
│   └── CardContent
│       ├── EnvironmentSelect (with environment status)
│       │   └── Shows HAProxy status badge for each environment
│       └── HAProxyStatusInfo
│           ├── Container running: IconCircleCheck (green)
│           └── Network configured: IconNetwork (blue)
│
├── ContainerSelectionCard (Step 2)
│   ├── CardHeader
│   │   ├── CardTitle: "Select Container"
│   │   └── CardDescription: "Choose an existing container on the same network as HAProxy"
│   └── CardContent
│       ├── ContainerList (filterable)
│       │   └── Each container shows:
│       │       ├── Name, Image, State
│       │       ├── Network badges
│       │       ├── Ports exposed
│       │       └── Eligibility badge (IconCircleCheck / IconAlertCircle)
│       └── NetworkWarning (if container not on HAProxy network)
│           └── Icon: IconAlertTriangle
│
├── FrontendConfigurationCard (Step 3)
│   ├── CardHeader
│   │   ├── CardTitle: "Frontend Configuration"
│   │   └── CardDescription: "Configure routing and connectivity settings"
│   └── CardContent (Form)
│       ├── HostnameInput (validated DNS format)
│       ├── ContainerPortInput (1-65535)
│       ├── SSLToggle (Switch component)
│       ├── CertificateSelect (if SSL enabled)
│       │   └── Shows certificate expiry and status
│       └── HealthCheckPathInput (optional, default: "/")
│
├── ValidationAndCreationCard (Step 4)
│   ├── CardHeader
│   │   ├── CardTitle: "Review & Create"
│   │   └── CardDescription: "Verify configuration before creating"
│   └── CardContent
│       ├── ConfigurationPreview
│       │   ├── Environment: {name}
│       │   ├── Container: {name} ({image})
│       │   ├── Hostname: {hostname}
│       │   ├── Port: {port}
│       │   ├── SSL: {enabled/disabled}
│       │   └── Certificate: {name} (if SSL)
│       ├── ValidationChecks (real-time)
│       │   ├── Container still running (IconCircleCheck / IconCircleX)
│       │   ├── Network connectivity (IconCircleCheck / IconCircleX)
│       │   ├── Hostname availability (IconCircleCheck / IconCircleX)
│       │   └── Certificate valid (if SSL) (IconCircleCheck / IconCircleX)
│       └── CreationProgress (during creation)
│           ├── Creating backend... (IconLoader2 animate-spin)
│           ├── Creating frontend... (IconLoader2 animate-spin)
│           ├── Deploying SSL... (if enabled) (IconLoader2 animate-spin)
│           └── Success! (IconCircleCheck)
│
└── NavigationButtons
    ├── Back Button (if step > 1)
    │   └── Icon: IconArrowLeft
    ├── Cancel Button → /haproxy/frontends
    │   └── Icon: IconX
    └── Next/Create Button
        └── Icon: IconArrowRight (steps 1-3) or IconCheck (step 4)
```

### Loading State

```tsx
// Show skeleton for environment selection
<Skeleton className="h-[300px] w-full" />
```

### Hooks Required

#### New Hooks to Develop
**File:** `client/src/hooks/use-manual-haproxy-frontend.ts`

```typescript
// 1. Get eligible containers for an environment
export function useEligibleContainers(environmentId: string | null) {
  // GET /api/haproxy/manual-frontends/containers?environmentId={id}
  // Query key: ["eligible-containers", environmentId]
  // Enabled only when environmentId is not null
  // Returns: { containers: EligibleContainer[], haproxyNetwork: string }
}

// 2. Create manual frontend
export function useCreateManualFrontend() {
  // POST /api/haproxy/manual-frontends
  // Invalidates: ["haproxy-frontends"] query
  // Shows success/error toasts
  // Redirects to frontend details on success
}

// 3. Validate hostname availability
export function useValidateHostname(hostname: string, environmentId: string) {
  // Could be a separate endpoint or done client-side with useAllFrontends()
  // Returns: { available: boolean, conflictingFrontend?: string }
}

// 4. Get TLS certificates for environment
export function useTLSCertificates(environmentId: string | null) {
  // GET /api/tls-certificates?environmentId={id}&status=ACTIVE
  // Query key: ["tls-certificates", environmentId]
  // Returns: Array<{ id, commonName, expiresAt, status }>
}
```

**File:** `client/src/hooks/use-environments.ts` (may already exist)

```typescript
// Get all environments with HAProxy status
export function useEnvironmentsWithHAProxy() {
  // GET /api/environments
  // Enhanced to include HAProxy container status
  // Returns: Array<{ id, name, haproxyStatus: 'running' | 'stopped' | 'missing' }>
}
```

### Icons Used
- **`IconPlus`** - Page header icon (orange background: `bg-orange-100 dark:bg-orange-900`)
- **`IconArrowLeft`** - Back button
- **`IconServer`** - Step 1 indicator
- **`IconBrandDocker`** - Step 2 indicator (brand icon)
- **`IconSettings`** - Step 3 indicator
- **`IconCheck`** - Step 4 indicator and success states
- **`IconCircleCheck`** - Validation success indicators
- **`IconCircleX`** - Validation failure indicators
- **`IconAlertCircle`** - Warnings
- **`IconAlertTriangle`** - Critical warnings
- **`IconLoader2`** - Loading spinners (with `animate-spin`)
- **`IconNetwork`** - Network information
- **`IconShield`** - SSL/TLS certificate indicators
- **`IconX`** - Cancel button

### State Management
- **Wizard State:** `useState` for current step (1-4)
- **Form State:** React Hook Form with Zod validation
- **Creation Progress:** State for tracking multi-step creation process
- **Validation State:** Real-time validation results

### Form Validation (Zod Schema)

```typescript
const createManualFrontendSchema = z.object({
  environmentId: z.string().min(1, "Environment is required"),
  containerId: z.string().min(1, "Container is required"),
  containerName: z.string().min(1),
  containerPort: z.number().int().min(1).max(65535, "Port must be 1-65535"),
  hostname: z.string()
    .min(1, "Hostname is required")
    .regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid hostname format"),
  enableSsl: z.boolean().default(false),
  tlsCertificateId: z.string().optional(),
  healthCheckPath: z.string().default("/"),
});
```

---

## Page 3: Frontend Details Page

**Route:** `/haproxy/frontends/[frontendName]`

**File:** `client/src/app/haproxy/frontends/[frontendName]/page.tsx`

### Purpose
Display comprehensive information about a specific frontend (deployment or manual type), with appropriate actions based on frontend type.

### Layout Structure

```tsx
export default function FrontendDetailsPage() {
  const { frontendName } = useParams();

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <PageHeader />
      </div>

      {/* Overview Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <OverviewCard />
      </div>

      {/* Routing Configuration Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <RoutingConfigCard />
      </div>

      {/* Backend/Source Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        {frontend.frontendType === 'manual'
          ? <ContainerDetailsCard />
          : <DeploymentDetailsCard />
        }
      </div>

      {/* SSL/TLS Card (if enabled) */}
      {frontend.useSSL && (
        <div className="px-4 lg:px-6 max-w-7xl">
          <SSLCertificateCard />
        </div>
      )}

      {/* Health Status Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <HealthStatusCard />
      </div>

      {/* Delete Dialog (manual frontends only) */}
      <DeleteFrontendDialog />
    </div>
  );
}
```

### Component Hierarchy

```
FrontendDetailsPage
├── PageHeader
│   ├── Back Button → /haproxy/frontends
│   │   └── Icon: IconArrowLeft
│   ├── Icon: IconNetwork (blue background)
│   ├── Title: {frontendName}
│   ├── Type Badge: "Deployment" | "Manual"
│   ├── Status Badge: Frontend status
│   └── Action Buttons (right side)
│       ├── Edit Button (manual only) → /haproxy/frontends/[name]/edit
│       │   └── Icon: IconEdit
│       ├── Sync Button (deployment only)
│       │   └── Icon: IconRefresh
│       └── Delete Button (manual only, opens dialog)
│           └── Icon: IconTrash
│
├── OverviewCard
│   ├── CardHeader
│   │   ├── CardTitle: "Overview"
│   │   └── Icon: IconInfoCircle
│   └── CardContent (2-column grid)
│       ├── Type: {frontendType} (with badge)
│       ├── Hostname: {hostname} (IconWorld)
│       ├── Status: {status} (with badge)
│       ├── Environment: {environmentName} (IconServer)
│       ├── Created: {createdAt} (IconCalendar)
│       ├── Updated: {updatedAt} (IconCalendar)
│       └── Error Message (if status === 'failed')
│           └── Icon: IconAlertCircle (red)
│
├── RoutingConfigCard
│   ├── CardHeader
│   │   ├── CardTitle: "Routing Configuration"
│   │   └── Icon: IconNetwork
│   └── CardContent
│       ├── Frontend Name: {frontendName}
│       ├── Backend Name: {backendName}
│       ├── Bind Address: {bindAddress}:{bindPort}
│       ├── SSL Enabled: {useSSL} (IconShield or IconBan)
│       ├── SSL Bind Port: {sslBindPort} (if SSL enabled)
│       └── ACL Rules Preview (code block)
│           └── Shows HAProxy ACL configuration
│
├── ContainerDetailsCard (Manual Frontends)
│   ├── CardHeader
│   │   ├── CardTitle: "Container Details"
│   │   └── Icon: IconBrandDocker
│   └── CardContent
│       ├── Container Name: {containerName}
│       ├── Container ID: {containerId} (with copy button)
│       │   └── Icon: IconCopy
│       ├── Container Port: {containerPort}
│       ├── Container Status: Running | Stopped | Missing
│       │   └── Real-time check with appropriate icon
│       ├── Networks: {networks} (badges)
│       └── View Container Button → /containers
│           └── Icon: IconEye
│
├── DeploymentDetailsCard (Deployment Frontends)
│   ├── CardHeader
│   │   ├── CardTitle: "Deployment Configuration"
│   │   └── Icon: IconRocket
│   └── CardContent
│       ├── Deployment Name: {deploymentName}
│       ├── Deployment ID: {deploymentConfigId}
│       ├── Last Deployed: {timestamp}
│       └── View Deployment Button → /deployments/[id]
│           └── Icon: IconEye
│
├── SSLCertificateCard (if useSSL === true)
│   ├── CardHeader
│   │   ├── CardTitle: "SSL/TLS Certificate"
│   │   └── Icon: IconShield
│   └── CardContent
│       ├── Certificate ID: {tlsCertificateId}
│       ├── Common Name: {commonName}
│       ├── Status: {certificateStatus} (badge)
│       ├── Issued: {issuedAt}
│       ├── Expires: {expiresAt}
│       │   └── Warning if expiring soon (IconAlertTriangle)
│       └── View Certificate Button → /settings/tls-certificates
│           └── Icon: IconEye
│
├── HealthStatusCard
│   ├── CardHeader
│   │   ├── CardTitle: "Health Status"
│   │   ├── Icon: IconActivity
│   │   └── Refresh Button
│   │       └── Icon: IconRefresh
│   └── CardContent
│       ├── Backend Server Health: Healthy | Unhealthy
│       │   └── Icon: IconCircleCheck | IconCircleX
│       ├── Frontend Routing: Active | Inactive
│       │   └── Icon: IconCircleCheck | IconCircleX
│       ├── SSL Handshake: Success | Failed (if SSL)
│       │   └── Icon: IconCircleCheck | IconCircleX
│       └── Last Health Check: {timestamp}
│
└── DeleteFrontendDialog (Manual frontends only)
    ├── DialogHeader
    │   ├── DialogTitle: "Delete Manual Frontend"
    │   └── Icon: IconAlertTriangle (red)
    └── DialogContent
        ├── Warning Message: "This will remove the frontend from HAProxy..."
        ├── Container Status Warning (if container still running)
        └── DialogFooter
            ├── Cancel Button
            └── Delete Button (destructive variant)
                └── Icon: IconTrash
```

### Loading State

```tsx
if (isLoading) {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </div>
      <div className="px-4 lg:px-6 max-w-7xl">
        <Skeleton className="h-[300px] w-full" />
      </div>
      <div className="px-4 lg:px-6 max-w-7xl">
        <Skeleton className="h-[250px] w-full" />
      </div>
    </div>
  );
}
```

### Hooks Required

#### New Hooks to Develop
**File:** `client/src/hooks/use-manual-haproxy-frontend.ts`

```typescript
// 1. Get frontend by name (supports both deployment and manual)
export function useFrontendByName(frontendName: string) {
  // GET /api/haproxy/frontends/:frontendName
  // Query key: ["haproxy-frontend", frontendName]
  // Returns: HAProxyFrontendInfo with all details
}

// 2. Get container status (for manual frontends)
export function useContainerStatus(containerId: string | null) {
  // Uses existing container API to check if container still running
  // Query key: ["container-status", containerId]
  // Enabled only when containerId is not null
  // Returns: { running: boolean, status: string }
}

// 3. Get health status for frontend
export function useFrontendHealthStatus(frontendName: string) {
  // GET /api/haproxy/frontends/:frontendName/health
  // Query key: ["frontend-health", frontendName]
  // Returns: { backendHealth, routingStatus, sslHandshake?, lastCheck }
}
```

#### Existing Hooks (Reuse)
- `useSyncDeploymentFrontend()` - For deployment frontend sync
- `useDeleteManualFrontend()` - For manual frontend deletion

### Icons Used
- **`IconNetwork`** - Page header icon (blue background)
- **`IconArrowLeft`** - Back navigation
- **`IconEdit`** - Edit button (manual frontends)
- **`IconRefresh`** - Sync/refresh buttons
- **`IconTrash`** - Delete button
- **`IconInfoCircle`** - Overview card
- **`IconWorld`** - Hostname indicator
- **`IconServer`** - Environment indicator
- **`IconCalendar`** - Date/time fields
- **`IconAlertCircle`** - Error messages
- **`IconShield`** - SSL enabled
- **`IconBan`** - SSL disabled
- **`IconBrandDocker`** - Container details (brand icon)
- **`IconRocket`** - Deployment details
- **`IconCopy`** - Copy to clipboard
- **`IconEye`** - View related resource
- **`IconActivity`** - Health status
- **`IconCircleCheck`** - Healthy/success states
- **`IconCircleX`** - Unhealthy/failure states
- **`IconAlertTriangle`** - Warnings (expiring cert, etc.)

### State Management
- **Delete Dialog:** Dialog open/close state
- **Real-time Updates:** React Query auto-refetch for health status

---

## Page 4: Manual Frontend Edit Page

**Route:** `/haproxy/frontends/[frontendName]/edit`

**File:** `client/src/app/haproxy/frontends/[frontendName]/edit/page.tsx`

### Purpose
Allow users to update configuration for existing manual frontends. **Note:** Container and environment cannot be changed (must delete and recreate).

### Layout Structure

```tsx
export default function EditManualFrontendPage() {
  const { frontendName } = useParams();

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header Section */}
      <div className="px-4 lg:px-6">
        <PageHeader />
      </div>

      {/* Info Alert */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <InfoAlert />
      </div>

      {/* Current Configuration Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <CurrentConfigCard />
      </div>

      {/* Edit Form Card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <EditFormCard />
      </div>

      {/* Action Buttons */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <ActionButtons />
      </div>
    </div>
  );
}
```

### Component Hierarchy

```
EditManualFrontendPage
├── PageHeader
│   ├── Back Button → /haproxy/frontends/[frontendName]
│   │   └── Icon: IconArrowLeft
│   ├── Icon: IconEdit (orange background)
│   ├── Title: "Edit Frontend: {frontendName}"
│   └── Description: "Update configuration for manual frontend"
│
├── InfoAlert (Alert component)
│   ├── Icon: IconInfoCircle
│   └── Message: "Container and environment cannot be changed. To connect a different container, delete this frontend and create a new one."
│
├── CurrentConfigCard
│   ├── CardHeader
│   │   ├── CardTitle: "Current Configuration"
│   │   └── Icon: IconNetwork
│   └── CardContent (read-only display)
│       ├── Environment: {environmentName} (IconServer, disabled)
│       ├── Container: {containerName} (IconBrandDocker, disabled)
│       ├── Container Port: {containerPort} (disabled)
│       └── Status: {status} (badge)
│
├── EditFormCard
│   ├── CardHeader
│   │   ├── CardTitle: "Editable Settings"
│   │   └── CardDescription: "Modify hostname, SSL, and health check settings"
│   └── CardContent (Form with React Hook Form)
│       ├── HostnameInput
│       │   ├── Label: "Hostname"
│       │   ├── Icon: IconWorld
│       │   ├── Validation: DNS format, uniqueness check
│       │   └── Helper: "Changing hostname will update routing rules"
│       ├── SSLSettingsSection
│       │   ├── SSLToggle (Switch)
│       │   │   └── Label: "Enable SSL/TLS" (Icon: IconShield)
│       │   ├── CertificateSelect (if SSL enabled)
│       │   │   ├── Shows active certificates
│       │   │   ├── Certificate status badges
│       │   │   └── Expiry warnings
│       │   └── SSLPortInput (default: 443)
│       └── HealthCheckSection
│           ├── HealthCheckPathInput
│           │   ├── Label: "Health Check Path"
│           │   ├── Icon: IconActivity
│           │   ├── Default: "/"
│           │   └── Helper: "Endpoint HAProxy will ping for health checks"
│           └── TestHealthCheckButton (optional)
│               └── Icon: IconSettingsQuestion
│
└── ActionButtons
    ├── Cancel Button → /haproxy/frontends/[frontendName]
    │   └── Icon: IconX
    └── Save Changes Button
        ├── Icon: IconCheck
        └── Loading state: IconLoader2 animate-spin
```

### Loading State

```tsx
if (isLoading) {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
      </div>
      <div className="px-4 lg:px-6 max-w-7xl">
        <Skeleton className="h-[400px] w-full" />
      </div>
    </div>
  );
}
```

### Hooks Required

#### New Hooks to Develop
**File:** `client/src/hooks/use-manual-haproxy-frontend.ts`

```typescript
// 1. Update manual frontend
export function useUpdateManualFrontend() {
  // PUT /api/haproxy/manual-frontends/:frontendName
  // Body: { hostname?, enableSsl?, tlsCertificateId?, healthCheckPath? }
  // Invalidates: ["haproxy-frontend", frontendName], ["haproxy-frontends"]
  // Shows success/error toasts
  // Redirects to details page on success
}

// 2. Test health check endpoint
export function useTestHealthCheck() {
  // POST /api/haproxy/frontends/:frontendName/test-health
  // Body: { path: string }
  // Returns: { success: boolean, statusCode: number, message: string }
  // Does not invalidate queries (just a test)
}
```

#### Existing Hooks (Reuse)
- `useFrontendByName(frontendName)` - Load current frontend data
- `useTLSCertificates(environmentId)` - Load available certificates

### Icons Used
- **`IconEdit`** - Page header icon (orange background: `bg-orange-100 dark:bg-orange-900`)
- **`IconArrowLeft`** - Back navigation
- **`IconInfoCircle`** - Info alert
- **`IconNetwork`** - Current config card
- **`IconServer`** - Environment field (disabled)
- **`IconBrandDocker`** - Container field (disabled)
- **`IconWorld`** - Hostname input
- **`IconShield`** - SSL toggle and indicators
- **`IconActivity`** - Health check settings
- **`IconSettingsQuestion`** - Test health check button
- **`IconX`** - Cancel button
- **`IconCheck`** - Save button
- **`IconLoader2`** - Loading spinner (with `animate-spin`)

### State Management
- **Form State:** React Hook Form with Zod validation
- **Dirty State:** Track form changes to enable/disable save button
- **Validation State:** Real-time hostname validation

### Form Validation (Zod Schema)

```typescript
const updateManualFrontendSchema = z.object({
  hostname: z.string()
    .min(1, "Hostname is required")
    .regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid hostname format"),
  enableSsl: z.boolean(),
  tlsCertificateId: z.string().optional(),
  sslBindPort: z.number().int().min(1).max(65535).default(443),
  healthCheckPath: z.string().min(1).default("/"),
});
```

### Access Control
- **Frontend Type Check:** Redirect to details page if frontend type is "deployment" (cannot edit deployment frontends)
- **Permission Check:** Ensure user has permission to edit

---

## Shared Components to Develop

### File: `client/src/components/haproxy/frontend-type-badge.tsx`

**Purpose:** Display frontend type badge (Deployment | Manual)

```typescript
interface FrontendTypeBadgeProps {
  type: 'deployment' | 'manual';
  className?: string;
}

// Displays:
// - "Deployment" badge (blue) with IconRocket
// - "Manual" badge (orange) with IconBrandDocker
```

### File: `client/src/components/haproxy/frontend-status-badge.tsx`

**Purpose:** Display frontend status badge (already exists as `FrontendStatusBadge` - reuse!)

**Existing Component:** `client/src/components/deployments/dns-status-badge.tsx`
- Supports: 'active', 'pending', 'failed', 'removed'
- Already has correct icons and colors

### File: `client/src/components/haproxy/container-eligibility-badge.tsx`

**Purpose:** Show if container can be connected to HAProxy

```typescript
interface ContainerEligibilityBadgeProps {
  canConnect: boolean;
  reason?: string;
}

// Displays:
// - "Can Connect" (green) with IconCircleCheck
// - "Cannot Connect" (red) with IconCircleX + tooltip with reason
```

### File: `client/src/components/haproxy/step-indicator.tsx`

**Purpose:** Multi-step wizard progress indicator

```typescript
interface Step {
  number: number;
  title: string;
  icon: Icon;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: number;
}

// Displays horizontal stepper with:
// - Completed steps (green check icon)
// - Current step (blue icon)
// - Future steps (gray icon)
// - Lines connecting steps
```

### File: `client/src/components/haproxy/ssl-certificate-select.tsx`

**Purpose:** Certificate selection dropdown with status and expiry info

```typescript
interface SSLCertificateSelectProps {
  environmentId: string;
  value?: string;
  onChange: (value: string) => void;
}

// Uses useTLSCertificates() hook
// Displays each certificate with:
// - Common name
// - Status badge
// - Expiry date (with warning if < 30 days)
// - Disabled if status !== 'ACTIVE'
```

---

## Reusable Existing Components

### From `client/src/components/deployments/`

1. **`FrontendConfigCard`** - Display frontend configuration (can be enhanced for manual frontends)
2. **`FrontendStatusBadge`** - Status badges (already perfect!)

### From `client/src/components/ui/`

All shadcn/ui components:
- Card, CardHeader, CardTitle, CardDescription, CardContent
- Button, Badge, Alert
- Table, Dialog, Select, Input, Switch
- Skeleton (for loading states)
- Tooltip

---

## API Integration Summary

### Existing Endpoints (Already Implemented)

**File:** `server/src/routes/haproxy-frontends.ts`
- `GET /api/haproxy/frontends` - List all frontends
- `GET /api/haproxy/frontends/:frontendName` - Get specific frontend

**File:** `server/src/routes/manual-haproxy-frontends.ts`
- `GET /api/haproxy/manual-frontends/containers?environmentId=X` - Get eligible containers
- `POST /api/haproxy/manual-frontends` - Create manual frontend
- `PUT /api/haproxy/manual-frontends/:frontendName` - Update manual frontend
- `DELETE /api/haproxy/manual-frontends/:frontendName` - Delete manual frontend

### New Endpoints Needed (Backend Development)

1. **`GET /api/haproxy/frontends/:frontendName/health`**
   - Returns backend server health, routing status, SSL handshake status
   - Real-time health check data

2. **`POST /api/haproxy/frontends/:frontendName/test-health`**
   - Test health check endpoint
   - Body: `{ path: string }`
   - Returns: Status code and response

---

## Development Checklist

### Phase 1: Hooks Development

**File:** `client/src/hooks/use-manual-haproxy-frontend.ts`
- [ ] `useEligibleContainers(environmentId)`
- [ ] `useCreateManualFrontend()`
- [ ] `useUpdateManualFrontend()`
- [ ] `useDeleteManualFrontend()`
- [ ] `useFrontendByName(frontendName)`
- [ ] `useContainerStatus(containerId)`
- [ ] `useFrontendHealthStatus(frontendName)`
- [ ] `useTestHealthCheck()`
- [ ] `useValidateHostname(hostname, environmentId)`

**File:** `client/src/hooks/use-tls-certificates.ts` (if doesn't exist)
- [ ] `useTLSCertificates(environmentId)`

**File:** `client/src/hooks/use-environments.ts` (enhance existing)
- [ ] `useEnvironmentsWithHAProxy()` - Include HAProxy status

### Phase 2: Shared Components

- [ ] `FrontendTypeBadge` - Type indicator (Deployment | Manual)
- [ ] `ContainerEligibilityBadge` - Connection eligibility indicator
- [ ] `StepIndicator` - Multi-step wizard progress
- [ ] `SSLCertificateSelect` - Certificate selection dropdown

### Phase 3: Pages

- [ ] **Frontend List Page** (`/haproxy/frontends/page.tsx`)
  - [ ] Header with action button
  - [ ] Filters card
  - [ ] Frontends table with actions
  - [ ] Delete confirmation dialog
  - [ ] Loading and error states

- [ ] **Manual Frontend Creation Page** (`/haproxy/frontends/new/manual/page.tsx`)
  - [ ] Multi-step wizard (4 steps)
  - [ ] Environment selection
  - [ ] Container selection with eligibility
  - [ ] Configuration form
  - [ ] Validation and creation
  - [ ] Navigation and state management

- [ ] **Frontend Details Page** (`/haproxy/frontends/[frontendName]/page.tsx`)
  - [ ] Overview card
  - [ ] Routing configuration
  - [ ] Container/deployment details (conditional)
  - [ ] SSL certificate info (if enabled)
  - [ ] Health status monitoring
  - [ ] Actions (edit/delete for manual, sync for deployment)

- [ ] **Manual Frontend Edit Page** (`/haproxy/frontends/[frontendName]/edit/page.tsx`)
  - [ ] Current config display (read-only)
  - [ ] Editable settings form
  - [ ] Hostname, SSL, health check updates
  - [ ] Save and cancel actions
  - [ ] Validation and error handling

### Phase 4: Navigation Integration

- [ ] Update `client/src/lib/route-config.ts`
  - [ ] Add `/haproxy` main route with `IconNetwork`
  - [ ] Add child routes for frontends, creation, details, edit
- [ ] Test sidebar navigation
- [ ] Verify breadcrumb navigation

### Phase 5: Testing & Polish

- [ ] Test all CRUD operations
- [ ] Verify loading states
- [ ] Test error handling
- [ ] Verify responsive design (mobile, tablet, desktop)
- [ ] Test dark mode appearance
- [ ] Accessibility checks (ARIA labels, keyboard navigation)
- [ ] Cross-browser testing

---

## Color Scheme & Iconography

Following the **Iconography Guide**:

### Primary Icons
- **HAProxy/Network:** `IconNetwork` (blue: `bg-blue-100 dark:bg-blue-900`)
- **Create/Add:** `IconPlus` (orange: `bg-orange-100 dark:bg-orange-900`)
- **Edit:** `IconEdit` (orange: `bg-orange-100 dark:bg-orange-900`)

### Brand Icons (Tabler)
- **Docker:** `IconBrandDocker`
- **PostgreSQL:** `IconBrandPostgresql` (if relevant)

### Status Icons
- **Success:** `IconCircleCheck` (green-600)
- **Error:** `IconCircleX` (red-600)
- **Warning:** `IconAlertCircle` (yellow-600)
- **Critical:** `IconAlertTriangle` (red-600)

### Action Icons
- **Back:** `IconArrowLeft`
- **Forward:** `IconArrowRight`
- **Refresh:** `IconRefresh`
- **Delete:** `IconTrash`
- **View:** `IconEye`
- **Copy:** `IconCopy`
- **Cancel:** `IconX`
- **Save:** `IconCheck`

### Loading
- **Spinner:** `IconLoader2` with `animate-spin` class

---

## Responsive Behavior

All pages follow the layout guide:
- **Mobile:** `gap-4 py-4 px-4`
- **Desktop:** `gap-6 py-6 lg:px-6`
- **Max width:** `max-w-7xl` for content sections
- **Tables:** Horizontal scroll on mobile
- **Forms:** Single column on mobile, may use grid on desktop

---

## Summary

This design provides:

1. ✅ **Consistent Layout** - All pages follow page-layout-design-guide.md
2. ✅ **Proper Iconography** - Uses Tabler Icons per ICONOGRAPHY.md
3. ✅ **Component Reuse** - Leverages existing FrontendConfigCard, FrontendStatusBadge
4. ✅ **Type Safety** - All types already defined in `@mini-infra/types`
5. ✅ **API Integration** - Hooks map to existing backend endpoints
6. ✅ **Navigation** - Sidebar integration with HAProxy section
7. ✅ **Accessibility** - Proper ARIA labels, keyboard navigation
8. ✅ **Responsive** - Mobile-first design with desktop enhancements
9. ✅ **Dark Mode** - All color schemes include dark mode variants
10. ✅ **Loading States** - Skeleton loaders for all async operations

**Total Pages:** 4
**New Hooks:** ~9
**New Components:** ~4
**Reused Components:** ~10+

This design is ready for implementation following the established patterns in the Mini Infra application.
