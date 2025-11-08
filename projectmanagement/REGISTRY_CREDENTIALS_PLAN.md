# Registry Credentials Implementation Plan

## Overview

This document outlines the plan to implement first-class support for Docker registry credentials in Mini Infra. The new system will replace the current settings-based approach with a dedicated table and service layer, providing automatic authentication for all Docker operations including pulls, runs, and deployments.

## Current State Analysis

### Existing Implementation

**Storage Mechanism**: SystemSettings table with key-value pairs
- `backup_registry_username` (category: `system`)
- `backup_registry_password` (category: `system`, encrypted)
- `restore_registry_username` (category: `system`)
- `restore_registry_password` (category: `system`, encrypted)

**Current Usage**:
- ✅ PostgreSQL backup operations (`BackupExecutorService`)
- ✅ PostgreSQL restore operations (`RestoreExecutorService`)
- ✅ Docker pull with authentication (`DockerExecutorService.pullImageWithAuth()`)
- ❌ **NOT used in deployment operations**
- ❌ **NOT used in general container operations**

**Limitations**:
1. Credentials are scoped to backup/restore only
2. Only supports a single registry per operation type (backup vs restore)
3. No support for multiple registries
4. No registry discovery/matching logic
5. Deployment operations have no authentication support

### Files Currently Using Registry Credentials

1. **Schema**: `server/prisma/schema.prisma` (SystemSettings model)
2. **Services**:
   - `server/src/services/postgres-settings-config.ts` (lines 299-332)
   - `server/src/services/backup-executor.ts` (lines 493-497, 927-955)
   - `server/src/services/restore-executor.ts`
   - `server/src/services/docker-executor.ts` (lines 612-844)
3. **Frontend**: `client/src/app/settings/system/page.tsx` (lines 48-95, 525-665)
4. **API Routes**: `server/src/routes/system-settings.ts` (lines 49-187)

### Files Currently NOT Using Registry Credentials (But Should)

1. `server/src/services/deployment-orchestrator.ts`
2. `server/src/services/haproxy/actions/deploy-application-containers.ts`
3. `server/src/services/container-lifecycle-manager.ts`
4. `server/src/services/docker.ts`

---

## Proposed Solution

### Phase 1: Database Schema Changes

#### 1.1 Create New RegistryCredentials Table

**File**: `server/prisma/schema.prisma`

```prisma
model RegistryCredential {
  id                    String   @id @default(cuid())
  name                  String   // Friendly name (e.g., "GitHub Container Registry", "Docker Hub Production")
  registryUrl           String   // Registry address (e.g., "ghcr.io", "registry.hub.docker.com")
  username              String   // Registry username
  password              String   // Encrypted password
  isDefault             Boolean  @default(false) // Default registry for unmatched images
  isActive              Boolean  @default(true)  // Enable/disable without deletion

  // Metadata
  description           String?  // Optional description
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  createdBy             String   // User ID
  updatedBy             String   // User ID

  // Validation tracking
  lastValidatedAt       DateTime?
  validationStatus      String?  // 'valid', 'invalid', 'pending', 'error'
  validationMessage     String?

  @@unique([registryUrl])
  @@map("registry_credentials")
}
```

**Key Design Decisions**:
- **`registryUrl`** is unique - one credential set per registry
- **`isDefault`** flag allows marking a fallback registry
- **`password`** will be encrypted using the existing encryption utilities
- **Validation tracking** mirrors SystemSettings pattern for consistency
- **Soft delete** via `isActive` rather than hard delete

#### 1.2 Update Shared Types

**File**: `lib/types/registry.ts` (new file)

```typescript
export interface RegistryCredential {
  id: string;
  name: string;
  registryUrl: string;
  username: string;
  password: string; // Will be encrypted in DB, decrypted in memory
  isDefault: boolean;
  isActive: boolean;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  lastValidatedAt?: Date;
  validationStatus?: 'valid' | 'invalid' | 'pending' | 'error';
  validationMessage?: string;
}

export interface CreateRegistryCredentialRequest {
  name: string;
  registryUrl: string;
  username: string;
  password: string;
  isDefault?: boolean;
  isActive?: boolean;
  description?: string;
}

export interface UpdateRegistryCredentialRequest {
  name?: string;
  username?: string;
  password?: string;
  isDefault?: boolean;
  isActive?: boolean;
  description?: string;
}

export interface RegistryCredentialResponse {
  id: string;
  name: string;
  registryUrl: string;
  username: string;
  password?: string; // Optional - only included when explicitly requested
  isDefault: boolean;
  isActive: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  validationStatus?: string;
  validationMessage?: string;
}

export interface RegistryTestResult {
  success: boolean;
  message: string;
  registryUrl: string;
  pullTimeMs?: number;
  error?: string;
}
```

