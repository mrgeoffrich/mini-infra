# Manual HAProxy Frontend Connections - Feature Plan

## Executive Summary

This feature enables users to manually connect HAProxy frontends to **existing Docker containers** running on the host, outside of the deployment system. This is particularly useful for connecting the Mini-Infra application itself to HAProxy when deployed as a container.

---

## Current State Analysis

### How Frontends Work Today

**Automatic Creation via Deployments:**
- Frontends are automatically created during deployment state machine execution
- **1:1 relationship** with `DeploymentConfiguration` (via unique `deploymentConfigId`)
- Frontend lifecycle is managed by deployment orchestrator
- Containers are automatically connected to HAProxy's Docker network during deployment
- Hostname-based routing with ACLs and backend switching rules

**Key Constraints:**
- Frontends **require** a `DeploymentConfiguration` (database constraint)
- Frontends **cannot exist independently** of a deployment
- No mechanism to connect HAProxy to "external" containers

**Network Requirements:**
- Application containers **must** be on the same Docker network as HAProxy
- HAProxy uses container internal IP addresses for backend servers
- Environment determines which HAProxy instance and network to use

---

## Problem Statement

**Goal:** Allow users to expose existing Docker containers through HAProxy without going through the full deployment workflow.

**Use Cases:**
1. **Self-hosting:** Connect Mini-Infra application itself to HAProxy when deployed as a container
2. **External Services:** Expose third-party containers (databases, monitoring tools, etc.)
3. **Development:** Quick frontend setup for testing containers
4. **Migration:** Connect containers before migrating to deployment system

**Challenges:**
- Current schema enforces `deploymentConfigId` as required and unique
- No UI/API for manual frontend management
- Container network validation is embedded in deployment flow
- Need to ensure container is on HAProxy network before creating frontend

---

## Proposed Solution

### High-Level Approach

**Decouple Frontends from Deployments:**
- Make `deploymentConfigId` **optional** in database schema
- Add `frontendType` field: `"deployment"` | `"manual"`
- Manual frontends reference Docker containers directly
- Deployment frontends continue current behavior

**User Flow:**
1. User navigates to manual frontend creation page
2. Selects environment (determines HAProxy instance)
3. Selects existing Docker container from dropdown
4. System validates container is on HAProxy network
5. User configures hostname, port, SSL settings
6. System creates frontend and backend in HAProxy
7. Frontend becomes immediately active

---

## Data Model Changes

### Schema Modifications

**HAProxyFrontend Model:**
```prisma
model HAProxyFrontend {
  id                    String   @id @default(cuid())

  // Make deploymentConfigId optional for manual frontends
  deploymentConfigId    String?  @unique  // Changed from required
  deploymentConfig      DeploymentConfiguration? @relation(...)

  // Add type discriminator
  frontendType          String   @default("deployment") // "deployment" | "manual"

  // Manual frontend fields
  containerName         String?  // Docker container name (for manual only)
  containerId           String?  // Docker container ID (for manual only)
  containerPort         Int?     // Container listening port (for manual only)
  environmentId         String   // Environment association (required for all)

  // Existing fields...
  frontendName          String   @unique
  backendName           String
  hostname              String
  bindPort              Int      @default(80)
  bindAddress           String   @default("*")
  useSSL                Boolean  @default(false)
  tlsCertificateId      String?
  sslBindPort           Int      @default(443)
  status                String   @default("pending")
  errorMessage          String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
}
```

**Key Changes:**
- `deploymentConfigId` → **Optional** (nullable)
- `frontendType` → Discriminates between deployment and manual
- `containerName`, `containerId`, `containerPort` → Manual frontend metadata
- `environmentId` → Direct environment reference (for manual frontends)

### Backward Compatibility

**Deployment Frontends:**
- Continue to populate `deploymentConfigId`
- `frontendType = "deployment"`
- Existing logic unchanged

**Manual Frontends:**
- `deploymentConfigId = null`
- `frontendType = "manual"`
- Managed via new API endpoints

---

## User Flow Design

### 1. Entry Point

**Location:** HAProxy management section in navigation

**Pages:**
- **Existing:** Frontends list (currently shows deployment frontends)
- **New:** "Connect Container" button/page

### 2. Manual Frontend Creation Flow

#### **Step 1: Environment Selection**
- **Purpose:** Determine which HAProxy instance to use
- **UI:** Dropdown of available environments
- **Validation:**
  - Environment must have running HAProxy container
  - HAProxy must have custom Docker network configured
- **Output:** Environment context (HAProxy container ID, network name)

