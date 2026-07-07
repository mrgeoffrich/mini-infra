import { Router } from 'express';
import { Prisma } from "../../generated/prisma/client";
import prisma from '../../lib/prisma';
import { asyncHandler } from '../../lib/async-handler';
import { requirePermission } from '../../middleware/auth';
import { updateStackServiceSchema } from '../../services/stacks/schemas';
import { serializeStack, assertStackFound } from '../../services/stacks/utils';
import { ErrorCode, Permission } from '@mini-infra/types';
import { NotFoundError } from '../../lib/errors';

const router = Router();

// PUT /:stackId/services/:serviceName — Update single service
router.put(
  '/:stackId/services/:serviceName',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const parsed = updateStackServiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        issues: parsed.error.issues,
      });
    }

    const stackId = String(req.params.stackId);
    const serviceName = String(req.params.serviceName);

    const service = await prisma.stackService.findFirst({
      where: { stackId, serviceName },
    });

    if (!service) {
      throw new NotFoundError(ErrorCode.STACK_SERVICE_NOT_FOUND, 'Stack service not found', {
        resource: { type: 'stackService', name: serviceName, id: stackId },
        action: 'Check the stack ID and service name.',
      });
    }

    const updateData: Prisma.StackServiceUpdateInput = {};
    const data = parsed.data;
    if (data.serviceType !== undefined) updateData.serviceType = data.serviceType;
    if (data.dockerImage !== undefined) updateData.dockerImage = data.dockerImage;
    if (data.dockerTag !== undefined) updateData.dockerTag = data.dockerTag;
    if (data.containerConfig !== undefined)
      updateData.containerConfig = data.containerConfig as unknown as Prisma.InputJsonValue;
    if (data.configFiles !== undefined)
      updateData.configFiles = data.configFiles as unknown as Prisma.InputJsonValue;
    if (data.initCommands !== undefined)
      updateData.initCommands = data.initCommands as unknown as Prisma.InputJsonValue;
    if (data.dependsOn !== undefined) updateData.dependsOn = data.dependsOn;
    if (data.order !== undefined) updateData.order = data.order;
    if (data.routing !== undefined)
      updateData.routing = data.routing as unknown as Prisma.InputJsonValue;
    if (data.adoptedContainer !== undefined) {
      updateData.adoptedContainer =
        data.adoptedContainer === null
          ? Prisma.DbNull
          : (data.adoptedContainer as unknown as Prisma.InputJsonValue);
    }
    if (data.poolConfig !== undefined) {
      updateData.poolConfig =
        data.poolConfig === null
          ? Prisma.DbNull
          : (data.poolConfig as unknown as Prisma.InputJsonValue);
    }
    if (data.vaultAppRoleId !== undefined) {
      updateData.vaultAppRole =
        data.vaultAppRoleId === null
          ? { disconnect: true }
          : { connect: { id: data.vaultAppRoleId } };
    }
    if (data.natsCredentialId !== undefined) {
      updateData.natsCredential =
        data.natsCredentialId === null
          ? { disconnect: true }
          : { connect: { id: data.natsCredentialId } };
    }

    await prisma.$transaction([
      prisma.stackService.update({ where: { id: service.id }, data: updateData }),
      prisma.stack.update({
        where: { id: stackId },
        data: { version: { increment: 1 }, status: 'pending' },
      }),
    ]);

    const stack = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        include: { services: { orderBy: { order: 'asc' } } },
      }),
      stackId,
    );

    res.json({ success: true, data: serializeStack(stack) });
  }),
);

export default router;
