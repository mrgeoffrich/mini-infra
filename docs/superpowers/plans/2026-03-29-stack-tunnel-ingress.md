# Stack Tunnel Ingress Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically configure Cloudflare tunnel public hostnames when deploying StatelessWeb applications on internet-facing environments.

**Architecture:** Add `tunnelId` and `tunnelServiceUrl` fields to the Environment model. Extend `CloudflareService.addHostname()` to support `originRequest.httpHostHeader`. Wire the Cloudflare API into the stack resource reconciler's `reconcileTunnel()` method. Build `tunnelIngress` definitions during stack instantiation from environment config. Add tunnel config fields to the environment edit UI.

**Tech Stack:** Prisma migration, Express routes, CloudflareService, StackResourceReconciler, React Hook Form

---

### File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `server/prisma/schema.prisma` | Add `tunnelId` and `tunnelServiceUrl` to Environment model |
| Create | `server/prisma/migrations/TIMESTAMP_add_environment_tunnel_config/migration.sql` | Database migration |
| Modify | `lib/types/environments.ts` | Add tunnel fields to Environment and UpdateEnvironmentRequest types |
| Modify | `server/src/routes/environments.ts` | Accept tunnel fields in PUT endpoint validation |
| Modify | `server/src/services/cloudflare/cloudflare-service.ts` | Add `originRequest` param to `addHostname()` |
| Modify | `server/src/services/stacks/stack-resource-reconciler.ts` | Add CloudflareService dependency, implement tunnel API calls |
| Modify | `server/src/routes/stacks.ts` | Pass CloudflareService to reconciler constructor |
| Modify | `server/src/services/stacks/stack-template-service.ts` | Build `tunnelIngress` array during stack instantiation |
| Modify | `client/src/components/environments/environment-edit-dialog.tsx` | Add tunnel config fields for internet environments |
| Modify | `client/src/app/applications/new/page.tsx` | Pass `tunnelIngress` array in create request |

---

### Task 1: Database Migration — Add Tunnel Fields to Environment

**Files:**
- Modify: `server/prisma/schema.prisma:366-387`
- Create: migration via `npx prisma migrate dev`

- [ ] **Step 1: Add fields to schema.prisma**

In `server/prisma/schema.prisma`, add two fields to the `Environment` model after `networkType`:

```prisma
  tunnelId        String?  // Cloudflare tunnel UUID for internet environments
  tunnelServiceUrl String? // HAProxy URL the tunnel routes to (e.g. http://haproxy-container:80)
```

The full model becomes:

```prisma
model Environment {
  id               String   @id @default(cuid())
  name             String   @unique
  description      String?
  type             String   // 'production', 'nonproduction'
  networkType      String   @default("local") // 'local', 'internet'
  tunnelId         String?  // Cloudflare tunnel UUID for internet environments
  tunnelServiceUrl String?  // HAProxy URL the tunnel routes to
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  // Relations
  networks    EnvironmentNetwork[]
  volumes     EnvironmentVolume[]
  deploymentConfigurations DeploymentConfiguration[]
  haproxyFrontends HAProxyFrontend[]
  haproxyBackends  HAProxyBackend[]
  stacks           Stack[]
  stackTemplates   StackTemplate[]

  @@index([type])
  @@index([networkType])
  @@map("environments")
}
```

- [ ] **Step 2: Generate and apply migration**

Run: `npx -w server prisma migrate dev --name add_environment_tunnel_config`
Expected: Migration created and applied successfully

