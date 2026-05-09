/**
 * Cross-stack template prerequisites (Phase 1 of the split-vault-nats
 * plan). The public surface is the evaluator + the predicate-name list
 * used at template load time. All other internals (predicate handlers,
 * stack-requirement evaluation) are intentionally not exported.
 */
export {
  evaluatePrerequisites,
  evaluatePrerequisitesForTemplateVersion,
} from "./evaluator";
export {
  isKnownPredicate,
  listPredicateNames,
} from "./predicates";
