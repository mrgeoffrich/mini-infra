---
name: ui-change-check
description: |
  Checks whether key UI documentation artifacts are in sync with your current branch changes before opening a PR. Analyzes git diff vs main to identify missing or stale user-facing help articles, route registrations, component docs, and help structure definitions. Use this whenever you've added a new page, changed a user-visible feature, modified navigation, or any time you want a "what UI docs did I forget to update?" sweep. Trigger on: "ui change check", "check UI docs", "did I update the user docs", "pre-PR UI check", "are my help articles up to date", "UI artifact check", "check help docs".
---

## Purpose

Scan what changed on this branch versus `main` and produce an actionable checklist of UI documentation artifacts that may need updating before the PR is opened.

## Artifacts tracked

| Artifact | Path | Update when... |
|---|---|---|
| User help articles | `client/src/user-docs/` | A user-visible feature is added, changed, or removed |
| Docs structure plan | `client/src/user-docs-structure/user-docs-structure.md` | A new route is added, removed, or renamed; or a new help category is needed |
| Extra docs definitions | `client/src/user-docs-structure/extra-docs-defined.md` | A new supplemental article (troubleshooting, reference, etc.) needs to be planned |
| Route registry | `client/src/lib/routes.tsx` | A new page is added or a page is removed/renamed |
| Component README | `client/src/components/[name]/README.md` | A complex component's public API or behavior changes significantly |
| Layout design guide | `claude-guidance/page-layout-design-guide.md` | A new layout pattern is established that other pages should follow |

## Workflow

### Step 1: Get the diff

```bash
git diff main...HEAD --name-only
git diff main...HEAD --stat
```

### Step 2: Categorize the changed files

Map changed files to the artifacts they affect:

| If these files changed... | Check these artifacts |
|---|---|
| `client/src/app/**/*.tsx` (new page file added) | `client/src/lib/routes.tsx` for registration |
| `client/src/app/**/*.tsx` (page feature changed) | `client/src/user-docs/` for a matching help article |
| `client/src/app/**/*.tsx` (page removed) | `client/src/lib/routes.tsx` and `client/src/user-docs/` for orphaned content |
| `client/src/lib/routes.tsx` | Are the help articles in `user-docs/` still aligned with the current route structure? |
| `client/src/components/**/*.tsx` (significant behavior change) | Component-level README if one exists for that component |
| `client/src/hooks/**/*.ts` (new hook for a major feature) | Check if the feature has user docs coverage |
| New category or section visible in the UI | `client/src/user-docs-structure/user-docs-structure.md` may need a new route entry; `extra-docs-defined.md` if a new supplemental article is planned |

If no files in `client/src/app/` or `client/src/components/` changed, say so and skip the relevant checks.

### Step 3: Targeted checks for each flagged artifact

**User help articles check**

This is the most important check. Read the changed page files to understand what user-visible feature was added or changed. Then look in `client/src/user-docs/` for a corresponding article.

Read `client/src/user-docs-structure/user-docs-structure.md` to understand the current category structure, which routes are already covered, and what articles are planned. This file is the source of truth — do not rely on a hardcoded category list. Also read `client/src/user-docs-structure/extra-docs-defined.md` to see which supplemental (non-route-linked) articles are planned.

Each article uses YAML frontmatter:
```yaml
---
title: Article Title
description: Brief description
category: Category Name
order: 1
tags:
  - tag1
---
```

Flag:
- New user-facing features with no help article
- Existing articles that describe a feature that has since changed (check article content against the updated page code)
- Articles for features that were removed

**Route registry check**

If a new page was added in `client/src/app/`, read `client/src/lib/routes.tsx` and verify the page is registered. If it's missing, the page is unreachable — this is a bug, not just a docs gap.

If a page was removed or its path changed, check for stale route entries.

**Help category structure check**

Read `client/src/user-docs-structure/user-docs-structure.md`. If the UI change introduces a route or feature area not listed there, flag it — the structure doc needs a new entry and the route's `helpDoc` field in `route-config.ts` should be set. If a new supplemental article (troubleshooting guide, reference doc) is warranted, flag it as a candidate for `extra-docs-defined.md`.

**Component README check**

Check if a README exists for the changed component (e.g. `client/src/components/postgres-server/README.md`). If it does and the component's public API or key behavior changed, flag it for review.

**Layout design guide check**

If the change introduces a new layout pattern that differs meaningfully from what's in `claude-guidance/page-layout-design-guide.md`, flag it — either the new page should follow the existing pattern, or the guide should be updated.

### Step 4: Report

```
## Pre-PR UI Artifact Check

### ✅ Up to date
- [artifact]: reason it's fine

### ⚠️ Needs review (possibly affected, verify manually)
- [artifact]: specific thing to check

### ❌ Needs update (definitely stale)
- user-docs: "No help article found for the new Permission Presets feature (client/src/app/api-keys/presets/). Consider adding client/src/user-docs/api/permission-presets.md"
- routes.tsx: "Page at client/src/app/api-keys/presets/page.tsx has no entry in routes.tsx"
```

Be specific about what's missing. "User docs may need updating" is not useful; say which feature lacks coverage and suggest the likely article path and category.

End with a one-line summary: "X artifacts need updates, Y need review, Z are up to date."
