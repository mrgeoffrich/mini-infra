/**
 * Seed the prefix-allowlist entries that system templates need at apply time.
 *
 * Phase 1 deliberately deferred this — the server's own bus credential
 * carries explicit pub/sub on `mini-infra.>` directly and doesn't go through
 * the allowlist. Phase 2 is the first time a *template* (`egress-fw-agent`)
 * declares a non-default `subjectPrefix`, so the allowlist gate now applies.
 *
 * **Why per-subsystem entries (not a single `mini-infra` row).** The plan
 * doc §4.1 sketches a single top-level `mini-infra` allowlist entry covering
 * all system templates. The current `NatsPrefixAllowlistService` matches
 * exact prefix only — `lookupAllowedTemplateIds(prefix)` is a single
 * `findUnique` — and the overlap rule rejects nested entries (e.g.
 * `mini-infra` and `mini-infra.egress.fw` cannot coexist). Going hierarchical
 * is real scope creep that should ride a separate ticket. Per-subsystem
 * entries (`mini-infra.egress.fw`, `mini-infra.egress.gw`, `mini-infra.backup`,
 * etc.) deliver the same isolation guarantee with no allowlist-matcher
 * changes; each future phase just appends its own row here.
 *
 * Idempotent: at boot it reads each entry, leaves it alone if the binding
 * already includes the right template IDs, and otherwise upserts. Running
 * boot twice (or syncing after an in-place server update) is a no-op.
 */

import { PrismaClient } from "../../lib/prisma";
import { getLogger } from "../../lib/logger-factory";
import {
  NatsPrefixAllowlistService,
  NatsPrefixAllowlistError,
} from "./nats-prefix-allowlist-service";

const log = getLogger("integrations", "nats-prefix-allowlist-seed");
const SYSTEM_USER = "system";

/**
 * Single source of truth for which system template owns which subject prefix.
 * Phase-by-phase, each migration adds a row here:
 *
 *   - Phase 2 (ALT-27): `egress-fw-agent` ↔ `mini-infra.egress.fw`
 *   - Phase 3 (ALT-28): `egress-gateway`  ↔ `mini-infra.egress.gw`
 *   - Phase 4 (ALT-29): `pg-az-backup`    ↔ `mini-infra.backup`
 *
 * Adding an entry here whose template doesn't exist yet is a soft warn —
 * the seed skips it and keeps the bound rows it can resolve. That keeps
 * the seed safe to land ahead of the matching template rollout.
 */
export interface SystemPrefixSeedEntry {
  prefix: string;
  templateNames: string[];
  reason: string;
}

export const SYSTEM_PREFIX_ALLOWLIST_SEEDS: readonly SystemPrefixSeedEntry[] = [
  {
    prefix: "mini-infra.egress.fw",
    templateNames: ["egress-fw-agent"],
    reason: "Phase 2 (ALT-27): egress-fw-agent rule push, NFLOG events, heartbeat",
  },
] as const;

export interface SeedSystemPrefixAllowlistDeps {
  prisma: PrismaClient;
  /**
   * Map of template name → row from `syncBuiltinStacks`. Passing this in
   * (rather than re-reading the DB) keeps the seed in lock-step with the
   * upsert that just ran in the same boot phase.
   */
  templateByName: Map<string, { id: string }>;
}

export async function seedSystemPrefixAllowlist(
  deps: SeedSystemPrefixAllowlistDeps,
): Promise<void> {
  const allowlist = new NatsPrefixAllowlistService(deps.prisma);

  for (const seed of SYSTEM_PREFIX_ALLOWLIST_SEEDS) {
    // Resolve template IDs. Skip seeds whose templates aren't on disk yet —
    // a forward-declared seed (e.g. Phase 4's backup row landing before the
    // pg-az-backup template gets a real `subjectPrefix`) shouldn't error.
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const name of seed.templateNames) {
      const row = deps.templateByName.get(name);
      if (row) {
        resolved.push(row.id);
      } else {
        missing.push(name);
      }
    }
    if (resolved.length === 0) {
      log.info(
        { prefix: seed.prefix, missing },
        "skipping system prefix allowlist seed — no resolvable templates yet",
      );
      continue;
    }
    if (missing.length > 0) {
      log.warn(
        { prefix: seed.prefix, missing, resolvedCount: resolved.length },
        "system prefix allowlist seed: some templates not yet present, seeding remainder",
      );
    }

    try {
      const existing = await allowlist.get(seed.prefix);
      if (!existing) {
        await allowlist.create(
          { prefix: seed.prefix, allowedTemplateIds: resolved },
          SYSTEM_USER,
        );
        log.info(
          { prefix: seed.prefix, templateIds: resolved, reason: seed.reason },
          "seeded system prefix allowlist entry",
        );
        continue;
      }
      // Merge — preserve any operator-added entries while ensuring our
      // system templates are still bound. Set semantics, then sort for
      // stable storage.
      const merged = Array.from(new Set([...existing.allowedTemplateIds, ...resolved])).sort();
      const sortedExisting = [...existing.allowedTemplateIds].sort();
      if (merged.length === sortedExisting.length && merged.every((v, i) => v === sortedExisting[i])) {
        log.debug(
          { prefix: seed.prefix, templateCount: merged.length },
          "system prefix allowlist seed already up to date",
        );
        continue;
      }
      await allowlist.update(seed.prefix, { allowedTemplateIds: merged }, SYSTEM_USER);
      log.info(
        { prefix: seed.prefix, beforeCount: sortedExisting.length, afterCount: merged.length },
        "updated system prefix allowlist entry",
      );
    } catch (err) {
      // Don't fail the whole seed run if one entry fails — the rest may
      // still be applicable. Surface the error loudly so an operator
      // notices on next boot.
      if (err instanceof NatsPrefixAllowlistError) {
        log.error(
          { prefix: seed.prefix, statusCode: err.statusCode, msg: err.message },
          "system prefix allowlist seed failed (validation)",
        );
      } else {
        log.error(
          {
            prefix: seed.prefix,
            err: err instanceof Error ? err.message : String(err),
          },
          "system prefix allowlist seed failed (unexpected)",
        );
      }
    }
  }
}
