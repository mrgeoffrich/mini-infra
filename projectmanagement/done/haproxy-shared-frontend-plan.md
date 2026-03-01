# HAProxy Shared Frontend Architecture Plan

## Problem Statement

The current HAProxy implementation creates **one frontend per deployment/application**, each binding to `*:80`. This causes port conflicts when multiple applications are deployed to the same environment.

### Current Behavior
```
frontend fe_pilltracker_env1
    bind *:80
    ...

frontend fe_retromania_env1
    bind *:80          <-- CONFLICT!
    ...
```

### Desired Behavior (from newhaproxyconfig.md)
```
frontend http_frontend
    mode http
    bind *:80
    acl acl_pilltracker_app hdr(host) -i pilltracker.app
    acl acl_retro_blinglabs_tech hdr(host) -i retro.blinglabs.tech
    use_backend pilltracker if acl_pilltracker_app
    use_backend retro-mania if acl_retro_blinglabs_tech

backend pilltracker
    server pilltracker-03a01f91 172.30.0.4:3000 check ...

backend retro-mania
    server retro-mania-f8e6104d 172.30.0.6:3001 check ...
    server retro-mania-09f89851 172.30.0.7:3001 check ...
```

## Design Decisions

Based on requirements gathering:
- **Frontend Scope**: Per Environment (each environment gets its own shared frontend)
- **Remediation Strategy**: Full Reset (delete all and rebuild from active deployment configs)
- **SSL Handling**: Single HTTPS frontend with SNI-based routing

---

## Phase 1: Database Schema Updates

### Duration: ~2 hours

### Changes

#### 1.1 Modify `HAProxyFrontend` Model

Add fields to support shared frontends:

```prisma
model HAProxyFrontend {
  // Existing fields...
  id                    String   @id @default(cuid())
  frontendType          String   @default("deployment") // "deployment" | "manual" | "shared"
  frontendName          String   @unique
  backendName           String
  hostname              String
  bindPort              Int      @default(80)
  bindAddress           String   @default("*")
  useSSL                Boolean  @default(false)
  tlsCertificateId      String?
  sslBindPort           Int      @default(443)
  status                String   @default("pending")

  // New fields for shared frontend support
  isSharedFrontend      Boolean  @default(false)
  sharedFrontendId      String?  // Reference to parent shared frontend (for routes)

  // Relations
  routes                HAProxyRoute[]
  environment           Environment? @relation(fields: [environmentId], references: [id])
}
```

#### 1.2 New `HAProxyRoute` Model

Track individual hostname routes within a shared frontend:

```prisma
model HAProxyRoute {
  id                    String   @id @default(cuid())
  sharedFrontendId      String   // FK to shared HAProxyFrontend
  sharedFrontend        HAProxyFrontend @relation(fields: [sharedFrontendId], references: [id])

  // Route configuration
  hostname              String
  aclName               String   // e.g., "acl_pilltracker_app"
  backendName           String   // e.g., "pilltracker"
  priority              Int      @default(0)  // For rule ordering

  // Source tracking
  sourceType            String   // "deployment" | "manual"
  deploymentConfigId    String?  // For deployment routes
  manualFrontendId      String?  // For manual routes (legacy migration)

  // SSL per-route (for SNI)
  useSSL                Boolean  @default(false)
  tlsCertificateId      String?

  status                String   @default("active")
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@unique([sharedFrontendId, hostname])
}
```

### Files to Modify
- `server/prisma/schema.prisma`

### Migration Command
```bash
npx prisma migrate dev --name add-shared-frontend-support
```

---

## Phase 2: HAProxy Service Layer Refactoring

### Duration: ~4-6 hours

### 2.1 Update `HAProxyFrontendManager`

**File**: `server/src/services/haproxy/haproxy-frontend-manager.ts`

#### New Methods to Add

```typescript
// Get or create a shared frontend for an environment
async getOrCreateSharedFrontend(
  environmentId: string,
  type: 'http' | 'https'
): Promise<HAProxyFrontend>

// Add a route (ACL + backend switching rule) to a shared frontend
async addRouteToSharedFrontend(
  sharedFrontendId: string,
  hostname: string,
  backendName: string,
  sourceType: 'deployment' | 'manual',
  sourceId: string,
  sslOptions?: { useSSL: boolean; tlsCertificateId?: string }
): Promise<HAProxyRoute>

// Remove a route from a shared frontend
async removeRouteFromSharedFrontend(
  sharedFrontendId: string,
  hostname: string
): Promise<void>

// Update an existing route
async updateRoute(
  routeId: string,
  updates: { hostname?: string; useSSL?: boolean; tlsCertificateId?: string }
): Promise<HAProxyRoute>

// Sync all routes for an environment (used by remediation)
async syncEnvironmentRoutes(environmentId: string): Promise<void>
```

#### Leverage Existing DataPlane Client Methods