**File**: `lib/types/index.ts`

```typescript
// Add to exports
export * from './registry';
```

---

### Phase 2: Backend Service Layer

#### 2.1 Create RegistryCredentialService

**File**: `server/src/services/registry-credential.ts` (new file)

**Responsibilities**:
1. CRUD operations for registry credentials
2. Password encryption/decryption using existing crypto utilities
3. Registry URL matching logic (determine which credentials to use for a given image)
4. Default registry handling
5. Credential validation via test pull

**Key Methods**:
```typescript
class RegistryCredentialService {
  // CRUD
  async createCredential(data: CreateRegistryCredentialRequest, userId: string): Promise<RegistryCredential>
  async getCredential(id: string): Promise<RegistryCredential | null>
  async getAllCredentials(includeInactive?: boolean): Promise<RegistryCredential[]>
  async updateCredential(id: string, data: UpdateRegistryCredentialRequest, userId: string): Promise<RegistryCredential>
  async deleteCredential(id: string): Promise<void>
  async setDefaultCredential(id: string): Promise<void>

  // Credential matching
  async getCredentialsForImage(imageName: string): Promise<{ username: string; password: string } | null>
  async getDefaultCredential(): Promise<RegistryCredential | null>

  // Validation
  async validateCredential(id: string): Promise<RegistryTestResult>
  async testCredential(registryUrl: string, username: string, password: string, testImage?: string): Promise<RegistryTestResult>
}
```

**Registry URL Matching Logic**:
```typescript
/**
 * Extracts registry URL from Docker image name
 * Examples:
 * - "ghcr.io/owner/repo:tag" -> "ghcr.io"
 * - "registry.hub.docker.com/library/postgres:13" -> "registry.hub.docker.com"
 * - "postgres:13" -> "registry.hub.docker.com" (Docker Hub default)
 * - "localhost:5000/image:tag" -> "localhost:5000"
 */
private extractRegistryFromImage(imageName: string): string {
  // Implementation details
}

async getCredentialsForImage(imageName: string): Promise<{ username: string; password: string } | null> {
  // 1. Extract registry URL from image name
  const registryUrl = this.extractRegistryFromImage(imageName);

  // 2. Find exact match in database
  const credential = await prisma.registryCredential.findFirst({
    where: {
      registryUrl,
      isActive: true
    }
  });

  if (credential) {
    return {
      username: credential.username,
      password: decryptValue(credential.password)
    };
  }

  // 3. Fall back to default credential if configured
  const defaultCredential = await this.getDefaultCredential();
  if (defaultCredential) {
    return {
      username: defaultCredential.username,
      password: decryptValue(defaultCredential.password)
    };
  }

  // 4. No credentials found
  return null;
}
```

#### 2.2 Update DockerExecutorService

**File**: `server/src/services/docker-executor.ts`

**Changes**:
1. Inject `RegistryCredentialService` dependency
2. Update `pullImageWithAuth()` to optionally auto-resolve credentials
3. Add new method `pullImageWithAutoAuth()` that automatically finds credentials

```typescript
class DockerExecutorService {
  constructor(
    private docker: Docker,
    private registryCredentialService: RegistryCredentialService
  ) {}

  /**
   * Pull image with automatic credential resolution
   */
  async pullImageWithAutoAuth(image: string): Promise<void> {
    const credentials = await this.registryCredentialService.getCredentialsForImage(image);

    if (credentials) {
      return this.pullImageWithAuth(image, credentials.username, credentials.password);
    } else {
      // No credentials - attempt anonymous pull
      return this.pullImageWithAuth(image);
    }
  }

  // Keep existing pullImageWithAuth() method for backward compatibility
  async pullImageWithAuth(
    image: string,
    registryUsername?: string,
    registryPassword?: string,
  ): Promise<void> {
    // Existing implementation unchanged
  }
}
```

#### 2.3 Update ContainerLifecycleManager

**File**: `server/src/services/container-lifecycle-manager.ts`

**Changes**:
1. Add image pull step before container creation
2. Use `DockerExecutorService.pullImageWithAutoAuth()`

```typescript
class ContainerLifecycleManager {
  constructor(
    private docker: Docker,
    private dockerExecutor: DockerExecutorService
  ) {}

  async createContainer(
    options: CreateContainerOptions
  ): Promise<Container> {
    // NEW: Pull image with automatic authentication
    this.logger.info(`Pulling image ${options.image} with automatic registry authentication`);
    await this.dockerExecutor.pullImageWithAutoAuth(options.image);

    // Existing container creation logic
    const container = await this.docker.createContainer({
      Image: options.image,
      name: options.name,
      // ... rest of config
    });

    return container;
  }
}
```

#### 2.4 Update DeployApplicationContainers Action

**File**: `server/src/services/haproxy/actions/deploy-application-containers.ts`

