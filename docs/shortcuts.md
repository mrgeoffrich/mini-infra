# Upgrade Cleanup Shortcuts

Shortcuts taken during the `no-explicit-any` cleanup. Each is a candidate
for a future follow-up PR.

---

## HAProxy state-machine action types (`server/src/services/haproxy/actions/types.ts`)

- `ActionEvent` is intentionally aliased to `any` (with an inline
  `eslint-disable-next-line @typescript-eslint/no-explicit-any`).

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
  action's `sendEvent` is typed to the host machine's event union). Both
  options are non-trivial refactors.

- `ActionContext` identifier fields (`deploymentId`, `applicationName`,
  `environmentId`, `environmentName`, `haproxyContainerId`,
  `haproxyNetworkName`) are typed as required `string`, even though every
  state-machine context initializes them with `""` fallbacks.

  **Why:** Actions use them unguarded (e.g. `ctx.applicationName` passed
  to `.includes()`). State machines set defaults so they're always
  present at runtime.

  **Proper fix:** Validate at state-machine entry and make them
  non-nullable (remove the `|| ""` fallbacks at context init).

## `add-container-to-lb.ts`

- `const serverAddress = (context.containerName || context.containerIpAddress) as string;`
  — earlier validation throws if neither is set, but TS can't narrow that
  for the composite expression. The cast is safe given the prior checks.

## `configure-frontend.ts`

- `const sourceType: 'stack' | 'manual' = (context.sourceType as 'stack' | 'manual') ?? 'stack';`
  — `sourceType` is `string` in `ActionContext`. State machines don't
  model the enum at the context level. Candidate for a typed enum.

## `deploy-application-containers.ts`

- `containerConfig` fallback construction uses
  `as unknown as ContainerConfig` because the legacy fallback produces a
  shape with `environment: string[]` and `volumes: string[]`, while
  `ContainerConfig` expects `ContainerEnvVar[]` and `DeploymentVolume[]`.

  **Proper fix:** Either update the fallback to build real
  `ContainerEnvVar[]` / `DeploymentVolume[]` values, or drop the legacy
  fallback entirely once all callers pass `containerPorts` /
  `containerVolumes` / `containerEnvironment` explicitly.
