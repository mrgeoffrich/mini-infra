# Pool Phase 1 — Data model, per-service Vault binding, and synchronous spawn

**Parent spec:** [stack-service-pools-plan.md](stack-service-pools-plan.md). This doc is the PR-level implementation plan; design decisions live in the parent.

**Goal:** land enough of the Pool feature that the slackbot manager can cut over. After this PR: operators can define a Pool service in a stack, apply the stack, and a caller (with a pool management token) can POST/GET/DELETE instances via the API. Spawn is synchronous (no task tracker yet); no idle reaper yet; no UI.

**Size note.** This phase is large enough to consider splitting into two PRs — see *Optional split* at the end. Default is one PR.

## Prerequisites

- Stack-level Vault AppRole binding is already live (`Stack.vaultAppRoleId`) — we mirror that pattern at the service level.
- Registry credential storage already works (`pullImageWithAutoAuth` handles `ghcr.io`).
- Task tracker infrastructure already exists — we don't use it in this phase, Phase 2 wires it in.

## Work items (in dependency order)

### 1. Types layer — `lib/types/`

1.1. `stacks.ts` — add `"Pool"` to `STACK_SERVICE_TYPES` tuple (currently `['Stateful', 'StatelessWeb', 'AdoptedWeb']`). The Zod schema derives from this automatically.

1.2. `stacks.ts` — extend `DynamicEnvSource` discriminated union with:
```ts
| { kind: 'pool-management-token'; poolService: string }
```

1.3. `stacks.ts` — add the `PoolConfig` type:
```ts
{ defaultIdleTimeoutMinutes: number; maxInstances: number | null; managedBy: string | null }
```

1.4. `permissions.ts` — add `"pools"` to `PermissionDomain` union. Add a `PermissionGroup` entry to `PERMISSION_GROUPS` with scopes `pools:read` (Reader/Editor/Admin) and `pools:write` (Editor/Admin). `ALL_PERMISSION_SCOPES` derives automatically.

1.5. `socket-events.ts` — add `"pools"` to `STATIC_SOCKET_CHANNELS`, add `Channel.POOLS = "pools"`. Do **not** add `ServerEvent` constants in this phase — events land in Phase 2.

### 2. Prisma schema — `server/prisma/schema.prisma`

2.1. Add `Pool` to `StackServiceType` enum.

2.2. Extend `StackService`:
```prisma
poolConfig                    Json?
poolManagementTokenHash       String?
vaultAppRoleId                String?
lastAppliedVaultAppRoleId     String?
vaultAppRole                  VaultAppRole? @relation("ServiceVaultAppRole", fields: [vaultAppRoleId], references: [id])
```

2.3. Add named relation to the existing `Stack.vaultAppRole` — rename its `@relation` to `"StackVaultAppRole"` so the two FKs to `VaultAppRole` disambiguate.

2.4. `VaultAppRole` — rename existing `stacks Stack[]` back-relation to `@relation("StackVaultAppRole")`, add new `stackServices StackService[] @relation("ServiceVaultAppRole")`.

