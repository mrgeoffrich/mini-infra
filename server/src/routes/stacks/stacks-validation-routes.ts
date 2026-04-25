import { Router } from 'express';
import prisma from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { requirePermission } from '../../middleware/auth';
import { DockerExecutorService } from '../../services/docker-executor';
import { StackReconciler } from '../../services/stacks/stack-reconciler';
import { createResourceReconciler } from '../../services/stacks/resource-reconciler-factory';
import { findEmptyStackParameters } from '../../services/stacks/parameter-validation';
import { checkStackConfigurationRequirements } from '../../services/stacks/stack-config-requirements';
import type { StackValidationResult, StackValidationWarning, StackNetwork } from '@mini-infra/types';
import { DEFAULT_STACK_NETWORK_NAME } from '../../services/stacks/utils';

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

    const missingConfig = await checkStackConfigurationRequirements(prisma, stackId);
    if (missingConfig) {
      return res.status(422).json({
        success: false,
        code: missingConfig.code,
        message: missingConfig.message,
        missing: missingConfig.missing,
      });
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
      select: {
        parameters: true,
        parameterValues: true,
        networks: true,
        services: { select: { serviceName: true, serviceType: true, containerConfig: true } },
      },
    });
    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const errors = findEmptyStackParameters(stack.parameters, stack.parameterValues);
    const warnings: StackValidationWarning[] = [];

    // Heads-up when a stack has 2+ container-bearing services and no declared
    // network — apply auto-creates a 'default' network so they can resolve each
    // other by service name. Surface this so operators aren't surprised.
    const declaredNetworks = (stack.networks as unknown as StackNetwork[]) ?? [];
    const containerBearingServices = stack.services.filter(
      (s) => s.serviceType === 'Stateful' || s.serviceType === 'StatelessWeb',
    );
    if (declaredNetworks.length === 0 && containerBearingServices.length >= 2) {
      const names = containerBearingServices.map((s) => s.serviceName).join(', ');
      warnings.push({
        code: 'auto_default_network',
        message: `Services [${names}] have no shared network declared. A '${DEFAULT_STACK_NETWORK_NAME}' bridge network will be auto-created at apply time so they can resolve each other by service name.`,
      });
    }

    const result: StackValidationResult = {
      success: true,
      valid: errors.length === 0,
      errors,
      warnings,
    };
    res.json(result);
  }),
);

export default router;