From `haproxy-dataplane-client.ts`:
- `createFrontend(config)` - Create the shared frontend once
- `addFrontendBind(frontendName, address, port, sslOptions)` - Add port bindings
- `addACL(frontendName, aclName, criterion, value)` - Add hostname ACLs
- `addBackendSwitchingRule(frontendName, backendName, aclName)` - Route to backend
- `deleteACL(frontendName, index)` - Remove ACL
- `deleteBackendSwitchingRule(frontendName, index)` - Remove routing rule
- `getACLs(frontendName)` - List existing ACLs
- `getBackendSwitchingRules(frontendName)` - List existing rules

### 2.2 Create `HAProxyRemediationService`

**New File**: `server/src/services/haproxy/haproxy-remediation-service.ts`

```typescript
export class HAProxyRemediationService {
  constructor(
    private frontendManager: HAProxyFrontendManager,
    private dataplaneClient: HAProxyDataPlaneClient,
    private prisma: PrismaClient
  ) {}

  /**
   * Full remediation of HAProxy for an environment
   * 1. Query all active DeploymentConfiguration and manual frontends
   * 2. Delete all existing frontends from HAProxy via DataPlane API
   * 3. Delete all backends via DataPlane API
   * 4. Create single http_frontend bound to *:80
   * 5. Create single https_frontend bound to *:443 with SNI
   * 6. For each deployment config / manual frontend:
   *    - Create backend with servers from active containers
   *    - Add ACL + backend switching rule to appropriate frontend
   * 7. Update database records
   */
  async remediateEnvironment(environmentId: string): Promise<RemediationResult>

  /**
   * Get current state vs expected state for an environment
   */
  async getRemediationPreview(environmentId: string): Promise<RemediationPreview>

  /**
   * Check if remediation is needed
   */
  async isRemediationNeeded(environmentId: string): Promise<boolean>
}

interface RemediationResult {
  success: boolean;
  frontendsDeleted: number;
  frontendsCreated: number;
  backendsRecreated: number;
  routesConfigured: number;
  errors: string[];
}

interface RemediationPreview {
  currentState: {
    frontends: string[];
    backends: string[];
  };
  expectedState: {
    sharedHttpFrontend: string;
    sharedHttpsFrontend: string;
    routes: Array<{ hostname: string; backend: string; ssl: boolean }>;
    backends: string[];
  };
  changes: {
    frontendsToDelete: string[];
    backendsToRecreate: string[];
    routesToAdd: string[];
  };
}
```

### 2.3 Update `ConfigureFrontend` Deployment Action

**File**: `server/src/services/deployments/actions/configure-frontend.ts`

Change from creating new frontend → adding route to shared frontend:

```typescript
// OLD:
await haproxyFrontendManager.createFrontendForDeployment(...)

// NEW:
const sharedFrontend = await haproxyFrontendManager.getOrCreateSharedFrontend(
  environmentId,
  context.enableSsl ? 'https' : 'http'
);
await haproxyFrontendManager.addRouteToSharedFrontend(
  sharedFrontend.id,
  context.hostname,
  context.backendName,
  'deployment',
  context.deploymentConfigId,
  { useSSL: context.enableSsl, tlsCertificateId: context.tlsCertificateId }
);
```

### Files to Create/Modify
- `server/src/services/haproxy/haproxy-frontend-manager.ts` (major refactor)
- `server/src/services/haproxy/haproxy-remediation-service.ts` (new)
- `server/src/services/haproxy/index.ts` (export new service)
- `server/src/services/deployments/actions/configure-frontend.ts` (update)

---

## Phase 3: API Routes

### Duration: ~2-3 hours

### 3.1 Environment Remediation Endpoint

**File**: `server/src/routes/environments.ts`

```typescript
// POST /api/environments/:environmentId/remediate-haproxy
router.post('/:environmentId/remediate-haproxy', async (req, res) => {
  // 1. Validate environment exists and has HAProxy
  // 2. Call HAProxyRemediationService.remediateEnvironment()
  // 3. Return result with detailed status
});

// GET /api/environments/:environmentId/haproxy-status
router.get('/:environmentId/haproxy-status', async (req, res) => {
  // Return current HAProxy configuration status
  // Including whether remediation is recommended
});

// GET /api/environments/:environmentId/remediation-preview
router.get('/:environmentId/remediation-preview', async (req, res) => {
  // Return preview of what remediation would do
});
```

### 3.2 Update Frontends API for Routes

**File**: `server/src/routes/haproxy-frontends.ts`

```typescript
// GET /api/haproxy/frontends/:frontendName/routes
router.get('/:frontendName/routes', async (req, res) => {
  // List all routes for a shared frontend
});

// POST /api/haproxy/frontends/:frontendName/routes
router.post('/:frontendName/routes', async (req, res) => {
  // Add a new route to a shared frontend (for manual additions)
});

// DELETE /api/haproxy/frontends/:frontendName/routes/:routeId
router.delete('/:frontendName/routes/:routeId', async (req, res) => {
  // Remove a route from a shared frontend
});
```

### 3.3 Enhanced Manual Frontend Routes

**File**: `server/src/routes/manual-haproxy-frontends.ts`