- [ ] **Step 3: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/
git commit -m "feat: add tunnelId and tunnelServiceUrl to Environment model"
```

---

### Task 2: Update Shared Types

**Files:**
- Modify: `lib/types/environments.ts`

- [ ] **Step 1: Add tunnel fields to Environment interface**

In `lib/types/environments.ts`, add to the `Environment` interface after `networkType`:

```typescript
export interface Environment {
  id: string;
  name: string;
  description?: string;
  type: EnvironmentType;
  networkType: EnvironmentNetworkType;
  tunnelId?: string;
  tunnelServiceUrl?: string;
  networks: EnvironmentNetwork[];
  volumes: EnvironmentVolume[];
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 2: Add tunnel fields to UpdateEnvironmentRequest**

```typescript
export interface UpdateEnvironmentRequest {
  description?: string;
  type?: EnvironmentType;
  networkType?: EnvironmentNetworkType;
  tunnelId?: string;
  tunnelServiceUrl?: string;
}
```

- [ ] **Step 3: Build lib**

Run: `npm run build:lib`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add lib/types/environments.ts
git commit -m "feat: add tunnel fields to Environment and UpdateEnvironmentRequest types"
```

---

### Task 3: Update Environment API Route

**Files:**
- Modify: `server/src/routes/environments.ts`

- [ ] **Step 1: Add tunnel fields to update schema**

Find the `updateEnvironmentSchema` in `server/src/routes/environments.ts` and add the tunnel fields:

```typescript
const updateEnvironmentSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  description: z.string().optional(),
  type: z.enum(['production', 'nonproduction']).optional(),
  networkType: z.enum(['local', 'internet']).optional(),
  tunnelId: z.string().optional().nullable(),
  tunnelServiceUrl: z.string().optional().nullable(),
});
```

- [ ] **Step 2: Verify the PUT handler passes through the new fields**

The PUT handler calls `environmentManager.updateEnvironment(id, request)` which does a Prisma update with the validated fields. Since Prisma will accept `tunnelId` and `tunnelServiceUrl` after the migration, no additional changes are needed in the environment manager — the validated request body is passed through directly.

Verify by reading the `updateEnvironment` method in the environment manager to confirm it spreads the request into the Prisma update.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/environments.ts
git commit -m "feat: accept tunnelId and tunnelServiceUrl in environment update API"
```

---

### Task 4: Extend CloudflareService.addHostname() with originRequest

**Files:**
- Modify: `server/src/services/cloudflare/cloudflare-service.ts:818-897`

- [ ] **Step 1: Add originRequest parameter**

Update the `addHostname` method signature and the `newRule` construction:

```typescript
async addHostname(
  tunnelId: string,
  hostname: string,
  service: string,
  path?: string,
  originRequest?: { httpHostHeader?: string },
): Promise<any> {
```

And where the `newRule` is built (around line 846):

```typescript
      const newRule: any = {
        hostname,
        service,
      };

      if (path) {
        newRule.path = path;
      }

      if (originRequest) {
        newRule.originRequest = originRequest;
      }
```

- [ ] **Step 2: Commit**

```bash
git add server/src/services/cloudflare/cloudflare-service.ts
git commit -m "feat: add originRequest parameter to CloudflareService.addHostname()"
```

---

### Task 5: Wire CloudflareService into StackResourceReconciler

**Files:**
- Modify: `server/src/services/stacks/stack-resource-reconciler.ts:39-45, 383-457`
- Modify: `server/src/routes/stacks.ts:90-95`
- Modify: `server/src/__tests__/stack-resource-reconciler.test.ts:79-84`
- Modify: `server/src/__tests__/stack-reconciler-plan.test.ts:394-399`

- [ ] **Step 1: Add CloudflareService to constructor**

In `server/src/services/stacks/stack-resource-reconciler.ts`, add the import and constructor parameter:

```typescript
import type { CloudflareService } from '../cloudflare/cloudflare-service';
```

Update the constructor:

```typescript
export class StackResourceReconciler {
  constructor(
    private prisma: PrismaClient,
    private certLifecycleManager: CertificateLifecycleManager,
    private cloudflareDns: CloudflareDNSService,
    private haproxyCertDeployer: HaproxyCertificateDeployer,
    private cloudflareService?: CloudflareService,
  ) {}
```

- [ ] **Step 2: Implement tunnel API calls in reconcileTunnel()**

