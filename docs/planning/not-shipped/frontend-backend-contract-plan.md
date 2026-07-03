# Typed Frontend↔Backend Contract — Eliminating HTTP Magic Strings and Hardening Connectivity

**Status:** planned, not implemented. Phased rollout — each phase ships as a separate PR.
**Builds on:** the review in [docs/designs/frontend-backend-contract-strategy.md](../../designs/frontend-backend-contract-strategy.md), and the existing `Channel.*`/`ServerEvent.*` contract in [lib/types/socket-events.ts](../../../lib/types/socket-events.ts) and the `describeRoute()` engine in [server/src/lib/describe-route.ts](../../../server/src/lib/describe-route.ts).
**Excludes:** the Socket.IO real-time layer itself — it is already the exemplary contract and is not re-architected here (see §3).

---

## 1. Background

The client and server meet at exactly one typed contract — `@mini-infra/types` (`lib/`) — and for real-time events and permissions that contract is excellent, but for everything about HTTP it is absent. The client makes ~340 raw `fetch()` calls with **no** shared client wrapper, hardcodes ~260 distinct `/api/...` path literals that the server independently re-declares (~200 of its own), scatters 551 inline TanStack `queryKey` arrays with no factory, and hand-rolls the `{success,data}` envelope 414 times. Errors are classified by string-matching (`error.message.includes("401")`), there are **zero** request timeouts anywhere, and the socket has no reconnection config or user-visible connection state. On the server, the `describeRoute()`/OpenAPI contract engine already exists but only 1 of 65 route modules uses it, and 384 `res.json()` calls are untyped. The fix is not new infrastructure: it is extending two proven local patterns — `socket-events.ts` on the shared side (which already ships runtime constants with zero external deps) and `describeRoute()` on the server side — to cover the HTTP surface, so that renaming a route becomes a compile error instead of a runtime 404, and the client↔server link degrades gracefully instead of hanging.

This plan delivers that in ten independently-shippable phases, each scoped to one PR, with CI drift-checks so the shared contract cannot rot.

## 2. Goals

1. **One typed client.** Every client→server call goes through a single `apiFetch` wrapper — one place for credentials, headers, correlation-ID, timeout, typed errors, and envelope unwrapping — with a lint guard preventing raw `fetch` from creeping back.
2. **One source of truth for paths.** Every `/api` path is a compile-checked constant in `@mini-infra/types`, verified against the live Express routes by a CI drift-check, so client and server can never silently disagree.
3. **One source of truth for cache keys.** TanStack query keys come from a shared factory, eliminating the casing-mismatch invalidation bugs that exist today.
4. **Responses typed end-to-end.** Server `res.json()` bodies are validated and typed against shared schemas, and the client infers the same response types — response-shape drift is caught in CI, not in production.
5. **Robust connectivity.** Requests time out, auth-expiry is handled globally, a dropped socket is visible and self-heals, and a cold start with the backend down shows "waiting for server" instead of an error.
6. **Server RBAC references the shared catalog.** Permission gating uses `Permission.*` constants rather than raw `"resource:action"` scope strings.

## 3. Non-goals

- **Replacing / re-architecting Socket.IO.** The real-time channel/event layer is already the exemplary shared contract (`Channel.*`/`ServerEvent.*`). Re-working it adds risk for no gain; this plan *models itself on* it, it doesn't touch it.
- **Full OpenAPI-spec-to-client codegen.** The codebase's convention is hand-authored shared types plus `describeRoute()`. A generated-client pipeline is heavier tooling the team hasn't adopted and would fight the existing `lib` build order; we grow typed responses through `describeRoute()` instead.
- **Pulling Zod (or any runtime dep) into `@mini-infra/types`.** The lib's zero-external-dependency invariant is load-bearing across its three module-resolution paths. Zod schemas stay in `server/`/`client/`; only inferred types and dependency-free constants are shared.
- **A client-side base-URL / multi-origin scheme.** Same-origin + the Vite proxy already work; only *paths* need centralising, not origins.
- **A big-bang rewrite of all 78 hooks in one PR.** Migration is incremental and batchable per resource area behind the primitives (Phase 4), not a single mega-change.

