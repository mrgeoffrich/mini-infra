import type { PrismaClient } from "../../generated/prisma/client";
import type { Logger } from 'pino';

/**
 * Flip a stack to `error` and record a human-readable failure reason on the
 * stack row. Swallows DB errors so failure recording never masks the original
 * error.
 *
 * This is the single source of truth for "an operation failed — leave the
 * stack in a persisted, recoverable error state". Both the reconciler's own
 * end-of-apply failure recording and the apply/update route's pre-reconciler
 * catch blocks (Vault / NATS / JobPool / plan-init phases) call it, so no
 * failure path can silently leave a stack stuck in `pending`.
 */
export async function markStackErrored(
  prisma: PrismaClient,
  stackId: string,
  reason: string,
  log: Logger,
): Promise<void> {
  try {
    await prisma.stack.update({
      where: { id: stackId },
      data: { status: 'error', lastFailureReason: reason },
    });
  } catch (dbErr) {
    log.error({ error: dbErr, stackId }, 'Failed to persist stack error status');
  }
}

/**
 * Record a failed deployment and mark the stack as errored (with the failure
 * reason). Swallows DB errors so failure recording never masks the original
 * error.
 */
export async function recordDeploymentFailure(
  prisma: PrismaClient,
  stackId: string,
  actionType: 'apply' | 'update',
  version: number,
  duration: number,
  error: string,
  triggeredBy: string | null | undefined,
  log: Logger
): Promise<void> {
  try {
    await prisma.stackDeployment.create({
      data: {
        stackId,
        action: actionType,
        success: false,
        version,
        status: 'error',
        duration,
        error,
        triggeredBy: triggeredBy ?? null,
      },
    });
  } catch (dbErr) {
    log.error({ error: dbErr }, `Failed to record ${actionType} failure`);
  }
  // Persist the terminal error status + reason via the shared helper so the
  // stack row state can't drift from the deployment-history row.
  await markStackErrored(prisma, stackId, error, log);
}
