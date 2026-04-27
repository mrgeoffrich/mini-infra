# SecretsVault — Implementation Plan

Concrete implementation plan for [secrets-vault-plan.md](secrets-vault-plan.md). Organised so each phase can land as its own PR. File paths are relative to the repo root.

> This plan has been revised following a sceptical review. Key changes from the first draft:
> - Phase 1 (template-only) was merged into Phase 2 — a deployed-but-unbootstrapped OpenBao leaves the operator in a half-state.
> - Networking reuses the existing `resourceOutputs` / `joinResourceNetworks` idiom instead of inventing `mini-infra-vault-net`.
> - AES-GCM is a shared `server/src/lib/crypto.ts` utility with a versioned format, not tucked inside the passphrase service.
> - Env injection happens in the plan-computer / reconciler layer with explicit "dynamic field" marking, not in `stack-container-manager.ts` — otherwise `definition-hash` and `lastAppliedSnapshot` break.
> - `VaultState` uses `cuid()` + a `kind` unique constraint, not a magic `id: "singleton"`.
> - Human operator access to the Vault UI for MVP is explicitly designed (was hand-waved).
> - Wrapping TTL is 300s (was 60s) and minted *after* image pull to avoid a correctness bug.

## Systems we're interacting with

| System | Role | Touchpoint |
|---|---|---|
| OpenBao | The managed vault itself | HTTP API (`/v1/*`) |
| Mini Infra server | Orchestrates OpenBao + exposes management UI | New services, routes, prisma models |
| Mini Infra client | Management UI | New pages under `client/src/app/vault/` |
| Stack templates | Ship OpenBao as a system template | New `server/templates/vault/` |
| Stack plan-computer + reconciler | Inject AppRole wrapped secret_ids at apply time | New dynamic-env mechanism in `stack-plan-computer.ts` / `stack-resource-reconciler.ts` |
| InfraResource model | Exposes the Vault docker network for bindings to join | Reuses `resourceOutputs` + `joinResourceNetworks` (postgres pattern) |
| HAProxy | Exposes Vault UI via existing routing | New StatelessWeb service on the Vault stack |
| Task tracker | Surfaces bootstrap / unseal / apply progress | New registry entries |
| Socket.IO | Real-time progress events | New `Channel.VAULT` |
| Prisma | Persists Vault state, policies, AppRoles, bindings | New models + migration |

## Prework — decisions to lock in before Phase 1

These are **pre-phase** choices that affect scope. Settle them in small design-only tickets.

### P0. Pick an HCL editor

There is **no Monaco or CodeMirror in the client today** (confirmed — no `monaco-editor` / `@monaco-editor/react` / `codemirror` in `client/package.json`). Phase 3's HCL editor requires adding one. Options:

- **`@monaco-editor/react`** — full IDE feel, built-in diff view, but a ~2 MB bundle hit and dark-theme integration work. No off-the-shelf HCL language package; we'd hand-roll a Monarch tokenizer (small, maybe 80 lines).
- **`react-simple-code-editor` + `prismjs` with the existing `prism-hcl` grammar** — tiny bundle (~30 KB), basic highlighting, no diff view. We'd build diff via side-by-side `<pre>` blocks or `diff2html`.
- **Textarea with server-side validation only** — cheapest, ugliest. Probably not worth shipping.

**Recommendation**: start with option 2 (Prism) — ship Phase 3 smaller; upgrade to Monaco later if operators complain.

### P1. AES-GCM format + KDF parameters

First real symmetric crypto in the repo — confirmed no existing helper (the RegistryCredential `password` field is labelled "Encrypted" in schema and `server/CLAUDE.md` but the service at `server/src/services/registry-credential.ts` stores the raw value; this is a pre-existing issue flagged separately below).

Specify once, reuse:

- **Cipher**: AES-256-GCM via `crypto.createCipheriv`.
- **On-disk format (bytes)**: `version(1) | nonce(12) | ciphertext(N) | tag(16)`. Version byte = `0x01` so we can rotate schemes later.
- **KDF**: Argon2id via the existing `argon2` package (already in `server/src/lib/password-service.ts`). Parameters: `memoryCost: 65536 KiB` (64 MB), `timeCost: 3`, `parallelism: 4`. Salt: 16 random bytes, persisted alongside the wrapped state so the same passphrase derives the same key across restarts.
- **Wrapping-key zeroisation**: stored in a `Buffer` that gets overwritten via `buf.fill(0)` on `lock()`.
- Implemented once in `server/src/lib/crypto.ts` — `encrypt(key, plaintext)`, `decrypt(key, ciphertext)`. Not in the passphrase service.

### P2. Human operator access to the Vault UI for MVP

OIDC is deferred to [vault-oidc-plan.md](vault-oidc-plan.md), and Phase 2 rotates the root token immediately after bootstrap. So how does a human log into the Vault UI?

**Decision for MVP**: Phase 2 creates a `mini-infra-operator` userpass user with a randomly generated password, stored encrypted in `VaultState` like any other credential. Operator is shown the password once at bootstrap completion (same screen as the unseal keys). Rotation via the Vault UI banner: "Change password". This keeps human access working without OIDC and without leaking the root token.

### P3. `mini-infra-admin` regeneration

If `VaultState.encryptedAdminSecretId` is ever lost (DB restore, disaster recovery), Mini Infra can still re-authenticate using the unseal keys → re-init path *as long as unseal keys survive*. The recovery route (Phase 5) handles this. Do not rely on root token persistence.

## Files worth pulling into context

Before touching anything, read these.

**Patterns to mirror**
- `server/templates/postgres/template.json` — reference system stack template. Note the `resourceOutputs: [{ type: "docker-network", purpose: "database", joinSelf: true }]` pattern and how consumers set `joinResourceNetworks: ["database"]` — this is the mechanism we use for Vault-to-app connectivity, not a bespoke external network.
- `server/src/services/stacks/post-install-actions/register-postgres-server.ts` — post-install action pattern.
- `server/src/services/stacks/builtin-stack-sync.ts` — how templates are upserted on boot.
- `server/src/services/stacks/stack-plan-computer.ts` + `stack-resource-reconciler.ts` + `stack-reconciler.ts` — **where env injection must happen** (not `stack-container-manager.ts`, which is too late in the flow).
- `server/src/services/stacks/template-engine.ts` — where parameter interpolation into env maps lives; this is the surface where "dynamic env" markers get resolved.
- `server/src/services/stacks/definition-hash.ts` — hashing of the stack definition for drift detection. Anything apply-time dynamic **must be excluded** here.
- `server/src/services/stacks/stack-applied-snapshot.ts` — last-applied snapshot. Same exclusion rule.
- `server/src/services/tls/certificate-lifecycle-manager.ts` — reference long-running multi-step operation with step callbacks.
- `server/src/services/configuration-factory.ts` — factory for new config categories. Current supported set is `"docker", "cloudflare", "azure", "tls"` (not `postgres`; `server/CLAUDE.md` is outdated on this point).
- `server/src/services/azure-storage-service.ts` — reference `IConfigurationService` implementation.
- `server/src/lib/password-service.ts` — Argon2id already available; KDF parameters go in `crypto.ts` per P1.
- `server/src/lib/connectivity-scheduler.ts` — pattern for the auto-unseal health watcher.

**Reference from slackbot-agent-sdk**
- `/Users/geoff/Repos/slackbot-agent-sdk/environment/vault/bootstrap.ts` — Vault init, unseal, auth-method enable, policy + AppRole create, KV seed.
- `/Users/geoff/Repos/slackbot-agent-sdk/environment/up.ts` — auto-unseal, wrapped secret_id mint, env injection.
- `/Users/geoff/Repos/slackbot-agent-sdk/environment/vault/*.hcl` — shape of AppRole / user-self-service policies.

