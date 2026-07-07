import type { PrismaClient } from "../../../generated/prisma/client";
import type {
  HelpAction,
  MinState,
  PrerequisiteEvaluation,
  PrerequisiteFailure,
  ScopeMatch,
  StackPrerequisite,
  StackTemplatePrerequisite,
} from "@mini-infra/types";
import { getLogger } from "../../../lib/logger-factory";
import { InternalError } from "../../../lib/errors";
import { getPredicate } from "./predicates";

const log = getLogger("stacks", "template-prerequisites-evaluator");

/**
 * Ordering used to test "stack X is at status >= minState". Higher means
 * "more applied". `error` and `removed` are deliberately not in the
 * ordering — they never satisfy any minState.
 */
const STATE_ORDER: Record<string, number> = {
  synced: 4,
  drifted: 3,
  pending: 2,
  undeployed: 1,
};

const REQUIRED_STATE_ORDER: Record<MinState, number> = {
  synced: STATE_ORDER.synced,
  drifted: STATE_ORDER.drifted,
  pending: STATE_ORDER.pending,
};

function statusMeetsMinState(status: string, minState: MinState): boolean {
  const observed = STATE_ORDER[status];
  if (observed === undefined) return false; // error / removed / unknown
  return observed >= REQUIRED_STATE_ORDER[minState];
}

/**
 * Look up the `requires` blob persisted on a stack template version.
 * Returns `[]` when the version has no `requires` declared. Throws
 * when the version itself can't be found.
 */
async function loadRequiresForVersion(
  prisma: PrismaClient,
  templateVersionId: string,
): Promise<StackTemplatePrerequisite[]> {
  const row = await prisma.stackTemplateVersion.findUnique({
    where: { id: templateVersionId },
    select: { requires: true },
  });
  if (!row) {
    throw new InternalError(`StackTemplateVersion not found: ${templateVersionId}`);
  }
  if (row.requires == null) return [];
  return row.requires as unknown as StackTemplatePrerequisite[];
}

/**
 * Evaluate a `stack`-kind requirement against the current world.
 *
 * - Resolves candidate stacks via `Stack.templateId` joined to
 *   `StackTemplate.name === templateName` (NOT by stack name — name-based
 *   lookups break for user-renamed instances; see the precedent in
 *   `builtin-stack-sync.ts upgradeExistingStacksForTemplates`).
 * - Filters by scope per `scopeMatch`.
 * - Returns `null` when satisfied; otherwise a structured failure.
 *
 * `applyingStackEnvId` is required for `same-environment` matching;
 * `null` means the applying stack is host-scoped, in which case
 * `same-environment` requirements are an authoring error.
 */
async function evaluateStackRequirement(
  prisma: PrismaClient,
  req: StackPrerequisite,
  applyingStackEnvId: string | null,
): Promise<PrerequisiteFailure | null> {
  const { templateName, minState, scopeMatch } = req;

  if (scopeMatch === "same-environment" && applyingStackEnvId === null) {
    throw new InternalError(
      `Prerequisite on template '${templateName}' uses scopeMatch='same-environment' but the applying stack is host-scoped`,
    );
  }

  // Fetch all non-removed candidate stacks bound to a template with the
  // requested name. Source-agnostic: a `stack` requirement just names a
  // template and a min state — it doesn't care if the candidate is a
  // system or user template.
  const candidates = await prisma.stack.findMany({
    where: {
      template: { name: templateName },
      status: { not: "removed" },
    },
    select: {
      id: true,
      status: true,
      environmentId: true,
      template: { select: { scope: true } },
    },
  });

  const matching = candidates.filter((s) => {
    const scope = s.template?.scope;
    if (scopeMatch === "host") {
      // Host requirements match host-scoped templates with no environment binding.
      return scope === "host" && s.environmentId === null;
    }
    if (scopeMatch === "environment") {
      // "Any env-scoped instance, anywhere" — env-scoped templates only.
      return scope === "environment" && s.environmentId !== null;
    }
    // same-environment: env-scoped template AND env matches the applying stack
    return (
      scope === "environment" &&
      s.environmentId !== null &&
      s.environmentId === applyingStackEnvId
    );
  });

  if (matching.length === 0) {
    return {
      kind: "stack",
      reason: `No ${describeScopeMatch(scopeMatch, applyingStackEnvId)} stack instantiated from template '${templateName}'`,
      helpAction: {
        type: "instantiate-stack",
        templateName,
        scopeMatch,
      } satisfies HelpAction,
      detail: { templateName, scopeMatch, observedCount: 0 },
    };
  }

  // At least one matching stack — does any of them meet the minState?
  const satisfied = matching.find((s) => statusMeetsMinState(s.status, minState));
  if (satisfied) return null;

  // Pick the "best" observed status (highest in STATE_ORDER) for diagnostics.
  let bestStatus: string = matching[0].status;
  let bestRank = STATE_ORDER[bestStatus] ?? -1;
  for (const m of matching) {
    const r = STATE_ORDER[m.status] ?? -1;
    if (r > bestRank) {
      bestRank = r;
      bestStatus = m.status;
    }
  }
  return {
    kind: "stack",
    reason: `Stack from template '${templateName}' is in status '${bestStatus}' but requires '${minState}' or better`,
    helpAction: {
      type: "apply-stack",
      templateName,
      scopeMatch,
    } satisfies HelpAction,
    detail: {
      templateName,
      scopeMatch,
      minState,
      observedStatus: bestStatus,
    },
  };
}

