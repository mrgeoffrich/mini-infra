# Systemic Error Handling — Typed Server Taxonomy and Actionable Client Messages

**Status:** planned, not implemented. Phased rollout — each phase ships as a separate PR.
**Builds on:** the `apiFetch` / `ApiRequestError` transport client and the global 401 handling shipped in [frontend-backend-contract-plan.md](./frontend-backend-contract-plan.md); the `toServiceError()` mapper in [server/src/lib/service-error-mapper.ts](../../../server/src/lib/service-error-mapper.ts) and the typed-error handling in [server/src/routes/nats.ts](../../../server/src/routes/nats.ts) are the in-repo models this generalises.
**Excludes:** the transport/route-registry/query-key contracts owned by the frontend-backend-contract plan — this plan adds only the error *semantics and presentation* layer on top.

---

## 1. Background

A production incident — a 409 on `POST /api/postgres/backup-configs/quick-setup` that surfaced as the toast "Failed to setup backup / Database configuration with name 'prod_postgres_db_kumiko' already exists" — turned out to be a symptom of a systemic, two-sided gap in how the app handles errors. On the server, ~96% of throws are raw `throw new Error("string")` (~488 sites); the central middleware ([server/src/lib/error-handler.ts](../../../server/src/lib/error-handler.ts)) only assigns a real HTTP status to `CustomError`/`ServiceError`, so raw errors default to 500 and routes instead re-derive status by brittle `error.message.includes(...)` string-matching across 7+ files, emitting at least 5 different JSON envelope shapes — none carrying a machine `code`, a resource reference, or a suggested next action. On the client, the well-built `ApiRequestError` (which already carries `status`, `code`, and the raw `body`) is thrown away: ~146 `onError` handlers hand-roll `toast.error("Failed to X", { description: error.message })` with no next step, and a `.code`-vs-`.message` split in the server responses forces ~5 pages to hand-roll workaround helpers.

The fix is not new transport infrastructure — that already exists. It is a typed error taxonomy plus one response envelope on the server, and one `getUserFacingError` / `toastApiError` presentation layer on the client, rolled out domain-by-domain behind the settled contract. After it lands, an error carries stable meaning end to end: the server says *what* failed and *what to do next*, and the client renders that as an actionable message instead of a raw sentence.

This is explicitly a multi-PR effort. The two foundation phases (server contract, then client presentation) land the convention and prove it on the postgres-backup flow that triggered the incident; the domain phases then fan out in parallel, each migrating one subsystem onto the established contract; a final phase locks the convention in with lint/CI guards so raw errors can't creep back.

*Rubric: all phases passed the 7-check rubric on the first pass with no re-splits. Each domain phase's Done-when is stated as a single end-to-end outcome; the "no string-matching remains / all onError routed" deliverables are enforced globally by Phase 11 rather than bundled into each Done-when, to keep the acceptance criterion single-clause.*

## 2. Goals

1. **Every server error carries stable meaning.** A thrown taxonomy error has a machine `code`, the correct HTTP status, and (where useful) a `resource` and a human `action` — with no route deriving status by string-matching a message.
2. **One envelope everywhere.** All error responses share a single shape, backward-compatible with the existing client extraction, so a caller can rely on the same fields regardless of which route failed.
3. **Users get a next step.** Failures render as an actionable, correctly-attributed message (title + description + optional action), not a raw server sentence or an opaque "Something went wrong".
4. **The client reads structure, not just strings.** The `.code`-vs-`.message` split is reconciled in one place, the ~5 workaround helpers are gone, and no bare-message toasts remain.
5. **Regressions are blocked mechanically.** A lint/CI guard rejects new raw `throw new Error` in services and bare `toast.error(error.message)` in the client.

## 3. Non-goals

