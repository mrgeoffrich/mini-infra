# Frontend ↔ Backend Contract Strategy

**Status:** Proposal / review
**Author:** Generated review (branch `claude/brisk-otter`)
**Scope:** How the client and server agree on API shape today, why it's brittle, and a phased strategy to push the contract into a shared, strongly-typed library and delete backend-dependent magic strings.

---

## 1. Executive summary

The two halves of Mini Infra meet at exactly one typed contract — `@mini-infra/types` (`lib/`) — and for **real-time events and permissions** that contract is excellent: every socket channel/event flows through `Channel.*`/`ServerEvent.*` constants (181 uses, 1 stray string, and that one is a doc comment). That is the pattern the whole app should be measured against.

For **everything else about HTTP** — URLs, query keys, response envelopes, error semantics, connection handling — there is no shared contract at all. Instead:

- **~340 raw `fetch()` calls** with **zero** shared client wrapper. The 4-line `credentials + headers + !response.ok` skeleton is copy-pasted everywhere; `generateCorrelationId()` is redefined **35 times**.
- **~260 hardcoded `/api/...` path literals** on the client and **~200** independently hardcoded on the server. Nothing links them — they drift silently.
- **551 inline `queryKey` arrays** across 80 files, **no factory**, and real invalidation bugs already exist (`postgresDatabases` vs `postgres-databases`).
- **414 hand-written `.success` envelope checks** and **249 `x === "status-literal"`** comparisons re-encoding server enums as bare strings.
- **Error handling by string-matching** (`error.message.includes("401")`) and **no request timeouts anywhere** (0 `AbortController`), so a slow backend hangs requests forever.
- On the server, **only 1 of 65 route modules** uses the already-built `describeRoute()`/OpenAPI contract infrastructure; **384 `res.json()`** calls are untyped.

The good news buried in the audit: **the machinery to fix this already exists and is proven in production.** `lib/` is not a types-only package — it already ships **60 runtime `const` maps + 13 functions** with zero external dependencies, across three working module-resolution paths. The server already has a `describeRoute()` system that emits OpenAPI 3.1 and auto-injects permission middleware. We are not building new infrastructure; we are **extending two existing, battle-tested patterns** (`socket-events.ts` on the shared side, `describeRoute()` on the server side) to cover the HTTP surface.

This document proposes a **single shared contract** in `@mini-infra/types` that both ends consume, delivered in six independently-shippable phases, plus CI drift-checks so the contract can't rot.

---

## 2. How the client and server interact today

```
        ┌──────────────────────── @mini-infra/types (lib/) ────────────────────────┐
        │  ✅ Channel.* / ServerEvent.*  (real-time contract — the good pattern)     │
        │  ✅ PERMISSION_GROUPS / PRESETS (shared catalog)                           │
        │  ✅ Domain models (ContainerInfo, StackInfo, …) — well shared              │
        │  ❌ No route paths   ❌ No query keys   ❌ No typed HTTP envelope binding   │
        └───────────────▲───────────────────────────────────────▲──────────────────┘
                        │ import type / const                    │ import type / const
        ┌───────────────┴───────────────┐       ┌────────────────┴───────────────────┐
        │  client/  (React + TanStack)   │       │  server/  (Express + Prisma)         │
        │                                │       │                                      │
        │  78 resource hooks, each:      │ HTTP  │  65 mounted route modules, each:     │
        │   • raw fetch(`/api/…`)  ──────┼──────▶│   • router.get("/…") + requirePerm() │
        │   • inline queryKey: […]       │ JSON  │   • ad-hoc zod on request (55/87)    │
        │   • hand-rolls {success,data}  │◀──────┼── • res.json(inline object literal)  │
        │   • error = message.includes() │       │   • 1/65 use describeRoute()         │
        └────────────────────────────────┘       └──────────────────────────────────────┘
             Socket.IO (same-origin, /socket.io, Vite-proxied) ── real-time push ──┘
```

**Transport.** Same-origin. Vite proxies `/api` and `/socket.io` to the backend (`localhost:5005` in dev) — the client never needs an absolute base URL, it just needs correct *paths*. Auth is an httpOnly cookie riding along via `credentials: "include"` (HTTP) and `withCredentials: true` (socket).

