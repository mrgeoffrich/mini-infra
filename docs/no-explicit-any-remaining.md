# `@typescript-eslint/no-explicit-any` — Remaining Work

Tracking the remaining `any` warnings after the bulk cleanup in `chore/no-explicit-any-cleanup`.

**Status:** ~234 warnings remain (159 server + 75 client) out of an original ~867 (~73% cleaned up).

The mechanical patterns are all done. What's left needs per-site reasoning — mostly SDK-response shapes, discriminated-union registries, and cases where a serializer must accept several distinct Prisma include shapes.

---

## Remaining categories

### 1. Cloudflare SDK response shapes (~25 warnings)

**Files:** `server/src/services/cloudflare/cloudflare-service.ts`, `cloudflare-dns.ts`, `server/src/routes/cloudflare-settings.ts`

- `Promise.race([apiCall, timeout])` result casts to `any` because the SDK method return types conflict with our narrow extraction shape.
- `config: any`, `Promise<any>` on helpers that proxy to Cloudflare's Tunnel/Zones APIs.
- DNS record type union mismatch: `type: params.type as any` because cloudflare SDK's `RecordCreateParams` union doesn't cleanly align with our `CloudflareDNSRecordType`.

**Fix direction:** build a thin, typed adapter layer over the cloudflare SDK (one file) that exposes `mini-infra`-shaped responses and swallows the type-union juggling. Or upgrade the cloudflare SDK when its types improve.

### 2. Task-tracker registry (~10 client warnings)

**Files:** `client/src/lib/task-type-registry.ts`, `client/src/components/task-tracker/task-tracker-provider.tsx`

Registry entries have `payload: any` because each task type reads different fields. Turning it into a generic `TaskTypeConfig<TStarted, TStep, TCompleted>` creates the right per-entry inference, but the `Record<TaskType, TaskTypeConfig>` map erases per-entry generics back to a union.

**Fix direction:** either
- a discriminated-union pattern (one entry per registered task type, with generics preserved),
- a `defineTaskTypeConfig<T...>()` builder + `satisfies Record<TaskType, TaskTypeConfig>` at the map level,
- or keep `any` with a focused comment (pragmatic — the registry only reads payload fields inside trusted normalizer callbacks).

### 3. Internal stack-reconciler methods (~6 warnings, server)

**File:** `server/src/services/stacks/stack-reconciler.ts`

`applyStateful/applyStatelessWeb/applyAdoptedWeb/applyRemoval` private methods still accept `stack: any`. Callers pass stacks from several different Prisma queries (some with `template`, some without, some with `environment`, some not), which makes the param needs a **union** of the concrete include shapes or a loose base + optional relations. Multiple attempts to express this caused cascading errors across ~100 other lines.

**Fix direction:** define a `StackWithReconcilerContext` type alias with all optional relations, then narrow inside each method where specific relations are required.

### 4. Stack-template serializers (~3 warnings)

**File:** `server/src/services/stacks/stack-template-service.ts`

`serializeTemplate(template: any)` and `serializeVersion(version: any)` are called from >5 call sites with different Prisma include shapes (varying `stacks`, `currentVersion`, `draftVersion`, `versions`, `_count` presence). A precise union is achievable but fiddly.

**Fix direction:** define `SerializableTemplate` / `SerializableVersion` with all optional relations; have each `serialize*` take the widest shape and defensively default.

### 5. HAProxy state-machine action executors (~25 warnings)

**Files:** `server/src/services/haproxy/actions/*.ts` (remove-frontend, remove-dns, remove-container-from-lb, stop-application, remove-application, validate-traffic)

All have `async execute(context: any, sendEvent: (event: any) => void)`. The `context` actually refers to an XState context defined in the calling state machine, and each action is used across several machines, so a common shape would need to be the intersection of all contexts.

**Fix direction:** either
- define a shared `ActionContext` base interface in `actions/` and have each state-machine context extend it,
- genericise each action class by the context type it expects,
- or use `Record<string, unknown>` + narrow at access sites (which is what I tried, but it cascaded into ~20 field-access errors).

### 6. Misc. Prisma JSON-field reads + fetch responses (~50 warnings)

**Files:** various small routes/services

Small counts per file. Most are `data.X` reads on a `response.json()` result (typed `unknown` by default) and Prisma JSON fields that need narrowing to an application type.

**Fix direction:** case-by-case. Usually a 1–2 line structural cast per file.

### 7. Middleware + settings validation (~7 warnings)

**Files:** `server/src/middleware/validation.ts`, `server/src/routes/settings-validation.ts`

- `validatedQuery?: any; validatedParams?: any;` on Express `Request` augmentation: narrowing requires sprinkling non-null assertions at downstream access sites (attempted, reverted).
- `(timeoutPromise as any).cleanup` — mutating a Promise with a custom `.cleanup` property.

**Fix direction:** small, contained refactors once the downstream consumers are updated.

### 8. Client form resolvers (~4 warnings)

**Files:** `client/src/components/stack-templates/*`

`resolver: zodResolver(schema) as any` — workaround for react-hook-form ↔ zod v4 type mismatch. Will resolve when upstream fixes land, or by downgrading one of them.

---

## Suggested next-pass order

1. **HAProxy action contexts** — biggest remaining chunk (25 warnings), one pattern, one shared interface.
2. **Task-tracker registry** — 10 warnings, one file, clean solution via discriminated union.
3. **Stack-reconciler stack param** — 6 warnings, define the union shape.
4. **Stack-template serializers** — 3 warnings, define the union shape.
5. **Cloudflare SDK adapter** — 25 warnings, one adapter file.
6. **Long-tail misc** — ~50 warnings, slow grind across ~30 files.
7. **Settings/middleware** — 7 warnings, needs downstream cleanup first.
8. **Client zod resolver casts** — wait for upstream.

Cumulative history of this branch:
- Pre-branch baseline: 742 server + 125 client = 867
- After mechanical pass: 300 server + 85 client = 385 (−482, 56% done)
- Current: 159 server + 75 client = 234 (−633, 73% done)
