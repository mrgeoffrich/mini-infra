# Stack Bundles & External-Installer Improvements

This document is a forward-looking design exploration prompted by the slackbot-agent-sdk integration. It pairs the friction list in `slackbot-agent-sdk/docs/mini-infra-installer-future.md` (written from the installer side) with what we actually have today inside mini-infra (written from this side), and proposes a coherent set of improvements to the stack/template/vault subsystems.

It is **not** a list of tickets. Most proposals here build on primitives that already exist; the work is mostly exposing and unifying them rather than inventing new mechanics. The header for each proposal calls out how much is genuinely new code vs. wiring of existing pieces.

A bug-fix companion plan covered issues #237–#242 (shipped in #243); this doc is the next step beyond that — what should the surface look like once the bugs are gone?

---

## 1. Background — why is the slackbot installer interesting?

The slackbot-agent-sdk wants to ship itself as a mini-infra-managed application: a stack template plus the Vault policies, AppRoles, and shared KV secrets it depends on, plus the four custom container images it builds locally. Today its installer is a 686-line Node script ([`environment/install-mini-infra.ts`](../../slackbot-agent-sdk/environment/install-mini-infra.ts)) running 8 sequential stages:

1. reachability (mini-infra + vault)
2. `docker build` four images
3. `docker push` four images
4. create/update Vault policies (one per AppRole) and publish each
5. create/update Vault AppRoles bound to those policies and apply each
6. write KV secrets directly to Vault (logs in via mini-infra-operator userpass to get a token)
7. create or draft+publish the stack template, then instantiate it, then PUT to backfill `mini-infra-stack-id`
8. apply the stack and poll `/status` every 3s for up to 5 minutes

The script works. But almost everything it does — Vault policies, AppRoles, KV secrets, template publishing — is something mini-infra **already does internally** for its built-in stacks (haproxy, postgres, vault, etc.). The seeder reads JSON template files from `server/templates/*/template.json` ([`builtin-stack-sync.ts:30`](../server/src/services/stacks/builtin-stack-sync.ts:30)), wires up policies and AppRoles, and applies the result. From that angle, **a built-in stack is exactly the kind of bundle the slackbot installer is reinventing**, just hard-coded into the server binary.

The headline opportunity is to take the bundle format that already lives at `server/templates/*/template.json` and let users POST one. Most other items on the list either fall out of that or close small specific gaps (template context, per-service AppRole binding, KV read injection).

The slackbot is a useful forcing function because it's the first non-trivial **third-party** application built on mini-infra. A handful of gaps that didn't matter when only system stacks existed (no scoped KV API, partial template context, no streaming apply) become real once external authors are doing the same dance.

---

## 2. What we already have

Before proposing additions, an honest inventory of the primitives in place. Several of these are 70%-built — the proposals below mostly finish the wiring rather than start fresh.

### Templates and bundles

- **Versioned templates with draft/publish lifecycle** ([`stack-template-service.ts:121`](../server/src/services/stacks/stack-template-service.ts:121)). Drafts are mutable; published versions are immutable and numbered. A re-draft + re-publish produces a new version on the same template.
- **System templates as JSON files** loaded at startup ([`builtin-stack-sync.ts:30`](../server/src/services/stacks/builtin-stack-sync.ts:30), [`template-file-loader.ts:62`](../server/src/services/stacks/template-file-loader.ts:62)). The schema at `server/templates/{haproxy,vault,postgres,...}/template.json` is **already a bundle format** — services, networks, volumes, parameters, resourceInputs/Outputs, configFiles. It just doesn't yet carry policies/AppRoles/KV alongside the template.
- **`builtinVersion` field** on each system template — bumping it triggers a re-publish on next boot. This is the version semantics we need for user bundles too.

### Vault

