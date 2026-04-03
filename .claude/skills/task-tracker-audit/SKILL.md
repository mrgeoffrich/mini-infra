---
name: task-tracker-audit
description: |
  Audits the task tracker integration for long-running background operations,
  ensuring server-side Socket.IO event emissions have matching client-side task
  type registry entries, correct step definitions, proper query invalidation,
  and consistent registerTask() call sites. Use this skill after adding or
  modifying any long-running operation (stack apply/destroy, certificate
  issuance, deployment, migration, sidecar startup, self-update), after
  changing Socket.IO event shapes or adding new events, or before opening a PR
  that touches stack operations, task tracker components, or progress hooks.
  Trigger on: "audit task tracker", "check task steps", "verify progress
  tracking", "are task events wired up", "check socket event coverage",
  "task tracker audit", "verify long-running operations".
---

## Purpose

Detect mismatches between server-side Socket.IO event emissions and the
client-side task tracking system. Long-running operations follow a
**started -> step -> completed** pattern. Every operation that uses this pattern
needs consistent wiring across four layers:

1. **Server emissions** — `emitToChannel()` calls in route handlers / services
2. **Task type registry** — normalizer entries in `client/src/lib/task-type-registry.ts`
3. **registerTask() call sites** — UI components that kick off tracked operations
4. **Inline progress hooks** — dedicated hooks like `useStackApplyProgress` that also listen to the same events

When these layers drift apart, tasks appear incomplete, never finish, or the UI
doesn't refresh after an operation completes.

## Audit Workflow

### Step 1: Inventory server-side operation patterns

Search for all `emitToChannel` calls that follow the started/step/completed
pattern. Group them by operation:

```bash
# Find all started/step/completed triplets
grep -rn "emitToChannel.*STARTED\|emitToChannel.*STEP\|emitToChannel.*COMPLETED\|emitToChannel.*SERVICE_RESULT" \
  server/src/ --include="*.ts" | grep -v node_modules
```

For each operation, record:
- **Which file** emits the events
- **The three event constants** used (started, step, completed)
- **The channel** used
- **What payload shape** each event sends (read the surrounding code)
- **Whether resource results are emitted** through the same step event (look for
  `'resourceType' in` checks or `ResourceResult` types in the onProgress callback)

Known operation patterns to check:

| Operation | Channel | Started | Step | Completed |
|-----------|---------|---------|------|-----------|
| Stack apply | `Channel.STACKS` | `STACK_APPLY_STARTED` | `STACK_APPLY_SERVICE_RESULT` | `STACK_APPLY_COMPLETED` |
| Stack update | `Channel.STACKS` | `STACK_APPLY_STARTED` | `STACK_APPLY_SERVICE_RESULT` | `STACK_APPLY_COMPLETED` |
| Stack destroy | `Channel.STACKS` | `STACK_DESTROY_STARTED` | *(none)* | `STACK_DESTROY_COMPLETED` |
| HAProxy migration | `Channel.STACKS` | `MIGRATION_STARTED` | `MIGRATION_STEP` | `MIGRATION_COMPLETED` |
| Cert issuance | `Channel.TLS` | `CERT_ISSUANCE_STARTED` | `CERT_ISSUANCE_STEP` | `CERT_ISSUANCE_COMPLETED` |
| Connect container | `Channel.HAPROXY` | `FRONTEND_SETUP_STARTED` | `FRONTEND_SETUP_STEP` | `FRONTEND_SETUP_COMPLETED` |
| Sidecar startup | `Channel.AGENT_SIDECAR` | `SIDECAR_STARTUP_STARTED` | `SIDECAR_STARTUP_STEP` | `SIDECAR_STARTUP_COMPLETED` |
| Self-update launch | `Channel.SELF_UPDATE` | `SELF_UPDATE_LAUNCH_STARTED` | `SELF_UPDATE_LAUNCH_STEP` | `SELF_UPDATE_LAUNCH_COMPLETED` |

If you find new operations not in this table, flag them.

### Step 2: Verify task type registry coverage

Read `client/src/lib/task-type-registry.ts` and for each server operation from
Step 1, verify a matching registry entry exists with:

- [ ] Correct `channel` matching the server channel
- [ ] Correct `startedEvent`, `stepEvent`, `completedEvent` matching the server event constants
- [ ] `getId` extracts the right identifier from the payload
- [ ] `normalizeStarted` extracts `totalSteps` and `plannedStepNames` — and `totalSteps` accounts for **all** action types (services + resources if applicable)
- [ ] `normalizeStep` handles **all result shapes** the server emits through that step event. For stack-apply, this means both `ServiceApplyResult` (has `serviceName`) and `ResourceResult` (has `resourceType`/`resourceName`). Check for `resourceType` detection.
- [ ] `normalizeCompleted` includes **all result arrays** from the completed payload. For stack-apply, this means both `serviceResults` AND `resourceResults`.
- [ ] `invalidateKeys` includes all query keys that should refresh when the operation completes

