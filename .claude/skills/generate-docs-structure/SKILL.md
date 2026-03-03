---
name: generate-docs-structure
description: |
  Generates a user-docs structure plan by cross-referencing all app routes against existing help articles. Produces a markdown document that maps every route to its current doc coverage, flags gaps, and proposes a complete target structure. Use this before writing new user docs to get a clear picture of what exists and what's missing. Trigger on: "generate docs structure", "plan user docs", "doc coverage map", "what docs are missing", "create docs plan", "map routes to docs", "doc structure plan".
---

## Purpose

Produce a `client/src/user-docs-structure/user-docs-structure.md` file that gives a complete, current picture of:
- Every user-visible route in the app
- Which routes already have help articles
- Which routes are missing coverage
- All extra (non-route) articles defined in `extra-docs-defined.md` and their coverage status
- A proposed target structure for any missing articles

This document becomes the source of truth for planning doc writing sessions. It is generated fresh each time this skill runs — don't worry about the previous version.

---

## Phase 1: Inventory routes

Read `client/src/lib/route-config.ts` fully. This is the canonical route registry. Extract:
- Every route entry's **path**, **title**, and **`helpDoc`** field (if present)
- The navigation **section** it belongs to (e.g. Applications, Databases, Networking, Administration)
- Whether the route is a detail/sub-page (has a dynamic segment like `:id`) vs a primary list/overview page

Also read `client/src/lib/routes.tsx` to confirm the complete set of registered routes and catch any that route-config.ts might not have metadata for.

Skip infrastructure routes: `/login`, `/help`, `/help/:category/:slug`, `/design/icons`, and the catch-all redirect.

---

## Phase 2: Inventory existing docs

Walk `client/src/user-docs/` and for each `.md` file, read its frontmatter to extract:
- `title`
- `category`
- `description`
- `order`

Build a map of: **directory → list of files with their titles**.

Also read `client/src/user-docs-structure/extra-docs-defined.md`. Parse each entry to extract:
- The **file path** (from the `## path/to/file.md` heading)
- The **title** (from the `**Title**:` field)
- The **category** (from the `**Category**:` field)
- The **content to cover** bullet list

Build a list of extra-defined articles. For each, check whether its file already exists in `client/src/user-docs/`. Mark as ✅ exists or ❌ not yet created.

---

## Phase 3: Cross-reference

For each user-visible route from Phase 1:

1. **If `helpDoc` is set**: check whether the referenced file actually exists in `client/src/user-docs/`. Mark as ✅ covered or ❌ broken link.
2. **If `helpDoc` is not set**: determine whether an existing doc plausibly covers this route (match by topic/category). Mark as ✅ covered (with the doc path), ⚠️ partial (related doc exists but route isn't directly referenced), or ❌ missing.

For detail pages (`:id` routes), use judgment: a detail page for the same feature as its list page can share a doc — don't require a separate article unless the detail page has substantially different functionality.

---

## Phase 4: Write the structure document

Write a file to `client/src/user-docs-structure/user-docs-structure.md` with the following structure:

```markdown
# User Docs Structure

Generated: [today's date]

## Coverage Summary

- Total user-visible routes: N
- Routes fully covered: N ✅
- Routes partially covered / inferred: N ⚠️
- Routes missing coverage: N ❌
- Extra defined articles (from extra-docs-defined.md): N total, N ✅ exist, N ❌ not yet created

---

## Route Coverage by Section

### [Section Name] (e.g. Applications)

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/containers` | Containers | ✅ | `containers/viewing-containers.md` |
| `/containers/:id` | Container Detail | ✅ | `containers/managing-containers.md` |
| `/deployments` | Deployments | ✅ | `deployments/deployment-overview.md` |
| `/deployments/new` | New Deployment | ❌ | — |

[Repeat for each section]

---

## Extra Docs Coverage

These articles are defined in `extra-docs-defined.md` and supplement the route-driven docs. They are not directly linked from a route `helpDoc` field.

| File | Title | Category | Status |
|------|-------|----------|--------|
| `getting-started/navigating-the-dashboard.md` | Navigating the Dashboard | getting-started | ✅ |
| `containers/troubleshooting.md` | Container Troubleshooting | containers | ❌ |

[List all entries from extra-docs-defined.md with their status]

---

## Existing Docs Inventory

### [Category Directory Name]

| File | Title | Description |
|------|-------|-------------|
| `viewing-containers.md` | Viewing Containers | How to read the container list... |

[Repeat for each directory]

---

## Proposed New Articles

For each ❌ missing route, propose the article to create:

| Route | Suggested File | Suggested Title | Suggested Category |
|-------|---------------|-----------------|-------------------|
| `/deployments/new` | `deployments/creating-a-deployment.md` | Creating a Deployment | Deployments |

---

## Extra Docs Still To Create

Extra articles defined in `extra-docs-defined.md` that do not yet exist in `client/src/user-docs/`:

| File | Title | Category |
|------|-------|----------|
| `containers/troubleshooting.md` | Container Troubleshooting | containers |

---

## Orphaned Docs

Docs that exist in `user-docs/` but are not referenced by any route in route-config.ts AND are not listed in extra-docs-defined.md:

| File | Title | Notes |
|------|-------|-------|
```

---

## Notes

- Write the file even if coverage is good — it's useful as a reference for the current state
- Do not modify any files in `client/src/user-docs/` or `client/src/user-docs-structure/extra-docs-defined.md` — this skill is read-only except for writing the structure doc
- If `client/src/user-docs-structure/` doesn't exist, create it
- A doc is only "orphaned" if it is not referenced by any route helpDoc AND is not listed in `extra-docs-defined.md` — extra-defined articles are intentional even without a route link
- The "Proposed New Articles" and "Extra Docs Still To Create" sections together are the primary input for a follow-up doc-writing session using the `write-user-docs` skill