- **Internationalized / localized error messages.** Copy stays English-only; no localization framework. Keeps the message helper a pure mapping with no locale plumbing.
- **Re-architecting the `apiFetch` request path, route registry, or query-key contracts.** Those are the frontend-backend-contract plan's surface. This plan touches `client/src/lib/api-client.ts` *only* to fix the `ApiRequestError` `.code`/`.message` extraction; it does not change the request pipeline, envelope-unwrap, or the path/query-key registries.

## 4. Shared contracts

Four contracts are referenced by every phase and are defined once here so the phases don't each re-invent them.

### 4.1 Error codes — `lib/types/error-codes.ts`

Codes are dependency-free string constants in the zero-dep `@mini-infra/types` package, shared by client and server. Naming rule: `SCREAMING_SNAKE`, shaped `<DOMAIN>_<REASON>`.

```ts
// lib/types/error-codes.ts — no runtime deps (per the lib zero-external-dependency invariant)
export const ErrorCode = {
  POSTGRES_DB_CONFIG_EXISTS: "POSTGRES_DB_CONFIG_EXISTS",
  POSTGRES_BACKUP_CONFIG_EXISTS: "POSTGRES_BACKUP_CONFIG_EXISTS",
  STACK_NOT_FOUND: "STACK_NOT_FOUND",
  // …one per known failure case, added by the phase that needs it.
  INTERNAL: "INTERNAL", // the 500 fallback for un-typed / programmer-error throws
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
```

### 4.2 Server taxonomy — extends `CustomError` (`server/src/lib/error-handler.ts`, plus `server/src/lib/errors.ts`)

The existing `CustomError` gains `code` and optional `resource` / `action` / `details`; a small set of subclasses fix the status per class so services never pass a raw number.

```ts
interface AppErrorShape {
  statusCode: number;
  isOperational: true;                                  // so the central middleware maps it
  code: ErrorCode;                                      // machine code, §4.1
  resource?: { type: string; id?: string; name?: string };
  action?: string;                                      // human next-step hint
  details?: unknown;                                    // structured detail (e.g. Zod issues)
}

class ConflictError    extends CustomError {} // 409
class NotFoundError     extends CustomError {} // 404
class ValidationError   extends CustomError {} // 400  (folds in today's Zod `details`)
class UnauthorizedError extends CustomError {} // 401
class ForbiddenError    extends CustomError {} // 403
```

Genuine internal invariants (programmer errors that *should* be 500) keep throwing a plain `Error` / a dedicated `InternalError`; the Phase 11 lint rule carries an escape hatch for these so correctness bugs aren't laundered into 4xx.

### 4.3 The response envelope — emitted by the central middleware

One shape for every error, backward-compatible with the client's current `extractMessage` (reads `body.message`) and `extractCode` (reads `body.error`):

```jsonc
{
  "error":    "POSTGRES_BACKUP_CONFIG_EXISTS", // machine code (was: an ad-hoc label or the human string)
  "message":  "kumiko already has a backup configuration.", // human, English
  "resource": { "type": "postgresBackupConfig", "name": "kumiko" },
  "action":   "Edit the existing backup config instead of creating a new one.",
  "details":  null,
  "requestId": "…",
  "timestamp": "…"
}
```

`message` stays the human string and `error` stays a string, so nothing on the client breaks; the change is that `error` now holds a stable `code` and `resource`/`action`/`details` are additive.

### 4.4 Client presentation — `client/src/lib/errors.ts`

```ts
function getUserFacingError(err: unknown): { title: string; description: string; action?: string };
//  - reads ApiRequestError.code / .status / body.resource / body.action
//  - reconciles the .code (machine) vs .message (human) split so BOTH server response
//    shapes resolve to the right human text (fixes the ~5 workaround pages)
//  - falls back by status class when no code match: 409 → "Already exists",
//    403 → "Not allowed", 404 → "Not found", 5xx → "Server error — try again".

function toastApiError(err: unknown, opts?: { title?: string }): void;
//  - getUserFacingError(err) → sonner toast (description + optional action button/link)
```