**Step name consistency check**: The planned step names from `normalizeStarted`
must **exactly match** the step names produced by `normalizeStep`, because
`buildDisplaySteps()` in `task-detail-dialog.tsx` uses exact string matching
(`completedMap.get(name)`) to pair completed steps with planned slots. If they
don't match, steps show as permanently "pending" even after completing.

### Step 3: Check registerTask() call sites

Search for all `registerTask(` calls:

```bash
grep -rn "registerTask(" client/src/ --include="*.tsx" --include="*.ts"
```

For each call site, verify:

- [ ] `type` matches a key in the task type registry
- [ ] `totalSteps` includes resource actions where applicable (check if the plan object has `resourceActions` and whether they're counted)
- [ ] `plannedStepNames` uses the same format string as the registry's `normalizeStarted` and `normalizeStep` (so names match for the step detail dialog)
- [ ] `channel` matches the registry entry's channel

Note: The STARTED socket event **replaces** the initial task state, so
mismatched `totalSteps`/`plannedStepNames` in registerTask only affects the
brief window before the STARTED event arrives. Still worth keeping consistent.

### Step 4: Check inline progress hooks

Some operations have dedicated progress hooks in addition to the global task
tracker. These hooks independently subscribe to the same socket events and
manage their own query invalidation. They must stay in sync.

Search for hooks that subscribe to the same events:

```bash
grep -rn "useSocketEvent.*STACK_APPLY\|useSocketEvent.*STACK_DESTROY\|useSocketEvent.*CERT_ISSUANCE\|useSocketEvent.*MIGRATION\|useSocketEvent.*FRONTEND_SETUP\|useSocketEvent.*SIDECAR_STARTUP\|useSocketEvent.*SELF_UPDATE" \
  client/src/hooks/ --include="*.ts"
```

For each inline progress hook, verify:

- [ ] **Query invalidation on completion matches the registry** — if the task type registry invalidates `["applications"]` and `["userStacks"]`, the inline hook should too
- [ ] **Result types are wide enough** — if the step event carries both `ServiceApplyResult` and `ResourceResult`, the hook's state type and matching logic must handle both (e.g., matching by `resourceType:resourceName` key, not just `serviceName`)
- [ ] **The completed handler's result type** includes resource results (e.g., `ApplyResult` has both `serviceResults` and `resourceResults`)

### Step 5: Check progress component rendering

For operations that have dedicated progress components (like `StackApplyProgress`),
verify:

- [ ] **Live view** renders both service and resource results — check that the matching key handles both shapes
- [ ] **Completed view** renders `resourceResults` alongside `serviceResults`
- [ ] **Duration display** safely handles results that lack `duration` (like `ResourceResult`)

### Step 6: Produce the report

Output a structured report with sections:

```
## Task Tracker Audit Report

### Coverage Summary
- X server operations found
- Y task type registry entries found
- Coverage: X/Y (list any unmatched operations)

### Issues Found

#### Critical (tasks won't track correctly)
- ...

#### Warning (inconsistencies that may confuse users)
- ...

#### Info (minor discrepancies, cosmetic)
- ...

### All Checks Passed
- ...
```

For each issue, include:
- **What**: one-line description
- **Where**: file path and line number
- **Fix**: what needs to change

## Common Pitfalls

These are the mistakes that have caused bugs before — pay extra attention:

1. **Resource actions missing from totalActions** — The STARTED event's `totalActions` must count both service actions AND resource actions. If only services are counted, the task shows "3/3 complete" while resources are still processing, then hangs before the COMPLETED event.

2. **Step name format mismatch** — `normalizeStarted` produces planned names, `normalizeStep` produces completed names. If the format strings differ (e.g., `"create app"` vs `"create tls:my-cert"` for resources), steps never match in the detail dialog.

3. **Missing invalidateKeys** — Stack operations that affect the applications page must invalidate `["applications"]` and `["userStacks"]`. This is easy to forget on new task types or when copying from an existing entry.

4. **Resource results emitted through service result event** — The `STACK_APPLY_SERVICE_RESULT` event carries both `ServiceApplyResult` and `ResourceResult` payloads. Any normalizer or progress hook that assumes `serviceName` exists will break on resource results. Check for `'resourceType' in` guards.

5. **Inline hook / registry invalidation drift** — When you add a query key to the registry's `invalidateKeys`, also add it to any inline progress hooks (`useStackApplyProgress`, `useStackDestroyProgress`, etc.) that independently invalidate queries on the same completed event.