**Types + schema touchpoints**
- `server/prisma/schema.prisma` — Stack, StackTemplate, InfraResource, RegistryCredential models.
- `lib/types/socket-events.ts` — where `Channel.VAULT` and `VAULT_*` events go. Pin step event shape to `{ step: OperationStep, completedCount: number, totalSteps: number }` to match TLS / sidecar / self-update.
- `lib/types/stack-templates.ts`, `lib/types/stacks.ts` — extension point for `StackVaultBinding`.
- `lib/types/settings.ts` — add `'vault'` to `SettingsCategory`.
- `lib/types/permissions.ts` — new `vault:*` scopes.
- `client/src/lib/task-type-registry.ts` — where new task types are declared.
- `client/CLAUDE.md` + `server/CLAUDE.md` — patterns we're required to follow.

## Phase breakdown

Each phase ends on a shippable PR.

---

### Phase 1 — Vault stack + bootstrap + operator passphrase

Was two phases in the original plan. Merged because OpenBao without `sys/init` is functionally useless (health returns 501, no auth methods enabled) and a "half-deployed" state has no honest UI story. This is the heavy phase; subsequent ones are smaller.

#### Template

- `server/templates/vault/template.json` — openbao image, single service, volume `openbao_data`, host-scoped, no parameters for MVP. Based on `slackbot-agent-sdk/environment/compose.vault.yml`. **Adds** `resourceOutputs: [{ type: "docker-network", purpose: "vault", joinSelf: true }]` so the Mini Infra server container joins the network and consumer stacks can attach via `joinResourceNetworks: ["vault"]`.
- `server/templates/vault/README.md` — operator notes.

#### Crypto + passphrase

- `server/src/lib/crypto.ts` (new) — shared AES-GCM utilities per P1. `encrypt(key: Buffer, plaintext: Buffer): Buffer`, `decrypt(key: Buffer, ciphertext: Buffer): Buffer`, plus `deriveKey(passphrase: string, salt: Buffer): Promise<Buffer>` using Argon2id. Versioned byte format.
- `server/src/lib/operator-passphrase-service.ts` (new) — singleton service with an explicit state machine:
  - States: `uninitialised` (no salt stored), `locked` (salt stored, key not derived), `unlocked` (key in memory), `failed-N` (after N wrong attempts; backoff or lockout).
  - `setPassphrase(passphrase)` — used during bootstrap; generates salt, derives key, moves to `unlocked`.
  - `unlock(passphrase)` — post-bootstrap; derives key with stored salt, verifies by decrypting a known-value probe (stored alongside salt), moves to `unlocked`.
  - `lock()` — zeroises the key buffer, moves to `locked`.
  - `wrap` / `unwrap` — delegates to `crypto.ts` with the in-memory key.
  - `OPERATOR_PASSPHRASE` env var unlocks at boot if set.
  - Emits `VAULT_PASSPHRASE_UNLOCKED` / `_LOCKED` socket events so the UI reacts immediately.

#### Vault client + orchestration

- `server/src/services/vault/vault-http-client.ts` — thin wrapper around OpenBao's HTTP API (`/v1/*`). Modelled on `BaoClient` in `bootstrap.ts`. Circuit breaker like `github-service.ts`.
- `server/src/services/vault/vault-state-service.ts` — reads/writes the encrypted `VaultState` row; all mutations pass through `operatorPassphraseService.wrap/unwrap`.
- `server/src/services/vault/vault-admin-service.ts` — orchestrator; methods `bootstrap(onStep)`, `unseal(onStep)`, `rotateRootToken()`, `isReady()`. Step callbacks emit to `Channel.VAULT`. Bootstrap:
  1. Init (3 shares, threshold 2). Wrap + persist unseal keys and root token.
  2. Unseal with 2 shares.
  3. Enable `approle/` and `userpass/` auth methods; enable `kv/` v2 at `secret/`.
  4. Write the `mini-infra-admin` policy; create the AppRole; read role_id, mint a non-wrapping secret_id, persist both wrapped.
  5. Create the `mini-infra-operator` userpass user with a random password (per P2); persist encrypted.
  6. Rotate the root token; switch client auth to the admin AppRole for all subsequent operations.
  7. Emit `VAULT_BOOTSTRAP_COMPLETED` with the one-time-viewable credentials blob.
- `server/src/services/vault/vault-config-service.ts` — `IConfigurationService` for `address`, `stackId`, `bootstrappedAt`. `validate()` probes `/v1/sys/health`.
- Extend `server/src/services/configuration-factory.ts` — register `vault` category.

