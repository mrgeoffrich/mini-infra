/**
 * Domain-trie based rule matcher.
 *
 * Trie is keyed by labels in reverse order (com -> openai -> api).
 * Supports exact matches and single wildcard prefix (*.suffix.example).
 * Longest match wins; ties broken by exact > wildcard, then first-insertion order.
 */

import type { EgressRule, StackPolicy } from "./types";

interface TrieNode {
  /** Rules attached directly at this node (exact match for this depth) */
  exactRules: EgressRule[];
  /** Rules attached at this node as a wildcard (matches any child label here) */
  wildcardRules: EgressRule[];
  children: Map<string, TrieNode>;
}

function makeNode(): TrieNode {
  return { exactRules: [], wildcardRules: [], children: new Map() };
}

/**
 * Splits a domain name into reversed labels.
 * 'api.openai.com' -> ['com', 'openai', 'api']
 */
function reversedLabels(domain: string): string[] {
  return domain
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .reverse();
}

/**
 * Parses a rule pattern into (isWildcard, reversed labels of the base domain).
 *
 * '*.googleapis.com' -> isWildcard=true, labels=['com','googleapis']
 * 'api.openai.com'   -> isWildcard=false, labels=['com','openai','api']
 */
function parsePattern(pattern: string): {
  isWildcard: boolean;
  labels: string[];
} {
  const lower = pattern.toLowerCase();
  if (lower.startsWith("*.")) {
    return { isWildcard: true, labels: reversedLabels(lower.slice(2)) };
  }
  return { isWildcard: false, labels: reversedLabels(lower) };
}

/** 0 = no match, 1 = wildcard, 2 = exact (higher = better at same depth) */
type MatchKind = 0 | 1 | 2;

interface BestMatch {
  rule: EgressRule;
  depth: number;
  kind: MatchKind;
}

function betterThan(candidate: BestMatch, current: BestMatch | null): boolean {
  if (current === null) return true;
  if (candidate.depth > current.depth) return true;
  if (candidate.depth === current.depth && candidate.kind > current.kind) return true;
  return false;
}

export class RuleTrie {
  private root: TrieNode = makeNode();

  /**
   * Insert a single rule into the trie.
   */
  insert(rule: EgressRule): void {
    const { isWildcard, labels } = parsePattern(rule.pattern);

    let node = this.root;
    for (const label of labels) {
      if (!node.children.has(label)) {
        node.children.set(label, makeNode());
      }
      node = node.children.get(label)!;
    }

    if (isWildcard) {
      node.wildcardRules.push(rule);
    } else {
      node.exactRules.push(rule);
    }
  }

  /**
   * Find the best matching rule for a domain and service name.
   *
   * Longest match wins; at equal depth exact > wildcard; within same type first insertion wins.
   * The `serviceName` parameter may be null when the source IP is unknown.
   */
  match(
    domain: string,
    serviceName: string | null,
  ): EgressRule | null {
    const labels = reversedLabels(domain);
    const best = this._search(this.root, labels, 0, serviceName, null);
    return best?.rule ?? null;
  }

  private _search(
    node: TrieNode,
    labels: string[],
    depth: number,
    serviceName: string | null,
    best: BestMatch | null,
  ): BestMatch | null {
    // Wildcards at this node match any single remaining label (and beyond).
    // effectiveDepth = depth + 1 (wildcard consumes one additional label).
    // Only valid if there is at least one remaining label (depth < labels.length).
    if (depth < labels.length) {
      const wildcardRule = this._firstApplicableRule(node.wildcardRules, serviceName);
      if (wildcardRule !== null) {
        const candidate: BestMatch = { rule: wildcardRule, depth: depth + 1, kind: 1 };
        if (betterThan(candidate, best)) {
          best = candidate;
        }
      }
    }

    if (depth === labels.length) {
      // At the leaf — check exact rules.
      const exactRule = this._firstApplicableRule(node.exactRules, serviceName);
      if (exactRule !== null) {
        const candidate: BestMatch = { rule: exactRule, depth, kind: 2 };
        if (betterThan(candidate, best)) {
          best = candidate;
        }
      }
      return best;
    }

    // Descend into the child matching the next label.
    const label = labels[depth];
    const child = node.children.get(label);
    if (child) {
      best = this._search(child, labels, depth + 1, serviceName, best);
    }

    return best;
  }

  private _firstApplicableRule(
    rules: EgressRule[],
    serviceName: string | null,
  ): EgressRule | null {
    for (const rule of rules) {
      if (
        rule.targets.length === 0 ||
        (serviceName !== null && rule.targets.includes(serviceName))
      ) {
        return rule;
      }
    }
    return null;
  }
}

/**
 * Build a RuleTrie from a StackPolicy's rule list.
 */
export function buildTrie(policy: StackPolicy): RuleTrie {
  const trie = new RuleTrie();
  for (const rule of policy.rules) {
    trie.insert(rule);
  }
  return trie;
}

/**
 * Determine the effective action for a given domain + service within a policy.
 * Returns the matched rule (for pattern logging) and the effective action.
 */
export function matchPolicy(
  trie: RuleTrie,
  policy: StackPolicy,
  domain: string,
  serviceName: string | null,
): { action: "allow" | "block"; matchedPattern: string | null } {
  const rule = trie.match(domain, serviceName);
  if (rule === null) {
    return { action: policy.defaultAction, matchedPattern: null };
  }
  return { action: rule.action, matchedPattern: rule.pattern };
}
