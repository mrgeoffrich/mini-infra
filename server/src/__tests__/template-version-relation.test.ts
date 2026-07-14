/**
 * The installed-vs-current comparison (P4 4.2).
 *
 * This lives in @mini-infra/types because three server surfaces had hand-rolled
 * copies of it — the stack serializer, the plan computer, and the template's
 * linked-stacks panel — and one of them said "Mirror utils.computeTemplateUpdateAvailable"
 * in a comment, which is the sound a duplication makes just before it drifts.
 */
import { describe, it, expect } from "vitest";
import { computeTemplateVersionRelation } from "@mini-infra/types";

describe("computeTemplateVersionRelation", () => {
  it("reports `behind` when the template has a newer published version", () => {
    expect(computeTemplateVersionRelation(1, 2)).toBe("behind");
  });

  it("reports `current` when the stack tracks the template's current version", () => {
    expect(computeTemplateVersionRelation(2, 2)).toBe("current");
  });

  it("reports `ahead` when the stack is on a version newer than current", () => {
    // Not corruption — this is exactly what a template rollback leaves behind,
    // since rollback re-points currentVersionId without touching installed stacks.
    expect(computeTemplateVersionRelation(3, 2)).toBe("ahead");
  });

  it("reports `unknown` for a templateless stack or an unpublished template", () => {
    expect(computeTemplateVersionRelation(null, 2)).toBe("unknown");
    expect(computeTemplateVersionRelation(1, null)).toBe("unknown");
    expect(computeTemplateVersionRelation(undefined, undefined)).toBe("unknown");
  });

  it("does not treat version 0 as absent", () => {
    // A `!installedVersion` truthiness check — which is what the old serializer
    // used — would call this `unknown` and hide a real available upgrade.
    expect(computeTemplateVersionRelation(0, 1)).toBe("behind");
  });
});
