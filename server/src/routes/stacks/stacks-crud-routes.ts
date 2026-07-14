import { Router } from 'express';
import { Prisma } from "../../generated/prisma/client";
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
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
  assertStackFound,
} from '../../services/stacks/utils';
import { detectNatsDrift } from '../../services/stacks/nats-drift-detector';
import {
  encryptInputValues,
  decryptInputValues,
  mergeForUpgrade,
} from '../../services/stacks/stack-input-values-service';
import type {
  StackAdoptionCandidate,
  StackAdoptionCandidatesResponse,
  StackServiceDefinition,
  StackNetworkEntry,
  StackResourceOutput,
  StackResourceInput,
} from '@mini-infra/types';
import { runStackVaultDeleter } from '../../services/stacks/stack-vault-deleter';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import { getUserId } from '../../lib/get-user-id';
import { EgressPolicyLifecycleService } from '../../services/egress/egress-policy-lifecycle';
import { ErrorCode, Permission } from '@mini-infra/types';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import {
  translateUnifiedNetworkDeclarations,
  UnifiedNetworkDeclarationError,
} from '../../services/networks';

const logger = getLogger("stacks", "stacks-crud-routes");
const egressPolicyLifecycle = new EgressPolicyLifecycleService(prisma);

const router = Router();

/**
 * Phase 10 — translate a stack create/update payload's unified `networks[]`
 * (+ per-service `networks[]`) declarations into the legacy shapes the rest
 * of the create/update handlers already understand (`networks[]`,
 * `resourceOutputs[]`, `containerConfig.joinResourceNetworks`). Runs
 * immediately after schema validation. Throws `ValidationError` (folding in
 * `UnifiedNetworkDeclarationError`, owned by `services/networks`) on
 * ambiguous input.
 */
function translateStackNetworks<
  T extends {
    networks?: StackNetworkEntry[];
    resourceOutputs?: StackResourceOutput[];
    resourceInputs?: StackResourceInput[];
    services?: StackServiceDefinition[];
  },
>(data: T): T {
  try {
    const translated = translateUnifiedNetworkDeclarations({
      networks: data.networks,
      resourceOutputs: data.resourceOutputs,
      resourceInputs: data.resourceInputs,
      services: data.services,
    });
    return {
      ...data,
      networks: translated.networks ?? data.networks,
      resourceOutputs: translated.resourceOutputs,
      resourceInputs: translated.resourceInputs,
      services: translated.services ?? data.services,
    } as T;
  } catch (err) {
    if (err instanceof UnifiedNetworkDeclarationError) {
      throw new ValidationError(ErrorCode.STACK_NETWORK_DECLARATION_INVALID, err.message, {
        action: 'Fix the ambiguous network declaration and try again.',
      });
    }
    throw err;
  }
}

// GET / — List stacks
router.get(
  '/',
  requirePermission(Permission.StacksRead),
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

    // Drift detection runs in parallel per stack — `detectNatsDrift` is one
    // Prisma read on `stackTemplateVersion` plus a JSON.parse, so for a list
    // bounded by single-host scale (dozens of stacks) the latency is well
    // within the existing list-route budget. Stacks without a NATS section
    // or without a snapshot return null cheaply.
    const driftByStack = await Promise.all(
      stacks.map((s) =>
        detectNatsDrift(prisma, {
          templateId: s.templateId,
          templateVersion: s.templateVersion,
          lastAppliedNatsSnapshot: s.lastAppliedNatsSnapshot,
        }).catch(() => null),
      ),
    );

    res.json({
      success: true,
      data: stacks.map((s, i) => ({ ...serializeStack(s), natsDrift: driftByStack[i] })),
    });
  }),
);

// GET /eligible-containers — List unadopted containers for AdoptedWeb
// Must come before /:stackId to avoid parameter collision.
router.get(
  '/eligible-containers',
  requirePermission(Permission.StacksRead),
  requireDockerConnected(),
  asyncHandler(async (req, res) => {
    const environmentId = req.query.environmentId as string | undefined;
    if (!environmentId) {
      throw new ValidationError(
        ErrorCode.STACK_ENVIRONMENT_ID_REQUIRED,
        'environmentId query parameter is required',
        { action: 'Pass an environmentId query parameter.' },
      );
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
  requirePermission(Permission.StacksRead),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const stack = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        include: {
          services: { orderBy: { order: 'asc' } },
          template: { select: { currentVersion: { select: { version: true } } } },
        },
      }),
      stackId,
    );

    const natsDrift = await detectNatsDrift(prisma, {
      templateId: stack.templateId,
      templateVersion: stack.templateVersion,
      lastAppliedNatsSnapshot: stack.lastAppliedNatsSnapshot,
    }).catch(() => null);

    res.json({ success: true, data: { ...serializeStack(stack), natsDrift } });
  }),
);

