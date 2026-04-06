import Fuse from "fuse.js";
import { useMemo } from "react";
import { docRegistry, type DocEntry } from "./doc-loader";

const fuseIndex = new Fuse(docRegistry, {
  keys: [
    { name: "frontmatter.title", weight: 0.4 },
    { name: "frontmatter.description", weight: 0.25 },
    { name: "topics", weight: 0.2 },
    { name: "frontmatter.tags", weight: 0.05 },
    { name: "content", weight: 0.1 },
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
