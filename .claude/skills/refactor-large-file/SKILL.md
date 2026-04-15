---
name: refactor-large-file
description: |
  Finds the largest TypeScript files in the Mini Infra codebase, helps the
  user pick one, explores how it's wired into the rest of the app, proposes a
  DRY refactor strategy, implements the refactor, and writes focused unit
  tests for the new abstractions. Use this skill whenever the user wants to
  find files to refactor, clean up a large file, improve DRY/maintainability,
  or reduce duplication — even if they don't name a specific file. Trigger on:
  "refactor a large file", "clean up our biggest files", "DRY up this file",
  "what files should we refactor", "find files to refactor", "our biggest
  files", "top files by line count", "this file is too big", "split this
  file", "improve maintainability", or when the user mentions a 1000+ line
  file and wants it improved.
---

## Purpose

Drive an end-to-end refactor of a single oversized file with these outcomes:

1. The file is split into focused modules, each with one clear responsibility.
2. Duplication is folded into shared primitives — typed helpers, not copy-paste.
3. The original module's public API is preserved via delegation so external
   callers don't change.
4. New abstractions get unit tests; delegation and trivial wrappers don't.
5. `npm run build`, `npm test`, and `npm run lint` are all green at the end.

The reference precedent for this workflow is PR #180
(`refactor/cloudflare-service-dry`), which split the 1484-line
`cloudflare-service.ts` and 1497-line `cloudflare-settings.ts` into 14 focused
modules while preserving every public method signature and adding 40 targeted
tests.

## Workflow

Drive the user through seven steps. Each is an explicit checkpoint — don't
run ahead. The human-in-the-loop at steps 2, 4, and 6 is what keeps the
refactor scope honest.

### 1. List candidate files

