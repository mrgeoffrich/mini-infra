# Technical Implementation Plan: Local Environment IP Address Configuration

## Issue Summary
**Title:** Local Network: Define IP address
**Issue Description:** When an environment is created of type local, there should be a field where the user can enter the IP address of that local server. This IP address should get used when DNS is added for containers running on that environment.

## Requirements

1. Add an optional `ipAddress` field to the Environment model for environments where `networkType = 'local'`
2. This IP address should be used when DNS records are created for containers deployed to that environment
3. Display the IP address field in the environment creation/edit forms (only when networkType is 'local')
4. Update all Zod validation schemas to include the new field
5. Update the DNS configuration logic to use the environment-specific IP instead of the global Docker host IP

## Impact Analysis

This change affects multiple packages across the codebase:

### Packages Affected:
1. **lib (shared types)** - Add `ipAddress` to Environment interface
2. **server (backend)** - Database schema, API validation, DNS logic, network utilities
3. **client (frontend)** - Forms, display components, API hooks

### No Changes Required:
- Queue processor (not used in this application)
- Authentication/authorization logic
- Cloudflare integration code (uses the IP provided by DNS manager)
- HAProxy configuration (uses DNS records, not direct IPs)

## Detailed Changes

### 1. Database Schema Changes

#### 1.1 File: `server/prisma/schema.prisma`

**Location:** Environment model definition (around line 150-170)

**Changes Required:**

Add new optional field to the Environment model:

```prisma
model Environment {
  id          String   @id @default(cuid())
  name        String   @unique
  description String?
  type        String   // 'production', 'nonproduction'
  networkType String   @default("local") // 'local', 'internet'
  ipAddress   String?  // IP address for local environments (NEW FIELD)
  status      String   @default("uninitialized")
  isActive    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // Relations
  services    EnvironmentService[]
  networks    EnvironmentNetwork[]
  volumes     EnvironmentVolume[]
  deploymentConfigurations DeploymentConfiguration[]
}
```

**Migration Required:** Yes - run `npx prisma db push` to sync the database

**Field Specifications:**
- Name: `ipAddress`
- Type: `String?` (optional/nullable)
- Purpose: Store the IP address for local environments
- Validation: Will be enforced at application level (IPv4/IPv6 format)

---

### 2. Shared Library Changes

#### 2.1 File: `lib/types/environments.ts`

**Location:** Environment interface definition (around line 30-50)

**Changes Required:**

Add `ipAddress` field to the Environment interface:

```typescript
export interface Environment {
  id: string;
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType: EnvironmentNetworkType;
  ipAddress?: string;  // NEW FIELD - IP address for local environments
  status: ServiceStatus;
  isActive: boolean;
  services: EnvironmentService[];
  networks: EnvironmentNetwork[];
  volumes: EnvironmentVolume[];
  createdAt: Date;
  updatedAt: Date;
}
```

**Build Required:** Yes - run `npm run build:lib` to compile the shared types

**Impact:** Both client and server packages depend on this, so must be built first

---

### 3. Backend API Changes

#### 3.1 File: `server/src/routes/environments.ts`

**Location:** Zod validation schemas (lines 20-60)

**Changes Required:**

1. **Update `createEnvironmentSchema`** (around line 25):

```typescript
const createEnvironmentSchema = z.object({
  name: z.string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only letters, numbers, underscores, and hyphens'),
  description: z.string().optional(),
  type: z.enum(['production', 'nonproduction']),
  networkType: z.enum(['local', 'internet']).optional(),
  ipAddress: z.string()
    .ip({ version: 'v4' })  // Validates IPv4 format
    .optional()
    .refine((val, ctx) => {
      // If networkType is 'local', ipAddress should be provided
      const networkType = ctx.parent?.networkType || 'local';
      if (networkType === 'local' && !val) {
        return false;
      }
      return true;
    }, {
      message: 'IP address is required for local environments'
    }),
  services: z.array(z.object({
    serviceName: z.string().min(1).max(100),
    serviceType: z.string().min(1),
    config: z.record(z.string(), z.any()).optional()
  })).optional()
});
```

