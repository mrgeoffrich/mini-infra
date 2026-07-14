import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { asyncHandler } from '../../lib/async-handler';
import { getUserId } from '../../lib/get-user-id';
import { requirePermission } from '../../middleware/auth';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import { upgradeStackToCurrentTemplateVersion } from '../../services/stacks/stack-upgrade-service';
import { assertStackFound } from '../../services/stacks/utils';
import { ErrorCode, Permission } from '@mini-infra/types';
import { ConflictError, ValidationError } from '../../lib/errors';

const logger = getLogger('stacks', 'stacks-upgrade-route');
const router = Router();

const upgradeBodySchema = z.object({
  // Operator-supplied input values required by rotateOnUpgrade declarations on
  // the target version. Optional — omitted when the template has no such inputs.
  inputValues: z.record(z.string(), z.string()).optional(),
});

// POST /:stackId/upgrade — Re-materialize the stack from its template's current
// published version (parameter + input merge), bump status to `pending`. Does
// NOT apply — the client chains POST /:stackId/apply afterwards.
router.post(
  '/:stackId/upgrade',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);

    const parsed = upgradeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError(
        ErrorCode.VALIDATION_FAILED,
        'Invalid upgrade request body',
        { action: 'inputValues must be a map of string → string.' },
      );
    }

    // 404 unknown stack before touching the lock.
    assertStackFound(
      await prisma.stack.findUnique({ where: { id: stackId }, select: { id: true } }),
      stackId,
    );

    if (stackOperationLock.has(stackId)) {
      throw new ConflictError(
        ErrorCode.STACK_OPERATION_IN_PROGRESS,
        'An operation is already in progress for this stack',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Wait for the in-flight operation to finish before upgrading.',
        },
      );
    }
    stackOperationLock.tryAcquire(stackId);

    let updated;
    try {
      updated = await upgradeStackToCurrentTemplateVersion(prisma, stackId, {
        suppliedInputValues: parsed.data.inputValues,
        userId: getUserId(req),
      });
    } finally {
      stackOperationLock.release(stackId);
    }

    logger.info(
      { stackId, toVersion: updated.templateVersion },
      'Stack upgraded to current template version',
    );
    res.json({ success: true, data: updated });
  }),
);

export default router;