#### **Step 2: Container Selection**
- **Purpose:** Choose existing container to expose
- **UI:** Dropdown of running containers on Docker host
- **Filtering:**
  - Only show containers **on the same network** as HAProxy
  - Exclude HAProxy container itself
  - Show container names, IDs, and network info
- **Validation:**
  - Container must be running
  - Container must be on HAProxy network
  - Container cannot already have a frontend
- **Output:** Container metadata (ID, name, internal IP, networks)

#### **Step 3: Frontend Configuration**
- **Purpose:** Configure routing and connectivity
- **Fields:**
  - **Hostname** (required): Domain to route (e.g., `mini.example.com`)
  - **Container Port** (required): Port application listens on inside container
  - **Frontend Name** (auto-generated): `fe_manual_{containerName}_{environmentId}`
  - **Backend Name** (auto-generated): `be_manual_{containerName}`
  - **SSL/TLS** (optional): Enable HTTPS with certificate selection
  - **Health Check Endpoint** (optional): Path for health monitoring (default: `/`)
- **Validation:**
  - Hostname must be unique across all frontends in environment
  - Hostname must be valid DNS format
  - Container port must be valid (1-65535)
  - If SSL enabled, certificate must be selected and active
- **Preview:** Show ACL and routing rule that will be created

#### **Step 4: Validation & Creation**
- **Pre-Creation Checks:**
  1. Verify container still running
  2. Verify container still on HAProxy network
  3. Verify hostname not already in use
  4. Test container port accessibility (optional)
  5. Validate certificate if SSL enabled
- **Creation Process:**
  1. Create backend in HAProxy with container IP:port as server
  2. Create frontend in HAProxy with hostname routing
  3. Add ACL for hostname matching
  4. Add backend switching rule
  5. Deploy SSL certificate if enabled
  6. Create `HAProxyFrontend` database record
- **Status Display:**
  - Show progress of creation steps
  - Display success or error messages
  - Provide rollback on failure

#### **Step 5: Confirmation**
- **Success View:**
  - Frontend URL: `http(s)://{hostname}`
  - Backend details: Container name, IP, port
  - Health check status
  - Link to frontend details page
- **Next Actions:**
  - Configure DNS (if needed)
  - Test frontend connectivity
  - View logs and metrics

### 3. Management Flow

#### **Frontend List Page (Enhanced)**
- **Filtering:**
  - Type: All | Deployment | Manual
  - Environment
  - Status
  - Hostname
- **Display:**
  - Frontend name
  - Type badge (Deployment | Manual)
  - Hostname
  - Backend (deployment name or container name)
  - Environment
  - Status (active | failed | pending)
  - SSL indicator
  - Actions menu

#### **Frontend Details Page**
- **Display:**
  - **Overview:** Type, hostname, status, created date
  - **Routing:** ACL rules, backend switching rules, bind addresses
  - **Backend:** Container details (for manual) or deployment details
  - **SSL/TLS:** Certificate info if enabled
  - **Environment:** Environment name, HAProxy container
  - **Health:** Backend server health status
- **Actions:**
  - Edit hostname (requires re-configuration)
  - Enable/disable SSL
  - Change certificate (if SSL)
  - Update health check settings
  - Delete frontend

#### **Deletion Flow**
- **Manual Frontends:**
  - Prompt user for confirmation
  - Warn if container is still running
  - Remove frontend from HAProxy
  - Remove backend from HAProxy
  - Delete database record
- **Deployment Frontends:**
  - Cannot be deleted manually
  - Must go through deployment removal process

---

## Validation Requirements

### Pre-Creation Validation

#### **1. Environment Validation**
- **Check:** Environment exists and is active
- **Check:** HAProxy container exists with environment label
- **Check:** HAProxy container is running
- **Check:** HAProxy has custom Docker network (not just bridge)
- **Error Messages:**
  - "Environment {name} not found"
  - "No HAProxy instance found for environment {name}"
  - "HAProxy container is not running"
  - "HAProxy network not configured"

#### **2. Container Validation**
- **Check:** Container exists and is running
- **Check:** Container is on at least one network shared with HAProxy
- **Check:** Container does not already have a frontend
- **Check:** Container port is exposed (via Docker inspect)
- **Error Messages:**
  - "Container {name} not found or not running"
  - "Container is not on the same network as HAProxy"
  - "Container already has a frontend configured"
  - "Port {port} is not exposed by container"

#### **3. Hostname Validation**
- **Check:** Hostname is valid DNS format (regex)
- **Check:** Hostname is not already used by another frontend in same environment
- **Check:** Hostname is not reserved (localhost, 127.0.0.1, etc.)
- **Error Messages:**
  - "Invalid hostname format"
  - "Hostname already in use by {existingFrontend}"
  - "Reserved hostname cannot be used"