**Three contract layers, three maturity levels:**

| Layer | Mechanism | State |
|---|---|---|
| Real-time (channels/events) | `Channel.*` / `ServerEvent.*` in `socket-events.ts` | ✅ **Exemplary** — centralized, `satisfies`-checked, typed payloads |
| Permissions (RBAC scopes) | `PERMISSION_GROUPS` catalog in `permissions.ts` | ⚠️ **Half-applied** — client uses the catalog; server hardcodes `requirePermission("x:y")` at 400+ sites |
| HTTP (paths, keys, envelopes, errors) | *(none)* | ❌ **Absent** — everything is a magic string |

The strategy below is essentially: **make the HTTP layer look like the real-time layer.**

---

## 3. The problem, quantified

Every number below is from a direct audit of the current tree (branch `claude/brisk-otter`).

### 3.1 No shared HTTP client — copy-paste everywhere

| Metric | Count | Source of pain |
|---|---:|---|
| Raw `fetch()` call sites | ~340 (299 in hooks alone) | No place to add auth/tracing/retry/timeout |
| Central fetch wrapper | **0** | — |
| `axios` / other client | 0 | Native `fetch` only |
| `generateCorrelationId()` redefinitions | **35** | Same helper pasted per file |
| `"Content-Type"` literal | 250 | No header constants |
| `"X-Correlation-ID"` literal | 168 | " |
| Files repeating `if (!response.ok) throw` | 68 | Divergent error messages (see 3.4) |
| `.success` envelope checks | **414** | `{success,data,message}` unwrapped by hand 414× |
| Request timeouts (`AbortController`/`AbortSignal.timeout`) | **0** | A hung backend hangs the request indefinitely |

The de-facto "wrapper" (reference `client/src/hooks/useContainers.ts:41-47`):

```ts
const response = await fetch(url.toString(), {
  credentials: "include",
  headers: { "Content-Type": "application/json", "X-Correlation-ID": correlationId },
});
if (!response.ok) throw new Error(`Failed to fetch containers: ${response.statusText}`);
```

`client/src/api/egress.ts` is the *only* file that pulls fetch logic out of hooks into a typed per-domain module — a good organisational step — but it still copy-pastes that same skeleton across all 10 of its functions and redefines `generateCorrelationId` (the 35th copy). It's a symptom of the missing primitive, not a solution.

### 3.2 Hardcoded URL paths — the headline magic string

| Metric | Count |
|---|---:|
| Distinct `/api/...` path literals (client) | ~220–260 (379 total occurrences) |
| Distinct `/api/...` path literals (server mounts + routers) | ~200 |
| Shared route constants (`API_BASE`, path builders, registry) | **0** |

Paths are built two ways, both hardcoded, e.g. `client/src/hooks/use-stacks.ts`:
```ts
new URL("/api/stacks", window.location.origin)         // :44
fetch(`/api/stacks/${stackId}/apply`, ...)             // :154
```
The server independently declares the *same* strings in `server/src/app-factory.ts:143` (`{ path: "/api/containers" }`) and in each router. **Nothing checks that the two lists agree.** Rename a route on the server and the only signal is a 404 at runtime.

### 3.3 Query keys — 551 inline arrays, latent invalidation bugs

| Metric | Count |
|---|---:|
| Inline `queryKey:` sites | **551** across 80 files |
| Distinct key namespaces | 122 |
| Central key factories | 2 (tiny, local) |

The resource name is duplicated as *both* the query key (`["stacks"]`) and inside the URL (`/api/stacks`) with no shared source, and invalidation blocks are copy-pasted — e.g. the trio `["applications"] / ["userStacks"] / ["stacks"]` appears **6 times** in `use-applications.ts`. Worse, inconsistent casing has already produced silent cache bugs:

- `postgresDatabases` (camel, `use-postgres-backup-configs.ts`) vs `postgres-databases` (kebab, `use-managed-databases.ts`) — **different keys; invalidating one misses the other.**
- `haproxy-frontends` (11 uses) vs `haproxy-frontend` (6 uses).

### 3.4 Error semantics inferred from strings

