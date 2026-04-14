import { Router } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { appLogger } from '../../lib/logger-factory';
import { asyncHandler } from '../../lib/async-handler';
import { requirePermission } from '../../middleware/auth';
import { requireDockerConnected } from '../../middleware/require-docker-connected';
import { DockerExecutorService } from '../../services/docker-executor';
import DockerService from '../../services/docker';
import {
  createStackSchema,
  updateStackSchema,
} from '../../services/stacks/schemas';
import {
  serializeStack,
  toServiceCreateInput,
} from '../../services/stacks/utils';
import type {
  StackAdoptionCandidate,
  StackAdoptionCandidatesResponse,
  StackServiceDefinition,
} from '@mini-infra/types';

const logger = appLogger();

const router = Router();

// GET / — List stacks
router.get(
  '/',
  requirePermission('stacks:read'),
  asyncHandler(async (req, res) => {
    const { environmentId, scope, source } = req.query;
    const where: Prisma.StackWhereInput = {};
    if (scope === 'host') {
      where.environmentId = null;
    } else if (environmentId && typeof environmentId === 'string') {
      where.environmentId = environmentId;
    }

    if (source === 'user') {
      where.template = { source: 'user' };
    } else if (source === 'system') {
      where.OR = [
        { template: { source: 'system' } },
        { templateId: null },
      ];
    } else if (scope === 'host' || environmentId) {
      where.OR = [
        { template: { source: 'system' } },
        { templateId: null },
      ];
    }

    const stacks = await prisma.stack.findMany({
      where,
      include: {
        services: true,
        template: { select: { source: true, currentVersion: { select: { version: true } } } },
      },
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, data: stacks.map(serializeStack) });
  }),
);

// GET /eligible-containers — List unadopted containers for AdoptedWeb
// Must come before /:stackId to avoid parameter collision.
router.get(
  '/eligible-containers',
  requirePermission('stacks:read'),
  requireDockerConnected(),
  asyncHandler(async (req, res) => {
    const environmentId = req.query.environmentId as string | undefined;
    if (!environmentId) {
      return res
        .status(400)
        .json({ success: false, message: 'environmentId query parameter is required' });
    }

    const docker = DockerService.getInstance();
    const allContainers = await docker.listContainers(false);
    const { getOwnContainerId } = await import('../../services/self-update');
    const ownContainerId = getOwnContainerId();

    const eligible: StackAdoptionCandidate[] = allContainers
      .map((c) => {
        const hasStackLabel = !!c.labels['mini-infra.stack-id'];
        const isSelf = ownContainerId && c.id.startsWith(ownContainerId);
        const ports = c.ports.map((p) => ({
          containerPort: p.private,
          protocol: p.type || 'tcp',
        }));

        return {
          id: c.id,
          name: c.name,
          image: c.image,
          imageTag: c.imageTag,
          status: c.status,
          ports,
          isSelf: !!isSelf,
          isManagedByStack: hasStackLabel,
          managedByStack: hasStackLabel ? c.labels['mini-infra.stack'] : undefined,
        };
      })
      .filter((c) => !c.isManagedByStack || c.isSelf);

    const response: StackAdoptionCandidatesResponse = { success: true, data: eligible };
    res.json(response);
  }),
);

// GET /:stackId — Get stack with services
router.get(
  '/:stackId',
  requirePermission('stacks:read'),
  asyncHandler(async (req, res) => {
    const stack = await prisma.stack.findUnique({
      where: { id: String(req.params.stackId) },
      include: {
        services: { orderBy: { order: 'asc' } },
        template: { select: { currentVersion: { select: { version: true } } } },
      },
    });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    res.json({ success: true, data: serializeStack(stack) });
  }),
);

