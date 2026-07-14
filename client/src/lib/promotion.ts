import type { StackInfo } from "@mini-infra/types";

/**
 * What promoting `source`'s installed template version into `target` would
 * actually do.
 *
 * Pulled out of the dialog because the interesting part is not the rendering —
 * it is that "promote" has three outcomes, and two of them are easy to get
 * wrong:
 *
 *  - a genuine promotion (target moves forward to the source's version);
 *  - a **rollback**, when the target is already on a *newer* version than the
 *    source (a hotfix published straight to production, or a template rollback).
 *    The server permits this as long as the target version is explicit, and it
 *    is a legitimate thing to want — but calling it a "promotion" in the UI
 *    would be a lie about the direction of travel;
 *  - a **no-op**, when the target already has that exact version. The server
 *    answers 409 `STACK_ALREADY_ON_LATEST` here. That is not a failure, and
 *    firing an error toast at someone who asked for a state the system is
 *    already in is just noise — so it gets caught before the request is sent.
 */
export interface PromotionPlan {
  /** Target already has this exact version — nothing to do. */
  alreadyThere: boolean;
  /** The target would move *backwards*. Allowed, but it is a rollback. */
  isBackwards: boolean;
  /** Safe to fire the upgrade. False for a no-op, or with nothing to promote. */
  canPromote: boolean;
}

export function planPromotion(
  source: Pick<StackInfo, "templateVersionId" | "templateVersion">,
  target: Pick<StackInfo, "templateVersionId" | "templateVersion"> | null,
): PromotionPlan {
  const noPlan = { alreadyThere: false, isBackwards: false, canPromote: false };

  // Nothing installed on the source → nothing to hand to the target.
  if (target == null || source.templateVersionId == null) return noPlan;

  // Compare on the version *id*, not the number. The number is only unique
  // within one template, and the id is the value the server itself compares.
  const alreadyThere = target.templateVersionId === source.templateVersionId;
  if (alreadyThere) return { alreadyThere: true, isBackwards: false, canPromote: false };

  const isBackwards =
    source.templateVersion != null &&
    target.templateVersion != null &&
    source.templateVersion < target.templateVersion;

  return { alreadyThere: false, isBackwards, canPromote: true };
}
