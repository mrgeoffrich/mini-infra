/**
 * Re-materialize an existing Stack from a published version of its
 * StackTemplate — the "upgrade" primitive.
 *
 * This is the shared core behind BOTH:
 *   - the user-facing `POST /api/stacks/:stackId/upgrade` route (user templates), and
 *   - boot-time built-in stack sync (`builtin-stack-sync.ts`, system templates).
 *
 * The target defaults to `template.currentVersion`, but the caller may name any
 * published version via `targetVersionId` — which is what makes a *downgrade*
 * possible. That matters because template rollback only re-points
 * `currentVersionId` and never touches installed stacks, so a rollback strands
 * every stack that had already adopted the newer version: they sit AHEAD of
 * current, with nothing to upgrade to and no way back. Naming a version
 * explicitly is the way out.
 *
 * It re-materializes the stack's services / networks / volumes / config-files /
 * resource-IO from the target version, merges the operator's existing parameter
 * values over the target's defaults, merges input values via `mergeForUpgrade`
 * (honouring `rotateOnUpgrade`), bumps `Stack.version`, updates
 * `templateVersion` + `templateVersionId` (and `builtinVersion` for system
 * templates), and flips status to `pending`. It does NOT apply — the caller
 * chains `POST /apply`.
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

/**
 * Load an explicitly-named target version, refusing anything that isn't a
 * published version of *this* template.
 *
 * The status check is load-bearing and new: nothing in the codebase previously
 * guarded `StackTemplateVersionStatus`. `createStackFromTemplate` and the old
 * upgrade path both went through `template.currentVersion`, which is published
 * by construction, so the gap never showed. Accepting an arbitrary version id
 * opens it — a draft (the author's unpublished work-in-progress) or an archived
 * version would otherwise be deployable by id.
 */
async function loadTargetVersion(
  prisma: PrismaClient,
  templateId: string,
  templateName: string,
  targetVersionId: string,
) {
  const version = await prisma.stackTemplateVersion.findUnique({
    where: { id: targetVersionId },
    include: {
      services: { orderBy: { order: "asc" } },
      configFiles: true,
    },
  });

  // Belonging to another template is reported as not-found, not as a mismatch —
  // the caller has no business knowing that some other template's version exists.
  if (!version || version.templateId !== templateId) {
    throw new NotFoundError(
      ErrorCode.STACK_TEMPLATE_VERSION_NOT_FOUND,
      "Template version not found",
      {
        resource: { type: "stackTemplateVersion", id: targetVersionId },
        action: `Choose a published version of '${templateName}'.`,
      },
    );
  }

  if (version.status !== "published") {
    throw new ValidationError(
      ErrorCode.STACK_TEMPLATE_VERSION_NOT_PUBLISHED,
      `Template version v${version.version} is ${version.status}, not published`,
      {
        resource: { type: "stackTemplateVersion", id: targetVersionId },
        action:
          version.status === "draft"
            ? "Publish the draft before deploying a stack from it."
            : "Choose a published version — archived versions cannot be deployed.",
      },
    );
  }

  return version;
}

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
  /**
   * Move the stack to this specific template version instead of the template's
   * current one. Must be a published version of the stack's own template.
   * May be OLDER than the installed version — that is a deliberate downgrade,
   * and the only way to recover a stack stranded ahead of current by a rollback.
   */
  targetVersionId?: string;
  /** Audit user id (egress reconcile + future audit). */
  userId?: string | null;
}

/**
 * Move `stackId` to a published version of its template — `targetVersionId` if
 * given, otherwise the template's current version. Returns the updated,
 * serialized stack. Throws typed taxonomy errors:
 *   - 404 STACK_NOT_FOUND — unknown stack
 *   - 400 STACK_NO_TEMPLATE — stack was created without a template
 *   - 400 STACK_TEMPLATE_NOT_PUBLISHED — template has no published version
 *   - 404 STACK_TEMPLATE_VERSION_NOT_FOUND — targetVersionId is unknown, or belongs to another template
 *   - 400 STACK_TEMPLATE_VERSION_NOT_PUBLISHED — targetVersionId is a draft or archived version
 *   - 409 STACK_ALREADY_ON_LATEST — the stack is already on the target version
 *   - 400 STACK_INPUT_ROTATION_REQUIRED — a rotateOnUpgrade input wasn't supplied
 */
export async function upgradeStackToTemplateVersion(
  prisma: PrismaClient,
  stackId: string,
  options: UpgradeStackOptions = {},
): Promise<StackInfo> {
  const {
    parameterOverrides = {},
    suppliedInputValues = {},
    targetVersionId,
    userId = null,
  } = options;

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
  const version = targetVersionId
    ? await loadTargetVersion(prisma, template.id, template.name, targetVersionId)
    : template.currentVersion;
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

  if (version.version === existing.templateVersion) {
    // A no-op either way, but say which no-op it is: "already on the latest"
    // is a lie when the operator explicitly asked for v2 and is already there.
    throw new ConflictError(
      ErrorCode.STACK_ALREADY_ON_LATEST,
      targetVersionId
        ? `Stack is already on template version v${version.version}`
        : `Stack is already on the latest template version (v${version.version})`,
      {
        resource: { type: "stack", id: stackId },
        action: targetVersionId
          ? "Choose a different version to move this stack to."
          : "No upgrade is needed — this stack already tracks the current version.",
      },
    );
  }

  // Only an EXPLICIT target may move a stack backwards. An implicit upgrade that
  // silently downgraded — because the template had been rolled back under it —
  // would be a nasty surprise, so the stranded-ahead stack is still refused here
  // and pointed at the version picker instead.
  if (
    !targetVersionId &&
    existing.templateVersion != null &&
    version.version < existing.templateVersion
  ) {
    throw new ConflictError(
      ErrorCode.STACK_ALREADY_ON_LATEST,
      `Stack is on template version v${existing.templateVersion}, which is newer than the template's current version (v${version.version}) — the template was rolled back.`,
      {
        resource: { type: "stack", id: stackId },
        action: `Choose a specific version to move this stack to (v${version.version} is the template's current one), or publish a newer version to move it forward.`,
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
    {
      stackId,
      templateId: template.id,
      fromVersion: existing.templateVersion,
      toVersion: version.version,
      explicitTarget: targetVersionId != null,
      isSystem,
    },
    "Stack moved to template version",
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
