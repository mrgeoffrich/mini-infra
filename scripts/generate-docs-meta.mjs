#!/usr/bin/env node
/**
 * scripts/generate-docs-meta.mjs
 *
 * Scans client/src/user-docs for `*.md` help articles and generates
 * client/src/user-docs/docs-meta.generated.json — a body-free map of
 * "category/slug" → { title, description, tags }.
 *
 * Why this exists: the help sidebar (mounted on every authenticated page) and
 * the header search need each article's frontmatter *title* synchronously, but
 * that frontmatter lives inside the `.md` bodies. Importing the bodies eagerly
 * inlined ~436 KB of markdown into the initial JS bundle for a menu that only
 * needs titles. This manifest carries just the metadata; the bodies are now
 * loaded lazily (see doc-loader.ts), so they no longer bloat the entry chunk.
 *
 * Usage:
 *   node scripts/generate-docs-meta.mjs
 *   pnpm generate:docs-meta
 *
 * Re-run whenever you add, rename, remove, or re-title a help article.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { resolve, join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DOCS_DIR = join(ROOT, "client/src/user-docs");
const OUTPUT_FILE = join(DOCS_DIR, "docs-meta.generated.json");

/** Minimal front-matter parser — kept in sync with doc-loader.ts::parseFrontMatter. */
function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return {};

  const attrs = {};
  const lines = match[1].split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();

    if (rest === "") {
      const items = [];
      while (i + 1 < lines.length && lines[i + 1].match(/^\s+-\s/)) {
        i++;
        items.push(lines[i].replace(/^\s+-\s+/, ""));
      }
      attrs[key] = items.length > 0 ? items : "";
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      attrs[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      attrs[key] = rest;
    }
    i++;
  }
  return attrs;
}

/** Recursively collect every .md file under DOCS_DIR. */
function walkMd(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkMd(full));
    } else if (entry.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const meta = {};
let count = 0;
for (const file of walkMd(DOCS_DIR).sort()) {
  const rel = relative(DOCS_DIR, file).replace(/\.md$/, "");
  const parts = rel.split(/[\\/]/);
  const category = parts[0];
  const slug = parts[parts.length - 1];
  const key = `${category}/${slug}`;

  const attrs = parseFrontMatter(readFileSync(file, "utf8"));
  meta[key] = {
    title: attrs.title ?? slug,
    description: attrs.description ?? "",
    ...(Array.isArray(attrs.tags) && attrs.tags.length > 0 ? { tags: attrs.tags } : {}),
  };
  count++;
}

// Stable key order so the generated file diffs cleanly.
const sorted = Object.fromEntries(Object.keys(meta).sort().map((k) => [k, meta[k]]));
writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2) + "\n");
console.log(`✓ Generated ${relative(ROOT, OUTPUT_FILE)} (${count} articles)`);