// POST / — Create stack
router.post(
  '/',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const parsed = createStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const translatedData = translateStackNetworks(parsed.data);

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
      vaultAppRoleId,
      vaultFailClosed,
    } = translatedData;

    if (environmentId) {
      const environment = await prisma.environment.findUnique({ where: { id: environmentId } });
      if (!environment) {
        throw new NotFoundError(ErrorCode.STACK_ENVIRONMENT_NOT_FOUND, 'Environment not found', {
          resource: { type: 'environment', id: environmentId },
          action: 'Check the environment ID or refresh the environments list.',
        });
      }

      const existing = await prisma.stack.findFirst({
        where: { name, environmentId, status: { not: 'removed' } },
      });
      if (existing) {
        throw new ConflictError(
          ErrorCode.STACK_NAME_EXISTS,
          'A stack with this name already exists in this environment',
          {
            resource: { type: 'stack', name },
            action: 'Choose a different name, or edit the existing stack.',
          },
        );
      }
    } else {
      const existing = await prisma.stack.findFirst({
        where: { name, environmentId: null, status: { not: 'removed' } },
      });
      if (existing) {
        throw new ConflictError(
          ErrorCode.STACK_NAME_EXISTS,
          'A host-level stack with this name already exists',
          {
            resource: { type: 'stack', name },
            action: 'Choose a different name, or edit the existing stack.',
          },
        );
      }
    }

    const stack = await prisma.stack.create({
      data: {
        name,
        description: description ?? null,
        ...(environmentId
          ? { environment: { connect: { id: environmentId } } }
          : {}),
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
        // Use the relation form so Prisma validates the FK at the type level
        // and stays consistent with the service-level PUT handler.
        ...(vaultAppRoleId
          ? { vaultAppRole: { connect: { id: vaultAppRoleId } } }
          : {}),
        ...(vaultFailClosed !== undefined ? { vaultFailClosed } : {}),
        services: {
          create: (services as StackServiceDefinition[]).map(toServiceCreateInput),
        },
      },
      include: { services: true },
    });

    logger.info({ stackId: stack.id, stackName: stack.name }, 'Stack created');
    const createUserId = getUserId(req);
    await egressPolicyLifecycle.ensureDefaultPolicy(stack.id, createUserId ?? null);
    await egressPolicyLifecycle.reconcileTemplateRules(stack.id, createUserId ?? null);
    res.status(201).json({ success: true, data: serializeStack(stack) });
  }),
);

