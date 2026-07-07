import { describe, it, expect } from "vitest";
import {
  EDIT_SECTIONS,
  computeSectionErrors,
  firstErroredSectionId,
  sectionAnchorId,
} from "@/app/applications/[id]/configuration/section-meta";

describe("section-meta", () => {
  it("maps every form field key to exactly one section", () => {
    const seen = new Map<string, string>();
    for (const section of EDIT_SECTIONS) {
      for (const key of section.fieldKeys) {
        expect(seen.has(key)).toBe(false);
        seen.set(key, section.id);
      }
    }
    // Sanity: the frequently-edited image fields lead the list.
    expect(EDIT_SECTIONS[0].id).toBe("image");
    expect(EDIT_SECTIONS[0].fieldKeys).toEqual(["dockerImage", "dockerTag"]);
  });

  describe("computeSectionErrors", () => {
    it("returns an empty set when there are no errors", () => {
      expect(computeSectionErrors([]).size).toBe(0);
    });

    it("maps a field-level error to its owning section", () => {
      expect([...computeSectionErrors(["dockerTag"])]).toEqual(["image"]);
      expect([...computeSectionErrors(["routing"])]).toEqual(["networking"]);
      expect([...computeSectionErrors(["healthCheck"])]).toEqual(["runtime"]);
    });

    it("maps errors across multiple sections", () => {
      const result = computeSectionErrors(["envVars", "volumeMounts"]);
      expect(result).toEqual(new Set(["environment", "storage"]));
    });

    it("ignores keys that no section owns", () => {
      expect(computeSectionErrors(["nonexistentField"]).size).toBe(0);
    });
  });

  describe("firstErroredSectionId", () => {
    it("returns null when nothing is errored", () => {
      expect(firstErroredSectionId([])).toBeNull();
    });

    it("returns the first errored section in render order, not input order", () => {
      // identity (last) listed before image (first) — render order must win.
      expect(firstErroredSectionId(["serviceName", "dockerImage"])).toBe(
        "image",
      );
    });

    it("resolves a single deep field to its section", () => {
      expect(firstErroredSectionId(["restartPolicy"])).toBe("runtime");
    });
  });

  it("builds a stable anchor id", () => {
    expect(sectionAnchorId("networking")).toBe("app-config-section-networking");
  });
});
