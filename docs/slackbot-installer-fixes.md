# Slackbot Installer — Bug Fixes Plan

Issues 237–242 were filed against `mini-infra` after `slackbot-agent-sdk` tried to use it as a host. All six were investigated against the codebase on `claude/elegant-volhard-a5f199`. Each one is reproducible from a code reading; this document records the verdict, exact file/line of the defect, and the proposed fix.

The fixes are ordered roughly by blast radius — Vault first because it intermittently breaks every admin operation; the stack-template / stack-CRUD asymmetries next because they all share the same root cause (handlers and schemas drifting apart); the multi-service network bug last because it's the most opinionated change.

---

## Issue #237 — Admin Vault token expires silently (no auto-renew)

**Verdict:** Real bug. Confirmed.

### Where it breaks

- [server/src/services/vault/vault-admin-service.ts:111](server/src/services/vault/vault-admin-service.ts:111) — `adminToken` is cached on the instance.
- [server/src/services/vault/vault-admin-service.ts:240](server/src/services/vault/vault-admin-service.ts:240) — AppRole is bootstrapped with `token_period: "1h"`.
- [server/src/services/vault/vault-admin-service.ts:364](server/src/services/vault/vault-admin-service.ts:364) — `authenticateAsAdmin()` performs the AppRole login and stores the token, but **never schedules a renewal**. There is no `setInterval`, no `setTimeout`, and no call to `auth/token/renew-self` anywhere in the service.
- The only re-auth triggers are server boot and `POST /api/vault/passphrase/unlock`. After ~1 hour of uptime every admin Vault call returns 500 because the cached token has expired; the global error handler swallows the underlying `permission denied` from Vault, so the UI shows a useless `Internal server error`.
- `GET /api/vault/status` continues to report `passphrase.state: "unlocked"` and `sealed: false` throughout, so operators have no visible signal of the degraded state.

### Fix

Add a self-renewing token loop to `VaultAdminService`. Concretely:

