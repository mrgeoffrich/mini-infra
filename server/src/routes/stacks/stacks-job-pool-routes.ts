import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler';
import { requireSessionOrApiKey } from '../../middleware/auth';

/**
 * JobPool runtime routes (Phase 1, MINI-50).
 *
 * Only the manual-trigger stub lives here today — Phase 3 activates the route
 * with the real `runJobPool()` dispatch and adds the cron + NATS-request
 * trigger registries that drive the same entry point. Returning a stable 501
 * envelope (rather than 404) makes the surface discoverable and lets clients
 * differentiate "not implemented yet" from "no such pool" in their error
 * handling.
 */
const router = Router();

router.post(
  '/:stackId/job-pools/:serviceName/run',
  requireSessionOrApiKey,
  asyncHandler(async (req, res) => {
    const { stackId, serviceName } = req.params as { stackId: string; serviceName: string };
    res.status(501).json({
      success: false,
      code: 'NOT_IMPLEMENTED',
      message:
        'Manual JobPool trigger is not yet implemented — coming in Phase 3 of the job-pool-service-type plan (MINI-52).',
      stackId,
      serviceName,
    });
  }),
);

export default router;
