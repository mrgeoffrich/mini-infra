import { z } from "zod";
import {
  PREREQUISITE_MIN_STATES,
  PREREQUISITE_SCOPE_MATCHES,
} from "@mini-infra/types";
import { isKnownPredicate, listPredicateNames } from "./predicates";

const templateNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "templateName can only contain letters, numbers, hyphens, and underscores",
  );

const stackPrerequisiteSchema = z.object({
  kind: z.literal("stack"),
  templateName: templateNameSchema,
  minState: z.enum(PREREQUISITE_MIN_STATES),
  scopeMatch: z.enum(PREREQUISITE_SCOPE_MATCHES),
});

const predicatePrerequisiteSchema = z
  .object({
    kind: z.literal("predicate"),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9-]+$/,
        "predicate name must be kebab-case (lowercase letters, numbers, hyphens)",
      ),
  })
  .superRefine((data, ctx) => {
    // Tight registry: every referenced predicate must exist in the
    // server-side registry. Catches typos at template-load / draft-save
    // time rather than letting them through to apply where the failure
    // mode is "always blocked" or "never blocked" depending on which
    // way the unknown name evaluates.
    if (!isKnownPredicate(data.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown predicate '${data.name}'. Known predicates: ${listPredicateNames().map((n) => `'${n}'`).join(", ") || "(none)"}`,
        path: ["name"],
      });
    }
  });

/**
 * Cross-stack prerequisite block on a stack template version. Optional
 * everywhere — a template with no prereqs simply omits the field. A
 * template with `requires: []` is also valid (explicit empty).
 *
 * Shared between the file-loader path (template.json) and the HTTP
 * draft/create path so the two surfaces can't drift on shape or
 * predicate-name validation.
 */
export const templatePrerequisiteSchema = z.discriminatedUnion("kind", [
  stackPrerequisiteSchema,
  predicatePrerequisiteSchema,
]);

export const templateRequiresSchema = z.array(templatePrerequisiteSchema);
