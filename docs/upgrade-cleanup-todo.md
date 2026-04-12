# Post-Upgrade Cleanup TODO

Consolidated TODO for finishing the cleanup work from the major dependency upgrade chain:
`chore/major-dependency-upgrades` (merged) → `chore/no-explicit-any-cleanup` (this branch).

Supersedes `major-upgrade-plan.md`, `upgrade-shortcuts.md`, and `no-explicit-any-remaining.md`.

---

## ✅ Done

- **Major dependency upgrades**: ESLint 10, globals 17, cloudflare SDK 5, Recharts 3, pino 10, eslint-plugin-react-hooks 7, cuid2 3, @types/dockerode 4, plus all transitive patch/minor bumps.
- **All upgrade shortcuts resolved**: preserve-caught-error (69), no-unused-vars (~145), no-useless-assignment (9), no-empty-object-type (3), react-hooks rules-of-hooks, no-extra-boolean-cast, no-control-regex, no-require-imports, no-namespace, no-useless-escape, no-empty — plus assorted small-file fixes.
- **react-hooks v7 new rules resolved**: all 31 violations across 22 files (set-state-in-effect, purity, preserve-manual-memoization, immutability, refs). Effects restructured, lazy useState / dialog-gate / useSyncExternalStore / useEffectEvent patterns applied.
- **`no-explicit-any` cleaned up**: from 867 total warnings down to **234 remaining (~73% cleaned)**. Mechanical patterns done, most service/route files typed with proper Prisma / SDK / shared types.

## 🟡 Deferred → Future PRs

### 1. Cloudflare SDK response shapes (~25 warnings)

**Files:** `server/src/services/cloudflare/cloudflare-service.ts`, `cloudflare-dns.ts`, `server/src/routes/cloudflare-settings.ts`

- `Promise.race([apiCall, timeout])` casts to `any` because SDK return types conflict with narrow extraction.
- `config: any`, `Promise<any>` helpers proxying to Tunnel/Zones APIs.
- DNS record type union mismatch: `type: params.type as any`.

**Approach:** build a thin adapter layer over cloudflare SDK that exposes `mini-infra`-shaped responses. One file, one PR.

### 2. HAProxy state-machine action executors (~25 warnings)

**Files:** `server/src/services/haproxy/actions/*.ts` (remove-frontend, remove-dns, remove-container-from-lb, stop-application, remove-application, validate-traffic)

All have `async execute(context: any, sendEvent: (event: any) => void)`. Context is an XState context defined per-machine; actions are used across multiple machines.

**Approach:** define shared `ActionContext` / `ActionEvent` base interfaces in `actions/`. Each state-machine context extends `ActionContext`. Action classes stay concrete on the shared base.

### 3. Task-tracker registry generics (~10 client warnings)

**Files:** `client/src/lib/task-type-registry.ts`, `client/src/components/task-tracker/task-tracker-provider.tsx`

Registry entries use `payload: any` because each task type reads different fields. `TaskTypeConfig<TStarted, TStep, TCompleted>` preserves per-entry inference but the `Record<TaskType, TaskTypeConfig>` map erases generics.

**Approach:** a discriminated-union pattern (one entry per registered task type with generics preserved), or `defineTaskTypeConfig<...>()` builder + `satisfies` at the map level.

### 4. Stack-reconciler internal methods (~6 warnings)

**File:** `server/src/services/stacks/stack-reconciler.ts`

`applyStateful/applyStatelessWeb/applyAdoptedWeb/applyRemoval` still take `stack: any`. Callers pass stacks from different Prisma queries (varying `template`, `environment`, etc).

**Approach:** define `StackWithReconcilerContext` with all relations optional; narrow inside each method where specific relations are required.

### 5. Stack-template serializer unions (~3 warnings)

**File:** `server/src/services/stacks/stack-template-service.ts`

`serializeTemplate(template: any)` and `serializeVersion(version: any)` are called from multiple sites with different include shapes (`stacks`, `currentVersion`, `draftVersion`, `versions`, `_count`).

**Approach:** define `SerializableTemplate` / `SerializableVersion` with all optional relations; defensive defaults in the serializer.

### 6. Misc Prisma JSON / fetch responses (~50 warnings)

Small counts across ~30 files. Mostly `data.X` reads on `response.json()` results and Prisma JSON fields that need narrowing.

**Approach:** case-by-case, 1–2 line structural casts per file. Good task for a long-running agent.

### 7. Middleware + settings validation (~7 warnings)

**Files:** `server/src/middleware/validation.ts`, `server/src/routes/settings-validation.ts`

- `validatedQuery?: any; validatedParams?: any;` on Request augmentation (downstream consumers need updating first).
- `(timeoutPromise as any).cleanup` mutation pattern.

**Approach:** contained refactor once downstream access sites are updated.

### 8. Client zod-resolver casts (~4 warnings)

**Files:** `client/src/components/stack-templates/*`

`resolver: zodResolver(schema) as any` — react-hook-form ↔ zod v4 type mismatch.

**Approach:** wait for upstream fix, or downgrade one side.

---

## Suggested order

If tackling these, do them roughly in this order (each makes a focused PR):

1. **HAProxy action contexts** (25 warnings, one pattern, one shared interface)
2. **Task-tracker registry** (10 warnings, one file, discriminated union)
3. **Stack-reconciler stack param** (6 warnings, define the union shape)
4. **Stack-template serializers** (3 warnings, define the union shape)
5. **Cloudflare SDK adapter** (25 warnings, one adapter file)
6. **Long-tail misc** (~50 warnings, grind across ~30 files — good for agents)
7. **Settings / middleware** (7 warnings, requires downstream cleanup first)
8. **Client zod resolver casts** (wait for upstream)

---

## Numbers

- Pre-cleanup baseline: 742 server + 125 client = **867 warnings**
- After mechanical pass (first commit batch on this branch): 300 + 85 = 385 (−482, 56% done)
- End of current session: 159 + 75 = **234 (−633, 73% done)**