2. **Update `updateEnvironmentSchema`** (around line 45):

```typescript
const updateEnvironmentSchema = z.object({
  name: z.string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  description: z.string().optional(),
  type: z.enum(['production', 'nonproduction']).optional(),
  networkType: z.enum(['local', 'internet']).optional(),
  ipAddress: z.string()
    .ip({ version: 'v4' })  // Validates IPv4 format
    .optional(),
  isActive: z.boolean().optional()
});
```

**Note:** The validation ensures:
- IP address must be a valid IPv4 format when provided
- For new environments with networkType='local', ipAddress is required
- For internet environments, ipAddress is optional (not used)

---

#### 3.2 File: `server/src/routes/environments.ts`

**Location:** POST /api/environments endpoint (around line 100-150)

**Changes Required:**

Update the create endpoint to include ipAddress in the request:

```typescript
router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const validatedData = createEnvironmentSchema.parse(req.body);

    const userId = getCurrentUserId(req);

    // Create environment with ipAddress
    const environment = await environmentManager.createEnvironment({
      name: validatedData.name,
      description: validatedData.description,
      type: validatedData.type,
      networkType: validatedData.networkType || 'local',
      ipAddress: validatedData.ipAddress,  // NEW FIELD
      services: validatedData.services || [],
      userId
    });

    logger.info({ environmentId: environment.id }, 'Environment created successfully');
    res.status(201).json(environment);
  } catch (error) {
    // ... error handling
  }
});
```

---

#### 3.3 File: `server/src/routes/environments.ts`

**Location:** PUT /api/environments/:id endpoint (around line 200-250)

**Changes Required:**

Update the update endpoint to include ipAddress:

```typescript
router.put('/:id', requireSessionOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const validatedData = updateEnvironmentSchema.parse(req.body);

    const updated = await environmentManager.updateEnvironment(id, {
      description: validatedData.description,
      type: validatedData.type,
      networkType: validatedData.networkType,
      ipAddress: validatedData.ipAddress,  // NEW FIELD
      isActive: validatedData.isActive
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Environment not found'
      });
    }

    logger.info({ environmentId: id }, 'Environment updated successfully');
    res.json(updated);
  } catch (error) {
    // ... error handling
  }
});
```

---

### 4. Backend Service Layer Changes

#### 4.1 File: `server/src/services/environment-manager.ts`

**Location:** CreateEnvironmentRequest interface and methods (around line 30-50)

**Changes Required:**

1. **Update `CreateEnvironmentRequest` type** (around line 35):

```typescript
interface CreateEnvironmentRequest {
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType?: EnvironmentNetworkType;
  ipAddress?: string;  // NEW FIELD
  services?: ServiceConfiguration[];
  userId: string;
}
```

2. **Update `UpdateEnvironmentRequest` type** (around line 50):

```typescript
interface UpdateEnvironmentRequest {
  description?: string;
  type?: EnvironmentType;
  networkType?: EnvironmentNetworkType;
  ipAddress?: string;  // NEW FIELD
  isActive?: boolean;
}
```

3. **Update `createEnvironment` method** (around line 100-150):

```typescript
async createEnvironment(request: CreateEnvironmentRequest): Promise<Environment> {
  try {
    logger.info({ request }, 'Creating environment');

    // Validate IP address if provided
    if (request.ipAddress && request.networkType === 'local') {
      this.validateIPAddress(request.ipAddress);
    }

    // Create environment in database
    const environment = await prisma.environment.create({
      data: {
        name: request.name,
        description: request.description,
        type: request.type,
        networkType: request.networkType || 'local',
        ipAddress: request.ipAddress,  // NEW FIELD
        status: ServiceStatusValues.UNINITIALIZED,
        isActive: false
      },
      include: {
        services: true,
        networks: true,
        volumes: true
      }
    });

    // Add services if provided
    if (request.services && request.services.length > 0) {
      await this.addServicesToEnvironment(environment.id, request.services);
    }

    return environment;
  } catch (error) {
    logger.error({ error }, 'Failed to create environment');
    throw error;
  }
}
```

4. **Update `updateEnvironment` method** (around line 200-250):