There is no typed error. `client/src/lib/auth-context.tsx:71-126` classifies failures with `error.message.includes("401" | "403" | "429" | "500" | "Failed to fetch")`. But hooks throw *divergent* messages — `useContainers.ts:71` throws only `statusText`, so a 500 there is **never** recognised as a server error by the parser. The 68 hand-rolled throw sites guarantee the messages diverge. Retry predicates (`useContainers.ts:172`) match the same brittle strings.

### 3.5 Backend enums re-encoded as bare client strings

**249** comparisons of the form `field === "literal"` mirror server-side string unions in the UI — `status === "connected"`, `state === "complete"`, `networkType === "internet"`, `type === "production"`. These unions are defined server-side (and often already exported from `@mini-infra/types`), but the client re-types them inline, so a server-side rename is invisible to the compiler.

### 3.6 Server side — contract infrastructure exists but is unused

| Metric | Count |
|---|---:|
| Mounted route modules | 65 (single table, `app-factory.ts:137-221`) |
| Modules using `describeRoute()` | **1** (`diagnostics.ts`) |
| `MIGRATED_ROUTE_PREFIXES` | `["/api/diagnostics"]` |
| Files importing zod | 55 / 87 |
| `res.json()` calls | 384 |
| `res.json()` calls with a compile-checked `Response<T>` | **1** |
| `API-ROUTES.md` | 594 lines, hand/skill-maintained, drift-prone |

`server/src/lib/describe-route.ts` already gives a `describe(method, path, meta, ...handlers)` that (1) registers the route, (2) auto-injects `requirePermission(meta.permission)`, (3) registers request/response zod schemas into the OpenAPI registry, and (4) remembers compact route metadata. It feeds `GET /api/openapi.json` and `GET /api/routes`. A dev-only `warnOnRouteMetadataDrift()` guard already exists. **This is the server end of the exact contract we want — it's just only wired to 6 endpoints.**

### 3.7 Connectivity robustness gaps

The user explicitly asked for "more robust connectivity." Concrete weak spots found:

1. **No request timeouts** (0 `AbortController`) — a half-open backend spins every query forever; TanStack `retry`/`retryDelay` never fire because the promise never rejects.
2. **No global error handling** — no `QueryCache`/`MutationCache` `onError`. A 401/500 can't be handled in one place.
3. **Mid-session 401 is slow to surface** — data-query 401s don't redirect; the login redirect only fires when the separately-polled `useAuthStatus` (every 5 min) flips. Up to 5 minutes of broken pages after expiry.
4. **Socket has no reconnection config and no `connect_error` handler** (`use-socket.ts:40-50`) — it leans entirely on library defaults, surfaces nothing, and has **no global "disconnected/reconnecting" banner**. `connected` state exists (cleanly, via `useSyncExternalStore`) but is only used to gate polling.
5. **11 hooks poll unconditionally**, ignoring socket state, violating the project's own "no polling when socket connected" rule (`use-nats.ts:33`, `use-agent-status.ts:25`, `use-egress-fw-agent.ts:38`, `environments/[id]/page.tsx:60`, `containers/[id]/page.tsx:54`, … full list in §7 Phase 5).
6. **Connectivity indicators false-negative on empty data** — `site-header.tsx:108` reads `data?.data?.[0]?.status === "connected"`; a *failed connectivity fetch* or a cold start (no check run yet) is visually identical to a *down service* (red dot). The four-service fan-out is also duplicated in 3 places.
7. **No cold-start readiness gate** — `/health` exists and is auth-exempt (`app-factory.ts:301`) but the client uses it only for a version string. If the backend isn't up yet, the app shows an **auth error with a manual reload button** instead of an auto-retrying "waiting for server" state.

---

## 4. What's already good — the patterns to extend (don't reinvent)

The strategy is deliberately conservative: **copy what already works in this codebase.**

### 4.1 `socket-events.ts` — the template for shared string contracts

`lib/types/socket-events.ts` is the model. Its shape:

```ts
// 1. literal array + derived union
export const STATIC_SOCKET_CHANNELS = ["containers", "stacks", ...] as const;
export type StaticSocketChannel = (typeof STATIC_SOCKET_CHANNELS)[number];

// 2. named-constant map, compile-checked against the union via `satisfies`
export const Channel = {
  CONTAINERS: "containers",
  STACKS: "stacks",
} as const satisfies Record<string, StaticSocketChannel>;

// 3. parameterized builders for dynamic segments
export const ParameterizedChannel = {
  container: (id: string) => `container:${id}` as const,
};

// 4. runtime validator (server rejects arbitrary client strings)
export function isValidSocketChannel(ch: string): ch is SocketChannel { ... }

// 5. typed payload map keyed by the literal event name
export interface ServerToClientEvents { [ServerEvent.CONTAINER_UPDATED]: (p: ContainerUpdate) => void; ... }
```

Every ingredient we need for routes and query keys is here: **`as const` map + `satisfies` guard + parameterized builders + a flat array for drift-checking + typed payloads.**

### 4.2 `nats-subjects.ts` — the template for CI drift-checking

`nats-subjects.ts` maintains `ALL_NATS_SUBJECTS` (a flat array) specifically so CI can diff the TypeScript contract against a Go mirror. **This is exactly how we keep the shared route registry honest against the actual Express mounts** (§6).

### 4.3 `lib/` already holds runtime values — no new tooling needed

The single most important enabling fact: **`@mini-infra/types` is already a hybrid runtime package**, not types-only.

- 60 `export const` value-maps, 13 exported functions, **0 external dependencies**.
- Consumed by ~92 files across both apps through **three resolution paths** that all already carry runtime constants: typecheck → source `.ts` (tsconfig `paths`), client bundle → source (Vite alias), server runtime → built CJS (`dist/`, symlinked). Adding route paths / query keys / a `Permission` map is *zero-friction* — the `Channel` map already proves every path works.
- **Caveat:** `lib/CLAUDE.md` still says "types-only… no business logic." That's stale and must be updated as part of this work, or a reviewer will reject a route-registry PR on principle. Keep the genuine invariant — **zero external runtime dependencies** — intact (route paths and query keys need none; do **not** pull zod into `lib/`).

### 4.4 The server already has a contract engine

`describeRoute()` (§3.6) is the server end. We extend its adoption rather than inventing a parallel system, and we make it consume the *same* shared descriptors the client uses.

---

## 5. Target architecture

One principle: **define each endpoint once, in `@mini-infra/types`, and have both ends consume that definition.** No string is written twice.

```
                        @mini-infra/types (lib/)
   ┌──────────────────────────────────────────────────────────────────────┐
   │  lib/types/api-routes.ts     ← NEW: typed endpoint registry           │
   │     ApiRoute.containers.get(id)  → "/api/containers/:id" + builder     │
   │     + method, permission, query-key derivation, request/response type  │
   │  lib/types/query-keys.ts     ← NEW: key factory derived from registry  │
   │  lib/types/http.ts           ← NEW: header names, correlation-id, envelope helpers │
   │  lib/types/permissions.ts    ← EXTEND: Permission const map for server │
   └───────────────▲───────────────────────────────────────▲──────────────┘
                    │ consumes                               │ consumes
   ┌────────────────┴─────────────────┐    ┌─────────────────┴──────────────────────┐
   │ client/src/lib/api-client.ts NEW  │    │ server describeRoute(ApiRoute.x, …) NEW │
   │  apiFetch(ApiRoute.containers.get)│    │  • path + permission from the registry  │
   │  • timeout, credentials, headers  │    │  • request/response zod → OpenAPI + types│
   │  • typed ApiError, envelope unwrap│    │  • res typed as the shared response type │
   │  • query keys from queryKeys.*    │    └──────────────────────────────────────────┘
   └───────────────────────────────────┘
```

### 5.1 Layer 1 — Shared route registry (`lib/types/api-routes.ts`)

Mirror `socket-events.ts`. Paths as parameterized builders; a flat array for drift-checking:

```ts
// lib/types/api-routes.ts
export const ApiRoute = {
  containers: {
    list:   ()            => `/api/containers`,
    get:    (id: string)  => `/api/containers/${id}`,
    action: (id: string)  => `/api/containers/${id}/action`,
  },
  stacks: {
    list:    ()            => `/api/stacks`,
    get:     (id: string)  => `/api/stacks/${id}`,
    apply:   (id: string)  => `/api/stacks/${id}/apply`,
    destroy: (id: string)  => `/api/stacks/${id}/destroy`,
  },
} as const;

// Flat, param-normalized list — the source of truth for the CI drift-check (§6)
export const ALL_API_ROUTES = [
  { method: "GET",  path: "/api/containers" },
  { method: "GET",  path: "/api/containers/:id" },
  { method: "POST", path: "/api/containers/:id/action" },
  // …
] as const;
```

This alone deletes ~260 client literals and ~200 server literals and makes rename a compile error instead of a runtime 404.

### 5.2 Layer 2 — Typed API client (`client/src/lib/api-client.ts`)

The single missing primitive. One place for credentials, headers, correlation-ID, **timeout**, typed errors, and envelope unwrapping:

```ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string,
              message: string, readonly body?: unknown) { super(message); }
  get isAuth()   { return this.status === 401; }
  get isServer() { return this.status >= 500; }
}

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    credentials: "include",
    headers: { [HttpHeader.ContentType]: "application/json",
               [HttpHeader.CorrelationId]: newCorrelationId(), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),  // ← kills the 0-timeout gap
  });
  if (!res.ok) throw await ApiError.fromResponse(res);   // ← typed error, one definition
  return unwrapEnvelope<T>(await res.json());            // ← {success,data} unwrapped once
}
```

Deletes the ~340× fetch skeleton, 35× correlation helper, 414× `.success` unwrap, the string-match error parser, and closes the no-timeout gap in one move. `credentials`/header constants come from `lib/types/http.ts`.

### 5.3 Layer 3 — Query-key factory (`lib/types/query-keys.ts`)

Derive keys from the same resource names as the routes, so key and URL can never disagree, and fix the camel/kebab bugs by construction:

```ts
export const queryKeys = {
  containers: {
    all:    ["containers"] as const,
    list:   (f: ContainerFilters) => ["containers", "list", f] as const,
    detail: (id: string)          => ["containers", "detail", id] as const,
  },
  stacks: { all: ["stacks"] as const, detail: (id) => ["stacks", id] as const },
} as const;
```

Replaces 551 inline arrays; invalidation becomes `queryClient.invalidateQueries({ queryKey: queryKeys.containers.all })`.

### 5.4 Layer 4 — Typed responses via `describeRoute()` expansion

Converge the client contract with the server contract engine. Each endpoint's request/response zod schema lives beside the route, its inferred type is exported to `@mini-infra/types`, and:

- The server: `describe()` binds the response type so `res.json()` is compile-checked (closes the 384→1 gap) and the schema flows into OpenAPI.
- The client: `apiFetch<InferResponse<typeof endpoint>>()` gets the same type for free.

End state (contract-first): a single endpoint descriptor object carrying `{ method, path, permission, request, response }` that **both** `describe()` (server) and `apiFetch` (client) accept — one definition drives typing on both ends, runtime validation, OpenAPI, and the query key. This is the north star; Layers 1–3 are the incremental path to it.

### 5.5 Layer 5 — Robust connectivity

Built on the typed client + a hardened socket:

- **Timeouts** via `AbortSignal.timeout` in `apiFetch` (5.2).
- **Global 401 handling** — a `QueryCache`/`MutationCache` `onError` in the single `QueryClient` that, on `ApiError.isAuth`, invalidates auth-status and redirects once. Fixes the ≤5-minute broken-page window.
- **Socket hardening** (`use-socket.ts`) — explicit `reconnection`/`reconnectionAttempts`/backoff config, a `connect_error` handler, and a **global connection banner** driven by the already-clean `connected` state ("Reconnecting to server…").
- **Cold-start readiness gate** — poll `/health` (auth-exempt) with backoff before mounting the auth gate, so backend-not-up-yet shows "waiting for server" instead of an auth error.
- **Bring the 11 rogue pollers** under the `connected ? false : ms` convention.
- **Fix connectivity false-negatives** — distinguish "fetch failed / no data yet" from "service down" in `use-all-services-status.ts`/`site-header.tsx`, and de-duplicate the four-service fan-out into one hook.

### 5.6 Layer 6 — Server permission constants