Run these two commands from the repo root (in parallel — they're independent):

```bash
./scripts/top-files-by-lines.sh ts 10
./scripts/top-files-by-lines.sh tsx 10
```

Present both tables. Flag which entries are **test files** (paths containing
`__tests__/` or ending in `.test.ts`/`.test.tsx`) — tests are often
legitimately large because of fixtures, and refactoring them usually isn't
high-value. Don't refuse to refactor them, but point it out.

Also scan the list for files where the duplication is likely to be *dense*:
route files, service classes with 10+ methods, files mixing HTTP handling
with business logic, and files whose name ends in `-service.ts` or
`-manager.ts`. Call out your top recommendation but let the user pick.

### 2. User picks the file (checkpoint)

Ask the user which file to refactor. **Do not assume.** If they waver, offer
a quick rationale for each candidate:

- Route files with shared validation/auth/error-handling boilerplate
- Service classes with shared circuit-breaker / timeout / auth patterns
- Files where one method contains 80+ lines of orchestration logic
- Files that re-implement something the project already has a wrapper for
  (see `server/CLAUDE.md` for the canonical wrappers — DockerService,
  ConfigurationServiceFactory, AzureStorageService, etc.)

### 3. Explore usage and duplication

Before proposing anything, build a mental model of how the file participates
in the codebase. For broad exploration, delegate to the Explore agent — it's
faster than doing many small Greps. Ask it to report:

- **Imports in**: what the file imports (SDK clients, other services,
  middleware). Raw SDK usage that bypasses project wrappers is a red flag
  worth fixing as part of the refactor.
- **Exported symbols**: the public surface. These are the signatures that
  must survive the refactor intact so downstream callers don't break.
- **Callers**: which files `import` the exported symbols. Note the call
  shapes so you can plan delegation carefully.
- **Tests**: which files exercise this module (`__tests__/...test.ts`).
  These tests define the observable contract — breaking them is breaking
  behaviour, even if the types still match.
- **Related patterns**: does another file in the same domain solve a similar
  problem differently? (Example: PR #180 noticed `cloudflare-dns.ts` had its
  own client-builder / timeout-wrapper duplicating `cloudflare-service.ts`.)

Then read the file itself and catalogue duplication. Typical patterns:

- **Repeated skeletons**: every method starts with the same preamble
  (auth check, circuit-breaker check, timeout wrapper) and ends with the
  same catch/log/rethrow.
- **Inline cross-cutting concerns**: request-id extraction, user-id
  extraction, "is this configured" guards repeated per-handler.
- **Copy-pasted validation**: same Zod schema 400-response shape in every
  handler.
- **Inline caches**: ad-hoc `Map<string, {data, timestamp}>` with TTL checks
  repeated across GET handlers.
- **Orchestration logic buried in handlers**: business rules (stack lookup,
  rollback on partial failure) inline in a route when they belong in a
  service.

### 4. Propose a strategy (checkpoint)

Write up the strategy **before implementing**. The user must sign off. The
proposal should cover:

1. **Current concerns** — what the file does, grouped. Example: "This file
   does five things: settings CRUD, validation, tunnel API, managed tunnels,
   zone/DNS. The tunnel and managed-tunnel code share a circuit-breaker but
   nothing else."
2. **Duplication patterns found** — name each one explicitly with a count.
3. **Proposed module split** — new files with one-line purposes.
4. **Shared primitives to extract** — the abstractions that replace the
   duplication. Describe the shape (a class, a function, a middleware)
   and the failure modes it encodes. When one abstraction needs to serve
   multiple behaviours (throw-on-error vs return-fallback), surface that
   as explicit variants (e.g. `run()` vs `tryRun()`).
5. **Public API preservation** — which class/function stays as an orchestrator
   and delegates to the new submodules. Call this out explicitly so the user
   sees you won't break callers.
6. **Tradeoffs / risks** — especially behavioural drift. If each method
   currently has subtly different error semantics (some return `null`, some
   throw, some log-and-swallow), name them and explain how the shared
   primitive preserves those shapes rather than flattening them.
7. **Expected line-count impact** — before vs after estimate.

End the proposal with a question: "Want me to start with a smaller, lower-risk
slice first, or go end-to-end?" Some users want incremental, some want one
big push.

### 5. Implement the refactor

Once the user approves, work in this order:

1. **Build shared primitives first.** New files under an appropriate
   `services/<domain>/` or `lib/` path. Test them mentally against the
   duplication catalogue from step 3 — each primitive should kill multiple
   duplication sites.
2. **Extract submodules next.** Each replaces a slice of the original class.
3. **Rewrite the orchestrator last.** The original class (e.g.
   `CloudflareService`) stays as a thin delegating shell so its public
   surface is unchanged. Keep its constructor signature identical; if
   external callers construct it directly, the refactor is invisible to them.
4. **Update sibling files that duplicate the same work.** If another module
   in the domain (like `cloudflare-dns.ts` in PR #180) has its own copy of
   what you just abstracted, point it at the new primitive.
5. **Split the route file if applicable.** Create focused sub-routers, then
   have the top-level file compose them so the `app-factory.ts` mount point
   stays unchanged.

**Project-specific constraints while implementing:**

- Run **all** commands from the repo root. Use `-w <workspace>` flags:
  `npm test -w server`, `npm run build -w client`, etc. Never `cd client/`,
  `cd server/`, or `cd lib/` — that's a repo convention.
- `update-sidecar/` and `agent-sidecar/` are NOT in the npm workspace — you
  must `cd` into those directories to run npm commands, then return.
- Run `npm run build:lib` whenever you change anything in `lib/` before
  running server/client builds — the shared types package must compile first.
- Follow the service-wrapper rules in `server/CLAUDE.md` (DockerService
  singleton, ConfigurationServiceFactory, etc.). If the file you're
  refactoring bypasses one of those wrappers, fixing it is part of the
  refactor.
- Use `Channel.*` / `ServerEvent.*` constants from `lib/types/socket-events.ts`
  — never raw strings.

**After implementation, verify:**

```bash
npm run build:lib            # always first if lib changed
npm run build -w server      # or -w client, depending on what you touched
npm run lint -w server
npm test -w server
```

Fix every error the refactor introduced — even pre-existing ones that become
visible because of your changes. Pre-existing errors tracked in
`docs/upgrade-shortcuts.md` are explicitly deferred — don't chase those, but
call them out if the user seems unaware.

When tests assert specific log messages or error shapes that your refactor
made more consistent, update the tests to match the new consistent shape —
don't retain inconsistency just to keep the old assertions happy. The point
of the refactor is uniformity.

### 6. Propose a test plan (checkpoint)

Before writing any tests, analyse what's worth testing and present a plan.
Rank by value-per-line:

**Usually high value:**
- New shared primitives (the thing everything else now depends on)
- Non-trivial pure logic: ingress-rule manipulation, keyed-storage schemes,
  TTL caches, rollback orchestration
- Middleware that gates multiple routes

**Usually low value, skip:**
- Pure delegation methods on the orchestrator class (already covered by
  existing tests against the public API)
- Trivial wrappers (`asyncHandler` = `Promise.resolve(...).catch(next)`)
- Classes that are 90% glue, where a meaningful test would reduce to
  re-proving the mocks

**Tell the user which tests you'd skip and why.** Getting user agreement on
the coverage target is important — otherwise you'll either over-test trivial
glue or under-test the load-bearing primitive.

### 7. Write the tests

Follow the existing test conventions in the repo:

- Tests live in `__tests__/` subdirs next to the code (`server/src/services/
  <domain>/__tests__/<name>.test.ts`).
- Vitest is the runner. Global setup at `server/src/__tests__/setup-unit.ts`
  already mocks `getLogger` from the logger factory, so don't re-mock it.
- Use `vi.mock` / `vi.spyOn` / `vi.hoisted` patterns already in the repo —
  grep existing test files for examples.
- Construct real collaborators (e.g. a real `CircuitBreaker` with in-memory
  state) rather than mocking them, unless the real thing pulls in heavy
  dependencies like Prisma. Real collaborators catch integration bugs that
  pure mocking misses.
- For time-sensitive tests (TTL caches, timeouts) use `vi.useFakeTimers()` /
  `vi.advanceTimersByTime()`.
- Give each `describe` block a clear subject and each `it` a behavioural
  description ("returns the fallback when credentials are missing", not
  "test 3").

Run the tests:

```bash
npx -w server vitest run <path-to-new-test-file>
```

Then run the full suite to confirm nothing else regressed:

```bash
npm test -w server
```

Fix everything you broke. If there's a pre-existing test failure you didn't
introduce, verify it was already failing on `main` (`git stash && npm test
-w server && git stash pop`) before declaring victory.

## Guiding principles

Keep these front of mind throughout the whole workflow — they're what
distinguish a clean refactor from a rearrangement:

**DRY — fold, don't copy.** When you see the same skeleton three times, it
means there's an abstraction waiting. But the abstraction has to encode the
variations, not paper over them. If the original methods had three different
failure modes (throw, return null, return []), the primitive surfaces those
as explicit options (`run()` vs `tryRun(fallback)`), not as a hidden boolean.

**Reliability — preserve observable behaviour.** The public API and the
logged/emitted events are the contract, even if nobody wrote them down.
Don't change error codes, HTTP status codes, or socket event names unless
that's the explicit goal. When behaviour genuinely drifts (a log message
becomes more consistent, an error type narrows), update the tests to match
rather than papering it over.

**Maintainability — one concern per file.** Aim for files under ~400 lines
where reasonable. The measure isn't line count itself but whether a reader
can hold the file's job in their head. A 600-line file that does one thing
is fine; a 300-line file that does three things isn't.

**Testability — inject, don't instantiate.** When extracting primitives,
pass dependencies through the constructor or function params. That way tests
can swap in fakes without monkey-patching modules. The reference runner in
PR #180 takes `CircuitBreaker` + two token-accessor functions, which is why
its tests can run without touching the DB.

**Preserve public APIs via delegation.** External callers should not change.
The original class keeps every method, but each method body shrinks to a
one-line delegate. This is what lets you land a large refactor as a
low-risk PR.

## Anti-patterns to avoid

- **Don't flatten distinct error semantics into one.** If `getTunnelConfig`
  returned `null` on failure and `updateTunnelConfig` threw, the new
  abstraction must still support both — usually via two variants
  (`tryRun` + `run`) rather than one "smart" function.
- **Don't refactor sibling files' behaviour by accident.** If a sibling
  file (e.g. a DNS service) has its own client-builder that differs
  subtly from the service you're refactoring, investigate the difference
  before unifying. Sometimes they diverge for a reason.
- **Don't introduce a new abstraction to save 20 lines.** The bar is folding
  duplication that appears in 3+ places. Two copies usually aren't worth
  the indirection cost.
- **Don't write tests for pure delegation.** If `CloudflareService.addHostname`
  is `this.tunnelApi.addHostname(...)`, testing `CloudflareService.addHostname`
  tests nothing the tunnel-api test doesn't already cover.
- **Don't ship a refactor with lint/test regressions.** Every error the
  refactor introduced is yours to fix before declaring done — even when the
  original author's code was the root cause.

## Reference example: PR #180

A concrete precedent the workflow produced:

- **Input**: `server/src/services/cloudflare/cloudflare-service.ts` (1484 lines)
  + `server/src/routes/cloudflare-settings.ts` (1497 lines)
- **Duplication found**: ~10 methods each repeating `circuitBreaker.isOpen()`
  check → `getApiToken`/`getAccountId` guard → `new Cloudflare({ apiToken })`
  → `Promise.race([call, timeout])` → `recordSuccess/Failure` → redacted log.
  Route handlers each repeated request-id + user extraction + try/catch +
  credentials guard + Zod-400 shape.
- **Primitives extracted**:
  - `CloudflareApiRunner` with `run()` (throws) / `tryRun(fallback)` /
    `withTimeout()` / `getAuthorizedClient()` / `cfdFetch()`
  - `ManagedTunnelStore` — typed façade over `managed_tunnel_{id|name|token|
    created_at}_{envId}` settings keys
  - `tunnelCache` — TTL cache module
  - `requireCloudflareCredentials` middleware
  - `asyncHandler` — shared try/catch/next wrapper
- **Submodules**: `cloudflare-tunnel-api.ts`, `cloudflare-zone-api.ts`,
  `cloudflare-managed-tunnel.ts` — each focused on one concern.
- **Public API**: `CloudflareService` kept every method signature and
  constructor intact via delegation. `cloudflareDNSService` singleton
  export also preserved. Zero downstream caller changes.
- **Tests added**: 40 across five files — runner, tunnel-api,
  managed-tunnel-store, tunnel-cache, require-credentials middleware.
  Skipped tests for `cloudflare-zone-api` (pure delegation to runner) and
  `asyncHandler` (trivial wrapper).
- **Outcome**: 3,688 lines in 3 files → 3,014 lines in 14 files. Neither
  original file now appears in the top-10 by line count. Full test suite
  green with 40 additional tests.