```typescript
async updateEnvironment(
  id: string,
  request: UpdateEnvironmentRequest
): Promise<Environment | null> {
  try {
    logger.info({ environmentId: id, request }, 'Updating environment');

    // Validate IP address if being updated
    if (request.ipAddress) {
      this.validateIPAddress(request.ipAddress);
    }

    const updated = await prisma.environment.update({
      where: { id },
      data: {
        description: request.description,
        type: request.type,
        networkType: request.networkType,
        ipAddress: request.ipAddress,  // NEW FIELD
        isActive: request.isActive
      },
      include: {
        services: true,
        networks: true,
        volumes: true
      }
    });

    logger.info({ environmentId: id }, 'Environment updated successfully');
    return updated;
  } catch (error) {
    if (error.code === 'P2025') {
      return null;
    }
    logger.error({ error, environmentId: id }, 'Failed to update environment');
    throw error;
  }
}
```

5. **Add IP validation helper method** (add new method):

```typescript
private validateIPAddress(ip: string): void {
  // IPv4 validation
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // IPv6 validation (simplified)
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;

  if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
    throw new Error(`Invalid IP address format: ${ip}`);
  }
}
```

---

#### 4.2 File: `server/src/services/network-utils.ts`

**Location:** `getAppropriateIPForEnvironment` method (around line 100-150)

**Changes Required:**

Update the method to use environment-specific IP address when available:

```typescript
async getAppropriateIPForEnvironment(environmentId: string): Promise<string> {
  try {
    logger.info({ environmentId }, 'Getting appropriate IP for environment');

    // Get environment details
    const environment = await prisma.environment.findUnique({
      where: { id: environmentId },
      select: {
        id: true,
        name: true,
        networkType: true,
        ipAddress: true  // NEW FIELD
      }
    });

    if (!environment) {
      throw new Error(`Environment not found: ${environmentId}`);
    }

    // For local environments, prefer the environment-specific IP if set
    if (environment.networkType === 'local' && environment.ipAddress) {
      logger.info(
        { environmentId, ipAddress: environment.ipAddress },
        'Using environment-specific IP address'
      );

      // Validate the IP format
      this.validateIPAddress(environment.ipAddress);
      return environment.ipAddress;
    }

    // Fall back to global Docker host IP from settings
    const dockerHostIp = await this.getDockerHostIP();

    if (!dockerHostIp) {
      throw new Error('Docker host IP not configured in system settings');
    }

    logger.info(
      { environmentId, dockerHostIp, networkType: environment.networkType },
      'Using global Docker host IP'
    );

    return dockerHostIp;
  } catch (error) {
    logger.error({ error, environmentId }, 'Failed to get appropriate IP for environment');
    throw error;
  }
}

private validateIPAddress(ip: string): void {
  // IPv4 validation
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  if (!ipv4Regex.test(ip)) {
    throw new Error(`Invalid IPv4 address format: ${ip}`);
  }
}
```

**Impact:** This change ensures that when DNS records are created for deployments on local environments, the environment-specific IP is used instead of the global Docker host IP.

---

#### 4.3 File: `server/src/services/deployment-dns-manager.ts`

**Location:** `createDNSRecordForDeployment` method (around line 50-100)

**Changes Required:**

No direct changes needed - this method already calls `networkUtils.getAppropriateIPForEnvironment()`, which will now return the environment-specific IP when available.

**Validation:** Verify the integration by checking the log messages:

```typescript
// Existing code already handles this correctly
const ipAddress = await this.networkUtils.getAppropriateIPForEnvironment(
  deploymentConfig.environmentId
);

logger.info(
  { deploymentConfigId, hostname, ipAddress },
  'Creating DNS record with environment IP'
);
```

---

### 5. Frontend Changes

#### 5.1 File: `client/src/components/environments/environment-create-dialog.tsx`

**Location:** Form fields and validation (around line 50-200)

**Changes Required:**

1. **Add ipAddress field to form schema** (around line 60):