#### Auto-unseal watcher

- `server/src/services/vault/vault-health-watcher.ts` — periodic seal-status poll (pattern from `connectivity-scheduler.ts`). On `sealed && passphrase.isUnlocked()` → call `vaultAdminService.unseal()`. Emits `VAULT_STATUS_CHANGED` on transitions.

#### Routes

- `server/src/routes/vault/bootstrap.ts` — `POST /api/vault/bootstrap`.
- `server/src/routes/vault/unseal.ts` — `POST /api/vault/unseal`.
- `server/src/routes/vault/passphrase.ts` — `POST /api/vault/passphrase/unlock`, `POST /api/vault/passphrase/lock`, `POST /api/vault/passphrase/change`.
- `server/src/routes/vault/status.ts` — `GET /api/vault/status` (seal, init, passphrase unlocked, reachable).
- `server/src/routes/vault/index.ts` — mounts the above. Gated behind the `VAULT_ENABLED` flag (see Rollout).

#### Schema

```prisma
model VaultState {
  id                          String   @id @default(cuid())
  kind                        String   @unique  // "primary" for MVP; enables multi-vault later
  stackId                     String?
  address                     String?
  initialised                 Boolean  @default(false)
  initialisedAt               DateTime?
  bootstrappedAt              DateTime?
  passphraseSalt              Bytes?
  passphraseProbe             Bytes?    // known-value encrypted by the derived key; used to verify passphrase on unlock
  encryptedUnsealKeys         Bytes?
  encryptedRootToken          Bytes?
  encryptedAdminRoleId        Bytes?
  encryptedAdminSecretId      Bytes?
  encryptedAdminSecretIdAt    DateTime?
  encryptedOperatorPassword   Bytes?    // for the userpass mini-infra-operator user (P2)
  createdAt                   DateTime @default(now())
  updatedAt                   DateTime @updatedAt
}
```

`kind` unique + `cuid()` id preserves singleton-for-now behaviour while allowing multi-vault later without a migration. Upsert by `kind: "primary"` on bootstrap.

#### Types + events

- `lib/types/vault.ts` — `VaultStatus`, `VaultBootstrapResult`, event payload types. Step shape matches the existing `OperationStep` convention.
- `lib/types/socket-events.ts` — add to `STATIC_SOCKET_CHANNELS`: `"vault"`. Add `Channel.VAULT`. Events: `VAULT_BOOTSTRAP_STARTED / _STEP / _COMPLETED`, `VAULT_UNSEAL_STARTED / _COMPLETED`, `VAULT_STATUS_CHANGED`, `VAULT_PASSPHRASE_UNLOCKED / _LOCKED`.

#### Client

- `client/src/app/vault/page.tsx` — overview: stack status, health, seal status, passphrase-locked banner, Bootstrap / Unlock / Unseal CTAs.
- `client/src/app/vault/components/VaultStatusCard.tsx` — status badges.
- `client/src/app/vault/components/BootstrapDialog.tsx` — wizard with passphrase entry → progress via `useOperationProgress(Channel.VAULT, ...)`.
- `client/src/app/vault/components/PassphraseUnlockDialog.tsx` — shown when locked.
- `client/src/app/vault/components/BootstrapCompletePage.tsx` — one-time view of unseal keys + root token + operator password. "I've saved these" confirmation required before navigation.

#### Task tracker

- `client/src/lib/task-type-registry.ts` — `vault-bootstrap`, `vault-unseal`.

#### Permissions

- `lib/types/permissions.ts` — new scopes `vault:read`, `vault:write`, `vault:admin`. Wire into presets.

#### Tests

- `server/src/lib/__tests__/crypto.test.ts` — AES-GCM round-trips, version-byte handling, tamper detection, KDF determinism.
- `server/src/lib/__tests__/operator-passphrase-service.test.ts` — state machine transitions, wrong-passphrase lockout, zeroisation.
- `server/src/services/vault/__tests__/vault-http-client.test.ts` — mocked fetch, error mapping, circuit breaker.
- `server/src/services/vault/__tests__/vault-admin-service.test.ts` — bootstrap happy path + failure paths against a mocked Vault.
- `server/src/services/vault/__tests__/vault-health-watcher.test.ts` — auto-unseal on seal detection, no-op when locked.
- Integration test (optional, gated): real OpenBao in a docker container for bootstrap e2e.