**Changes**:
1. No direct changes needed - relies on `ContainerLifecycleManager`
2. The pull logic in `ContainerLifecycleManager` will automatically apply

#### 2.5 Update BackupExecutorService

**File**: `server/src/services/backup-executor.ts`

**Changes**:
1. Replace `getBackupRegistryCredentials()` with `registryCredentialService.getCredentialsForImage()`
2. Simplify logic - no need for separate backup-specific credentials

```typescript
// BEFORE (lines 493-497, 927-955)
const registryCredentials = await this.getBackupRegistryCredentials();
const { username, password } = registryCredentials;
await this.dockerExecutor.pullImageWithAuth(image, username, password);

// AFTER
await this.dockerExecutor.pullImageWithAutoAuth(image);
```

**Delete**:
- `getBackupRegistryCredentials()` method (lines 927-955)

#### 2.6 Update RestoreExecutorService

**File**: `server/src/services/restore-executor.ts`

**Changes**:
- Same pattern as BackupExecutorService
- Replace restore-specific credential retrieval with auto-auth

#### 2.7 Update PostgresSettingsConfigService

**File**: `server/src/services/postgres-settings-config.ts`

**Changes**:
- **Delete** `getBackupRegistryCredentials()` (lines 299-314)
- **Delete** `getRestoreRegistryCredentials()` (lines 316-332)

---

### Phase 3: API Routes

#### 3.1 Create Registry Credentials Routes

**File**: `server/src/routes/registry-credentials.ts` (new file)

```typescript
import express from "express";
import { z } from "zod";
import { requireSessionOrApiKey, getCurrentUserId } from "../middleware/auth";
import { RegistryCredentialService } from "../services/registry-credential";
import { appLogger } from "../lib/logger-factory";

const logger = appLogger();
const router = express.Router();
const registryCredentialService = new RegistryCredentialService();

// Validation schemas
const createSchema = z.object({
  name: z.string().min(1),
  registryUrl: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional()
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional()
});

// GET /api/registry-credentials
router.get('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const credentials = await registryCredentialService.getAllCredentials(includeInactive);

    // Don't send passwords to frontend by default
    const sanitized = credentials.map(cred => ({
      ...cred,
      password: undefined
    }));

    res.json({ success: true, data: sanitized });
  } catch (error) {
    logger.error({ error }, "Failed to fetch registry credentials");
    res.status(500).json({ success: false, error: "Failed to fetch credentials" });
  }
});

// GET /api/registry-credentials/:id
router.get('/:id', requireSessionOrApiKey, async (req, res) => {
  try {
    const credential = await registryCredentialService.getCredential(req.params.id);

    if (!credential) {
      return res.status(404).json({ success: false, error: "Credential not found" });
    }

    // Don't send password
    res.json({
      success: true,
      data: { ...credential, password: undefined }
    });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "Failed to fetch credential");
    res.status(500).json({ success: false, error: "Failed to fetch credential" });
  }
});

// POST /api/registry-credentials
router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const validatedData = createSchema.parse(req.body);
    const userId = getCurrentUserId(req);

    const credential = await registryCredentialService.createCredential(validatedData, userId);

    res.status(201).json({
      success: true,
      data: { ...credential, password: undefined }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: "Validation failed", details: error.errors });
    }
    logger.error({ error }, "Failed to create registry credential");
    res.status(500).json({ success: false, error: "Failed to create credential" });
  }
});

// PUT /api/registry-credentials/:id
router.put('/:id', requireSessionOrApiKey, async (req, res) => {
  try {
    const validatedData = updateSchema.parse(req.body);
    const userId = getCurrentUserId(req);

    const credential = await registryCredentialService.updateCredential(
      req.params.id,
      validatedData,
      userId
    );

    res.json({
      success: true,
      data: { ...credential, password: undefined }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: "Validation failed", details: error.errors });
    }
    logger.error({ error, id: req.params.id }, "Failed to update credential");
    res.status(500).json({ success: false, error: "Failed to update credential" });
  }
});

// DELETE /api/registry-credentials/:id
router.delete('/:id', requireSessionOrApiKey, async (req, res) => {
  try {
    await registryCredentialService.deleteCredential(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "Failed to delete credential");
    res.status(500).json({ success: false, error: "Failed to delete credential" });
  }
});

// POST /api/registry-credentials/:id/set-default
router.post('/:id/set-default', requireSessionOrApiKey, async (req, res) => {
  try {
    await registryCredentialService.setDefaultCredential(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "Failed to set default credential");
    res.status(500).json({ success: false, error: "Failed to set default credential" });
  }
});

// POST /api/registry-credentials/:id/test
router.post('/:id/test', requireSessionOrApiKey, async (req, res) => {
  try {
    const result = await registryCredentialService.validateCredential(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "Failed to test credential");
    res.status(500).json({ success: false, error: "Failed to test credential" });
  }
});

// POST /api/registry-credentials/test-connection
router.post('/test-connection', requireSessionOrApiKey, async (req, res) => {
  try {
    const testSchema = z.object({
      registryUrl: z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(1),
      testImage: z.string().optional()
    });

    const validatedData = testSchema.parse(req.body);

    const result = await registryCredentialService.testCredential(
      validatedData.registryUrl,
      validatedData.username,
      validatedData.password,
      validatedData.testImage
    );

    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: "Validation failed", details: error.errors });
    }
    logger.error({ error }, "Failed to test registry connection");
    res.status(500).json({ success: false, error: "Failed to test connection" });
  }
});

export default router;
```

