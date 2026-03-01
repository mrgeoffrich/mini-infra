---
name: update-api-artifacts
description: |
  Scans the entire repository and updates all documentation artifacts to match the actual source code: rebuilds API-ROUTES.md from route files, audits lib/types/permissions.ts for gaps, and spot-checks AGENT.md for stale references. Use this skill when docs are known to be out of date, after a big feature push, or to do a full reconciliation from scratch. Trigger on: "update docs", "sync docs", "regenerate API routes", "update all artifacts", "docs are stale", "refresh documentation", "full doc sync", "rebuild API-ROUTES".
---

## Purpose

Do a full reconciliation of all project documentation artifacts against the actual source code. This is a deeper operation than `docs-check` — it reads every route file and produces updated artifacts.

## Artifacts to update

1. **`API-ROUTES.md`** (root of repo) — full rebuild from route files
2. **`lib/types/permissions.ts`** — audit only; flag gaps but do not auto-rewrite (access control requires human review)
3. **`AGENT.md`** (root of repo) — spot-check for stale references; flag but do not rewrite narrative sections
4. **`CLAUDE.md`** (root of repo) — spot-check for stale references; flag but do not rewrite narrative sections

---

## Phase 1: Rebuild API-ROUTES.md

This is the main task. Read every registered route file and reconstruct the document from scratch.

### Step 1: Get the route registry

Read `server/src/app.ts` lines ~154-203. This contains the `routes` array with every mounted route:

```typescript
{ path: "/api/keys", router: apiKeyRoutes, name: "apiKeyRoutes" },
```

The `path` value is the mount prefix. Note: some routes (e.g. agent routes) are conditionally registered — include them with a note like `(requires ANTHROPIC_API_KEY)`.

Also note the nested postgres-server routes — their actual full paths look like `/api/postgres-server/servers/:serverId/databases/:dbId/...`.

### Step 2: Extract endpoints from each route file

For each route file in `server/src/routes/` (and `server/src/routes/postgres-server/`):

Read the file and find all route handler registrations:
- `router.get('/path', ...)`
- `router.post('/path', ...)`
- `router.put('/path', ...)`
- `router.patch('/path', ...)`
- `router.delete('/path', ...)`

The full endpoint path = mount prefix + route path. For example, if mount is `/api/keys` and route is `/:keyId/rotate`, the full path is `/api/keys/:keyId/rotate`.

For the description, use:
1. Any JSDoc comment immediately above the handler
2. The handler function name if it's descriptive
3. The route path and method to infer a sensible description

Work through all route files systematically. There are ~40 route files — don't skip any. The postgres-server subdirectory has 6 more files.

### Step 3: Organize by section

Group endpoints into sections matching the existing `API-ROUTES.md` structure. Keep sections in the same order for a minimal diff. Use this section order as a guide:

1. System
2. Auth (`/auth`)
3. API Keys (`/api/keys`)
4. Containers (`/api/containers`)
5. Docker (`/api/docker`)
6. Settings (`/api/settings`) — including subsections for System, Azure, Cloudflare, GitHub, Self-Backup
7. Connectivity
8. PostgreSQL Databases, Backup Configs, Backups, Restore, Progress
9. PostgreSQL Servers (including nested Databases, Tables, Users, Grants, Workflows)
10. Deployments, Deployment DNS, Deployment Infrastructure
11. HAProxy Frontends, HAProxy Backends, Manual HAProxy Frontends
12. Environments
13. TLS Settings, TLS Certificates, TLS Renewals
14. Registry Credentials
15. Events
16. User Preferences
17. Agent (conditional)
18. Permission Presets (if registered)

### Step 4: Write API-ROUTES.md

Use this exact table format for each section:

```markdown
## Section Name (`/api/prefix`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/prefix/endpoint` | What it does |
| POST | `/api/prefix/endpoint` | What it does |
```

For nested resources, use the `...` shorthand for the repeated prefix (see existing file for style).

Write the complete new `API-ROUTES.md` and report a summary of changes vs the previous version (sections added, endpoints added/removed).

---

## Phase 2: Audit permissions.ts

Read `lib/types/permissions.ts`. The key structure is `PERMISSION_GROUPS` — an object where each key is a `PermissionScope` string like `"containers:read"`.

Scan **all** route files for `requirePermission("...")` calls and collect every permission string used in the codebase.

Compare against the keys in `PERMISSION_GROUPS`. Report:

```
## Permissions Audit

### Used in routes but missing from PERMISSION_GROUPS:
- "permission-presets:read" (used in routes/permission-presets.ts)
- ...

### Defined in PERMISSION_GROUPS but not used in any route:
- (these may be intentional — note them but don't flag as errors)

### Consistency checks:
- Is every key in PERMISSION_GROUPS also in the PermissionScope type union?
- Does READ_ONLY_SCOPES include all :read permissions?
- Do the presets (full-access, read-only, ai-agent, etc.) cover new domains?
```

**Do not modify permissions.ts** — access control definitions require human review. Produce the gap report and let the developer decide.

---

## Phase 3: Spot-check AGENT.md

Read `AGENT.md` and flag any stale references. Look for:

- Specific file paths mentioned that may have moved (e.g., `server/src/services/backup-executor.ts`)
- Framework/library versions that are significantly out of date vs `package.json`
- Example API endpoints that no longer exist (check against the just-rebuilt `API-ROUTES.md`)
- Port numbers (backend: 5000, frontend: 3005 — these rarely change)
- References to testing frameworks (should be Vitest now, not Jest)

Do not rewrite narrative sections — AGENT.md has context and intent that needs human judgment. Just flag specific lines that look wrong.

## Phase 4: Spot-check CLAUDE.md

Read `CLAUDE.md` and flag any stale references. Look for:

- Specific file paths mentioned that may have moved (e.g., `server/src/services/backup-executor.ts`)
- Framework/library versions that are significantly out of date vs `package.json`
- Example API endpoints that no longer exist (check against the just-rebuilt `API-ROUTES.md`)
- Port numbers (backend: 5000, frontend: 3005 — these rarely change)
- References to testing frameworks (should be Vitest now, not Jest)

Do not rewrite narrative sections — CLAUDE.md has context and intent that needs human judgment. Just flag specific lines that look wrong.

---

## Final summary

```
## Artifact Update Summary

### API-ROUTES.md
✅ Rebuilt — [N] endpoints across [M] sections
Changes vs previous: [list major additions/removals]

### lib/types/permissions.ts
[List missing entries, or "✅ All permissions accounted for"]

### AGENT.md
[List stale references with line numbers, or "✅ No stale references detected"]

### CLAUDE.md
[List stale references with line numbers, or "✅ No stale references detected"]
```