#### Phase 1 exit criteria

- Operator deploys the vault stack, enters a passphrase, runs bootstrap, end state is: running unsealed Vault, `VaultState` encrypted in DB, `mini-infra-admin` AppRole active, `mini-infra-operator` userpass user can log into the Vault UI.
- Vault container restart → auto-unseal fires without operator intervention (while passphrase unlocked).
- Mini Infra restart → Vault stays sealed until operator unlocks passphrase via UI; rest of platform keeps running.
- **Backup restore test passes**: take a self-backup, destroy `VaultState`, restore from backup, re-unlock passphrase, confirm Vault is operable again. This is an exit gate, not a best-effort check.

---

### Phase 2 — HCL policies + AppRoles as first-class resources

CRUD + apply-to-Vault for policies and AppRoles. Still no stack binding.

#### Schema

```prisma
model VaultPolicy {
  id                String   @id @default(cuid())
  name              String   @unique
  displayName       String
  description       String?
  draftHclBody      String?
  publishedHclBody  String?
  publishedVersion  Int      @default(0)
  publishedAt       DateTime?
  lastAppliedAt     DateTime?
  isSystem          Boolean  @default(false)
  createdById       String?
  updatedById       String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  appRoles          VaultAppRole[]
}

model VaultAppRole {
  id                String       @id @default(cuid())
  name              String       @unique
  policyId          String
  policy            VaultPolicy  @relation(fields: [policyId], references: [id], onDelete: Restrict)
  secretIdNumUses   Int          @default(1)
  secretIdTtl       String       @default("0")
  tokenTtl          String?
  tokenMaxTtl       String?
  tokenPeriod       String?
  cachedRoleId      String?      // captured after apply; nullable until reconciled
  lastAppliedAt     DateTime?
  createdById       String?
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt
}
```

Real FK with `onDelete: Restrict` so deleting a policy in use is a loud failure, not a silent dangling reference.

#### Services

- `server/src/services/vault/vault-policy-service.ts` — CRUD + `publish(id)` → `PUT sys/policies/acl/<name>`, bumps `publishedVersion`, sets `lastAppliedAt`.
- `server/src/services/vault/vault-approle-service.ts` — CRUD + `apply(id)` writes the role to Vault; reads role_id and stores in `cachedRoleId`.

#### Routes

- `server/src/routes/vault/policies.ts` — REST CRUD.
- `server/src/routes/vault/approles.ts` — REST CRUD + `POST /:id/apply`.

#### Client

- `client/src/app/vault/policies/page.tsx` — list + create.
- `client/src/app/vault/policies/[id]/page.tsx` — HCL editor per P0 decision (Prism + `react-simple-code-editor` assumed). Side-by-side diff between draft and published via `diff2html` or similar.
- `client/src/app/vault/roles/` — form-based AppRole editor.

#### Seed data

- `server/src/services/vault/vault-seed.ts` (new, **not** inside `builtin-stack-sync.ts` which is stack-template-specific) — on server boot, upsert:
  - `mini-infra-admin` policy row (content mirroring what Phase 1 bootstrap wrote to Vault), `isSystem: true`.
  - `user-self-service` policy template, `isSystem: true`, unapplied.
  - Example read-only and kv-user-namespaced policies, `isSystem: true`, unapplied.
- Called from `app-factory.ts` alongside `syncBuiltinStacks()`.

#### Events

- `ServerEvent.VAULT_POLICY_APPLIED`, `ServerEvent.VAULT_APPROLE_APPLIED`.

#### Phase 2 exit criteria

Operator writes an HCL policy in-app, publishes it to Vault, defines an AppRole referencing it, sees `cachedRoleId` populated. Deleting a policy in use returns a clear "cannot delete: referenced by AppRoles x, y, z" error.

---

### Phase 3 — Stack ↔ Vault binding + wrapped secret_id injection