**Global wiring (decided — global default + opt-out).** Mutation errors are toasted by a single `MutationCache.onError` on the app `QueryClient` (extending the existing 401 handler in `client/src/lib/query-client.ts`) that calls `toastApiError` by default. A site opts out with `useMutation({ meta: { skipErrorToast: true } })` when it renders the error inline or handles it bespoke. Consequence for Phases 3–10: they mostly **delete** hand-rolled `onError` toasts rather than rewrite them, adding the opt-out only where a site needs custom/inline handling.

## 5. Phased rollout

The foundation is deliberately split **server (Phase 1) then client (Phase 2)**: they define two *different* contracts (the response envelope vs. the presentation helper), so they're two concerns and two PRs, and the client genuinely depends on the server shipping `code`/`action` first. From Phase 3 on, each phase merely *applies* the settled contract to one domain, so those phases span both sides as a single concern and **fan out in parallel** — they're designed to be handed to independent (Sonnet) agents, one per domain, each fully briefed by §4. Phase 11 gates on all of them.

### Phase 1 — Server error taxonomy + one envelope

**Goal:** Thrown taxonomy errors get their status and machine code from the central middleware, and the postgres-backup path is the server-side reference (correctly attributing the incident's conflict).

Deliverables:
- `CustomError` (in `server/src/lib/error-handler.ts`) extended with `code`, optional `resource`/`action`/`details`; subclasses `ConflictError`/`NotFoundError`/`ValidationError`/`UnauthorizedError`/`ForbiddenError` in `server/src/lib/errors.ts` (§4.2).
- `lib/types/error-codes.ts` — the `ErrorCode` const map (§4.1), seeded with the postgres codes and `INTERNAL`.
- The central middleware emitting the single envelope (§4.3) for any thrown taxonomy error, with the raw-`Error` path still defaulting to a 500 `INTERNAL`.
- `postgres-database-manager` and the quick-setup route throwing `ConflictError`/`NotFoundError` with `resource` + `action`; the `postgres-backup-configs` route's `error.message.includes("already exists")` status mapping removed.
- Correct attribution of the quick-setup duplicate as a backup-config conflict (`POSTGRES_BACKUP_CONFIG_EXISTS`), not a raw "database configuration" error.
- Integration-test coverage of the middleware envelope and the quick-setup 409.

Reversibility: safe — additive taxonomy plus a backward-compatible envelope (`message`/`error` stay top-level strings); a plain PR revert restores prior behaviour.

UI changes: none

Schema changes: none

Done when: An integration test asserts a duplicate Quick Setup Backup returns HTTP 409 with the envelope `{ error: "POSTGRES_BACKUP_CONFIG_EXISTS", message, resource, action }` produced by the central middleware.

Verify in prod: postgres conflict/not-found responses carry a machine `code` + `resource` + `action` in their bodies (observable in logs/network) and no longer return 500.

### Phase 2 — Client actionable-error presentation

**Goal:** `getUserFacingError`/`toastApiError` exist and the Quick Setup Backup flow renders through them as the client reference — resolving the reported incident's toast.

Deliverables:
- `client/src/lib/errors.ts` — `getUserFacingError(err)` (§4.4) mapping `code`/`status`/`resource`/`action` into `{ title, description, action? }` and reconciling the `.code`-vs-`.message` split.
- `toastApiError(err, { title? })` over sonner, with an optional action affordance.
- A global `MutationCache.onError` on the app `QueryClient` (`client/src/lib/query-client.ts`) that calls `toastApiError` by default, with a `meta.skipErrorToast` opt-out (extends the existing 401-only cache handler — §4.4).
- The quick-backup-setup modal and `use-postgres-backup-configs` hooks routed through `toastApiError` (or relying on the global default), replacing the hand-rolled `catch`; the postgres-area `.code` workaround removed.
- Unit tests for `getUserFacingError` across representative codes and status classes.
- `client/ARCHITECTURE.md` error-handling/canonical-hook section documenting the `toastApiError` pattern.

Reversibility: safe — additive client helper; only the reference flow is routed through it, every other site keeps its hand-rolled toast until its domain phase.

UI changes:
- The Quick Setup Backup failure toast becomes actionable — it names the existing backup config and offers to edit it, instead of restating "…already exists" [design needed] (establishes the reusable title/description/action toast pattern).

Schema changes: none

Done when: A unit test proves `getUserFacingError` turns a 409 `ApiRequestError` carrying a `code` and `action` into a `{ title, description, action }` result.

Verify in prod: the Quick Setup Backup failure shows an actionable toast naming the existing config and offering to edit it — the reported incident is resolved.

### Phase 3 — Stacks, applications & deployments

**Goal:** The stack/application/deployment domain surfaces typed, actionable errors end to end.

Deliverables:
- Stack, application, and deployment services throw taxonomy errors (`ConflictError`/`NotFoundError`/`ValidationError`/…) with new `ErrorCode.*` entries, `resource`, and `action`, replacing raw `throw new Error` (incl. `TemplateError` and the blue-green paths).
- The stacks/applications route files carry no `error.message.includes(...)` status mapping.
- The domain's client `onError`/`catch` sites routed through `toastApiError`.
- (Orientation — key surfaces: `server/src/services/**/stack-template-service.ts`, `routes/stacks-crud-routes.ts`, application + deployment services; `client/src/hooks/use-stacks.ts`, `use-applications.ts`, deployment hooks.)

Reversibility: safe — behaviour-preserving migration onto the settled contract; some errors change 500→4xx (a correctness fix), still cleanly revertable per PR.

UI changes:
- Error toasts across the stacks/applications/deployments pages gain actionable, correctly-attributed messages [no design].

Schema changes: none

Done when: Triggering the domain's canonical conflict/not-found action (e.g. applying a stack that doesn't exist, or a duplicate application create) yields an actionable, correctly-attributed message instead of a raw 500 or opaque string.