Replace the `reconcileTunnel` method body (lines 383-457):

```typescript
  async reconcileTunnel(
    actions: ResourceAction[],
    stackId: string,
    definitions: StackTunnelIngress[],
    onProgress?: (result: ResourceResult) => void,
  ): Promise<ResourceResult[]> {
    const results: ResourceResult[] = [];
    const defMap = new Map(definitions.map((d) => [d.name, d]));

    // Look up environment tunnel config
    const stack = await this.prisma.stack.findUnique({
      where: { id: stackId },
      select: { environmentId: true },
    });
    let tunnelId: string | null = null;
    let tunnelServiceUrl: string | null = null;
    if (stack?.environmentId) {
      const env = await this.prisma.environment.findUnique({
        where: { id: stack.environmentId },
        select: { tunnelId: true, tunnelServiceUrl: true },
      });
      tunnelId = env?.tunnelId ?? null;
      tunnelServiceUrl = env?.tunnelServiceUrl ?? null;
    }

    for (const action of actions) {
      if (action.resourceType !== 'tunnel' || action.action === 'no-op') continue;

      const def = defMap.get(action.resourceName);
      const result: ResourceResult = {
        resourceType: 'tunnel',
        resourceName: action.resourceName,
        action: action.action,
        success: false,
      };

      try {
        if (action.action === 'create' || action.action === 'update') {
          if (!def) {
            result.error = `No definition found for tunnel resource ${action.resourceName}`;
            results.push(result);
            continue;
          }

          // Call Cloudflare API if tunnel is configured
          if (tunnelId && this.cloudflareService) {
            const serviceUrl = tunnelServiceUrl ?? def.service;
            log.info({ fqdn: def.fqdn, service: serviceUrl, tunnelId }, 'Adding hostname to Cloudflare tunnel');
            try {
              await this.cloudflareService.addHostname(
                tunnelId,
                def.fqdn,
                serviceUrl,
                undefined,
                { httpHostHeader: def.fqdn },
              );
            } catch (err: any) {
              // If hostname already exists, treat as success (idempotent)
              if (err.message?.includes('already exists')) {
                log.info({ fqdn: def.fqdn }, 'Hostname already exists in tunnel, continuing');
              } else {
                throw err;
              }
            }
          } else {
            log.warn({ stackId, fqdn: def.fqdn }, 'No tunnel configured on environment, skipping Cloudflare API call');
          }

          await this.prisma.stackResource.upsert({
            where: {
              stackId_resourceType_resourceName: {
                stackId,
                resourceType: 'tunnel',
                resourceName: action.resourceName,
              },
            },
            create: {
              stackId,
              resourceType: 'tunnel',
              resourceName: action.resourceName,
              fqdn: def.fqdn,
              externalId: tunnelId,
              externalState: { fqdn: def.fqdn, service: tunnelServiceUrl ?? def.service },
              status: 'active',
            },
            update: {
              fqdn: def.fqdn,
              externalId: tunnelId,
              externalState: { fqdn: def.fqdn, service: tunnelServiceUrl ?? def.service },
              status: 'active',
              error: null,
            },
          });

          result.success = true;
        } else if (action.action === 'remove') {
          // Read externalId to know which tunnel to remove from
          const resource = await this.prisma.stackResource.findFirst({
            where: { stackId, resourceType: 'tunnel', resourceName: action.resourceName },
          });
          const removeTunnelId = resource?.externalId ?? tunnelId;
          const removeFqdn = resource?.fqdn ?? action.resourceName;

          if (removeTunnelId && this.cloudflareService) {
            log.info({ fqdn: removeFqdn, tunnelId: removeTunnelId }, 'Removing hostname from Cloudflare tunnel');
            try {
              await this.cloudflareService.removeHostname(removeTunnelId, removeFqdn);
            } catch (err: any) {
              // If hostname not found, treat as success (already removed)
              if (err.message?.includes('not found')) {
                log.info({ fqdn: removeFqdn }, 'Hostname not found in tunnel, continuing');
              } else {
                throw err;
              }
            }
          }

          await this.prisma.stackResource.deleteMany({
            where: { stackId, resourceType: 'tunnel', resourceName: action.resourceName },
          });
          result.success = true;
        }
      } catch (err: any) {
        log.error({ err, resourceName: action.resourceName }, 'Tunnel reconciliation failed');
        result.error = err.message ?? String(err);
      }

      results.push(result);
      try { onProgress?.(result); } catch {}
    }

    return results;
  }
```

