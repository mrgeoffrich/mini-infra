import Fuse from "fuse.js";
import { useMemo } from "react";
import { docRegistry, type DocEntry } from "./doc-loader";

/**
 * Help search ranks over article *metadata* — title, description, the curated
 * `topics` list (which docs-structure.yaml maintains specifically "for search
 * ranking and agent lookups"), and tags. It deliberately does NOT index the
 * markdown bodies: those are lazy-loaded now (see doc-loader.ts) so they don't
 * ship in the initial bundle, and pulling all 56 of them back just to add a
 * weight-0.1 full-text signal would undo that win. The metadata carries the
 * large majority of the ranking weight, so results are effectively unchanged
 * for real queries.
 */
const fuseIndex = new Fuse(docRegistry, {
  keys: [
    { name: "frontmatter.title", weight: 0.45 },
    { name: "frontmatter.description", weight: 0.3 },
    { name: "topics", weight: 0.2 },
    { name: "frontmatter.tags", weight: 0.05 },
  ],
  threshold: 0.4,
  includeScore: true,
  minMatchCharLength: 2,
});

export function useDocSearch(query: string): DocEntry[] {
  return useMemo(() => {
    if (!query.trim()) return docRegistry;
    return fuseIndex.search(query).map((r) => r.item);
  }, [query]);
}