```typescript
const formSchema = z.object({
  name: z.string()
    .min(1, "Name is required")
    .max(100, "Name must be 100 characters or less")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Name must contain only letters, numbers, underscores, and hyphens"
    ),
  description: z.string().optional(),
  type: z.enum(["production", "nonproduction"]),
  networkType: z.enum(["local", "internet"]),
  ipAddress: z.string()
    .optional()
    .refine((val, ctx) => {
      const networkType = ctx.parent?.networkType;
      if (networkType === 'local' && !val) {
        return false;
      }
      return true;
    }, {
      message: "IP address is required for local environments"
    })
    .refine((val) => {
      if (!val) return true;
      // IPv4 validation
      const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      return ipv4Regex.test(val);
    }, {
      message: "Must be a valid IPv4 address"
    }),
  services: z.array(z.object({
    serviceType: z.string(),
    serviceName: z.string()
  })).optional()
});
```

2. **Add ipAddress to form default values** (around line 100):

```typescript
const form = useForm<z.infer<typeof formSchema>>({
  resolver: zodResolver(formSchema),
  defaultValues: {
    name: "",
    description: "",
    type: "nonproduction",
    networkType: "local",
    ipAddress: "",  // NEW FIELD
    services: []
  }
});
```

3. **Add IP Address input field to form** (around line 250, after networkType field):

```typescript
{/* Network Type Selection */}
<FormField
  control={form.control}
  name="networkType"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Network Type</FormLabel>
      <Select
        onValueChange={field.onChange}
        defaultValue={field.value}
      >
        <FormControl>
          <SelectTrigger>
            <SelectValue placeholder="Select network type" />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value="local">Local</SelectItem>
          <SelectItem value="internet">Internet</SelectItem>
        </SelectContent>
      </Select>
      <FormDescription>
        Local: Environment on local network. Internet: Exposed to internet.
      </FormDescription>
      <FormMessage />
    </FormItem>
  )}
/>

{/* NEW FIELD - IP Address (only shown for local environments) */}
{form.watch("networkType") === "local" && (
  <FormField
    control={form.control}
    name="ipAddress"
    render={({ field }) => (
      <FormItem>
        <FormLabel>IP Address *</FormLabel>
        <FormControl>
          <Input
            placeholder="e.g., 192.168.1.100"
            {...field}
          />
        </FormControl>
        <FormDescription>
          The IP address of the local server. This will be used for DNS records.
        </FormDescription>
        <FormMessage />
      </FormItem>
    )}
  />
)}
```

4. **Update form submission** (around line 400):

```typescript
const handleSubmit = async (values: z.infer<typeof formSchema>) => {
  try {
    await createEnvironment({
      name: values.name,
      description: values.description,
      type: values.type,
      networkType: values.networkType,
      ipAddress: values.ipAddress,  // NEW FIELD
      services: values.services?.map(s => ({
        serviceName: s.serviceName,
        serviceType: s.serviceType,
        config: {}
      }))
    });

    toast.success("Environment created successfully");
    setOpen(false);
    form.reset();
  } catch (error) {
    toast.error("Failed to create environment");
    logger.error({ error }, "Failed to create environment");
  }
};
```

---

#### 5.2 File: `client/src/components/environments/environment-edit-dialog.tsx`

**Location:** Form fields and update logic (around line 50-200)

**Changes Required:**

1. **Add ipAddress to form schema** (around line 60):

```typescript
const formSchema = z.object({
  description: z.string().optional(),
  type: z.enum(["production", "nonproduction"]),
  ipAddress: z.string()
    .optional()
    .refine((val) => {
      if (!val) return true;
      // IPv4 validation
      const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      return ipv4Regex.test(val);
    }, {
      message: "Must be a valid IPv4 address"
    })
});
```

2. **Add ipAddress to form initialization** (around line 100):

```typescript
useEffect(() => {
  if (open && environment) {
    form.reset({
      description: environment.description || "",
      type: environment.type,
      ipAddress: environment.ipAddress || ""  // NEW FIELD
    });
  }
}, [open, environment, form]);
```

3. **Add IP Address field to edit form** (around line 200, after description field):

