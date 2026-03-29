# Application Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated "Update" action to Application cards that pulls the latest image and redeploys containers — blue-green for StatelessWeb, simple stop→pull→recreate for Stateful.

**Architecture:** New `POST /api/stacks/:id/update` endpoint reuses the existing `StackReconciler.apply()` with `forcePull` semantics but records the action as `'update'`. StatelessWeb services use a new stripped-down blue-green update state machine (no frontend/DNS/TLS states). Frontend adds an Update button + confirmation dialog + Task Tracker integration.

**Tech Stack:** Express.js, xstate, Prisma, React, TanStack Query, Socket.IO, Zod

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/src/services/haproxy/blue-green-update-state-machine.ts` | Simplified blue-green state machine without frontend/DNS states |
| Modify | `server/src/services/stacks/stack-reconciler.ts` | Add `update()` method that uses forcePull + update state machine |
| Modify | `server/src/routes/stacks.ts` | Add `POST /:stackId/update` endpoint |
| Modify | `lib/types/stacks.ts` | Add `UpdateOptions` and `'update'` to action types |
| Modify | `client/src/lib/task-tracker-types.ts` | Add `"stack-update"` to `TaskType` union |
| Modify | `client/src/lib/task-type-registry.ts` | Add `"stack-update"` registry entry |
| Modify | `client/src/hooks/use-applications.ts` | Add `useUpdateApplication()` hook + `updateStack()` API function |
| Create | `client/src/app/applications/update-application-dialog.tsx` | Confirmation dialog |
| Modify | `client/src/app/applications/page.tsx` | Add Update button to cards |

---

### Task 1: Create Blue-Green Update State Machine

**Files:**
- Create: `server/src/services/haproxy/blue-green-update-state-machine.ts`

This is a copy of `blue-green-deployment-state-machine.ts` with `configuringFrontend`, `configuringDNS` states removed, and their rollback counterparts simplified.

- [ ] **Step 1: Copy the deployment state machine as a starting point**

```bash
cp server/src/services/haproxy/blue-green-deployment-state-machine.ts server/src/services/haproxy/blue-green-update-state-machine.ts
```

- [ ] **Step 2: Strip frontend/DNS states and simplify**

Edit `server/src/services/haproxy/blue-green-update-state-machine.ts`:

1. Remove these imports (no longer needed):
   - `ConfigureFrontend` from `./actions/configure-frontend`
   - `ConfigureDNS` from `./actions/configure-dns`
   - `RemoveFrontend` from `./actions/remove-frontend`

2. Remove these action class instantiations:
   - `const configureFrontend = new ConfigureFrontend();`
   - `const configureDNS = new ConfigureDNS();`
   - `const removeFrontend = new RemoveFrontend();`

3. Rename the context interface to `BlueGreenUpdateContext` and the export to `blueGreenUpdateMachine`.

4. Remove the `configuringFrontend` state (lines 945-970 in the original). Change `healthCheckWait`'s `SERVERS_HEALTHY` transition target from `'configuringFrontend'` to `'openingTraffic'`.

5. Remove the `configuringDNS` state (lines 972-997 in the original).

6. Remove the `configureGreenFrontend` and `configureGreenDNS` action implementations from the `actions` block.

7. Remove the `frontendConfigured` and `dnsConfigured` context fields and their `assign()` calls.

8. In rollback states, remove `rollbackDisableGreenTraffic` (it disables traffic that was never separately configured for frontend). The rollback path should go: `rollbackRestoreBlueTraffic` → `rollbackRemoveGreenHaproxyConfig` → `rollbackStoppingGreenApp` → `rollbackRemovingGreenApp` → `rollbackComplete`.

9. The final exported machine should have these states:
   ```
   idle → deployingGreenApp → waitingGreenReady → initializingGreenLB
     → healthCheckWait → openingTraffic → drainingBlue → waitingForDrain
     → decommissioningBlueLB → stoppingBlueApp → removingBlueApp → completed

   Rollback: rollbackRestoreBlueTraffic → rollbackRemoveGreenHaproxyConfig
     → rollbackStoppingGreenApp → rollbackRemovingGreenApp → rollbackComplete

   Terminal: completed, rollbackComplete, failed
   ```

- [ ] **Step 3: Verify the file compiles**

Run: `npx -w server tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors related to `blue-green-update-state-machine.ts`