The payoff. This phase is where the existing stack pipeline meets Vault. It's more invasive than Phases 1–2 because we're introducing the concept of **apply-time dynamic env vars** to the stack definition.

#### Schema

```prisma
model Stack {
  // existing fields...
  vaultAppRoleId      String?
  vaultAppRole        VaultAppRole?  @relation(fields: [vaultAppRoleId], references: [id], onDelete: SetNull)
  vaultFailClosed     Boolean        @default(true)
}
```

Real relation instead of `Json?` — we want FK integrity, and there's exactly one binding field. Promote to a join table later if stacks grow multiple bindings.

#### The dynamic-env mechanism (cross-cutting)

`stack-container-manager.ts` is the **wrong seam** — env vars there bypass `definition-hash` and `lastAppliedSnapshot`, so re-applies won't re-mint secret_ids (a functional bug) and drift detection gets confused (a correctness bug).

Instead:

- Extend the stack-service env model with a `dynamic` marker: `Record<string, string | { dynamic: true; source: 'vault-role-id' | 'vault-wrapped-secret-id' | 'vault-addr' }>`.
- `template-engine.ts` passes dynamic markers through untouched during parameter interpolation.
- `definition-hash.ts` and `stack-applied-snapshot.ts` **exclude** dynamic-marked values from their hash / snapshot so the stack is never "drifted" because the wrapping token changed.
- `stack-plan-computer.ts` resolves dynamic markers at plan time **after** any image pull step has completed, calling a new `VaultCredentialInjector` to mint a wrapped secret_id.
- `stack-resource-reconciler.ts` / `stack-reconciler.ts` pass the resolved env to the container-creation step through the normal channel.

This is the biggest design risk in the project. Before writing code, do a spike: add a single dynamic-marked env to one test service and verify that (a) subsequent re-applies re-resolve it, (b) drift detection stays stable, (c) applied-snapshot round-trips cleanly.

#### VaultCredentialInjector

- `server/src/services/vault/vault-credential-injector.ts` — given a stack's `vaultAppRoleId`, returns `{ VAULT_ADDR, VAULT_ROLE_ID, VAULT_WRAPPED_SECRET_ID }` or null.
- Wrapping TTL: **300s** (was 60s in the original plan; too tight given cold image pull + boot). Still short-lived, still one-shot.
- Mint *after* `pullImageWithAutoAuth()` completes, not before. The plan-computer orchestrates this.
- Fail-closed nuance:
  - `vaultFailClosed: true` + Vault unreachable + stack has never been applied successfully → **fail**.
  - `vaultFailClosed: true` + Vault unreachable + stack has a valid `lastAppliedSnapshot` with the same AppRole → **proceed with `VAULT_ROLE_ID` only, skip wrapping**. The app's responsibility to handle an absent wrap by retrying against Vault once it's reachable. This preserves the design promise ("Mini Infra keeps running when Vault is sealed") — platform redeploys don't block on Vault.
  - `vaultFailClosed: false` → always proceed with whatever's available.

#### Docker networking — **not** a new external network

Phase 1's template already declared `resourceOutputs: [{ type: "docker-network", purpose: "vault", joinSelf: true }]`. Bound stacks declare `joinResourceNetworks: ["vault"]` in their container config. The existing `stack-infra-resource-manager.ts` handles the attach/detach lifecycle — no new infrastructure code needed.

Verify during the spike: a container on two bridge networks (environment + vault) resolves `mini-infra-vault` short-name reliably. If not, fall back to the Vault container's IP via `docker inspect` or expose the Vault address as a fully-qualified name (e.g. `mini-infra-vault.<vault-network>`). This is the correctness question called out in the review.

#### Routes

- `server/src/routes/stacks/stacks-update-route.ts` — accept `vaultAppRoleId` + `vaultFailClosed` in the patch payload; validate that the AppRole exists.
- `server/src/routes/vault/bindings.ts` — `GET /api/vault/approles/:id/stacks` — "which stacks use this AppRole?" for the role detail page.

#### Client

