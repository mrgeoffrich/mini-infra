import { Router } from 'express';
import prisma from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { requirePermission } from '../../middleware/auth';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import { serializeStack, assertStackFound } from '../../services/stacks/utils';
import {
  restoreStackFromSnapshot,
  isUsableSnapshot,
} from '../../services/stacks/stack-restore-service';
import { emitStackStatusChanged } from '../../services/stacks/stack-socket-emitter';
import { ErrorCode, Permission } from '@mini-infra/types';
import { ConflictError, ValidationError } from '../../lib/errors';

const router = Router();

// POST /:stackId/revert-pending — Discard unapplied definition edits by
// restoring the stack's definition from its last applied snapshot and flipping
// status back to `synced`. This is the "way back" for a stack that was edited
// (status `pending`) but never applied. Never-deployed stacks have no snapshot
// to revert to, so they 400. Synchronous (a single fast transaction) — no
// background phase, no containers touched.
router.post(
  '/:stackId/revert-pending',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const stack = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        select: {
          id: true,
          name: true,
          lastAppliedSnapshot: true,
          lastAppliedVersion: true,
        },
      }),
      stackId,
    );

    const snapshot = stack.lastAppliedSnapshot;
    if (!isUsableSnapshot(snapshot)) {
      throw new ValidationError(
        ErrorCode.STACK_NO_APPLIED_SNAPSHOT,
        'This stack has never been applied, so there are no changes to discard.',
        {
          resource: { type: 'stack', id: stackId, name: stack.name },
          action: 'Apply the stack to establish a baseline before you can revert to it.',
        },
      );
    }

    if (stackOperationLock.has(stackId)) {
      throw new ConflictError(
        ErrorCode.STACK_OPERATION_IN_PROGRESS,
        'An operation is already in progress for this stack',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Wait for the in-flight operation to finish before retrying.',
        },
      );
    }
    stackOperationLock.tryAcquire(stackId);

    try {
      await restoreStackFromSnapshot(prisma, stackId, snapshot, {
        // The restored definition IS what last reached containers, so `synced`
        // is the truth and the revision counter rewinds to match.
        status: 'synced',
        rewindToVersion: stack.lastAppliedVersion,
      });
    } finally {
      stackOperationLock.release(stackId);
    }

    emitStackStatusChanged(stackId, 'synced');

    const updated = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        include: { services: { orderBy: { order: 'asc' } } },
      }),
      stackId,
    );
    res.json({ success: true, data: serializeStack(updated) });
  }),
);

export default router;
