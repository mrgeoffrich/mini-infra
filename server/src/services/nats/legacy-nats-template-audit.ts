import type { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";

const log = getLogger("integrations", "legacy-nats-template-audit");

/**
 * Rows carried over from the removed low-level NATS template surface
 * (`nats.accounts` / `credentials` / `streams` / `consumers`, and the
 * per-service `natsCredentialRef`).
 *
 * The drop migration copies anything still on the old shape into
 * `_LegacyNatsTemplateData` rather than destroying it, because a column drop is
 * irreversible and would otherwise erase a template's NATS section without a
 * trace. That table is raw SQL, not a Prisma model — deliberately, since it is
 * a one-off forensic artefact rather than part of the domain.
 */
export interface LegacyNatsTemplateRow {
  kind: string;
  rowId: string;
}

/**
 * Report any quarantined legacy-NATS template data at boot.
 *
 * On the expected install this finds nothing and says nothing. When it does
 * find something, the operator needs to know: the affected template versions no
 * longer have a NATS section the product can act on, so a stack still running
 * on one of those versions will apply as a NATS no-op — its existing credential
 * profiles keep working, but they are no longer reconciled. The fix is to
 * re-author the template against `nats.roles[]` and re-publish.
 *
 * Non-fatal by construction: this is a diagnostic, and a missing table (an
 * install that somehow predates the migration) is not an error worth blocking
 * boot over.
 */
export async function auditLegacyNatsTemplateData(prisma: PrismaClient): Promise<LegacyNatsTemplateRow[]> {
  let rows: LegacyNatsTemplateRow[];
  try {
    rows = await prisma.$queryRawUnsafe<LegacyNatsTemplateRow[]>(
      'SELECT "kind", "rowId" FROM "_LegacyNatsTemplateData"',
    );
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "legacy-NATS quarantine table not queryable; skipping audit",
    );
    return [];
  }

  if (rows.length === 0) return [];

  const byKind = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.kind] = (acc[row.kind] ?? 0) + 1;
    return acc;
  }, {});

  log.warn(
    { byKind, total: rows.length },
    "Found template data on the removed low-level NATS surface (nats.accounts/credentials/streams/consumers, services[].natsCredentialRef). " +
      "It was quarantined into _LegacyNatsTemplateData by the drop migration and is no longer applied. " +
      "Any stack still on one of these template versions now applies as a NATS no-op — re-author the template against nats.roles[] and re-publish. " +
      "Inspect with: SELECT kind, rowId, data FROM _LegacyNatsTemplateData;",
  );

  return rows;
}
