/**
 * Integration tests for the system NATS prefix allowlist seed.
 *
 * Pinches: idempotent across boots, merges with operator-added entries
 * instead of overwriting, soft-skips seeds whose templates aren't on disk
 * yet, and surfaces validation errors without crashing the rest of the run.
 */

import { describe, it, expect, vi } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

import { NatsPrefixAllowlistService } from "../services/nats/nats-prefix-allowlist-service";
import {
  seedSystemPrefixAllowlist,
  SYSTEM_PREFIX_ALLOWLIST_SEEDS,
} from "../services/nats/seed-system-prefix-allowlist";

const FW_PREFIX = "mini-infra.egress.fw";

async function makeTemplate(name: string): Promise<string> {
  const id = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id,
      name,
      displayName: name,
      source: "system",
      scope: "host",
      currentVersionId: null,
      draftVersionId: null,
    },
  });
  return id;
}

describe("seedSystemPrefixAllowlist", () => {
  it("seed registry includes the Phase 2 fw-agent entry", () => {
    const fw = SYSTEM_PREFIX_ALLOWLIST_SEEDS.find((s) => s.prefix === FW_PREFIX);
    expect(fw).toBeDefined();
    expect(fw?.templateNames).toContain("egress-fw-agent");
  });

  it("creates a missing entry and binds it to the resolved template id", async () => {
    const fwId = await makeTemplate("egress-fw-agent");
    const templateByName = new Map([["egress-fw-agent", { id: fwId }]]);

    await seedSystemPrefixAllowlist({ prisma: testPrisma, templateByName });

    const entry = await new NatsPrefixAllowlistService(testPrisma).get(FW_PREFIX);
    expect(entry).not.toBeNull();
    expect(entry!.allowedTemplateIds).toEqual([fwId]);
  });

  it("is idempotent — running twice with the same templates is a no-op write-wise", async () => {
    const fwId = await makeTemplate("egress-fw-agent");
    const templateByName = new Map([["egress-fw-agent", { id: fwId }]]);

    await seedSystemPrefixAllowlist({ prisma: testPrisma, templateByName });
    const first = await new NatsPrefixAllowlistService(testPrisma).get(FW_PREFIX);
    const firstUpdatedAt = first!.updatedAt.getTime();

    // Second run, same inputs. updatedAt should be untouched (no write
    // path triggered) — the seed only updates when the merged set differs.
    await new Promise((r) => setTimeout(r, 5));
    await seedSystemPrefixAllowlist({ prisma: testPrisma, templateByName });
    const second = await new NatsPrefixAllowlistService(testPrisma).get(FW_PREFIX);
    expect(second!.updatedAt.getTime()).toBe(firstUpdatedAt);
    expect(second!.allowedTemplateIds).toEqual([fwId]);
  });

  it("merges operator-added entries on top of an existing allowlist row", async () => {
    const fwId = await makeTemplate("egress-fw-agent");
    const operatorTplId = await makeTemplate("operator-added-template");
    const templateByName = new Map([["egress-fw-agent", { id: fwId }]]);

    // Operator created an allowlist row first with their own template — the
    // seed must preserve their entry and add the system template alongside.
    const allowlist = new NatsPrefixAllowlistService(testPrisma);
    await allowlist.create(
      { prefix: FW_PREFIX, allowedTemplateIds: [operatorTplId] },
      "operator",
    );

    await seedSystemPrefixAllowlist({ prisma: testPrisma, templateByName });

    const entry = await allowlist.get(FW_PREFIX);
    expect(entry!.allowedTemplateIds).toContain(fwId);
    expect(entry!.allowedTemplateIds).toContain(operatorTplId);
    expect(entry!.allowedTemplateIds).toHaveLength(2);
  });

  it("soft-skips seeds whose template isn't on disk yet (forward declaration safe)", async () => {
    // Pass an empty templateByName — the seed should not throw, just log
    // and continue. Allowlist row should not be created.
    await seedSystemPrefixAllowlist({
      prisma: testPrisma,
      templateByName: new Map(),
    });

    const entry = await new NatsPrefixAllowlistService(testPrisma).get(FW_PREFIX);
    expect(entry).toBeNull();
  });
});
