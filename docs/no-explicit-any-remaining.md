# `@typescript-eslint/no-explicit-any` — Remaining Work

Tracking the remaining `any` warnings after the bulk cleanup in `chore/no-explicit-any-cleanup`.

**Status:** 385 warnings remain (300 server + 85 client) out of an original ~867.

The mechanical patterns (catch-block narrowing, `as unknown as Prisma.InputJsonValue`, structural error casts, hook-event generic parameterisation) are done. What's left needs per-site reasoning.

---

## Remaining categories

### 1. XState state-machine contexts (~10 warnings)

**Files:** `server/src/services/stacks/stack-reconciler.ts`

Lines like `(finalState.context as any).containerId`, `.error`, `.newContainerId`. The state machines (`initialDeploymentMachine`, `blueGreenDeploymentMachine`, `blueGreenUpdateMachine`, `removalDeploymentMachine`) each have their own context type, and `finalState` is a generic `StateValue`. We need either:
- A generic helper `extractContext<T>(finalState): T`
- Explicit type parameter when invoking `createActor(machine)` so `finalState` is typed properly
- Narrow inline with a local `{ containerId?: string; newContainerId?: string; error?: string }` cast

### 2. Cloudflare SDK response shapes (~25 warnings)

**Files:** `server/src/services/cloudflare/cloudflare-service.ts`, `cloudflare-dns.ts`

- `async updateTunnelConfig(tunnelId: string, config: any): Promise<any>` — needs the tunnel config shape from Cloudflare API docs.
- `async getTunnelConfig(...): Promise<any>`, `getTunnelInfo(): Promise<any[]>` — similar.
- `Promise.race([apiCall, timeout])` results cast `as any` because the SDK method return type is sometimes too narrow (Zone[], Tunnel[]) for the generic bridging we do. Consider typing the helper properly.
- DNS record type mismatch: `type: params.type as any` — cloudflare SDK has a union that differs from our `CloudflareDNSRecordType`. Map explicitly.

### 3. Internal stack-reconciler method params (~6 warnings)

**File:** `server/src/services/stacks/stack-reconciler.ts`

`applyStateful(svc: any, stack: any, ...)`, `applyStatelessWeb(svc: any, stack: any, ...)`, `applyBlueGreenUpdate(svc: any, stack: any, ...)`, `applyRemoval(svc: any, stack: any, ...)`.

These need `Prisma.StackServiceGetPayload<...>` and `Prisma.StackGetPayload<{ include: {...} }>` types that match the actual queries at the call sites. The tricky bit is the various inclusion combinations across callers (some include template, some include services, etc.).

### 4. HAProxy Data Plane API typed mixin proxies (~11 warnings)

**File:** `server/src/services/haproxy/dataplane/base.ts`

The `withTransaction()` helper monkey-patches `this.httpClient.get/post/put/delete` to prefix transaction IDs, and uses `as any` for the assignment because the generic signatures conflict with the override. Options:
- Convert to a typed proxy pattern with `Parameters<typeof originalGet>`
- Extract the wrapper into a `TransactionalHttpClient` subclass

Also `const self = this as any` to duck-type mixin methods — refactor to define an interface the mixin + base both implement.

### 5. Prisma JSON-field reads with bespoke shapes (~30 warnings)

**Files:** `stack-template-service.ts`, `stacks.ts` routes, various templates

Already converted writes to `as unknown as Prisma.InputJsonValue`. Reads still use `as any` in cases where we want to narrow to an application-level type without going through `StackServiceRouting` etc. Fix: define reader helpers like:

```ts
function readRouting(value: Prisma.JsonValue): StackServiceRouting | null {
  // runtime-validate or cast based on your trust level
}
```

### 6. Logger contexts and middleware (~10 warnings)

**Files:** `middleware/validation.ts`, `lib/logger-factory.ts`, various

Patterns like `function log(ctx: any, msg: string)` — change `ctx` to `Record<string, unknown>` (pino's default) or use `pino.bindings` shape.

### 7. Database/queue job data in restore/backup (~6 warnings)

**Files:** `services/backup/backup-executor.ts`, `services/restore-executor/*`

Mostly done, but a couple of `on("completed", (job, result: any)` — `result` needs to match the processor's TResult. Use proper generic result type.

### 8. Task type registry (~10 warnings)

**File:** `client/src/lib/task-type-registry.ts`, `components/task-tracker/task-tracker-provider.tsx`

The registry's callbacks are typed `(payload: any)` because the payload differs per task type. Options:
- Genericise `TaskTypeConfig<TStartedPayload, TStepPayload, TCompletedPayload>`
- Use a tagged-union approach
- Keep as `any` with a comment explaining the multi-payload dispatch

Current attempt (reverted) to narrow them broke downstream use since each task type reads different fields. Solution is a proper generic, not a narrower shape.

### 9. Client hook/component `(record: any).field` reads (~15 warnings)

**Files:** various client components

Some are reading from API responses before types are established (pre-typed fetch). Fix per call: infer from the shared `@mini-infra/types` response type.

### 10. Docker port bindings shape (~3 warnings)

**File:** `services/container/container-lifecycle-manager.ts`

`Record<string, Docker.PortBinding[]>` was adjusted; a couple of internal helpers still take/return `any` for compatibility with dockerode's loose typing. Leave as-is or add custom `PortBindingMap` type.

---

## Suggested next pass

Priority order if we want to close out to 0:

1. **XState contexts** (self-contained, satisfying wins). Gives back ~10 and makes stack-reconciler cleaner.
2. **Stack-reconciler `svc: any`/`stack: any` params** — 6 warnings but a big file; pair with (1).
3. **Task type registry generics** — 10 client warnings; cleanest when done with proper generic signature.
4. **Prisma JSON readers** — adds a few typed helpers; pay down tech debt in one place.
5. **HAProxy base.ts transactional client** — restructure the `withTransaction` helper.
6. **Cloudflare SDK wrappers** — biggest but lowest ROI without upstream SDK type improvements.
7. **Long-tail 1-3-warning files** — ~80 warnings spread across ~30 files. Grind work.

Each of 1–5 can be a single focused PR. Item 6 is worth splitting; item 7 is ideal for agents that aren't time-bounded.
