# Upgrade Cleanup Shortcuts

Shortcuts taken during the `no-explicit-any` cleanup. Each is a candidate
for a future follow-up PR.

---

## 1. HAProxy state-machine action types ✅ Resolved

Resolved in `chore/type-cleanup`. Each action class now has a per-action
emit type (e.g. `ContainerStartupEmit`, `LBConfigEmit`) exported from
`actions/types.ts`. `ActionEvent` is now a proper discriminated union of
all emit types instead of `any`. The two blue-green machines had their
`CONTAINERS_RUNNING.containerPort` widened from `number` to `number | undefined`
to match what `MonitorContainerStartup` actually emits.

- `ActionContext` identifier fields (`deploymentId`, `applicationName`,
  `environmentId`, `environmentName`, `haproxyContainerId`,
  `haproxyNetworkName`) are typed as required `string`, even though every
  state-machine context initializes them with `""` fallbacks.

  **Why:** Actions use them unguarded (e.g. `ctx.applicationName` passed
  to `.includes()`). State machines set defaults so they're always
  present at runtime.

  **Proper fix:** Validate at state-machine entry and make them
  non-nullable (remove the `|| ""` fallbacks at context init).

## 2. Cloudflare SDK response shape ✅ Resolved

Resolved in `chore/type-cleanup`. `CloudflareApiResponse = any` removed from all
three files. SDK types (`Zone`, `TunnelListResponse`, `RecordResponse`) used directly;
`SdkRecord` intersection type bridges the gap where the SDK omits fields (`zone_id`,
`zone_name`, `locked`, `data`) that the Cloudflare v4 API returns at runtime.
Zone/tunnel fields with type mismatches (optional vs required, `null` vs `undefined`,
enum supersets) are bridged with `?? default` or narrow casts at the mapping boundary.
Tunnel config raw fetch responses cast to `CloudflareTunnelConfig` at the parse site.

## 3. Stack-template-service serializer shape ✅ Resolved

Resolved in `chore/stack-template-serializer-types`. Two Prisma payload types replace `any`:

- `VersionDetailPayload` — `GetPayload<{ include: typeof versionWithDetails }>` — full services + configFiles
- `VersionSummaryPayload` — `GetPayload<{ select: typeof versionSummary }>` — service count + serviceType per service

`SerializableVersion = VersionDetailPayload | VersionSummaryPayload` with a `configFiles in v` type guard. The
`SerializableTemplate` interface covers all template query shapes structurally (optional relations, Prisma enum
types are compatible string unions). JSON columns use `as unknown as` double-assertion. `versionSummary` was
updated to include `resourceOutputs` and `resourceInputs` so both payload types expose those fields.

`StackTemplateVersionInfo` gained `serviceTypes?: StackServiceType[]` — populated for both shapes. The
applications page now reads `serviceTypes?.[0]` instead of the previously incorrect `services?.[0]?.serviceType`
(which was silently returning partial service objects with only `serviceType` set).

## 4. Client task-tracker registry ✅ Resolved

Resolved in `chore/task-tracker-registry-types`. `EventPayload = any` and
`EventData = any` removed. Each registry entry uses `defineTaskTypeConfig<TStarted,
TStep, TCompleted>()` so its normalizers are validated against the actual Socket.IO
event payload shapes. A `RuntimeTaskTypeConfig` interface (documented variance
boundary) is used for polymorphic access in `TaskEventListener` — the `any` payload
params there are intentional and concentrated, not scattered across every normalizer.

Also fixed: `stack:apply:service-result` event type corrected to
`(ServiceApplyResult | ResourceResult) & { … }` — the server emits both types via
`onProgress`; normalizers for `stack-apply`/`stack-update` discriminate via
`'resourceType' in p`. Removed the now-unnecessary `as Array<…>` and
`as OperationStep["status"]` casts throughout.

## 5. HAProxy action bodies ✅ Resolved

Resolved in `chore/haproxy-action-body-types`.

### `add-container-to-lb.ts`

- Replaced the `!containerName && !containerIpAddress` guard + `as string` cast with a
  direct assignment `const serverAddress = context.containerName ?? context.containerIpAddress`
  followed by a single `if (!serverAddress) throw` guard. TypeScript now narrows
  `serverAddress` to `string` from the guard onward — no cast required.

### `configure-frontend.ts`

- `ActionContext.sourceType` narrowed from `string` to `'stack' | 'manual'`. The cast
  `(context.sourceType as 'stack' | 'manual')` is now unnecessary; the line simplifies to
  `context.sourceType ?? 'stack'` and TypeScript infers the correct union type.

### `deploy-application-containers.ts`

- `context.containerName as string` removed — the `??` fallback already handles `undefined`
  and TypeScript correctly infers `string` from the nullish coalescing expression.
- `ActionContext.containerVolumes` changed from `string[]` to `DeploymentVolume[]` (the
  reconciler always passes `[]`; no runtime change). Same update applied to the three state
  machine context interfaces (`InitialDeploymentContext`, `BlueGreenDeploymentContext`,
  `BlueGreenUpdateContext`).
- `ActionContext.containerPorts` protocol narrowed from `string` to `'tcp' | 'udp'`, matching
  the actual values from `StackContainerConfig`. State machine context types updated to match.
- Environment conversion fixed: `map(([k, v]) => \`${k}=${v}\`)` → `map(([name, value]) => ({ name, value }))`,
  producing real `ContainerEnvVar[]` instead of `string[]`.
- With the above three fixes the fallback object literal is directly assignable to `ContainerConfig`
  — the `as unknown as ContainerConfig` cast is gone.

## 5. Middleware `validatedQuery` / `validatedParams` ✅ Resolved

Resolved in `chore/validation-typed-accessor`. The `declare global { namespace Express
{ interface Request { validatedQuery?: unknown; ... } } }` augmentation is removed.

Validated query/params data is now stored on the request under private symbol keys
(`_validatedQuery`, `_validatedParams`) that are not exported. Callers retrieve typed
data via `getValidatedQuery(req, schema)` and `getValidatedParams(req, schema)` —
passing the same schema used at middleware registration lets TypeScript infer
`z.output<TSchema>` without any cast at the call site. The two `as unknown as
SymbolKeyed` double-assertions are contained inside the module and are the only casts
required.

## 6. Connectivity status reads ✅ Resolved

Resolved in `chore/connectivity-status-dto`. `getLatestConnectivityStatus()` now
returns `Promise<ConnectivityStatusRow | null>` instead of `Promise<Record<string,
unknown> | null>`. The `ConnectivityStatusRow` DTO (exported from
`configuration-base.ts`) converts Prisma's mismatched types at the source:

- `BigInt | null` → `number | undefined` for `responseTimeMs`
- `T | null` → `T | undefined` for all other optional fields

All six `getHealthStatus()` callers drop their identical `const row = latestStatus as
{ ... }` cast blocks and use `latestStatus` directly. The `GitHubAppValidationContext`
interface in `github-app-constants.ts` is updated to match.

## 7. Client zod-resolver casts

**Files:** `client/src/components/stack-templates/*`

- `resolver: zodResolver(schema) as Resolver<z.infer<typeof schema>>`
  instead of the previous `as any`.

  **Why:** react-hook-form + zod v4 type mismatch; the `Resolver<>` cast
  is narrower than `any` but still papers over the same upstream issue.

  **Proper fix:** Wait for upstream compatibility, then remove the cast.