- [ ] **Step 4: Commit**

```bash
git add server/src/services/haproxy/blue-green-update-state-machine.ts
git commit -m "feat: add blue-green update state machine without frontend/DNS states"
```

---

### Task 2: Add Update Support to Shared Types

**Files:**
- Modify: `lib/types/stacks.ts`

- [ ] **Step 1: Add `UpdateOptions` type**

In `lib/types/stacks.ts`, after the `ApplyOptions` interface (line 384), add:

```typescript
export interface UpdateOptions {
  triggeredBy?: string;
  /** Called after each service action completes */
  onProgress?: (result: ServiceApplyResult, completedCount: number, totalActions: number) => void;
}
```

- [ ] **Step 2: Build the types**

Run: `npm run build:lib`
Expected: Successful build with no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/types/stacks.ts
git commit -m "feat: add UpdateOptions type for stack updates"
```

---

### Task 3: Add `update()` Method to StackReconciler

**Files:**
- Modify: `server/src/services/stacks/stack-reconciler.ts`

- [ ] **Step 1: Import the update state machine**

At line 31 (after the existing blue-green import), add:

```typescript
import { blueGreenUpdateMachine } from '../haproxy/blue-green-update-state-machine';
```

Also add `UpdateOptions` to the import from `@mini-infra/types` on line 3-22.

- [ ] **Step 2: Add the `update()` method**

Add this method to the `StackReconciler` class, after the `apply()` method (after line 583):

```typescript
  /**
   * Update a deployed stack by pulling fresh images and redeploying
   * containers whose image digest has changed.
   * StatelessWeb: uses blue-green update state machine (no frontend/DNS reconfiguration).
   * Stateful: simple stop → remove → pull → create → start.
   */
  async update(stackId: string, options?: UpdateOptions): Promise<ApplyResult> {
    const startTime = Date.now();
    const log = servicesLogger().child({ operation: 'stack-update', stackId });

    // 1. Compute plan and force-pull to detect image digest changes
    const plan = await this.plan(stackId);
    await this.promoteStalePullActions(plan, stackId, log);

    // 2. Filter to only actions that need work (digest changed → promoted to 'recreate')
    const actions = plan.actions.filter((a) => a.action !== 'no-op');

    if (actions.length === 0) {
      log.info('All images are up to date — nothing to update');
      // Still record the update attempt
      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: 'update',
          success: true,
          version: plan.stackVersion,
          status: 'synced',
          duration: Date.now() - startTime,
          serviceResults: [],
          triggeredBy: options?.triggeredBy ?? null,
        },
      });
      return {
        success: true,
        stackId,
        appliedVersion: plan.stackVersion,
        serviceResults: [],
        resourceResults: [],
        duration: Date.now() - startTime,
      };
    }

    // 3. Load stack
    const stack = await this.prisma.stack.findUniqueOrThrow({
      where: { id: stackId },
      include: { services: { orderBy: { order: 'asc' } }, environment: true },
    });

    try {
      const projectName = stack.environment ? `${stack.environment.name}-${stack.name}` : stack.name;
      const params = mergeParameterValues(
        (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
        (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {}
      );
      const templateContext = buildStackTemplateContext(stack, params);
      const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
      const { resolvedConfigsMap, resolvedDefinitions, serviceHashes } = resolveServiceConfigs(stack.services, templateContext);

      // Ensure environment networks exist
      const envNetworkMap = await this.resolveEnvironmentNetworks(stack.environmentId, resolvedDefinitions);

      // Get running containers for this stack
      const docker = this.dockerExecutor.getDockerClient();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stackId}`] },
      });
      const containerByService = buildContainerMap(containers);

      const networkNames = (stack.networks as unknown as StackNetwork[]).map(
        (n) => `${projectName}_${n.name}`
      );

      // 4. Execute actions
      const serviceResults: ServiceApplyResult[] = [];
      let completedCount = 0;

      for (const action of actions) {
        const svc = serviceMap.get(action.serviceName);
        const serviceDef = resolvedDefinitions.get(action.serviceName) ?? null;
        const actionStart = Date.now();

        let result: ServiceApplyResult;

        if (svc?.serviceType === 'StatelessWeb' && serviceDef) {
          result = await this.updateStatelessWeb(
            action, svc, serviceDef, projectName, stackId, stack,
            networkNames, serviceHashes, resolvedConfigsMap,
            containerByService, actionStart, log, envNetworkMap
          );
        } else {
          // Stateful: reuse existing applyStateful with 'recreate' action
          result = await this.applyStateful(
            action, svc, serviceDef, projectName, stackId, stack,
            networkNames, serviceHashes, resolvedConfigsMap,
            containerByService, actionStart, log, envNetworkMap
          );
        }

        // Override the action label to 'update' for audit clarity
        result = { ...result, action: 'update' };
        serviceResults.push(result);
        completedCount++;
        options?.onProgress?.(result, completedCount, actions.length);
      }

      const allSucceeded = serviceResults.every((r) => r.success);
      const resultStatus = allSucceeded ? 'synced' : 'error';

      // Update stack status + snapshot
      await this.prisma.stack.update({
        where: { id: stackId },
        data: {
          status: resultStatus,
          lastAppliedVersion: stack.version,
          lastAppliedAt: new Date(),
          lastAppliedSnapshot: serializeStack({
            ...stack,
            services: stack.services.map((s) => ({
              ...s,
              serviceType: s.serviceType as StackServiceDefinition['serviceType'],
              containerConfig: s.containerConfig as unknown as StackContainerConfig,
              configFiles: (s.configFiles as unknown as StackConfigFile[]) ?? null,
              initCommands: (s.initCommands as unknown as StackServiceDefinition['initCommands']) ?? null,
              dependsOn: s.dependsOn as unknown as string[],
              routing: (s.routing as unknown as StackServiceDefinition['routing']) ?? null,
            })),
          } as any) as any,
          status: resultStatus,
        },
      });

      // Record deployment history
      await this.prisma.stackDeployment.create({
        data: {
          stackId,
          action: 'update',
          success: allSucceeded,
          version: stack.version,
          status: resultStatus,
          duration: Date.now() - startTime,
          serviceResults: serviceResults as any,
          triggeredBy: options?.triggeredBy ?? null,
        },
      });

      return {
        success: allSucceeded,
        stackId,
        appliedVersion: stack.version,
        serviceResults,
        resourceResults: [],
        duration: Date.now() - startTime,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      log.error({ error: err.message }, 'Update failed unexpectedly');
      try {
        await this.prisma.stackDeployment.create({
          data: {
            stackId,
            action: 'update',
            success: false,
            version: stack.version,
            status: 'error',
            duration,
            error: err.message,
            triggeredBy: options?.triggeredBy ?? null,
          },
        });
        await this.prisma.stack.update({
          where: { id: stackId },
          data: { status: 'error' },
        });
      } catch (dbErr) {
        log.error({ error: dbErr }, 'Failed to record update failure');
      }
      throw err;
    }
  }
```

- [ ] **Step 3: Add the `updateStatelessWeb()` private method**

Add this method after `applyStatelessWeb()` (after line 1208):

```typescript
  /**
   * Update a StatelessWeb service using the blue-green update state machine
   * (no frontend/DNS reconfiguration — those are already in place).
   */
  private async updateStatelessWeb(
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

    log.info({ service: action.serviceName }, 'Updating StatelessWeb service via blue-green update state machine');

    const baseContext = await this.buildStateMachineContext(
      action, serviceDef, projectName, stackId, stack, serviceHashes, envNetworkMap
    );

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
    };

    const finalState = await runStateMachineToCompletion(
      blueGreenUpdateMachine,
      blueGreenContext,
      (actor) => actor.send({ type: 'START_DEPLOYMENT' })
    );

    const success = finalState.value === 'completed';
    return {
      serviceName: action.serviceName,
      action: 'update',
      success,
      duration: Date.now() - actionStart,
      containerId: (finalState.context as any).newContainerId,
      error: success ? undefined : (finalState.context as any).error ?? 'Blue-green update failed',
    };
  }
```

- [ ] **Step 4: Verify the file compiles**

Run: `npx -w server tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/stacks/stack-reconciler.ts
git commit -m "feat: add update() and updateStatelessWeb() methods to StackReconciler"
```

---

### Task 4: Add `POST /:stackId/update` Endpoint

**Files:**
- Modify: `server/src/routes/stacks.ts`

- [ ] **Step 1: Add the update endpoint**

After the apply endpoint (after line 604), add the following route handler:

```typescript
// POST /:stackId/update — Pull latest images and redeploy changed containers
router.post('/:stackId/update', requirePermission('stacks:write'), async (req, res) => {
  const stackId = String(req.params.stackId);
  try {
    // Prevent concurrent operations on the same stack
    if (applyingStacks.has(stackId)) {
      return res.status(409).json({ success: false, message: 'Stack operation already in progress' });
    }

    // Validate stack exists and is deployed
    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      select: { id: true, name: true, status: true },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }
    if (stack.status !== 'synced' && stack.status !== 'drifted') {
      return res.status(400).json({
        success: false,
        message: `Stack must be deployed to update (current status: ${stack.status})`,
      });
    }

    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const routingManager = new StackRoutingManager(prisma, new HAProxyFrontendManager());
    const resourceReconciler = await createResourceReconciler();
    const reconciler = new StackReconciler(dockerExecutor, prisma, routingManager, resourceReconciler);

    applyingStacks.add(stackId);

    // Emit started event — use same STACK_APPLY events with action context
    // We emit a generic "pull" action per service since we don't know which will change yet
    const plan = await reconciler.plan(stackId);
    const startedActions = plan.actions.map((a) => ({ serviceName: a.serviceName, action: 'update' }));

    emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_STARTED, {
      stackId,
      stackName: plan.stackName,
      totalActions: startedActions.length,
      actions: startedActions,
      forcePull: true,
    });

    // Respond immediately
    res.json({ success: true, data: { started: true, stackId } });

    // Run update in background
    const triggeredBy = (req as any).user?.id;
    (async () => {
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
          },
        });

        emitToChannel(Channel.STACKS, ServerEvent.STACK_APPLY_COMPLETED, {
          ...result,
        });
      } catch (error: any) {
        logger.error({ error: error.message, stackId }, 'Background stack update failed');
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
  } catch (error: any) {
    applyingStacks.delete(stackId);
    if (isDockerConnectionError(error)) {
      return res.status(503).json({ success: false, message: 'Docker is unavailable' });
    }
    logger.error({ error, stackId }, 'Failed to start stack update');
    res.status(500).json({ success: false, message: error?.message ?? 'Failed to update stack' });
  }
});
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx -w server tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/stacks.ts
git commit -m "feat: add POST /stacks/:id/update endpoint"
```

---

### Task 5: Add `"stack-update"` Task Type to Frontend

**Files:**
- Modify: `client/src/lib/task-tracker-types.ts`
- Modify: `client/src/lib/task-type-registry.ts`

- [ ] **Step 1: Add `"stack-update"` to the TaskType union**

In `client/src/lib/task-tracker-types.ts`, line 11-18, add `"stack-update"` to the union:

```typescript
export type TaskType =
  | "cert-issuance"
  | "connect-container"
  | "stack-apply"
  | "stack-destroy"
  | "stack-update"
  | "migration"
  | "sidecar-startup"
  | "self-update-launch";
```

- [ ] **Step 2: Add registry entry for `"stack-update"`**

In `client/src/lib/task-type-registry.ts`, after the `"stack-apply"` entry (after line 119), add:

```typescript
  "stack-update": {
    channel: Channel.STACKS,
    startedEvent: ServerEvent.STACK_APPLY_STARTED,
    stepEvent: ServerEvent.STACK_APPLY_SERVICE_RESULT,
    completedEvent: ServerEvent.STACK_APPLY_COMPLETED,
    getId: (p) => p.stackId,
    normalizeStarted: (p) => ({
      totalSteps: p.totalActions,
      plannedStepNames: (p.actions as Array<{ serviceName: string; action: string }>).map(
        (a) => `update ${a.serviceName}`,
      ),
    }),
    normalizeStep: (p) => ({
      step: `update ${p.serviceName}`,
      status: p.success ? "completed" : "failed",
      detail: p.error ?? undefined,
    }),
    normalizeCompleted: (p) => ({
      success: p.success,
      steps: (p.serviceResults as Array<{ serviceName: string; action: string; success: boolean; error?: string }>).map(
        (r) => ({
          step: `update ${r.serviceName}`,
          status: (r.success ? "completed" : "failed") as OperationStep["status"],
          detail: r.error ?? undefined,
        }),
      ),
      errors: p.error ? [p.error] : [],
    }),
    invalidateKeys: (taskId) => [
      ["stacks"],
      ["stack", taskId],
      ["stackPlan", taskId],
      ["stackStatus", taskId],
      ["stackHistory", taskId],
      ["applications"],
      ["userStacks"],
    ],
  },
```

- [ ] **Step 3: Verify frontend compiles**

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Successful build.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/task-tracker-types.ts client/src/lib/task-type-registry.ts
git commit -m "feat: add stack-update task type to task tracker registry"
```

---

### Task 6: Add `useUpdateApplication` Hook

**Files:**
- Modify: `client/src/hooks/use-applications.ts`

- [ ] **Step 1: Add `updateStack()` API function**

After the `destroyStack()` function (after line 333), add:

```typescript
async function updateStack(
  stackId: string,
  correlationId: string,
): Promise<{ success: boolean; data: { started: true; stackId: string } }> {
  const response = await fetch(`/api/stacks/${stackId}/update`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    let errorMessage = `Failed to update application: ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  return await response.json();
}
```

- [ ] **Step 2: Add `useUpdateApplication()` hook**

After the `useStopApplication()` hook (after line 540), add:

```typescript
export function useUpdateApplication() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: async (stackId: string) => {
      await updateStack(stackId, correlationId);
    },
    onSuccess: () => {
      toast.success("Application update started");
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["userStacks"] });
      queryClient.invalidateQueries({ queryKey: ["stacks"] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to update application: ${error.message}`);
    },
  });
}
```

- [ ] **Step 3: Verify frontend compiles**

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Successful build.

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/use-applications.ts
git commit -m "feat: add useUpdateApplication hook and updateStack API function"
```

