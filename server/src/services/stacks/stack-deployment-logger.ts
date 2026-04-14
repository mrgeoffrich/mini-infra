import type { PrismaClient } from "../../generated/prisma/client";
import type { Logger } from 'pino';

/**
 * Record a failed deployment and mark the stack as errored.
 * Swallows DB errors so failure recording never masks the original error.
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
    await prisma.stack.update({
      where: { id: stackId },
      data: { status: 'error' },
    });
  } catch (dbErr) {
    log.error({ error: dbErr }, `Failed to record ${actionType} failure`);
  }
}