#### 3.2 Update App Routes Registration

**File**: `server/src/app.ts`

```typescript
// Add import
import registryCredentialsRoutes from "./routes/registry-credentials";

// Register route
app.use("/api/registry-credentials", registryCredentialsRoutes);
```

#### 3.3 Deprecate Old System Settings Routes

**File**: `server/src/routes/system-settings.ts`

**Changes**:
- Keep existing routes for backward compatibility during migration
- Add deprecation warnings in logs
- Eventually remove after migration complete

---

### Phase 4: Frontend Implementation

#### 4.1 Create Registry Credentials Management Page

**File**: `client/src/app/settings/registry-credentials/page.tsx` (new file)

**Features**:
1. List all registry credentials in a table
2. Add new credential form/dialog
3. Edit existing credentials
4. Delete credentials (with confirmation)
5. Set default registry
6. Test connection button per credential
7. Active/inactive toggle
8. Password visibility toggle (eye icon)

**UI Components**:
- Data table with sortable columns (name, registry URL, username, status)
- Add button (opens dialog)
- Edit button per row (opens dialog)
- Delete button per row (confirmation dialog)
- "Set as Default" button per row
- "Test Connection" button per row
- Status badge (active/inactive, validation status)

**Form Fields**:
```typescript
const credentialSchema = z.object({
  name: z.string().min(1, "Name is required"),
  registryUrl: z.string().min(1, "Registry URL is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: z.string().optional()
});
```

#### 4.2 Create API Hooks

**File**: `client/src/hooks/use-registry-credentials.ts` (new file)

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  RegistryCredential,
  CreateRegistryCredentialRequest,
  UpdateRegistryCredentialRequest,
  RegistryTestResult
} from '@mini-infra/types';

export function useRegistryCredentials(includeInactive = false) {
  return useQuery({
    queryKey: ['registry-credentials', includeInactive],
    queryFn: async () => {
      const res = await fetch(`/api/registry-credentials?includeInactive=${includeInactive}`);
      const data = await res.json();
      return data.data as RegistryCredential[];
    }
  });
}

export function useRegistryCredential(id: string) {
  return useQuery({
    queryKey: ['registry-credentials', id],
    queryFn: async () => {
      const res = await fetch(`/api/registry-credentials/${id}`);
      const data = await res.json();
      return data.data as RegistryCredential;
    },
    enabled: !!id
  });
}

export function useCreateRegistryCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateRegistryCredentialRequest) => {
      const res = await fetch('/api/registry-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['registry-credentials'] });
    }
  });
}

export function useUpdateRegistryCredential(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateRegistryCredentialRequest) => {
      const res = await fetch(`/api/registry-credentials/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['registry-credentials'] });
    }
  });
}

export function useDeleteRegistryCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/registry-credentials/${id}`, {
        method: 'DELETE'
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['registry-credentials'] });
    }
  });
}

export function useSetDefaultCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/registry-credentials/${id}/set-default`, {
        method: 'POST'
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['registry-credentials'] });
    }
  });
}

export function useTestRegistryCredential() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/registry-credentials/${id}/test`, {
        method: 'POST'
      });
      const data = await res.json();
      return data.data as RegistryTestResult;
    }
  });
}