Update to work with shared frontend model:
- Creating a manual frontend now adds a route to the shared frontend
- Deleting removes the route (not the whole frontend)
- Update only modifies the route properties

### Files to Modify
- `server/src/routes/environments.ts`
- `server/src/routes/haproxy-frontends.ts`
- `server/src/routes/manual-haproxy-frontends.ts`

---

## Phase 4: Frontend UI - Environment Remediation

### Duration: ~3-4 hours

### 4.1 Remediate HAProxy Button on Environment Page

**File**: `client/src/app/environments/[id]/page.tsx`

Add to the header actions area:
- "Remediate HAProxy" button (only visible if environment has HAProxy service)
- Opens confirmation dialog with preview

### 4.2 Remediation Dialog Component

**New File**: `client/src/components/haproxy/remediate-haproxy-dialog.tsx`

```tsx
interface RemediateHAProxyDialogProps {
  environmentId: string;
  environmentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Features:
// - Shows preview of changes (frontends to delete, routes to create)
// - Warning about temporary traffic disruption
// - Progress indicator during remediation
// - Success/failure result display
```

### 4.3 HAProxy Status Card for Environment

**New File**: `client/src/components/environments/haproxy-status-card.tsx`

Display on environment detail page:
- Current frontend configuration (shared vs legacy)
- Number of routes configured
- Health status
- "Remediation recommended" badge if conflicts detected

### 4.4 React Query Hooks

**New File**: `client/src/hooks/use-haproxy-remediation.ts`

```typescript
export function useRemediationPreview(environmentId: string)
export function useRemediateHAProxy()
export function useHAProxyStatus(environmentId: string)
```

### Files to Create/Modify
- `client/src/app/environments/[id]/page.tsx`
- `client/src/components/haproxy/remediate-haproxy-dialog.tsx` (new)
- `client/src/components/environments/haproxy-status-card.tsx` (new)
- `client/src/hooks/use-haproxy-remediation.ts` (new)

---

## Phase 5: Frontend UI - Enhanced Frontends Management

### Duration: ~4-5 hours

### 5.1 Update Frontends List Page

**File**: `client/src/app/haproxy/frontends/page.tsx`

Changes:
- Add "Shared Frontend" type to filter options
- Show shared frontends with expandable route list
- Group routes under their parent shared frontend
- Add "Add Route" action for shared frontends

### 5.2 Shared Frontend Detail Page

**Update**: `client/src/app/haproxy/frontends/[frontendName]/page.tsx`

For shared frontends, show:
- Overview card with bind address/port
- Routes table with columns: Hostname, Backend, Source (Deployment/Manual), SSL, Status, Actions
- "Add Route" button
- Individual route edit/delete actions

### 5.3 Add Route Dialog

**New File**: `client/src/components/haproxy/add-route-dialog.tsx`

For manually adding routes to a shared frontend:
- Hostname input with validation
- Backend selection (existing or new)
- SSL toggle with certificate selection
- Container selection (if creating new backend)

### 5.4 Route Management Components

**New Files**:
- `client/src/components/haproxy/routes-table.tsx` - Table of routes within a frontend
- `client/src/components/haproxy/route-row.tsx` - Individual route row with actions
- `client/src/components/haproxy/edit-route-dialog.tsx` - Edit route hostname/SSL

### 5.5 Update Manual Frontend Create Flow

**File**: `client/src/app/haproxy/frontends/new/manual/page.tsx`

Update wizard to:
1. Select Environment
2. Choose Container
3. Configure Route (hostname, SSL) - note: adds to shared frontend
4. Review & Create

### Files to Create/Modify
- `client/src/app/haproxy/frontends/page.tsx`
- `client/src/app/haproxy/frontends/[frontendName]/page.tsx`
- `client/src/app/haproxy/frontends/new/manual/page.tsx`
- `client/src/components/haproxy/add-route-dialog.tsx` (new)
- `client/src/components/haproxy/routes-table.tsx` (new)
- `client/src/components/haproxy/route-row.tsx` (new)
- `client/src/components/haproxy/edit-route-dialog.tsx` (new)

---

## Phase 6: Shared Types and Testing

### Duration: ~2-3 hours

### 6.1 Shared Types

**File**: `lib/types/haproxy.ts`

```typescript
export interface SharedFrontend {
  id: string;
  frontendName: string;
  environmentId: string;
  bindAddress: string;
  bindPort: number;
  type: 'http' | 'https';
  routes: HAProxyRoute[];
  status: 'active' | 'pending' | 'failed';
}

export interface HAProxyRoute {
  id: string;
  hostname: string;
  aclName: string;
  backendName: string;
  sourceType: 'deployment' | 'manual';
  sourceId: string;
  useSSL: boolean;
  status: string;
}

export interface RemediationPreview {
  needsRemediation: boolean;
  currentState: { ... };
  expectedState: { ... };
  changes: { ... };
}

export interface RemediationResult {
  success: boolean;
  summary: { ... };
  errors: string[];
}
```