## 4. Shared contracts

These four contracts are referenced by ≥2 phases and are defined once here so the phases don't each re-invent them. All follow the `socket-events.ts` idiom: `as const` value-maps, `satisfies`-guarded, parameterized builders for dynamic segments, and a flat `ALL_*` array to power a CI drift-check.

### 4.1 Route registry — `lib/types/api-routes.ts` (Phases 2, 4, 9)

```ts
export const ApiRoute = {
  containers: {
    list:   ()           => `/api/containers`,
    get:    (id: string) => `/api/containers/${id}`,
    action: (id: string) => `/api/containers/${id}/action`,
  },
  stacks: {
    list:    ()           => `/api/stacks`,
    apply:   (id: string) => `/api/stacks/${id}/apply`,
    destroy: (id: string) => `/api/stacks/${id}/destroy`,
  },
} as const;

// Flat, param-normalised — the source of truth for the CI drift-check.
export const ALL_API_ROUTES = [
  { method: "GET",  path: "/api/containers" },
  { method: "GET",  path: "/api/containers/:id" },
  { method: "POST", path: "/api/containers/:id/action" },
  // …
] as const;
```

### 4.2 Typed client — `client/src/lib/api-client.ts` + `lib/types/http.ts` (Phases 1, 4, 5)

```ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string,
              message: string, readonly body?: unknown) { super(message); }
  get isAuth()   { return this.status === 401; }
  get isServer() { return this.status >= 500; }
}

export async function apiFetch<T>(path: string, opts?: ApiOptions): Promise<T>;
// credentials + HttpHeader.* + newCorrelationId() + AbortSignal.timeout(default)
// → throws ApiError on non-2xx → unwraps {success,data} envelope once.
```

Header names and `newCorrelationId()` live in `lib/types/http.ts` (replacing the 35 local copies).

### 4.3 Query-key factory — `lib/types/query-keys.ts` (Phases 3, 4)

```ts
export const queryKeys = {
  containers: {
    all:    ["containers"] as const,
    list:   (f: ContainerFilters) => ["containers", "list", f] as const,
    detail: (id: string)          => ["containers", "detail", id] as const,
  },
} as const;
```

### 4.4 The `describeRoute()` engine (Phase 9)

Already built (`server/src/lib/describe-route.ts` + `openapi-registry.ts`): `describe(method, path, meta, ...handlers)` registers the route, auto-injects `requirePermission(meta.permission)`, records request/response Zod schemas into the OpenAPI registry, and feeds `/api/openapi.json` + `/api/routes`. Phase 9 grows its adoption; the inferred request/response types are what the client `apiFetch<T>` consumes.

## 5. Phased rollout

Phases are numbered in recommended execution order; running them in numeric order is a valid strictly-sequential execution. The `[blocks-by: …]` edges in §7 show the true dependency graph — Phase 1 is the foundation, and the connectivity line (5–8), the typed-response migration (9), and the permission cleanup (10) depend only on Phase 1, so they can fan out in parallel with the magic-string line (2→4) once Phase 1 lands. No phase changes the database schema.

### Phase 1 — Typed API client primitive

**Goal:** A single typed `apiFetch` client exists and the containers resource fetches through it as the reference implementation.

Deliverables:
- `lib/types/http.ts` — header-name constants (`HttpHeader.ContentType`, `HttpHeader.CorrelationId`), shared envelope-type helpers, and a `newCorrelationId()` helper (replacing the 35 local copies).
- `client/src/lib/api-client.ts` — `apiFetch<T>()` (credentials, headers, correlation-ID, `AbortSignal.timeout` default, JSON body handling), the `ApiError` class (status/code/body + `isAuth`/`isServer`), and a single envelope-unwrap that returns `data` or throws `ApiError`.
- The `useContainers` hook migrated to `apiFetch` as the canonical pattern.
- A unit-test suite for `apiFetch`/`ApiError`.
- `client/ARCHITECTURE.md`'s "canonical hook" section updated to the `apiFetch` shape.

