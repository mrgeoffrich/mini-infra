# Test Report — PostgreSQL Stack (Create & Remove)

**Date:** 2026-04-10  
**Tester:** Claude Code (automated)  
**Branch:** test-and-fix

## Summary

- Test cases planned: 7
- Test cases completed: 7
- Issues found: 1 (0 blockers, 0 major, 1 minor)
- Status: **PASSED**

## What Was Tested

The new PostgreSQL stack feature, covering the full lifecycle: discovering the template, deploying the stack, verifying the running container, and removing the stack.

## Test Cases

| # | Description | Result |
|---|---|---|
| 1 | Explore postgres stack template | PASS |
| 2 | Postgres stack exists as "Undeployed" in environment with correct plan | PASS |
| 3 | Deploy (Apply All) the postgres stack | PASS |
| 4 | Containers page shows postgres container Running | PASS |
| 5 | Inspect container details | PASS |
| 6 | Uninstall postgres stack | PASS |
| 7 | Verify container removed after destruction | PASS |

## Detailed Findings

### Template

The **PostgreSQL Database** stack template (system-provided, v2, environment-scoped) contains:

- 1 service: `postgres` (Stateful, `postgres:17-alpine`)
- 5 parameters: `postgres-user`, `postgres-password`, `postgres-db`, `host-port`, `expose-on-host`
- 1 volume: `postgres_data`

### Deployment

The stack was found in the `local` environment in "Undeployed" state with a plan showing 1 create action. Clicking **Apply All** deployed it in **8.6 seconds** and status changed to **Synced**.

### Container Verification

After deployment, `local-postgres-postgres` appeared in the Containers page under the "local" environment group:

- **Status:** Running
- **Image:** `postgres:17-alpine`
- **IP Address:** 172.17.0.3
- **Port:** 5432/tcp (internal only)
- **Volume:** `postgres_data` → `/var/lib/postgresql/data` (Read/Write)
- **Logs:** PostgreSQL 17.9 initialised successfully, "database system is ready to accept connections"

### Removal

Clicking **Uninstall** showed a confirmation dialog with a clear data-loss warning. After confirming **Destroy Stack**, the stack was removed and notifications confirmed success. The `local-postgres-postgres` container was gone from the Containers page immediately.

## Issues

### [MINOR] 404 errors in console after stack destruction

- **Where:** Environment Details page, postgres stack panel
- **Steps:** Deploy postgres stack → click Uninstall → confirm Destroy Stack → check browser console
- **Expected:** No errors after stack is destroyed
- **Actual:** Two 404 errors for `GET /api/stacks/{id}/plan` — the client attempts to refresh the plan for the deleted stack because the stack panel stays expanded in the UI
- **Impact:** None visible to the user — destruction completes correctly and the stack disappears from the list. Only the background refetch fails silently.
- **Suggestion:** Cancel in-flight plan fetches or collapse the stack panel on successful destruction to avoid stale requests.
