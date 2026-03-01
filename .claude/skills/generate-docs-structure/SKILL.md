---
name: generate-docs-structure
description: |
  Generates a user-docs structure plan by cross-referencing all app routes against existing help articles. Produces a markdown document that maps every route to its current doc coverage, flags gaps, and proposes a complete target structure. Use this before writing new user docs to get a clear picture of what exists and what's missing. Trigger on: "generate docs structure", "plan user docs", "doc coverage map", "what docs are missing", "create docs plan", "map routes to docs", "doc structure plan".
---

## Purpose

Produce a `docs/user-docs-structure.md` file that gives a complete, current picture of:
- Every user-visible route in the app
- Which routes already have help articles
- Which routes are missing coverage
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
- Fully covered: N ✅
- Partially covered / inferred: N ⚠️
- Missing coverage: N ❌

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

## Orphaned Docs

Docs that exist in `user-docs/` but are not referenced by any route in route-config.ts:

| File | Title | Notes |
|------|-------|-------|
```

---

## Notes

- Write the file even if coverage is good — it's useful as a reference for the current state
- Do not modify any files in `client/src/user-docs/` — this skill is read-only except for writing the structure doc
- If `docs/` directory doesn't exist, create it
- The "Proposed New Articles" section is the primary input for a follow-up doc-writing session using the `write-user-docs` skill
