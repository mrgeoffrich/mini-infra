---
name: update-ui-artifacts
description: |
  Scans the entire frontend codebase and reconciles all UI documentation artifacts against the actual source: audits user-docs coverage against every page in the app, checks route registrations, verifies help category structure, and spot-checks component READMEs and guidance docs. Use this when UI docs are known to be stale, after significant feature development, or to do a full reconciliation from scratch. Trigger on: "update UI docs", "sync UI docs", "audit user docs", "update UI artifacts", "full UI doc sync", "which pages are missing help articles", "check all UI docs".
---

## Purpose

Do a full reconciliation of all UI documentation artifacts against the actual source code. This is a whole-codebase scan — it doesn't rely on git diff. It finds gaps that accumulated over time, not just what changed in the current branch.

## Artifacts to reconcile

1. **`client/src/user-docs/`** — help articles; audit coverage against every user-visible page
2. **`client/src/lib/routes.tsx`** — route registry; verify all registered routes have real page files and vice versa
3. **`client/src/user-docs-structure/user-docs-structure.md`** — the source of truth for planned doc structure; verify it reflects the actual `user-docs/` content and all current routes
4. **`client/src/user-docs-structure/extra-docs-defined.md`** — supplemental article definitions; verify planned articles are accounted for in `user-docs-structure.md`
5. **`claude-guidance/page-layout-design-guide.md`** — spot-check example pages still exist and are accurate
6. **`client/src/components/*/README.md`** — spot-check for components that have grown significantly but lack docs

---

## Phase 1: Audit user-docs coverage

This is the main task. The goal is a complete map of every user-visible page in the app and whether it has help article coverage.

### Step 1: Inventory all pages

Walk `client/src/app/` and collect every `page.tsx` file. For each one, note:
- Its route path (infer from directory structure, e.g. `app/api-keys/presets/page.tsx` → `/api-keys/presets`)
- A brief description of what the page does (read the file if needed)
- Whether it's a user-visible feature page or an infrastructure page (like login, error boundaries, redirects) — skip infrastructure pages

Cross-reference with `client/src/lib/routes.tsx` to get the canonical route paths and confirm what's actually reachable.

### Step 2: Inventory all user-docs articles

Walk `client/src/user-docs/` and list every `.md` file. For each, read the frontmatter to extract:
- `title`
- `category`
- `description`
- `tags`

Build a map of: category → list of articles.

### Step 3: Match pages to articles

For each user-visible page from Step 1, determine whether there is a corresponding help article in `user-docs/`. A match doesn't have to be one-to-one — a single article might cover multiple related pages, or a single page might warrant multiple articles.

Use judgment: a simple settings toggle page probably doesn't need its own article; a complex workflow page (like deployments or postgres restore) definitely does.

Produce a coverage table:

```
## User Docs Coverage

| Page | Route | Has Help Article? | Notes |
|------|-------|-------------------|-------|
| API Keys | /api-keys | ✅ api/api-keys.md | |
| Permission Presets | /api-keys/presets | ❌ Missing | Suggest: user-docs/api/permission-presets.md |
| Containers | /containers | ✅ containers/overview.md | |
| ...  | ... | ... | ... |
```

For missing articles, suggest the likely path and category based on the existing structure.

---

## Phase 2: Route registry integrity check

Read `client/src/lib/routes.tsx` fully.

Check both directions:
- **Registered but missing**: Routes that point to a page component file that doesn't exist on disk (broken import)
- **Exists but unregistered**: Page files in `client/src/app/` that aren't referenced in routes.tsx at all (unreachable pages)

Also check for routes where the path has drifted from the directory structure — e.g. a route registered as `/api-keys/presets` but the page is at `app/api-keys/preset/page.tsx`.

---

## Phase 3: Docs structure plan check

Read `client/src/user-docs-structure/user-docs-structure.md`. This is the source of truth for the planned documentation structure — it maps every route to its coverage status and lists all planned articles.

Also read `client/src/user-docs-structure/extra-docs-defined.md` for the supplemental (non-route-linked) articles that are planned.

Compare both against the actual `user-docs/` directory:
- Routes listed in `user-docs-structure.md` as ❌ missing — are these still missing, or have they been created since the doc was generated?
- Articles marked ❌ in `extra-docs-defined.md` — same check
- Directories or articles that exist in `user-docs/` but are not accounted for in either file (orphans)
- Routes in `route-config.ts` that were added after `user-docs-structure.md` was last generated (the structure doc may be stale — re-run `/generate-docs-structure` if significant new routes exist)

Update `user-docs-structure.md` if the coverage status has changed.

---

## Phase 4: Spot-check guidance docs

**`claude-guidance/page-layout-design-guide.md`**: This doc cites specific pages as examples of the standard layout. Read it and verify the example pages it references (e.g. Registry Credentials, Self-Backup, Container Dashboard) still exist and still use the pattern described. Flag any examples that have moved or been removed.

**Component READMEs**: Check `client/src/components/` for subdirectories. For each subdirectory that has a `README.md`, quickly assess whether the component has grown significantly beyond what the README covers. The postgres-server component is a known example. Flag obvious gaps; don't require a README for every component — only complex ones with public APIs warrant them.

---

## Final summary

```
## UI Artifact Reconciliation Summary

### User Docs Coverage
[N] pages audited — [X] have help articles, [Y] are missing coverage
Missing articles: [list with suggested paths]

### Route Registry
[✅ All routes have matching page files / ❌ list any broken or orphaned entries]

### Docs Structure Plan (user-docs-structure.md)
[List gaps between the plan and actual user-docs/ content, stale coverage statuses, or ✅ Aligned]

### Guidance Docs
[List any stale examples or component README gaps, or ✅ No issues found]
```
