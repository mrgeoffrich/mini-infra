import fm from "front-matter";
import docsStructure from "../user-docs/docs-structure.yaml";

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
}

export interface SectionDef {
  slug: string;
  label: string;
  description: string;
  articles: string[];
}

export interface DocsStructure {
  sections: SectionDef[];
}

const structure = docsStructure as DocsStructure;

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

    const { attributes, body } = fm<DocFrontmatter>(raw);

    map.set(`${category}/${slug}`, {
      slug,
      category,
      frontmatter: attributes,
      content: body.trim(),
      href: `/help/${category}/${slug}`,
    });
  }
  return map;
}

const rawMap = buildRawMap();

function buildRegistry(): DocEntry[] {
  const entries: DocEntry[] = [];

  for (const section of structure.sections) {
    for (const articleSlug of section.articles) {
      const key = `${section.slug}/${articleSlug}`;
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
      .map((articleSlug) => rawMap.get(`${section.slug}/${articleSlug}`))
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
export { structure as docsStructure };
