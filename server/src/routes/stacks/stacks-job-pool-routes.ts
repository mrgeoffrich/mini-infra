import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler';
import { requireSessionOrApiKey } from '../../middleware/auth';
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { DockerExecutorService } from '../../services/docker-executor';
import { runJobPool } from '../../services/stacks/job-pool-spawner';
import { jobPoolTriggerRequestSchema } from '../../services/nats/payload-schemas';
import { ErrorCode } from '@mini-infra/types';
import { ConflictError, NotFoundError } from '../../lib/errors';

const log = getLogger('stacks', 'stacks-job-pool-routes');
const router = Router();

/**
 * Build an initialised DockerExecutorService for a single request. Mirrors
 * the helper in `stacks-pool-routes.ts` — the underlying Docker client is a
 * singleton, so this is cheap.
 */
async function buildDockerExecutor(): Promise<DockerExecutorService> {
  const executor = new DockerExecutorService();
  await executor.initialize();
  return executor;
}

/**
 * Manual JobPool trigger route (Phase 3, MINI-52).
 *
 * Activated from the Phase 1 501 stub. Forwards an optional JSON body to
 * the spawned container as `JOB_PAYLOAD`, returns `{ runId }` on success
 * or `429 { error: "concurrency_cap_reached", maxConcurrent }` when the
 * pool is at cap. Service / stack-not-found surface as 404; stack-in-error
 * as 409; any other server-side failure as 500.
 */
router.post(
  '/:stackId/job-pools/:serviceName/run',
  requireSessionOrApiKey,
  asyncHandler(async (req, res) => {
    const { stackId, serviceName } = req.params as { stackId: string; serviceName: string };

    // Optional JSON body; tolerate empty bodies so a bare POST without
    // Content-Type still spawns. Validate using the same envelope schema
    // the NATS registry uses so the two surfaces enforce identical limits.
    let payload: Record<string, unknown> | undefined;
    if (req.body !== undefined && req.body !== null && Object.keys(req.body).length > 0) {
      const parsed = jobPoolTriggerRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PAYLOAD',
          message: parsed.error.issues[0]?.message ?? 'invalid request body',
        });
      }
      payload = parsed.data;
    }

    const dockerExecutor = await buildDockerExecutor();

    const result = await runJobPool(prisma, dockerExecutor, {
      stackId,
      serviceName,
      trigger: { kind: 'manual', name: 'manual-http' },
      payload,
    });

    if (result.ok) {
      log.info(
        { stackId, serviceName, runId: result.runId, containerId: result.containerId },
        'Manual JobPool trigger spawned run',
      );
      return res.status(200).json({ success: true, runId: result.runId });
    }

    if (result.reason === 'concurrency_cap') {
      log.info(
        { stackId, serviceName, maxConcurrent: result.maxConcurrent },
        'Manual JobPool trigger rejected — concurrency cap',
      );
      return res.status(429).json({
        success: false,
        code: 'CONCURRENCY_CAP_REACHED',
        error: 'concurrency_cap_reached',
        maxConcurrent: result.maxConcurrent,
      });
    }

    if (result.reason === 'service_not_found' || result.reason === 'stack_not_found') {
      throw new NotFoundError(ErrorCode.STACK_JOB_POOL_NOT_FOUND, result.message, {
        resource: { type: 'stackJobPool', name: serviceName, id: stackId },
        action: 'Check the stack ID and service name.',
      });
    }

    if (result.reason === 'stack_in_error') {
      throw new ConflictError(ErrorCode.STACK_JOB_POOL_STACK_IN_ERROR, result.message, {
        resource: { type: 'stack', id: stackId },
        action: 'Resolve the stack error (or re-apply) before triggering this job pool.',
      });
    }

    // `spawn_failed` — only branch left. A genuine internal/infra failure,
    // not a user-actionable 4xx — a plain Error still reaches the central
    // middleware's generic 500 path instead of a bespoke body here.
    log.error(
      {
        stackId,
        serviceName,
        error: result.message,
        instanceRowId: result.reason === 'spawn_failed' ? result.instanceRowId : null,
      },
      'Manual JobPool trigger spawn failed',
    );
    throw new Error(result.message);
  }),
);

export default router;
