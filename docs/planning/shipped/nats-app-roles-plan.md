# NATS App Roles & Subject Scoping in the Stack Definition Language

**Status:** Phases 1, 2, 3, and 5 shipped. Phase 4 (signers) deferred until the Phase 0 prerequisite (live account-JWT propagation) lands.
**Forcing function:** [slackbot-agent-sdk](https://github.com/) — a third-party app that wants to consume NATS via mini-infra without hand-rolling NKey/JWT minting and without colliding with other apps' subjects.
**Builds on:** the NATS first-class primitives shipped in #320 / #322 (`vault-nats` built-in stack, `NatsControlPlaneService`, `TemplateNatsSection`).

---

## 1. Background

### 1.1 What landed in #320 / #322

Mini-infra now manages NATS as a first-class primitive:

- A built-in `vault-nats` stack runs OpenBao + NATS, with operator/account NKey material stored in Vault KV.
- `TemplateNatsSection` in [`lib/types/stack-templates.ts:218`](../../../lib/types/stack-templates.ts:218) lets a template declare `accounts`, `credentials`, `streams`, `consumers`. Each carries a `scope: 'host' | 'environment' | 'stack'` that namespaces resource *names*.
- `NatsCredentialProfile` rows hold `publishAllow` / `subscribeAllow` arrays. Services bind to a profile via `StackService.natsCredentialId` (set from a symbolic `natsCredentialRef` in the template).
- The credential injector ([`server/src/services/nats/nats-credential-injector.ts`](../../../server/src/services/nats/nats-credential-injector.ts)) resolves `dynamicEnv: { kind: 'nats-creds' }` → minted JWT, and `{ kind: 'nats-url' }` → internal URL.

### 1.2 What's missing

The primitives are powerful but **unsafe by default for app authors**: a template can declare a credential with `publishAllow: ['>']` and clobber any other app's subjects. Today this is fine because every NATS-using template is system-authored. Once third parties (slackbot, future apps) write templates, we need:

1. **Subject isolation by default** — an app's credentials can only touch its own subject namespace.
2. **Ergonomic role declaration** — template authors think in roles ("gateway", "manager"), not raw allow lists.
3. **Dynamic credential minting** — the slackbot manager mints short-lived per-user JWTs in-process. It needs an account signing key, but the key must be cryptographically constrained to a sub-tree.
4. **Cross-app messaging** — opt-in, explicit, validated. Not an accident.

### 1.3 The unsolved-by-#320 problem: live account JWT propagation

**This is a prerequisite for Phase 4 (signers) and must be designed before that phase is scoped.**

The current `vault-nats` stack runs NATS with `resolver: MEMORY` and a static `resolver_preload` block written into `nats.conf` ([`server/src/services/nats/nats-config-renderer.ts`](../../../server/src/services/nats/nats-config-renderer.ts)). Account JWTs in this mode are loaded once at process start and **do not hot-reload**.

Scoped signing keys (the cryptographic primitive that makes `signers` safe — see §2.4 step 4) live inside the account JWT. Adding/rotating/revoking a signer means re-issuing the account JWT and getting the live `nats-server` to load the new one. With the current memory-resolver setup, the only ways to do that are:

1. **Restart `nats-server`** every time a signer is added/changed/removed. Disruptive — breaks all in-flight connections.
2. **Send `SIGHUP`** to reload the config (re-reads `nats.conf` and the embedded `resolver_preload`). Less disruptive than restart but still a reload event; needs verifying that NATS actually re-evaluates account JWTs on `SIGHUP` with the memory resolver.
3. **Switch to the full account resolver** (`resolver: { type: full, dir: ... }`) and use the NATS account-server protocol (`$SYS.REQ.CLAIMS.UPDATE`) to push updates over the wire. No reload, no downtime — but a meaningful change to how `vault-nats` is configured.

Until one of these is in place, **the signers feature is not implementable**. Recommend option (3) — switching to the full resolver — because it's the only path that gives us first-class JWT lifecycle without reload events. Option (2) is the cheap fallback if (3) turns out to be too much. This is its own pre-Phase-4 design exercise; flagging it here so it doesn't get discovered mid-implementation.

The same constraint applies to **revocation**: deleting a signer (e.g., when a stack is destroyed) means the embedded scoped signing key in the account JWT is dormant but not gone until the account JWT is re-issued. Without a propagation mechanism, revoked signing keys remain valid until the next reload.

### 1.4 The slackbot today (concrete reference)

From `slackbot-agent-sdk`:

- Subjects all live under `navi.>` (defined in `shared/src/subjects.ts`).
- Three static services with distinct permission profiles: `slack-gateway`, `manager`, per-user `worker`.
- Manager mints worker JWTs (40-min TTL) using an account NKey seed it holds. See `manager/src/nats-jwt-minter.ts`.
- Every role needs `_INBOX.>` in **both** publish and subscribe — a footgun the team hit during JWT migration.

This is the design's litmus test: can we express the slackbot's NATS topology in our template DSL with no escape hatches?

---

## 2. Design

### 2.1 Decisions locked in conversation

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Prefix-only isolation** (one shared NATS account, per-app subject prefix). Not per-app accounts. | Simpler operator model; cryptographic safety still achievable via scoped signing keys. |
| 2 | **Default `subjectPrefix = app.{{stack.id}}`**. Overrides require a system-level allowlist. | `stack.id` is the only system-guaranteed-unique value. `stack.name` collisions across host-scoped stacks would silently merge prefixes — a security failure. UUIDs aren't pretty, but the prefix is rarely user-facing (it's just the namespace prepended to the patterns the template author writes in `roles[].publish/subscribe`). For the human-readable case, the override allowlist exists. |
| 3 | **Scoped signing keys** for `signers`, relative-only scope expressions. | NATS-native primitive (`nats-jwt`'s `newScopedSigner()` + `Account.signing_keys`); the server intersects per-user JWT claims with the scope template, so a compromised signer can only mint within its scope. **Requires** the JWT propagation mechanism in §1.3 — the scope template lives inside the account JWT, so it only takes effect once the live server loads the updated JWT. |
| 4 | **Stream subjects auto-prefixed**. Stream/consumer names left alone. | Consistency with role permissions. |
| 5 | **Cross-app `imports`/`exports`** resolved at apply time via DB lookup of the producer's latest applied version. Imports are **per-role** (`forRoles: string[]` required). | Templating only spans a single stack; cross-stack is structural. Per-role binding (rather than broadcasting to every role in the consumer stack) is a security decision — a "consumer" role shouldn't accidentally pick up cross-app subjects intended only for a specific gateway. |
| 6 | **Allowlist is a new Configuration category** (`"nats-prefix-allowlist"`). | Clean audit trail, separate from existing NATS settings. |
| 7 | **`roles`/`signers` are sugar over existing `accounts`/`credentials`** — they materialize into the same Prisma rows. The low-level fields stay for system templates. | App templates use the safe surface; system templates keep the escape hatch. |

Out of scope for v1:
- Per-app NATS accounts (option B in the ideation).
- Per-user credential observability UI (mini-infra is intentionally blind once a signer is delegated).
- Cross-environment imports.
- Subject prefixes that aren't derived from `stack.projectName` without explicit allowlisting.

### 2.2 Template DSL additions

Adds to `TemplateNatsSection` ([`lib/types/stack-templates.ts:218`](../../../lib/types/stack-templates.ts:218)):

```ts
export interface TemplateNatsSection {
  // NEW
  subjectPrefix?: string;            // defaults to "{{stack.projectName}}"
  roles?: TemplateNatsRole[];
  signers?: TemplateNatsSigner[];
  exports?: string[];                // relative subjects this stack publishes for cross-app consumption
  imports?: TemplateNatsImport[];

  // EXISTING — kept for system templates and advanced/internal use
  accounts?: TemplateNatsAccount[];
  credentials?: TemplateNatsCredential[];
  streams?: TemplateNatsStream[];
  consumers?: TemplateNatsConsumer[];
}

export interface TemplateNatsRole {
  /** Symbolic name. Service-level `natsRole: <name>` resolves to this. */
  name: string;
  /** Subjects relative to the stack's subjectPrefix. Prefix prepended at apply. */
  publish?: string[];
  subscribe?: string[];
  /**
   * Controls `_INBOX.>` auto-injection. NATS request/reply uses connection-generated
   * inbox subjects; the *requester* needs subscribe access (to receive replies), the
   * *replier* needs publish access (to send replies into the requester's inbox).
   *   - 'both'    (default): inject in both pub and sub. Right for roles that both
   *                          send and receive request/reply.
   *   - 'reply'  : inject in pub only. Right for pure responders (receive request,
   *                publish reply). Subscribe to the request subject explicitly.
   *   - 'request': inject in sub only. Right for pure requesters.
   *   - 'none'   : no injection. Pub-sub-only roles or roles that manage inbox
   *                routing themselves.
   * Defaulting to 'both' preserves the slackbot ergonomics; downgrading is opt-in.
   */
  inboxAuto?: 'both' | 'reply' | 'request' | 'none';
  /** Credential JWT TTL. Defaults to NatsCredentialProfile system default (3600s). */
  ttlSeconds?: number;
}

export interface TemplateNatsSigner {
  name: string;
  /**
   * Subject sub-tree the signing key is constrained to, relative to the prefix.
   * E.g. "agent.worker" → key can only mint creds whose permissions are a
   * subset of "<prefix>.agent.worker.>".
   */
  subjectScope: string;
  /** Hard cap on TTL of any JWT the signer can mint. Defaults to 3600s. */
  maxTtlSeconds?: number;
}

export interface TemplateNatsImport {
  /** Structural reference to another stack. Resolved against the latest applied version at apply time. */
  fromStack: string;
  /** Subjects relative to the *producer's* subjectPrefix. Must match producer's exports. */
  subjects: string[];
  /** Roles in *this* stack that get the imported subjects added to their subscribe list. Required. */
  forRoles: string[];
}
```

Service-level additions (in `StackTemplateServiceInfo` and the per-version `StackTemplateService` row):

```ts
interface StackTemplateServiceInfo {
  // ... existing fields ...
  natsRole?: string;     // NEW — symbolic, resolved to a NatsCredentialProfile
  natsSigner?: string;   // NEW — injects NATS_ACCOUNT_SEED for the named signer
  natsCredentialRef?: string;  // EXISTING — kept for low-level / non-prefixed access
}
```

New `DynamicEnvSource` kind in [`lib/types/stacks.ts:45`](../../../lib/types/stacks.ts:45):

```ts
type DynamicEnvSource =
  | ...existing...
  | { kind: 'nats-signer-seed'; signer: string };
```

**Two distinct keys, two distinct injections.** When a service declares both `natsRole` and `natsSigner`, it gets *two* env vars:

- `NATS_CREDS` — minted by mini-infra using the **account keypair**. Used by the service to *connect* to NATS as the role's user. Same path as today (`nats-credential-injector.ts`).
- `NATS_SIGNER_SEED` — the seed of a **scoped signing keypair**. Used by the service to *mint* its own user JWTs for downstream consumers (e.g., per-user workers). Never used to connect.

Naming the env var `NATS_SIGNER_SEED` (not `NATS_ACCOUNT_SEED`) matters: it's not the account seed and apps that confuse the two will get cryptic JWT-validation failures from NATS. Apps don't write either dynamicEnv entry by hand — declaring `natsRole` and `natsSigner` is enough; the orchestrator wires both.

### 2.3 What the slackbot template looks like

```yaml
nats:
  # subjectPrefix omitted → defaults to "app.{{stack.id}}"
  # The stack ID is opaque, but template authors only ever write *relative* subjects,
  # so they don't see it in their template — the orchestrator prepends it.
  # If the slackbot wants the human-friendly "navi" prefix, an admin allowlists it
  # for this template ID and the template sets `subjectPrefix: "navi"`.
  roles:
    - name: gateway
      publish:   ["agent.in"]
      subscribe: ["slack.api", "askuser", "agent.reply.>"]
      # inboxAuto defaults to 'both' → gateway both initiates request/reply (to slack.api)
      # and responds to incoming requests; needs _INBOX.> in pub and sub.
    - name: manager
      publish:   ["agent.worker.>"]   # dispatches work to specific worker subjects
      subscribe: ["agent.ensure", "agent.worker.ready.>", "auth.mint.>"]
  signers:
    - name: worker-minter
      subjectScope: "agent.worker"
      maxTtlSeconds: 2400

services:
  - name: slack-gateway
    natsRole: gateway
  - name: manager
    natsRole: manager           # → NATS_CREDS (connection)
    natsSigner: worker-minter   # → NATS_SIGNER_SEED (in-process minting)
```

Compared to today's slackbot:
- `navi.*` prefix → defaults away to `app.<stack-id>.*`. If the team wants the human-readable `navi` retained, that's a one-line admin allowlist entry plus `subjectPrefix: "navi"` in the template.
- The manager's hand-rolled `NatsJwtMinter` works unchanged — it's still calling `nkeys.encodeUser()` with a seed; only the seed source changes (env var injected by mini-infra rather than fetched from Vault via the app's own bootstrap).
- `_INBOX.>` plumbing disappears from the app's concerns.
- The 686-line installer can stop managing NATS account material.

### 2.4 Apply-time pipeline

In `runStackNatsApplyPhase` ([`server/src/services/stacks/stack-nats-apply-orchestrator.ts:35`](../../../server/src/services/stacks/stack-nats-apply-orchestrator.ts:35)):

**Pre-step: routing between legacy and new paths.** The current `hasNats` guard at line 65 counts only `accounts/credentials/streams/consumers`. It must be extended to `||= roles.length > 0 || signers.length > 0 || exports.length > 0 || imports.length > 0`. Existing templates that use only the legacy fields keep going through the existing materialization codepath unchanged — no prefix logic, no `_INBOX.>` injection. New templates use either the new fields or the legacy ones; mixing within a single template is rejected at validation time (open question — see §5).

1. **Resolve `subjectPrefix`** via the existing template engine. If unset, default to `app.{{stack.id}}`. Resolve against the stack's `TemplateContext` (which already exposes `stack.id`, see [`template-engine.ts:99`](../../../server/src/services/stacks/template-engine.ts:99)).
2. **Validate prefix** — if the resolved prefix doesn't equal `app.<stack-id>`, look it up in the `nats-prefix-allowlist` Configuration category. The allowlist contains `{ prefix, allowedTemplateIds: string[] }` entries; a stack template can claim a non-default prefix only if its `templateId` is in the entry's allowlist. Reject at apply with a clear error otherwise.
3. **Materialize `roles` → `NatsCredentialProfile`s.** For each role:
   - Prepend the resolved prefix to every entry in `publish` / `subscribe`.
   - Apply `inboxAuto` (`'both' | 'reply' | 'request' | 'none'`, default `'both'`) — inject `_INBOX.>` in publish and/or subscribe per the table in §2.2.
   - Reject any pattern that escapes the prefix (`>` or `*` at root, leading `_INBOX` outside the auto-injected one, leading `$SYS`, etc.).
   - Upsert as a `NatsCredentialProfile` on the system shared account. Profile name: `<stackId>-<roleName>` (use `stack.id` not `stack.name` for collision-free uniqueness; UI can render `<stackName>-<roleName>` for humans).
4. **Materialize `signers` → scoped signing keys.** *Requires the JWT propagation mechanism from §1.3.* For each signer:
   - Compute scoped subject `<prefix>.<subjectScope>.>`.
   - Generate a fresh ED25519 keypair via an extended `NatsKeyManager` (new function: `generateScopedSigningKey()` — distinct from `mintUserCreds`, which signs with the *account* key).
   - Use `nats-jwt`'s `newScopedSigner(signingKey, role, { pub: { allow: [<scoped>] }, sub: { allow: [<scoped>, '_INBOX.>'] } })` and add to `Account.signing_keys`.
   - Re-issue the account JWT with the updated `signing_keys` and propagate it to the live `nats-server` via the mechanism chosen in §1.3.
   - Persist seed in Vault KV at `shared/nats-signers/<stackId>-<signerName>`.
   - Persist a `NatsSigningKey` row (see §2.7) capturing the public key, scope, KV path, and `maxTtlSeconds`.
5. **Materialize `exports`.** Store the resolved (prefixed) export subjects as a `natsExports` JSON column on the applied `StackTemplateVersion` so consumer stacks can resolve them. (Open question 4: dedicated `StackNatsExport` table later if cross-stack queries get hot.)
6. **Resolve `imports`.** For each import:
   - Look up `fromStack` in DB by template-version applied snapshot. Use the producer stack's latest *applied* version's exports.
   - For each requested subject, verify it matches an exported pattern. Fail apply with a structured error if not.
   - Add `<producerPrefix>.<subject>` to the subscribe list of **only the roles named in `forRoles`** (see §2.1 decision 5 — per-role is required, not default-broadcast). Validate that every entry in `forRoles` is a declared role in this stack.
7. **Auto-prefix stream subjects on the new path.** For any streams declared inside a future role-aware shape (not in v1), prepend the prefix. Legacy `streams` field keeps absolute subjects (system templates need that). Effectively: roles auto-prefix; `streams` field doesn't.
8. **Wire service bindings.**
   - `natsRole: 'gateway'` → look up the materialized `NatsCredentialProfile`, set `StackService.natsCredentialId`. Existing injector for `nats-creds` handles the rest.
   - `natsSigner: 'worker-minter'` → auto-inject `dynamicEnv.NATS_SIGNER_SEED = { kind: 'nats-signer-seed', signer: 'worker-minter' }`. The role and signer injections coexist on a single service — the manager service ends up with `NATS_URL`, `NATS_CREDS`, *and* `NATS_SIGNER_SEED`.
9. **New injector**: `NatsCredentialInjector.resolve()` gains a branch for `kind: 'nats-signer-seed'` that reads the seed from Vault KV at `shared/nats-signers/<stackId>-<signerName>`. Cap on TTL (`maxTtlSeconds`) is **enforced at JWT-mint time by NATS itself** via the scope template — mini-infra doesn't need to police the TTL post-injection, but the seed handler still logs the binding for audit.

**Failure modes.**
- *NATS unreachable during apply:* role materialization writes to Vault KV and the credential profile DB row — both work without a live NATS connection. Signer materialization also writes seed to Vault KV, but **cannot complete the JWT propagation step** (§1.3). Two options: (a) defer propagation to the next NATS-up moment with a reconciler, or (b) fail the apply phase with a "NATS unreachable, signer not live" status. Recommend (b) for v1 — clearer semantics, no zombie state — with a `requireNatsReady` flag matching the existing pattern.
- *Cross-stack import: producer not yet applied:* fail with a structured error pointing the operator at the producer stack. No silent best-effort.
- *Concurrent applies on producer + consumer:* the producer's apply might change its prefix mid-flight while the consumer is resolving imports. The apply chain serializer at the stack level doesn't span stacks. Either resolve under a global NATS-apply lock, or accept eventual consistency (consumer re-apply picks up new prefix). Recommend the lock — it's a single-host system, contention is rare. Flagged as a risk in §6.

### 2.4.1 Destroy / cleanup

When a stack with NATS resources is destroyed, the orchestrator must:

- **Roles:** delete the `NatsCredentialProfile` row. Already-minted JWTs continue to validate until their TTL expires (cryptographic — mini-infra can't revoke).
- **Signers:** delete the `NatsSigningKey` row, delete the seed from Vault KV, **and** re-issue the account JWT with the signing key removed, then re-propagate via §1.3. Without the re-issue, the scoped signing key remains valid until the next account-JWT refresh — a real revocation gap.
- **Exports:** clear the `natsExports` field on the applied snapshot. Consumer stacks importing from this stack will fail their next apply with a "producer no longer exports X" error — this is the right behavior; the alternative (silent removal of subjects from consumer roles) is worse.
- **Imports:** consumer-side cleanup happens automatically when the consumer's credentials are re-materialized.

### 2.5 Validator updates

[`server/src/services/stacks/template-substitution-validator.ts`](../../../server/src/services/stacks/template-substitution-validator.ts) needs to:

1. Extend `ValidateInput` with **individual fields**, matching the existing `vaultPolicies` / `vaultAppRoles` / `vaultKvPaths` pattern at [`template-substitution-validator.ts:30`](../../../server/src/services/stacks/template-substitution-validator.ts:30) — *not* a single `nats?: TemplateNatsSection` wrapper. Add: `natsSubjectPrefix?: string`, `natsRoles?: unknown`, `natsSigners?: unknown`, `natsExports?: unknown`, `natsImports?: unknown`. (The legacy `accounts`/`credentials`/`streams`/`consumers` fields are not currently walked by the validator and don't need to be — they're system-template-only and don't accept substitutions in the dangerous fields.)
2. Allow substitution (existing `params|stack|environment` namespace rules) in: `natsSubjectPrefix`, `natsRoles[].publish[]`, `natsRoles[].subscribe[]`, `natsSigners[].subjectScope`, `natsExports[]`, `natsImports[].subjects[]`.
3. **New static checks** (no substitution dependence, but landed here for one-shot publish feedback):
   - `natsRoles[].name` and `natsSigners[].name` are unique within the section.
   - Service `natsRole` / `natsSigner` references resolve to a declared role/signer.
   - No `natsRoles[].publish/subscribe` entry starts with `>`, contains a leading wildcard, has `_INBOX.` (those go via `inboxAuto`), or starts with `$SYS`.
   - `natsSigners[].subjectScope` is non-empty, contains no wildcards, and doesn't traverse upward (no `..`).
   - `natsImports[].fromStack` is non-empty.
   - `natsImports[].forRoles` is non-empty and every entry references a declared role in this template.
   - **Mixing rule (open question):** if both legacy `credentials` and new `roles` are declared, reject. This forces an explicit migration step.

### 2.6 Configuration: `nats-prefix-allowlist`

New category in `ConfigurationServiceFactory` ([`server/src/services/configuration-factory.ts`](../../../server/src/services/configuration-factory.ts)):

- **Storage**: an array of entries. Don't use a single PUT-the-whole-blob API — one stale write wipes everyone's allowlist. Use individual-entry CRUD:
  - `GET /api/settings/nats-prefix-allowlist` — list entries.
  - `POST /api/settings/nats-prefix-allowlist` — add entry `{ prefix, allowedTemplateIds }`.
  - `PUT /api/settings/nats-prefix-allowlist/:prefix` — update an entry.
  - `DELETE /api/settings/nats-prefix-allowlist/:prefix` — remove an entry.
  Each operation routes through `ConfigurationService.set()` for audit. Entries shape:
  ```json
  [
    { "prefix": "navi", "allowedTemplateIds": ["slackbot-legacy"] },
    { "prefix": "events.platform", "allowedTemplateIds": ["platform-event-bus"] }
  ]
  ```
- **Validation at write**:
  - Prefixes must be non-empty, contain no wildcards (`>`, `*`), no leading dot, no `$SYS` prefix.
  - No new entry's prefix may be a strict subset *or* superset of an existing entry (e.g. if `events.platform` is allowlisted, `events` cannot be added). Prevents footgun overlaps that silently merge namespaces.
  - `allowedTemplateIds` must be non-empty and reference real template IDs.
- **Default**: empty. Out of the box, every stack uses `app.<stack-id>`.

### 2.7 Database

**New columns on `StackTemplateVersion`** (Prisma JSON type, all nullable for backwards compat):
- `natsSubjectPrefix String?` — resolved at apply time but stored on the version for inspectability.
- `natsRoles Json?`
- `natsSigners Json?`
- `natsExports Json?` — stores **resolved** (prefixed) exports for cheap consumer-stack lookup.
- `natsImports Json?`

The orchestrator's `templateVersion` `select` clause at [`stack-nats-apply-orchestrator.ts:51`](../../../server/src/services/stacks/stack-nats-apply-orchestrator.ts:51) must be extended to include these columns.

**New `NatsSigningKey` table** (decision: option (b) from the original draft — signers are a distinct concept and conflating them with `NatsCredentialProfile` will confuse the model):

```prisma
model NatsSigningKey {
  id             String   @id @default(cuid())
  accountId      String
  account        NatsAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  stackId        String
  stack          Stack    @relation(fields: [stackId], references: [id], onDelete: Cascade)
  name           String                       // e.g. "worker-minter"
  scope          String                       // relative scope as declared, e.g. "agent.worker"
  scopedSubject  String                       // resolved absolute subject, e.g. "app.<id>.agent.worker.>"
  publicKey      String                       // for cross-checking server-side validation
  seedKvPath     String                       // shared/nats-signers/<stackId>-<name>
  maxTtlSeconds  Int
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([stackId, name])
  @@index([accountId])
}
```

`NatsAccount` and `Stack` get the inverse relations.

### 2.8 Cross-cutting touchpoints

Files that change in proportion to which the design touches them:

| Area | Files | Change |
|------|-------|--------|
| Types | `lib/types/stack-templates.ts`, `lib/types/stacks.ts`, `lib/types/nats.ts` | New interfaces, new `DynamicEnvSource` variant |
| Schemas | `server/src/services/stacks/schemas.ts` | Zod for new fields, structural drift checks |
| Validator | `server/src/services/stacks/template-substitution-validator.ts` | Walk `nats.*`, new static checks |
| Apply orchestrator | `server/src/services/stacks/stack-nats-apply-orchestrator.ts` | Steps 1–8 above |
| Injector | `server/src/services/nats/nats-credential-injector.ts` | New branch for `nats-signer-seed` |
| Key manager | `server/src/services/nats/nats-key-manager.ts` | Scoped signing key generation + minting with constraints |
| Config | `server/src/services/configuration-factory.ts` + a new `NatsPrefixAllowlistService` | New category |
| HTTP | `server/src/routes/nats-prefix-allowlist.ts` (new) | GET/PUT for the allowlist |
| Schema | `server/prisma/schema.prisma` | New `NatsSigningKey` table (option b) |
| Tests | `server/src/__tests__/` | See §4 |
| Docs | `docs/user/stack-definition-reference.md` | New "NATS app roles" section |

---

## 3. Implementation phases

### Phase 0 — Live account JWT propagation (PREREQUISITE for Phase 4)
- Design + implement the mechanism described in §1.3. Strongly recommend switching `vault-nats` to the full account resolver and using the `$SYS.REQ.CLAIMS.UPDATE` protocol to push account JWT updates without reload.
- Touches `nats-config-renderer.ts`, `nats-control-plane-service.ts`, the `vault-nats` template, and `nats-key-manager.ts`.
- Tests: account JWT update propagates to a live NATS server within X seconds; revoking a signing key invalidates JWTs signed by it.
- This is the largest unknown in the plan and should be tackled as a discrete spike before signer scope is finalized. Phases 1–3 can ship without this.

### Phase 1 — Types + validator + schema migration (no behavior change)
- Add `TemplateNatsRole`, `TemplateNatsSigner`, `TemplateNatsImport`, extend `TemplateNatsSection`.
- Add `natsRole`/`natsSigner` to service interfaces and Zod schemas (with a contract test through the HTTP draft route per [server/CLAUDE.md](../../../server/CLAUDE.md) "Field-persistence regression tests").
- Add the new `StackTemplateVersion` columns (§2.7) and the `NatsSigningKey` table via Prisma migration.
- Extend the substitution validator to walk and statically check the new fields (§2.5).
- Tests: validator catches missing role/signer references, escape attempts, name collisions, and the legacy/new mixing rule.

### Phase 2 — Prefix allowlist
- New Configuration category + service + REST routes (CRUD per entry, not blob PUT — see §2.6).
- Admin-only access for v1; UI surface deferred.
- Tests: config round-trips; validation rejects wildcards, overlapping prefixes, and `$SYS`.

### Phase 3 — Roles materialization
- In the apply orchestrator: resolve `subjectPrefix`, branch correctly between legacy and new paths (§2.4 pre-step), prepend to role patterns, apply `inboxAuto`, materialize `NatsCredentialProfile` rows.
- Wire `StackService.natsCredentialId` from `natsRole` symbol.
- Tests: golden-file test of materialized publishAllow/subscribeAllow given a sample template; allowlist enforcement; rejection of escape patterns; legacy templates pass through unchanged.

### Phase 4 — Signers (depends on Phase 0 + Phase 3; can run parallel to Phase 5)
- Extend `NatsKeyManager` with `generateScopedSigningKey()` — distinct from `mintUserCreds`.
- Add scoped signing key to the shared account, re-issue account JWT, push via Phase 0 mechanism.
- New `nats-signer-seed` injector branch in `NatsCredentialInjector.resolve()`.
- Wire `natsSigner` service field → auto-inject `NATS_SIGNER_SEED` dynamicEnv.
- Tests (must run against a real NATS server, not mocks):
  - JWT minted by a scoped signer with permissions broader than the scope is silently trimmed by the server (the actual cryptographic guarantee).
  - JWT with claimed TTL > `maxTtlSeconds` is rejected.
  - Seed is redacted in logs (`getLogger("nats", ...)` filters).
  - Destroying a stack with a signer revokes the key end-to-end (re-issued account JWT no longer contains it).

### Phase 5 — Imports/exports (depends on Phase 3; parallel to Phase 4)
- Materialize `exports` on the applied version.
- Resolve `imports` against producer's latest applied version at apply time, including `forRoles` validation.
- Add the global NATS-apply lock (or document the eventual-consistency tradeoff).
- Tests: import without matching export fails clean; import after producer re-publishes picks up new prefix; producer not yet applied → clear error; consumer apply concurrent with producer re-apply doesn't write stale subscribe subjects.

### Phase 6 — Slackbot migration
- Update slackbot-agent-sdk to use `roles` + `signers`.
- Validate the 686-line installer shrinks meaningfully.
- Decide whether to keep `navi.*` (allowlist entry) or take the default `app.<stack-id>.*`.

### Phase 7 — Docs
- Add a "NATS app roles" section to `docs/user/stack-definition-reference.md`.
- Update `docs/user/vault-app-developer-guide.md` cross-refs since signers replace one of its patterns.

---

## 4. Test strategy

Critical scenarios that **must** have integration coverage (not just unit tests against fixtures):

1. **Role isolation** — two stacks with overlapping role names (`gateway`) get distinct credential profiles with non-overlapping subject prefixes. Connect with cred A, attempt to publish to stack B's prefix → NATS rejects.
2. **Signer scope enforcement** — given a signer scoped to `agent.worker`, mint a JWT for `agent.worker.123` (succeeds) and `agent.in` (fails, NATS rejects). Asserts the cryptographic backstop, not just our codepath.
3. **`_INBOX.>` auto-injection** — request/reply round-trip works for a role with no explicit `_INBOX` mention.
4. **Allowlist** — apply with non-default `subjectPrefix` and matching allowlist entry succeeds; without entry, fails with a structured error pointing at the allowlist UI.
5. **Cross-stack imports** — producer applies with `exports: ['events.>']`; consumer with `imports: [{ fromStack: 'producer', subjects: ['events.>'] }]` can subscribe to `<producer-prefix>.events.foo`.
6. **HTTP contract** — supertest POST to the template draft route persists `natsRole`/`natsSigner` (per the field-persistence convention).
7. **Migration** — re-applying a stack with changed roles updates the credential profile in place; re-applying with changed signer scope rotates the signing key cleanly (or fails loudly if mid-flight JWTs would be invalidated — TBD, see open question 7).

---

## 5. Open questions

**Decided in this iteration** (no longer open):
- Signer storage → dedicated `NatsSigningKey` table.
- `forRoles` on imports → required, not optional. Per-role binding only.
- Default subject prefix → `app.<stack-id>`, not `{{stack.projectName}}`.
- `_INBOX.>` injection → `inboxAuto: 'both' | 'reply' | 'request' | 'none'`, default `'both'`.

**Still open:**

1. **Mixing legacy + new fields in one template.** The validator currently rejects (per §2.5). Confirm — system templates won't need to mix because they're all-legacy and stay that way. App templates are all-new from the start.
2. **Where do exports live structurally?** JSON column on `StackTemplateVersion` is simplest and ships in Phase 1. A dedicated `StackNatsExport` table makes cross-stack queries cheap and makes the "producer destroyed → consumers' next apply fails" semantics explicit. v1: JSON; refactor if cross-stack lookups get hot.
3. **Streams in roles, or stay separate?** v1 keeps streams as the existing template field, absolute subjects, system-template-only path. Apps that want JetStream in v1 can't (they'd need to roll their own via the legacy fields, which the mixing rule blocks). This is a real gap if any app needs JetStream — unblock by adding `roles[].streams` in a follow-up. Decide: is JetStream-for-apps a v1 requirement or a v2 follow-up? The slackbot doesn't need it.
4. **Signer rotation semantics**: re-applying with a changed `subjectScope` rotates the underlying signing key (old key removed from account JWT, new one added). In-flight JWTs minted by the old key remain valid until TTL because of NATS's stateless validation. Acceptable, or do we need a forced revocation path?
5. **Operator UX for the allowlist**: admin-only API in v1; deferred UI. Worth a CLI helper (`mini-infra nats allowlist add ...`) for ergonomics, or punt entirely.
6. **JWT-propagation mechanism (§1.3)**: full resolver vs. `SIGHUP` reload vs. process restart. This is its own spike — needs to be answered before Phase 4 scope is finalized.

---

## 6. Risks

- **(Top risk) Live account JWT propagation (§1.3) is unsolved.** Without it, signers don't work — scope templates live inside the account JWT, and the current `resolver: MEMORY` setup doesn't hot-reload. This is the only thing in the plan that genuinely needs new infrastructure; everything else is a wiring exercise. Phase 0 exists explicitly to de-risk this.
- **Cryptographic correctness of scoped signing keys.** The "manager can't escape its sub-tree" guarantee rests on us configuring NATS scoped signing keys correctly *and* getting the propagation right. Both must be tested against a real NATS server, not mocked. Misconfiguration here is the worst-case bug class.
- **Concurrent applies across stacks.** Cross-stack imports resolve against the producer's applied version. If producer + consumer apply simultaneously and the producer's prefix changes, the consumer can write subscribe entries against a stale prefix. Mitigation: a global NATS-apply lock (Phase 5).
- **Validator surface area growth.** Each new section grows the validator. Keep checks colocated with the section types and lean on the existing pattern in `template-substitution-validator.ts`.
- **Backward compat with #320 / #322.** The vault-nats template and system stacks declaring `accounts`/`credentials` directly continue to work — those fields are unchanged. New surface is purely additive. The mixing rule (§2.5) prevents accidental coexistence within a single template.
- **Allowlist footguns.** Empty string, wildcards, `$SYS`, overlapping prefixes — all rejected at write time (§2.6). The CRUD-per-entry API (vs. blob PUT) prevents accidental wipes.
- **Audit blindness on signer-minted JWTs.** Mini-infra is intentionally blind once a seed is delegated (§2.1, decision summary). Server-side: NATS's own connection logs cover who connected with what JWT. App-side: the manager service is responsible for its own audit log if it needs one. Neither lives in mini-infra. This is acceptable for v1 but worth revisiting if a real compliance ask appears.

---

## 7. References

- Ideation conversation: this branch's session transcript.
- Slackbot reference: `slackbot-agent-sdk/manager/src/nats-jwt-minter.ts`, `shared/src/subjects.ts`.
- NATS scoped signing keys: https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro/jwt#scoped-signing-keys
- Prior planning doc style: [`docs/planning/shipped/stack-bundles-and-installer-improvements.md`](../shipped/stack-bundles-and-installer-improvements.md).
