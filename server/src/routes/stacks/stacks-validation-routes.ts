import { Router } from 'express';
import prisma from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { requirePermission } from '../../middleware/auth';
import { DockerExecutorService } from '../../services/docker-executor';
import { StackReconciler } from '../../services/stacks/stack-reconciler';
import { createResourceReconciler } from '../../services/stacks/resource-reconciler-factory';
import { findEmptyStackParameters } from '../../services/stacks/parameter-validation';
import type { StackValidationResult } from '@mini-infra/types';

const router = Router();

// GET /:stackId/plan — Compute reconciliation plan
router.get(
  '/:stackId/plan',
  requirePermission('stacks:read'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const exists = await prisma.stack.findUnique({
      where: { id: stackId },
      select: { id: true },
    });
    if (!exists) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const dockerExecutor = new DockerExecutorService();
    await dockerExecutor.initialize();
    const resourceReconciler = await createResourceReconciler();
    const reconciler = new StackReconciler(dockerExecutor, prisma, undefined, resourceReconciler);
    const plan = await reconciler.plan(stackId);

    res.json({ success: true, data: plan });
  }),
);

// GET /:stackId/validate — Validate stack parameters before apply
router.get(
  '/:stackId/validate',
  requirePermission('stacks:read'),
  asyncHandler(async (req, res) => {
    const stack = await prisma.stack.findUnique({
      where: { id: String(req.params.stackId) },
      select: { parameters: true, parameterValues: true },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const errors = findEmptyStackParameters(stack.parameters, stack.parameterValues);

    const result: StackValidationResult = {
      success: true,
      valid: errors.length === 0,
      errors,
    };
    res.json(result);
  }),
);

export default router;
