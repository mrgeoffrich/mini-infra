import docsStructure from "../user-docs/docs-structure.yaml";
import docsQuestions from "../user-docs/docs-questions.yaml";

/** Minimal front-matter parser — replaces the `front-matter` npm package. */
function parseFrontMatter<T>(raw: string): { attributes: T; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { attributes: {} as T, body: raw };

  const attrs: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx === -1) { i++; continue; }
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();

    if (rest === "") {
      // Could be a YAML block list — collect "  - value" lines
      const items: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].match(/^\s+-\s/)) {
        i++;
        items.push(lines[i].replace(/^\s+-\s+/, ""));
      }
      attrs[key] = items.length > 0 ? items : "";
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      attrs[key] = rest.slice(1, -1).split(",").map((s) => s.trim());
    } else {
      attrs[key] = rest;
    }
    i++;
  }
  return { attributes: attrs as T, body: match[2] };
}

export interface DocFrontmatter {
  title: string;
  description: string;
  tags?: string[];
}

export interface DocEntry {
  slug: string;
  category: string;
  frontmatter: DocFrontmatter;
  content: string;
  href: string;
  /** Topics this article covers — from docs-structure.yaml */
  topics: string[];
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

const rawFiles = import.meta.glob("../user-docs/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Map from "category/slug" to parsed doc entry */
function buildRawMap(): Map<string, DocEntry> {
  const map = new Map<string, DocEntry>();
  for (const [filePath, raw] of Object.entries(rawFiles)) {
    const parts = filePath
      .replace("../user-docs/", "")
      .replace(/\.md$/, "")
      .split("/");
    const category = parts[0];
    const slug = parts[parts.length - 1];
    const key = `${category}/${slug}`;

    const { attributes, body } = parseFrontMatter<DocFrontmatter>(raw);

    map.set(key, {
      slug,
      category,
      frontmatter: attributes,
      content: body.trim(),
      href: `/help/${category}/${slug}`,
      topics: topicsMap.get(key) ?? [],
    });
  }
  return map;
}

const rawMap = buildRawMap();

function buildRegistry(): DocEntry[] {
  const entries: DocEntry[] = [];

  for (const section of structure.sections) {
    for (const article of section.articles) {
      const key = `${section.slug}/${article.slug}`;
      const doc = rawMap.get(key);
      if (doc) {
        entries.push(doc);
      }
    }
  }

  // Include any docs that exist on disk but aren't in the YAML yet (append at end)
  for (const [, doc] of rawMap) {
    if (!entries.includes(doc)) {
      entries.push(doc);
    }
  }

  return entries;
}

export const docRegistry: DocEntry[] = buildRegistry();

export function getDocBySlug(
  category: string,
  slug: string
): DocEntry | undefined {
  return docRegistry.find(
    (d) => d.category === category && d.slug === slug
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
      .map((article) => rawMap.get(`${section.slug}/${article.slug}`))
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
