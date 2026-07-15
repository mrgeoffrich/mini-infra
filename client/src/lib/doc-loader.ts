import docsStructure from "../user-docs/docs-structure.yaml";
import docsQuestions from "../user-docs/docs-questions.yaml";
import docsMeta from "../user-docs/docs-meta.generated.json";

/**
 * Doc *metadata* (title/description/tags per article) is loaded eagerly from a
 * small generated manifest — see `scripts/generate-docs-meta.mjs`. Doc *bodies*
 * are loaded lazily (below), so the ~436 KB of markdown no longer ships in the
 * initial bundle for the always-mounted help sidebar. Only the help article
 * page (a lazy route) and the search index (lazily, on first use) ever pull a
 * body across the wire. Re-run `pnpm generate:docs-meta` after adding, renaming,
 * or re-titling an article.
 */

export interface DocFrontmatter {
  title: string;
  description: string;
  tags?: string[];
}

/**
 * Article metadata. `content` (the markdown body) is loaded lazily and is
 * therefore optional — the eager registry leaves it unset; the help page and
 * search index fill it on demand (see `loadDocContent` / `loadAllDocContent`).
 */
export interface DocEntry {
  slug: string;
  category: string;
  frontmatter: DocFrontmatter;
  href: string;
  /** Topics this article covers — from docs-structure.yaml */
  topics: string[];
  /** Markdown body, present only once lazily loaded. */
  content?: string;
}

export interface ArticleDef {
  slug: string;
  topics: string[];
}

export interface SectionDef {
  slug: string;
  label: string;
  description: string;
  articles: ArticleDef[];
}

export interface DocsStructure {
  sections: SectionDef[];
}

export interface QuestionMapping {
  q: string;
  ref: string;
}

const structure = docsStructure as DocsStructure;
const questions = docsQuestions as QuestionMapping[];
const metaMap = docsMeta as Record<string, DocFrontmatter>;

/** Build a lookup from "category/slug" → topics[] */
function buildTopicsMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const section of structure.sections) {
    for (const article of section.articles) {
      map.set(`${section.slug}/${article.slug}`, article.topics ?? []);
    }
  }
  return map;
}

const topicsMap = buildTopicsMap();

/**
 * Lazy body loaders, keyed by "category/slug". `eager: false` (the default) is
 * the whole point — Vite emits a dynamic import per file instead of inlining
 * every body into this module's chunk.
 */
const bodyLoaders = import.meta.glob("../user-docs/**/*.md", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

function keyForPath(filePath: string): string {
  const parts = filePath
    .replace("../user-docs/", "")
    .replace(/\.md$/, "")
    .split("/");
  const category = parts[0];
  const slug = parts[parts.length - 1];
  return `${category}/${slug}`;
}

const loaderByKey = new Map<string, () => Promise<string>>();
for (const [filePath, loader] of Object.entries(bodyLoaders)) {
  loaderByKey.set(keyForPath(filePath), loader);
}

/** Minimal front-matter stripper — the manifest already holds the parsed attributes. */
function stripFrontMatter(raw: string): string {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (match ? match[1] : raw).trim();
}

function metaFor(key: string, slug: string): DocFrontmatter {
  return metaMap[key] ?? { title: slug, description: "" };
}

/** Build the metadata-only registry (body-free) from the manifest + structure. */
function buildRegistry(): DocEntry[] {
  const entries: DocEntry[] = [];
  const seen = new Set<string>();

  const add = (key: string) => {
    if (seen.has(key)) return;
    const [category, slug] = key.split("/");
    entries.push({
      slug,
      category,
      frontmatter: metaFor(key, slug),
      href: `/help/${category}/${slug}`,
      topics: topicsMap.get(key) ?? [],
    });
    seen.add(key);
  };

  // YAML-defined order first…
  for (const section of structure.sections) {
    for (const article of section.articles) {
      const key = `${section.slug}/${article.slug}`;
      if (metaMap[key]) add(key);
    }
  }
  // …then any article present on disk (in the manifest) but not yet in the YAML.
  for (const key of Object.keys(metaMap)) add(key);

  return entries;
}

export const docRegistry: DocEntry[] = buildRegistry();

export function getDocBySlug(
  category: string,
  slug: string
): DocEntry | undefined {
  return docRegistry.find((d) => d.category === category && d.slug === slug);
}

/** Load one article's markdown body (front-matter stripped). Returns null if unknown. */
export async function loadDocContent(
  category: string,
  slug: string
): Promise<string | null> {
  const loader = loaderByKey.get(`${category}/${slug}`);
  if (!loader) return null;
  return stripFrontMatter(await loader());
}

/** Load every article body and pair it with its metadata — used to build the search index. */
export async function loadAllDocContent(): Promise<DocEntry[]> {
  return Promise.all(
    docRegistry.map(async (entry) => ({
      ...entry,
      content: stripFrontMatter(
        (await loaderByKey.get(`${entry.category}/${entry.slug}`)?.()) ?? ""
      ),
    })),
  );
}

export interface DocCategory {
  slug: string;
  label: string;
  description: string;
  docs: DocEntry[];
}

export function getDocsByCategory(): DocCategory[] {
  const categories: DocCategory[] = [];
  const seen = new Set<string>();

  // Build categories in YAML-defined order
  for (const section of structure.sections) {
    const docs = section.articles
      .map((article) => getDocBySlug(section.slug, article.slug))
      .filter((d): d is DocEntry => d !== undefined);

    if (docs.length > 0) {
      categories.push({
        slug: section.slug,
        label: section.label,
        description: section.description,
        docs,
      });
      seen.add(section.slug);
    }
  }

  // Append any categories that exist on disk but aren't in the YAML
  const remaining = new Map<string, DocEntry[]>();
  for (const doc of docRegistry) {
    if (!seen.has(doc.category)) {
      const existing = remaining.get(doc.category) ?? [];
      existing.push(doc);
      remaining.set(doc.category, existing);
    }
  }
  for (const [slug, docs] of remaining) {
    categories.push({
      slug,
      label: slug,
      description: "",
      docs,
    });
  }

  return categories;
}

/** Look up the display label for a category slug */
export function getCategoryLabel(categorySlug: string): string {
  const section = structure.sections.find((s) => s.slug === categorySlug);
  return section?.label ?? categorySlug;
}

/** Exported for use by other consumers (e.g. agent, search) */
export { structure as docsStructure, questions as docsQuestions };