Verify in prod: the domain's known conflict/not-found failures surface as typed 4xx with actionable toasts, and its 500-rate for those cases drops.

### Phase 4 — Environments & Docker networks

**Goal:** The environment and network domain surfaces typed, actionable errors end to end.

Deliverables:
- Environment and docker-network services throw taxonomy errors with new `ErrorCode.*` entries, `resource`, and `action` (incl. replacing the `.includes('Unique constraint')` Prisma-string match on the environments route).
- The environments/networks route files carry no message-string status mapping.
- The domain's client `onError`/`catch` sites routed through `toastApiError`.
- (Orientation — key surfaces: `server/src/services/**/environment-manager.ts`, docker-network services, `routes/environments.ts`; `client/src/hooks/use-environments.ts`, `use-networks.ts`.)

Reversibility: safe — behaviour-preserving migration onto the settled contract; per-PR revert is clean.

UI changes:
- Error toasts across the environments and networks pages gain actionable, correctly-attributed messages [no design].

Schema changes: none

Done when: Triggering the domain's canonical conflict/not-found action (e.g. creating an environment with a duplicate name) yields an actionable, correctly-attributed message instead of a raw 500 or opaque string.

Verify in prod: the domain's known conflict/not-found failures surface as typed 4xx with actionable toasts, and its 500-rate for those cases drops.

### Phase 5 — Certificates, TLS, ACME & DNS

**Goal:** The certificate/TLS/DNS domain surfaces typed, actionable errors end to end.

Deliverables:
- Certificate-lifecycle, renewal-scheduler, ACME, and DNS services throw taxonomy errors with new `ErrorCode.*` entries, `resource`, and `action`, replacing raw `throw new Error` (incl. the "Certificate not found" and "Invalid cron expression" sites).
- The certificate/TLS/DNS route files carry no message-string status mapping.
- The domain's client `onError`/`catch` sites routed through `toastApiError`.
- (Orientation — key surfaces: `server/src/services/**/certificate-lifecycle-manager.ts`, `certificate-renewal-scheduler.ts`, `acme/`, DNS/Cloudflare services; `client/src/hooks/use-certificates.ts`, `use-cert-issuance.ts`, `use-tls-settings.ts`, DNS hooks.)

