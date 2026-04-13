# Post-Upgrade Cleanup TODO

Consolidated TODO for finishing the cleanup work from the major dependency upgrade chain:
`chore/major-dependency-upgrades` (merged) → `chore/no-explicit-any-cleanup` (this branch).

Supersedes `major-upgrade-plan.md`, `upgrade-shortcuts.md`, and `no-explicit-any-remaining.md`.

---

## ✅ Done

- **Major dependency upgrades**: ESLint 10, globals 17, cloudflare SDK 5, Recharts 3, pino 10, eslint-plugin-react-hooks 7, cuid2 3, @types/dockerode 4, plus all transitive patch/minor bumps.
- **All upgrade shortcuts resolved**: preserve-caught-error (69), no-unused-vars (~145), no-useless-assignment (9), no-empty-object-type (3), react-hooks rules-of-hooks, no-extra-boolean-cast, no-control-regex, no-require-imports, no-namespace, no-useless-escape, no-empty — plus assorted small-file fixes.
- **react-hooks v7 new rules resolved**: all 31 violations across 22 files.
- **`no-explicit-any` fully cleaned**: from 867 total warnings down to **0** across both server and client.

## Shortcuts taken (tracked in `docs/shortcuts.md`)

Several files contain localized `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
type aliases where a full refactor would have ballooned the diff:

- `server/src/services/haproxy/actions/types.ts` — shared `ActionEvent` typed as `any` because
  four XState machines have subtly different event unions. Proper fix is a shared supertype
  or per-machine-scoped action callbacks.
- `server/src/services/cloudflare/cloudflare-service.ts`,
  `cloudflare-dns.ts`, `server/src/routes/cloudflare-settings.ts` —
  `CloudflareApiResponse = any` alias for SDK pagination / response shapes.
  Proper fix is a thin adapter layer (see "Cloudflare SDK adapter" below).
- `server/src/services/stacks/stack-template-service.ts` —
  `SerializableTemplate` / `SerializableVersion` aliased to `any` because each caller
  loads a different Prisma `include`/`select` subset. Proper fix is a discriminated
  union per include shape.
- `client/src/lib/task-type-registry.ts`,
  `client/src/components/task-tracker/task-tracker-provider.tsx` —
  `EventPayload = any` for heterogeneous Socket.IO payloads; normalizers narrow locally.
  Proper fix is a discriminated union keyed by task type.

## 🟡 Still Deferred → Future PRs

Non-`no-explicit-any` items that remain open:

### 1. Cloudflare SDK adapter layer

**Files:** `server/src/services/cloudflare/cloudflare-service.ts`, `cloudflare-dns.ts`,
`server/src/routes/cloudflare-settings.ts`

The quick cleanup introduced `CloudflareApiResponse = any`. The proper fix is a thin
adapter over the cloudflare SDK that exposes `mini-infra`-shaped responses and removes
all the Promise.race + `as any` patterns. One file, one PR.

### 2. Stack-template-service serializer shape

**File:** `server/src/services/stacks/stack-template-service.ts`

`serializeTemplate` / `serializeVersion` currently take `any` because every caller passes
a different Prisma include shape. A discriminated union (one variant per include set) or
a single loose shape with runtime validation would let us drop the `any`.

### 3. HAProxy state-machine event unions

**Files:** `server/src/services/haproxy/actions/types.ts`,
`haproxy/blue-green-deployment-state-machine.ts`,
`haproxy/blue-green-update-state-machine.ts`,
`haproxy/initial-deployment-state-machine.ts`,
`haproxy/removal-deployment-state-machine.ts`

Each machine defines its own event union; `ActionEvent` is currently `any` because
different machines require different shapes for the "same" event (e.g.
`CONTAINERS_RUNNING` has required `containerIpAddress` in blue-green but optional in
initial-deployment). Aligning these into a shared supertype would let us make
`ActionEvent` a proper discriminated union.

### 4. Client task-tracker registry

**Files:** `client/src/lib/task-type-registry.ts`,
`client/src/components/task-tracker/task-tracker-provider.tsx`

`EventPayload = any`. A discriminated union (one entry per registered task type with
generics preserved) or `defineTaskTypeConfig<...>()` builder + `satisfies` at the map
level would make each registry entry type-safe.

### 5. Middleware `validatedQuery` / `validatedParams`

**Files:** `server/src/middleware/validation.ts` (already cleaned to `unknown`)

Consumers currently don't read these augmentations, but if they ever do they'll need
explicit casts. A proper refactor would remove the Express module augmentation entirely
and move validated data onto the request via a typed wrapper.

### 6. Client zod-resolver casts

**Files:** `client/src/components/stack-templates/*`

Previously `zodResolver(schema) as any`; now cast to `Resolver<z.infer<typeof schema>>`
as a workaround for the react-hook-form ↔ zod v4 type mismatch. Remove once upstream
provides compatible types.

---

## Numbers

- Pre-cleanup baseline: 742 server + 125 client = **867 warnings**
- After mechanical pass (first commit batch on this branch): 300 + 85 = 385 (−482, 56% done)
- Middle-session snapshot: 159 + 75 = 234 (−633, 73% done)
- **Final: 0 server `no-explicit-any` + 0 client `no-explicit-any`** (all 867 resolved).
  43 client warnings remain, all from unrelated rules (`react-hooks/exhaustive-deps`,
  `react-refresh/only-export-components`) and predate this cleanup.