// POST / — Create stack
router.post(
  '/',
  requirePermission('stacks:write'),
  asyncHandler(async (req, res) => {
    const parsed = createStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const {
      name,
      description,
      environmentId,
      parameters,
      parameterValues,
      resourceOutputs,
      resourceInputs,
      networks,
      volumes,
      services,
      tlsCertificates,
      dnsRecords,
      tunnelIngress,
    } = parsed.data;

    if (environmentId) {
      const environment = await prisma.environment.findUnique({ where: { id: environmentId } });
      if (!environment) {
        return res.status(404).json({ success: false, message: 'Environment not found' });
      }

      const existing = await prisma.stack.findFirst({
        where: { name, environmentId, status: { not: 'removed' } },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'A stack with this name already exists in this environment',
        });
      }
    } else {
      const existing = await prisma.stack.findFirst({
        where: { name, environmentId: null, status: { not: 'removed' } },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'A host-level stack with this name already exists',
        });
      }
    }

    const stack = await prisma.stack.create({
      data: {
        name,
        description: description ?? null,
        environmentId: environmentId ?? undefined,
        parameters: parameters ? (parameters as unknown as Prisma.InputJsonValue) : undefined,
        parameterValues: parameterValues
          ? (parameterValues as unknown as Prisma.InputJsonValue)
          : undefined,
        resourceOutputs: resourceOutputs
          ? (resourceOutputs as unknown as Prisma.InputJsonValue)
          : undefined,
        resourceInputs: resourceInputs
          ? (resourceInputs as unknown as Prisma.InputJsonValue)
          : undefined,
        networks: networks as unknown as Prisma.InputJsonValue,
        volumes: volumes as unknown as Prisma.InputJsonValue,
        tlsCertificates: tlsCertificates ?? [],
        dnsRecords: dnsRecords ?? [],
        tunnelIngress: tunnelIngress ?? [],
        services: {
          create: (services as StackServiceDefinition[]).map(toServiceCreateInput),
        },
      },
      include: { services: true },
    });

    logger.info({ stackId: stack.id, stackName: stack.name }, 'Stack created');
    res.status(201).json({ success: true, data: serializeStack(stack) });
  }),
);

// PUT /:stackId — Update stack definition
router.put(
  '/:stackId',
  requirePermission('stacks:write'),
  asyncHandler(async (req, res) => {
    const parsed = updateStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const stackId = String(req.params.stackId);
    const existing = await prisma.stack.findUnique({
      where: { id: stackId },
      include: { services: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    const {
      services,
      parameters,
      parameterValues,
      resourceOutputs,
      resourceInputs,
      tlsCertificates,
      dnsRecords,
      tunnelIngress,
      ...fields
    } = parsed.data;

    const updateData: Prisma.StackUpdateInput = {
      ...fields,
      networks: fields.networks ? (fields.networks as unknown as Prisma.InputJsonValue) : undefined,
      volumes: fields.volumes ? (fields.volumes as unknown as Prisma.InputJsonValue) : undefined,
      parameters: parameters ? (parameters as unknown as Prisma.InputJsonValue) : undefined,
      parameterValues: parameterValues
        ? (parameterValues as unknown as Prisma.InputJsonValue)
        : undefined,
      ...(resourceOutputs !== undefined
        ? { resourceOutputs: resourceOutputs as unknown as Prisma.InputJsonValue }
        : {}),
      ...(resourceInputs !== undefined
        ? { resourceInputs: resourceInputs as unknown as Prisma.InputJsonValue }
        : {}),
      ...(tlsCertificates !== undefined ? { tlsCertificates } : {}),
      ...(dnsRecords !== undefined ? { dnsRecords } : {}),
      ...(tunnelIngress !== undefined ? { tunnelIngress } : {}),
      version: existing.version + 1,
      status: 'pending',
    };

    if (services) {
      const stack = await prisma.$transaction(async (tx) => {
        await tx.stackService.deleteMany({ where: { stackId } });

        return tx.stack.update({
          where: { id: stackId },
          data: {
            ...updateData,
            services: {
              create: (services as StackServiceDefinition[]).map(toServiceCreateInput),
            },
          },
          include: { services: true },
        });
      });

      res.json({ success: true, data: serializeStack(stack) });
    } else {
      const stack = await prisma.stack.update({
        where: { id: stackId },
        data: updateData,
        include: { services: true },
      });

      res.json({ success: true, data: serializeStack(stack) });
    }
  }),
);

// DELETE /:stackId — Delete stack
router.delete(
  '/:stackId',
  requirePermission('stacks:write'),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const stack = await prisma.stack.findUnique({ where: { id: stackId } });

    if (!stack) {
      return res.status(404).json({ success: false, message: 'Stack not found' });
    }

    if (stack.status !== 'undeployed' && stack.status !== 'pending') {
      try {
        const dockerExecutor = new DockerExecutorService();
        await dockerExecutor.initialize();
        const docker = dockerExecutor.getDockerClient();
        const containers = await docker.listContainers({
          filters: { label: [`mini-infra.stack-id=${stackId}`] },
        });

        if (containers.length > 0) {
          return res.status(400).json({
            success: false,
            message:
              'Cannot delete stack with running containers. Remove containers first or set status to undeployed.',
          });
        }
      } catch {
        return res.status(400).json({
          success: false,
          message:
            'Cannot verify container state. Stack status must be "undeployed" to delete without Docker access.',
        });
      }
    }

    await prisma.stack.delete({ where: { id: stackId } });
    res.json({ success: true, message: 'Stack deleted' });
  }),
);

export default router;