Reversibility: safe — behaviour-preserving migration onto the settled contract; per-PR revert is clean.

UI changes:
- Error toasts across the certificates, TLS, and DNS pages gain actionable, correctly-attributed messages [no design].

Schema changes: none

Done when: Triggering the domain's canonical conflict/not-found action (e.g. issuing against a missing certificate id) yields an actionable, correctly-attributed message instead of a raw 500 or opaque string.

Verify in prod: the domain's known conflict/not-found failures surface as typed 4xx with actionable toasts, and its 500-rate for those cases drops.

### Phase 6 — NATS

**Goal:** The NATS domain surfaces typed, actionable errors end to end (finishing what `routes/nats.ts` started).

Deliverables:
- NATS services throw taxonomy errors with new `ErrorCode.*` entries (folding the existing `NatsIdentityError` and friends into the taxonomy so the middleware — not the route — maps status and echoes the code).
- The NATS route files carry no bespoke per-error status mapping beyond the central middleware.
- The domain's client `onError`/`catch` sites routed through `toastApiError`.
- (Orientation — key surfaces: `server/src/routes/nats.ts`, `nats-identity-errors.ts`, NATS control-plane/apply services; `client/src/hooks/use-nats.ts`.)

Reversibility: safe — behaviour-preserving migration onto the settled contract; per-PR revert is clean.

UI changes:
- Error toasts across the NATS pages gain actionable, correctly-attributed messages [no design].

Schema changes: none

Done when: Triggering the domain's canonical conflict/not-found action (e.g. a NATS apply that references a missing account/role) yields an actionable, correctly-attributed message instead of a raw 500 or opaque string.

Verify in prod: the domain's known failure cases surface as typed 4xx with actionable toasts, and its 500-rate for those cases drops.

### Phase 7 — Containers, images & volumes

**Goal:** The Docker execution surface (containers, images, volumes) surfaces typed, actionable errors end to end.

Deliverables:
- Container/image/volume services throw taxonomy errors with new `ErrorCode.*` entries, `resource`, and `action`, replacing raw `throw new Error` and folding the `toServiceError()` Docker mapping into the taxonomy where it overlaps.
- The images/containers/volumes route files carry no message-string status mapping.
- The domain's client `onError`/`catch` sites routed through `toastApiError` (incl. `ContainerTable.tsx`, which today discards the real error behind a generic string).
- (Orientation — key surfaces: `server/src/services/**/docker.ts`, `routes/images.ts`, volume services; `client/src/hooks/use-container-actions.ts`, `use-volumes.ts`, `app/containers/ContainerTable.tsx`.)

Reversibility: safe — behaviour-preserving migration onto the settled contract; per-PR revert is clean.

UI changes:
- Error toasts across the containers, images, and volumes pages gain actionable, correctly-attributed messages [no design].

Schema changes: none

Done when: Triggering the domain's canonical conflict/not-found action (e.g. an action on a missing container, or a duplicate image tag) yields an actionable, correctly-attributed message instead of a raw 500 or opaque string.

Verify in prod: the domain's known conflict/not-found failures surface as typed 4xx with actionable toasts, and its 500-rate for those cases drops.

### Phase 8 — HAProxy

**Goal:** The HAProxy domain surfaces typed, actionable errors end to end.

Deliverables:
- HAProxy (frontend/backend/server/instance + data-plane) services throw taxonomy errors with new `ErrorCode.*` entries, `resource`, and `action`, replacing raw `throw new Error`.
- The HAProxy route files (incl. the manual and shared frontend routes) carry no message-string status mapping.
- The domain's client `onError`/`catch` sites routed through `toastApiError`.
- (Orientation — key surfaces: `server/src/routes/haproxy-frontends.ts`, `manual-haproxy-frontends.ts`, HAProxy data-plane services; `client/src/hooks/use-haproxy-remediation.ts` and HAProxy hooks.)