- [ ] **Step 3: Pass CloudflareService in stacks route**

In `server/src/routes/stacks.ts`, update the `createResourceReconciler` function. A `CloudflareService` instance is already created on line 62. Capture it and pass to the reconciler:

```typescript
  const cloudflareConfig = new CloudflareService(prisma);
  // ... existing code ...

  return new StackResourceReconciler(
    prisma,
    effectiveCertManager,
    new CloudflareDNSService(),
    new HaproxyCertificateDeployer(),
    cloudflareConfig,
  );
```

Note: `cloudflareConfig` is already instantiated on line 62 inside the `if (connectionString)` block. Move it outside that block so it's always available (it can work independently of Azure storage):

```typescript
  const cloudflareConfig = new CloudflareService(prisma);

  if (connectionString) {
    // ... TLS setup using cloudflareConfig ...
  }

  return new StackResourceReconciler(
    prisma,
    effectiveCertManager,
    new CloudflareDNSService(),
    new HaproxyCertificateDeployer(),
    cloudflareConfig,
  );
```

- [ ] **Step 4: Update test files to pass the new constructor arg**

In `server/src/__tests__/stack-resource-reconciler.test.ts`, update the constructor call:

```typescript
    reconciler = new StackResourceReconciler(
      mockPrisma,
      mockCertLifecycleManager,
      mockCloudflareDns,
      mockHaproxyCertDeployer,
      undefined, // cloudflareService — not needed for non-tunnel tests
    );
```

In `server/src/__tests__/stack-reconciler-plan.test.ts`:

```typescript
    const mockResourceReconciler = new StackResourceReconciler(
      mockPrisma,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    );
```

- [ ] **Step 5: Run tests**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts src/__tests__/stack-reconciler-plan.test.ts`
Expected: All tests PASS (existing tests don't test tunnel reconciliation with API calls)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/stacks/stack-resource-reconciler.ts server/src/routes/stacks.ts server/src/__tests__/stack-resource-reconciler.test.ts server/src/__tests__/stack-reconciler-plan.test.ts
git commit -m "feat: wire CloudflareService into tunnel reconciler for automatic ingress config"
```

---

### Task 6: Build tunnelIngress Array During Stack Instantiation

**Files:**
- Modify: `server/src/services/stacks/stack-template-service.ts:846-874`

- [ ] **Step 1: Add tunnelIngress construction in createStackFromTemplate()**

In `server/src/services/stacks/stack-template-service.ts`, in the `createStackFromTemplate` method, after the environment lookup (around line 810) and before the `prisma.stack.create` call (line 846), add logic to build the `tunnelIngress` array from service routing definitions:

```typescript
    // Build tunnelIngress from service routing definitions
    const tunnelIngressDefs: { name: string; fqdn: string; service: string }[] = [];
    if (input.environmentId) {
      const envForTunnel = await this.prisma.environment.findUnique({
        where: { id: input.environmentId },
        select: { tunnelServiceUrl: true, tunnelId: true },
      });

      if (envForTunnel?.tunnelId) {
        for (const svc of services) {
          const routing = svc.routing as any;
          if (routing?.tunnelIngress) {
            tunnelIngressDefs.push({
              name: routing.tunnelIngress,
              fqdn: routing.tunnelIngress,
              service: envForTunnel.tunnelServiceUrl ?? `http://localhost:80`,
            });
          }
        }
      }
    }