---

### Task 7: Create Update Application Dialog

**Files:**
- Create: `client/src/app/applications/update-application-dialog.tsx`

- [ ] **Step 1: Create the confirmation dialog**

Create `client/src/app/applications/update-application-dialog.tsx`:

```tsx
import { IconLoader2, IconRefresh } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useUpdateApplication } from "@/hooks/use-applications";
import { useTaskTracker } from "@/components/task-tracker/task-tracker-context";
import { Channel } from "@mini-infra/types";
import type { StackTemplateInfo, StackInfo } from "@mini-infra/types";

interface UpdateApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: StackTemplateInfo | null;
  stack: StackInfo | null;
}

export function UpdateApplicationDialog({
  open,
  onOpenChange,
  application,
  stack,
}: UpdateApplicationDialogProps) {
  const updateApplication = useUpdateApplication();
  const { trackTask } = useTaskTracker();

  const handleUpdate = async () => {
    if (!stack) return;

    try {
      trackTask({
        id: stack.id,
        type: "stack-update",
        label: `Updating ${application?.displayName ?? application?.name ?? "application"}`,
        channel: Channel.STACKS,
      });
      await updateApplication.mutateAsync(stack.id);
      onOpenChange(false);
    } catch {
      // Error handled by mutation's onError
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconRefresh className="h-5 w-5" />
            Update Application
          </DialogTitle>
          <DialogDescription>
            This will pull the latest image and redeploy &quot;{application?.displayName ?? application?.name}&quot;.
            Web services will be updated with zero downtime.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleUpdate}
            disabled={updateApplication.isPending}
          >
            {updateApplication.isPending && (
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Successful build.

- [ ] **Step 3: Commit**

```bash
git add client/src/app/applications/update-application-dialog.tsx
git commit -m "feat: add UpdateApplicationDialog confirmation component"
```

---

### Task 8: Add Update Button to Applications Page

**Files:**
- Modify: `client/src/app/applications/page.tsx`

- [ ] **Step 1: Add imports**

Add to the existing imports at the top of `client/src/app/applications/page.tsx`:

```typescript
import { IconRefresh } from "@tabler/icons-react";
import { useUpdateApplication } from "@/hooks/use-applications";
import { UpdateApplicationDialog } from "./update-application-dialog";
```

- [ ] **Step 2: Add state for update target**

In the component, alongside the existing state declarations (near `deployTarget`, `stoppingId`), add:

```typescript
const [updateTarget, setUpdateTarget] = useState<StackTemplateInfo | null>(null);
```

- [ ] **Step 3: Add the Update button to card actions**

In the card's button group (where Deploy and Stop buttons are rendered), add an Update button between Deploy and Stop:

```tsx
<Button
  size="sm"
  variant="outline"
  className="flex-1"
  disabled={!stackByTemplateId.has(app.id)}
  onClick={() => setUpdateTarget(app)}