function describeScopeMatch(
  scopeMatch: ScopeMatch,
  applyingStackEnvId: string | null,
): string {
  switch (scopeMatch) {
    case "host":
      return "host-scoped";
    case "environment":
      return "environment-scoped";
    case "same-environment":
      return applyingStackEnvId
        ? "matching environment-scoped"
        : "same-environment-scoped";
  }
}

/**
 * Evaluate every requirement in `requires` and collect failures.
 * Predicates and stack requirements are treated uniformly here — the
 * caller (apply route or precheck endpoint) decides what to do with
 * the result.
 */
async function evaluateAll(
  prisma: PrismaClient,
  requires: StackTemplatePrerequisite[],
  applyingStackId: string | undefined,
  applyingStackEnvId: string | null,
): Promise<PrerequisiteEvaluation> {
  const failures: PrerequisiteFailure[] = [];

  for (const req of requires) {
    if (req.kind === "stack") {
      const failure = await evaluateStackRequirement(
        prisma,
        req,
        applyingStackEnvId,
      );
      if (failure) failures.push(failure);
      continue;
    }
    if (req.kind === "predicate") {
      const handler = getPredicate(req.name);
      if (!handler) {
        // Defence in depth — template-load validation should have caught
        // this. Surface it loudly if it slips through (e.g. an old DB
        // row from before a rename) rather than silently passing.
        log.warn(
          { predicate: req.name },
          "Unknown predicate referenced at apply time — template-load validation should have caught this",
        );
        failures.push({
          kind: "predicate",
          reason: `Unknown predicate '${req.name}' (template-load validation should have caught this)`,
          detail: { predicate: req.name },
        });
        continue;
      }
      const result = await handler({ prisma, stackId: applyingStackId });
      if (!result.ok) {
        failures.push({
          kind: "predicate",
          reason: result.reason ?? `Predicate '${req.name}' returned not ok`,
          helpAction: result.helpAction,
          detail: { predicate: req.name },
        });
      }
      continue;
    }
    // Defensive: schema validation should make this unreachable.
    log.warn(
      { req: req as unknown as Record<string, unknown> },
      "Unknown prerequisite kind — ignoring",
    );
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Public entrypoint: evaluate the prerequisites of an existing stack
 * (post-instantiate). Looks up the stack's bound template version (by
 * `templateId` + `templateVersion`), reads the persisted `requires`
 * blob, and evaluates each requirement.
 *
 * A stack with no template binding (or no `requires` declared on its
 * version) is always `ok: true`.
 */
export async function evaluatePrerequisites(
  prisma: PrismaClient,
  stackId: string,
): Promise<PrerequisiteEvaluation> {
  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    select: {
      id: true,
      environmentId: true,
      templateId: true,
      templateVersion: true,
    },
  });
  if (!stack) {
    throw new InternalError(`Stack not found: ${stackId}`);
  }
  if (!stack.templateId || stack.templateVersion == null) {
    return { ok: true, failures: [] };
  }

  // Resolve the stack's bound template version row to read `requires`.
  // Stack.templateVersion is a number (version int), not the version's id.
  const versionRow = await prisma.stackTemplateVersion.findFirst({
    where: { templateId: stack.templateId, version: stack.templateVersion },
    select: { id: true, requires: true },
  });
  if (!versionRow) {
    // Stack references a version we can't find — treat as no requires
    // rather than blowing up. The apply path will hit a clearer error
    // separately if the version is genuinely gone.
    log.warn(
      { stackId, templateId: stack.templateId, templateVersion: stack.templateVersion },
      "Stack references missing template version — skipping prerequisite check",
    );
    return { ok: true, failures: [] };
  }

  const requires = (versionRow.requires as unknown as StackTemplatePrerequisite[] | null) ?? [];
  if (requires.length === 0) {
    return { ok: true, failures: [] };
  }

  return evaluateAll(prisma, requires, stackId, stack.environmentId ?? null);
}

/**
 * Variant for the precheck path: the stack doesn't exist yet, so the
 * caller hands us a `templateVersionId` and the scope they intend to
 * instantiate into. Used by
 * `GET /api/stack-templates/:id/prerequisites?environmentId=…`.
 */
export async function evaluatePrerequisitesForTemplateVersion(
  prisma: PrismaClient,
  templateVersionId: string,
  scope: { kind: "host" } | { kind: "environment"; environmentId: string },
): Promise<PrerequisiteEvaluation> {
  const requires = await loadRequiresForVersion(prisma, templateVersionId);
  if (requires.length === 0) {
    return { ok: true, failures: [] };
  }

  const applyingStackEnvId =
    scope.kind === "environment" ? scope.environmentId : null;

  return evaluateAll(prisma, requires, undefined, applyingStackEnvId);
}