2.5. Add `PoolInstance` model with the columns from the spec (id is `cuid()`, status is plain `String` not enum, all fields as per the spec's data-model table).

2.6. Create the migration: `pnpm --filter mini-infra-server exec prisma migrate dev --name pool_service_type`.

2.7. Add a raw-SQL migration for the partial unique index:
```sql
CREATE UNIQUE INDEX pool_instance_active_unique
ON PoolInstance (stackId, serviceName, instanceId)
WHERE status IN ('starting', 'running');
```
This needs a follow-up `prisma migrate dev --create-only` + hand-edit, or an unchecked raw SQL file in `migrations/`.

### 3. Zod schemas — `server/src/services/stacks/schemas.ts`

3.1. Add `poolConfigSchema` matching the type.

3.2. Extend the service-definition schema with optional `poolConfig`.

3.3. Add a `.refine()` guard:
- `serviceType === "Pool"` ⇒ `poolConfig` required, `routing` forbidden.
- `poolConfig.managedBy`, if set, must name a service that exists in the same stack.

3.4. Extend `dynamicEnv` schema to accept `kind: "pool-management-token"` with a `poolService: string` field.

### 4. Reconciler skip-Pool guards

4.1. `stack-plan-computer.ts` — in `compute()`, return `no-op` unconditionally for any service with `serviceType === "Pool"`. Never emit a `create` action for them.

4.2. `stack-reconciler.ts` — `promoteStalePullActions()`: add a type guard to skip Pool services (no image pull/compare).

4.3. `stack-reconciler.ts` — in the apply loop, skip `resolveVaultEnv()` for Pool services. Pool services don't get containers at apply time, so per-service Vault resolution there is wasteful.

4.4. `stack-reconciler.ts` — `destroyStack` and `stopStack`: after stopping containers by label, transition any matching `PoolInstance` rows to `status = stopped` with `stoppedAt = now` in the same transaction.

### 5. Vault injector — `server/src/services/vault/vault-credential-injector.ts`

5.1. `InjectorArgs` already has `appRoleId`. At call sites in `stack-reconciler.ts`, pass the service-level `vaultAppRoleId` when set, falling back to the stack-level value. The injector itself doesn't need to know which layer it came from.

5.2. Add a handler branch in `resolve()` for `kind: "pool-management-token"`. At apply time only, this returns the plaintext token that was just minted for the named pool service. The token comes from a per-apply context passed into the injector — add an optional `poolTokens: Record<serviceName, string>` argument.

### 6. Pool management token mint on apply

6.1. In `stack-reconciler.ts` apply flow, before resolving dynamicEnv for any service: for each Pool service in the stack where `poolConfig.managedBy` is set, generate a 32-byte random hex token, bcrypt-hash it (cost 10), update `StackService.poolManagementTokenHash`. Collect the plaintext tokens into a `Record<poolServiceName, plaintext>` map.

6.2. Pass that map to `resolveVaultEnv` / the injector so the `pool-management-token` kind can resolve.

6.3. Tokens are regenerated on every apply. Never persist plaintext.

### 7. Pool routes — `server/src/routes/stacks/stacks-pool-routes.ts` (new)

7.1. Route prefix: `/api/stacks/:stackId/pools/:serviceName/instances`.

7.2. Dual-auth middleware: accepts either an API key with the correct `pools:read`/`pools:write` scope, or a bearer pool management token. Token path: find all `StackService` records for `(stackId, serviceName)` with `poolManagementTokenHash IS NOT NULL`, bcrypt-compare, authorise only for that specific pool.

7.3. Every handler validates that `serviceName` names a `Pool`-type service in the given stack (mirror the existing type check in `stacks-service-routes.ts`).

7.4. Implement four handlers synchronously (spawn blocks the response in this phase):
- `POST /` — ensure instance. Idempotent: if `starting`/`running` row exists, return it. Otherwise insert `starting` row, perform spawn steps a-h from the spec inline, update to `running` or `error`, return the row. Strip `VAULT_*` from caller env.
- `GET /` — list non-stopped instances.
- `GET /:instanceId` — get one.
- `DELETE /:instanceId` — stop + remove container, mark `stopped`. Fire-and-forget container removal.

7.5. Env merge order (bottom wins): service base env → Vault-injected env → caller env.

7.6. Container naming and labels per spec: `{projectName}-pool-{serviceName}-{instanceId}`, plus the five labels (stack, stack-id, service, pool-instance, pool-instance-id).

7.7. Mount in `server/src/routes/stacks/index.ts` alongside `crudRoutes`, `serviceRoutes`, etc.

## Tests

- **Unit:** Zod schema tests for Pool service validation (happy path, `routing` rejected, `poolConfig.managedBy` refers to missing service, `pool-management-token` references unknown pool).
- **Unit:** `StackPlanComputer` test — Pool services always produce `no-op`.
- **Unit:** Vault injector resolves `pool-management-token` kind.
- **Integration:** apply a stack with one Pool service + one Stateful caller. Verify `poolManagementTokenHash` is populated and the caller's env contains a plaintext token. Re-apply and verify the hash rotated.
- **Integration:** POST to the pool routes with a valid token creates an instance; wrong token 401; token against a different pool 401; API key with `pools:write` works.
- **Integration:** destroy the stack → `PoolInstance` rows transition to `stopped`.

## Definition of done

- [ ] Migration applies cleanly on a dev DB.
- [ ] Existing stacks (no Pool services) continue to apply and destroy without regression.
- [ ] A stack with only Pool services applies successfully and creates zero containers.
- [ ] Pool management token is injected into the `managedBy` service's env; rotates on re-apply.
- [ ] POST/GET/DELETE work end-to-end from `curl` on a dev instance.
- [ ] Manual test: apply the slackbot stack definition from the migration plan's checklist, verify manager container receives `MINI_INFRA_POOL_TOKEN`.
- [ ] Server + lib tests pass (`pnpm test`).

## Optional split (de-risk large PR)

If this is too big:

- **1a** — items 1, 2, 3, 4. No new functionality; extends the schema and wires skip-guards. Safe to land alone because no callers exist.
- **1b** — items 5, 6, 7. Vault injector extension + token mint + routes. Depends on 1a.

Both halves must land before slackbot can cut over.

## Out of scope (deferred to later phases)

- Task tracker integration (Phase 2)
- Async spawn / Socket.IO events (Phase 2)
- Heartbeat endpoint (Phase 2)
- Idle reaper (Phase 3)
- UI (Phase 4)
