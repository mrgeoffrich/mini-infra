import type { PrismaClient } from "../../../../generated/prisma/client";
import type { HelpAction } from "@mini-infra/types";

/**
 * Context handed to a predicate handler. Always includes a Prisma
 * client; predicates that care about the applying stack itself can
 * read `stackId` and look up scope/environment as needed.
 */
export interface PredicateContext {
  prisma: PrismaClient;
  /** Set when the evaluator is called for an instantiated stack. Unset
   *  when the precheck endpoint runs against a `templateVersionId` +
   *  `scope` pair (the stack doesn't exist yet). */
  stackId?: string;
}

export interface PredicateResult {
  ok: boolean;
  reason?: string;
  helpAction?: HelpAction;
}

export type PredicateHandler = (ctx: PredicateContext) => Promise<PredicateResult>;
