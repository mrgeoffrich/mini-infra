import Fuse from "fuse.js";
import { useEffect, useMemo, useState } from "react";
import { docRegistry, loadAllDocContent, type DocEntry } from "./doc-loader";

/**
 * Doc bodies are lazy now (see doc-loader.ts), so the search index is built in
 * two stages: a metadata-only Fuse index synchronously (titles, descriptions,
 * topics, tags — instant, no bodies), then a content-aware index once the
 * bodies have been fetched on first use. Full-text ranking (weight 0.1) is
 * preserved; it just isn't paid for until someone actually searches.
 */
const METADATA_KEYS = [
  { name: "frontmatter.title", weight: 0.4 },
  { name: "frontmatter.description", weight: 0.25 },
  { name: "topics", weight: 0.2 },
  { name: "frontmatter.tags", weight: 0.05 },
];

const OPTS = { threshold: 0.4, includeScore: true, minMatchCharLength: 2 };

const metadataIndex = new Fuse(docRegistry, { keys: METADATA_KEYS, ...OPTS });

let contentIndex: Fuse<DocEntry> | null = null;
let contentPromise: Promise<void> | null = null;

/** Fetch every body once and upgrade to a content-aware index. Idempotent. */
function ensureContentIndex(): Promise<void> {
  if (!contentPromise) {
    contentPromise = loadAllDocContent().then((withContent) => {
      contentIndex = new Fuse<DocEntry>(withContent, {
        keys: [...METADATA_KEYS, { name: "content", weight: 0.1 }],
        ...OPTS,
      });
    });
  }
  return contentPromise;
}

export function useDocSearch(query: string): DocEntry[] {
  // `ready` flips once the content index is built, re-running the memo so an
  // in-flight query upgrades from metadata- to content-aware results.
  const [ready, setReady] = useState(contentIndex !== null);

  useEffect(() => {
    if (contentIndex) return;
    let active = true;
    void ensureContentIndex().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  return useMemo(() => {
    if (!query.trim()) return docRegistry;
    const index = contentIndex ?? metadataIndex;
    return index.search(query).map((r) => r.item);
    // `ready` is a dependency so results recompute when the content index lands.
  }, [query, ready]);
}