```typescript
{/* Description Field */}
<FormField
  control={form.control}
  name="description"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Description</FormLabel>
      <FormControl>
        <Textarea
          placeholder="Optional description"
          {...field}
        />
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>

{/* NEW FIELD - IP Address (only for local environments) */}
{environment?.networkType === "local" && (
  <FormField
    control={form.control}
    name="ipAddress"
    render={({ field }) => (
      <FormItem>
        <FormLabel>IP Address</FormLabel>
        <FormControl>
          <Input
            placeholder="e.g., 192.168.1.100"
            {...field}
          />
        </FormControl>
        <FormDescription>
          The IP address of the local server. Used for DNS records.
        </FormDescription>
        <FormMessage />
      </FormItem>
    )}
  />
)}

{/* Read-only fields section */}
<div className="space-y-4 rounded-lg border border-muted bg-muted/50 p-4">
  {/* ... existing read-only fields ... */}
</div>
```

4. **Update submission handler** (around line 300):

```typescript
const handleSubmit = async (values: z.infer<typeof formSchema>) => {
  try {
    const updates: any = {};

    if (values.description !== environment?.description) {
      updates.description = values.description;
    }

    if (values.type !== environment?.type) {
      updates.type = values.type;
    }

    // NEW FIELD
    if (values.ipAddress !== environment?.ipAddress) {
      updates.ipAddress = values.ipAddress;
    }

    if (Object.keys(updates).length === 0) {
      toast.info("No changes to save");
      return;
    }

    await updateEnvironment({
      id: environment!.id,
      ...updates
    });

    toast.success("Environment updated successfully");
    setOpen(false);
  } catch (error) {
    toast.error("Failed to update environment");
    logger.error({ error }, "Failed to update environment");
  }
};
```

---

#### 5.3 File: `client/src/components/environments/environment-card.tsx`

**Location:** Environment display card (around line 50-150)

**Changes Required:**

Add display of IP address for local environments (around line 100, in the card content area):

```typescript
<Card
  className="cursor-pointer transition-shadow hover:shadow-md"
  onClick={() => onSelect(environment.id)}
>
  <CardHeader>
    <div className="flex items-start justify-between">
      <div className="space-y-1">
        <CardTitle className="flex items-center gap-2">
          {environment.name}
          <Badge variant={environment.type === 'production' ? 'default' : 'secondary'}>
            {environment.type}
          </Badge>
        </CardTitle>
        <CardDescription>{environment.description || 'No description'}</CardDescription>
      </div>
      <Badge variant="outline">
        {environment.networkType === 'local' ? 'Local' : 'Internet'}
      </Badge>
    </div>
  </CardHeader>

  <CardContent className="space-y-4">
    {/* NEW SECTION - Display IP address for local environments */}
    {environment.networkType === 'local' && environment.ipAddress && (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <IconNetwork size={16} />
        <span className="font-mono">{environment.ipAddress}</span>
      </div>
    )}

    {/* Service Health Summary */}
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">Services</span>
      <span>
        {healthyCount} healthy / {totalServices} total
      </span>
    </div>

    {/* ... rest of the card ... */}
  </CardContent>
</Card>
```

**Import Required:** Add `IconNetwork` from `@tabler/icons-react` at the top of the file.

---

#### 5.4 File: `client/src/app/environments/[id]/page.tsx`

**Location:** Environment detail page (around line 100-400)

**Changes Required:**

Add display of IP address in the environment details section (around line 150, after the status section):

```typescript
<div className="space-y-6">
  {/* Header Section */}
  <div className="flex items-start justify-between">
    <div className="space-y-1">
      <h1 className="text-3xl font-bold">{environment.name}</h1>
      <p className="text-muted-foreground">
        {environment.description || 'No description'}
      </p>

      {/* NEW SECTION - Display IP address for local environments */}
      {environment.networkType === 'local' && environment.ipAddress && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground pt-2">
          <IconNetwork size={16} />
          <span className="font-mono font-medium">{environment.ipAddress}</span>
          <Badge variant="outline" className="ml-2">Local IP</Badge>
        </div>
      )}
    </div>

    <div className="flex items-center gap-2">
      {/* Status Badge */}
      <EnvironmentStatus status={environment.status} />

      {/* Action Buttons */}
      <div className="flex gap-2">
        {/* ... start/stop buttons ... */}
      </div>
    </div>
  </div>

  {/* Statistics Cards */}
  <div className="grid gap-4 md:grid-cols-3">
    {/* ... existing cards ... */}
  </div>

  {/* Tabs for Services, Networks, Volumes */}
  <Tabs defaultValue="services" className="space-y-4">
    {/* ... existing tabs ... */}
  </Tabs>
</div>
```

