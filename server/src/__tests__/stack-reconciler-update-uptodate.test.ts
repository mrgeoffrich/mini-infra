/**
 * Unit test for the "already up to date" update result (P2 feedback niceties).
 *
 * When a pull-latest `update` finds every image already current, `updateInner`
 * short-circuits with a distinguishable `upToDate: true` result (and records a
 * zero-work deployment row) so the client can toast "Already up to date" rather
 * than a generic success.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "../generated/prisma/client";
import type { DockerExecutorService } from "../services/docker-executor";
import type { StackPlan } from "@mini-infra/types";
import { StackReconciler } from "../services/stacks/stack-reconciler";

function makePlan(overrides: Partial<StackPlan> = {}): StackPlan {
  return {
    stackId: "stack-1",
    stackName: "monitoring",
    stackVersion: 7,
    planTime: new Date().toISOString(),
    actions: [],
    resourceActions: [],
    networkActions: [],
    hasChanges: false,
    ...overrides,
  };
}

interface ReconcilerPrivates {
  plan: (stackId: string) => Promise<StackPlan>;
  promoteStalePullActions: (
    plan: StackPlan,
    stackId: string,
    log: unknown,
  ) => Promise<void>;
}

describe("StackReconciler.update — up-to-date result", () => {
  it("returns upToDate:true and records a zero-work deployment when nothing to pull", async () => {
    const createDeployment = vi.fn().mockResolvedValue({});
    const prisma = {
      stackDeployment: {
        create: createDeployment,
        // Snapshot retention runs after the deployment row is written.
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaClient;
    const dockerExecutor = {} as unknown as DockerExecutorService;

    const reconciler = new StackReconciler(dockerExecutor, prisma);
    const privates = reconciler as unknown as ReconcilerPrivates;

    // Plan shows every service already current (all no-op / empty actions).
    vi.spyOn(privates, "plan").mockResolvedValue(
      makePlan({ actions: [{ serviceName: "web", action: "no-op" } as never] }),
    );
    // No pull actions to promote — stub so it doesn't touch Docker.
    vi.spyOn(privates, "promoteStalePullActions").mockResolvedValue(undefined);

    const result = await reconciler.update("stack-1");

    expect(result.upToDate).toBe(true);
    expect(result.success).toBe(true);
    expect(result.serviceResults).toEqual([]);
    expect(result.appliedVersion).toBe(7);

    // Records a zero-work deployment row so history stays honest.
    expect(createDeployment).toHaveBeenCalledTimes(1);
    const deployment = createDeployment.mock.calls[0]![0].data;
    expect(deployment.action).toBe("update");
    expect(deployment.success).toBe(true);
    expect(deployment.serviceResults).toEqual([]);
  });
});
