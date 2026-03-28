# Stack-Level Resource Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevate TLS certificates, DNS records, and Cloudflare tunnel ingress to first-class stack-level resources with plan/apply lifecycle management.

**Architecture:** Three new resource arrays (`tlsCertificates`, `dnsRecords`, `tunnelIngress`) added to `StackDefinition`, tracked via a `StackResource` database table, reconciled in dependency order during the existing plan/apply flow. Services reference resources by name. The `StackReconciler` gains resource planning and reconciliation methods.

**Tech Stack:** TypeScript, Prisma (SQLite), Vitest, Zod, existing TLS/DNS/HAProxy services

---

## File Structure

### New Files
| File | Purpose |
|------|---------|
| `server/prisma/migrations/<timestamp>_add_stack_resources/migration.sql` | Database migration for StackResource table |
| `server/src/services/stacks/stack-resource-reconciler.ts` | Resource planning + reconciliation logic (TLS, DNS, tunnel) |
| `server/src/__tests__/stack-resource-reconciler.test.ts` | Tests for resource reconciliation |

### Modified Files
| File | Change |
|------|--------|
| `lib/types/stacks.ts` | Add resource types, update `StackDefinition`, `StackServiceRouting`, `StackPlan`, `ApplyResult` |
| `server/prisma/schema.prisma` | Add `StackResource` model, add relation to `Stack` |
| `server/src/services/stacks/schemas.ts` | Add Zod schemas for resource types, update routing schema |
| `server/src/services/stacks/definition-hash.ts` | Include resources in stack definition hash |
| `server/src/services/stacks/stack-reconciler.ts` | Integrate resource reconciliation into plan/apply/destroy |
| `server/src/services/stacks/utils.ts` | Update `serializeStack` and `toServiceDefinition` for new fields |
| `server/src/routes/stacks.ts` | Pass new dependencies to reconciler |
| `server/src/__tests__/stack-reconciler-plan.test.ts` | Add resource plan tests |
| `server/src/__tests__/stack-reconciler-apply.test.ts` | Add resource apply tests |

---

### Task 1: Add Resource Types to Shared Types

**Files:**
- Modify: `lib/types/stacks.ts`

- [ ] **Step 1: Add the three resource interfaces**

Add after `StackVolume` (line 100) and before the `// DB model types` comment (line 102):

```typescript
// Stack-level resource types

export interface StackTlsCertificate {
  name: string;
  fqdn: string;
}

export interface StackDnsRecord {
  name: string;
  fqdn: string;
  recordType: 'A';
  target: string;
  ttl?: number;
  proxied?: boolean;
}

export interface StackTunnelIngress {
  name: string;
  fqdn: string;
  service: string;
}
```

- [ ] **Step 2: Add ResourceAction and ResourceResult types**

Add after `FieldDiff` (line 310) and before `// Apply types` (line 312):

```typescript
// Resource reconciliation types

export type ResourceType = 'tls' | 'dns' | 'tunnel';

export interface ResourceAction {
  resourceType: ResourceType;
  resourceName: string;
  action: 'create' | 'update' | 'remove' | 'no-op';
  reason?: string;
  diff?: FieldDiff[];
}

export interface ResourceResult {
  resourceType: ResourceType;
  resourceName: string;
  action: string;
  success: boolean;
  error?: string;
}
```

- [ ] **Step 3: Update StackDefinition to include resource arrays**

Replace the `StackDefinition` interface (lines 200-207):

```typescript
export interface StackDefinition {
  name: string;
  description?: string;
  parameters?: StackParameterDefinition[];
  networks: StackNetwork[];
  volumes: StackVolume[];
  tlsCertificates?: StackTlsCertificate[];
  dnsRecords?: StackDnsRecord[];
  tunnelIngress?: StackTunnelIngress[];
  services: StackServiceDefinition[];
}
```

- [ ] **Step 4: Update StackServiceRouting**

Replace the `StackServiceRouting` interface (lines 71-88):

```typescript
export interface StackServiceRouting {
  hostname: string;
  listeningPort: number;
  backendOptions?: {
    balanceAlgorithm?: 'roundrobin' | 'leastconn' | 'source';
    checkTimeout?: number;
    connectTimeout?: number;
    serverTimeout?: number;
  };
  tlsCertificate?: string;
  dnsRecord?: string;
  tunnelIngress?: string;
}
```

- [ ] **Step 5: Update StackPlan to include resourceActions**

Replace the `StackPlan` interface (lines 286-295):

```typescript
export interface StackPlan {
  stackId: string;
  stackName: string;
  stackVersion: number;
  planTime: string;
  actions: ServiceAction[];
  resourceActions: ResourceAction[];
  hasChanges: boolean;
  templateUpdateAvailable?: boolean;
  warnings?: PlanWarning[];
}
```

- [ ] **Step 6: Update ApplyResult to include resourceResults**

Replace the `ApplyResult` interface (lines 326-332):

```typescript
export interface ApplyResult {
  success: boolean;
  stackId: string;
  appliedVersion: number;
  serviceResults: ServiceApplyResult[];
  resourceResults: ResourceResult[];
  duration: number;
}
```

- [ ] **Step 7: Update ApplyOptions onProgress to include resource progress**

Replace the `onProgress` type in `ApplyOptions` (line 323):

```typescript
  onProgress?: (result: ServiceApplyResult | ResourceResult, completedCount: number, totalActions: number) => void;
```

- [ ] **Step 8: Update CreateStackRequest and UpdateStackRequest**

Add resource arrays to `CreateStackRequest` (after line 379, before `services`):

```typescript
  tlsCertificates?: StackTlsCertificate[];
  dnsRecords?: StackDnsRecord[];
  tunnelIngress?: StackTunnelIngress[];
```

Add resource arrays to `UpdateStackRequest` (after line 388, before `services`):

```typescript
  tlsCertificates?: StackTlsCertificate[];
  dnsRecords?: StackDnsRecord[];
  tunnelIngress?: StackTunnelIngress[];
```

- [ ] **Step 9: Update serializeStack to include resources**

Replace the `serializeStack` function body (lines 211-233) to include the three resource arrays from the stack:

```typescript
export function serializeStack(
  stack: Stack & { services: StackService[] }
): StackDefinition {
  return {
    name: stack.name,
    description: stack.description ?? undefined,
    parameters: stack.parameters?.length > 0 ? stack.parameters : undefined,
    networks: stack.networks,
    volumes: stack.volumes,
    tlsCertificates: stack.tlsCertificates?.length > 0 ? stack.tlsCertificates : undefined,
    dnsRecords: stack.dnsRecords?.length > 0 ? stack.dnsRecords : undefined,
    tunnelIngress: stack.tunnelIngress?.length > 0 ? stack.tunnelIngress : undefined,
    services: stack.services.map((s) => ({
      serviceName: s.serviceName,
      serviceType: s.serviceType,
      dockerImage: s.dockerImage,
      dockerTag: s.dockerTag,
      containerConfig: s.containerConfig,
      configFiles: s.configFiles ?? undefined,
      initCommands: s.initCommands ?? undefined,
      dependsOn: s.dependsOn,
      order: s.order,
      routing: s.routing ?? undefined,
    })),
  };
}
```

- [ ] **Step 10: Update the Stack DB model type**

Add to the `Stack` interface (after `volumes` around line 117):

```typescript
  tlsCertificates: StackTlsCertificate[];
  dnsRecords: StackDnsRecord[];
  tunnelIngress: StackTunnelIngress[];
```

- [ ] **Step 11: Update StackInfo type**

Find the `StackInfo` interface and add the same three fields to match.

- [ ] **Step 12: Build lib and verify no type errors**

Run: `npm run build -w lib`
Expected: Clean build with no errors.

- [ ] **Step 13: Commit**

```bash
git add lib/types/stacks.ts
git commit -m "feat: add stack-level resource types (TLS, DNS, tunnel)"
```

---

