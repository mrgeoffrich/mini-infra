/**
 * Wildcard collapse suggestion algorithm for the Promote-to-Enforce wizard.
 *
 * Algorithm:
 *   1. Strip the leftmost label from each destination to get its "parent suffix"
 *      (e.g. oauth2.googleapis.com → googleapis.com).
 *   2. Group destinations by parent suffix.
 *   3. If a parent suffix has ≥3 distinct child destinations AND has ≥2 labels
 *      (floor against TLD-like suffixes such as "com"), propose *.{parent}.
 *   4. Return the proposals plus any destinations not covered by a proposal.
 */

export interface WildcardSuggestion {
  /** The proposed wildcard pattern, e.g. "*.googleapis.com". */
  pattern: string;
  /** The exact destinations that would be covered. */
  covers: string[];
}

export interface WildcardSuggestions {
  suggestions: WildcardSuggestion[];
  /** Destinations that are not covered by any suggestion. */
  uncovered: string[];
}

/**
 * Returns true if `suffix` has at least two DNS labels
 * (i.e. not a bare TLD such as "com" or "net").
 */
function hasTwoOrMoreLabels(suffix: string): boolean {
  return suffix.split(".").filter(Boolean).length >= 2;
}

/**
 * Returns the parent suffix of a hostname by dropping the leftmost label.
 * "oauth2.googleapis.com" → "googleapis.com"
 * "googleapis.com"        → "com"
 * "com"                   → "" (single-label, no parent)
 */
function parentSuffix(hostname: string): string {
  const idx = hostname.indexOf(".");
  if (idx === -1) return "";
  return hostname.slice(idx + 1);
}

/**
 * Compute wildcard collapse suggestions from a list of destination hostnames.
 *
 * @param destinations  All observed destination hostnames.
 * @param existingRules Existing rule patterns (already covered); destinations
 *                      matched by these are excluded from the "uncovered" list
 *                      but still appear inside suggestion.covers so the user
 *                      can see the full picture.
 * @param threshold     Minimum children per parent to propose a wildcard (default 3).
 */
export function computeWildcardSuggestions(
  destinations: string[],
  existingRules: string[] = [],
  threshold = 3,
): WildcardSuggestions {
  const unique = Array.from(new Set(destinations));

  // Group by parent suffix
  const byParent = new Map<string, string[]>();
  for (const dest of unique) {
    const parent = parentSuffix(dest);
    if (!parent) continue; // single-label host — can't wildcard
    const arr = byParent.get(parent) ?? [];
    arr.push(dest);
    byParent.set(parent, arr);
  }

  const suggestions: WildcardSuggestion[] = [];
  const coveredByWildcard = new Set<string>();

  for (const [parent, children] of byParent) {
    if (children.length >= threshold && hasTwoOrMoreLabels(parent)) {
      const pattern = `*.${parent}`;
      suggestions.push({ pattern, covers: children.slice().sort() });
      children.forEach((c) => coveredByWildcard.add(c));
    }
  }

  // Build a matcher for existing rule patterns so we can exclude already-covered
  // destinations from the uncovered list.
  function isCoveredByExisting(dest: string): boolean {
    return existingRules.some((rule) => {
      if (rule === dest) return true;
      if (rule.startsWith("*.")) {
        const suffix = rule.slice(2);
        return dest === suffix || dest.endsWith(`.${suffix}`);
      }
      return false;
    });
  }

  const uncovered = unique.filter(
    (d) => !coveredByWildcard.has(d) && !isCoveredByExisting(d),
  );

  return { suggestions, uncovered };
}
