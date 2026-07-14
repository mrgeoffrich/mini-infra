import { describe, it, expect } from "vitest";
import { planPromotion } from "@/lib/promotion";

/**
 * Promotion is "upgrade the target stack to the version the source already has".
 * The two cases worth pinning are the ones a naive implementation gets wrong:
 * the target being *ahead* (a rollback wearing a promotion's clothes), and the
 * target already being there (a no-op the server reports as a 409).
 */
describe("planPromotion", () => {
  const v = (id: string | null, num: number | null) => ({
    templateVersionId: id,
    templateVersion: num,
  });

  it("promotes forward when the target is behind the source", () => {
    expect(planPromotion(v("ver3", 3), v("ver1", 1))).toEqual({
      alreadyThere: false,
      isBackwards: false,
      canPromote: true,
    });
  });

  it("flags a backwards move rather than calling it a promotion", () => {
    // Production got a hotfix (v5) that staging (v3) never saw. Aligning
    // production with staging is legitimate — the server allows it because the
    // target version is explicit — but it rolls production back, and the UI has
    // to say so.
    const plan = planPromotion(v("ver3", 3), v("ver5", 5));
    expect(plan.isBackwards).toBe(true);
    expect(plan.canPromote).toBe(true);
    expect(plan.alreadyThere).toBe(false);
  });

  it("treats an already-matching target as a no-op, not an error", () => {
    // The server answers 409 STACK_ALREADY_ON_LATEST here. Catching it up front
    // keeps an error toast away from someone who asked for the state the system
    // is already in.
    expect(planPromotion(v("ver3", 3), v("ver3", 3))).toEqual({
      alreadyThere: true,
      isBackwards: false,
      canPromote: false,
    });
  });

  it("matches on version id, not version number", () => {
    // Version *numbers* are only unique within a template. Two stacks both
    // reading "v2" are only the same deployment if the ids agree — and the id is
    // what the server compares.
    const plan = planPromotion(v("ver-a-2", 2), v("ver-b-2", 2));
    expect(plan.alreadyThere).toBe(false);
    expect(plan.canPromote).toBe(true);
  });

  it("cannot promote when the source has no version installed", () => {
    expect(planPromotion(v(null, null), v("ver1", 1)).canPromote).toBe(false);
  });

  it("cannot promote without a target", () => {
    expect(planPromotion(v("ver3", 3), null).canPromote).toBe(false);
  });

  it("still promotes when version numbers are unknown but the ids differ", () => {
    // Missing numbers must not be read as "not backwards, therefore fine to
    // silently skip" — the move is still real, we just can't label its direction.
    const plan = planPromotion(v("ver3", null), v("ver1", null));
    expect(plan.canPromote).toBe(true);
    expect(plan.isBackwards).toBe(false);
  });
});