### Task 2: Add StackResource Database Model

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/<timestamp>_add_stack_resources/migration.sql`

- [ ] **Step 1: Add StackResource model to Prisma schema**

Add after the `StackDeployment` model (after the `@@map("stack_deployments")` closing brace, around line 1259):

```prisma
model StackResource {
  id            String   @id @default(cuid())
  stackId       String
  stack         Stack    @relation(fields: [stackId], references: [id], onDelete: Cascade)

  resourceType  String   // 'tls' | 'dns' | 'tunnel'
  resourceName  String   // name from the stack definition
  fqdn          String   // the domain this resource manages

  externalId    String?  // Cloudflare record ID, tunnel ingress ID, or TlsCertificate ID
  externalState Json?    // snapshot of what was applied

  status        String   @default("active") // 'active' | 'pending' | 'error'
  error         String?

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([stackId, resourceType, resourceName])
  @@index([stackId])
  @@map("stack_resources")
}
```

- [ ] **Step 2: Add resources relation to Stack model**

In the `Stack` model (around line 1210), add after `deployments StackDeployment[]`:

```prisma
  resources             StackResource[]
```

- [ ] **Step 3: Add resource JSON columns to Stack model**

In the `Stack` model, add after the `volumes` field (around line 1205):

```prisma
  tlsCertificates      Json?       // Array of StackTlsCertificate
  dnsRecords           Json?       // Array of StackDnsRecord
  tunnelIngress        Json?       // Array of StackTunnelIngress
```

- [ ] **Step 4: Add resourceResults column to StackDeployment model**

In the `StackDeployment` model (around line 1253), add after `serviceResults`:

```prisma
  resourceResults Json?       // ResourceResult[] for apply, null for stop
```

- [ ] **Step 5: Generate and apply migration**

Run: `npx -w server prisma migrate dev --name add_stack_resources`
Expected: Migration created and applied successfully.

- [ ] **Step 6: Verify Prisma client generation**

Run: `npx -w server prisma generate`
Expected: Prisma Client generated successfully.

- [ ] **Step 7: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/
git commit -m "feat: add StackResource database model and stack resource columns"
```

---

### Task 3: Add Zod Validation Schemas for Resources

**Files:**
- Modify: `server/src/services/stacks/schemas.ts`

- [ ] **Step 1: Add resource Zod schemas**

Add after `stackVolumeSchema` (line 165) and before the `nameRegex` (line 167):

```typescript
export const stackTlsCertificateSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  fqdn: z.string().min(1).max(253),
});

export const stackDnsRecordSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  fqdn: z.string().min(1).max(253),
  recordType: z.literal('A'),
  target: z.string().min(1),
  ttl: z.number().int().min(60).max(86400).optional(),
  proxied: z.boolean().optional(),
});

export const stackTunnelIngressSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  fqdn: z.string().min(1).max(253),
  service: z.string().min(1),
});
```

- [ ] **Step 2: Update stackServiceRoutingSchema**

Replace `stackServiceRoutingSchema` (lines 130-153):

```typescript
export const stackServiceRoutingSchema = z.object({
  hostname: z.string().min(1).max(253),
  listeningPort: numberOrTemplate,
  backendOptions: z
    .object({
      balanceAlgorithm: z
        .enum(["roundrobin", "leastconn", "source"])
        .optional(),
      checkTimeout: numberOrTemplateMin0.optional(),
      connectTimeout: numberOrTemplateMin0.optional(),
      serverTimeout: numberOrTemplateMin0.optional(),
    })
    .optional(),
  tlsCertificate: z.string().optional(),
  dnsRecord: z.string().optional(),
  tunnelIngress: z.string().optional(),
});
```

- [ ] **Step 3: Update stackDefinitionSchema to include resources**

Replace `stackDefinitionSchema` (lines 212-221):

```typescript
export const stackDefinitionSchema = z.object({
  name: stackNameSchema,
  description: z.string().max(500).optional(),
  parameters: z.array(stackParameterDefinitionSchema).optional(),
  networks: z.array(stackNetworkSchema),
  volumes: z.array(stackVolumeSchema),
  tlsCertificates: z.array(stackTlsCertificateSchema).optional(),
  dnsRecords: z.array(stackDnsRecordSchema).optional(),
  tunnelIngress: z.array(stackTunnelIngressSchema).optional(),
  services: z
    .array(stackServiceDefinitionSchema)
    .min(1, "At least one service is required"),
});
```

- [ ] **Step 4: Update createStackSchema and updateStackSchema**

Find `createStackSchema` (around line 225) and add the resource arrays after `volumes`:

```typescript
  tlsCertificates: z.array(stackTlsCertificateSchema).optional(),
  dnsRecords: z.array(stackDnsRecordSchema).optional(),
  tunnelIngress: z.array(stackTunnelIngressSchema).optional(),
```

Do the same for `updateStackSchema`.

- [ ] **Step 5: Remove the serviceType routing refinement for Stateful**

Update the refinement in `stackServiceDefinitionSchema` (lines 195-209). Change the check so Stateful services CAN have routing:

```typescript
  .refine(
    (data) => {
      if (data.serviceType === "StatelessWeb" && !data.routing) {
        return false;
      }
      return true;
    },
    {
      message:
        "StatelessWeb services must have routing",
    }
  );
```

- [ ] **Step 6: Build and verify no errors**

Run: `npm run build -w lib && npm run build -w server`
Expected: Clean build.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/stacks/schemas.ts
git commit -m "feat: add Zod validation schemas for stack resources"
```

---

### Task 4: Create Stack Resource Reconciler

**Files:**
- Create: `server/src/services/stacks/stack-resource-reconciler.ts`
- Test: `server/src/__tests__/stack-resource-reconciler.test.ts`

- [ ] **Step 1: Write tests for resource planning**

Create `server/src/__tests__/stack-resource-reconciler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StackResourceReconciler } from '../services/stacks/stack-resource-reconciler';
import type {
  StackTlsCertificate,
  StackDnsRecord,
  StackTunnelIngress,
  ResourceAction,
} from '@mini-infra/types';

// Mock external services
const mockPrisma = {
  stackResource: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  tlsCertificate: {
    findFirst: vi.fn(),
  },
} as any;

const mockCertLifecycleManager = {
  issueCertificate: vi.fn(),
} as any;

const mockCloudflareDns = {
  upsertARecord: vi.fn(),
  deleteDNSRecord: vi.fn(),
  findZoneForHostname: vi.fn(),
  findDNSRecords: vi.fn(),
} as any;

const mockHaproxyCertDeployer = {
  fetchAndDeployCertificate: vi.fn(),
} as any;

