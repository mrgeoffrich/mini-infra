// =====================================================================
// Template Prerequisites — cross-stack dependency declarations on a
// stack template version. Phase 1 of the three-phase split-vault-nats
// plan shipped these types as pure infrastructure; Phase 2 wires the
// `nats`, `egress-fw-agent`, and `egress-gateway` templates to use them.
// =====================================================================

/** Statuses a stack-kind requirement can demand. Higher implies lower
 *  in the apply-readiness ordering — `synced` satisfies any minState,
 *  `pending` only satisfies `pending`. `error` and `removed` never
 *  satisfy a requirement. The schema validator rejects any other value. */
export const PREREQUISITE_MIN_STATES = ["synced", "drifted", "pending"] as const;
export type MinState = typeof PREREQUISITE_MIN_STATES[number];

/** How a stack-kind requirement matches candidate stacks against the
 *  applying stack's scope. `host` matches host-scoped stacks only;
 *  `environment` matches any env-scoped stack of the named template;
 *  `same-environment` matches an env-scoped stack of the named template
 *  in the **same** environment as the applying stack. The evaluator
 *  rejects `same-environment` requirements when the applying stack is
 *  itself host-scoped. */
export const PREREQUISITE_SCOPE_MATCHES = ["host", "environment", "same-environment"] as const;
export type ScopeMatch = typeof PREREQUISITE_SCOPE_MATCHES[number];

/** Distinguishing tag for the discriminated union. */
export const PREREQUISITE_KINDS = ["stack", "predicate"] as const;
export type RequirementKind = typeof PREREQUISITE_KINDS[number];

/** A `stack`-kind requirement: at least one stack instantiated from the
 *  named template must exist with status >= minState, matching scope. */
export interface StackPrerequisite {
  kind: "stack";
  templateName: string;
  minState: MinState;
  scopeMatch: ScopeMatch;
}

/** A `predicate`-kind requirement: a named function in the server-side
 *  predicate registry must return `ok: true`. Names are validated
 *  against the registry at template load time so a typo blows up
 *  `syncBuiltinStacks` rather than failing silently at apply. */
export interface PredicatePrerequisite {
  kind: "predicate";
  name: string;
}

/** Discriminated union of all prerequisite kinds. */
export type StackTemplatePrerequisite = StackPrerequisite | PredicatePrerequisite;

/** Optional structured deep-link hint for the UI to render a "fix this"
 *  CTA next to a failure. The frontend interprets these — the server
 *  treats them as opaque strings. */
export type HelpAction =
  | { type: "apply-stack"; templateName: string; scopeMatch: ScopeMatch }
  | { type: "instantiate-stack"; templateName: string; scopeMatch: ScopeMatch }
  | { type: "open-vault-bootstrap" };

/** A single unmet requirement, in shape returned by both the precheck
 *  endpoints and the 409 PREREQUISITES_NOT_MET apply-route response. */
export interface PrerequisiteFailure {
  kind: RequirementKind;
  reason: string;
  helpAction?: HelpAction;
  /** Machine-readable context (e.g. `{ templateName, observedStatus }`).
   *  Optional — included when useful for diagnostics. */
  detail?: Record<string, unknown>;
}

/** Result of evaluating a stack template version's `requires` block
 *  against the current world. `ok: true` means apply may proceed. */
export interface PrerequisiteEvaluation {
  ok: boolean;
  failures: PrerequisiteFailure[];
}

/** Wire shape returned by the apply-route 409 path. */
export interface PrerequisitesNotMetResponse {
  success: false;
  code: "PREREQUISITES_NOT_MET";
  failures: PrerequisiteFailure[];
}