#### **4. SSL Certificate Validation (if enabled)**
- **Check:** Certificate exists in database
- **Check:** Certificate status is "ACTIVE"
- **Check:** Certificate is accessible in Azure Key Vault
- **Check:** Certificate matches hostname (CN or SAN)
- **Error Messages:**
  - "Certificate not found"
  - "Certificate is not active (status: {status})"
  - "Certificate not found in Key Vault"
  - "Certificate does not match hostname"

### Post-Creation Validation

#### **5. Connectivity Validation**
- **Check:** Backend server responds to health checks
- **Check:** Frontend routing works (hostname → backend)
- **Check:** SSL handshake succeeds (if enabled)
- **Warning Messages:**
  - "Backend health check failing - container may not be ready"
  - "Frontend created but routing not yet validated"
  - "SSL certificate deployed but handshake failing"

### Runtime Validation

#### **6. Container Monitoring**
- **Check:** Container still exists and running (periodic check)
- **Check:** Container still on HAProxy network
- **Action:** Mark frontend as `failed` if container is stopped or removed
- **Action:** Show warning in UI if container network changes

---

## API Design

### New Endpoints

#### **GET /api/haproxy/manual-frontends/containers**
- **Purpose:** List available containers for manual frontend creation
- **Query Params:**
  - `environmentId` (required) - Filter by environment
  - `includeNetworks` (boolean) - Include network details
- **Response:** List of eligible containers
  ```typescript
  {
    containers: Array<{
      id: string;
      name: string;
      image: string;
      state: string;
      networks: string[];
      labels: Record<string, string>;
      ports: Array<{ containerPort: number; protocol: string }>;
      canConnect: boolean; // On HAProxy network?
      reason?: string; // Why can't connect if false
    }>;
    haproxyNetwork: string;
  }
  ```

#### **POST /api/haproxy/manual-frontends**
- **Purpose:** Create manual frontend
- **Request Body:**
  ```typescript
  {
    environmentId: string;
    containerId: string;
    containerName: string;
    containerPort: number;
    hostname: string;
    enableSsl?: boolean;
    tlsCertificateId?: string;
    healthCheckPath?: string;
  }
  ```
- **Validation:** All pre-creation checks
- **Response:** Created frontend record
- **Status Codes:**
  - 201: Created successfully
  - 400: Validation error
  - 404: Environment/Container not found
  - 409: Hostname already in use

#### **GET /api/haproxy/frontends**
- **Enhancement:** Add query param `type` (deployment | manual | all)
- **Enhancement:** Include `frontendType` in response

#### **GET /api/haproxy/frontends/:frontendName**
- **Enhancement:** Include container details for manual frontends
- **Enhancement:** Include `frontendType` and manual-specific fields

#### **DELETE /api/haproxy/manual-frontends/:frontendName**
- **Purpose:** Delete manual frontend
- **Validation:** Only allow deletion of `frontendType = "manual"`
- **Process:**
  1. Remove frontend from HAProxy
  2. Remove backend from HAProxy
  3. Delete database record
- **Response:** Success message
- **Status Codes:**
  - 200: Deleted successfully
  - 403: Cannot delete deployment frontend
  - 404: Frontend not found

#### **PUT /api/haproxy/manual-frontends/:frontendName**
- **Purpose:** Update manual frontend configuration
- **Allowed Changes:**
  - Hostname (requires HAProxy re-configuration)
  - SSL settings (certificate, enable/disable)
  - Health check path
- **Not Allowed:**
  - Container (must delete and recreate)
  - Environment (must delete and recreate)
- **Response:** Updated frontend record

---

## Service Layer Design

### New Service: ManualFrontendManager

**Location:** `server/src/services/haproxy/manual-frontend-manager.ts`

**Responsibilities:**
- Validate container eligibility
- Create manual frontends
- Update manual frontend configuration
- Delete manual frontends
- Monitor container health

**Key Methods:**

#### `getEligibleContainers(environmentId: string)`
- Fetch HAProxy environment context
- List all running containers
- Filter by network compatibility
- Return containers with eligibility status

#### `createManualFrontend(options: ManualFrontendOptions)`
- Validate environment, container, hostname
- Create backend in HAProxy (container IP:port as server)
- Create frontend in HAProxy (hostname routing)
- Deploy SSL certificate if enabled
- Create database record (`frontendType = "manual"`)
- Return created frontend

#### `deleteManualFrontend(frontendName: string)`
- Verify frontend is manual type
- Remove frontend from HAProxy
- Remove backend from HAProxy
- Delete database record

#### `updateManualFrontend(frontendName: string, updates: Partial<ManualFrontendOptions>)`
- Validate updates
- Apply changes to HAProxy configuration
- Update database record