Reversibility: safe — additive; only the containers hook is switched, every other hook keeps its raw `fetch` until Phase 4.

UI changes: none

Schema changes: none

Done when: A unit test proves `apiFetch` throws a typed `ApiError` carrying the HTTP status on any non-2xx response.

Verify in prod: n/a — internal only (container-list behaviour unchanged).

### Phase 2 — Shared route registry + drift-check

**Goal:** Every `/api` path comes from one compile-checked registry, verified against the live server routes.

Deliverables:
- `lib/types/api-routes.ts` — `ApiRoute` parameterized builders + the flat `ALL_API_ROUTES` array (§4.1).
- Server route mounts and the containers reference routes sourcing paths from the registry instead of string literals.
- A CI test that boots the Express app, runs `express-list-endpoints`, and asserts the live route set equals `ALL_API_ROUTES`.
- `API-ROUTES.md` generated from `ALL_API_ROUTES` (replacing the hand-maintained 594-line doc) plus a `pnpm` regenerate script.
- The containers reference hook switched to `ApiRoute.containers.*`.

Reversibility: safe — additive registry; route literals are swapped for equivalent constants and the drift-check is the only new gate.

UI changes: none

Schema changes: none

Done when: A CI test asserts the live Express route set exactly equals `ALL_API_ROUTES` in `@mini-infra/types`.

Verify in prod: n/a — internal only (no new 404s after routes reference the registry).

### Phase 3 — Shared query-key factory

**Goal:** TanStack query keys come from a single factory rather than inline arrays.

Deliverables:
- `lib/types/query-keys.ts` — the `queryKeys` factory grouped by resource (§4.3), typed `as const`.
- The containers reference hook sourcing every query and invalidation key from `queryKeys.containers.*`.
- A unit test for the factory shape.

Reversibility: safe — keys are internal; the reference resource migrates, the rest follow in Phase 4.

UI changes: none

Schema changes: none

Done when: The containers hook sources every query key and invalidation from `queryKeys.containers.*`, verified by a factory unit test.

Verify in prod: n/a — internal only.

### Phase 4 — Migrate the client onto the contract

**Goal:** No client hook constructs a raw request, URL, or query key by hand.

Deliverables:
- All remaining resource hooks (~77) migrated to `apiFetch` + `ApiRoute` + `queryKeys`.
- The 414 hand-rolled `.success` envelope checks removed (unwrapping happens once in `apiFetch`).
- The 249 inline `x === "status-literal"` comparisons replaced with the shared string-union types/constants from `@mini-infra/types`.
- The 11 unconditional-poll hooks brought under the `refetchInterval = connected ? false : ms` convention (polling hygiene folded into the same edits).
- `client/src/api/egress.ts` folded onto the shared primitives (its 10 copy-pasted fetch skeletons removed).
- An ESLint guard banning, in `client/src` outside the api-client/registry: raw `fetch(`, `/api` string literals, unfactored inline `queryKey` arrays, and unconditional `refetchInterval` while the socket is connected.

Reversibility: safe — behaviour-preserving mechanical migration; may land as batched PRs per resource area with the ESLint guard flipped on in the final batch.

UI changes: none

Schema changes: none

Done when: The client-hooks ESLint guard (no raw `fetch`, no `/api` literal, no unfactored query key, no unconditional poll while socket-connected) passes clean across `client/src`.

Verify in prod: Client error/exception rate stays flat or drops after rollout, with every resource page loading normally.

### Phase 5 — Global HTTP resilience

**Goal:** Auth-expiry and transient failures are handled once, globally, off the typed `ApiError`.

