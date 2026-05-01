/**
 * NATS subject-prefix allowlist (Phase 2).
 *
 * The Phase 1+3 design defaults every stack's `nats.subjectPrefix` to
 * `app.<stack-id>` — opaque but collision-free. Templates that want a
 * human-readable prefix (e.g. the slackbot's `navi.*`) need an explicit
 * admin opt-in: an allowlist entry naming the prefix and the template IDs
 * that may claim it. Without an entry, apply rejects any non-default prefix.
 *
 * **Storage shape.** One `SystemSettings` row per allowlist entry. Category
 * is a dedicated `nats-prefix-allowlist`. Key is the prefix string itself;
 * value is JSON `{ allowedTemplateIds: string[] }`. CRUD-per-entry — never a
 * blob PUT — so a stale write can't wipe everyone's allowlist (one of the
 * design's named footguns).
 *
 * **Validation, all enforced at write time** (so a corrupt entry can never
 * reach the apply orchestrator):
 *   - prefix non-empty, no wildcards (`>` / `*`), no leading/trailing dot,
 *     not `$SYS.*`, syntactically dotted-segment of `[a-zA-Z0-9_-]`
 *   - prefix has no overlap (strict subset/superset) with any other entry —
 *     prevents "events" silently shadowing "events.platform"
 *   - allowedTemplateIds non-empty and every entry references a real
 *     `StackTemplate.id`
 *
 * The apply orchestrator (Phase 3) reads this via `lookupAllowedTemplateIds`
 * and rejects an apply when the resolved subjectPrefix is non-default and
 * the template's ID is not in the entry's allowlist.
 */

import { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";

export interface NatsPrefixAllowlistEntry {
  prefix: string;
  allowedTemplateIds: string[];
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

export interface NatsPrefixAllowlistEntryInfo {
  prefix: string;
  allowedTemplateIds: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface UpsertNatsPrefixAllowlistEntryInput {
  prefix: string;
  allowedTemplateIds: string[];
}

export class NatsPrefixAllowlistError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "NatsPrefixAllowlistError";
  }
}

const CATEGORY = "nats-prefix-allowlist";
const log = getLogger("integrations", "nats-prefix-allowlist");

// Dotted segments of [a-zA-Z0-9_-]. Must contain no wildcards, no leading/
// trailing dot. The regex matches the `templateNatsSubjectPrefixSchema` in
// `stack-template-schemas.ts` — keep them in sync.
const PREFIX_REGEX = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

function validatePrefixSyntax(prefix: string): void {
  if (!prefix || prefix.length === 0) {
    throw new NatsPrefixAllowlistError("prefix must be non-empty", 400);
  }
  if (prefix.length > 120) {
    throw new NatsPrefixAllowlistError("prefix must be ≤120 characters", 400);
  }
  if (/[>*]/.test(prefix)) {
    throw new NatsPrefixAllowlistError("prefix must not contain wildcards ('>' or '*')", 400);
  }
  if (prefix.startsWith(".") || prefix.endsWith(".")) {
    throw new NatsPrefixAllowlistError("prefix must not start or end with '.'", 400);
  }
  if (prefix === "$SYS" || prefix.startsWith("$SYS.")) {
    throw new NatsPrefixAllowlistError("prefix must not target the '$SYS' system-account namespace", 400);
  }
  if (!PREFIX_REGEX.test(prefix)) {
    throw new NatsPrefixAllowlistError(
      "prefix must be dotted segments of [a-zA-Z0-9_-] (e.g. 'navi' or 'events.platform')",
      400,
    );
  }
}

/**
 * `a` is a strict ancestor or descendant of `b` (in the dotted-segment subject
 * tree). E.g. "events" is an ancestor of "events.platform". Equality returns
 * true so callers can decide whether duplicates should error out separately.
 */
function isSubjectTreeOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b + ".") || b.startsWith(a + ".");
}

