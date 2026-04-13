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

## 4. Client task-tracker registry

**Files:** `client/src/lib/task-type-registry.ts`,
`client/src/components/task-tracker/task-tracker-provider.tsx`

- `EventPayload = any` and `EventData = any` with `// eslint-disable-next-line`.

  **Why:** Registry entries each handle a distinct Socket.IO event whose
  payload shape is specific to the event. Typing the union across all
  events would force every normalizer to discriminate on fields the
  registry doesn't know about.

  **Proper fix:** Discriminated union keyed by task type, or
  `defineTaskTypeConfig<...>()` builder + `satisfies` at the map level.

## 5. HAProxy action bodies

### `add-container-to-lb.ts`

- `const serverAddress = (context.containerName || context.containerIpAddress) as string;`
  — earlier validation throws if neither is set, but TS can't narrow that
  for the composite expression. The cast is safe given the prior checks.

### `configure-frontend.ts`

- `const sourceType: 'stack' | 'manual' = (context.sourceType as 'stack' | 'manual') ?? 'stack';`
  — `sourceType` is `string` in `ActionContext`. State machines don't
  model the enum at the context level. Candidate for a typed enum.

### `deploy-application-containers.ts`

- `containerConfig` fallback construction uses
  `as unknown as ContainerConfig` because the legacy fallback produces a
  shape with `environment: string[]` and `volumes: string[]`, while
  `ContainerConfig` expects `ContainerEnvVar[]` and `DeploymentVolume[]`.

  **Proper fix:** Update the fallback to build real `ContainerEnvVar[]` /
  `DeploymentVolume[]` values, or drop the legacy fallback entirely once
  all callers pass explicit fields.

## 6. Connectivity status reads

**Files:** `server/src/services/azure-storage-service.ts`,
`server/src/services/cloudflare/cloudflare-service.ts`,
`server/src/services/docker-config.ts`,
`server/src/services/github-service.ts`,
`server/src/services/github-app/github-app-validation.ts`,
`server/src/services/tls/tls-config.ts`

- Each `getHealthStatus()` reads the return of
  `getLatestConnectivityStatus()` (which returns `Record<string, unknown>`)
  via a local `const row = latestStatus as { ... }` cast.

  **Why:** Typing `getLatestConnectivityStatus` to the full Prisma
  `ConnectivityStatus` payload triggers `Date | null` vs `Date | undefined`
  / `bigint` vs `number` mismatches at every caller.

  **Proper fix:** Return a narrow DTO from `getLatestConnectivityStatus`
  that already converts nullable fields.

## 7. Client zod-resolver casts

**Files:** `client/src/components/stack-templates/*`

- `resolver: zodResolver(schema) as Resolver<z.infer<typeof schema>>`
  instead of the previous `as any`.

  **Why:** react-hook-form + zod v4 type mismatch; the `Resolver<>` cast
  is narrower than `any` but still papers over the same upstream issue.

  **Proper fix:** Wait for upstream compatibility, then remove the cast.
