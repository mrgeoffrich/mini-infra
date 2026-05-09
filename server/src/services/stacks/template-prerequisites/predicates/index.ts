/**
 * Tight, code-only registry of predicate names. Mirrors the
 * post-install-actions pattern at
 * server/src/services/stacks/post-install-actions/index.ts — the set of
 * accepted names is fixed at build time, so a typo in a template's
 * `requires` block fails loudly at template-load time rather than
 * silently passing/failing at apply.
 */
import { vaultBootstrappedPredicate } from "./vault-bootstrapped";
import type { PredicateHandler } from "./types";

export type { PredicateHandler, PredicateContext, PredicateResult } from "./types";

const registry: Record<string, PredicateHandler> = {
  "vault-bootstrapped": vaultBootstrappedPredicate,
};

export function getPredicate(name: string): PredicateHandler | undefined {
  return registry[name];
}

export function listPredicateNames(): string[] {
  return Object.keys(registry);
}

export function isKnownPredicate(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, name);
}