function entryFromRow(row: {
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}): NatsPrefixAllowlistEntry {
  let allowedTemplateIds: string[] = [];
  try {
    const parsed = JSON.parse(row.value);
    if (parsed && Array.isArray(parsed.allowedTemplateIds)) {
      allowedTemplateIds = parsed.allowedTemplateIds.filter((s: unknown): s is string => typeof s === "string");
    }
  } catch {
    log.warn({ prefix: row.key }, "nats-prefix-allowlist row had unparseable value");
  }
  return {
    prefix: row.key,
    allowedTemplateIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

export function toEntryInfo(entry: NatsPrefixAllowlistEntry): NatsPrefixAllowlistEntryInfo {
  return {
    prefix: entry.prefix,
    allowedTemplateIds: entry.allowedTemplateIds,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    createdBy: entry.createdBy,
    updatedBy: entry.updatedBy,
  };
}

export class NatsPrefixAllowlistService {
  constructor(private prisma: PrismaClient) {}

  async list(): Promise<NatsPrefixAllowlistEntry[]> {
    const rows = await this.prisma.systemSettings.findMany({
      where: { category: CATEGORY, isActive: true },
      orderBy: { key: "asc" },
    });
    return rows.map(entryFromRow);
  }

  async get(prefix: string): Promise<NatsPrefixAllowlistEntry | null> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { category_key: { category: CATEGORY, key: prefix } },
    });
    if (!row || !row.isActive) return null;
    return entryFromRow(row);
  }

  /**
   * Read-only lookup used by the apply orchestrator: returns the allowlist
   * entry for an exact-match prefix, or null. The orchestrator then checks
   * that the candidate templateId is in `allowedTemplateIds`.
   */
  async lookupAllowedTemplateIds(prefix: string): Promise<string[] | null> {
    const entry = await this.get(prefix);
    return entry ? entry.allowedTemplateIds : null;
  }

  /**
   * Create a new allowlist entry. Rejects duplicates (use `update` to change
   * an existing entry) and any prefix that overlaps an existing entry's
   * subject tree.
   */
  async create(input: UpsertNatsPrefixAllowlistEntryInput, userId: string): Promise<NatsPrefixAllowlistEntry> {
    await this.validateForWrite(input, { isUpdate: false });
    await this.prisma.systemSettings.create({
      data: {
        category: CATEGORY,
        key: input.prefix,
        value: JSON.stringify({ allowedTemplateIds: input.allowedTemplateIds }),
        isEncrypted: false,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      },
    });
    log.info({ prefix: input.prefix, userId, count: input.allowedTemplateIds.length }, "nats-prefix-allowlist entry created");
    const created = await this.get(input.prefix);
    if (!created) throw new NatsPrefixAllowlistError("failed to load created entry", 500);
    return created;
  }

  /**
   * Update an existing entry's `allowedTemplateIds`. The prefix itself is
   * the immutable key — to rename, delete + create.
   */
  async update(prefix: string, input: { allowedTemplateIds: string[] }, userId: string): Promise<NatsPrefixAllowlistEntry> {
    const existing = await this.get(prefix);
    if (!existing) {
      throw new NatsPrefixAllowlistError(`allowlist entry for prefix '${prefix}' not found`, 404);
    }
    // Re-validate the new template IDs (overlap rules don't apply on update —
    // the prefix string isn't changing — but we do re-check that every
    // templateId references a real template).
    await this.validateForWrite({ prefix, allowedTemplateIds: input.allowedTemplateIds }, { isUpdate: true });
    await this.prisma.systemSettings.update({
      where: { category_key: { category: CATEGORY, key: prefix } },
      data: {
        value: JSON.stringify({ allowedTemplateIds: input.allowedTemplateIds }),
        updatedBy: userId,
        updatedAt: new Date(),
      },
    });
    log.info({ prefix, userId, count: input.allowedTemplateIds.length }, "nats-prefix-allowlist entry updated");
    const updated = await this.get(prefix);
    if (!updated) throw new NatsPrefixAllowlistError("failed to load updated entry", 500);
    return updated;
  }

  async remove(prefix: string, userId: string): Promise<void> {
    const existing = await this.get(prefix);
    if (!existing) {
      throw new NatsPrefixAllowlistError(`allowlist entry for prefix '${prefix}' not found`, 404);
    }
    await this.prisma.systemSettings.delete({
      where: { category_key: { category: CATEGORY, key: prefix } },
    });
    log.info({ prefix, userId }, "nats-prefix-allowlist entry deleted");
  }

  // ─── Validation helpers ────────────────────────────────────────────────────

  /**
   * Full per-write validation: prefix syntax + overlap (create only) +
   * non-empty allowedTemplateIds + every templateId references a real row.
   */
  private async validateForWrite(
    input: UpsertNatsPrefixAllowlistEntryInput,
    opts: { isUpdate: boolean },
  ): Promise<void> {
    validatePrefixSyntax(input.prefix);

    if (!Array.isArray(input.allowedTemplateIds) || input.allowedTemplateIds.length === 0) {
      throw new NatsPrefixAllowlistError("allowedTemplateIds must be a non-empty array", 400);
    }
    const seen = new Set<string>();
    for (const id of input.allowedTemplateIds) {
      if (typeof id !== "string" || id.length === 0) {
        throw new NatsPrefixAllowlistError("allowedTemplateIds entries must be non-empty strings", 400);
      }
      if (seen.has(id)) {
        throw new NatsPrefixAllowlistError(`duplicate templateId in allowedTemplateIds: '${id}'`, 400);
      }
      seen.add(id);
    }

    // Verify every templateId references a real template. One DB hit; cheap.
    const templates = await this.prisma.stackTemplate.findMany({
      where: { id: { in: input.allowedTemplateIds } },
      select: { id: true },
    });
    const realIds = new Set(templates.map((t) => t.id));
    const missing = input.allowedTemplateIds.filter((id) => !realIds.has(id));
    if (missing.length > 0) {
      throw new NatsPrefixAllowlistError(
        `allowedTemplateIds references unknown template${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
        400,
      );
    }

    // Overlap check — only on create. Update keeps the same prefix string
    // so overlap with itself is fine.
    if (!opts.isUpdate) {
      const existing = await this.list();
      for (const e of existing) {
        if (isSubjectTreeOverlap(e.prefix, input.prefix)) {
          throw new NatsPrefixAllowlistError(
            `prefix '${input.prefix}' overlaps existing allowlist entry '${e.prefix}' (one is a subject-tree ancestor or duplicate of the other)`,
            409,
          );
        }
      }
    }
  }
}
