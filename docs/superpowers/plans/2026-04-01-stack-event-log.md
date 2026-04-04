# Stack Event Log Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate stack deploy, update, and destroy operations into the UserEvent audit log with structured step-by-step logs.

**Architecture:** A log formatter utility produces structured text logs. The stack route handlers create a UserEvent before firing the background operation and update it via `onProgress` callbacks and on completion/failure. The reconciler's existing `onProgress` already reports service and resource results — the route handler translates these into formatted log lines.

**Tech Stack:** TypeScript, Express routes, UserEventService, existing StackReconciler callbacks

---

### Task 1: Add New Event Types to Shared Types

**Files:**
- Modify: `lib/types/user-events.ts:6-26` (UserEventType union)
- Modify: `lib/types/user-events.ts:43-52` (UserEventResourceType union)

- [ ] **Step 1: Add `stack_deploy`, `stack_update`, and `stack_destroy` to UserEventType**

In `lib/types/user-events.ts`, add three new types to the `UserEventType` union:

```typescript
export type UserEventType =
  | 'deployment'
  | 'deployment_rollback'
  | 'deployment_uninstall'
  | 'environment_start'
  | 'environment_stop'
  | 'environment_create'
  | 'environment_delete'
  | 'certificate_create'
  | 'certificate_renew'
  | 'certificate_revoke'
  | 'backup'
  | 'backup_cleanup'
  | 'restore'
  | 'container_cleanup'
  | 'database_create'
  | 'database_delete'
  | 'user_create'
  | 'user_delete'
  | 'system_maintenance'
  | 'stack_deploy'
  | 'stack_update'
  | 'stack_destroy'
  | 'other';
```

- [ ] **Step 2: Add `stack` to UserEventResourceType**

```typescript
export type UserEventResourceType =
  | 'deployment'
  | 'deployment_config'
  | 'database'
  | 'container'
  | 'certificate'
  | 'environment'
  | 'user'
  | 'backup'
  | 'stack'
  | 'system';
```

- [ ] **Step 3: Build lib to verify types compile**

Run: `npm run build -w lib`
Expected: Clean compilation with no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/types/user-events.ts
git commit -m "feat: add stack_deploy, stack_update, stack_destroy event types"
```

---

### Task 2: Create Stack Event Log Formatter

**Files:**
- Create: `server/src/services/stacks/stack-event-log-formatter.ts`
- Create: `server/src/__tests__/stack-event-log-formatter.test.ts`

- [ ] **Step 1: Write tests for the formatter**

Create `server/src/__tests__/stack-event-log-formatter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  formatPlanStep,
  formatServiceStep,
  formatResourceGroupStep,
  formatDestroyContainerStep,
  formatDestroyNetworkStep,
  formatDestroyVolumeStep,
  formatDestroyResourceStep,
} from '../services/stacks/stack-event-log-formatter';
import { ServiceApplyResult, ResourceResult } from '@mini-infra/types';

