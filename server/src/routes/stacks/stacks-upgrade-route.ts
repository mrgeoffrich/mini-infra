import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { asyncHandler } from '../../lib/async-handler';
import { getUserId } from '../../lib/get-user-id';
import { requirePermission } from '../../middleware/auth';
import { stackOperationLock } from '../../services/stacks/operation-lock';
import { upgradeStackToTemplateVersion } from '../../services/stacks/stack-upgrade-service';
import { assertStackFound } from '../../services/stacks/utils';
import { ErrorCode, Permission } from '@mini-infra/types';
import type { TemplateInputDeclaration } from '@mini-infra/types';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';

const logger = getLogger('stacks', 'stacks-upgrade-route');
const router = Router();

const upgradeBodySchema = z.object({
  // Operator-supplied input values required by rotateOnUpgrade declarations on
  // the target version. Optional — omitted when the template has no such inputs.
  inputValues: z.record(z.string(), z.string()).optional(),
  // Move to this specific published version rather than the template's current
  // one. May be older than the installed version (a deliberate downgrade).
  targetVersionId: z.string().min(1).optional(),
});

// POST /:stackId/upgrade — Re-materialize the stack from a published version of
// its template (parameter + input merge), bump status to `pending`. Targets the
// template's current version unless `targetVersionId` names another. Does NOT
// apply — the client chains POST /:stackId/apply afterwards.
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
        {
          action:
            'inputValues must be a map of string → string, and targetVersionId a non-empty string.',
        },
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
      updated = await upgradeStackToTemplateVersion(prisma, stackId, {
        suppliedInputValues: parsed.data.inputValues,
        targetVersionId: parsed.data.targetVersionId,
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

// GET /:stackId/upgrade-inputs — the input declarations the operator must
// supply to move this stack to a template version. These are the
// `rotateOnUpgrade` inputs (POST /upgrade 400s with
// STACK_INPUT_ROTATION_REQUIRED without them). Lets the client collect the
// values up front instead of dead-ending on the error. Returns an empty list
// when the stack has no template, no published version, or no such inputs.
//
// `?targetVersionId=` mirrors the POST body: inputs are a property of the
// version being deployed, so a targeted upgrade must read the declarations off
// the TARGET version. Resolving them against `currentVersion` regardless would
// prompt for the wrong secrets — or, worse, prompt for none and let the upgrade
// 400 on rotation-required after the operator thought they were done.
router.get(
  '/:stackId/upgrade-inputs',
  requirePermission(Permission.StacksRead),
  asyncHandler(async (req, res) => {
    const stackId = String(req.params.stackId);
    const targetVersionId =
      typeof req.query.targetVersionId === 'string' && req.query.targetVersionId.length > 0
        ? req.query.targetVersionId
        : undefined;

    const stack = assertStackFound(
      await prisma.stack.findUnique({
        where: { id: stackId },
        select: {
          id: true,
          templateId: true,
          template: {
            select: { currentVersion: { select: { inputs: true } } },
          },
        },
      }),
      stackId,
    );

    let declarations: TemplateInputDeclaration[];
    if (targetVersionId) {
      // Scoped by templateId so one stack's id can't be used to read the input
      // declarations of an unrelated template's version.
      const target = await prisma.stackTemplateVersion.findFirst({
        where: {
          id: targetVersionId,
          templateId: stack.templateId ?? '',
          status: 'published',
        },
        select: { inputs: true },
      });
      if (!target) {
        throw new NotFoundError(
          ErrorCode.STACK_TEMPLATE_VERSION_NOT_FOUND,
          'Template version not found',
          {
            resource: { type: 'stackTemplateVersion', id: targetVersionId },
            action: "Choose a published version of this stack's template.",
          },
        );
      }
      declarations = (target.inputs as unknown as TemplateInputDeclaration[] | null) ?? [];
    } else {
      declarations =
        (stack.template?.currentVersion?.inputs as unknown as TemplateInputDeclaration[] | null) ??
        [];
    }

    const inputs = declarations.filter((d) => d.rotateOnUpgrade);

    res.json({ success: true, data: { inputs } });
  }),
);

export default router;