```

Then in the `prisma.stack.create` call, add the `tunnelIngress` field:

```typescript
    const stack = await this.prisma.stack.create({
      data: {
        name: stackName,
        description: template.description,
        environmentId: input.environmentId ?? null,
        version: 1,
        status: "undeployed",
        templateId: template.id,
        templateVersion: version.version,
        builtinVersion:
          template.source === "system" ? version.version : null,
        parameters:
          paramDefs.length > 0 ? (paramDefs as any) : undefined,
        parameterValues:
          Object.keys(mergedValues).length > 0
            ? (mergedValues as any)
            : undefined,
        networks: version.networks as any,
        volumes: version.volumes as any,
        tunnelIngress: tunnelIngressDefs.length > 0 ? tunnelIngressDefs : undefined,
        services: {
          create: services.map(toServiceCreateInput),
        },
      },
      include: {
        services: { orderBy: { order: "asc" } },
      },
    });
```

- [ ] **Step 2: Commit**

```bash
git add server/src/services/stacks/stack-template-service.ts
git commit -m "feat: build tunnelIngress definitions during stack instantiation"
```

---

### Task 7: Environment Edit UI — Tunnel Config Fields

**Files:**
- Modify: `client/src/components/environments/environment-edit-dialog.tsx`

- [ ] **Step 1: Read the current edit dialog**

Read `client/src/components/environments/environment-edit-dialog.tsx` to understand the form structure.

- [ ] **Step 2: Add tunnel fields to the form schema**

Update the form schema:

```typescript
const updateEnvironmentSchema = z.object({
  description: z.string().optional(),
  type: z.enum(["production", "nonproduction"] as const).optional(),
  tunnelId: z.string().optional().nullable(),
  tunnelServiceUrl: z.string().optional().nullable(),
});
```

- [ ] **Step 3: Add default values from the environment**

When populating the form defaults, include:

```typescript
tunnelId: environment.tunnelId ?? "",
tunnelServiceUrl: environment.tunnelServiceUrl ?? "",
```

- [ ] **Step 4: Add tunnel config fields (conditionally for internet environments)**

After the existing form fields, add a conditional section:

```tsx
{environment.networkType === "internet" && (
  <>
    <FormField
      control={form.control}
      name="tunnelId"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Cloudflare Tunnel ID</FormLabel>
          <FormControl>
            <Input
              placeholder="e.g. 277a978a-8a04-4761-a248-0464ced6a055"
              {...field}
              value={field.value ?? ""}
            />
          </FormControl>
          <FormDescription>
            UUID of the Cloudflare tunnel for this environment.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />

    <FormField
      control={form.control}
      name="tunnelServiceUrl"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Tunnel Service URL</FormLabel>
          <FormControl>
            <Input
              placeholder="e.g. http://internet-facing-haproxy-haproxy:80"
              {...field}
              value={field.value ?? ""}
            />
          </FormControl>
          <FormDescription>
            HAProxy URL that the tunnel routes traffic to.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  </>
)}
```

- [ ] **Step 5: Handle empty strings as null on submit**

In the submit handler, convert empty strings to null before sending:

```typescript
const payload = {
  ...data,
  tunnelId: data.tunnelId || null,
  tunnelServiceUrl: data.tunnelServiceUrl || null,
};
```

- [ ] **Step 6: Build and verify**

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add client/src/components/environments/environment-edit-dialog.tsx
git commit -m "feat: add tunnel config fields to environment edit dialog"
```

---

### Task 8: Build Verification, Rebuild, and Push

**Files:** None (verification only)

- [ ] **Step 1: Run existing server tests**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts src/__tests__/stack-reconciler-plan.test.ts`
Expected: All tests PASS

- [ ] **Step 2: Build client**

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Rebuild dev deployment**

Run: `bash deployment/development/start.sh`
Expected: Container rebuilds and starts successfully

- [ ] **Step 4: Push**

```bash
git push -u origin feat/stack-tunnel-ingress-config
```