Reversibility: safe — behaviour-preserving migration onto the settled contract; per-PR revert is clean.

UI changes:
- Error toasts across the HAProxy pages gain actionable, correctly-attributed messages [no design].

Schema changes: none

Done when: Triggering the domain's canonical conflict/not-found action (e.g. a migration against a missing frontend) yields an actionable, correctly-attributed message instead of a raw 500 or opaque string.

Verify in prod: the domain's known conflict/not-found failures surface as typed 4xx with actionable toasts, and its 500-rate for those cases drops.

### Phase 9 — API keys, users, auth & permissions

**Goal:** The auth domain surfaces typed, actionable errors end to end — and its endpoints stop putting human text in the `error` field.

Deliverables:
- API-key, user, auth, and permission services throw taxonomy errors with new `ErrorCode.*` entries, `resource`, and `action`, replacing raw `throw new Error` (incl. the "API key not found or not owned by user" and permission-preset sites).
- The auth route files carry no message-string status mapping and emit the standard envelope (so human text is in `message`, machine code in `error`).
- The `.code` workaround helpers on the setup/recover/change-password/users/authentication pages removed now that extraction is centralized.
- The domain's client `onError`/`catch` sites routed through `toastApiError`.
- (Orientation — key surfaces: `server/src/lib/api-key-service.ts`, `routes/api-keys.ts`, users routes, `routes/permission-presets.ts`; `client/src/hooks/use-api-keys.ts`, `app/settings/users/page.tsx`, `app/setup/**`, `app/recover/**`, `app/change-password/**`, `app/settings/authentication/**`.)

Reversibility: safe — behaviour-preserving migration onto the settled contract; per-PR revert is clean.

UI changes:
- Error toasts and inline messages across the API-keys, users, and auth pages gain actionable, correctly-attributed messages, and the auth pages stop showing raw HTTP status text [no design].

Schema changes: none

Done when: Triggering the domain's canonical conflict/not-found action (e.g. a duplicate API-key name, or acting on a key not owned by the user) yields an actionable, correctly-attributed message instead of a raw 500, opaque string, or bare HTTP status text.

Verify in prod: auth/api-key failures surface as typed 4xx with actionable messages (no bare status text), and the domain's 500-rate for these cases drops.

### Phase 10 — Vault, secrets, egress & remaining surfaces

**Goal:** The remaining subsystems (Vault/secrets, egress, storage, backup execution, self-update, monitoring) surface typed, actionable errors end to end.

Deliverables:
- Vault/secrets, egress, storage, backup-execution, self-update, and monitoring services throw taxonomy errors with new `ErrorCode.*` entries, `resource`, and `action`, folding the already-typed `storage-service` codes and `VaultHttpError`/`EgressGatewayError`/`CryptoError` classes into the taxonomy.
- These subsystems' route files carry no message-string status mapping.
- Their client `onError`/`catch` sites routed through `toastApiError` (incl. the bare `toast.error(error.message)` sites in `use-self-update`, `use-agent-settings`, `use-vault`).
- (Orientation — key surfaces: Vault/secrets services, `storage-service.ts`, egress services, `backup-executor.ts`, `self-update.ts`, monitoring; `client/src/hooks/use-vault.ts`, `use-self-update.ts`, `use-agent-settings.ts`, egress hooks.)

Reversibility: safe — behaviour-preserving migration onto the settled contract; per-PR revert is clean.

UI changes:
- Error toasts across the Vault, secrets, egress, self-update, and monitoring surfaces gain actionable, correctly-attributed messages [no design].

Schema changes: none

Done when: Triggering a canonical failure in these subsystems (e.g. a Vault operation while sealed, or a self-update precondition failure) yields an actionable, correctly-attributed message instead of a raw 500 or opaque string.

