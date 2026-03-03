---
name: api-change-check
description: |
  Checks whether key project artifacts are in sync with your current branch changes before opening a PR. Analyzes git diff vs main to identify exactly which docs, permission definitions, and registrations may be stale. Use this skill whenever you're about to create a PR, after adding or modifying API routes, adding new permissions, changing the schema, or any time you want a quick "what did I forget to update?" sweep. Trigger on: "pre-PR check", "check my docs", "what needs updating", "are docs up to date", "doc check before PR", "what did I forget", "artifact freshness check".
---

## Purpose

Scan what changed on this branch versus `main` and produce an actionable checklist of artifacts that may need updating before the PR is opened.

## Artifacts tracked

| Artifact | Path | Update when... |
|---|---|---|
| API endpoint reference | `API-ROUTES.md` | Any route file gains/loses/renames an endpoint |
| Permission definitions | `lib/types/permissions.ts` | New permission domain or action is used in routes |
| Route registration | `server/src/app.ts` (lines ~154-203) | A new route file is added |
| Agent guide | `AGENT.md` | Major structural changes to the project |
| Claude Md | `CLAUDE.md` | Major structural changes to the project |

## Workflow

### Step 1: Get the diff

```bash
git diff main...HEAD --name-only
git diff main...HEAD --stat
```

If there's no `main` or the user is on an unusual base, ask which branch to compare against. If the diff is large, also run `git log main...HEAD --oneline` to understand the scope of changes.

### Step 2: Categorize the changed files

Map changed files to the artifacts they affect:

- **Any file in `server/src/routes/`** → check `API-ROUTES.md` for endpoint additions/removals/renames
- **A new file added in `server/src/routes/`** → check `server/src/app.ts` for registration
- **Any file in `server/src/routes/`** → scan for new `requirePermission(...)` calls and check `lib/types/permissions.ts`
- **`lib/types/permissions.ts` itself changed** → verify the `PERMISSION_GROUPS` object, `ALL_PERMISSION_SCOPES`, and presets are still consistent
- **`server/src/app.ts` changed** → note any new route registrations that affect `API-ROUTES.md` sections
- **`lib/types/` files changed** → flag if new shared types were added that aren't used yet, or vice versa

If no route files changed at all, skip the API-ROUTES.md and permissions checks and say so.

### Step 3: Targeted checks for each flagged artifact

**API-ROUTES.md check**

Read the changed route files. For each `router.get/post/put/patch/delete/use(` call, extract:
- The HTTP method
- The path string (first argument)
- The full path = mount prefix (from app.ts) + route path

Cross-reference against `API-ROUTES.md`. Flag:
- Endpoints present in route files but missing from the doc
- Endpoints in the doc that no longer exist in the route files
- Paths or methods that have changed

**Permissions check**

Scan changed route files for `requirePermission("...")` calls. Extract each permission string (e.g. `"containers:read"`, `"api-keys:write"`). Check each against the `PERMISSION_GROUPS` object in `lib/types/permissions.ts`. Flag any that are missing.

Also check: if a brand-new permission domain was added (e.g. `"permission-presets:read"`), verify it appears in:
- `PERMISSION_GROUPS`
- The `PermissionScope` type union
- Relevant permission presets (e.g. `full-access`, `read-only`)

**Route registration check**

If a new route file was added, read `server/src/app.ts` and check whether the file appears in the `routes` array. If absent, it means the endpoints exist in code but are never mounted — this is a bug, not just a docs issue.

**Migration check**

If `schema.prisma` changed, list the migration folders in `server/prisma/migrations/`. If the most recent migration's timestamp predates the schema change (or if there's no new migration at all), flag it.

### Step 4: Report

Produce a checklist with three sections. Be specific — a vague "API-ROUTES.md needs updating" is not useful; say exactly what's missing.

```
## Pre-PR Artifact Check

### ✅ Up to date
- [artifact]: reason it's fine

### ⚠️ Needs review (possibly affected, verify manually)
- [artifact]: specific thing to check

### ❌ Needs update (definitely stale)
- [artifact]: "Missing: POST /api/permission-presets/ endpoint"
- [artifact]: "Permission 'permission-presets:read' used in routes/permission-presets.ts but not in PERMISSION_GROUPS"
```

End with a one-line summary: "X artifacts need updates, Y need review, Z are up to date."