Deliverables:
- A `QueryCache`/`MutationCache` `onError` on the single `QueryClient` that, on `ApiError.isAuth`, invalidates auth-status and redirects to `/login` exactly once.
- A typed global retry policy keyed off `ApiError` (retry network/5xx with backoff; never retry 4xx).
- Confirmation of the `apiFetch` request-timeout default (from Phase 1) and its interaction with the retry policy.

Reversibility: safe — centralises behaviour that today is per-hook or absent; revertable as one PR.

UI changes:
- On session expiry, any page redirects to the login screen promptly (previously up to a 5-minute delay) [no design] — reuses the existing login route.

Schema changes: none

Done when: A simulated 401 from any TanStack query triggers exactly one redirect to `/login`.

Verify in prod: Reports of "stuck/blank pages after being logged in a while" drop to zero; auth telemetry shows prompt redirects on 401.

### Phase 6 — Socket resilience & reconnection UI

**Goal:** A dropped socket connection is visible to the user and recovers deliberately.

Deliverables:
- Explicit `reconnection`/`reconnectionAttempts`/backoff config and a `connect_error` handler in `client/src/hooks/use-socket.ts`.
- A global "reconnecting to server…" banner driven by the existing `connected` state, shown app-wide.

Reversibility: safe — additive socket config plus one banner component.

UI changes:
- A global connection banner appears when the live connection drops and clears on reconnect [design needed].

Schema changes: none

Done when: Dropping the socket connection surfaces a global "reconnecting" banner that clears automatically on reconnect.

Verify in prod: During a server restart/deploy, users see the reconnecting banner (stale data is no longer silent) and reconnect succeeds without a manual refresh.

### Phase 7 — Connectivity-indicator correctness

**Goal:** The connected-service indicators distinguish "not yet known" from "down".

Deliverables:
- A single shared hook for the four-service connectivity fan-out, replacing the duplication across `use-all-services-status.ts` and `site-header.tsx`.
- Indicator states that render "unknown/checking" distinctly from "connected"/"down", so an empty or failed connectivity fetch no longer reads as red.

Reversibility: safe — display and hook-consolidation change.

UI changes:
- Service connectivity dots gain an "unknown/checking" state distinct from red "disconnected" [design needed].

Schema changes: none

Done when: With no connectivity row yet loaded, each service indicator renders an "unknown" state rather than red/"disconnected".

Verify in prod: Service indicators no longer flash red on cold page load before the first connectivity check lands.

### Phase 8 — Cold-start readiness gate

**Goal:** When the backend isn't up yet, the app waits for it instead of erroring.

Deliverables:
- A readiness gate that polls `/health` (auth-exempt) with backoff before mounting the auth gate.
- A "waiting for server" state replacing the auth-error-with-manual-reload on cold boot.

Reversibility: safe — boot-path UX addition; revertable as one PR.

UI changes:
- On cold start with the backend down, users see an auto-retrying "waiting for server" screen instead of an auth error [design needed].

Schema changes: none

Done when: With the backend down at page load, the app shows an auto-retrying "waiting for server" state instead of an auth error.

Verify in prod: During a deploy/restart, users hitting the app see "waiting for server" and auto-recover once `/health` is green — no manual reload.

### Phase 9 — Typed response contracts (rolling)

**Goal:** Server response bodies are validated and typed end-to-end, growing route-by-route from the existing `describeRoute()` engine.

Deliverables:
- `describeRoute()` adoption expanded beyond `/api/diagnostics`, starting with the containers reference resource: request + response Zod schemas beside the route, inferred response types exported to `@mini-infra/types`, and `res.json()` type-bound to the shared response type.
- Client `apiFetch<InferResponse<…>>` sourcing the response type from the shared contract for migrated resources.
- `warnOnRouteMetadataDrift()` promoted from a dev warning to a CI coverage ratchet over a growing `MIGRATED_ROUTE_PREFIXES`.

Reversibility: feature-flagged — adoption is per-route via `MIGRATED_ROUTE_PREFIXES`; response validation can be disabled per prefix without reverting the shared types.