- Admin token cached and (post #237 fix) self-renewing in [`vault-admin-service.ts:111`](../server/src/services/vault/vault-admin-service.ts:111).
- Policies and AppRoles managed via REST with draft/publish-style apply (`POST /vault/policies/:id/publish`, `POST /vault/approles/:id/apply`).
- **Per-service AppRole binding columns already exist in the DB** — `Stack.vaultAppRoleId`, `StackService.vaultAppRoleId`, `StackTemplateService.vaultAppRoleId` ([`schema.prisma:1086, 1198, 1390`](../server/prisma/schema.prisma)). What's missing is the resolver actually preferring the service-level binding over the stack-level one when both are set.
- `GET /api/vault/operator-credentials` returns a userpass account the installer can use to log in to Vault directly. This works as the bridge today; it's also the smell that says we should be brokering KV instead.
- No `POST /api/vault/kv` route. Direct Vault HTTP is the only path.

### DynamicEnv resolver

- Discriminated union with four kinds today ([`stacks.ts:45`](../lib/types/stacks.ts:45)): `vault-addr`, `vault-role-id`, `vault-wrapped-secret-id`, `pool-management-token`. Resolved at apply time in [`vault-credential-injector.ts:50`](../server/src/services/vault/vault-credential-injector.ts:50).
- Fail-closed degradation logic already in place (return cached role_id when Vault is briefly unreachable). New resolvers should adopt the same pattern.

### Template substitution context

- Engine already builds a richer context than the validation regex permits. [`template-engine.ts:56`](../server/src/services/stacks/template-engine.ts:56) constructs `{ params, stack: { name, projectName }, volumes, networks }`. But the schema regex at [`schemas.ts:11`](../server/src/services/stacks/schemas.ts:11) only matches `{{params.key-name}}`, so any template using `{{stack.name}}` is rejected at validation time. The engine is ready; the regex is the gate.

### Stack apply

- Async fire-and-forget today via `POST /api/stacks/:id/apply` returning HTTP 200 immediately ([`stacks-apply-route.ts:35`](../server/src/routes/stacks/stacks-apply-route.ts:35)). Reconciliation runs in the background and emits Socket.IO events on `Channel.STACKS` per service action. A blocking/streaming variant doesn't exist; callers either poll or run a Socket.IO client.

### Pool services

- Generated tokens hashed with argon2id, rotated when the `managedBy` service is recreated ([`pool-management-token.ts:30`](../server/src/services/stacks/pool-management-token.ts:30)). Plaintext is only seen by the `managedBy` service via dynamicEnv injection. There's no introspection endpoint for "when was this last rotated".

### API surface and SDK

- Consistent response envelope `{ success, data?, message?, issues? }` across all routes.
- Strongly-typed Zod schemas in `@mini-infra/types` shared with the client.
- No published SDK. External tools rebuild the envelope wrapper themselves — slackbot's [`mini-infra-api.ts`](../../slackbot-agent-sdk/environment/install/mini-infra-api.ts) is 52 lines that mostly re-derive what `@mini-infra/types` could give them.

---

## 3. Proposals

Each proposal is sized as **S/M/L** (rough effort) and tagged with how much is new mechanism vs. wiring. Priority is in §4.

### A. Stack Bundles — packaging template + policies + AppRoles + KV in one resource

**Size: L. Mostly composition.** This is the headline change.

**Problem.** The slackbot installer's 8 stages are an external orchestrator doing what the seeder does internally for system stacks. Each stage tracks state across calls (policy IDs, AppRole IDs, template ID, stack ID), each has its own delete endpoint for rollback, and a partial failure leaves dangling objects the user must clean up by hand.

**Design sketch.**

A bundle is a single document — same JSON schema as `server/templates/*/template.json` today, extended with optional sibling sections for the resources a template implicitly depends on:

```yaml
apiVersion: mini-infra/v1
kind: StackBundle
metadata:
  name: slackbot
  version: 3            # bundle author's version, monotonically increasing
  description: ...
spec:
  template:             # exactly today's template.json, no changes required
    name: slackbot
    scope: environment
    services: [...]
    parameters: [...]
    networks: [...]
    volumes: [...]
    resourceInputs: [...]
    resourceOutputs: [...]
  vault:
    policies:           # HCL bodies, by name
      - name: slackbot-manager
        body: |
          path "secret/data/shared/slack" { capabilities = ["read"] }
      - name: slackbot-worker
        body: |
          ...
    appRoles:           # bound to policies above by name
      - name: slackbot-manager
        policy: slackbot-manager
        tokenPeriod: 1h
        secretIdNumUses: 0
      - name: slackbot-worker
        policy: slackbot-worker
        tokenPeriod: 1h
    kv:                 # KV writes the bundle owns
      - path: shared/slack
        fields:
          bot_token: { fromInput: slackBotToken }
          app_token: { fromInput: slackAppToken }
      - path: shared/anthropic
        fields:
          api_key: { fromInput: anthropicApiKey }
  inputs:               # values the operator must supply at install time
    - name: slackBotToken
      sensitive: true
      description: "Slack bot user OAuth token (xoxb-...)"
    - name: anthropicApiKey
      sensitive: true
```

Endpoints:

```
POST /api/stack-bundles                  # ingest a bundle, no apply
POST /api/stack-bundles/:name/apply      # apply (transactional, idempotent)
GET  /api/stack-bundles                  # list
GET  /api/stack-bundles/:name            # current state, version, derived objects
DELETE /api/stack-bundles/:name          # tear down all derived objects
```

`apply` semantics:

- **Transactional within a single bundle apply.** Either every derived object lands successfully or the whole apply rolls back. Failures leave the previously-applied bundle version in place (i.e. the system never moves to a partial new state).
- **Idempotent across applies.** Re-POSTing the same bundle version is a no-op. POSTing a higher version reconciles the diff: drafts a new template version, publishes it, updates policies/AppRoles, writes new KV values, then re-applies the stack with the new template version.
- **Apply order is fixed and internal:** policies → AppRoles (now that policies exist) → KV writes (now that any apply-time validation can happen) → template draft+publish → stack instantiate (or update parameter values on existing stack) → stack apply.

**DRY notes.**

- The bundle schema **is** the system template schema with a wrapper. Reuse [`template-file-loader.ts`](../server/src/services/stacks/template-file-loader.ts) for the inner template parsing — no new schema duplication.
- Policy/AppRole creation reuses the existing services. The bundle controller is a thin orchestrator that calls them in order. No new HCL-rendering or AppRole-minting logic.
- Make the seeder for system stacks **a special case of the bundle pipeline** rather than a parallel codepath. `builtin-stack-sync.ts` becomes "load each `server/templates/*/template.json` as a bundle, mark `source: system`, apply via the same controller". This is the single biggest DRY win — system and user bundles converge on one codepath, and any new bundle-level feature (transactional rollback, drift detection, version diffing) lights up for built-in stacks too without duplicate work.

**Open questions.**

- How does the bundle handle the `inputs` re-bind on an upgrade? When applying v3 over v2, should we silently reuse the v2 input values (stored encrypted), prompt the user, or require explicit `--input slackBotToken=...` flags? Strawman: stored, reused by default; bundle author can mark an input `rotateOnUpgrade: true` to require a fresh value.
- What's the audit story for KV writes performed by the bundle? They should appear in the events log with `triggeredBy: bundle:slackbot:v3`.
- Bundle deletion order is policies/AppRoles/KV last, after stacks are torn down. But what about cross-bundle dependencies? Strawman: refuse to delete a bundle if any other bundle's stack uses its outputs (resourceOutputs already model this for stacks).

**Permission scope.** New `bundles:read` and `bundles:write`. The bundle controller internally uses elevated privileges (admin Vault token) so the API key only needs `bundles:write`, not the union of all the underlying scopes. This is the same pattern as `stacks:write` already implying "I can ask the server to do Docker things".

### B. Expand the template substitution context — let `{{stack.id}}`, `{{stack.name}}`, `{{env.X}}` resolve

**Size: S. Wiring only.**

**Problem.** Templates need the stack's database CUID inside an env var so the running app can call `POST /api/stacks/:stackId/pools/...`. Today the slackbot template declares an empty-default `mini-infra-stack-id` parameter and the installer does a follow-up PUT to set it after instantiate. Three round-trips for one substitution that mini-infra already knows.

The engine already builds a `stack.{name,projectName}` context. The validation regex blocks anything other than `{{params.*}}` from passing through. So the user-visible feature is missing for a strictly-smaller reason than implementing it would suggest.

**Design sketch.**

1. Widen the regex in [`schemas.ts:11`](../server/src/services/stacks/schemas.ts:11) to allow `{{<namespace>.<key>}}` for an enumerated set of namespaces: `params`, `stack`, `env`, `volumes`, `networks`. Keep the single-token rule (no concatenation) — that's a useful constraint and the engine relies on it.
2. Extend the engine context at [`template-engine.ts:30`](../server/src/services/stacks/template-engine.ts:30) to include `stack.id` and an `env` object (environment name, type, networkType, id).
3. Add a bundle-time validator that fails if a template references `{{stack.id}}` but is host-scoped (no environment), or `{{env.id}}` on a host-scoped template, or any reference whose namespace key doesn't exist in the context.

**DRY notes.**

- Reuse the existing `templateStringPattern` regex; just generalize it.
- The validator runs in the same pre-publish step as today's parameter validation.

**Open questions.**

- Should `stack.id` be available at the **template** level (i.e. before instantiate) or only at **apply** time? Apply time is fine because dynamicEnv resolves at apply, and string interpolation in service definitions is also at apply (post-#238 fix). Template authoring shows `{{stack.id}}` literally; instantiate doesn't need to substitute it.
- Should we expose `{{vault.addr}}` here, or leave that to the existing `vault-addr` dynamicEnv? Probably leave it — keeping vault references in dynamicEnv keeps the audit/cred path separate from the substitution path.

### C. `vault-kv` dynamicEnv kind — read KV at apply, inject as env

**Size: S. One new resolver branch.**

**Problem.** Most slackbot services need exactly one or two static secrets at boot (slack-gateway wants `secret/shared/slack.bot_token`). Teaching them the wrapped-secret-id flow + AppRole login + KV read just to fetch one value is a lot of code per service. The "one unified policy across all services" workaround in the slackbot installer is partly because every service runs the same Vault client code, so any service that touches Vault needs the union of all read paths.

**Design sketch.**

New dynamicEnv kind:

```yaml
dynamicEnv:
  SLACK_BOT_TOKEN:
    kind: vault-kv
    path: shared/slack
    field: bot_token
```

Resolver: read at apply time using the admin token (mini-infra already has it), substitute the env value, inject into the container. A fresh apply re-reads. A bundle re-apply triggered by a KV update re-reads. No client SDK in the service.

**Trade-off vs. AppRole flow.**

- Apply-time read = secret is **frozen at the apply moment**. Updating KV requires another apply to propagate. This is the right behaviour for boot-time secrets that don't rotate often.
- Services that need fresher reads, or that enumerate multiple paths, keep using AppRole. The two patterns coexist; bundle authors pick per-service.

**Audit and rotation.**

- Mini-infra logs the read against the admin token in Vault audit, plus an event in the mini-infra events log (`vault:kv-read for service X path Y`).
- Rotating a value: bump the KV version (Vault KV v2), trigger a stack apply. Could later add a "watch KV path → trigger apply on change" mode, but explicit reconcile-on-apply is fine to start.

**Security notes.**

- Resolver must redact the value from the resolved-definition trace (we already redact secrets in container env logs; check that's covered).
- Permission scope: a bundle author adding a `vault-kv` env doesn't grant the running container a Vault token at all. The container only sees the resolved value. This is strictly **safer** than the current AppRole flow for static secrets.

**DRY notes.**

- Single new branch in [`vault-credential-injector.ts:50`](../server/src/services/vault/vault-credential-injector.ts:50). Reuse the existing fail-closed degradation logic — if Vault is briefly unreachable on apply, fail the apply (don't run a service with a missing secret).

### D. Per-service AppRole binding — let the resolver consume what the schema already exposes

**Size: S. Resolver change.**

**Problem.** The slackbot uses one unioned `navi-slackbot` policy with read access to all KV paths because mini-infra's resolver only consumes `Stack.vaultAppRoleId` today. The original design wanted per-service policies (manager reads `shared/anthropic`, slack-gateway reads `shared/slack`, worker reads `users/*`) for least-privilege isolation. The installer's policy file even comments this as a deliberate workaround.

The schema **already** has `StackService.vaultAppRoleId` ([`schema.prisma:1198`](../server/prisma/schema.prisma:1198)) and `StackTemplateService.vaultAppRoleId` ([`schema.prisma:1390`](../server/prisma/schema.prisma:1390)). The columns were added in anticipation of this. The injector just needs to prefer the service-level binding when set.

**Design sketch.**

In [`vault-credential-injector.ts:50`](../server/src/services/vault/vault-credential-injector.ts:50): when resolving dynamicEnv for a service, if `service.vaultAppRoleId` is non-null, use that AppRole; otherwise fall back to `stack.vaultAppRoleId`. The fail-closed degraded mode applies per-service in the same way (cached role_id keyed by AppRole, not by stack).

Bundle/template authoring (after A): each `services[].vaultAppRoleRef: <name>` references an AppRole name from the bundle's `vault.appRoles`. Bundle controller resolves the name to an ID at apply time and writes it to `StackTemplateService.vaultAppRoleId`.

**DRY notes.**

- No new schema, no new endpoints. The change is "look one column to the left" inside a single resolver.
- The cached role_id table needs to key by AppRole ID (which it already does). Verify the cache eviction story handles a stack swapping a service's AppRole binding without leaving stale entries — almost certainly already correct, but worth a test.

**Open questions.**

- Should we still allow Stack-level binding as a default, or require per-service? Strawman: keep stack-level as the fallback (it's still the common case for small stacks), per-service overrides when set.

### E. Brokered Vault KV API — `POST /api/vault/kv` with scoped permission

**Size: S. Thin shim over admin token.**

**Problem.** The installer logs in to Vault as mini-infra-operator to write KV. It works, but it means the installer has to know the **user-facing Vault address** (which is different in worktree mode), needs `vault:read` to even fetch the operator credentials, and gets no audit attribution beyond "mini-infra-operator wrote KV" — we lose the API key identity.

After **A** (bundles), the installer no longer writes KV directly because the bundle declares it. But the brokered route is still useful for:
- One-off operational writes ("rotate this token without redeploying anything").
- External tools that don't yet use bundles.
- Bundle KV writes themselves — the bundle controller calls this internally.

**Design sketch.**

```
POST   /api/vault/kv     { path, data: { ... } }       # scope: vault:kv-write
GET    /api/vault/kv/:path                              # scope: vault:kv-read
DELETE /api/vault/kv/:path                              # scope: vault:kv-write
PATCH  /api/vault/kv/:path  { data: { ...partial } }   # KV v2 patch
```

Mini-infra brokers using its admin token. Audit log includes the API key identity that called it.

**Permission additions.** New `vault:kv-read` and `vault:kv-write` scopes, narrower than today's `vault:admin`. Add to the Editor preset (kv-write), Reader preset (kv-read).

**DRY notes.** The KV writer used by the bundle controller (proposal A) is the same module the route handler uses. Single source of truth for KV interactions with Vault.

### F. Streaming/blocking apply — `POST /api/stacks/:id/apply?wait=jsonl`

**Size: S. New route shape, reuse emitter.**

**Problem.** The slackbot installer polls `/status` every 3s for up to 5 minutes. Polling loses fidelity (you don't see "manager pulled image" or "haproxy frontend rebuilt") and burns the 5-minute timeout on slow image pulls. The Socket.IO events are richer but adding a Socket.IO client to a one-shot Node script is heavy.

**Design sketch.**

Two modes via query param:

- `?wait=true` (or `?wait=result`) — server holds the connection and returns the apply result as a single JSON body when reconciliation finishes. Same shape as the final `stack:apply:completed` event.
- `?wait=jsonl` — server streams JSON-lines, one per Socket.IO event, and closes the connection after `stack:apply:completed`. Same shape as the events on the wire.

Implementation: route handler subscribes to `Channel.STACKS` filtered by stackId, pipes events through res.write(JSON.stringify(...) + '\n'), closes on the completed event.

**DRY notes.** No new emitter, no new event shapes — the Socket.IO event payloads become the JSONL line format. One new helper for "subscribe and pipe to res", which is also useful for any future SSE-style endpoint.

**Open questions.**

- SSE vs. JSONL? SSE has built-in `EventSource` support in browsers, JSONL is easier from curl/Node fetch. Strawman: support both via `Accept` header (`text/event-stream` → SSE, `application/x-ndjson` → JSONL, default to JSON single-body).
- Long-poll timeout: cap at, say, 15 minutes for the wait-result variant. JSONL has no cap (the connection stays open until completion).

### G. Pool token introspection — `GET /api/stacks/:id/pools/:svc/management-token-meta`

**Size: S.**

**Problem.** The pool token rotates on every recreate of the `managedBy` service. The plaintext only reaches the manager via dynamicEnv. The installer's reachability check can't validate "the manager will be able to talk to the pool API" before applying — it has to apply, then trust.

**Design sketch.**

```
GET /api/stacks/:stackId/pools/:serviceName/management-token-meta
  → { rotatedAt, scope, lastUsedAt? }
```

No plaintext readback (mini-infra holds the only legitimate copy). Just enough metadata to confirm the dynamicEnv resolved and the manager picked it up.

Stretch: `lastUsedAt` requires recording every pool API call's auth-method timestamp. Useful for spotting "the manager hasn't called us in 10 minutes, is it healthy?" but adds a write per request. Skip in v1.

**DRY notes.** Single route, single Prisma read (the existing `StackService.poolManagementTokenHash` row already has the metadata; just don't return the hash).

### H. Image build endpoint — `POST /api/images/build`

**Size: M. Genuinely new.**

**Problem.** Slackbot's installer shells out to `docker build` against `$DOCKER_HOST`. For worktree dev this means the user has to know which colima profile to target. For CI, this means mounting `/var/run/docker.sock` into the runner.

**Design sketch.**

```
POST /api/images/build
{
  source: { kind: 'git', repo: '...', ref: '...' },
  dockerfile: 'manager/Dockerfile',
  context: '.',
  imageName: 'slackbot-manager',
  tag: 'v3.1.0'
}
→ 202 Accepted, returns buildId
```

Mini-infra clones (or fetches a cached clone), runs BuildKit, pushes to its local registry. Streams progress via Socket.IO on `Channel.IMAGES`. Returns the resolved registry tag (e.g. `localhost:5101/slackbot-manager:v3.1.0`) on completion.

**Trade-off.** This is **genuinely new** (vs. most other proposals which are wiring), and it's lower priority than the others. Most users have docker locally and the build phase is fast. The main payoff is CI environments where mounting docker.sock is awkward, and dev worktrees where colima profile selection is fiddly.

**Skip if.** The bundle (proposal A) accepts a list of pre-built `ghcr.io/...` image references. Bundle authors who already publish to a public registry don't need the build endpoint at all. The "build inside mini-infra" path is for closed-source, locally-built images.

**Open questions.**

- Source kinds: git is obvious; do we also want `tar` (POST a tarball) for "build this directory I have locally"? Strawman: yes, a `multipart/form-data` upload variant.
- Caching: BuildKit has a cache; is mini-infra responsible for cleaning it? Probably yes, with a configurable retention.
- Auth for private git: out of scope for v1; require public repos or pre-baked source tarballs.

### I. `@mini-infra/sdk` — generated TypeScript client

**Size: M. Mostly mechanical.**

**Problem.** Every external tool (slackbot, future tools) re-implements the same fetch wrapper, envelope parsing, error typing. Slackbot's [`mini-infra-api.ts`](../../slackbot-agent-sdk/environment/install/mini-infra-api.ts) is 52 lines that mostly re-derive what `@mini-infra/types` could give them.

**Design sketch.**

Publish `@mini-infra/sdk` as an npm package. Two layers:

1. **Envelope + auth wrapper.** A typed `MiniInfraClient` that accepts `{ baseUrl, apiKey }` and exposes `.get<T>(path)`, `.post<T>(path, body)`, etc., with envelope unwrapping and `MiniInfraApiError` typing. ~80 lines.
2. **Resource clients.** `client.stacks.list()`, `client.stacks.get(id)`, `client.bundles.apply(name)`, etc., generated from existing Zod schemas in `@mini-infra/types`. Use the same generation step we already run for the OpenAPI-style docs (or introduce one — see below).

**DRY notes.**

- The envelope wrapper exists three times today: in the client, in `@mini-infra/types` consumers, and in slackbot's installer. SDK consolidates.
- Generated resource clients should derive from a single source: route handlers' Zod request/response schemas. We don't have a route schema registry today — adding one is a precondition for codegen and is independently useful (validation, OpenAPI export).

**Skip-or-defer call.** Lower priority than A–E because every consumer can write their own wrapper. But the line count is small and the maintenance benefit compounds across users.

### J. Non-interactive Vault bootstrap — `POST /api/vault/bootstrap` with passphrase in body

**Size: S.**

**Problem.** The installer's reachability check special-cases "Vault not initialised" and bails with "go to the UI". The bootstrap is interactive (operator chooses a passphrase) and not scriptable.

**Design sketch.**

`POST /api/vault/bootstrap` already exists. Today it requires the operator to be at the UI to receive the unseal keys + admin secret_id (one-time-viewable). Make the same endpoint usable from automation by accepting:

```
POST /api/vault/bootstrap
{
  passphrase: '...',
  acknowledgeOneTimeReadback: true   # caller affirms it will store the response
}
→ 200 { unsealKeys: [...], adminRoleId, adminSecretId, operatorPassword }
```

For orchestrated installs (bundle apply on a fresh mini-infra), the response is captured by the orchestrator. For UI users, the existing flow is unchanged.

**Audit and safety.**

- Single-shot: subsequent calls return 409. No way to re-bootstrap a live Vault.
- Response is logged in the events stream as "vault bootstrapped" with no plaintext.
- Strongly recommend pairing with **A** (bundle apply) — the bundle controller can lazily trigger bootstrap if it gets `initialised: false`, prompting the orchestrator for a passphrase exactly once.

---

## 4. Suggested rollout order

The dependencies between proposals form a small graph:

```
B (template context)  ──┐
D (per-service AppRole) ─┤
C (vault-kv dynamicEnv)  ┼──> A (bundles, the real prize)
E (brokered KV API)     ─┤
J (non-int bootstrap)   ─┘

F (streaming apply)  ──> independent, useful for any caller, not a bundle prereq
G (pool token meta)  ──> independent
I (SDK)              ──> independent, lower priority
H (image build)      ──> independent, optional / nice-to-have
```

**Phase 1 — Close the small specific gaps.** B, D, C, E. Each is small, independently shippable, and each removes a specific workaround in the existing slackbot installer. After this phase, the installer is shorter and cleaner but still 8 stages.

**Phase 2 — Bundles.** A. The big composition step that turns the 8-stage orchestrator into a single POST. Lands cleanly because the underlying primitives (B/D/C/E from phase 1) are already in place. **Make `builtin-stack-sync.ts` use the bundle controller** so system and user stacks converge.

**Phase 3 — Operational quality of life.** F (streaming apply), G (pool meta), J (non-interactive bootstrap), I (SDK). Independent, can be done in any order. Drop H (image build) unless a real CI use case shows up.

**Why this order.** A in isolation is awkward — a bundle resource that still has to do per-service workarounds for things like `{{stack.id}}` and per-service policies is a half-feature. Doing the small unlocks first means the bundle resource lands with a clean authoring story. It also de-risks A by spreading the change across multiple smaller commits that each have an obvious test surface.

**Don't bundle these into one PR.** Each of B, D, C, E should be a separate change with its own test. A is itself a multi-PR feature: schema + ingest, then apply controller, then re-platforming `builtin-stack-sync.ts` onto it.

---

## 5. Out of scope / non-goals

A few things adjacent to this work that are intentionally not on the list:

- **A bundle marketplace / public registry.** Once bundles exist, the question of "where do users find them" is real, but it's a UI/distribution problem that should happen after we have at least one external bundle (slackbot) running through the system. Premature.
- **Replacing `@mini-infra/types` with OpenAPI as the source of truth.** The Zod-first approach works and the client/server already share types. SDK generation can read Zod directly without an OpenAPI hop.
- **Multi-cluster / multi-host bundles.** Bundles target one mini-infra instance. Cross-host federation is a separate, much larger conversation.
- **Helm/Kustomize compatibility.** The bundle format is shaped by what mini-infra needs (services, vault, KV) and what its existing template format already supports. It's not trying to be a Kubernetes manifest. A future "import from Helm chart" tool is conceivable but isn't a goal of the bundle work itself.
- **Encrypting bundle KV inputs at rest in the bundle file.** Sealed-secret style. Useful but outside the v1 scope; for now bundles take secrets via inputs at apply time, and operators provide them through the same channel they provide other API inputs.
- **Reverting the slackbot installer's manual stages.** Out of scope here, but the obvious follow-up: once A lands and the slackbot publishes a bundle, the installer collapses to ~50 lines that POST one document. That work happens in slackbot-agent-sdk, not here.

---

## 6. Open architectural questions

A few things worth deciding before phase 2:

1. **Bundle name uniqueness scope.** Per-host? Per-environment? Strawman: bundle names are host-global (like template names today). Re-applying with a different scope/environment is an error.
2. **Bundle and Application abstraction overlap.** Mini-infra has the "Application" concept (UX layer over a stack). Should an installed bundle automatically materialize as an Application? Strawman: yes, if the bundle declares a single user-facing service or a `displayService` field. The Application listing in the UI is then the natural place to see "I have slackbot v3 installed".
3. **Bundle outputs as inputs to other bundles.** Like resourceOutputs/Inputs on stacks today. Probably yes long-term (the slackbot would consume haproxy's tunnel URL output as an input), but not necessary for v1 — the slackbot consumes it via the existing stack-level mechanism.
4. **Should the bundle controller be a server-side singleton, or per-bundle workers?** Strawman: singleton with operation-locks per bundle name (mirrors how stack apply locks per stack ID today).
