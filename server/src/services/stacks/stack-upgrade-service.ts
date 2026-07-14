/**
 * Re-materialize an existing Stack from the current published version of its
 * StackTemplate — the "upgrade" primitive.
 *
 * This is the shared core behind BOTH:
 *   - the user-facing `POST /api/stacks/:stackId/upgrade` route (user templates), and
 *   - boot-time built-in stack sync (`builtin-stack-sync.ts`, system templates).
 *
 * It loads `template.currentVersion` (which must be published), re-materializes
 * the stack's services / networks / volumes / config-files / resource-IO from
 * that version, merges the operator's existing parameter values over the new
 * defaults, merges input values via `mergeForUpgrade` (honouring
 * `rotateOnUpgrade`), bumps `Stack.version`, updates `templateVersion` +
 * `templateVersionId` (and `builtinVersion` for system templates), and flips
 * status to `pending`. It does NOT apply — the caller chains `POST /apply`.
 */
import { PrismaClient, Prisma } from "../../generated/prisma/client";
import type {
  StackInfo,
  StackParameterDefinition,
  StackParameterValue,
  TemplateInputDeclaration,
} from "@mini-infra/types";
import { ErrorCode } from "@mini-infra/types";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { getLogger } from "../../lib/logger-factory";
import { toServiceCreateInput, serializeStack, mergeParameterValues } from "./utils";
import { emitStackStatusChanged } from "./stack-socket-emitter";
import { buildServiceDefinitionsFromVersion } from "./stack-template-service";
import {
  encryptInputValues,
  decryptInputValues,
  mergeForUpgrade,
} from "./stack-input-values-service";
import { EgressPolicyLifecycleService } from "../egress/egress-policy-lifecycle";

const log = getLogger("stacks", "stack-upgrade-service");

export interface UpgradeStackOptions {
  /**
   * Parameter overrides applied with the highest precedence (e.g. environment
   * network-type defaults injected by boot-time system-stack sync). Operator
   * values on the stack still win over the new template defaults; these win
   * over the operator values.
   */
  parameterOverrides?: Record<string, StackParameterValue>;
  /**
   * Operator-supplied input values for this upgrade. Required for any
   * `rotateOnUpgrade` input declaration on the target version.
   */
  suppliedInputValues?: Record<string, string>;
  /** Audit user id (egress reconcile + future audit). */
  userId?: string | null;
}

/**
 * Upgrade `stackId` to its template's current published version. Returns the
 * updated, serialized stack. Throws typed taxonomy errors:
 *   - 404 STACK_NOT_FOUND — unknown stack
 *   - 400 STACK_NO_TEMPLATE — stack was created without a template
 *   - 400 STACK_TEMPLATE_NOT_PUBLISHED — template has no published version
 *   - 409 STACK_ALREADY_ON_LATEST — stack is already on the current version
 *   - 400 STACK_INPUT_ROTATION_REQUIRED — a rotateOnUpgrade input wasn't supplied
 */
