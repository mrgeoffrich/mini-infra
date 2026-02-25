import fm from "front-matter";

export interface DocFrontmatter {
  title: string;
  description: string;
  category: string;
  order?: number;
  tags?: string[];
}

export interface DocEntry {
  slug: string;
  category: string;
  frontmatter: DocFrontmatter;
  content: string;
  href: string;
}

const rawFiles = import.meta.glob("../user-docs/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function buildRegistry(): DocEntry[] {
  return Object.entries(rawFiles)
    .map(([filePath, raw]) => {
      const parts = filePath
        .replace("../user-docs/", "")
        .replace(/\.md$/, "")
        .split("/");
      const category = parts[0];
      const slug = parts[parts.length - 1];

      const { attributes, body } = fm<DocFrontmatter>(raw);
      const frontmatter = attributes;

      return {
        slug,
        category,
        frontmatter,
        content: body.trim(),
        href: `/help/${category}/${slug}`,
      };
    })
    .sort((a, b) => (a.frontmatter.order ?? 99) - (b.frontmatter.order ?? 99));
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
  docs: DocEntry[];
}

export function getDocsByCategory(): DocCategory[] {
  const map = new Map<string, DocEntry[]>();
  for (const doc of docRegistry) {
    const existing = map.get(doc.category) ?? [];
    existing.push(doc);
    map.set(doc.category, existing);
  }
  return Array.from(map.entries()).map(([slug, docs]) => ({
    slug,
    label: docs[0]?.frontmatter.category ?? slug,
    docs,
  }));
}