UI changes: none

Schema changes: none

Done when: The CI coverage ratchet fails when any route under `MIGRATED_ROUTE_PREFIXES` lacks request/response contract metadata.

Verify in prod: `/api/openapi.json` coverage grows each release; response-shape mismatches surface in CI rather than as client runtime errors.

### Phase 10 — Server permission constants + doc refresh

**Goal:** Server permission gating references the shared catalog, not raw scope strings.

Deliverables:
- A `Permission` const map in `lib/types/permissions.ts`, `satisfies`-checked against `ALL_PERMISSION_SCOPES` (mirrors the `Channel` idiom).
- Every server `requirePermission("resource:action")` call switched to `requirePermission(Permission.*)`.
- An ESLint rule banning raw permission-scope string literals in `server/src`.
- `lib/CLAUDE.md` updated: drop the stale "types-only / no business logic" language; state the zero-external-runtime-dependency invariant explicitly.

Reversibility: safe — compile-checked string-for-constant swap plus a doc edit.

UI changes: none

Schema changes: none

Done when: Every server `requirePermission(...)` call references a `Permission.*` constant, enforced by an ESLint rule banning raw scope-string literals.

Verify in prod: n/a — internal only (RBAC decisions identical).

## 6. Risks & open questions

- **Response-validation strictness (Phase 9).** `server/CLAUDE.md` documents a real past bug where Zod's unknown-key stripping silently dropped `services[].vaultAppRoleRef` at the HTTP boundary. Response schemas must be permissive-by-default (`passthrough`) or the coverage ratchet will surface false failures — decide the strictness policy before expanding adoption.
- **Correlation-ID semantics (Phase 1).** Consolidating `newCorrelationId()` must preserve whatever the server reads from `X-Correlation-ID` for tracing. Confirm the header name/format the server logs key off before replacing the 35 copies.
- **`API-ROUTES.md` generation (Phase 2).** The hand-maintained doc carries per-route descriptions the registry doesn't hold. Decide whether `ApiRoute`/`ALL_API_ROUTES` carries a `description` field, or the generated doc is method+path only (losing the prose).
- **Batching vs the lint guard (Phase 4).** Migrating ~77 hooks is mechanical but large; batching by resource area keeps PRs reviewable, but the ESLint guard can only flip on once the last batch lands — interim batches rely on review discipline.
- **P7 vs P4 file overlap.** Phase 7 touches `use-all-services-status.ts`/`site-header.tsx` that Phase 4 also migrates; P7 is gated on P4 to avoid a double-touch, but if P4 is batched, those files should land in P4's final batch or be explicitly deferred to P7.
- **Socket handshake auth (Phase 6).** The socket relies on the httpOnly cookie via `withCredentials`; if the cookie is expired the socket fails silently. Decide whether P6's `connect_error` handler should also trigger the Phase 5 auth-redirect path.

## 7. Phase tracking

Manual checklist — check a box when that phase's PR merges. `[blocks-by: …]` encodes the dependency graph; numeric order is a valid sequential execution.

- [ ] Phase 1: Typed API client primitive
- [ ] Phase 2: Shared route registry + drift-check  [blocks-by: 1]
- [ ] Phase 3: Shared query-key factory  [blocks-by: 1]
- [ ] Phase 4: Migrate the client onto the contract  [blocks-by: 1, 2, 3]
- [ ] Phase 5: Global HTTP resilience  [blocks-by: 1]
- [ ] Phase 6: Socket resilience & reconnection UI  [blocks-by: 1]
- [ ] Phase 7: Connectivity-indicator correctness  [blocks-by: 4]
- [ ] Phase 8: Cold-start readiness gate  [blocks-by: 1]
- [ ] Phase 9: Typed response contracts (rolling)  [blocks-by: 2]
- [ ] Phase 10: Server permission constants + doc refresh  [blocks-by: 1]