export function useTestRegistryConnection() {
  return useMutation({
    mutationFn: async (params: {
      registryUrl: string;
      username: string;
      password: string;
      testImage?: string;
    }) => {
      const res = await fetch('/api/registry-credentials/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      const data = await res.json();
      return data.data as RegistryTestResult;
    }
  });
}
```

#### 4.3 Update Settings Navigation

**File**: `client/src/app/settings/layout.tsx` (or navigation component)

**Changes**:
- Add "Registry Credentials" link to settings sidebar/navigation
- Position it prominently (e.g., between "System Settings" and "User Settings")

#### 4.4 Remove Old Registry Fields from System Settings

**File**: `client/src/app/settings/system/page.tsx`

**Changes**:
1. Remove from schema (lines 48-95):
   - `backupRegistryUsername`
   - `backupRegistryPassword`
   - `restoreRegistryUsername`
   - `restoreRegistryPassword`

2. Remove form fields (lines 525-665):
   - Backup registry username input
   - Backup registry password input
   - Restore registry username input
   - Restore registry password input
   - Test connection buttons for backup/restore registries

3. Remove from save logic (lines 243-244, 260-261):
   - Encryption logic for registry passwords
   - Setting updates for registry credentials

4. Add migration notice:
   - Display a notice explaining that registry credentials have moved to dedicated page
   - Provide link to new Registry Credentials page

---

### Phase 5: Database Migration

#### 5.1 Create Migration Script

**File**: `server/prisma/migrations/YYYYMMDDHHMMSS_add_registry_credentials_table/migration.sql`

```sql
-- CreateTable
CREATE TABLE "registry_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "registryUrl" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "lastValidatedAt" DATETIME,
    "validationStatus" TEXT,
    "validationMessage" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "registry_credentials_registryUrl_key" ON "registry_credentials"("registryUrl");
```

#### 5.2 Create Data Migration Script

**File**: `server/src/scripts/migrate-registry-credentials.ts` (new file)

**Purpose**: Migrate existing backup/restore credentials to new table

```typescript
import prisma from "../lib/prisma";
import { encryptValue, decryptValue } from "../lib/crypto";

async function migrateRegistryCredentials() {
  console.log("Starting registry credentials migration...");

  // Get existing backup credentials
  const backupUsername = await prisma.systemSettings.findUnique({
    where: { category_key: { category: 'system', key: 'backup_registry_username' } }
  });

  const backupPassword = await prisma.systemSettings.findUnique({
    where: { category_key: { category: 'system', key: 'backup_registry_password' } }
  });

  // Get existing restore credentials
  const restoreUsername = await prisma.systemSettings.findUnique({
    where: { category_key: { category: 'system', key: 'restore_registry_username' } }
  });

  const restorePassword = await prisma.systemSettings.findUnique({
    where: { category_key: { category: 'system', key: 'restore_registry_password' } }
  });

  // Get backup image to extract registry URL
  const backupImage = await prisma.systemSettings.findUnique({
    where: { category_key: { category: 'system', key: 'backup_docker_image' } }
  });

  const restoreImage = await prisma.systemSettings.findUnique({
    where: { category_key: { category: 'system', key: 'restore_docker_image' } }
  });

  // Helper to extract registry from image
  function extractRegistry(imageName?: string): string {
    if (!imageName) return 'registry.hub.docker.com';
    const parts = imageName.split('/');
    if (parts.length > 2 || parts[0].includes('.') || parts[0].includes(':')) {
      return parts[0];
    }
    return 'registry.hub.docker.com';
  }

  const migrations: Array<{
    name: string;
    registryUrl: string;
    username: string;
    password: string;
  }> = [];

  // Migrate backup credentials
  if (backupUsername?.value && backupPassword?.value) {
    const registryUrl = extractRegistry(backupImage?.value);
    migrations.push({
      name: 'Backup Registry (Migrated)',
      registryUrl,
      username: backupUsername.value,
      password: backupPassword.value // Already encrypted
    });
  }

  // Migrate restore credentials
  if (restoreUsername?.value && restorePassword?.value) {
    const registryUrl = extractRegistry(restoreImage?.value);

    // Check if same registry as backup
    const existingMigration = migrations.find(m => m.registryUrl === registryUrl);

    if (!existingMigration) {
      migrations.push({
        name: 'Restore Registry (Migrated)',
        registryUrl,
        username: restoreUsername.value,
        password: restorePassword.value // Already encrypted
      });
    } else if (
      existingMigration.username !== restoreUsername.value ||
      existingMigration.password !== restorePassword.value
    ) {
      console.warn(`Backup and restore have different credentials for ${registryUrl}`);
      console.warn("Using backup credentials. Please review and update manually if needed.");
    }
  }

  // Get system user for createdBy/updatedBy
  const systemUser = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' }
  });

  if (!systemUser) {
    console.error("No users found in database. Cannot migrate credentials.");
    return;
  }

  // Create new registry credentials
  for (const migration of migrations) {
    const existing = await prisma.registryCredential.findUnique({
      where: { registryUrl: migration.registryUrl }
    });

    if (existing) {
      console.log(`Registry credential for ${migration.registryUrl} already exists. Skipping.`);
      continue;
    }

    await prisma.registryCredential.create({
      data: {
        name: migration.name,
        registryUrl: migration.registryUrl,
        username: migration.username,
        password: migration.password,
        isDefault: migrations.indexOf(migration) === 0, // First one is default
        isActive: true,
        createdBy: systemUser.id,
        updatedBy: systemUser.id
      }
    });

    console.log(`Migrated credentials for ${migration.registryUrl}`);
  }

  // Optional: Delete old settings after confirmation
  console.log("\nMigration complete!");
  console.log("Old settings have NOT been deleted automatically.");
  console.log("After verifying the migration, you can safely delete:");
  console.log("  - backup_registry_username");
  console.log("  - backup_registry_password");
  console.log("  - restore_registry_username");
  console.log("  - restore_registry_password");
}