**Import Required:** Add `IconNetwork` from `@tabler/icons-react` at the top of the file.

---

#### 5.5 File: `client/src/hooks/use-environments.ts`

**Location:** API integration hooks (no changes needed to hook logic)

**Verification Required:**

The hooks already use the shared `Environment` type from `@mini-infra/types`, so once the types are updated and rebuilt, the hooks will automatically include the new `ipAddress` field in:

- `useEnvironments()` - Will include ipAddress in list responses
- `useEnvironment(id)` - Will include ipAddress in single environment response
- `useCreateEnvironment()` - Will accept ipAddress in create request
- `useUpdateEnvironment()` - Will accept ipAddress in update request

**No code changes required** - TypeScript will automatically pick up the new field.

---

### 6. Testing Strategy

#### 6.1 Manual Testing Checklist

**Environment Creation:**
- [ ] Create local environment with IP address - should succeed
- [ ] Create local environment without IP address - should show validation error
- [ ] Create internet environment without IP address - should succeed
- [ ] Verify IP validation rejects invalid formats (e.g., "999.999.999.999", "abc.def.ghi.jkl")
- [ ] Verify IP validation accepts valid IPv4 (e.g., "192.168.1.100", "10.0.0.1")

**Environment Editing:**
- [ ] Edit local environment to change IP address - should succeed
- [ ] Edit local environment to set invalid IP - should show validation error
- [ ] Edit local environment to clear IP - should show validation error
- [ ] Edit internet environment - IP field should not be shown

**Environment Display:**
- [ ] Local environment card should display IP address with network icon
- [ ] Internet environment card should not display IP address
- [ ] Environment detail page should show IP for local environments
- [ ] Environment detail page should not show IP for internet environments

**DNS Integration:**
- [ ] Deploy container to local environment with IP address
- [ ] Verify DNS record created with environment-specific IP (check logs)
- [ ] Deploy container to local environment without IP address (legacy)
- [ ] Verify DNS record created with fallback Docker host IP (check logs)
- [ ] Deploy container to internet environment
- [ ] Verify DNS record skipped (check logs)

#### 6.2 API Testing with curl

```bash
# Get development API key
cd server && npm run show-dev-key

# Create local environment with IP address
curl -X POST http://localhost:5000/api/environments \
  -H "x-api-key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-local-env",
    "description": "Test local environment",
    "type": "nonproduction",
    "networkType": "local",
    "ipAddress": "192.168.1.100"
  }'

# Update environment IP address
curl -X PUT http://localhost:5000/api/environments/<env-id> \
  -H "x-api-key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "ipAddress": "192.168.1.200"
  }'

# Get environment details (should show ipAddress field)
curl -H "x-api-key: <your-api-key>" \
  http://localhost:5000/api/environments/<env-id>
```

#### 6.3 Database Verification

```powershell
# Check environment table has ipAddress field
cd server
@"
.headers on
.mode column
SELECT id, name, networkType, ipAddress FROM Environment;
"@ | .\sqlite3.exe prisma/dev.db
```

---

## Implementation Steps

### Step 1: Update Shared Types Library
1. Open `lib/types/environments.ts`
2. Add `ipAddress?: string` to the `Environment` interface
3. Build the library: `cd lib && npm run build`
4. Verify compilation succeeds with no TypeScript errors

### Step 2: Update Database Schema
1. Open `server/prisma/schema.prisma`
2. Add `ipAddress String?` field to `Environment` model
3. Run migration: `cd server && npx prisma db push`
4. Verify migration succeeds and database is updated
5. Optionally run: `npx prisma studio` to visually verify the new field