Verify in prod: these subsystems' known failure cases surface as typed 4xx with actionable toasts, and their 500-rate for those cases drops.

### Phase 11 — Enforcement guards + convention lock-in

**Goal:** Raw errors and bare-message toasts can't come back.

Deliverables:
- An ESLint rule (or CI grep-guard) banning raw `throw new Error(...)` in `server/src/services/**`, requiring a taxonomy error — with a documented escape hatch (`InternalError`/assert helper) for genuine programmer-error invariants.
- An ESLint rule banning bare `toast.error(error.message)` / `toast.error(…, { description: error.message })` in `client/src/**`, requiring `toastApiError`.
- A CI check that no route file contains `error.message.includes(` for status mapping.
- Removal of any residual inconsistent envelope shapes or `.code` workarounds missed by the domain phases.
- `server/CLAUDE.md` and `client/CLAUDE.md` updated with the error-handling conventions.

Reversibility: safe — lint config + CI guard plus a doc edit; revert removes the gate.

UI changes: none

Schema changes: none

Done when: The lint/CI guard banning raw `throw new Error` in `server/src/services` and bare `toast.error(error.message)` in `client/src` passes clean across the repo.

Verify in prod: n/a — internal only.

## 6. Risks & open questions

- **Global auto-toast vs. per-site — DECIDED: global default + opt-out.** A `MutationCache.onError` calls `toastApiError` by default; sites opt out via `useMutation({ meta: { skipErrorToast: true } })` when they render errors inline or handle them bespoke (wired in Phase 2 — §4.4). Phases 3–10 therefore mostly *delete* hand-rolled toasts rather than rewrite them. Residual risk to watch during migration: double-toasts where a site both keeps a local toast and inherits the global one, and the handful of sites that show inline errors rather than toasts (those get the opt-out).
- **500→4xx is a behaviour change.** Some monitoring/alerting may key off status codes or the old message strings. Each domain PR should note the reclassification in release notes.
- **Not every raw throw should become 4xx.** Genuine internal invariants must keep returning 500; the taxonomy and the Phase 11 lint rule need a clean escape hatch so correctness bugs aren't laundered into client-friendly 4xx.
- **Transition safety for the `.code` workaround pages.** The ~5 pages that read `.code` today must keep working until their domain phase (9) removes the workaround; sequence the extraction fix so they don't regress in between.
- **Zod `details` already exist** in `validationErrorMessage`; fold that into `ValidationError.details` rather than leaving a parallel path.
- **Class name confirmation.** The transport plan drafted the client error class as `ApiError`; the shipped code uses `ApiRequestError`. Confirm the actual name when wiring `getUserFacingError`.

## 7. Phase tracking

Manual checklist — check a box when that phase's PR merges. `[blocks-by: …]` encodes the dependency graph: Phase 1 → Phase 2, then the domain phases fan out in parallel off Phase 2, and Phase 11 gates on all of them.

- [ ] Phase 1: Server error taxonomy + one envelope
- [ ] Phase 2: Client actionable-error presentation  [blocks-by: 1]
- [ ] Phase 3: Stacks, applications & deployments  [blocks-by: 2]
- [ ] Phase 4: Environments & Docker networks  [blocks-by: 2]
- [ ] Phase 5: Certificates, TLS, ACME & DNS  [blocks-by: 2]
- [ ] Phase 6: NATS  [blocks-by: 2]
- [ ] Phase 7: Containers, images & volumes  [blocks-by: 2]
- [ ] Phase 8: HAProxy  [blocks-by: 2]
- [ ] Phase 9: API keys, users, auth & permissions  [blocks-by: 2]
- [ ] Phase 10: Vault, secrets, egress & remaining surfaces  [blocks-by: 2]
- [ ] Phase 11: Enforcement guards + convention lock-in  [blocks-by: 3, 4, 5, 6, 7, 8, 9, 10]