#### `validateContainer(containerId: string, environmentId: string)`
- Check container exists and running
- Check network compatibility
- Check port accessibility
- Return validation result with details

### Enhanced Service: HAProxyFrontendManager

**Enhancements:**
- Handle both deployment and manual frontends
- Check `frontendType` before operations
- Provide type-specific error messages

---

## High-Level Pages Required

### 1. **Manual Frontend Creation Page**
- **Route:** `/haproxy/frontends/new/manual`
- **Components:**
  - Environment selector
  - Container selector with network validation badges
  - Frontend configuration form
  - Validation feedback display
  - Preview of HAProxy configuration
  - Creation progress stepper
  - Success/error confirmation

### 2. **Enhanced Frontends List Page**
- **Route:** `/haproxy/frontends`
- **Enhancements:**
  - Type filter (All | Deployment | Manual)
  - Type badge in row display
  - Source indicator (deployment name or container name)
  - "Connect Container" action button
  - Delete action (manual frontends only)

### 3. **Frontend Details Page**
- **Route:** `/haproxy/frontends/:frontendName`
- **Enhancements:**
  - Display frontend type prominently
  - Show deployment details OR container details based on type
  - Show "Edit" button for manual frontends only
  - Show "Delete" button for manual frontends only
  - Display network information
  - Display backend server health

### 4. **Manual Frontend Edit Page**
- **Route:** `/haproxy/frontends/:frontendName/edit`
- **Features:**
  - Update hostname
  - Update SSL settings
  - Update health check configuration
  - Cannot change container or environment

---

## Implementation Phases

### **Phase 1: Core Functionality** (MVP)
1. Database schema migration (make `deploymentConfigId` optional)
2. Backend validation service (container eligibility)
3. Manual frontend manager service
4. API endpoints (create, list, delete)
5. Network validation

**Deliverables:**
- Users can create manual frontends via API
- Basic UI for manual frontend creation
- Container network validation
- Manual frontend listing

### **Phase 2: Enhanced UI & Management**
1. Frontend details page and frontend list page
2. Edit functionality for manual frontends
3. Container monitoring and health status
4. Better error messages and validation feedback
5. Frontend preview before creation

**Deliverables:**
- Full UI for managing manual frontends
- Edit existing manual frontends
- Real-time container health monitoring
- Improved user experience

### **Phase 3: Advanced Features**
1. Port auto-detection from container
2. Batch frontend creation (multiple containers)
3. Template-based configuration
4. DNS integration for manual frontends
5. Metrics and monitoring dashboard

**Deliverables:**
- Advanced automation features
- DNS management
- Monitoring and analytics

---

## Edge Cases & Considerations

### Container Lifecycle Management

**Scenario:** Container is stopped or removed after frontend creation
- **Detection:** Periodic health checks in background job
- **Action:** Mark frontend as `failed` with error message
- **User Action:** Frontend remains in database, user can delete when ready
- **Alternative:** Auto-cleanup option in settings

### Network Changes

**Scenario:** Container is disconnected from HAProxy network
- **Detection:** Network validation check fails
- **Action:** Frontend marked as `failed`, error message shows network issue
- **User Action:** Reconnect container to network or delete frontend

### Hostname Conflicts

**Scenario:** User tries to create frontend with existing hostname
- **Prevention:** Pre-creation validation checks for hostname uniqueness
- **Scope:** Check within same environment only (different environments can reuse)
- **Error:** Clear message showing which frontend is using the hostname

### SSL Certificate Expiration

**Scenario:** Certificate expires while manual frontend is active
- **Detection:** Certificate monitoring job (existing system)
- **Action:** Warning notification, frontend continues with expired cert
- **User Action:** Update certificate via edit page

### HAProxy Restart

**Scenario:** HAProxy container is restarted or recreated
- **Impact:** Frontends and backends are lost from HAProxy memory
- **Recovery:** Sync job should recreate all frontends from database
- **Consideration:** Add "sync all frontends" action in UI

### Migration from Manual to Deployment

**Scenario:** User wants to migrate manual frontend to deployment system
- **Approach:** No automatic migration - user must create deployment config
- **Workflow:**
  1. Note current manual frontend settings
  2. Create deployment configuration with same hostname
  3. Deploy via deployment system
  4. Delete manual frontend once deployment is active
- **Future Enhancement:** Migration wizard

---

**Implementation Effort:**
- **Phase 1 (MVP):** ~2-3 weeks (schema, services, basic API, minimal UI)
- **Phase 2 (Enhanced):** ~1-2 weeks (full UI, editing, monitoring)
- **Phase 3 (Advanced):** ~2-3 weeks (automation, DNS, metrics)


