import type { PrismaClient } from "../../generated/prisma/client";
import type { NatsDriftInfo, NatsDriftReason } from "@mini-infra/types";

/**
 * Compare a stack's current template-version NATS section against its last
 * applied NATS snapshot and report which fields drifted.
 *
 * **Scope.** The detector compares the **raw**, un-rendered template fields
 * — `natsSubjectPrefix`, `natsRoles`, `natsSigners`, `natsExports`,
 * `natsImports` — against the equivalents persisted in
 * `lastAppliedNatsSnapshot`. That catches the common drift drivers (template
 * edits, role/signer adds/removes, prefix changes). It does **not** catch
 * drift driven purely by stack-parameter renaming or admin-allowlist edits;
 * those would require re-running the template engine, which is reserved for
 * a v2 if the demand surfaces.
 *
 * **Independence from stack.status.** This is a soft signal layered on top
 * of the existing stack status (`synced`/`drifted`/`pending`/...). A stack
 * can be `synced` container-wise yet still report `natsDrift.drifted = true`
 * if the template was edited and not yet re-applied. Surfacing both lets
 * operators distinguish "containers in sync, NATS state out of sync" from
 * "everything is in sync" without conflating two orthogonal axes.
 *
 * **Backwards compat.** Snapshots written before the raw-fields bump don't
 * carry `subjectPrefixRaw` / `exportsRaw`; in that case the detector emits
 * `baseline-incomplete` rather than guessing. A single re-apply on a synced
 * stack writes the new fields and clears the reason.
 *
 * @returns `null` when the stack has no NATS section or has never been
 * applied; otherwise a `NatsDriftInfo` summary.
 */
export async function detectNatsDrift(
  prisma: PrismaClient,
  stack: {
    templateId: string | null;
    templateVersion: number | null;
    lastAppliedNatsSnapshot: string | null;
  },
): Promise<NatsDriftInfo | null> {
  if (!stack.templateId || stack.templateVersion == null) return null;
  // No prior NATS apply → nothing to compare against. Status-page UI shows
  // the stack as `pending`/`undeployed` for an unrelated reason; we don't
  // need to layer NATS drift on top of that.
  if (!stack.lastAppliedNatsSnapshot) return null;

  const templateVersion = await prisma.stackTemplateVersion.findFirst({
    where: { templateId: stack.templateId, version: stack.templateVersion },
    select: {
      natsSubjectPrefix: true,
      natsRoles: true,
      natsSigners: true,
      natsExports: true,
      natsImports: true,
    },
  });
  if (!templateVersion) return null;

  // Skip stacks whose current template version has no NATS section at all.
  // `lastAppliedNatsSnapshot` from a prior version that DID have one would
  // already report drift via the field comparisons below — but if the
  // current version has nothing, the snapshot is a relic of a strictly
  // earlier shape and the destroy/re-apply path will clean it up.
  const currentHasNats =
    templateVersion.natsSubjectPrefix != null ||
    nonEmpty(templateVersion.natsRoles) ||
    nonEmpty(templateVersion.natsSigners) ||
    nonEmpty(templateVersion.natsExports) ||
    nonEmpty(templateVersion.natsImports);
  if (!currentHasNats) return null;

  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(stack.lastAppliedNatsSnapshot) as Record<string, unknown>;
  } catch {
    // Corrupt snapshot — every re-apply rewrites it, so `error` is the right
    // surface (not drift). Returning null leaves the operator looking at the
    // stack's existing failure reason for context.
    return null;
  }

  const reasons: NatsDriftReason[] = [];

  // subjectPrefix: snapshot has both the legacy resolved value and (post-
  // raw-bump) the raw form. Compare raw-to-raw when available; otherwise
  // emit baseline-incomplete and skip the field-level check.
  const snapshotPrefixRaw = "subjectPrefixRaw" in snapshot ? (snapshot.subjectPrefixRaw as string | null) : undefined;
  const snapshotExportsRaw = "exportsRaw" in snapshot ? (snapshot.exportsRaw as unknown[] | null) : undefined;
  let baselineIncomplete = false;
  if (snapshotPrefixRaw === undefined || snapshotExportsRaw === undefined) {
    baselineIncomplete = true;
  }

  if (snapshotPrefixRaw !== undefined) {
    const currentPrefixRaw = templateVersion.natsSubjectPrefix ?? null;
    if (!stableEqual(currentPrefixRaw, snapshotPrefixRaw)) {
      reasons.push("subject-prefix");
    }
  }

  if (!stableEqual(templateVersion.natsRoles, snapshot.roles)) {
    reasons.push("roles");
  }
  if (!stableEqual(templateVersion.natsSigners, snapshot.signers)) {
    reasons.push("signers");
  }
  if (snapshotExportsRaw !== undefined) {
    if (!stableEqual(templateVersion.natsExports, snapshotExportsRaw)) {
      reasons.push("exports");
    }
  }
  if (!stableEqual(templateVersion.natsImports, snapshot.imports)) {
    reasons.push("imports");
  }
  if (baselineIncomplete) {
    reasons.push("baseline-incomplete");
  }

  return { drifted: reasons.length > 0, reasons };
}

function nonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Deep equality with stable key ordering and null/undefined coalescing —
 * Prisma's JSON columns round-trip through `JSON.parse` so identity-level
 * comparison would fire false positives on every re-read.
 *
 * Treats `null`, `undefined`, and missing as equivalent for top-level
 * comparison: a template with `natsRoles: null` and a snapshot with
 * `roles: []` should NOT report drift just because nothing's there.
 */
function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNullish(a) && isNullish(b)) return true;
  if (isNullish(a) !== isNullish(b)) {
    // One side is null/undefined, the other isn't. If the present side is
    // an empty array/object treat it as no-difference; otherwise drift.
    const present = isNullish(a) ? b : a;
    if (Array.isArray(present) && present.length === 0) return true;
    if (typeof present === "object" && present !== null && Object.keys(present).length === 0) return true;
    return false;
  }
  return canonicalize(a) === canonicalize(b);
}

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalize(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const sorted = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalize((value as Record<string, unknown>)[k]));
    return "{" + sorted.join(",") + "}";
  }
  return JSON.stringify(value);
}