>
  <IconRefresh className="h-4 w-4 mr-1" />
  Update
</Button>
```

- [ ] **Step 4: Add the dialog**

Near the existing `<DeployApplicationDialog>` (around line 349), add the update dialog:

```tsx
<UpdateApplicationDialog
  open={!!updateTarget}
  onOpenChange={(open) => {
    if (!open) setUpdateTarget(null);
  }}
  application={updateTarget}
  stack={updateTarget ? stackByTemplateId.get(updateTarget.id) ?? null : null}
/>
```

- [ ] **Step 5: Verify frontend compiles**

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Successful build.

- [ ] **Step 6: Commit**

```bash
git add client/src/app/applications/page.tsx
git commit -m "feat: add Update button to application cards"
```

---

### Task 9: Integration Test — Update Endpoint

**Files:**
- Modify: Add test to existing test file or create if needed

- [ ] **Step 1: Find existing stack route tests**

Run: `find server/src -name "*.test.*" | grep -i stack | head -10`

Check if there's an existing test file for stack routes. If there is, add tests there. If not, this step validates the endpoint works via build + manual testing.

- [ ] **Step 2: Verify full build succeeds**

Run: `npm run build:lib && npx -w server tsc --noEmit --pretty 2>&1 | tail -10`
Expected: No type errors.

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Successful build.

- [ ] **Step 3: Run existing tests to confirm no regressions**

Run: `npm test -w server 2>&1 | tail -20`
Expected: All existing tests pass.

Run: `npm test -w client 2>&1 | tail -20`
Expected: All existing tests pass.

- [ ] **Step 4: Commit if any test files were added**

```bash
git add -A
git commit -m "test: verify no regressions from update feature"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Verify full build**

```bash
npm run build:lib && npm run build -w client
```

- [ ] **Step 2: Run all tests**

```bash
npm test -w server && npm test -w client
```

- [ ] **Step 3: Review all changes**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Verify the commit history covers:
1. Blue-green update state machine
2. Shared types (`UpdateOptions`)
3. Reconciler `update()` + `updateStatelessWeb()` methods
4. `POST /stacks/:id/update` endpoint
5. Task tracker types + registry
6. `useUpdateApplication` hook
7. `UpdateApplicationDialog`
8. Update button on Applications page