- Stack / Application edit UI: new "Vault Integration" section with AppRole dropdown and the fail-closed toggle.
- Application card: Vault icon badge when bound.
- `server/templates/hello-vault/template.json` — reference sample that unwraps at boot, logs in via AppRole, reads a KV secret, and echoes it. End-to-end demo.

#### Phase 3 exit criteria

- Deploy hello-vault with a binding; container comes up, unwraps, reads a secret. End-to-end proof.
- Re-apply the same stack without changes → new wrapping token is minted each time; `definition-hash` stays stable; drift is not reported.
- Seal Vault after deploy → the already-running app keeps working until its AppRole token expires; a re-apply with the same AppRole succeeds and injects role_id without wrap (the fail-closed nuance); a brand-new stack deploy with a binding fails with a clear error.

---

### Phase 4 — Vault UI exposure via HAProxy + recovery flow

Polish + operational readiness.

#### Files

- Add a `StatelessWeb` service to `server/templates/vault/template.json` routed via HAProxy with a route like `vault.{host}`. Toggle via a template parameter; off means UI-only-on-docker-network. ACME cert issuance is free via the existing flow.
- `server/src/routes/vault/recover.ts` — `POST /api/vault/recover` lets an operator paste unseal keys + root token if `VaultState` is lost (e.g. backup restore before Phase 1). Re-wraps with current passphrase. Emits a loud audit event.
- `client/src/app/vault/recover/page.tsx` — admin-only, gated by a double confirmation.

#### Observability

- Log every vault admin op via `userEventService.create()`. Not a full audit log — OpenBao has its own — but a trail of *what Mini Infra did* to Vault.

#### Phase 4 exit criteria

Operator can enable Vault UI via HAProxy with a TLS cert, browse it over the LAN, log in as `mini-infra-operator`. Recovery flow works in a DR drill: wipe `VaultState`, paste the one-time unseal keys from Phase 1, re-enter passphrase, Mini Infra re-seeds its state and regains admin access.

---

## Rollout ordering & feature flag

- `VAULT_ENABLED` env var read at boot. Until Phase 3, all Vault routes return 404 and the nav entry is hidden.
- Prisma models ship early. Empty tables are harmless; they're tracked in migrations and covered by self-backup automatically.
- Flag is removed when Phase 4 ships.

## Adjacent issue surfaced by this work (flagged, not fixed here)

The schema labels `RegistryCredential.password`, `PostgresDatabase.connectionString`, `PostgresServer.connectionString`, and `ManagedDatabaseUser.passwordHash` as "Encrypted" in comments, and `server/CLAUDE.md` claims AES encryption via the API key secret. In reality, there is no cipher code — these fields are stored in plaintext. This is not within scope for SecretsVault but the new `server/src/lib/crypto.ts` utility makes a retrofit trivial. Worth a standalone ticket.

## Risks & open questions to resolve during build

- **Short-name DNS resolution on multi-network containers** — tested during the Phase 3 spike. Fallback: bake the Vault address via `docker inspect` when attaching.
- **HCL editor polish** — Prism-based editor is functional but plain. If operators write lots of HCL, revisit Monaco.
- **Wrapping TTL under slow pulls** — 300s is generous for normal operation but could be tight on very slow registries. Observable: if any app ever fails to unwrap due to TTL, bump to 600s.
- **Passphrase rotation** — requires re-wrapping all `VaultState.encrypted*` fields. Implement as part of Phase 4's recovery route or a dedicated settings page; needs explicit testing around partial-rewrap failures.
- **Self-backup coverage** — covered by the Phase 1 restore-test exit criterion.

## Don't forget

- Update `CLAUDE.md` (project) with a short note about Vault being available and never on the critical path of Mini Infra itself.
- Update `server/CLAUDE.md` with conventions for `VaultHttpClient`, `VaultAdminService`, `VaultCredentialInjector` (mirror the pattern established for Docker/Azure/GitHub services). Also correct the outdated claim that `postgres` is a supported `ConfigurationServiceFactory` category.
- Update `docs/roadmap.md` status as phases ship.
- `scripts/generate-ui-manifest.mjs` auto-picks-up `data-tour` attributes — add them to every new Vault page so the agent sidecar can highlight them.
- Run the `api-change-check` skill before each phase's PR.