### Step 3: Update Backend API Validation
1. Open `server/src/routes/environments.ts`
2. Update `createEnvironmentSchema` to include ipAddress validation
3. Update `updateEnvironmentSchema` to include ipAddress validation
4. Update POST endpoint to pass ipAddress to environment manager
5. Update PUT endpoint to pass ipAddress to environment manager
6. Verify TypeScript compilation: `cd server && npm run build`

### Step 4: Update Backend Service Layer
1. Open `server/src/services/environment-manager.ts`
2. Update `CreateEnvironmentRequest` interface
3. Update `UpdateEnvironmentRequest` interface
4. Update `createEnvironment` method to handle ipAddress
5. Update `updateEnvironment` method to handle ipAddress
6. Add `validateIPAddress` helper method
7. Verify TypeScript compilation

### Step 5: Update Network Utilities
1. Open `server/src/services/network-utils.ts`
2. Update `getAppropriateIPForEnvironment` to use environment-specific IP
3. Add IP validation method
4. Test with existing deployments to ensure backward compatibility
5. Verify log messages show correct IP selection logic

### Step 6: Update Frontend Create Form
1. Open `client/src/components/environments/environment-create-dialog.tsx`
2. Update form schema to include ipAddress field with validation
3. Add ipAddress to default values
4. Add conditional IP Address input field (shown only for local environments)
5. Update form submission to include ipAddress
6. Test form validation and submission

### Step 7: Update Frontend Edit Form
1. Open `client/src/components/environments/environment-edit-dialog.tsx`
2. Update form schema to include ipAddress field
3. Add ipAddress to form initialization
4. Add conditional IP Address input field
5. Update submission handler to include ipAddress in change detection
6. Test editing existing environments

### Step 8: Update Frontend Display Components
1. Open `client/src/components/environments/environment-card.tsx`
2. Add display of IP address for local environments
3. Import `IconNetwork` from `@tabler/icons-react`
4. Open `client/src/app/environments/[id]/page.tsx`
5. Add display of IP address in detail page
6. Import `IconNetwork` from `@tabler/icons-react`
7. Verify display logic shows IP only for local environments

### Step 9: Build and Test Full Stack
1. Build shared types: `cd lib && npm run build`
2. Build backend: `cd server && npm run build`
3. Build frontend: `cd client && npm run build`
4. Start development environment: `npm run dev` (from root)
5. Verify all services start without errors

### Step 10: Manual Integration Testing
1. Follow the testing checklist in section 6.1
2. Test environment creation with IP address
3. Test environment editing
4. Test DNS integration with deployment
5. Verify logs show correct IP selection
6. Test validation error cases

### Step 11: Database Migration for Existing Environments
1. Review existing environments: `SELECT id, name, networkType FROM Environment;`
2. For each local environment without an IP, decide whether to:
   - Leave as null (will use fallback Docker host IP)
   - Update with appropriate IP address
3. Optional: Create script to bulk update local environments with Docker host IP

---

## Technical Notes

### Why ipAddress is Optional

The `ipAddress` field is optional (nullable) for these reasons:

1. **Backward Compatibility**: Existing local environments without an IP address will continue to work by falling back to the global Docker host IP
2. **Internet Environments**: Environments with `networkType='internet'` don't need an IP address since DNS is managed externally
3. **Flexible Migration**: Allows gradual migration of existing environments to use environment-specific IPs

### IP Address Validation Strategy

Validation occurs at multiple levels:

1. **Frontend Validation**: Zod schema with regex validation for immediate user feedback
2. **Backend API Validation**: Zod schema with IP format validation before database write
3. **Service Layer Validation**: Additional validation in EnvironmentManager for defensive programming
4. **Network Utilities Validation**: Final validation before using IP in DNS records

This multi-layered approach ensures invalid IPs never reach critical DNS configuration code.

### DNS Integration Flow

When a container is deployed to an environment:

1. Deployment orchestrator calls `deploymentDNSManager.createDNSRecordForDeployment()`
2. DNS manager loads deployment config with environment relationship
3. DNS manager checks environment `networkType`:
   - If 'internet': Skips DNS creation (external management)
   - If 'local': Proceeds to create DNS record