// PUT /:stackId — Update stack definition (or supply/rotate input values)
router.put(
  '/:stackId',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const parsed = updateStackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const translatedData = translateStackNetworks(parsed.data);

    const stackId = String(req.params.stackId);

    // A definition edit bumps the stack version and flips status to `pending`;
    // running it against a stack with an apply/update/destroy in flight would
    // desync the reconciler snapshot. Match the guard on apply/update/destroy.
    if (stackOperationLock.has(stackId)) {
      throw new ConflictError(
        ErrorCode.STACK_OPERATION_IN_PROGRESS,
        'An operation is already in progress for this stack',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Wait for the in-flight operation to finish before editing the stack.',
        },
      );
    }

    const existing = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        include: { services: true },
      }),
      stackId,
    );

    const {
      services,
      parameters,
      parameterValues,
      resourceOutputs,
      resourceInputs,
      tlsCertificates,
      dnsRecords,
      tunnelIngress,
      vaultAppRoleId,
      inputValues,
      ...fields
    } = translatedData;

    // Merge supplied input values with stored ones using mergeForUpgrade so that
    // rotateOnUpgrade declarations are enforced on every input-values write.
    let encryptedInputValues: string | undefined;
    if (inputValues !== undefined) {
      const stored = existing.encryptedInputValues
        ? (() => {
            try { return decryptInputValues(existing.encryptedInputValues); }
            catch { return {}; }
          })()
        : {};

      // Load input declarations from the template version if the stack is
      // template-bound. Falls back to a bare spread merge when no template is
      // linked (manually-created stacks without a vault section).
      let declarations: import('@mini-infra/types').TemplateInputDeclaration[] = [];
      if (existing.templateId && existing.templateVersion != null) {
        const tv = await prisma.stackTemplateVersion.findFirst({
          where: { templateId: existing.templateId, version: existing.templateVersion },
          select: { inputs: true },
        });
        if (tv?.inputs) {
          declarations = tv.inputs as unknown as import('@mini-infra/types').TemplateInputDeclaration[];
        }
      }

      // mergeForUpgrade throws InputValuesMissingError (a ValidationError
      // subclass) when a rotateOnUpgrade input wasn't supplied — let it
      // bubble to the central error middleware rather than catching it here.
      const merged = declarations.length > 0
        ? mergeForUpgrade(stored, inputValues, declarations)
        : { ...stored, ...inputValues };
      if (Object.keys(merged).length > 0) {
        encryptedInputValues = encryptInputValues(merged);
      }
    }

    const updateData: Prisma.StackUpdateInput = {
      ...fields,
      ...(encryptedInputValues !== undefined ? { encryptedInputValues } : {}),
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
      // vaultAppRoleId goes through the relation form so Prisma validates the
      // FK and we stay consistent with the service-level PUT handler.
      ...(vaultAppRoleId !== undefined
        ? {
            vaultAppRole:
              vaultAppRoleId === null
                ? { disconnect: true }
                : { connect: { id: vaultAppRoleId } },
          }
        : {}),
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

      // Refresh egress policy stack name snapshot if name was updated
      if (parsed.data.name !== undefined) {
        await egressPolicyLifecycle.refreshStackNameSnapshot(stackId);
      }

      // Reconcile template egress rules — service definitions may have changed
      const updateUserId = getUserId(req);
      await egressPolicyLifecycle.reconcileTemplateRules(stackId, updateUserId ?? null);

      res.json({ success: true, data: serializeStack(stack) });
    } else {
      const stack = await prisma.stack.update({
        where: { id: stackId },
        data: updateData,
        include: { services: true },
      });

      // Refresh egress policy stack name snapshot if name was updated
      if (parsed.data.name !== undefined) {
        await egressPolicyLifecycle.refreshStackNameSnapshot(stackId);
      }

      res.json({ success: true, data: serializeStack(stack) });
    }
  }),
);

// DELETE /:stackId — Delete stack
router.delete(
  '/:stackId',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    assertStackFound(
      await prisma.stack.findUnique({ where: { id: stackId } }),
      stackId,
    );

    // Always verify there are no labelled containers before tombstoning the
    // DB row — the `status` field can lie. A partial /destroy (or any failure
    // that flipped status to `undeployed` but left containers up) would
    // otherwise let DELETE silently succeed and leave orphaned Docker
    // resources running. Confirmed regression: customer repro showed two
    // back-to-back DELETEs where the second returned 200 because status was
    // `undeployed`, even though the containers from the first reject were
    // still up.
    let containers;
    try {
      const dockerExecutor = new DockerExecutorService();
      await dockerExecutor.initialize();
      const docker = dockerExecutor.getDockerClient();
      containers = await docker.listContainers({
        all: true,
        filters: { label: [`mini-infra.stack-id=${stackId}`] },
      });
    } catch {
      throw new ValidationError(
        ErrorCode.STACK_DOCKER_UNREACHABLE,
        'Cannot verify container state — Docker is unreachable. Restore Docker connectivity and retry, or remove the containers manually before deleting.',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Restore Docker connectivity and retry.',
        },
      );
    }

    if (containers.length > 0) {
      // Kept as a 400 (ValidationError), matching prior behaviour pinned by
      // stacks-delete-vault-cascade.integration.test.ts — this is a
      // regression guard for a customer-reported orphaned-container bug, so
      // the status code is deliberately preserved rather than reclassified.
      throw new ValidationError(
        ErrorCode.STACK_HAS_ACTIVE_CONTAINERS,
        'Cannot delete stack while Docker still has containers labelled with this stack ID. Run /destroy to remove them first, or remove the containers manually.',
        {
          resource: { type: 'stack', id: stackId },
          action: 'Run POST /:stackId/destroy first, or remove the containers manually.',
        },
      );
    }

    const userId = getUserId(req);
    const triggeredBy = userId ? `stack-delete:${stackId}` : `stack-delete:${stackId}:api`;
    await runStackVaultDeleter(prisma, stackId, triggeredBy);

    // Archive egress policy before deleting the stack row so we can still
    // record userId on the archived record while the stack is resolvable.
    await egressPolicyLifecycle.archiveForStack(stackId, userId ?? null);

    await prisma.stack.delete({ where: { id: stackId } });
    res.json({ success: true, message: 'Stack deleted' });
  }),
);

export default router;