describe('StackResourceReconciler', () => {
  let reconciler: StackResourceReconciler;

  beforeEach(() => {
    vi.clearAllMocks();
    reconciler = new StackResourceReconciler(
      mockPrisma,
      mockCertLifecycleManager,
      mockCloudflareDns,
      mockHaproxyCertDeployer,
    );
  });

  describe('planResources', () => {
    it('returns create actions for new TLS certificates', () => {
      const tlsCertificates: StackTlsCertificate[] = [
        { name: 'api-cert', fqdn: 'api.example.com' },
      ];
      const currentResources: any[] = [];

      const actions = reconciler.planResources(
        { tlsCertificates, dnsRecords: [], tunnelIngress: [] },
        currentResources
      );

      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual({
        resourceType: 'tls',
        resourceName: 'api-cert',
        action: 'create',
        reason: 'New TLS certificate for api.example.com',
      });
    });

    it('returns no-op for existing TLS certificate with matching state', () => {
      const tlsCertificates: StackTlsCertificate[] = [
        { name: 'api-cert', fqdn: 'api.example.com' },
      ];
      const currentResources = [
        {
          resourceType: 'tls',
          resourceName: 'api-cert',
          fqdn: 'api.example.com',
          externalId: 'cert-123',
          externalState: { fqdn: 'api.example.com' },
          status: 'active',
        },
      ];

      const actions = reconciler.planResources(
        { tlsCertificates, dnsRecords: [], tunnelIngress: [] },
        currentResources
      );

      expect(actions).toHaveLength(1);
      expect(actions[0].action).toBe('no-op');
    });

    it('returns remove actions for resources no longer in definition', () => {
      const currentResources = [
        {
          resourceType: 'dns',
          resourceName: 'old-dns',
          fqdn: 'old.example.com',
          externalId: 'rec-456',
          externalState: { fqdn: 'old.example.com', target: '1.2.3.4', ttl: 300 },
          status: 'active',
        },
      ];

      const actions = reconciler.planResources(
        { tlsCertificates: [], dnsRecords: [], tunnelIngress: [] },
        currentResources
      );

      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual({
        resourceType: 'dns',
        resourceName: 'old-dns',
        action: 'remove',
        reason: 'Resource removed from stack definition',
      });
    });

    it('returns update action when DNS target changes', () => {
      const dnsRecords: StackDnsRecord[] = [
        { name: 'api-dns', fqdn: 'api.example.com', recordType: 'A', target: '10.0.0.2' },
      ];
      const currentResources = [
        {
          resourceType: 'dns',
          resourceName: 'api-dns',
          fqdn: 'api.example.com',
          externalId: 'rec-789',
          externalState: { fqdn: 'api.example.com', recordType: 'A', target: '10.0.0.1', ttl: 300 },
          status: 'active',
        },
      ];

      const actions = reconciler.planResources(
        { tlsCertificates: [], dnsRecords, tunnelIngress: [] },
        currentResources
      );

      expect(actions).toHaveLength(1);
      expect(actions[0].action).toBe('update');
      expect(actions[0].diff).toContainEqual({
        field: 'target',
        old: '10.0.0.1',
        new: '10.0.0.2',
      });
    });

    it('plans all three resource types together', () => {
      const tlsCertificates: StackTlsCertificate[] = [
        { name: 'cert', fqdn: 'app.example.com' },
      ];
      const dnsRecords: StackDnsRecord[] = [
        { name: 'dns', fqdn: 'app.example.com', recordType: 'A', target: '10.0.0.1' },
      ];
      const tunnelIngress: StackTunnelIngress[] = [
        { name: 'tunnel', fqdn: 'app.example.com', service: 'http://app:8080' },
      ];

      const actions = reconciler.planResources(
        { tlsCertificates, dnsRecords, tunnelIngress },
        []
      );

      expect(actions).toHaveLength(3);
      expect(actions.map((a) => a.resourceType)).toEqual(['tls', 'dns', 'tunnel']);
      expect(actions.every((a) => a.action === 'create')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: FAIL — cannot find module `stack-resource-reconciler`

- [ ] **Step 3: Implement StackResourceReconciler — planResources method**

Create `server/src/services/stacks/stack-resource-reconciler.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import type {
  StackTlsCertificate,
  StackDnsRecord,
  StackTunnelIngress,
  ResourceAction,
  ResourceResult,
  ResourceType,
  FieldDiff,
} from '@mini-infra/types';
import type { CertificateLifecycleManager } from '../tls/certificate-lifecycle-manager';
import type { CloudflareDNSService } from '../cloudflare/cloudflare-dns';
import type { HaproxyCertificateDeployer } from '../haproxy/haproxy-certificate-deployer';
import type { HAProxyDataPlaneClient } from '../haproxy';
import { servicesLogger } from '../../lib/logger-factory';

const log = servicesLogger.child({ service: 'stack-resource-reconciler' });

interface ResourceDefinitions {
  tlsCertificates: StackTlsCertificate[];
  dnsRecords: StackDnsRecord[];
  tunnelIngress: StackTunnelIngress[];
}

interface StackResourceRecord {
  resourceType: string;
  resourceName: string;
  fqdn: string;
  externalId: string | null;
  externalState: any;
  status: string;
}

export class StackResourceReconciler {
  constructor(
    private prisma: PrismaClient,
    private certLifecycleManager: CertificateLifecycleManager,
    private cloudflareDns: CloudflareDNSService,
    private haproxyCertDeployer: HaproxyCertificateDeployer,
  ) {}

  /**
   * Compare desired resource definitions against current StackResource records.
   * Returns a list of actions needed to reconcile.
   */
  planResources(
    definitions: ResourceDefinitions,
    currentResources: StackResourceRecord[]
  ): ResourceAction[] {
    const actions: ResourceAction[] = [];
    const matched = new Set<string>();

    // Plan TLS certificates
    for (const cert of definitions.tlsCertificates) {
      const key = `tls:${cert.name}`;
      const existing = currentResources.find(
        (r) => r.resourceType === 'tls' && r.resourceName === cert.name
      );
      matched.add(key);

      if (!existing) {
        actions.push({
          resourceType: 'tls',
          resourceName: cert.name,
          action: 'create',
          reason: `New TLS certificate for ${cert.fqdn}`,
        });
      } else if (existing.fqdn !== cert.fqdn) {
        actions.push({
          resourceType: 'tls',
          resourceName: cert.name,
          action: 'update',
          reason: `FQDN changed`,
          diff: [{ field: 'fqdn', old: existing.fqdn, new: cert.fqdn }],
        });
      } else {
        actions.push({
          resourceType: 'tls',
          resourceName: cert.name,
          action: 'no-op',
        });
      }
    }

    // Plan DNS records
    for (const dns of definitions.dnsRecords) {
      const key = `dns:${dns.name}`;
      const existing = currentResources.find(
        (r) => r.resourceType === 'dns' && r.resourceName === dns.name
      );
      matched.add(key);

      if (!existing) {
        actions.push({
          resourceType: 'dns',
          resourceName: dns.name,
          action: 'create',
          reason: `New DNS record for ${dns.fqdn}`,
        });
      } else {
        const state = existing.externalState ?? {};
        const diffs: FieldDiff[] = [];

        if (state.target !== dns.target) {
          diffs.push({ field: 'target', old: state.target ?? null, new: dns.target });
        }
        if ((state.ttl ?? 300) !== (dns.ttl ?? 300)) {
          diffs.push({ field: 'ttl', old: String(state.ttl ?? 300), new: String(dns.ttl ?? 300) });
        }
        if ((state.proxied ?? false) !== (dns.proxied ?? false)) {
          diffs.push({ field: 'proxied', old: String(state.proxied ?? false), new: String(dns.proxied ?? false) });
        }

        if (diffs.length > 0) {
          actions.push({
            resourceType: 'dns',
            resourceName: dns.name,
            action: 'update',
            reason: 'DNS record configuration changed',
            diff: diffs,
          });
        } else {
          actions.push({
            resourceType: 'dns',
            resourceName: dns.name,
            action: 'no-op',
          });
        }
      }
    }

    // Plan tunnel ingress
    for (const tunnel of definitions.tunnelIngress) {
      const key = `tunnel:${tunnel.name}`;
      const existing = currentResources.find(
        (r) => r.resourceType === 'tunnel' && r.resourceName === tunnel.name
      );
      matched.add(key);

      if (!existing) {
        actions.push({
          resourceType: 'tunnel',
          resourceName: tunnel.name,
          action: 'create',
          reason: `New tunnel ingress for ${tunnel.fqdn}`,
        });
      } else {
        const state = existing.externalState ?? {};
        const diffs: FieldDiff[] = [];

        if (state.fqdn !== tunnel.fqdn) {
          diffs.push({ field: 'fqdn', old: state.fqdn ?? null, new: tunnel.fqdn });
        }
        if (state.service !== tunnel.service) {
          diffs.push({ field: 'service', old: state.service ?? null, new: tunnel.service });
        }

        if (diffs.length > 0) {
          actions.push({
            resourceType: 'tunnel',
            resourceName: tunnel.name,
            action: 'update',
            reason: 'Tunnel ingress configuration changed',
            diff: diffs,
          });
        } else {
          actions.push({
            resourceType: 'tunnel',
            resourceName: tunnel.name,
            action: 'no-op',
          });
        }
      }
    }

    // Plan removals for resources no longer in definition
    for (const resource of currentResources) {
      const key = `${resource.resourceType}:${resource.resourceName}`;
      if (!matched.has(key)) {
        actions.push({
          resourceType: resource.resourceType as ResourceType,
          resourceName: resource.resourceName,
          action: 'remove',
          reason: 'Resource removed from stack definition',
        });
      }
    }

    return actions;
  }
}
```

- [ ] **Step 4: Run the plan tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/stacks/stack-resource-reconciler.ts server/src/__tests__/stack-resource-reconciler.test.ts
git commit -m "feat: add StackResourceReconciler with resource planning"
```

---

### Task 5: Implement TLS Reconciliation

**Files:**
- Modify: `server/src/services/stacks/stack-resource-reconciler.ts`
- Modify: `server/src/__tests__/stack-resource-reconciler.test.ts`

- [ ] **Step 1: Write tests for TLS reconciliation**

Add to the test file inside the main `describe` block:

```typescript
  describe('reconcileTls', () => {
    it('provisions a new certificate when not in TLS store', async () => {
      mockPrisma.tlsCertificate.findFirst.mockResolvedValue(null);
      mockCertLifecycleManager.issueCertificate.mockResolvedValue({
        id: 'cert-new',
        primaryDomain: 'api.example.com',
      });
      mockPrisma.stackResource.upsert.mockResolvedValue({});

      const actions: ResourceAction[] = [
        { resourceType: 'tls', resourceName: 'api-cert', action: 'create', reason: 'New TLS certificate for api.example.com' },
      ];
      const definitions = {
        tlsCertificates: [{ name: 'api-cert', fqdn: 'api.example.com' }],
        dnsRecords: [],
        tunnelIngress: [],
      };

      const results = await reconciler.reconcileTls(
        actions, 'stack-1', definitions, null, 'user-1'
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockCertLifecycleManager.issueCertificate).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryDomain: 'api.example.com',
          domains: ['api.example.com'],
          userId: 'user-1',
        }),
        expect.any(Function),
      );
      expect(mockPrisma.stackResource.upsert).toHaveBeenCalled();
    });

    it('reuses existing certificate from TLS store', async () => {
      mockPrisma.tlsCertificate.findFirst.mockResolvedValue({
        id: 'cert-existing',
        primaryDomain: 'api.example.com',
        status: 'ACTIVE',
      });
      mockHaproxyCertDeployer.fetchAndDeployCertificate.mockResolvedValue('cert-file.pem');
      mockPrisma.stackResource.upsert.mockResolvedValue({});

      const actions: ResourceAction[] = [
        { resourceType: 'tls', resourceName: 'api-cert', action: 'create', reason: 'New TLS certificate for api.example.com' },
      ];
      const definitions = {
        tlsCertificates: [{ name: 'api-cert', fqdn: 'api.example.com' }],
        dnsRecords: [],
        tunnelIngress: [],
      };

      const results = await reconciler.reconcileTls(
        actions, 'stack-1', definitions, null, 'user-1'
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockCertLifecycleManager.issueCertificate).not.toHaveBeenCalled();
      expect(mockHaproxyCertDeployer.fetchAndDeployCertificate).toHaveBeenCalledWith(
        'cert-existing', expect.anything(), expect.anything(), expect.anything(),
      );
    });

    it('skips no-op TLS actions', async () => {
      const actions: ResourceAction[] = [
        { resourceType: 'tls', resourceName: 'api-cert', action: 'no-op' },
      ];
      const definitions = {
        tlsCertificates: [{ name: 'api-cert', fqdn: 'api.example.com' }],
        dnsRecords: [],
        tunnelIngress: [],
      };

      const results = await reconciler.reconcileTls(
        actions, 'stack-1', definitions, null, 'user-1'
      );

      expect(results).toHaveLength(0);
      expect(mockCertLifecycleManager.issueCertificate).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: FAIL — `reconcileTls` is not a function.

- [ ] **Step 3: Implement reconcileTls method**

Add to `StackResourceReconciler` class:

```typescript
  /**
   * Reconcile TLS certificate resources.
   * Looks up certs by FQDN, provisions if missing, deploys to HAProxy.
   */
  async reconcileTls(
    actions: ResourceAction[],
    stackId: string,
    definitions: ResourceDefinitions,
    haproxyClient: HAProxyDataPlaneClient | null,
    userId: string,
    onProgress?: (step: string) => void,
  ): Promise<ResourceResult[]> {
    const results: ResourceResult[] = [];
    const tlsActions = actions.filter(
      (a) => a.resourceType === 'tls' && a.action !== 'no-op'
    );

    for (const action of tlsActions) {
      const certDef = definitions.tlsCertificates.find(
        (c) => c.name === action.resourceName
      );

      if (action.action === 'remove') {
        // Unbind from HAProxy only — cert stays in TLS store
        try {
          await this.prisma.stackResource.deleteMany({
            where: { stackId, resourceType: 'tls', resourceName: action.resourceName },
          });
          results.push({
            resourceType: 'tls',
            resourceName: action.resourceName,
            action: 'remove',
            success: true,
          });
        } catch (err: any) {
          results.push({
            resourceType: 'tls',
            resourceName: action.resourceName,
            action: 'remove',
            success: false,
            error: err.message,
          });
        }
        continue;
      }

      if (!certDef) continue;

      try {
        onProgress?.(`Provisioning TLS certificate for ${certDef.fqdn}...`);

        // Look up existing certificate by FQDN
        const existingCert = await this.prisma.tlsCertificate.findFirst({
          where: { primaryDomain: certDef.fqdn, status: { in: ['ACTIVE', 'RENEWING'] } },
        });

        let certId: string;

        if (existingCert) {
          certId = existingCert.id;
          log.info({ fqdn: certDef.fqdn, certId }, 'Reusing existing TLS certificate');

          // Deploy to HAProxy if available
          if (haproxyClient) {
            await this.haproxyCertDeployer.fetchAndDeployCertificate(
              certId, this.prisma, haproxyClient, {}
            );
          }
        } else {
          // Provision new certificate via ACME
          log.info({ fqdn: certDef.fqdn }, 'Provisioning new TLS certificate');
          const cert = await this.certLifecycleManager.issueCertificate(
            {
              primaryDomain: certDef.fqdn,
              domains: [certDef.fqdn],
              userId,
              deployToHaproxy: !!haproxyClient,
              haproxyContainerId: undefined,
            },
            (step, count, total) => {
              onProgress?.(`TLS ${certDef.fqdn}: ${step.step} (${count}/${total})`);
            },
          );
          certId = cert.id;
        }

        // Record in StackResource table
        await this.prisma.stackResource.upsert({
          where: {
            stackId_resourceType_resourceName: {
              stackId,
              resourceType: 'tls',
              resourceName: action.resourceName,
            },
          },
          create: {
            stackId,
            resourceType: 'tls',
            resourceName: action.resourceName,
            fqdn: certDef.fqdn,
            externalId: certId,
            externalState: { fqdn: certDef.fqdn },
            status: 'active',
          },
          update: {
            fqdn: certDef.fqdn,
            externalId: certId,
            externalState: { fqdn: certDef.fqdn },
            status: 'active',
            error: null,
          },
        });

        results.push({
          resourceType: 'tls',
          resourceName: action.resourceName,
          action: action.action,
          success: true,
        });
      } catch (err: any) {
        log.error({ err, fqdn: certDef.fqdn }, 'TLS reconciliation failed');
        results.push({
          resourceType: 'tls',
          resourceName: action.resourceName,
          action: action.action,
          success: false,
          error: err.message,
        });
      }
    }

    return results;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/stacks/stack-resource-reconciler.ts server/src/__tests__/stack-resource-reconciler.test.ts
git commit -m "feat: implement TLS certificate reconciliation"
```

---

### Task 6: Implement DNS Reconciliation

**Files:**
- Modify: `server/src/services/stacks/stack-resource-reconciler.ts`
- Modify: `server/src/__tests__/stack-resource-reconciler.test.ts`

- [ ] **Step 1: Write tests for DNS reconciliation**

Add to the test file:

```typescript
  describe('reconcileDns', () => {
    it('creates a new DNS A record in Cloudflare', async () => {
      mockCloudflareDns.upsertARecord.mockResolvedValue({
        id: 'cf-rec-1',
        name: 'api.example.com',
        type: 'A',
        content: '10.0.0.1',
      });
      mockPrisma.stackResource.upsert.mockResolvedValue({});

      const actions: ResourceAction[] = [
        { resourceType: 'dns', resourceName: 'api-dns', action: 'create', reason: 'New DNS record' },
      ];
      const definitions = {
        tlsCertificates: [],
        dnsRecords: [{ name: 'api-dns', fqdn: 'api.example.com', recordType: 'A' as const, target: '10.0.0.1' }],
        tunnelIngress: [],
      };

      const results = await reconciler.reconcileDns(actions, 'stack-1', definitions);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockCloudflareDns.upsertARecord).toHaveBeenCalledWith(
        'api.example.com', '10.0.0.1', 300, false
      );
    });

    it('updates an existing DNS record when target changes', async () => {
      mockCloudflareDns.upsertARecord.mockResolvedValue({
        id: 'cf-rec-1',
        name: 'api.example.com',
        type: 'A',
        content: '10.0.0.2',
      });
      mockPrisma.stackResource.upsert.mockResolvedValue({});

      const actions: ResourceAction[] = [
        { resourceType: 'dns', resourceName: 'api-dns', action: 'update', reason: 'Changed' },
      ];
      const definitions = {
        tlsCertificates: [],
        dnsRecords: [{ name: 'api-dns', fqdn: 'api.example.com', recordType: 'A' as const, target: '10.0.0.2', ttl: 600 }],
        tunnelIngress: [],
      };

      const results = await reconciler.reconcileDns(actions, 'stack-1', definitions);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockCloudflareDns.upsertARecord).toHaveBeenCalledWith(
        'api.example.com', '10.0.0.2', 600, false
      );
    });

    it('removes a DNS record from Cloudflare', async () => {
      mockPrisma.stackResource.findMany.mockResolvedValue([
        {
          resourceType: 'dns',
          resourceName: 'old-dns',
          fqdn: 'old.example.com',
          externalId: 'cf-rec-old',
          externalState: { zoneId: 'zone-1' },
        },
      ]);
      mockCloudflareDns.deleteDNSRecord.mockResolvedValue(undefined);
      mockPrisma.stackResource.deleteMany.mockResolvedValue({});

      const actions: ResourceAction[] = [
        { resourceType: 'dns', resourceName: 'old-dns', action: 'remove', reason: 'Removed' },
      ];
      const definitions = { tlsCertificates: [], dnsRecords: [], tunnelIngress: [] };

      const results = await reconciler.reconcileDns(actions, 'stack-1', definitions);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: FAIL — `reconcileDns` is not a function.

- [ ] **Step 3: Implement reconcileDns method**

Add to `StackResourceReconciler`:

```typescript
  /**
   * Reconcile DNS record resources via Cloudflare.
   */
  async reconcileDns(
    actions: ResourceAction[],
    stackId: string,
    definitions: ResourceDefinitions,
    onProgress?: (step: string) => void,
  ): Promise<ResourceResult[]> {
    const results: ResourceResult[] = [];
    const dnsActions = actions.filter(
      (a) => a.resourceType === 'dns' && a.action !== 'no-op'
    );

    for (const action of dnsActions) {
      const dnsDef = definitions.dnsRecords.find(
        (d) => d.name === action.resourceName
      );

      if (action.action === 'remove') {
        try {
          // Look up the external ID to delete from Cloudflare
          const resources = await this.prisma.stackResource.findMany({
            where: { stackId, resourceType: 'dns', resourceName: action.resourceName },
          });
          const resource = resources[0];
          if (resource?.externalId && resource.externalState?.zoneId) {
            await this.cloudflareDns.deleteDNSRecord(
              resource.externalState.zoneId,
              resource.externalId
            );
          }
          await this.prisma.stackResource.deleteMany({
            where: { stackId, resourceType: 'dns', resourceName: action.resourceName },
          });
          results.push({
            resourceType: 'dns',
            resourceName: action.resourceName,
            action: 'remove',
            success: true,
          });
        } catch (err: any) {
          log.error({ err }, 'DNS removal failed');
          results.push({
            resourceType: 'dns',
            resourceName: action.resourceName,
            action: 'remove',
            success: false,
            error: err.message,
          });
        }
        continue;
      }

      if (!dnsDef) continue;

      try {
        onProgress?.(`Configuring DNS record for ${dnsDef.fqdn}...`);

        const ttl = dnsDef.ttl ?? 300;
        const proxied = dnsDef.proxied ?? false;
        const record = await this.cloudflareDns.upsertARecord(
          dnsDef.fqdn,
          dnsDef.target,
          ttl,
          proxied
        );

        // Find the zone ID for cleanup later
        const zone = await this.cloudflareDns.findZoneForHostname(dnsDef.fqdn);

        await this.prisma.stackResource.upsert({
          where: {
            stackId_resourceType_resourceName: {
              stackId,
              resourceType: 'dns',
              resourceName: action.resourceName,
            },
          },
          create: {
            stackId,
            resourceType: 'dns',
            resourceName: action.resourceName,
            fqdn: dnsDef.fqdn,
            externalId: record.id,
            externalState: {
              fqdn: dnsDef.fqdn,
              recordType: dnsDef.recordType,
              target: dnsDef.target,
              ttl,
              proxied,
              zoneId: zone?.id ?? null,
            },
            status: 'active',
          },
          update: {
            fqdn: dnsDef.fqdn,
            externalId: record.id,
            externalState: {
              fqdn: dnsDef.fqdn,
              recordType: dnsDef.recordType,
              target: dnsDef.target,
              ttl,
              proxied,
              zoneId: zone?.id ?? null,
            },
            status: 'active',
            error: null,
          },
        });

        results.push({
          resourceType: 'dns',
          resourceName: action.resourceName,
          action: action.action,
          success: true,
        });
      } catch (err: any) {
        log.error({ err, fqdn: dnsDef.fqdn }, 'DNS reconciliation failed');
        results.push({
          resourceType: 'dns',
          resourceName: action.resourceName,
          action: action.action,
          success: false,
          error: err.message,
        });
      }
    }

    return results;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/stacks/stack-resource-reconciler.ts server/src/__tests__/stack-resource-reconciler.test.ts
git commit -m "feat: implement DNS record reconciliation"
```

---

### Task 7: Implement Tunnel Ingress Reconciliation

**Files:**
- Modify: `server/src/services/stacks/stack-resource-reconciler.ts`
- Modify: `server/src/__tests__/stack-resource-reconciler.test.ts`

- [ ] **Step 1: Write tests for tunnel reconciliation**

Add to the test file:

```typescript
  describe('reconcileTunnel', () => {
    it('creates a new tunnel ingress rule', async () => {
      mockPrisma.stackResource.upsert.mockResolvedValue({});

      const actions: ResourceAction[] = [
        { resourceType: 'tunnel', resourceName: 'api-tunnel', action: 'create', reason: 'New tunnel' },
      ];
      const definitions = {
        tlsCertificates: [],
        dnsRecords: [],
        tunnelIngress: [{ name: 'api-tunnel', fqdn: 'api.example.com', service: 'http://api:8080' }],
      };

      const results = await reconciler.reconcileTunnel(actions, 'stack-1', definitions);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(mockPrisma.stackResource.upsert).toHaveBeenCalled();
    });

    it('removes a tunnel ingress rule', async () => {
      mockPrisma.stackResource.deleteMany.mockResolvedValue({});

      const actions: ResourceAction[] = [
        { resourceType: 'tunnel', resourceName: 'old-tunnel', action: 'remove', reason: 'Removed' },
      ];
      const definitions = { tlsCertificates: [], dnsRecords: [], tunnelIngress: [] };

      const results = await reconciler.reconcileTunnel(actions, 'stack-1', definitions);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: FAIL — `reconcileTunnel` is not a function.

- [ ] **Step 3: Implement reconcileTunnel method**

Add to `StackResourceReconciler`. Note: Cloudflare tunnel API integration is stubbed — the method records the desired state in `StackResource` but the actual Cloudflare tunnel config API call is a placeholder for when the tunnel service is fully implemented:

```typescript
  /**
   * Reconcile Cloudflare tunnel ingress resources.
   * Records desired ingress rules. Actual Cloudflare tunnel API integration
   * will be connected when the tunnel service is fully implemented.
   */
  async reconcileTunnel(
    actions: ResourceAction[],
    stackId: string,
    definitions: ResourceDefinitions,
    onProgress?: (step: string) => void,
  ): Promise<ResourceResult[]> {
    const results: ResourceResult[] = [];
    const tunnelActions = actions.filter(
      (a) => a.resourceType === 'tunnel' && a.action !== 'no-op'
    );

    for (const action of tunnelActions) {
      const tunnelDef = definitions.tunnelIngress.find(
        (t) => t.name === action.resourceName
      );

      if (action.action === 'remove') {
        try {
          // TODO: Remove ingress rule from Cloudflare tunnel config when tunnel service is ready
          await this.prisma.stackResource.deleteMany({
            where: { stackId, resourceType: 'tunnel', resourceName: action.resourceName },
          });
          results.push({
            resourceType: 'tunnel',
            resourceName: action.resourceName,
            action: 'remove',
            success: true,
          });
        } catch (err: any) {
          results.push({
            resourceType: 'tunnel',
            resourceName: action.resourceName,
            action: 'remove',
            success: false,
            error: err.message,
          });
        }
        continue;
      }

      if (!tunnelDef) continue;

      try {
        onProgress?.(`Configuring tunnel ingress for ${tunnelDef.fqdn}...`);

        // TODO: Call Cloudflare tunnel API to add/update ingress rule when tunnel service is ready
        // For now, record the desired state so the plan/diff works correctly

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
            fqdn: tunnelDef.fqdn,
            externalId: null,
            externalState: {
              fqdn: tunnelDef.fqdn,
              service: tunnelDef.service,
            },
            status: 'active',
          },
          update: {
            fqdn: tunnelDef.fqdn,
            externalState: {
              fqdn: tunnelDef.fqdn,
              service: tunnelDef.service,
            },
            status: 'active',
            error: null,
          },
        });

        results.push({
          resourceType: 'tunnel',
          resourceName: action.resourceName,
          action: action.action,
          success: true,
        });
      } catch (err: any) {
        log.error({ err, fqdn: tunnelDef.fqdn }, 'Tunnel reconciliation failed');
        results.push({
          resourceType: 'tunnel',
          resourceName: action.resourceName,
          action: action.action,
          success: false,
          error: err.message,
        });
      }
    }

    return results;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/stacks/stack-resource-reconciler.ts server/src/__tests__/stack-resource-reconciler.test.ts
git commit -m "feat: implement tunnel ingress reconciliation (with Cloudflare API stub)"
```

---

### Task 8: Add Cleanup Method to Resource Reconciler

**Files:**
- Modify: `server/src/services/stacks/stack-resource-reconciler.ts`
- Modify: `server/src/__tests__/stack-resource-reconciler.test.ts`

- [ ] **Step 1: Write test for destroyAllResources**

Add to the test file:

```typescript
  describe('destroyAllResources', () => {
    it('removes all resources for a stack', async () => {
      mockPrisma.stackResource.findMany.mockResolvedValue([
        {
          id: 'res-1',
          stackId: 'stack-1',
          resourceType: 'tls',
          resourceName: 'api-cert',
          fqdn: 'api.example.com',
          externalId: 'cert-1',
          externalState: { fqdn: 'api.example.com' },
        },
        {
          id: 'res-2',
          stackId: 'stack-1',
          resourceType: 'dns',
          resourceName: 'api-dns',
          fqdn: 'api.example.com',
          externalId: 'cf-rec-1',
          externalState: { zoneId: 'zone-1', target: '10.0.0.1' },
        },
      ]);
      mockCloudflareDns.deleteDNSRecord.mockResolvedValue(undefined);
      mockPrisma.stackResource.deleteMany.mockResolvedValue({});

      await reconciler.destroyAllResources('stack-1');

      // DNS record should be deleted from Cloudflare
      expect(mockCloudflareDns.deleteDNSRecord).toHaveBeenCalledWith('zone-1', 'cf-rec-1');
      // All resources cleaned from DB
      expect(mockPrisma.stackResource.deleteMany).toHaveBeenCalledWith({
        where: { stackId: 'stack-1' },
      });
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: FAIL — `destroyAllResources` is not a function.

- [ ] **Step 3: Implement destroyAllResources**

Add to `StackResourceReconciler`:

```typescript
  /**
   * Destroy all resources for a stack.
   * TLS certs are left in the store (unbind only). DNS records are deleted from Cloudflare.
   * Tunnel ingress rules are removed.
   */
  async destroyAllResources(stackId: string): Promise<void> {
    const resources = await this.prisma.stackResource.findMany({
      where: { stackId },
    });

    for (const resource of resources) {
      try {
        if (resource.resourceType === 'dns' && resource.externalId && resource.externalState?.zoneId) {
          await this.cloudflareDns.deleteDNSRecord(
            resource.externalState.zoneId,
            resource.externalId
          );
        }
        // TODO: Remove tunnel ingress from Cloudflare when tunnel service is ready
        // TLS: no cleanup needed — cert stays in TLS store
      } catch (err) {
        log.warn({ err, resource: resource.resourceName }, 'Failed to clean up external resource during destroy');
      }
    }

    await this.prisma.stackResource.deleteMany({ where: { stackId } });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/stacks/stack-resource-reconciler.ts server/src/__tests__/stack-resource-reconciler.test.ts
git commit -m "feat: add destroyAllResources for stack cleanup"
```

---

### Task 9: Integrate Resource Reconciler into StackReconciler

**Files:**
- Modify: `server/src/services/stacks/stack-reconciler.ts`
- Modify: `server/src/services/stacks/utils.ts`
- Modify: `server/src/services/stacks/definition-hash.ts`

- [ ] **Step 1: Update StackReconciler constructor to accept resource reconciler**

In `stack-reconciler.ts`, add import and update the constructor (lines 42-51):

```typescript
import { StackResourceReconciler } from './stack-resource-reconciler';

export class StackReconciler {
  private containerManager: StackContainerManager;

  constructor(
    private dockerExecutor: DockerExecutorService,
    private prisma: PrismaClient,
    private routingManager?: StackRoutingManager,
    private resourceReconciler?: StackResourceReconciler
  ) {
    this.containerManager = new StackContainerManager(dockerExecutor);
  }
```

- [ ] **Step 2: Update plan() to include resourceActions**

In the `plan()` method, after loading the stack and before returning the plan:

After loading the stack (around line 106), add resource loading:

```typescript
    const currentResources = this.resourceReconciler
      ? await this.prisma.stackResource.findMany({ where: { stackId } })
      : [];
```

Before the return statement (around line 211), compute resource actions:

```typescript
    const resourceActions = this.resourceReconciler
      ? this.resourceReconciler.planResources(
          {
            tlsCertificates: (stack.tlsCertificates as any[]) ?? [],
            dnsRecords: (stack.dnsRecords as any[]) ?? [],
            tunnelIngress: (stack.tunnelIngress as any[]) ?? [],
          },
          currentResources
        )
      : [];
```

Update the return object to include `resourceActions`:

```typescript
    return {
      stackId,
      stackName: stack.name,
      stackVersion: stack.version,
      planTime: new Date().toISOString(),
      actions,
      resourceActions,
      hasChanges: actions.some((a) => a.action !== 'no-op') || resourceActions.some((a) => a.action !== 'no-op'),
      templateUpdateAvailable: /* existing logic */,
      warnings: /* existing logic */,
    };
```

- [ ] **Step 3: Update apply() to reconcile resources before services**

In the `apply()` method, after the networks/volumes creation block (around line 337) and before the service execution loop (around line 339), add resource reconciliation:

```typescript
    // Reconcile stack-level resources (TLS → DNS → Tunnels)
    const allResourceResults: ResourceResult[] = [];
    if (this.resourceReconciler && plan.resourceActions.some((a) => a.action !== 'no-op')) {
      const definitions = {
        tlsCertificates: (stack.tlsCertificates as any[]) ?? [],
        dnsRecords: (stack.dnsRecords as any[]) ?? [],
        tunnelIngress: (stack.tunnelIngress as any[]) ?? [],
      };

      // Get HAProxy client if environment has one
      let haproxyClient: HAProxyDataPlaneClient | null = null;
      if (stack.environmentId) {
        try {
          const envValidation = new EnvironmentValidationService();
          const haproxyCtx = await envValidation.getHAProxyEnvironmentContext(stack.environmentId);
          if (haproxyCtx) {
            haproxyClient = new HAProxyDataPlaneClient(haproxyCtx.haproxyContainerId);
          }
        } catch { /* no HAProxy available */ }
      }

      const progressCallback = (step: string) => {
        log.info({ stackId, step }, 'Resource reconciliation progress');
      };

      // TLS first (may need provisioning)
      const tlsResults = await this.resourceReconciler.reconcileTls(
        plan.resourceActions, stackId, definitions, haproxyClient,
        options?.triggeredBy ?? 'system', progressCallback
      );
      allResourceResults.push(...tlsResults);

      // Fail fast if TLS failed
      if (tlsResults.some((r) => !r.success)) {
        const failedTls = tlsResults.find((r) => !r.success);
        throw new Error(`TLS reconciliation failed: ${failedTls?.error}`);
      }

      // DNS second
      const dnsResults = await this.resourceReconciler.reconcileDns(
        plan.resourceActions, stackId, definitions, progressCallback
      );
      allResourceResults.push(...dnsResults);

      if (dnsResults.some((r) => !r.success)) {
        const failedDns = dnsResults.find((r) => !r.success);
        throw new Error(`DNS reconciliation failed: ${failedDns?.error}`);
      }

      // Tunnel ingress third
      const tunnelResults = await this.resourceReconciler.reconcileTunnel(
        plan.resourceActions, stackId, definitions, progressCallback
      );
      allResourceResults.push(...tunnelResults);

      if (tunnelResults.some((r) => !r.success)) {
        const failedTunnel = tunnelResults.find((r) => !r.success);
        throw new Error(`Tunnel reconciliation failed: ${failedTunnel?.error}`);
      }
    }
```

Update the return of `apply()` to include `resourceResults`:

```typescript
    return {
      success: serviceResults.every((r) => r.success),
      stackId,
      appliedVersion: stack.version,
      serviceResults,
      resourceResults: allResourceResults,
      duration: Date.now() - startTime,
    };
```

Also update the `StackDeployment` create to include `resourceResults`:

```typescript
    await this.prisma.stackDeployment.create({
      data: {
        stackId,
        action: 'apply',
        success: /* ... */,
        version: stack.version,
        status: /* ... */,
        duration: /* ... */,
        serviceResults: serviceResults as any,
        resourceResults: allResourceResults as any,
        triggeredBy: options?.triggeredBy,
      },
    });
```

- [ ] **Step 4: Update destroyStack() to clean up resources**

In `destroyStack()` (around line 613), before the container removal loop, add:

```typescript
    // Clean up stack-level resources
    if (this.resourceReconciler) {
      await this.resourceReconciler.destroyAllResources(stackId);
    }
```

- [ ] **Step 5: Update buildStateMachineContext to use stack-level TLS**

In `buildStateMachineContext()` (around line 853), update how TLS is resolved. Instead of reading `routing.enableSsl` and `routing.tlsCertificateId` directly, look up the cert from the StackResource table:

```typescript
    // Resolve TLS from stack-level resource if referenced
    let enableSsl = false;
    let tlsCertificateId: string | undefined;

    if (routing.tlsCertificate) {
      const tlsResource = await this.prisma.stackResource.findFirst({
        where: { stackId, resourceType: 'tls', resourceName: routing.tlsCertificate },
      });
      if (tlsResource?.externalId) {
        enableSsl = true;
        tlsCertificateId = tlsResource.externalId;
      }
    }
```

Then use `enableSsl` and `tlsCertificateId` in the returned context instead of `routing.enableSsl` and `routing.tlsCertificateId`.

- [ ] **Step 6: Update definition hash to include resources**

In `definition-hash.ts`, the `computeDefinitionHash` function operates per-service and doesn't need to change. However, update the plan's `hasChanges` check so resource changes trigger a version bump. This is already handled in step 2 above.

- [ ] **Step 7: Update serializeStack in utils.ts**

In `server/src/services/stacks/utils.ts`, update the `serializeStack` function (around line 21) to include the new resource arrays:

```typescript
export function serializeStack(stack: any): StackInfo {
  return {
    // ... existing fields ...
    tlsCertificates: stack.tlsCertificates ?? [],
    dnsRecords: stack.dnsRecords ?? [],
    tunnelIngress: stack.tunnelIngress ?? [],
    // ... rest of existing fields ...
  };
}
```

- [ ] **Step 8: Build and verify**

Run: `npm run build -w lib && npm run build -w server`
Expected: Clean build.

- [ ] **Step 9: Commit**

```bash
git add server/src/services/stacks/stack-reconciler.ts server/src/services/stacks/utils.ts server/src/services/stacks/definition-hash.ts
git commit -m "feat: integrate resource reconciler into stack plan/apply/destroy"
```

---

### Task 10: Update Stack API Routes

**Files:**
- Modify: `server/src/routes/stacks.ts`

- [ ] **Step 1: Read the current stacks route file**

Read `server/src/routes/stacks.ts` to understand how the reconciler is instantiated and passed to routes.

- [ ] **Step 2: Update reconciler construction to pass resource reconciler**

Where the `StackReconciler` is instantiated, create a `StackResourceReconciler` and pass it:

```typescript
import { StackResourceReconciler } from '../services/stacks/stack-resource-reconciler';
import { CertificateLifecycleManager } from '../services/tls/certificate-lifecycle-manager';
import { CloudflareDNSService } from '../services/cloudflare/cloudflare-dns';
import { HaproxyCertificateDeployer } from '../services/haproxy/haproxy-certificate-deployer';

// Where reconciler is created:
const resourceReconciler = new StackResourceReconciler(
  prisma,
  new CertificateLifecycleManager(prisma),
  new CloudflareDNSService(),
  new HaproxyCertificateDeployer(),
);

const reconciler = new StackReconciler(
  dockerExecutor,
  prisma,
  routingManager,
  resourceReconciler,
);
```

Note: The exact code depends on how services are currently instantiated in the route file. Read the file first and follow the existing pattern.

- [ ] **Step 3: Update create/update stack routes to accept resource arrays**

In the POST `/api/stacks` handler, ensure the `tlsCertificates`, `dnsRecords`, and `tunnelIngress` fields from the request body are saved to the stack:

```typescript
    const stack = await prisma.stack.create({
      data: {
        // ... existing fields ...
        tlsCertificates: body.tlsCertificates ?? [],
        dnsRecords: body.dnsRecords ?? [],
        tunnelIngress: body.tunnelIngress ?? [],
        // ... rest ...
      },
    });
```

Do the same for the PUT `/api/stacks/:stackId` handler.

- [ ] **Step 4: Update plan response to include resourceActions**

The plan route should already return the full `StackPlan` which now includes `resourceActions`. Verify this is serialized in the response.

- [ ] **Step 5: Build and verify**

Run: `npm run build -w server`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/stacks.ts
git commit -m "feat: wire resource reconciler into stack API routes"
```

---

### Task 11: Update Existing Tests

**Files:**
- Modify: `server/src/__tests__/stack-reconciler-plan.test.ts`
- Modify: `server/src/__tests__/stack-reconciler-apply.test.ts`

- [ ] **Step 1: Update plan test factories to include resource fields**

In `stack-reconciler-plan.test.ts`, update `makeStackRow` to include the new columns:

```typescript
function makeStackRow(serviceOverrides: any[] = []) {
  return {
    // ... existing fields ...
    tlsCertificates: [],
    dnsRecords: [],
    tunnelIngress: [],
    // ... rest of existing fields ...
  };
}
```

- [ ] **Step 2: Update plan test assertions for resourceActions**

In each plan test, update assertions to expect `resourceActions` in the result:

```typescript
expect(plan.resourceActions).toEqual([]);
```

For tests that don't involve resources, this should be an empty array.

- [ ] **Step 3: Update apply test factories similarly**

In `stack-reconciler-apply.test.ts`, update `makeStackRow` with the same resource fields.

- [ ] **Step 4: Update apply test assertions for resourceResults**

Update apply result assertions to include `resourceResults`:

```typescript
expect(result.resourceResults).toEqual([]);
```

- [ ] **Step 5: Add Prisma mock for stackResource in tests**

Add `stackResource` to the mock Prisma object:

```typescript
const mockPrisma = {
  stack: { /* existing */ },
  stackDeployment: { /* existing */ },
  stackResource: {
    findMany: vi.fn().mockResolvedValue([]),
  },
} as any;
```

- [ ] **Step 6: Run all stack tests**

Run: `npx -w server vitest run src/__tests__/stack-reconciler`
Expected: All existing tests PASS with updated assertions.

- [ ] **Step 7: Commit**

```bash
git add server/src/__tests__/stack-reconciler-plan.test.ts server/src/__tests__/stack-reconciler-apply.test.ts
git commit -m "test: update existing stack tests for resource fields"
```

---

### Task 12: Add Integration Tests for Resource Plan/Apply

**Files:**
- Modify: `server/src/__tests__/stack-reconciler-plan.test.ts`
- Modify: `server/src/__tests__/stack-reconciler-apply.test.ts`

- [ ] **Step 1: Add plan test with resource actions**

In the plan test file, add a new test:

```typescript
  it('plans resource actions for TLS and DNS', async () => {
    const stack = makeStackRow([{ serviceName: 'api', serviceType: 'StatelessWeb', routing: { hostname: 'api.example.com', listeningPort: 8080, tlsCertificate: 'api-cert', dnsRecord: 'api-dns' } }]);
    stack.tlsCertificates = [{ name: 'api-cert', fqdn: 'api.example.com' }];
    stack.dnsRecords = [{ name: 'api-dns', fqdn: 'api.example.com', recordType: 'A', target: '10.0.0.1' }];
    mockFindUniqueOrThrow.mockResolvedValue(stack);
    mockListContainers.mockResolvedValue([]);

    // Create reconciler with resource reconciler
    const mockResourceReconciler = {
      planResources: vi.fn().mockReturnValue([
        { resourceType: 'tls', resourceName: 'api-cert', action: 'create', reason: 'New TLS certificate' },
        { resourceType: 'dns', resourceName: 'api-dns', action: 'create', reason: 'New DNS record' },
      ]),
    } as any;
    const reconcilerWithResources = new StackReconciler(mockDockerExecutor, mockPrisma, undefined, mockResourceReconciler);

    const plan = await reconcilerWithResources.plan('stack-1');

    expect(plan.resourceActions).toHaveLength(2);
    expect(plan.resourceActions[0].resourceType).toBe('tls');
    expect(plan.resourceActions[1].resourceType).toBe('dns');
    expect(plan.hasChanges).toBe(true);
  });
```

- [ ] **Step 2: Run plan tests**

Run: `npx -w server vitest run src/__tests__/stack-reconciler-plan.test.ts`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/stack-reconciler-plan.test.ts server/src/__tests__/stack-reconciler-apply.test.ts
git commit -m "test: add integration tests for resource plan/apply"
```

---

### Task 13: Validate Resource References in Plan

**Files:**
- Modify: `server/src/services/stacks/stack-resource-reconciler.ts`
- Modify: `server/src/__tests__/stack-resource-reconciler.test.ts`

- [ ] **Step 1: Write test for resource reference validation**

Add to the test file:

```typescript
  describe('validateResourceReferences', () => {
    it('returns warnings for services referencing non-existent resources', () => {
      const definitions = {
        tlsCertificates: [{ name: 'api-cert', fqdn: 'api.example.com' }],
        dnsRecords: [],
        tunnelIngress: [],
      };
      const services = [
        {
          serviceName: 'api',
          routing: { hostname: 'api.example.com', listeningPort: 8080, tlsCertificate: 'api-cert', dnsRecord: 'missing-dns' },
        },
      ];

      const warnings = reconciler.validateResourceReferences(definitions, services as any);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('missing-dns');
    });

    it('returns no warnings for valid references', () => {
      const definitions = {
        tlsCertificates: [{ name: 'api-cert', fqdn: 'api.example.com' }],
        dnsRecords: [{ name: 'api-dns', fqdn: 'api.example.com', recordType: 'A' as const, target: '10.0.0.1' }],
        tunnelIngress: [],
      };
      const services = [
        {
          serviceName: 'api',
          routing: { hostname: 'api.example.com', listeningPort: 8080, tlsCertificate: 'api-cert', dnsRecord: 'api-dns' },
        },
      ];

      const warnings = reconciler.validateResourceReferences(definitions, services as any);
      expect(warnings).toHaveLength(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: FAIL — `validateResourceReferences` is not a function.

- [ ] **Step 3: Implement validateResourceReferences**

Add to `StackResourceReconciler`:

```typescript
  /**
   * Validate that services reference resources that exist in the stack definition.
   */
  validateResourceReferences(
    definitions: ResourceDefinitions,
    services: Array<{ serviceName: string; routing?: { tlsCertificate?: string; dnsRecord?: string; tunnelIngress?: string } }>
  ): PlanWarning[] {
    const warnings: PlanWarning[] = [];

    const tlsNames = new Set(definitions.tlsCertificates.map((c) => c.name));
    const dnsNames = new Set(definitions.dnsRecords.map((d) => d.name));
    const tunnelNames = new Set(definitions.tunnelIngress.map((t) => t.name));

    for (const svc of services) {
      if (!svc.routing) continue;

      if (svc.routing.tlsCertificate && !tlsNames.has(svc.routing.tlsCertificate)) {
        warnings.push({
          type: 'resource-reference',
          serviceName: svc.serviceName,
          resourceName: svc.routing.tlsCertificate,
          resourceType: 'tls',
          message: `Service "${svc.serviceName}" references TLS certificate "${svc.routing.tlsCertificate}" which is not defined in the stack`,
        } as any);
      }

      if (svc.routing.dnsRecord && !dnsNames.has(svc.routing.dnsRecord)) {
        warnings.push({
          type: 'resource-reference',
          serviceName: svc.serviceName,
          resourceName: svc.routing.dnsRecord,
          resourceType: 'dns',
          message: `Service "${svc.serviceName}" references DNS record "${svc.routing.dnsRecord}" which is not defined in the stack`,
        } as any);
      }

      if (svc.routing.tunnelIngress && !tunnelNames.has(svc.routing.tunnelIngress)) {
        warnings.push({
          type: 'resource-reference',
          serviceName: svc.serviceName,
          resourceName: svc.routing.tunnelIngress,
          resourceType: 'tunnel',
          message: `Service "${svc.serviceName}" references tunnel ingress "${svc.routing.tunnelIngress}" which is not defined in the stack`,
        } as any);
      }
    }

    return warnings;
  }
```

Note: You'll also want to add a `ResourceReferenceWarning` type to `lib/types/stacks.ts` and include it in the `PlanWarning` union:

```typescript
export interface ResourceReferenceWarning {
  type: 'resource-reference';
  serviceName: string;
  resourceName: string;
  resourceType: ResourceType;
  message: string;
}

export type PlanWarning = PortConflictWarning | NameConflictWarning | ResourceReferenceWarning;
```

- [ ] **Step 4: Wire validation into plan() in stack-reconciler.ts**

In the `plan()` method, after computing resource actions, call validation and add warnings:

```typescript
    if (this.resourceReconciler) {
      const resourceWarnings = this.resourceReconciler.validateResourceReferences(
        {
          tlsCertificates: (stack.tlsCertificates as any[]) ?? [],
          dnsRecords: (stack.dnsRecords as any[]) ?? [],
          tunnelIngress: (stack.tunnelIngress as any[]) ?? [],
        },
        stack.services.map(toServiceDefinition)
      );
      warnings.push(...resourceWarnings);
    }
```

- [ ] **Step 5: Run all tests**

Run: `npx -w server vitest run src/__tests__/stack-resource-reconciler.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Build and verify**

Run: `npm run build -w lib && npm run build -w server`
Expected: Clean build.

- [ ] **Step 7: Commit**

```bash
git add lib/types/stacks.ts server/src/services/stacks/stack-resource-reconciler.ts server/src/services/stacks/stack-reconciler.ts server/src/__tests__/stack-resource-reconciler.test.ts
git commit -m "feat: validate resource references in plan phase"
```

---

### Task 14: Run Full Test Suite and Fix Issues

**Files:**
- Various (fix any test failures)

- [ ] **Step 1: Build the shared types package**

Run: `npm run build -w lib`
Expected: Clean build.

- [ ] **Step 2: Run the full server test suite**

Run: `npm test -w server`
Expected: All tests pass. If any fail, investigate and fix.

- [ ] **Step 3: Fix any test failures**

Common issues to look for:
- Tests that assert on `StackPlan` shape but don't include `resourceActions`
- Tests that assert on `ApplyResult` shape but don't include `resourceResults`
- Tests that mock `StackServiceRouting` with old fields (`enableSsl`, `tlsCertificateId`, `dns`)
- Prisma mock missing `stackResource` property

Fix each failure by updating the test data or assertions to match the new types.

- [ ] **Step 4: Run the full test suite again**

Run: `npm test -w server`
Expected: All tests PASS.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from stack resource type changes"
```