describe('stack-event-log-formatter', () => {
  describe('formatPlanStep', () => {
    it('formats plan summary with action counts', () => {
      const result = formatPlanStep(1, 5, {
        creates: 2,
        recreates: 1,
        removes: 0,
        updates: 0,
      });
      expect(result).toBe(
        '[1/5] Planning stack changes...\n' +
        '      → 2 to create, 1 to recreate, 0 to remove\n'
      );
    });

    it('includes updates count when non-zero', () => {
      const result = formatPlanStep(1, 3, {
        creates: 0,
        recreates: 0,
        removes: 0,
        updates: 2,
      });
      expect(result).toBe(
        '[1/3] Planning stack changes...\n' +
        '      → 0 to create, 0 to recreate, 0 to remove, 2 to update\n'
      );
    });
  });

  describe('formatServiceStep', () => {
    it('formats a successful create action', () => {
      const result: ServiceApplyResult = {
        serviceName: 'postgres',
        action: 'create',
        success: true,
        duration: 2300,
      };
      const output = formatServiceStep(2, 5, result);
      expect(output).toBe(
        '[2/5] Creating service: postgres\n' +
        '      ✓ Completed (2.3s)\n'
      );
    });

    it('formats a successful recreate action', () => {
      const result: ServiceApplyResult = {
        serviceName: 'web-app',
        action: 'recreate',
        success: true,
        duration: 4100,
      };
      const output = formatServiceStep(3, 5, result);
      expect(output).toBe(
        '[3/5] Recreating service: web-app\n' +
        '      ✓ Completed (4.1s)\n'
      );
    });

    it('formats a successful remove action', () => {
      const result: ServiceApplyResult = {
        serviceName: 'old-worker',
        action: 'remove',
        success: true,
        duration: 500,
      };
      const output = formatServiceStep(4, 5, result);
      expect(output).toBe(
        '[4/5] Removing service: old-worker\n' +
        '      ✓ Completed (0.5s)\n'
      );
    });

    it('formats a successful update action', () => {
      const result: ServiceApplyResult = {
        serviceName: 'web',
        action: 'update',
        success: true,
        duration: 3200,
      };
      const output = formatServiceStep(2, 3, result);
      expect(output).toBe(
        '[2/3] Updating service: web\n' +
        '      ✓ Completed (3.2s)\n'
      );
    });

    it('formats a failed action with error', () => {
      const result: ServiceApplyResult = {
        serviceName: 'web-app',
        action: 'create',
        success: false,
        duration: 1200,
        error: 'port 8080 already in use',
      };
      const output = formatServiceStep(2, 5, result);
      expect(output).toBe(
        '[2/5] Creating service: web-app\n' +
        '      ✗ Failed (1.2s)\n' +
        '        Error: port 8080 already in use\n'
      );
    });

    it('formats a failed action without error message', () => {
      const result: ServiceApplyResult = {
        serviceName: 'redis',
        action: 'create',
        success: false,
        duration: 800,
      };
      const output = formatServiceStep(3, 5, result);
      expect(output).toBe(
        '[3/5] Creating service: redis\n' +
        '      ✗ Failed (0.8s)\n'
      );
    });
  });

  describe('formatResourceGroupStep', () => {
    it('formats successful TLS results', () => {
      const results: ResourceResult[] = [
        { resourceType: 'tls', resourceName: 'web.example.com', action: 'create', success: true },
      ];
      const output = formatResourceGroupStep(4, 5, 'tls', results);
      expect(output).toBe(
        '[4/5] Reconciling TLS certificates\n' +
        '      ✓ web.example.com — create\n'
      );
    });

    it('formats mixed success/failure DNS results', () => {
      const results: ResourceResult[] = [
        { resourceType: 'dns', resourceName: 'web.example.com', action: 'create', success: true },
        { resourceType: 'dns', resourceName: 'api.example.com', action: 'create', success: false, error: 'Rate limited' },
      ];
      const output = formatResourceGroupStep(5, 6, 'dns', results);
      expect(output).toBe(
        '[5/6] Reconciling DNS records\n' +
        '      ✓ web.example.com — create\n' +
        '      ✗ api.example.com — create: Rate limited\n'
      );
    });

    it('formats tunnel results', () => {
      const results: ResourceResult[] = [
        { resourceType: 'tunnel', resourceName: 'web-tunnel', action: 'create', success: true },
      ];
      const output = formatResourceGroupStep(6, 6, 'tunnel', results);
      expect(output).toBe(
        '[6/6] Reconciling tunnel ingress\n' +
        '      ✓ web-tunnel — create\n'
      );
    });
  });

  describe('formatDestroyContainerStep', () => {
    it('formats container removal step', () => {
      const output = formatDestroyContainerStep(2, 5, 3, 3);
      expect(output).toBe(
        '[2/5] Removing containers\n' +
        '      ✓ 3 of 3 containers removed\n'
      );
    });

    it('formats partial container removal', () => {
      const output = formatDestroyContainerStep(2, 5, 2, 3);
      expect(output).toBe(
        '[2/5] Removing containers\n' +
        '      ✗ 2 of 3 containers removed (1 failed)\n'
      );
    });
  });

  describe('formatDestroyNetworkStep', () => {
    it('formats network removal', () => {
      const output = formatDestroyNetworkStep(3, 5, ['net-a', 'net-b']);
      expect(output).toBe(
        '[3/5] Removing networks\n' +
        '      ✓ Removed: net-a, net-b\n'
      );
    });

    it('formats no networks removed', () => {
      const output = formatDestroyNetworkStep(3, 5, []);
      expect(output).toBe(
        '[3/5] Removing networks\n' +
        '      ✓ No networks to remove\n'
      );
    });
  });

  describe('formatDestroyVolumeStep', () => {
    it('formats volume removal', () => {
      const output = formatDestroyVolumeStep(4, 5, ['vol-a']);
      expect(output).toBe(
        '[4/5] Removing volumes\n' +
        '      ✓ Removed: vol-a\n'
      );
    });

    it('formats no volumes removed', () => {
      const output = formatDestroyVolumeStep(4, 5, []);
      expect(output).toBe(
        '[4/5] Removing volumes\n' +
        '      ✓ No volumes to remove\n'
      );
    });
  });

  describe('formatDestroyResourceStep', () => {
    it('formats resource destruction step', () => {
      const output = formatDestroyResourceStep(1, 5, true);
      expect(output).toBe(
        '[1/5] Destroying stack resources (TLS, DNS, tunnels)\n' +
        '      ✓ Resources cleaned up\n'
      );
    });

    it('formats failed resource destruction', () => {
      const output = formatDestroyResourceStep(1, 5, false, 'Cloudflare API error');
      expect(output).toBe(
        '[1/5] Destroying stack resources (TLS, DNS, tunnels)\n' +
        '      ✗ Failed: Cloudflare API error\n'
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx -w server vitest run src/__tests__/stack-event-log-formatter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the formatter**

Create `server/src/services/stacks/stack-event-log-formatter.ts`:

```typescript
import { ServiceApplyResult, ResourceResult, ResourceType } from '@mini-infra/types';

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const actionLabels: Record<string, string> = {
  create: 'Creating',
  recreate: 'Recreating',
  remove: 'Removing',
  update: 'Updating',
};

const resourceGroupLabels: Record<ResourceType, string> = {
  tls: 'TLS certificates',
  dns: 'DNS records',
  tunnel: 'tunnel ingress',
};

export function formatPlanStep(
  stepNum: number,
  totalSteps: number,
  counts: { creates: number; recreates: number; removes: number; updates: number },
): string {
  let summary = `${counts.creates} to create, ${counts.recreates} to recreate, ${counts.removes} to remove`;
  if (counts.updates > 0) {
    summary += `, ${counts.updates} to update`;
  }
  return (
    `[${stepNum}/${totalSteps}] Planning stack changes...\n` +
    `      → ${summary}\n`
  );
}

export function formatServiceStep(
  stepNum: number,
  totalSteps: number,
  result: ServiceApplyResult,
): string {
  const label = actionLabels[result.action] ?? result.action;
  let output = `[${stepNum}/${totalSteps}] ${label} service: ${result.serviceName}\n`;

  if (result.success) {
    output += `      ✓ Completed (${formatDuration(result.duration)})\n`;
  } else {
    output += `      ✗ Failed (${formatDuration(result.duration)})\n`;
    if (result.error) {
      output += `        Error: ${result.error}\n`;
    }
  }

  return output;
}

export function formatResourceGroupStep(
  stepNum: number,
  totalSteps: number,
  resourceType: ResourceType,
  results: ResourceResult[],
): string {
  const label = resourceGroupLabels[resourceType];
  let output = `[${stepNum}/${totalSteps}] Reconciling ${label}\n`;

  for (const r of results) {
    if (r.success) {
      output += `      ✓ ${r.resourceName} — ${r.action}\n`;
    } else {
      output += `      ✗ ${r.resourceName} — ${r.action}${r.error ? ': ' + r.error : ''}\n`;
    }
  }

  return output;
}

export function formatDestroyResourceStep(
  stepNum: number,
  totalSteps: number,
  success: boolean,
  error?: string,
): string {
  let output = `[${stepNum}/${totalSteps}] Destroying stack resources (TLS, DNS, tunnels)\n`;
  if (success) {
    output += `      ✓ Resources cleaned up\n`;
  } else {
    output += `      ✗ Failed${error ? ': ' + error : ''}\n`;
  }
  return output;
}

export function formatDestroyContainerStep(
  stepNum: number,
  totalSteps: number,
  removed: number,
  total: number,
): string {
  let output = `[${stepNum}/${totalSteps}] Removing containers\n`;
  if (removed === total) {
    output += `      ✓ ${removed} of ${total} containers removed\n`;
  } else {
    output += `      ✗ ${removed} of ${total} containers removed (${total - removed} failed)\n`;
  }
  return output;
}

export function formatDestroyNetworkStep(
  stepNum: number,
  totalSteps: number,
  networksRemoved: string[],
): string {
  let output = `[${stepNum}/${totalSteps}] Removing networks\n`;
  if (networksRemoved.length === 0) {
    output += `      ✓ No networks to remove\n`;
  } else {
    output += `      ✓ Removed: ${networksRemoved.join(', ')}\n`;
  }
  return output;
}

export function formatDestroyVolumeStep(
  stepNum: number,
  totalSteps: number,
  volumesRemoved: string[],
): string {
  let output = `[${stepNum}/${totalSteps}] Removing volumes\n`;
  if (volumesRemoved.length === 0) {
    output += `      ✓ No volumes to remove\n`;
  } else {
    output += `      ✓ Removed: ${volumesRemoved.join(', ')}\n`;
  }
  return output;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/stack-event-log-formatter.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/stacks/stack-event-log-formatter.ts server/src/__tests__/stack-event-log-formatter.test.ts
git commit -m "feat: add stack event log formatter with tests"
```

---

### Task 3: Integrate UserEvent into Stack Apply Route

**Files:**
- Modify: `server/src/routes/stacks.ts:1-37` (imports)
- Modify: `server/src/routes/stacks.ts:440-605` (apply route handler)

- [ ] **Step 1: Add imports to stacks.ts**

Add these imports at the top of `server/src/routes/stacks.ts`:

```typescript
import { UserEventService } from '../services/user-events';
import {
  formatPlanStep,
  formatServiceStep,
  formatResourceGroupStep,
} from '../services/stacks/stack-event-log-formatter';
import { ResourceResult, ResourceType } from '@mini-infra/types';
```

Note: `ResourceResult` and `ResourceType` should be added to the existing `@mini-infra/types` import. `Channel`, `ServerEvent` etc. are already imported.

- [ ] **Step 2: Modify the apply route to create and update a UserEvent**

Replace the background async block inside `POST /:stackId/apply` (the `(async () => { ... })()` at lines 523-596). The new version creates a UserEvent before apply, appends structured logs as progress comes in, and finalizes on completion/failure.

The full replacement for the fire-and-forget block (starting after `res.json(...)` at line 519):

```typescript
    // Run apply in background
    const triggeredBy = (req as any).user?.id;
    const userEventService = new UserEventService(prisma);

    (async () => {
      // Create user event
      let userEventId: string | undefined;
      try {
        const userEvent = await userEventService.createEvent({
          eventType: 'stack_deploy',
          eventCategory: 'infrastructure',
          eventName: `Deploy ${plan.stackName} v${plan.stackVersion}`,
          userId: triggeredBy,
          triggeredBy: triggeredBy ? 'manual' : 'api',
          resourceId: stackId,
          resourceType: 'stack',
          resourceName: plan.stackName,
          status: 'running',
          progress: 0,
          description: `Deploying stack ${plan.stackName}`,
          metadata: {
            stackName: plan.stackName,
            version: plan.stackVersion,
            serviceActions: startedActions,
            forcePull: isForcePull,
          },
        });
        userEventId = userEvent.id;
      } catch (err) {
        logger.warn({ error: err, stackId }, 'Failed to create user event for stack apply');
      }

      // Count total steps: 1 (plan) + service actions + resource groups with actions
      const resourceTypes: ResourceType[] = ['tls', 'dns', 'tunnel'];
      const resourceGroupCount = resourceTypes.filter((rt) =>
        plan.resourceActions?.some((ra) => ra.resourceType === rt && ra.action !== 'no-op')
      ).length;
      const totalSteps = 1 + startedActions.length + resourceGroupCount;
      let currentStep = 1;

      // Append plan step
      const actionCounts = {
        creates: startedActions.filter((a) => a.action === 'create').length,
        recreates: startedActions.filter((a) => a.action === 'recreate').length,
        removes: startedActions.filter((a) => a.action === 'remove').length,
        updates: startedActions.filter((a) => a.action === 'update' || a.action === 'pull').length,
      };

      if (userEventId) {
        try {
          await userEventService.appendLogs(
            userEventId,
            formatPlanStep(currentStep, totalSteps, actionCounts),
          );
          await userEventService.updateEvent(userEventId, {
            progress: Math.round((currentStep / totalSteps) * 100),
          });
        } catch { /* never break apply */ }
      }

      try {
        const result = await reconciler.apply(stackId, {
          ...parsed.data,
          triggeredBy,
          plan,
          onProgress: (progressResult, completedCount, totalActions) => {
            try {
              emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_SERVICE_RESULT, {
                stackId,
                ...progressResult,
                completedCount,
                totalActions,
              } as any);
            } catch { /* never break apply */ }

            // Append to user event log
            if (userEventId) {
              try {
                currentStep++;
                // Determine if this is a service result or resource result
                const isResource = 'resourceType' in progressResult;
                if (!isResource) {
                  const serviceResult = progressResult as import('@mini-infra/types').ServiceApplyResult;
                  userEventService.appendLogs(
                    userEventId,
                    formatServiceStep(currentStep, totalSteps, serviceResult),
                  ).catch(() => {});
                }
                // Resource results are batched per-group below
                userEventService.updateEvent(userEventId, {
                  progress: Math.round((currentStep / totalSteps) * 100),
                }).catch(() => {});
              } catch { /* never break apply */ }
            }
          },
        });

        // Append resource group logs from the final result
        if (userEventId && result.resourceResults.length > 0) {
          try {
            const grouped = new Map<ResourceType, ResourceResult[]>();
            for (const rr of result.resourceResults) {
              const list = grouped.get(rr.resourceType) ?? [];
              list.push(rr);
              grouped.set(rr.resourceType, list);
            }
            for (const [rt, results] of grouped) {
              if (results.some((r) => r.action !== 'no-op')) {
                currentStep++;
                await userEventService.appendLogs(
                  userEventId,
                  formatResourceGroupStep(currentStep, totalSteps, rt, results.filter((r) => r.action !== 'no-op')),
                );
              }
            }
          } catch { /* never break apply */ }
        }

        // HAProxy post-apply restoration
        let postApply: { success: boolean; errors?: string[] } | undefined;
        const haproxyServiceApplied = result.serviceResults.some(
          (r) => r.serviceName === 'haproxy' && r.success && (r.action === 'create' || r.action === 'recreate')
        );
        if (haproxyServiceApplied) {
          const stack = await prisma.stack.findUnique({
            where: { id: stackId },
            select: { name: true, environmentId: true },
          });
          if (stack?.name === 'haproxy' && stack.environmentId) {
            const postApplyResult = await restoreHAProxyRuntimeState(stack.environmentId, prisma);
            if (!postApplyResult.success) {
              logger.warn({ stackId, errors: postApplyResult.errors }, 'HAProxy post-apply restoration had errors');
            }
            postApply = { success: postApplyResult.success, errors: postApplyResult.errors };
          }
        }

        // Monitoring post-apply: connect app container to monitoring network
        if (result.success) {
          const stack = await prisma.stack.findUnique({
            where: { id: stackId },
            select: { name: true },
          });
          if (stack?.name === 'monitoring') {
            try {
              const monitoringService = new MonitoringService();
              await monitoringService.initialize();
              await monitoringService.ensureAppConnectedToMonitoringNetwork();
            } catch (err) {
              logger.warn({ error: err }, 'Failed to connect app to monitoring network after apply');
            }
          }
        }

        // Finalize user event
        if (userEventId) {
          try {
            const failedServices = result.serviceResults.filter((r) => !r.success);
            const failedResources = result.resourceResults.filter((r) => !r.success);
            const hasFailures = failedServices.length > 0 || failedResources.length > 0;

            await userEventService.updateEvent(userEventId, {
              status: hasFailures ? 'failed' : 'completed',
              progress: 100,
              resultSummary: hasFailures
                ? `${failedServices.length} service(s) and ${failedResources.length} resource(s) failed`
                : `${result.serviceResults.length} service(s) deployed successfully`,
              ...(hasFailures
                ? {
                    errorMessage: failedServices.length > 0
                      ? `Failed services: ${failedServices.map((s) => s.serviceName).join(', ')}`
                      : `Failed resources: ${failedResources.map((r) => r.resourceName).join(', ')}`,
                    errorDetails: { failedServices, failedResources },
                  }
                : {}),
            });
          } catch { /* never break apply */ }
        }

        // Emit completed event
        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          ...result,
          postApply,
        });
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack apply failed');

        // Update user event with failure
        if (userEventId) {
          try {
            await userEventService.updateEvent(userEventId, {
              status: 'failed',
              errorMessage: error.message,
              errorDetails: { type: error.constructor?.name, message: error.message },
            });
          } catch { /* never break error handling */ }
        }

        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          success: false,
          stackId,
          appliedVersion: 0,
          serviceResults: [],
          resourceResults: [],
          duration: 0,
          error: error.message,
        });
      } finally {
        applyingStacks.delete(stackId);
      }
    })();
```

- [ ] **Step 3: Build to verify compilation**

Run: `npm run build -w lib && npm run build -w server`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/stacks.ts
git commit -m "feat: integrate UserEvent into stack apply route"
```

---

### Task 4: Integrate UserEvent into Stack Update Route

**Files:**
- Modify: `server/src/routes/stacks.ts:607-698` (update route handler)

- [ ] **Step 1: Modify the update route's background block**

Replace the fire-and-forget block inside `POST /:stackId/update` (the `(async () => { ... })()` starting at line 656). The pattern is similar to apply but uses `stack_update` event type and has no resource reconciliation steps.

New background block (after `res.json(...)` at line 652):

```typescript
    // Run update in background
    const triggeredBy = (req as any).user?.id;
    const userEventService = new UserEventService(prisma);

    (async () => {
      let userEventId: string | undefined;
      try {
        const userEvent = await userEventService.createEvent({
          eventType: 'stack_update',
          eventCategory: 'infrastructure',
          eventName: `Update ${plan.stackName}`,
          userId: triggeredBy,
          triggeredBy: triggeredBy ? 'manual' : 'api',
          resourceId: stackId,
          resourceType: 'stack',
          resourceName: plan.stackName,
          status: 'running',
          progress: 0,
          description: `Pulling latest images and updating stack ${plan.stackName}`,
          metadata: {
            stackName: plan.stackName,
            actions: startedActions,
          },
        });
        userEventId = userEvent.id;
      } catch (err) {
        logger.warn({ error: err, stackId }, 'Failed to create user event for stack update');
      }

      const totalSteps = 1 + startedActions.length;
      let currentStep = 1;

      // Append plan step
      if (userEventId) {
        try {
          await userEventService.appendLogs(
            userEventId,
            formatPlanStep(currentStep, totalSteps, {
              creates: 0,
              recreates: 0,
              removes: 0,
              updates: startedActions.length,
            }),
          );
          await userEventService.updateEvent(userEventId, {
            progress: Math.round((currentStep / totalSteps) * 100),
          });
        } catch { /* never break update */ }
      }

      try {
        const result = await reconciler.update(stackId, {
          triggeredBy,
          onProgress: (serviceResult, completedCount, totalActions) => {
            try {
              emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_SERVICE_RESULT, {
                stackId,
                ...serviceResult,
                completedCount,
                totalActions,
              } as any);
            } catch { /* never break update */ }

            if (userEventId) {
              try {
                currentStep++;
                userEventService.appendLogs(
                  userEventId,
                  formatServiceStep(currentStep, totalSteps, serviceResult),
                ).catch(() => {});
                userEventService.updateEvent(userEventId, {
                  progress: Math.round((currentStep / totalSteps) * 100),
                }).catch(() => {});
              } catch { /* never break update */ }
            }
          },
        });

        // Finalize user event
        if (userEventId) {
          try {
            const failedServices = result.serviceResults.filter((r) => !r.success);
            const hasFailures = failedServices.length > 0;

            await userEventService.updateEvent(userEventId, {
              status: hasFailures ? 'failed' : 'completed',
              progress: 100,
              resultSummary: hasFailures
                ? `${failedServices.length} service(s) failed to update`
                : result.serviceResults.length === 0
                  ? 'All images are up to date'
                  : `${result.serviceResults.length} service(s) updated successfully`,
              ...(hasFailures
                ? {
                    errorMessage: `Failed services: ${failedServices.map((s) => s.serviceName).join(', ')}`,
                    errorDetails: { failedServices },
                  }
                : {}),
            });
          } catch { /* never break update */ }
        }

        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          ...result,
        });
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack update failed');

        if (userEventId) {
          try {
            await userEventService.updateEvent(userEventId, {
              status: 'failed',
              errorMessage: error.message,
              errorDetails: { type: error.constructor?.name, message: error.message },
            });
          } catch { /* never break error handling */ }
        }

        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          success: false,
          stackId,
          appliedVersion: 0,
          serviceResults: [],
          resourceResults: [],
          duration: 0,
          error: error.message,
        });
      } finally {
        applyingStacks.delete(stackId);
      }
    })();
```

- [ ] **Step 2: Build to verify compilation**

Run: `npm run build -w server`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/stacks.ts
git commit -m "feat: integrate UserEvent into stack update route"
```

---

### Task 5: Integrate UserEvent into Stack Destroy Route

**Files:**
- Modify: `server/src/routes/stacks.ts:700-752` (destroy route handler)

- [ ] **Step 1: Modify the destroy route's background block**

Replace the fire-and-forget block inside `POST /:stackId/destroy`. The destroy route needs to create a `stack_destroy` event and track resource cleanup, container removal, network removal, and volume removal steps.

New background block (after `res.json(...)` at line 717):

```typescript
    const triggeredBy = (req as any).user?.id;
    const userEventService = new UserEventService(prisma);

    (async () => {
      let userEventId: string | undefined;
      try {
        const userEvent = await userEventService.createEvent({
          eventType: 'stack_destroy',
          eventCategory: 'infrastructure',
          eventName: `Destroy ${stack.name}`,
          userId: triggeredBy,
          triggeredBy: triggeredBy ? 'manual' : 'api',
          resourceId: stackId,
          resourceType: 'stack',
          resourceName: stack.name,
          status: 'running',
          progress: 0,
          description: `Destroying stack ${stack.name} and all its resources`,
        });
        userEventId = userEvent.id;
      } catch (err) {
        logger.warn({ error: err, stackId }, 'Failed to create user event for stack destroy');
      }

      try {
        const dockerExecutor = new DockerExecutorService();
        await dockerExecutor.initialize();
        const resourceReconciler = await createResourceReconciler();
        const reconciler = new StackReconciler(dockerExecutor, prisma, undefined, resourceReconciler);
        const result = await reconciler.destroyStack(stackId, { triggeredBy });

        // Build structured logs for the destroy result
        // Destroy always has 4 steps: resources, containers, networks, volumes
        const totalSteps = 4;
        if (userEventId) {
          try {
            let logs = '';
            logs += formatDestroyResourceStep(1, totalSteps, true);
            logs += formatDestroyContainerStep(2, totalSteps, result.containersRemoved, result.containersRemoved);
            logs += formatDestroyNetworkStep(3, totalSteps, result.networksRemoved);
            logs += formatDestroyVolumeStep(4, totalSteps, result.volumesRemoved);

            await userEventService.appendLogs(userEventId, logs);
            await userEventService.updateEvent(userEventId, {
              status: 'completed',
              progress: 100,
              resultSummary: `Stack destroyed: ${result.containersRemoved} containers, ${result.networksRemoved.length} networks, ${result.volumesRemoved.length} volumes removed`,
            });
          } catch { /* never break destroy */ }
        }

        emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_COMPLETED, result);
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack destroy failed');

        if (userEventId) {
          try {
            await userEventService.updateEvent(userEventId, {
              status: 'failed',
              errorMessage: error.message,
              errorDetails: { type: error.constructor?.name, message: error.message },
            });
          } catch { /* never break error handling */ }
        }

        emitToChannel(Channel.STACKS, ServerEvent.STACK_DESTROY_COMPLETED, {
          success: false,
          stackId,
          containersRemoved: 0,
          networksRemoved: [],
          volumesRemoved: [],
          duration: 0,
          error: error.message,
        });
      } finally {
        applyingStacks.delete(stackId);
      }
    })();
```

Note: This requires adding `formatDestroyResourceStep`, `formatDestroyContainerStep`, `formatDestroyNetworkStep`, and `formatDestroyVolumeStep` to the import from the formatter (update the existing import from Task 3 Step 1).

Full updated import:

```typescript
import {
  formatPlanStep,
  formatServiceStep,
  formatResourceGroupStep,
  formatDestroyResourceStep,
  formatDestroyContainerStep,
  formatDestroyNetworkStep,
  formatDestroyVolumeStep,
} from '../services/stacks/stack-event-log-formatter';
```

- [ ] **Step 2: Build to verify compilation**

Run: `npm run build -w server`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/stacks.ts
git commit -m "feat: integrate UserEvent into stack destroy route"
```

---

### Task 6: Build and Verify

**Files:** None (verification only)

- [ ] **Step 1: Build the full project**

Run: `npm run build -w lib && npm run build -w server`
Expected: Clean compilation with no errors.

- [ ] **Step 2: Run all server tests**

Run: `npm test -w server`
Expected: All tests pass including the new formatter tests.

- [ ] **Step 3: Run the formatter tests specifically**

Run: `npx -w server vitest run src/__tests__/stack-event-log-formatter.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Build frontend to verify no regressions**

Run: `npm run build -w client`
Expected: Clean build (frontend uses the shared types but doesn't need changes).
