# State Machine Integration for Stack StatelessWeb Deployments

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the procedural `applyStatelessWeb()` in the stack reconciler with the existing xstate deployment state machines so stack deployments get formal rollback chains, timeouts, and drain monitoring.

**Architecture:** Refactor 4 action classes to read config from context instead of doing Prisma DB lookups, then have the stack reconciler create xstate actors directly in `applyStatelessWeb()`. Legacy deployment orchestrator populates the same new context fields from `DeploymentConfig` so its behavior is unchanged.

**Tech Stack:** xstate v5, TypeScript, Vitest, Prisma

---

### Task 1: Add Source-Agnostic Context Fields to State Machine Types

**Files:**
- Modify: `server/src/services/haproxy/initial-deployment-state-machine.ts:37-78`
- Modify: `server/src/services/haproxy/blue-green-deployment-state-machine.ts:44-92`

- [ ] **Step 1: Add new fields to `InitialDeploymentContext`**

In `server/src/services/haproxy/initial-deployment-state-machine.ts`, add these fields to the `InitialDeploymentContext` interface after the existing `config?: DeploymentConfig` field:

```typescript
    // Source-agnostic configuration (used by actions instead of DB lookups)
    // When set, actions read from these fields directly.
    // When unset, actions fall back to context.config / DB lookups for backwards compatibility.
    hostname?: string;
    enableSsl?: boolean;
    tlsCertificateId?: string;
    certificateStatus?: string;
    networkType?: string;
    healthCheckEndpoint?: string;
    healthCheckInterval?: number;
    healthCheckRetries?: number;
    containerPorts?: { containerPort: number; hostPort: number; protocol: string }[];
    containerVolumes?: string[];
    containerEnvironment?: Record<string, string>;
    containerLabels?: Record<string, string>;
    containerNetworks?: string[];
```

- [ ] **Step 2: Add the same fields to `BlueGreenDeploymentContext`**

In `server/src/services/haproxy/blue-green-deployment-state-machine.ts`, add the identical block of fields to the `BlueGreenDeploymentContext` interface after the `config?: any` field.

- [ ] **Step 3: Wire new fields into context initialization for initial deployment machine**

In `initial-deployment-state-machine.ts`, inside the `context: ({ input })` factory function (around line 313), add the new fields to the returned object after the existing `config` field:

```typescript
        // Source-agnostic configuration
        hostname: deploymentInput?.hostname,
        enableSsl: deploymentInput?.enableSsl,
        tlsCertificateId: deploymentInput?.tlsCertificateId,
        certificateStatus: deploymentInput?.certificateStatus,
        networkType: deploymentInput?.networkType,
        healthCheckEndpoint: deploymentInput?.healthCheckEndpoint,
        healthCheckInterval: deploymentInput?.healthCheckInterval,
        healthCheckRetries: deploymentInput?.healthCheckRetries,
        containerPorts: deploymentInput?.containerPorts,
        containerVolumes: deploymentInput?.containerVolumes,
        containerEnvironment: deploymentInput?.containerEnvironment,
        containerLabels: deploymentInput?.containerLabels,
        containerNetworks: deploymentInput?.containerNetworks,
```

- [ ] **Step 4: Wire new fields into context initialization for blue-green deployment machine**

In `blue-green-deployment-state-machine.ts`, inside the `context: ({ input })` factory function, add the same fields to the returned object.

- [ ] **Step 5: Verify build passes**

Run: `npm run build:lib && npm run build -w server 2>&1 | tail -20`
Expected: Build succeeds with no type errors (new fields are all optional).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/haproxy/initial-deployment-state-machine.ts server/src/services/haproxy/blue-green-deployment-state-machine.ts
git commit -m "feat: add source-agnostic context fields to deployment state machine types

These optional fields allow actions to read configuration directly from
context instead of doing Prisma DB lookups, enabling reuse by the stack
reconciler while maintaining backwards compatibility for legacy deployments."
```

---

### Task 2: Make `DeployApplicationContainers` Source-Agnostic

**Files:**
- Modify: `server/src/services/haproxy/actions/deploy-application-containers.ts`
- Test: `server/src/__tests__/action-source-agnostic.test.ts`

- [ ] **Step 1: Write failing test for source-agnostic container deployment**

Create `server/src/__tests__/action-source-agnostic.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ContainerLifecycleManager
const mockCreateContainer = vi.fn().mockResolvedValue('new-container-id');
const mockStartContainer = vi.fn().mockResolvedValue(undefined);
const mockCaptureContainerForDeployment = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/container', () => ({
  ContainerLifecycleManager: vi.fn().mockImplementation(() => ({
    createContainer: mockCreateContainer,
    startContainer: mockStartContainer,
    captureContainerForDeployment: mockCaptureContainerForDeployment,
  })),
}));

