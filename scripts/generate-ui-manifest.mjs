#!/usr/bin/env node
/**
 * scripts/generate-ui-manifest.mjs
 *
 * Scans client/src/ for data-tour attributes and generates
 * client/src/user-docs/ui-elements/manifest.json
 *
 * The manifest is read by the AI assistant at runtime to discover which
 * element IDs are available on each page for highlight_element calls.
 *
 * Usage:
 *   node scripts/generate-ui-manifest.mjs
 *   npm run generate:ui-manifest
 *
 * Re-run whenever you add, rename, or remove a data-tour attribute.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve, relative, join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CLIENT_SRC = join(ROOT, "client/src");
const OUTPUT_DIR = join(ROOT, "client/src/user-docs/ui-elements");
const OUTPUT_FILE = join(OUTPUT_DIR, "manifest.json");
const ROUTES_FILE = join(ROOT, "client/src/lib/routes.tsx");
const ROUTE_CONFIG_FILE = join(ROOT, "client/src/lib/route-config.ts");

// Files that reference data-tour as a query string (not as markers to catalogue)
const SKIP_PATTERNS = ["agent-spotlight-overlay"];

// ── File walker ──────────────────────────────────────────────────────────────

function walk(dir, exts) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full, exts));
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

// ── Build folder → route path mapping from routes.tsx ───────────────────────
//
// Strategy:
//   1. Parse static imports to get: componentName → app-relative file path
//   2. Parse route definitions to get: routePath → componentName
//   3. Join: derive folder from file path, map folder → routePath
//
// This handles non-obvious mappings like:
//   client/src/app/connectivity/docker/ → /connectivity-docker
//   client/src/app/settings/system/     → /settings-system

function buildFolderRouteMap() {
  const content = readFileSync(ROUTES_FILE, "utf-8");

  // Step 1 — imports: "ComponentName" → "subfolder/of/app/file"
  const importMap = new Map();
  const importRe =
    /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+"@\/app\/([^"]+)"/g;
  let m;
  while ((m = importRe.exec(content)) !== null) {
    const named = m[1];
    const def = m[2];
    const filePath = m[3]; // e.g. "connectivity/docker/page"
    if (def) importMap.set(def, filePath);
    if (named) {
      for (const name of named
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        importMap.set(name, filePath);
      }
    }
  }

  // Step 2 — route definitions: path → component name
  // Matches simple child routes: path: "foo",\n  element: <ComponentName
  // Does not match wrapped routes (Suspense, Navigate) — intentional.
  const routeRe = /path:\s*"([^"*:]+)",\s*\n\s*element:\s*<(\w+)/g;
  const folderRouteMap = new Map();

  while ((m = routeRe.exec(content)) !== null) {
    const routePath = "/" + m[1];
    const componentName = m[2];
    const filePath = importMap.get(componentName);
    if (!filePath) continue; // Navigate, unknown component, etc.

    // Folder = directory portion of the import path
    const folder = filePath.includes("/")
      ? filePath.slice(0, filePath.lastIndexOf("/"))
      : filePath;
    // e.g. "connectivity/docker"

    if (!folderRouteMap.has(folder)) {
      folderRouteMap.set(folder, routePath);
    }

    // Also register the top-level segment as a coarser fallback so that
    // non-page files in the same subtree (e.g. ContainerDashboard.tsx) match.
    const topSegment = folder.split("/")[0];
    if (!folderRouteMap.has(topSegment)) {
      folderRouteMap.set(topSegment, routePath);
    }
  }

  return folderRouteMap;
}

// ── Parse route-config.ts for human-readable route titles ───────────────────

function parseRouteTitles() {
  const content = readFileSync(ROUTE_CONFIG_FILE, "utf-8");
  const titles = {};
  const re = /"(\/[^"]+)":\s*\{[^}]*?title:\s*"([^"]+)"/gs;
  let m;
  while ((m = re.exec(content)) !== null) {
    titles[m[1]] = m[2];
  }
  return titles;
}

// ── Find which route a source file belongs to ────────────────────────────────

function findRouteForFile(filePath, folderRouteMap) {
  const rel = relative(CLIENT_SRC, filePath);
  const appMatch = rel.match(/^app\/(.*)/);
  if (!appMatch) return null; // components/, hooks/, lib/, etc. → global

  const appRel = appMatch[1]; // e.g. "containers/ContainerDashboard.tsx"
  const parts = appRel.split("/");

  // Try longest folder prefix first (most specific wins)
  for (let len = parts.length - 1; len >= 1; len--) {
    const folder = parts.slice(0, len).join("/");
    if (folderRouteMap.has(folder)) {
      return folderRouteMap.get(folder);
    }
  }
  return null;
}

// ── Extract the JSX tag name that carries the data-tour attribute ─────────────

function extractTagName(content, matchIndex) {
  let i = matchIndex;
  while (i >= 0 && content[i] !== "<") i--;
  if (i < 0) return "element";
  const tagMatch = content.slice(i).match(/^<([A-Za-z][A-Za-z0-9.]*)/);
  return tagMatch ? tagMatch[1] : "element";
}

// ── Derive a readable label from a kebab-case element ID ─────────────────────

function toLabel(id) {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const folderRouteMap = buildFolderRouteMap();
const routeTitles = parseRouteTitles();

const sourceFiles = walk(CLIENT_SRC, [".tsx", ".ts"]).filter(
  (f) => !f.includes("/user-docs/ui-elements/"),
);

const elementsByRoute = {}; // routePath → { title, elements[] }
const globalElements = [];

const DATA_TOUR_RE = /data-tour="([^"]+)"/g;

for (const filePath of sourceFiles) {
  const rel = relative(ROOT, filePath);
  if (SKIP_PATTERNS.some((p) => rel.includes(p))) continue;

  const content = readFileSync(filePath, "utf-8");
  if (!content.includes("data-tour=")) continue; // fast skip

  DATA_TOUR_RE.lastIndex = 0;
  let m;
  while ((m = DATA_TOUR_RE.exec(content)) !== null) {
    const elementId = m[1];
    const route = findRouteForFile(filePath, folderRouteMap);

    const entry = {
      id: elementId,
      label: toLabel(elementId),
      elementType: extractTagName(content, m.index),
      file: rel,
    };

    if (route) {
      if (!elementsByRoute[route]) {
        elementsByRoute[route] = {
          title: routeTitles[route] ?? route,
          elements: [],
        };
      }
      // Deduplicate: same ID can appear in multiple files on the same route
      if (!elementsByRoute[route].elements.some((e) => e.id === elementId)) {
        elementsByRoute[route].elements.push(entry);
      }
    } else {
      if (!globalElements.some((e) => e.id === elementId)) {
        globalElements.push(entry);
      }
    }
  }
}

// ── Write manifest ────────────────────────────────────────────────────────────

const totalElements =
  Object.values(elementsByRoute).reduce((n, r) => n + r.elements.length, 0) +
  globalElements.length;

const manifest = {
  generated: new Date().toISOString().slice(0, 10),
  description:
    'UI element IDs (data-tour attributes) available for agent highlighting. ' +
    'Pass "id" to highlight_element and the route key to navigate_to. ' +
    '"global" elements are present on all pages.',
  routes: elementsByRoute,
  global: globalElements,
};

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2) + "\n");

const routeCount = Object.keys(elementsByRoute).length;
console.log(`✓ Generated ${relative(ROOT, OUTPUT_FILE)}`);
console.log(
  `  ${routeCount} route(s), ${globalElements.length} global element(s), ${totalElements} total`,
);
