# Upgrade Cleanup Shortcuts

Shortcuts taken during the `no-explicit-any` cleanup. Each is a candidate
for a future follow-up PR.

---

## 1. HAProxy state-machine action types

**File:** `server/src/services/haproxy/actions/types.ts`

- `ActionEvent` is aliased to `any` with
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any`.

  **Why:** Each XState machine (initial-deployment, blue-green-deployment,
  blue-green-update, removal-deployment) defines its own strictly-typed
  event union. Actions emit events that differ subtly between machines
  (e.g. `CONTAINERS_RUNNING` requires `containerIpAddress: string` in
  blue-green but optional in initial-deployment). Trying to make a single
  discriminated `ActionEvent` compatible with all four machines produced
  dozens of forwarding errors (`self.send(event)` inside narrowed
  branches). Keeping `ActionEvent = any` lets each state machine keep its
  strict event union on the receiving side while actions remain free to
  emit heterogeneous shapes.

  **Proper fix:** Either widen each state-machine event union to a shared
  supertype, OR declare per-machine-scoped action callbacks (so each
  action's `sendEvent` is typed to the host machine's event union).

- `ActionContext` identifier fields (`deploymentId`, `applicationName`,
  `environmentId`, `environmentName`, `haproxyContainerId`,
  `haproxyNetworkName`) are typed as required `string`, even though every
  state-machine context initializes them with `""` fallbacks.

  **Why:** Actions use them unguarded (e.g. `ctx.applicationName` passed
  to `.includes()`). State machines set defaults so they're always
  present at runtime.

  **Proper fix:** Validate at state-machine entry and make them
  non-nullable (remove the `|| ""` fallbacks at context init).

## 2. Cloudflare SDK response shape

**Files:** `server/src/services/cloudflare/cloudflare-service.ts`,
`server/src/services/cloudflare/cloudflare-dns.ts`,
`server/src/routes/cloudflare-settings.ts`

- `CloudflareApiResponse = any` with `// eslint-disable-next-line`.

  **Why:** The cloudflare SDK's response types fight the narrow helper
  signatures (zones / tunnels / DNS records are cursor-paginated unions).
  Modelling every response inline was too invasive for a cleanup PR.

  **Proper fix:** Thin adapter layer over the cloudflare SDK that exposes
  mini-infra-shaped responses.

## 3. Stack-template-service serializer shape

**File:** `server/src/services/stacks/stack-template-service.ts`

- `SerializableTemplate = any` and `SerializableVersion = any` with
  `// eslint-disable-next-line`.

  **Why:** `serializeTemplate` / `serializeVersion` accept multiple
  Prisma payload shapes depending on the caller's `include` set (list vs
  detail vs update). Every strict union I tried cascaded into errors
  against the runtime `as unknown as ...` casts for JSON columns.

  **Proper fix:** Discriminated union per caller shape, or a single
  loose shape with runtime validation.

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