Close the half-applied permission contract (§2). Add a `Permission` const map to `permissions.ts` (mirroring `Channel`), `satisfies`-checked against `ALL_PERMISSION_SCOPES`, and replace the 400+ raw `requirePermission("postgres:write")` strings with `requirePermission(Permission.PostgresWrite)`. When `describeRoute()` adoption grows, permission comes from the descriptor and this collapses further.

---

## 6. Keeping the contract honest — drift prevention

A shared registry that silently disagrees with the real routes is worse than none. Two CI guards, both with existing precedent in this repo:

1. **Route drift-check** (mirrors the `ALL_NATS_SUBJECTS` ↔ Go-mirror check). A test boots the Express app, runs `express-list-endpoints` (already used by `GET /api/routes`), and asserts the live route set **equals** `ALL_API_ROUTES` from `lib/`. Any route added/renamed/removed without touching the registry fails CI.
2. **`describeRoute()` coverage ratchet.** `warnOnRouteMetadataDrift()` already exists; promote it from a dev warning to a CI assertion over a growing `MIGRATED_ROUTE_PREFIXES`, so migrated areas can't regress.

Bonus: once `ALL_API_ROUTES` exists, `API-ROUTES.md` (594 hand-maintained lines) can be **generated** from it, deleting a whole class of drift.

---

## 7. Phased rollout

Each phase is independently shippable, ordered by leverage-per-risk. Phases 1–3 are mechanical and safe; 4 is the deep one; 5–6 harden and finish.

### Phase 1 — Typed API client *(highest leverage, low risk)*
Introduce `client/src/lib/api-client.ts` (`apiFetch`, `ApiError`, envelope unwrap, timeout, correlation-ID) + `lib/types/http.ts` (header/const names). Migrate a **vertical slice** (containers) as the reference, update `client/ARCHITECTURE.md`'s "canonical hook" pattern, then fan out hook-by-hook.
**Deletes:** ~340 fetch skeletons, 35 correlation copies, 414 `.success` unwraps, the string-match error parser, the 0-timeout gap.
**Reversibility:** safe — additive; hooks migrate incrementally, old code keeps working.

### Phase 2 — Shared route registry
Add `lib/types/api-routes.ts` (`ApiRoute` builders + `ALL_API_ROUTES`). Point `apiFetch` callers and server mounts at it. Land the **route drift-check** CI test (§6). Generate `API-ROUTES.md` from it.
**Deletes:** ~260 client + ~200 server path literals. **Turns rename-404s into compile errors.**
**Reversibility:** safe.

### Phase 3 — Query-key factory
Add `lib/types/query-keys.ts`; replace 551 inline keys. Fixes the `postgresDatabases`/`postgres-databases` and `haproxy-frontend(s)` invalidation bugs by construction.
**Reversibility:** safe (keys are internal), but touch carefully — a wrong key silently breaks a cache. Migrate per-resource with the existing socket tests as backstop.

### Phase 4 — Typed responses / `describeRoute()` expansion *(largest, do resource-by-resource)*
Expand `MIGRATED_ROUTE_PREFIXES` beyond `/api/diagnostics`. For each resource: define request/response zod beside the route, export inferred types to `@mini-infra/types`, bind `res.json()`'s type, and switch the client to `apiFetch<Response>`. Retire the 249 inline enum-string comparisons in favour of the shared unions. Converge toward single endpoint descriptors (5.4).
**Closes:** the 384→1 untyped-response gap; server↔client response drift.
**Reversibility:** feature-flagged per resource (a route works migrated or not).

### Phase 5 — Robust connectivity
Global `QueryClient` `onError` (401 redirect), socket reconnection config + `connect_error` + global disconnect banner, `/health` cold-start gate, bring the 11 rogue pollers under the socket gate, fix connectivity-indicator false-negatives, de-dup the four-service fan-out.
**Rogue pollers to fix:** `use-nats.ts:33`, `use-agent-status.ts:25`, `use-agent-settings.ts:136`, `use-egress-fw-agent.ts:38`, `system-diagnostics/use-diagnostics.ts:25`, `environments/[id]/page.tsx:60`, `containers/[id]/page.tsx:54`, `applications/[id]/monitoring/page.tsx:107`, `haproxy-status-card.tsx:39`, `environment-list.tsx:33` (and review `use-auth-status.ts:57`).
**Reversibility:** safe (UI/behaviour hardening).