4. DNS manager calls `networkUtils.getAppropriateIPForEnvironment(environmentId)`
5. Network utils loads environment and checks for `ipAddress` field:
   - If set: Uses environment-specific IP
   - If not set: Falls back to global Docker host IP from settings
6. DNS manager creates CloudFlare A record with the selected IP
7. HAProxy frontend routes traffic based on hostname

This flow ensures seamless integration with minimal code changes.

### Future Enhancements

1. **IPv6 Support**: Currently validates IPv4 only; could extend to support IPv6
2. **Multiple IPs**: Could support multiple IPs per environment for load balancing
3. **IP Pools**: Could manage IP address pools for automatic assignment
4. **CIDR Notation**: Could support subnet notation for network ranges
5. **DNS Record Updates**: Could add UI for bulk DNS record updates when IP changes

---

## Files Modified Summary

| Package | File Path | Type of Change | Lines Changed |
|---------|-----------|----------------|---------------|
| lib | `types/environments.ts` | Modified - Add ipAddress field | ~2 |
| server | `prisma/schema.prisma` | Modified - Database schema | ~1 |
| server | `src/routes/environments.ts` | Modified - Zod schemas and endpoints | ~40 |
| server | `src/services/environment-manager.ts` | Modified - Service methods | ~60 |
| server | `src/services/network-utils.ts` | Modified - IP resolution logic | ~30 |
| client | `components/environments/environment-create-dialog.tsx` | Modified - Form fields | ~50 |
| client | `components/environments/environment-edit-dialog.tsx` | Modified - Form fields | ~40 |
| client | `components/environments/environment-card.tsx` | Modified - Display | ~10 |
| client | `app/environments/[id]/page.tsx` | Modified - Display | ~15 |

**Total Files Changed:** 9
**Total Packages Affected:** 3 (lib, server, client)
**Estimated Lines of Code:** ~250

---

## Rollback Plan

If issues are discovered after deployment:

### Immediate Rollback Steps:
1. Revert frontend changes: `git revert <commit-hash>`
2. Revert backend service changes: `git revert <commit-hash>`
3. Redeploy: `npm run build:all`
4. The database column can remain (nullable fields don't break functionality)

### Database Rollback (if needed):
1. Check for any data in ipAddress column: `SELECT COUNT(*) FROM Environment WHERE ipAddress IS NOT NULL;`
2. If data exists, export it first: `SELECT id, name, ipAddress FROM Environment WHERE ipAddress IS NOT NULL;`
3. Remove column: Edit `schema.prisma`, remove `ipAddress String?`, run `npx prisma db push`

### DNS Fallback:
The `networkUtils.getAppropriateIPForEnvironment()` method already has fallback logic to use the global Docker host IP if environment-specific IP is not set, ensuring continued operation.

---

## Success Criteria

The implementation is considered successful when:

1. ✅ Local environments can be created with an IP address
2. ✅ IP address validation prevents invalid formats
3. ✅ IP address is required for local environments
4. ✅ IP address displays correctly in UI for local environments
5. ✅ IP address can be edited for local environments
6. ✅ DNS records use environment-specific IP when available
7. ✅ DNS records fall back to global Docker host IP when not set
8. ✅ Internet environments continue to work without IP address
9. ✅ Existing environments continue to function (backward compatibility)
10. ✅ All TypeScript compilation succeeds without errors
11. ✅ Manual testing checklist passes completely

---

## Additional Considerations

### Security
- IP addresses are not considered sensitive information in this context
- No additional encryption needed for IP storage
- Standard authentication still required for all API endpoints

### Performance
- No performance impact expected
- Additional field is indexed via primary key relationship
- Network utilities caching behavior unchanged

### Documentation
- Update README.md if environment setup process changes
- Update CLAUDE.md with IP address field information
- Consider adding tooltips in UI explaining IP address usage

### Monitoring
- Monitor logs for "Using environment-specific IP address" messages
- Track DNS record creation success/failure rates
- Alert on IP validation errors in production