migrateRegistryCredentials()
  .then(() => {
    console.log("Migration script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
```

**File**: `server/package.json`

```json
{
  "scripts": {
    "migrate:registry-creds": "tsx src/scripts/migrate-registry-credentials.ts"
  }
}
```

#### 5.3 Cleanup Old Settings (Post-Migration)

**Manual Step**: After verifying migration success, delete old settings:

```sql
DELETE FROM system_settings WHERE key IN (
  'backup_registry_username',
  'backup_registry_password',
  'restore_registry_username',
  'restore_registry_password'
);
```

---

## Implementation Phases

### Phase 1: Foundation (Backend Schema & Service)
**Estimated Effort**: 2-3 days

1. ✅ Update Prisma schema with `RegistryCredential` model
2. ✅ Create shared types in `lib/types/registry.ts`
3. ✅ Run `npx prisma migrate dev` to create migration
4. ✅ Create `RegistryCredentialService` with all CRUD methods
5. ✅ Implement registry URL matching logic
6. ✅ Implement password encryption/decryption
7. ✅ Write unit tests for service layer
8. ✅ Build shared types: `cd lib && npm run build`

**Validation**:
- [ ] Schema migrated successfully
- [ ] Service can create/read/update/delete credentials
- [ ] Password encryption works correctly
- [ ] Registry URL matching logic works for common patterns
- [ ] All tests pass

---

### Phase 2: API Layer
**Estimated Effort**: 1-2 days

1. ✅ Create `server/src/routes/registry-credentials.ts`
2. ✅ Implement all CRUD endpoints
3. ✅ Implement test connection endpoint
4. ✅ Register routes in `server/src/app.ts`
5. ✅ Write API integration tests
6. ✅ Test with Postman/curl

**Validation**:
- [ ] All endpoints return correct responses
- [ ] Authentication middleware works
- [ ] Validation schemas catch invalid input
- [ ] Passwords are never returned in responses
- [ ] Test connection endpoint works correctly

---

### Phase 3: Docker Integration
**Estimated Effort**: 2-3 days

1. ✅ Update `DockerExecutorService`:
   - Add `RegistryCredentialService` dependency
   - Create `pullImageWithAutoAuth()` method
2. ✅ Update `ContainerLifecycleManager`:
   - Add `DockerExecutorService` dependency
   - Add pull step before container creation
3. ✅ Update `BackupExecutorService`:
   - Remove `getBackupRegistryCredentials()`
   - Use `pullImageWithAutoAuth()`
4. ✅ Update `RestoreExecutorService`:
   - Remove restore-specific credential logic
   - Use `pullImageWithAutoAuth()`
5. ✅ Update `PostgresSettingsConfigService`:
   - Remove deprecated methods
6. ✅ Write integration tests for deployment flow
7. ✅ Test backup/restore operations

**Validation**:
- [ ] Deployments can pull private images
- [ ] Backups work with new credential system
- [ ] Restores work with new credential system
- [ ] Error handling for missing/invalid credentials
- [ ] Logs show credential resolution process

---

### Phase 4: Frontend Implementation
**Estimated Effort**: 3-4 days

1. ✅ Create `client/src/hooks/use-registry-credentials.ts`
2. ✅ Create `client/src/app/settings/registry-credentials/page.tsx`
3. ✅ Implement data table with all credentials
4. ✅ Implement add/edit dialogs
5. ✅ Implement delete confirmation
6. ✅ Implement test connection functionality
7. ✅ Implement set default functionality
8. ✅ Update settings navigation
9. ✅ Remove old fields from system settings page
10. ✅ Add migration notice to system settings

**Validation**:
- [ ] Can create new credentials via UI
- [ ] Can edit existing credentials
- [ ] Can delete credentials (with confirmation)
- [ ] Can set default credential
- [ ] Can test connection for each credential
- [ ] Validation errors display correctly
- [ ] Success/error toasts work
- [ ] Password visibility toggle works
- [ ] Active/inactive toggle works

---

### Phase 5: Data Migration & Cleanup
**Estimated Effort**: 1 day

1. ✅ Create migration script `migrate-registry-credentials.ts`
2. ✅ Test migration on development database
3. ✅ Document migration process
4. ✅ Run migration in production
5. ✅ Verify migrated data
6. ✅ Delete old settings from database
7. ✅ Update documentation

**Validation**:
- [ ] Existing backup credentials migrated correctly
- [ ] Existing restore credentials migrated correctly
- [ ] No data loss during migration
- [ ] Old settings cleaned up
- [ ] Backup/restore operations still work

---

## Testing Strategy

### Unit Tests

**Registry Credential Service** (`server/src/__tests__/registry-credential.test.ts`):
- ✅ Create credential
- ✅ Get credential by ID
- ✅ Get all credentials
- ✅ Update credential
- ✅ Delete credential
- ✅ Set default credential (unsets previous default)
- ✅ Extract registry URL from image name
- ✅ Get credentials for image (exact match)
- ✅ Get credentials for image (default fallback)
- ✅ Get credentials for image (no credentials)
- ✅ Password encryption/decryption

**Docker Executor Service** (`server/src/__tests__/docker-executor.test.ts`):
- ✅ Pull image with auto-auth (credentials found)
- ✅ Pull image with auto-auth (no credentials)
- ✅ Pull image with auto-auth (default credentials)

### Integration Tests

**API Routes** (`server/src/__tests__/registry-credentials-api.test.ts`):
- ✅ POST /api/registry-credentials (create)
- ✅ GET /api/registry-credentials (list)
- ✅ GET /api/registry-credentials/:id (get one)
- ✅ PUT /api/registry-credentials/:id (update)
- ✅ DELETE /api/registry-credentials/:id (delete)
- ✅ POST /api/registry-credentials/:id/set-default
- ✅ POST /api/registry-credentials/:id/test
- ✅ POST /api/registry-credentials/test-connection

**Deployment Flow** (`server/src/__tests__/deployment-with-registry.test.ts`):
- ✅ Deploy with private registry (credentials exist)
- ✅ Deploy with private registry (credentials missing)
- ✅ Deploy with public registry (no credentials needed)

**Backup/Restore Flow** (`server/src/__tests__/backup-restore-with-registry.test.ts`):
- ✅ Backup with private registry
- ✅ Restore with private registry

### Manual Testing Checklist

- [ ] Create credential via UI
- [ ] Edit credential via UI
- [ ] Delete credential via UI
- [ ] Set default credential via UI
- [ ] Test connection via UI (success)
- [ ] Test connection via UI (failure)
- [ ] Deploy container with private registry
- [ ] Run backup with private registry
- [ ] Run restore with private registry
- [ ] Verify error messages when credentials missing
- [ ] Verify error messages when credentials invalid
- [ ] Verify logs show credential resolution

---

## Rollback Strategy

If issues arise during deployment:

### Phase 3 Rollback (Docker Integration Issues)

1. **Revert service changes**:
   ```bash
   git revert <commit-hash>
   ```

2. **Restore old credential methods**:
   - Re-add `getBackupRegistryCredentials()` to `BackupExecutorService`
   - Re-add `getRestoreRegistryCredentials()` to `RestoreExecutorService`

3. **Keep new table and API**:
   - New credential system can coexist with old system
   - Migrate back to old system settings as needed

### Full Rollback

1. **Database rollback**:
   ```bash
   npx prisma migrate rollback
   ```

2. **Code rollback**:
   ```bash
   git revert <range-of-commits>
   ```

3. **Frontend rollback**:
   - Remove registry credentials page
   - Re-add old fields to system settings

---

## Security Considerations

### Password Encryption

- ✅ Use existing `encryptValue()` / `decryptValue()` utilities
- ✅ Store encrypted passwords in database
- ✅ Never log passwords (even encrypted)
- ✅ Never return passwords in API responses (except when explicitly requested)

### API Security

- ✅ All endpoints require `requireSessionOrApiKey` authentication
- ✅ No public access to credentials
- ✅ Validate all input with Zod schemas
- ✅ Sanitize error messages (don't expose internal details)

### Docker Security

- ✅ Only use credentials when necessary (private registries)
- ✅ Log credential usage for audit trail
- ✅ Handle authentication failures gracefully
- ✅ Clear credentials from memory after use

### Migration Security

- ✅ Backup database before migration
- ✅ Test migration on development environment first
- ✅ Verify data integrity after migration
- ✅ Keep old settings until migration verified

---

## Documentation Updates

### Files to Update

1. **README.md**:
   - Add section on Registry Credentials management
   - Document new API endpoints
   - Update Docker deployment section

2. **CLAUDE.md**:
   - Update project structure with new files
   - Document new service layer
   - Update API routes section

3. **API Documentation** (if exists):
   - Document all new endpoints
   - Provide examples for each endpoint
   - Document authentication requirements

4. **User Guide** (if exists):
   - How to add registry credentials
   - How to test connections
   - How to set default registry
   - Troubleshooting authentication issues

---

## Files to Modify - Complete List

### New Files to Create

**Backend**:
1. `lib/types/registry.ts` - Shared TypeScript types
2. `server/src/services/registry-credential.ts` - Service layer
3. `server/src/routes/registry-credentials.ts` - API routes
4. `server/src/scripts/migrate-registry-credentials.ts` - Migration script
5. `server/src/__tests__/registry-credential.test.ts` - Unit tests
6. `server/src/__tests__/registry-credentials-api.test.ts` - Integration tests
7. `server/src/__tests__/deployment-with-registry.test.ts` - Deployment tests
8. `server/src/__tests__/backup-restore-with-registry.test.ts` - Backup/restore tests
9. `server/prisma/migrations/YYYYMMDDHHMMSS_add_registry_credentials_table/migration.sql` - Database migration

**Frontend**:
10. `client/src/hooks/use-registry-credentials.ts` - React Query hooks
11. `client/src/app/settings/registry-credentials/page.tsx` - UI page

### Files to Modify

**Backend**:
1. `server/prisma/schema.prisma` - Add RegistryCredential model
2. `lib/types/index.ts` - Export new registry types
3. `server/src/app.ts` - Register new routes
4. `server/src/services/docker-executor.ts` - Add auto-auth method
5. `server/src/services/container-lifecycle-manager.ts` - Add pull step
6. `server/src/services/backup-executor.ts` - Remove old credential logic
7. `server/src/services/restore-executor.ts` - Remove old credential logic
8. `server/src/services/postgres-settings-config.ts` - Remove deprecated methods
9. `server/package.json` - Add migration script

**Frontend**:
10. `client/src/app/settings/system/page.tsx` - Remove old registry fields
11. `client/src/app/settings/layout.tsx` - Add navigation link (if applicable)

**Documentation**:
12. `README.md` - Document new features
13. `CLAUDE.md` - Update project context
14. `.env.example` - No changes needed (uses existing encryption secrets)

### Files to Eventually Delete (Post-Migration)

**Backend**:
- None (old methods will be removed from existing files)

**Database**:
- SystemSettings records for:
  - `backup_registry_username`
  - `backup_registry_password`
  - `restore_registry_username`
  - `restore_registry_password`

---

## Success Metrics

### Functional Metrics
- [ ] All Docker operations (pull, run, deploy) support private registries
- [ ] Backup/restore operations work with new credential system
- [ ] Multiple registries can be configured simultaneously
- [ ] Default registry fallback works correctly
- [ ] Test connection feature validates credentials

### Performance Metrics
- [ ] No performance degradation in container operations
- [ ] Credential lookup adds <100ms to deployment time
- [ ] Database queries optimized (proper indexes)

### User Experience Metrics
- [ ] Intuitive UI for managing credentials
- [ ] Clear error messages for authentication failures
- [ ] Smooth migration from old system (no user data loss)
- [ ] Documentation is clear and complete

---

## Open Questions & Future Enhancements

### Open Questions
1. **Multi-tenant support**: Should different users have different credentials?
   - Current plan: System-wide credentials (all users share)
   - Future: Per-user or per-team credentials

2. **Credential rotation**: How to handle password changes?
   - Current plan: Manual update via UI
   - Future: Automatic validation and alerts for expired credentials

3. **Private registry caching**: Should we cache pull operations?
   - Current plan: No caching (always pull latest)
   - Future: Configurable pull policy (always, if-not-present, etc.)

### Future Enhancements
1. **OAuth/Token-based authentication**: Support for GitHub PATs, GitLab tokens, etc.
2. **Credential validation scheduling**: Periodic background validation
3. **Audit logging**: Track credential usage and access
4. **Image pull statistics**: Track which images are pulled most frequently
5. **Registry health monitoring**: Automatic connectivity checks
6. **Credential sharing**: Share credentials between environments (dev, staging, prod)
7. **Secrets management integration**: Vault, AWS Secrets Manager, etc.

---

## Timeline Estimate

**Total Estimated Time**: 9-13 days

- Phase 1 (Backend Schema & Service): 2-3 days
- Phase 2 (API Layer): 1-2 days
- Phase 3 (Docker Integration): 2-3 days
- Phase 4 (Frontend): 3-4 days
- Phase 5 (Migration & Cleanup): 1 day

**Contingency**: +20% (2-3 days) for unexpected issues

**Total with Contingency**: 11-16 days

---

## Conclusion

This plan provides a comprehensive roadmap for implementing first-class registry credentials support in Mini Infra. The new system will:

1. ✅ Support multiple registries with individual credentials
2. ✅ Automatically apply credentials to all Docker operations
3. ✅ Provide a better user experience with dedicated UI
4. ✅ Maintain backward compatibility during migration
5. ✅ Improve security with proper encryption and access controls
6. ✅ Enable future enhancements (OAuth, validation, monitoring)

The phased approach ensures each component is thoroughly tested before moving to the next phase, minimizing risk and allowing for early course correction if issues arise.