### Phase 6 — Server permission constants + doc cleanup
`Permission` const map in `permissions.ts`; replace 400+ `requirePermission("…")` strings. Update `lib/CLAUDE.md` (drop the stale "types-only" language; state the "zero external deps" invariant explicitly).
**Reversibility:** safe (string-for-constant swap, compile-checked).

---

## 8. Prioritisation & effort

| Phase | Leverage | Risk | Rough effort | Prereq |
|---|---|---|---|---|
| 1 — Typed API client | ★★★★★ | Low | M (primitive S; fan-out is mechanical) | — |
| 2 — Route registry | ★★★★★ | Low | M | 1 (client), independent (server) |
| 3 — Query-key factory | ★★★★ | Low–Med | M | — (pairs well with 1) |
| 4 — Typed responses | ★★★★ | Med | L (per-resource, ongoing) | 1, 2 |
| 5 — Robust connectivity | ★★★★ | Low | M | 1 |
| 6 — Permission constants | ★★★ | Low | S–M | — |

**Recommended first PR:** Phase 1's `apiFetch` primitive + the containers vertical slice + the `client/ARCHITECTURE.md` pattern update. It's the keystone every later phase leans on, it's self-contained, and it immediately closes the two scariest gaps (no timeouts, no typed errors) on the most-used resource. Phases 1–3 can proceed in parallel by different hands once the primitives land; Phase 4 is a long tail that rides the `describeRoute()` migration.

---

## 9. Appendix — findings at a glance

| Area | Metric | Count |
|---|---|---:|
| **HTTP client** | Raw `fetch()` sites | ~340 |
| | Central wrapper | 0 |
| | `generateCorrelationId` copies | 35 |
| | Request timeouts | 0 |
| | `.success` envelope checks | 414 |
| | Header literals (`Content-Type` / `X-Correlation-ID`) | 250 / 168 |
| **URLs** | Distinct `/api` literals (client) | ~220–260 |
| | Distinct `/api` literals (server) | ~200 |
| | Shared route constants | 0 |
| **Query keys** | Inline `queryKey` sites | 551 |
| | Distinct namespaces | 122 |
| | Key factories | 2 (local) |
| | Known casing/invalidation bugs | ≥2 |
| **Types** | Enum-string comparisons (`x === "literal"`) | 249 |
| | Local `interface`/`type` in hooks | 156 (46 files) |
| | Hooks importing `@mini-infra/types` | 60 / 78 |
| **Server** | Mounted route modules | 65 |
| | Using `describeRoute()` | 1 |
| | `res.json()` (typed) | 384 (1) |
| | Files importing zod | 55 / 87 |
| **Connectivity** | Hooks polling unconditionally | 11 |
| | Socket `connect_error` handlers | 0 |
| | Global query/mutation `onError` | 0 |
| | Cold-start readiness gate | none |
| **The good pattern** | `Channel.*`/`ServerEvent.*` uses | 181 (1 stray, in a comment) |
| | `lib/` runtime `const` maps / functions | 60 / 13 |

### Key files
- **Shared:** `lib/types/socket-events.ts` (the template), `lib/types/nats-subjects.ts` (drift-check template), `lib/types/permissions.ts`, `lib/types/api.ts`, `lib/package.json`, `lib/CLAUDE.md` (stale), `lib/tsconfig.json`.
- **Client:** `client/src/hooks/useContainers.ts` (canonical hook), `client/src/api/egress.ts` (partial pattern), `client/src/lib/auth-context.tsx:128` (the one `QueryClient`), `client/src/hooks/use-socket.ts`, `client/src/hooks/use-all-services-status.ts`, `client/src/components/site-header.tsx`.
- **Server:** `server/src/app-factory.ts:137-221` (mount table), `server/src/lib/describe-route.ts`, `server/src/lib/openapi-registry.ts`, `server/src/routes/diagnostics.ts` (the one migrated module), `server/src/routes/api-routes.ts`, `API-ROUTES.md`.