vi.mock('../lib/prisma', () => ({
  default: {
    userEvent: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../services/user-events', () => ({
  UserEventService: vi.fn().mockImplementation(() => ({
    appendLogs: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { DeployApplicationContainers } from '../services/haproxy/actions/deploy-application-containers';

describe('DeployApplicationContainers - source-agnostic', () => {
  let action: DeployApplicationContainers;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new DeployApplicationContainers();
  });

  it('should use containerNetworks from context when config.containerConfig is absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      dockerImage: 'myapp/web:1.0.0',
      environmentId: 'env-1',
      environmentName: 'prod',
      haproxyNetworkName: 'haproxy-net',
      haproxyContainerId: 'haproxy-abc123',
      containerNetworks: ['haproxy-net', 'app-network'],
      containerEnvironment: { NODE_ENV: 'production' },
      containerLabels: { 'mini-infra.stack-id': 'stack-1' },
      containerPorts: [{ containerPort: 3000, hostPort: 0, protocol: 'tcp' }],
      containerVolumes: [],
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DEPLOYMENT_SUCCESS');
    expect(events[0].containerId).toBe('new-container-id');

    // Verify the createContainer call used context fields
    const createCall = mockCreateContainer.mock.calls[0][0];
    expect(createCall.config.networks).toContain('haproxy-net');
    expect(createCall.config.networks).toContain('app-network');
  });

  it('should fall back to config.containerConfig when context fields are absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'legacy-app',
      dockerImage: 'legacy/app:2.0',
      environmentId: 'env-1',
      environmentName: 'prod',
      haproxyNetworkName: 'haproxy-net',
      haproxyContainerId: 'haproxy-abc123',
      config: {
        containerConfig: {
          ports: [],
          volumes: [],
          environment: [],
          labels: {},
          networks: ['haproxy-net'],
        },
      },
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DEPLOYMENT_SUCCESS');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx -w server vitest run src/__tests__/action-source-agnostic.test.ts 2>&1 | tail -20`
Expected: FAIL — the action currently requires `context.config.containerConfig` or throws when building container config without it.

- [ ] **Step 3: Update `DeployApplicationContainers.execute()` to read from context fields first**

In `server/src/services/haproxy/actions/deploy-application-containers.ts`, replace the container config construction block (around lines 39-50) with:

```typescript
            // Build container configuration - prefer source-agnostic context fields,
            // fall back to config.containerConfig for legacy callers
            const containerConfig: ContainerConfig = context.config?.containerConfig ?? {
                ports: context.containerPorts ?? [],
                volumes: context.containerVolumes ?? [],
                environment: context.containerEnvironment
                    ? Object.entries(context.containerEnvironment).map(([k, v]) => `${k}=${v}`)
                    : [],
                labels: context.containerLabels ?? {},
                networks: context.containerNetworks ?? [context.haproxyNetworkName],
            };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx -w server vitest run src/__tests__/action-source-agnostic.test.ts 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/haproxy/actions/deploy-application-containers.ts server/src/__tests__/action-source-agnostic.test.ts
git commit -m "feat: make DeployApplicationContainers source-agnostic

Read container config from flat context fields (containerNetworks,
containerEnvironment, etc.) with fallback to config.containerConfig
for backwards compatibility with legacy deployments."
```

---

### Task 3: Make `AddContainerToLB` Source-Agnostic

**Files:**
- Modify: `server/src/services/haproxy/actions/add-container-to-lb.ts`
- Modify: `server/src/__tests__/action-source-agnostic.test.ts`

- [ ] **Step 1: Write failing test for source-agnostic health check config**

Append to `server/src/__tests__/action-source-agnostic.test.ts`:

```typescript
// Add mock for HAProxyDataPlaneClient at the top of the file
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockGetBackend = vi.fn().mockResolvedValue(null);
const mockCreateBackend = vi.fn().mockResolvedValue(undefined);
const mockAddServer = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/haproxy/haproxy-dataplane-client', () => ({
  HAProxyDataPlaneClient: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    getBackend: mockGetBackend,
    createBackend: mockCreateBackend,
    addServer: mockAddServer,
  })),
}));

import { AddContainerToLB } from '../services/haproxy/actions/add-container-to-lb';

describe('AddContainerToLB - source-agnostic', () => {
  let action: AddContainerToLB;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new AddContainerToLB();
  });

  it('should use healthCheck fields from context when config.healthCheck is absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      containerId: 'container-abc12345',
      containerName: 'prod-myapp-web',
      containerPort: 3000,
      environmentId: 'env-1',
      environmentName: 'prod',
      haproxyNetworkName: 'haproxy-net',
      haproxyContainerId: 'haproxy-abc123',
      healthCheckEndpoint: '/healthz',
      healthCheckInterval: 5000,
      healthCheckRetries: 3,
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('LB_CONFIGURED');

    // Verify the addServer call used context health check fields
    const serverConfig = mockAddServer.mock.calls[0][1];
    expect(serverConfig.check_path).toBe('/healthz');
    expect(serverConfig.inter).toBe(5000);
    expect(serverConfig.rise).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx -w server vitest run src/__tests__/action-source-agnostic.test.ts 2>&1 | tail -20`
Expected: FAIL — the action currently throws `'Health check configuration is required for server setup'` when `context.config?.healthCheck` is missing.

- [ ] **Step 3: Update `AddContainerToLB.execute()` to read health check config from context fields first**

In `server/src/services/haproxy/actions/add-container-to-lb.ts`, replace the health check validation and extraction (around lines 43-45 and 90-93) with:

```typescript
            // Health check configuration - prefer source-agnostic context fields,
            // fall back to config.healthCheck for legacy callers
            const healthCheckEndpoint = context.healthCheckEndpoint
                ?? context.config?.healthCheck?.endpoint
                ?? '/health';
            const healthCheckInterval = context.healthCheckInterval
                ?? context.config?.healthCheck?.interval
                ?? 2000;
            const healthCheckRetries = context.healthCheckRetries
                ?? context.config?.healthCheck?.retries
                ?? 2;

            if (!context.healthCheckEndpoint && !context.config?.healthCheck) {
                logger.info({
                    deploymentId: context.deploymentId,
                }, 'No explicit health check config, using defaults');
            }
```

Remove the old validation that throws when `context.config?.healthCheck` is missing. Then update the `serverConfig` construction to use the new variables:

```typescript
            const serverConfig: ServerConfig = {
                name: serverName,
                address: serverAddress,
                port: context.containerPort,
                check: 'enabled',
                check_path: healthCheckEndpoint,
                inter: healthCheckInterval,
                rise: Math.max(2, healthCheckRetries),
                fall: 3,
                weight: 100,
                enabled: true,
                maintenance: 'disabled'
            };
```

Also make `deploymentConfigId` optional in the DB upsert by changing the create block's `deploymentConfigId` line to:

```typescript
                            deploymentConfigId: context.deploymentConfigId ?? null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx -w server vitest run src/__tests__/action-source-agnostic.test.ts 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/haproxy/actions/add-container-to-lb.ts server/src/__tests__/action-source-agnostic.test.ts
git commit -m "feat: make AddContainerToLB source-agnostic

Read health check config from flat context fields (healthCheckEndpoint,
healthCheckInterval, healthCheckRetries) with fallback to config.healthCheck
and sensible defaults. deploymentConfigId is now optional for DB records."
```

---

### Task 4: Make `ConfigureFrontend` Source-Agnostic

**Files:**
- Modify: `server/src/services/haproxy/actions/configure-frontend.ts`
- Modify: `server/src/__tests__/action-source-agnostic.test.ts`

- [ ] **Step 1: Write failing test for source-agnostic frontend config**

Append to `server/src/__tests__/action-source-agnostic.test.ts`. You will need to add mocks for the `haproxyFrontendManager` at the top:

```typescript
const mockGetOrCreateSharedFrontend = vi.fn().mockResolvedValue({
  id: 'shared-fe-1',
  frontendName: 'fe_env1_http',
});
const mockAddRouteToSharedFrontend = vi.fn().mockResolvedValue({
  id: 'route-1',
});

vi.mock('../services/haproxy/haproxy-frontend-manager', () => ({
  haproxyFrontendManager: {
    getOrCreateSharedFrontend: mockGetOrCreateSharedFrontend,
    addRouteToSharedFrontend: mockAddRouteToSharedFrontend,
  },
}));

import { ConfigureFrontend } from '../services/haproxy/actions/configure-frontend';

describe('ConfigureFrontend - source-agnostic', () => {
  let action: ConfigureFrontend;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock getBackend to return a backend for the check
    mockGetBackend.mockResolvedValue({ name: 'stk-myapp-web' });
    action = new ConfigureFrontend();
  });

  it('should use hostname from context when deploymentConfigId is absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
      haproxyContainerId: 'haproxy-abc123',
      hostname: 'app.example.com',
      enableSsl: false,
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('FRONTEND_CONFIGURED');
    expect(events[0].hostname).toBe('app.example.com');
  });

  it('should skip when no hostname in context and no deploymentConfigId', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
      haproxyContainerId: 'haproxy-abc123',
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('FRONTEND_CONFIG_SKIPPED');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx -w server vitest run src/__tests__/action-source-agnostic.test.ts 2>&1 | tail -20`
Expected: FAIL — the action currently throws `'Deployment config ID is required for frontend configuration'`.

- [ ] **Step 3: Refactor `ConfigureFrontend.execute()` to read from context first, fall back to DB**

Replace the validation and DB lookup section (lines 32-81) with:

```typescript
      // Resolve configuration - prefer context fields, fall back to DB lookup
      let hostname: string | undefined;
      let enableSsl: boolean | undefined;
      let tlsCertificateId: string | null | undefined;
      let certificateStatus: string | null | undefined;
      let sourceType: string = 'deployment';
      let sourceId: string | undefined = context.deploymentConfigId;

      if (context.hostname) {
        // Source-agnostic path: read from context directly
        hostname = context.hostname;
        enableSsl = context.enableSsl ?? false;
        tlsCertificateId = context.tlsCertificateId;
        certificateStatus = context.certificateStatus;
        sourceType = context.deploymentConfigId ? 'deployment' : 'stack';
        sourceId = context.deploymentConfigId ?? context.deploymentId;
      } else if (context.deploymentConfigId) {
        // Legacy path: look up from database
        const deploymentConfig = await prisma.deploymentConfiguration.findUnique({
          where: { id: context.deploymentConfigId },
          include: { environment: true },
        });

        if (!deploymentConfig) {
          throw new Error(`Deployment configuration not found: ${context.deploymentConfigId}`);
        }

        if (!deploymentConfig.hostname) {
          sendEvent({ type: "FRONTEND_CONFIG_SKIPPED", message: "No hostname configured" });
          return;
        }

        hostname = deploymentConfig.hostname;
        enableSsl = deploymentConfig.enableSsl;
        tlsCertificateId = deploymentConfig.tlsCertificateId;
        certificateStatus = deploymentConfig.certificateStatus;
      } else {
        // No config available — skip
        sendEvent({ type: "FRONTEND_CONFIG_SKIPPED", message: "No hostname configured" });
        return;
      }
```

Then update the rest of the method to use these local variables instead of `deploymentConfig.*`. The `hasSslCertificate` check becomes:

```typescript
      const hasSslCertificate = Boolean(enableSsl && tlsCertificateId && certificateStatus === "ACTIVE");
```

The `addRouteToSharedFrontend` call changes to use `sourceType` and `sourceId`:

```typescript
      const route = await haproxyFrontendManager.addRouteToSharedFrontend(
        sharedFrontend.id,
        hostname,
        backendName,
        sourceType,
        sourceId!,
        this.haproxyClient,
        prisma,
        {
          useSSL: hasSslCertificate,
          tlsCertificateId: hasSslCertificate ? (tlsCertificateId ?? undefined) : undefined,
        }
      );
```

The existing frontend cleanup block (lines 187-208 checking `prisma.hAProxyFrontend`) should be wrapped in `if (context.deploymentConfigId)` since it only applies to legacy deployments.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx -w server vitest run src/__tests__/action-source-agnostic.test.ts 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Verify existing tests still pass**

Run: `npx -w server vitest run src/__tests__/stack-reconciler-apply-stateless.test.ts 2>&1 | tail -20`
Expected: PASS (unchanged behavior for existing code paths)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/haproxy/actions/configure-frontend.ts server/src/__tests__/action-source-agnostic.test.ts
git commit -m "feat: make ConfigureFrontend source-agnostic

Read hostname, SSL config from context fields when available. Falls back
to DeploymentConfiguration DB lookup for legacy callers. Skips gracefully
when neither context fields nor deploymentConfigId are present."
```

---

### Task 5: Make `ConfigureDNS` Source-Agnostic

**Files:**
- Modify: `server/src/services/haproxy/actions/configure-dns.ts`
- Modify: `server/src/__tests__/action-source-agnostic.test.ts`

- [ ] **Step 1: Write failing test for source-agnostic DNS config**

Append to `server/src/__tests__/action-source-agnostic.test.ts`. Add mocks for the DNS dependencies:

```typescript
const mockUpsertARecord = vi.fn().mockResolvedValue(undefined);
const mockFindZoneForHostname = vi.fn().mockResolvedValue({ id: 'zone-1' });
const mockGetAppropriateIPForEnvironment = vi.fn().mockResolvedValue('192.168.1.100');

vi.mock('../services/cloudflare', () => ({
  cloudflareDNSService: {
    upsertARecord: mockUpsertARecord,
    findZoneForHostname: mockFindZoneForHostname,
  },
}));

vi.mock('../services/network-utils', () => ({
  networkUtils: {
    getAppropriateIPForEnvironment: mockGetAppropriateIPForEnvironment,
  },
}));

import { ConfigureDNS } from '../services/haproxy/actions/configure-dns';

describe('ConfigureDNS - source-agnostic', () => {
  let action: ConfigureDNS;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new ConfigureDNS();
  });

  it('should configure DNS using context fields when deploymentConfigId is absent', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
      hostname: 'app.example.com',
      networkType: 'local',
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DNS_CONFIGURED');
    expect(mockUpsertARecord).toHaveBeenCalledWith('app.example.com', '192.168.1.100', 300, false);
  });

  it('should skip DNS when networkType is internet', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
      hostname: 'app.example.com',
      networkType: 'internet',
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DNS_CONFIG_SKIPPED');
  });

  it('should skip DNS when no hostname and no deploymentConfigId', async () => {
    const events: any[] = [];
    const context = {
      deploymentId: 'deploy-1',
      applicationName: 'stk-myapp-web',
      environmentId: 'env-1',
    };

    await action.execute(context, (event: any) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DNS_CONFIG_SKIPPED');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx -w server vitest run src/__tests__/action-source-agnostic.test.ts 2>&1 | tail -20`
Expected: FAIL — the action currently throws `'Deployment config ID is required for DNS configuration'`.

- [ ] **Step 3: Refactor `ConfigureDNS.execute()` to read from context first, fall back to DB**

Replace the validation and DB lookup section (lines 27-68) with:

```typescript
      // Resolve configuration - prefer context fields, fall back to DB lookup
      let hostname: string | undefined;
      let networkType: string | undefined;

      if (context.hostname) {
        // Source-agnostic path: read from context directly
        hostname = context.hostname;
        networkType = context.networkType;
      } else if (context.deploymentConfigId) {
        // Legacy path: look up from database
        const deploymentConfig = await prisma.deploymentConfiguration.findUnique({
          where: { id: context.deploymentConfigId },
          include: { environment: true },
        });

        if (!deploymentConfig) {
          throw new Error(`Deployment configuration not found: ${context.deploymentConfigId}`);
        }

        if (!deploymentConfig.hostname) {
          sendEvent({ type: "DNS_CONFIG_SKIPPED", message: "No hostname configured" });
          return;
        }

        hostname = deploymentConfig.hostname;
        networkType = deploymentConfig.environment.networkType;
      } else {
        // No config available — skip
        sendEvent({ type: "DNS_CONFIG_SKIPPED", message: "No hostname or deployment config available" });
        return;
      }
```

Then update the network type check and DNS creation. Replace the `deploymentDNSManager.createDNSRecordForDeployment` call with a direct Cloudflare DNS approach that works for both paths:

```typescript
      if (networkType === "internet") {
        sendEvent({
          type: "DNS_CONFIG_SKIPPED",
          message: "Network type is 'internet', DNS managed externally",
          networkType,
        });
        context.dnsConfigured = false;
        context.dnsSkipped = true;
        return;
      }

      // For 'local' network type, create DNS record
      if (context.deploymentConfigId) {
        // Legacy path: use deployment DNS manager
        const dnsRecord = await deploymentDNSManager.createDNSRecordForDeployment(
          context.deploymentConfigId
        );
        if (dnsRecord) {
          context.dnsConfigured = true;
          context.dnsRecordId = dnsRecord.id;
          context.hostname = dnsRecord.hostname;
          sendEvent({ type: "DNS_CONFIGURED", dnsRecordId: dnsRecord.id, hostname: dnsRecord.hostname });
        } else {
          sendEvent({ type: "DNS_CONFIG_SKIPPED", message: "DNS record already exists or was skipped" });
          context.dnsConfigured = false;
          context.dnsSkipped = true;
        }
      } else {
        // Source-agnostic path: create DNS record directly via Cloudflare
        const { networkUtils } = await import('../../network-utils');
        const { cloudflareDNSService } = await import('../../cloudflare');
        const ip = await networkUtils.getAppropriateIPForEnvironment(context.environmentId);
        await cloudflareDNSService.upsertARecord(hostname!, ip, 300, false);
        context.dnsConfigured = true;
        context.hostname = hostname;
        sendEvent({ type: "DNS_CONFIGURED", hostname });
      }
```

Note: The dynamic imports above should be replaced with static imports at the top of the file:

```typescript
import { cloudflareDNSService } from '../../cloudflare';
import { networkUtils } from '../../network-utils';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx -w server vitest run src/__tests__/action-source-agnostic.test.ts 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/haproxy/actions/configure-dns.ts server/src/__tests__/action-source-agnostic.test.ts
git commit -m "feat: make ConfigureDNS source-agnostic

Read hostname and networkType from context fields when available. Falls
back to DeploymentConfiguration DB lookup and deploymentDNSManager for
legacy callers. Source-agnostic path creates DNS directly via Cloudflare."
```

---

### Task 6: Update DeploymentOrchestrator to Populate New Context Fields

**Files:**
- Modify: `server/src/services/deployment-orchestrator.ts:301-421`

- [ ] **Step 1: Update `startInitialDeployment()` to populate new context fields**

In `server/src/services/deployment-orchestrator.ts`, inside `startInitialDeployment()`, add the new fields to the `initialContext` object after the existing fields. These are populated from `baseContext.config` (which is the `DeploymentConfig`):

```typescript
      // Source-agnostic fields (populated from DeploymentConfig for legacy path)
      hostname: baseContext.config.hostname,
      enableSsl: baseContext.config.enableSsl,
      tlsCertificateId: baseContext.config.tlsCertificateId,
      certificateStatus: baseContext.config.certificateStatus,
      networkType: baseContext.config.networkType,
      healthCheckEndpoint: baseContext.config.healthCheck?.endpoint,
      healthCheckInterval: baseContext.config.healthCheck?.interval,
      healthCheckRetries: baseContext.config.healthCheck?.retries,
      containerPorts: baseContext.config.containerConfig?.ports,
      containerVolumes: baseContext.config.containerConfig?.volumes,
      containerEnvironment: baseContext.config.containerConfig?.environment,
      containerLabels: baseContext.config.containerConfig?.labels,
      containerNetworks: baseContext.config.containerConfig?.networks,
```

Note: Some of these fields may not exist on `DeploymentConfig`. Check the actual type and only populate what exists. If a field like `hostname` lives on the `DeploymentConfiguration` Prisma model rather than the `DeploymentConfig` type, you may need to fetch it from the `deploymentRecord` that's already queried at line 232. Adapt accordingly — the goal is that legacy deployments still pass the same data to actions, just via the new context fields in addition to `config`.

- [ ] **Step 2: Update `startBlueGreenDeployment()` with the same fields**

Add the same block of source-agnostic fields to the `blueGreenContext` object.

- [ ] **Step 3: Verify existing deployment tests still pass**

Run: `npx -w server vitest run src/__tests__/deployment-api.test.ts 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/services/deployment-orchestrator.ts
git commit -m "feat: populate source-agnostic context fields in DeploymentOrchestrator

Legacy deployment path now populates the new flat context fields from
DeploymentConfig so actions can read them without DB lookups. This is
a no-op change in behavior — actions now have two paths to the same data."
```

---

### Task 7: Create Actor Await Helper

**Files:**
- Create: `server/src/services/stacks/state-machine-runner.ts`
- Test: `server/src/__tests__/state-machine-runner.test.ts`

- [ ] **Step 1: Write failing test for the await helper**

Create `server/src/__tests__/state-machine-runner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { setup, createActor } from 'xstate';
import { runStateMachineToCompletion } from '../services/stacks/state-machine-runner';

// A simple test machine that goes idle -> working -> completed or failed
const testMachine = setup({
  types: {
    context: {} as { value: number; error?: string },
    events: {} as { type: 'START' } | { type: 'DONE' } | { type: 'FAIL'; error: string },
  },
  actions: {
    setError: ({ context, event }) => {
      if (event.type === 'FAIL') {
        context.error = event.error;
      }
    },
  },
}).createMachine({
  id: 'test',
  initial: 'idle',
  context: ({ input }) => ({ value: (input as any)?.value ?? 0 }),
  states: {
    idle: {
      on: { START: 'working' },
    },
    working: {
      on: {
        DONE: 'completed',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    completed: { type: 'final' },
    failed: { type: 'final' },
  },
});

describe('runStateMachineToCompletion', () => {
  it('should resolve with the final state when machine completes', async () => {
    const result = await runStateMachineToCompletion(testMachine, { value: 42 }, (actor) => {
      actor.send({ type: 'START' });
      actor.send({ type: 'DONE' });
    });

    expect(result.value).toBe('completed');
    expect(result.context.value).toBe(42);
  });

  it('should resolve with failed state', async () => {
    const result = await runStateMachineToCompletion(testMachine, { value: 0 }, (actor) => {
      actor.send({ type: 'START' });
      actor.send({ type: 'FAIL', error: 'something broke' });
    });

    expect(result.value).toBe('failed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx -w server vitest run src/__tests__/state-machine-runner.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `server/src/services/stacks/state-machine-runner.ts`:

```typescript
import { createActor, AnyStateMachine, SnapshotFrom } from 'xstate';

/**
 * Runs an xstate machine to completion and returns the final state.
 * The `start` callback receives the actor and should send the initial event(s).
 * For async state machines where actions send events internally, the promise
 * resolves when the machine reaches a final state.
 */
export function runStateMachineToCompletion<TMachine extends AnyStateMachine>(
  machine: TMachine,
  input: Record<string, unknown>,
  start: (actor: ReturnType<typeof createActor<TMachine>>) => void
): Promise<SnapshotFrom<TMachine>> {
  return new Promise((resolve) => {
    const actor = createActor(machine, { input });

    actor.subscribe((state) => {
      if (state.status === 'done') {
        resolve(state as SnapshotFrom<TMachine>);
      }
    });

    actor.start();
    start(actor);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx -w server vitest run src/__tests__/state-machine-runner.test.ts 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/stacks/state-machine-runner.ts server/src/__tests__/state-machine-runner.test.ts
git commit -m "feat: add runStateMachineToCompletion helper for stack reconciler

Wraps xstate actor creation and subscription into a promise that resolves
when the machine reaches a final state. Used by the stack reconciler to
await deployment state machines."
```

---

### Task 8: Wire State Machines into Stack Reconciler `applyStatelessWeb()`

**Files:**
- Modify: `server/src/services/stacks/stack-reconciler.ts:844-1073`
- Modify: `server/src/__tests__/stack-reconciler-apply-stateless.test.ts`

- [ ] **Step 1: Add imports to stack-reconciler.ts**

Add at the top of `server/src/services/stacks/stack-reconciler.ts`:

```typescript
import { createActor } from 'xstate';
import { initialDeploymentMachine } from '../haproxy/initial-deployment-state-machine';
import { blueGreenDeploymentMachine } from '../haproxy/blue-green-deployment-state-machine';
import { removalDeploymentMachine } from '../haproxy/removal-deployment-state-machine';
import { runStateMachineToCompletion } from './state-machine-runner';
import { EnvironmentValidationService } from '../environment';
```

- [ ] **Step 2: Add a private method to build state machine context from stack data**

Add this method to the `StackReconciler` class:

```typescript
  private async buildStateMachineContext(
    action: ServiceAction,
    serviceDef: StackServiceDefinition,
    projectName: string,
    stackId: string,
    stack: any,
    serviceHashes: Map<string, string>,
    containerByService: Map<string, Docker.ContainerInfo>
  ): Promise<Record<string, unknown>> {
    const routing = serviceDef.routing!;
    const containerName = `${projectName}-${action.serviceName}`;
    const envValidation = new EnvironmentValidationService();
    const haproxyCtx = await envValidation.getHAProxyEnvironmentContext(stack.environmentId);

    if (!haproxyCtx) {
      throw new Error(`HAProxy environment context not available for environment ${stack.environmentId}`);
    }

    // Build the full docker image string
    const dockerImage = `${serviceDef.dockerImage}:${serviceDef.dockerTag}`;

    // Build environment variables array from env record
    const envRecord = serviceDef.containerConfig.env ?? {};
    const envArray = Object.entries(envRecord).map(([k, v]) => `${k}=${v}`);

    // Base context shared across all machine types
    const base: Record<string, unknown> = {
      deploymentId: `stack-${stackId}-${action.serviceName}-${Date.now()}`,
      configurationId: stackId,
      deploymentConfigId: '', // Not used by source-agnostic actions
      applicationName: `stk-${stack.name}-${action.serviceName}`,
      dockerImage,

      environmentId: haproxyCtx.environmentId,
      environmentName: haproxyCtx.environmentName,
      haproxyContainerId: haproxyCtx.haproxyContainerId,
      haproxyNetworkName: haproxyCtx.haproxyNetworkName,

      triggerType: 'manual',
      startTime: Date.now(),

      // Source-agnostic fields
      hostname: routing.hostname,
      enableSsl: routing.enableSsl ?? false,
      tlsCertificateId: routing.tlsCertificateId,
      certificateStatus: routing.enableSsl && routing.tlsCertificateId ? 'ACTIVE' : undefined,
      networkType: routing.dns?.provider === 'external' ? 'internet' : 'local',
      healthCheckEndpoint: '/health', // Default; could be extracted from healthcheck.test if present
      healthCheckInterval: serviceDef.containerConfig.healthcheck?.interval
        ? serviceDef.containerConfig.healthcheck.interval * 1000
        : 2000,
      healthCheckRetries: serviceDef.containerConfig.healthcheck?.retries ?? 2,
      containerPorts: serviceDef.containerConfig.ports ?? [],
      containerVolumes: [],
      containerEnvironment: envRecord,
      containerLabels: {
        'mini-infra.stack': stack.name,
        'mini-infra.stack-id': stackId,
        'mini-infra.service': action.serviceName,
        'mini-infra.environment': stack.environmentId,
        'mini-infra.definition-hash': serviceHashes.get(action.serviceName) ?? '',
        'mini-infra.stack-version': String(stack.version),
        ...(serviceDef.containerConfig.labels ?? {}),
      },
      containerNetworks: [haproxyCtx.haproxyNetworkName],
      containerPort: routing.listeningPort,
      containerName,
    };

    // Include environment networks (e.g., 'applications', 'monitoring')
    // so the container joins them during creation rather than post-creation.
    // The old procedural code called joinEnvironmentNetworks() separately;
    // the state machine's DeployApplicationContainers action uses containerNetworks.
    if (serviceDef.containerConfig.joinEnvironmentNetworks?.length) {
      const envNetworks = await this.resolveEnvironmentNetworks(
        stack.environmentId,
        new Map([[action.serviceName, serviceDef]])
      );
      for (const dockerName of envNetworks.values()) {
        if (!(base.containerNetworks as string[]).includes(dockerName)) {
          (base.containerNetworks as string[]).push(dockerName);
        }
      }
    }

    return base;
  }
```

- [ ] **Step 3: Rewrite `applyStatelessWeb()` to use state machines**

Replace the entire `applyStatelessWeb()` method body with:

```typescript
  private async applyStatelessWeb(
    action: ServiceAction,
    svc: any,
    serviceDef: StackServiceDefinition,
    projectName: string,
    stackId: string,
    stack: any,
    networkNames: string[],
    serviceHashes: Map<string, string>,
    resolvedConfigsMap: Map<string, StackConfigFile[]>,
    containerByService: Map<string, Docker.ContainerInfo>,
    actionStart: number,
    log: any,
    envNetworkMap: Map<string, string> = new Map()
  ): Promise<ServiceApplyResult> {
    const routing = serviceDef.routing;
    if (!routing) {
      throw new Error(`StatelessWeb service "${action.serviceName}" requires routing configuration`);
    }

    const baseContext = await this.buildStateMachineContext(
      action, serviceDef, projectName, stackId, stack, serviceHashes, containerByService
    );

    switch (action.action) {
      case 'create': {
        log.info({ service: action.serviceName }, 'Creating StatelessWeb service via initial deployment state machine');

        // Prepare config files and init commands before the state machine runs
        await prepareServiceContainer(
          this.containerManager,
          svc,
          resolvedConfigsMap.get(action.serviceName) ?? [],
          projectName
        );

        const initialContext = {
          ...baseContext,
          containerId: undefined,
          applicationReady: false,
          haproxyConfigured: false,
          healthChecksPassed: false,
          frontendConfigured: false,
          dnsConfigured: false,
          trafficEnabled: false,
          validationErrors: 0,
          error: undefined,
          retryCount: 0,
          frontendName: undefined,
          dnsRecordId: undefined,
        };

        const finalState = await runStateMachineToCompletion(
          initialDeploymentMachine,
          initialContext,
          (actor) => actor.send({ type: 'START_DEPLOYMENT' })
        );

        const success = finalState.value === 'completed';
        return {
          serviceName: action.serviceName,
          action: 'create',
          success,
          duration: Date.now() - actionStart,
          containerId: finalState.context.containerId,
          error: success ? undefined : finalState.context.error ?? 'Deployment failed',
        };
      }

      case 'recreate': {
        log.info({ service: action.serviceName }, 'Recreating StatelessWeb service via blue-green state machine');

        const oldContainer = containerByService.get(action.serviceName);

        await prepareServiceContainer(
          this.containerManager,
          svc,
          resolvedConfigsMap.get(action.serviceName) ?? [],
          projectName
        );

        const blueGreenContext = {
          ...baseContext,
          blueHealthy: false,
          greenHealthy: false,
          greenBackendConfigured: false,
          frontendConfigured: false,
          dnsConfigured: false,
          trafficOpenedToGreen: false,
          trafficValidated: false,
          blueDraining: false,
          blueDrained: false,
          validationErrors: 0,
          drainStartTime: undefined,
          monitoringStartTime: undefined,
          error: undefined,
          retryCount: 0,
          activeConnections: 0,
          oldContainerId: oldContainer?.Id,
          newContainerId: undefined,
          containerIpAddress: undefined,
          frontendName: undefined,
          dnsRecordId: undefined,
        };

        const finalState = await runStateMachineToCompletion(
          blueGreenDeploymentMachine,
          blueGreenContext,
          (actor) => actor.send({ type: 'START_DEPLOYMENT' })
        );

        const success = finalState.value === 'completed';
        return {
          serviceName: action.serviceName,
          action: 'recreate',
          success,
          duration: Date.now() - actionStart,
          containerId: finalState.context.newContainerId,
          error: success ? undefined : finalState.context.error ?? 'Blue-green deployment failed',
        };
      }

      case 'remove': {
        log.info({ service: action.serviceName }, 'Removing StatelessWeb service via removal state machine');

        const container = containerByService.get(action.serviceName);

        const removalContext = {
          ...baseContext,
          containerId: container?.Id,
          containersToRemove: container ? [container.Id] : [],
          lbRemovalComplete: false,
          frontendRemoved: false,
          dnsRemoved: false,
          applicationStopped: false,
          applicationRemoved: false,
          error: undefined,
          retryCount: 0,
        };

        const finalState = await runStateMachineToCompletion(
          removalDeploymentMachine,
          removalContext,
          (actor) => actor.send({ type: 'START_REMOVAL' })
        );

        const success = finalState.value === 'completed';
        return {
          serviceName: action.serviceName,
          action: 'remove',
          success,
          duration: Date.now() - actionStart,
          error: success ? undefined : finalState.context.error ?? 'Removal failed',
        };
      }

      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }
```

- [ ] **Step 4: Update the existing stateless test to expect state-machine behavior**

The existing tests in `server/src/__tests__/stack-reconciler-apply-stateless.test.ts` mock the reconciler's internal methods. They need to be updated to mock the state machine actions or the `runStateMachineToCompletion` helper. The simplest approach is to mock `runStateMachineToCompletion`:

Add at the top of the test file:

```typescript
vi.mock('../services/stacks/state-machine-runner', () => ({
  runStateMachineToCompletion: vi.fn().mockResolvedValue({
    value: 'completed',
    status: 'done',
    context: {
      containerId: 'new-container-id',
      newContainerId: 'new-container-id',
      error: undefined,
    },
  }),
}));
```

Update the test assertions to verify `runStateMachineToCompletion` was called with the right machine and context structure. Keep the existing test cases but adapt expectations to the new flow.

- [ ] **Step 5: Run all stateless reconciler tests**

Run: `npx -w server vitest run src/__tests__/stack-reconciler-apply-stateless.test.ts 2>&1 | tail -30`
Expected: PASS

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npm test -w server 2>&1 | tail -30`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/services/stacks/stack-reconciler.ts server/src/__tests__/stack-reconciler-apply-stateless.test.ts
git commit -m "feat: wire xstate deployment state machines into stack reconciler

applyStatelessWeb() now delegates to initialDeploymentMachine (create),
blueGreenDeploymentMachine (recreate), and removalDeploymentMachine
(remove) instead of inline procedural code. This gives stack-based
StatelessWeb deployments formal rollback chains, timeouts, drain
monitoring, and retry resilience."
```

---

### Task 9: Integration Verification

**Files:**
- No file changes — verification only

- [ ] **Step 1: Build the full project**

Run: `npm run build 2>&1 | tail -20`
Expected: Build succeeds with no type errors.

- [ ] **Step 2: Run all server tests**

Run: `npm test -w server 2>&1 | tail -30`
Expected: All tests PASS.

- [ ] **Step 3: Run client tests to verify no regressions**

Run: `npm test -w client 2>&1 | tail -20`
Expected: All tests PASS.

- [ ] **Step 4: Verify the existing deployment tests still pass**

Run: `npx -w server vitest run src/__tests__/deployment-api.test.ts src/__tests__/removal-deployment-state-machine.test.ts 2>&1 | tail -20`
Expected: PASS — legacy deployment path behavior unchanged.