export async function upgradeStackToCurrentTemplateVersion(
  prisma: PrismaClient,
  stackId: string,
  options: UpgradeStackOptions = {},
): Promise<StackInfo> {
  const { parameterOverrides = {}, suppliedInputValues = {}, userId = null } = options;

  const existing = await prisma.stack.findUnique({
    where: { id: stackId },
    select: {
      id: true,
      version: true,
      templateId: true,
      templateVersion: true,
      parameterValues: true,
      encryptedInputValues: true,
    },
  });
  if (!existing) {
    throw new NotFoundError(ErrorCode.STACK_NOT_FOUND, "Stack not found", {
      resource: { type: "stack", id: stackId },
      action: "Check the stack ID or refresh the stacks list.",
    });
  }

  if (!existing.templateId) {
    throw new ValidationError(
      ErrorCode.STACK_NO_TEMPLATE,
      "This stack was not created from a template and cannot be upgraded",
      {
        resource: { type: "stack", id: stackId },
        action: "Edit the stack definition directly instead of upgrading.",
      },
    );
  }

  const template = await prisma.stackTemplate.findUnique({
    where: { id: existing.templateId },
    include: {
      currentVersion: {
        include: {
          services: { orderBy: { order: "asc" } },
          configFiles: true,
        },
      },
    },
  });
  if (!template) {
    throw new NotFoundError(ErrorCode.STACK_TEMPLATE_NOT_FOUND, "Template not found", {
      resource: { type: "stackTemplate", id: existing.templateId },
      action: "The template backing this stack no longer exists.",
    });
  }
  const version = template.currentVersion;
  if (!version) {
    throw new ValidationError(
      ErrorCode.STACK_TEMPLATE_NOT_PUBLISHED,
      "Template has no published version to upgrade to",
      {
        resource: { type: "stackTemplate", id: template.id, name: template.name },
        action: "Publish a version of this template before upgrading.",
      },
    );
  }

  if (existing.templateVersion != null && version.version <= existing.templateVersion) {
    throw new ConflictError(
      ErrorCode.STACK_ALREADY_ON_LATEST,
      `Stack is already on the latest template version (v${version.version})`,
      {
        resource: { type: "stack", id: stackId },
        action: "No upgrade is needed — this stack already tracks the current version.",
      },
    );
  }

  const isSystem = template.source === "system";

  // --- Parameter values: new defaults ← existing operator values ← overrides ---
  const paramDefs = (version.parameters as unknown as StackParameterDefinition[]) ?? [];
  const versionDefaults =
    (version.defaultParameterValues as unknown as Record<string, StackParameterValue>) ?? {};
  const existingValues =
    (existing.parameterValues as unknown as Record<string, StackParameterValue>) ?? {};
  const mergedValues = mergeParameterValues(paramDefs, {
    ...versionDefaults,
    ...existingValues,
    ...parameterOverrides,
  });

  // --- Input values: merge stored with supplied, enforcing rotateOnUpgrade ---
  const declarations = (version.inputs as unknown as TemplateInputDeclaration[] | null) ?? [];
  let encryptedInputValues: string | undefined;
  if (declarations.length > 0 || Object.keys(suppliedInputValues).length > 0) {
    const stored = existing.encryptedInputValues
      ? (() => {
          try {
            return decryptInputValues(existing.encryptedInputValues);
          } catch {
            return {} as Record<string, string>;
          }
        })()
      : {};
    // mergeForUpgrade throws InputValuesMissingError (a ValidationError) when a
    // rotateOnUpgrade input wasn't supplied — let it bubble to the caller.
    const merged =
      declarations.length > 0
        ? mergeForUpgrade(stored, suppliedInputValues, declarations)
        : { ...stored, ...suppliedInputValues };
    if (Object.keys(merged).length > 0) {
      encryptedInputValues = encryptInputValues(merged);
    }
  }

  const serviceDefs = buildServiceDefinitionsFromVersion(version);

  await prisma.$transaction(async (tx) => {
    await tx.stackService.deleteMany({ where: { stackId: existing.id } });

    await tx.stack.update({
      where: { id: existing.id },
      data: {
        description: template.description,
        version: existing.version + 1,
        status: "pending",
        templateVersion: version.version,
        templateVersionId: version.id,
        ...(isSystem ? { builtinVersion: version.version } : {}),
        parameters:
          paramDefs.length > 0 ? (paramDefs as unknown as Prisma.InputJsonValue) : undefined,
        parameterValues:
          Object.keys(mergedValues).length > 0
            ? (mergedValues as unknown as Prisma.InputJsonValue)
            : undefined,
        resourceOutputs: version.resourceOutputs
          ? (version.resourceOutputs as unknown as Prisma.InputJsonValue)
          : undefined,
        resourceInputs: version.resourceInputs
          ? (version.resourceInputs as unknown as Prisma.InputJsonValue)
          : undefined,
        networks: version.networks as unknown as Prisma.InputJsonValue,
        volumes: version.volumes as unknown as Prisma.InputJsonValue,
        ...(encryptedInputValues !== undefined ? { encryptedInputValues } : {}),
        services: {
          create: serviceDefs.map(toServiceCreateInput),
        },
      },
    });
  });
  emitStackStatusChanged(existing.id, "pending");

  // Reconcile template-declared egress rules now that services have changed.
  try {
    const egressLifecycle = new EgressPolicyLifecycleService(prisma);
    await egressLifecycle.reconcileTemplateRules(existing.id, userId);
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error), stackId },
      "Egress reconcile after upgrade failed (non-fatal)",
    );
  }

  log.info(
    { stackId, templateId: template.id, toVersion: version.version, isSystem },
    "Stack upgraded to current template version",
  );

  const updated = await prisma.stack.findUnique({
    where: { id: existing.id },
    include: {
      services: { orderBy: { order: "asc" } },
      template: { select: { currentVersion: { select: { version: true } } } },
    },
  });
  // updated cannot be null — we just updated it inside this call.
  return serializeStack(updated!);
}