1. Capture the lease metadata returned by `appRoleLogin` (`auth.lease_duration`, `auth.renewable`, `auth.token_policies`) on `this` alongside the token.
2. After a successful login or renewal, schedule a one-shot timer at half the lease duration that calls `POST /v1/auth/token/renew-self` against the admin token (the AppRole's `token_period` makes renewal indefinite as long as the daemon stays up).
3. On renewal success, recompute the schedule from the new lease.
4. On renewal failure: drop `this.adminToken`, clear the timer, log a `vault` warning, and emit a Socket.IO event on a new `Channel.VAULT` (or piggy-back on the existing vault channel) so operators see a banner rather than getting silent 500s. The next admin operation should re-attempt `authenticateAsAdmin()` once before failing — if AppRole login also fails, surface a concrete error code (e.g. `vault_admin_unauthenticated`) instead of bare 500.
5. Clear the renewal timer in any teardown path (`destroy()` / process shutdown).
6. Add `POST /api/vault/admin/reauthenticate` (no body, gated on `passphrase.isUnlocked()`) so external installers can force-refresh without going through the lock+unlock UI dance. This is small and gives automation a programmatic recovery path.

### Tests

- Unit: fake the HTTP client, assert that `authenticateAsAdmin` schedules a timer, that fast-forwarding past the half-lease point calls `renew-self`, and that consecutive renewals reschedule correctly.
- Unit: assert that a 403 from `renew-self` clears the cached token and emits the warning event.
- Integration (existing vault test harness): apply a stack > 1 token-period later in fake time, assert the apply still succeeds.

### Out of scope

Changing the AppRole's `token_period` itself, or moving from AppRole to Kubernetes auth — both are bigger conversations. The renewal pattern works as-is.

---

## Issue #238 — `dockerImage` / `dockerTag` skip template substitution; pulls fail on `{{params.…}}`

**Verdict:** Real bug. Confirmed.

### Where it breaks

The reconciler builds a `resolvedDefinitions` map at the top of an apply via `resolveServiceConfigs()` ([server/src/services/stacks/stack-reconciler.ts:133](server/src/services/stacks/stack-reconciler.ts:133)). Resolved values flow into `createAndStartContainer` correctly, but the **pull** call sites all read the raw Prisma row:

- [server/src/services/stacks/stack-service-handlers.ts:105](server/src/services/stacks/stack-service-handlers.ts:105) — `prepareServiceContainer(this.containerManager, svc, …)` is handed the unresolved `svc`. Inside, `containerManager.pullImage(svc.dockerImage, svc.dockerTag)` runs against the literal strings.
- [server/src/services/stacks/utils.ts:304](server/src/services/stacks/utils.ts:304) — `prepareServiceContainer` itself; same problem at the source.
- [server/src/services/stacks/stack-reconciler.ts:648-659](server/src/services/stacks/stack-reconciler.ts:648) — `promoteStalePullActions()` does its own `pullImage(svc.dockerImage, svc.dockerTag)` against raw values.

`deepResolve` ([server/src/services/stacks/template-engine.ts:98](server/src/services/stacks/template-engine.ts:98)) already walks every string field on the service definition, so resolved `dockerImage` / `dockerTag` are sitting in `resolvedDefinitions` — they just aren't being read.

### Fix

Single-source the resolved image reference and pass it through every pull and create site.

1. Change the signature of `prepareServiceContainer` (utils.ts) to accept either the resolved `StackServiceDefinition` instead of the raw Prisma row, or an explicit `{ dockerImage, dockerTag }` pair already pulled from `resolvedDefinitions`. Match what `createAndStartContainer` already takes.
2. Update the call site at [stack-service-handlers.ts:105](server/src/services/stacks/stack-service-handlers.ts:105) to pass `serviceDef` (the resolved definition that's already retrieved at line 274 of the reconciler) — or read `dockerImage`/`dockerTag` from it explicitly.
3. Update `promoteStalePullActions()` to look up the resolved definition the same way the apply path does (`resolvedDefinitions.get(action.serviceName)`) and pull against that.
4. Audit the rest of the stack pipeline for any other site that reads `svc.dockerImage` / `svc.dockerTag` and uses them for I/O — there shouldn't be more, but a grep confirms the surface.

### Tests

- Unit (vitest): apply a stack whose `dockerImage` is `{{params.image-registry}}/foo` and `dockerTag` is `{{params.image-tag}}`, with a fake `containerManager.pullImage`. Assert the call receives the resolved values, not the literal `{{…}}` strings.
- Same for the force-pull path — drive it via `promoteStalePullActions` with the same assertion.

### Out of scope

Generalising template resolution into the Prisma layer (e.g. returning resolved values directly from the DAL). Keeping resolution at apply-time only is fine.

### Documentation update

[docs/stack-definition-reference.md](docs/stack-definition-reference.md) currently says free-form string fields support templating; once this lands, that promise will actually hold for `dockerImage` / `dockerTag`. No doc change needed beyond confirming an example.

---

## Issue #239 — `toTemplateServiceCreate` drops `poolConfig` and `vaultAppRoleId`

**Verdict:** Real bug. Confirmed.

### Where it breaks

- [server/src/services/stacks/stack-template-service.ts:1104](server/src/services/stacks/stack-template-service.ts:1104) — `toTemplateServiceCreate` builds the create payload but omits `poolConfig` and `vaultAppRoleId` entirely.
- Compare [server/src/services/stacks/utils.ts:101](server/src/services/stacks/utils.ts:101) — `toServiceCreateInput`, used by the regular `POST /api/stacks` path, *does* include both.

So a Pool service round-tripped through a user template ends up with `poolConfig: null` in the DB. The pool reaper then skips that service for not having `managedBy`, and any cross-service `pool-management-token` `dynamicEnv` on the caller never resolves. This makes user templates unusable for the slackbot worker pool — the canonical use case Pool was added for.

### Fix

Add both fields to `toTemplateServiceCreate`, mirroring `toServiceCreateInput`:

```ts
poolConfig: s.poolConfig
  ? (s.poolConfig as unknown as Prisma.InputJsonValue)
  : Prisma.DbNull,
vaultAppRoleId: s.vaultAppRoleId ?? null,
```

Also verify the symmetric serialiser used when reading template versions back to clients (`serializeTemplateService` in the same file) reads both fields. If it doesn't, add them — it's pointless to write them if they're stripped on read.

### Tests

- Unit (vitest): create a template version containing a Pool service with `poolConfig` populated and a service with `vaultAppRoleId`, then re-fetch it and assert both round-trip.
- Integration: instantiate a stack from that template version, assert the resulting `StackService` row has both fields populated.

### Out of scope

The broader question of whether template versions and stack services should share a single Prisma model rather than two near-identical mappers. That's a real DRY concern but a refactor for another PR.

---

## Issue #240 — `PUT /api/stacks/:stackId/services/:serviceName` ignores `poolConfig`, `vaultAppRoleId`, `adoptedContainer`

**Verdict:** Real bug. Confirmed.

### Where it breaks

- Schema [server/src/services/stacks/schemas.ts:429-431](server/src/services/stacks/schemas.ts:429) **does** declare `adoptedContainer`, `poolConfig`, and `vaultAppRoleId` — they're accepted into the request body without error.
- Handler [server/src/routes/stacks/stacks-service-routes.ts:36-50](server/src/routes/stacks/stacks-service-routes.ts:36) builds `updateData` with only `serviceType`, `dockerImage`, `dockerTag`, `containerConfig`, `configFiles`, `initCommands`, `dependsOn`, `order`, and `routing`. The other three fields are silently discarded — no warning, no 400, no Prisma write.

This means once a Pool service is created with the wrong `managedBy` (or the wrong `vaultAppRoleId`, or the wrong `adoptedContainer`), the only way to fix it via the public API is to delete and recreate the stack. Not viable for stacks with state.

### Fix

Add the three missing branches to the handler, with `null` mapped to `Prisma.DbNull` for the JSON columns:

```ts
if (data.adoptedContainer !== undefined) {
  updateData.adoptedContainer =
    data.adoptedContainer === null
      ? Prisma.DbNull
      : (data.adoptedContainer as unknown as Prisma.InputJsonValue);
}
if (data.poolConfig !== undefined) {
  updateData.poolConfig =
    data.poolConfig === null
      ? Prisma.DbNull
      : (data.poolConfig as unknown as Prisma.InputJsonValue);
}
if (data.vaultAppRoleId !== undefined) {
  updateData.vaultAppRoleId = data.vaultAppRoleId;
}
```

While here, audit the `if (data.X !== undefined)` chain for any *other* schema fields that aren't being copied — same root cause, same fix shape, easy to bundle.

### Tests

- Unit (supertest against the route): PUT each of the three fields individually, GET the service, assert each persisted. Repeat with explicit `null` to confirm clearing works.
- Unit: PUT a body with all three plus the existing fields, assert no field is dropped.

### Refactor opportunity (note, not required for the fix)

The `if (data.X !== undefined) updateData.X = …` pattern is bug-prone exactly because it requires manual upkeep on every schema change. A small helper that derives the update object from the schema's keys would prevent recurrences. Worth raising as a follow-up but **not** in scope here — the immediate fix is the three branches.

---

## Issue #241 — `createStackSchema` doesn't include `vaultAppRoleId` / `vaultFailClosed`

**Verdict:** Real bug. Confirmed (partial — handler will accept the fields once schema is updated).

### Where it breaks

- [server/src/services/stacks/schemas.ts:383-397](server/src/services/stacks/schemas.ts:383) — `createStackSchema` lacks `vaultAppRoleId` and `vaultFailClosed`.
- [server/src/services/stacks/schemas.ts:399-417](server/src/services/stacks/schemas.ts:399) — `updateStackSchema` has both at lines 413-414.
- [server/src/routes/stacks/stacks-crud-routes.ts:141-221](server/src/routes/stacks/stacks-crud-routes.ts:141) — the POST handler can already pass these through to `prisma.stack.create`; it's only the schema gate that strips them.

The asymmetry forces every Vault-bound stack to do `POST /api/stacks` immediately followed by a `PUT /api/stacks/:id` to set the binding. There's a small but real window between the two calls where a triggered apply silently skips Vault resolution and produces broken services.

### Fix

Add the two fields to `createStackSchema` matching `updateStackSchema`:

```ts
vaultAppRoleId: z.string().nullable().optional(),
vaultFailClosed: z.boolean().optional(),
```

Then thread them through the create handler. The exact write site depends on the existing `prisma.stack.create({ data: { ... } })` block in `stacks-crud-routes.ts` — copy the same shape `updateStackSchema` already uses. Default `vaultFailClosed` to `true` if undefined (matches the existing safe behaviour and the issue's stated expectation).

### Tests

- Unit (supertest): POST `/api/stacks` with `vaultAppRoleId` and `vaultFailClosed`, assert both persist on first read.
- Unit: POST without them, assert the existing default behaviour (`vaultFailClosed: true`, `vaultAppRoleId: null`) is unchanged.

### Out of scope

A broader audit of every other create-vs-update schema asymmetry. Worth doing, but bundle into the same follow-up that picks up the #240 refactor opportunity.

---

## Issue #242 — Multi-service stacks with `networks: []` end up on `bridge` with no DNS

**Verdict:** Real bug. Confirmed. This one has the most design surface.

### Where it breaks

- [server/src/services/stacks/stack-reconciler.ts:234](server/src/services/stacks/stack-reconciler.ts:234) — `const networkNames = networks.map((n) => \`${projectName}_${n.name}\`);` — empty `networks` produces empty `networkNames`.
- [server/src/services/docker-executor/long-running-container.ts:169-176](server/src/services/docker-executor/long-running-container.ts:169) — when `options.networks.length === 0`, no `NetworkingConfig.EndpointsConfig` is constructed. Docker then defaults to `bridge`, which has no DNS by container name.
- No `Aliases` are ever set on `EndpointsConfig` (grep across the codebase returns zero hits). So even on a properly-networked stack, the bare service name doesn't resolve — only the full `${projectName}-${serviceName}` does. Users have to lean on `{{services.X.containerName}}` template vars to wire env vars, which leaks the project name out to consumers.
- No validate-time warning catches the "≥2 services, no shared network" case.

### Fix

Three complementary changes. All of them are small individually; together they make multi-service stacks behave the way users coming from docker-compose expect.

#### 1. Auto-create a default network when a stack has ≥2 services and `networks: []`

In the reconciler, after loading the stack definition and before building `networkNames`, detect the case `services.length >= 2 && networks.length === 0` and synthesise a default network entry: `{ name: "default", driver: "bridge" }`. Then continue through the existing infrastructure-creation path so `${projectName}_default` is created and torn down with the stack like any other stack-owned network.

This must be invisible to the stack definition stored in the DB — i.e. it's a runtime synthesis at apply time, not a definition mutation. That keeps `networks: []` valid as a single-service shorthand and avoids surprising existing single-service stacks.

#### 2. Set service-name aliases on every stack network attachment

In `long-running-container.ts` where `EndpointsConfig` is built for each network, add `Aliases: [serviceName]` (and optionally include any user-declared aliases from `containerConfig.networkAliases` if that's a thing — check schema). The serviceName is already known at the call site as part of the resolved definition.

After this, `nats://nats:4222` resolves on any stack-owned network, no template trickery needed.

Note: aliases are per-network, so this needs to apply for every entry in `EndpointsConfig` — including the auto-synthesised default network from change 1.

#### 3. Validate-time warning

Extend `GET /api/stacks/:id/validate` (or the equivalent server-side validator) to emit a non-fatal warning when `services.length >= 2 && networks.length === 0 && services.every(s => !s.containerConfig?.joinNetworks?.length)`. Wording: `"Services X, Y, Z share no network. They will land on the host's bridge network and won't be able to reach each other by service name. A default network will be auto-created at apply time."` (Tone matches change 1 — the warning explains the auto-creation rather than scaring the user.)

If we decide change 1 is too magical, the warning becomes the only signal and the wording shifts to "add a `networks` entry, e.g. `[{ name: 'default' }]`."

### Tests

- Integration: apply a 2-service stack with `networks: []`. Assert both containers join `${projectName}_default`, that the network is created with the expected name, and that one container can `getent hosts <other-service-name>` resolve to the other.
- Integration: apply a 2-service stack with `networks: [{ name: "shared" }]`. Assert both containers have `Aliases: [serviceName]` set on `${projectName}_shared`.
- Unit: validator returns the new warning for `≥2 services, no networks`.
- Existing single-service stacks: confirm no regression — they should continue to work whether they have `networks: []` or not (no auto-default for them; they'd typically use bridge or `host`).

### Open question

Should change 1 also auto-create a default network for single-service stacks with `networks: []`? Probably not — single-service stacks have no DNS problem to solve and adding/destroying a bridge per stack adds churn. Leaving it off keeps the change scoped to where the bug actually bites.

### Documentation update

Add a "Networking" section to [docs/stack-definition-reference.md](docs/stack-definition-reference.md) describing: (a) when the default network kicks in, (b) that service names are usable as DNS aliases, (c) the `joinNetworks` override for advanced cases. The slackbot installer currently has to read source to figure this out.

---

## Suggested PR ordering

Bundle as follows so each PR is independently reviewable and the high-impact fixes don't block on the bigger refactors:

1. **PR-A — Vault token renewal (#237).** Standalone; touches only the vault service.
2. **PR-B — Stack schema/handler asymmetries (#239, #240, #241).** Same root cause (schema-vs-handler drift), same files, same review surface. One PR with three commits and three sets of tests.
3. **PR-C — Template substitution for image refs (#238).** Standalone; touches the reconciler / utils only.
4. **PR-D — Multi-service network defaults (#242).** Largest surface, most opinionated. Send last so the smaller fixes aren't held up by the design discussion.

All four together unblock the slackbot installer.
