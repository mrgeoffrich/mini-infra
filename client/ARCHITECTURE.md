# Client architecture

The client is a Vite + React 19 single-page app served from the same origin as the API. This document is the orientation guide for frontend contributors. It covers the layout, the routing model, the data and real-time layers, and the patterns that hold the app together.

For repo-wide context, start at the root [ARCHITECTURE.md](../ARCHITECTURE.md). For Claude-facing pattern reference, see [CLAUDE.md](CLAUDE.md) — this doc summarises and links into it.

## Entry points

When you read the client cold, these are the files to open in order.

- [src/main.tsx](src/main.tsx) — mounts `<App/>` into `#root`. Almost trivial; the only side-effect is a `MutationObserver` that strips password-manager-injected DOM nodes (which would otherwise re-inject after every render).
- [src/App.tsx](src/App.tsx) — the provider stack: `AuthProvider` → `RouterProvider` → `Toaster`. Read this once to understand what's globally available.
- [src/lib/routes.tsx](src/lib/routes.tsx) — `createBrowserRouter()`. The static, hand-edited list of every URL the app knows about. If a route isn't here, it doesn't exist.
- [src/hooks/use-socket.ts](src/hooks/use-socket.ts) — the socket primitives every resource hook builds on.
- [src/hooks/useContainers.ts](src/hooks/useContainers.ts) — the canonical resource-hook pattern. Copy this shape when adding a new resource.

## Layout

```
client/
├── public/                       static assets served as-is
├── src/
│   ├── main.tsx                  entry — mounts <App/> into #root
│   ├── App.tsx                   AuthProvider → RouterProvider → Toaster
│   ├── index.css                 global styles, Tailwind layer config
│   ├── api/                      raw fetch helpers (when not behind a hook)
│   ├── app/                      page components, one folder per route
│   ├── components/               feature-scoped UI + shared primitives
│   ├── hooks/                    data and behaviour hooks (TanStack Query, sockets)
│   ├── lib/                      router, contexts, utilities, registries
│   ├── user-docs/                in-app help, served as MDX/MD
│   ├── user-docs-structure/      meta files describing docs hierarchy
│   ├── assets/                   images, icons, static files
│   └── __tests__/                tests
├── vite.config.ts                dev server, proxy, build output
└── package.json
```

Entry chain: [src/main.tsx](src/main.tsx) → [src/App.tsx](src/App.tsx) (`AuthProvider` + `RouterProvider` + `Toaster`) → [src/lib/routes.tsx](src/lib/routes.tsx) (`createBrowserRouter`).

### `src/app/` — page components

One folder per route. Bracketed segments map to URL params (`app/containers/[id]/page.tsx` → `/containers/:id`). Pages are thin: they assemble components from `src/components/<feature>/` and pull data from hooks in `src/hooks/`.

**Invariant:** logic does not live in page files. If a `page.tsx` grows past assembly, factor it into the corresponding `components/<feature>/` folder. (We've been burned by re-using "page" code when the same UI gets dropped into a dialog elsewhere.)

### `src/components/` — feature-scoped UI

Each feature has its own folder (e.g. `containers/`, `stacks/`, `haproxy/`, `egress/`, `certificates/`, `agent/`, `task-tracker/`). The shared design-system primitives — buttons, dialogs, inputs, sheets — live in [src/components/ui/](src/components/ui/) and wrap [Radix UI](https://www.radix-ui.com/) primitives.

**Invariant:** the design system is one folder. New primitives are added to `components/ui/` (wrapping Radix). We don't import a second component library.

### `src/hooks/` — data + behaviour

This is where API access happens. Every server resource has a hook (`useContainers`, `useStacks`, `useApplications`, `useEgress`, etc.) that wraps fetch + TanStack Query + Socket.IO subscriptions. The reference pattern lives in [src/hooks/useContainers.ts](src/hooks/useContainers.ts) — copy from it when adding a new resource.

**Invariant:** server state lives in TanStack Query, not React state and not a third-party store. Components read via hooks; mutations go through `useMutation`. There is no other store on the client.

### `src/lib/` — wiring

| File | What it owns |
|---|---|
| [routes.tsx](src/lib/routes.tsx) | `createBrowserRouter()` configuration |
| [route-config.ts](src/lib/route-config.ts) | route metadata (title, icon, breadcrumb parent, nav group, help doc) |
| [auth-context.tsx](src/lib/auth-context.tsx) | `AuthProvider`, `useAuth()` |
| [task-tracker-context.ts](src/lib/task-tracker-context.ts), [task-type-registry.ts](src/lib/task-type-registry.ts), [task-tracker-types.ts](src/lib/task-tracker-types.ts) | global task tracker |
| [agent-chat-context.ts](src/lib/agent-chat-context.ts) | agent sidecar chat |
| [doc-loader.ts](src/lib/doc-loader.ts), [doc-search.ts](src/lib/doc-search.ts) | in-app help docs |
| [date-utils.ts](src/lib/date-utils.ts), [ansi-to-html.ts](src/lib/ansi-to-html.ts), [parse-dotenv.ts](src/lib/parse-dotenv.ts), [utils.ts](src/lib/utils.ts) | leaf utilities |

### `src/user-docs/` — in-app help

Markdown/MDX organised by feature (`containers/`, `applications/`, `connectivity/`, etc.). Loaded at runtime by [doc-loader.ts](src/lib/doc-loader.ts). The help system is hosted at `/help/:category/:slug`. Pages opt in to contextual help by setting `helpDoc` in [route-config.ts](src/lib/route-config.ts).

UI elements that the agent's `highlight_element` tool should be able to point at carry `data-tour="<id>"` attributes. [scripts/generate-ui-manifest.mjs](../scripts/generate-ui-manifest.mjs) scans the codebase and writes `src/user-docs/ui-elements/manifest.json`. Run `pnpm generate:ui-manifest` after adding or renaming `data-tour` IDs.

## Routing

Routes are statically defined in [src/lib/routes.tsx](src/lib/routes.tsx) using `createBrowserRouter()` from `react-router-dom`. Adding a route means editing this file.

**Invariant:** routes are static. There is no dynamic route generation — and every authenticated route has a matching entry in [src/lib/route-config.ts](src/lib/route-config.ts) so navigation, breadcrumbs, page titles, and contextual help all work. (We tried meta-driven routing once; nav and breadcrumbs drifted out of sync within a sprint.)

The structure has three concentric layers:

1. **`AuthErrorBoundary`** — catches auth errors anywhere in the tree and forces a redirect to login.
2. **`PublicRoute` / `ProtectedRoute`** — `PublicRoute` is for `/login`, `/setup`, `/recover`; `ProtectedRoute` ensures a valid session before rendering.
3. **`AppLayout`** — the nav + main shell that wraps every authenticated page. Rendered as the layout child of the `/` route, so all in-app pages inherit it.

A few special cases to know:

- `/logs/fullscreen` is a top-level protected route that bypasses `AppLayout` so the logs viewer can take the whole window.
- The help pages (`/help`, `/help/:category/:slug`) are **lazy-loaded** via `lazy: async () => ...` to keep the help bundle out of the main route chunk.
- Dev-only routes (`/design/icons`) are gated behind `import.meta.env.VITE_SHOW_DEV_MENU === 'true'`.

Every route should also have an entry in [src/lib/route-config.ts](src/lib/route-config.ts) so navigation, breadcrumbs, page titles, and contextual help work. The metadata fields are documented inline.

## Client invariants — digest

Most of these are also stated inline at the spot they apply. This is the consolidated list.

- **State:** TanStack Query owns server state; React state owns UI state. Auth and the task tracker are the only other contexts. No Redux, no Zustand.
- **Polling:** `refetchInterval: false` when connected; fast poll only when disconnected. Always `refetchOnReconnect: true`.
- **Socket:** singleton from `useSocket()`. `io()` is never constructed in feature code.
- **Channels:** ref-counted via `useSocketChannel()`. Manual `socket.emit("subscribe")` is not used.
- **Real-time names:** `Channel.*` / `ServerEvent.*` from `@mini-infra/types`. No raw strings.
- **Routing:** static in `lib/routes.tsx`. Every authed route has a `route-config.ts` entry.
- **Pages:** thin. Logic lives in `components/<feature>/` and `hooks/`.
- **UI library:** one — `components/ui/` wrapping Radix.
- **Permissions:** scopes from auth context, not role names. UI gate is for UX only; server enforces.
- **Long-running ops:** through the task tracker (`trackTask()` / `useOperationProgress`). No one-off socket listeners for progress.

## Data layer (TanStack Query + sockets)

The combination of TanStack Query and Socket.IO is the data layer. There is no Redux, no Zustand, no other store. Server state lives in TanStack Query's cache; UI state lives in React state and a small number of contexts (auth, task tracker, agent chat).

### Anatomy of a resource hook

The reference is [src/hooks/useContainers.ts](src/hooks/useContainers.ts). Every resource hook should follow the same shape:

```ts
export function useContainers(options: UseContainersOptions = {}) {
  const { connected } = useSocket();

  // 1. Polling falls back to a fast interval only when the socket is disconnected.
  const refetchInterval = connected ? false : POLL_INTERVAL_DISCONNECTED;

  // 2. Subscribe to the room while this hook is mounted.
  useSocketChannel(Channel.CONTAINERS, enabled);

  // 3. Listen to events and either invalidate or surgically patch the cache.
  useSocketEvent(ServerEvent.CONTAINERS_LIST, () => {
    queryClient.invalidateQueries({ queryKey: ["containers"] });
  }, enabled);
  useSocketEvent(ServerEvent.CONTAINER_STATUS, (data) => {
    queryClient.setQueriesData<ContainerListResponse>(/* surgical patch */);
  }, enabled);

  // 4. The query itself.
  return useQuery({
    queryKey: ["containers", queryParams],
    queryFn: () => fetchContainers(queryParams, correlationId),
    refetchInterval,
    refetchOnReconnect: true,    // recover events missed during disconnect
    refetchOnWindowFocus: true,
    staleTime: 2000,
    gcTime: 5 * 60 * 1000,
    retry: /* don't retry 401s or "Docker unavailable"; backoff on others */,
  });
}
```

The four invariants that every hook must respect:

1. **No polling when the socket is connected.** Set `refetchInterval: false` when `connected` is true.
2. **Always set `refetchOnReconnect: true`.** It backfills any events missed while the socket was down.
3. **Use `Channel.*` and `ServerEvent.*` constants** from `@mini-infra/types`. Never raw strings.
4. **Use `useSocketChannel()`** rather than emitting `subscribe` manually. The hook ref-counts subscribers, so two components on the same channel don't unsubscribe each other on unmount.

### The socket primitives

[src/hooks/use-socket.ts](src/hooks/use-socket.ts) exports four hooks:

| Hook | Purpose |
|---|---|
| `useSocket()` | Access the singleton socket and the `connected` flag (via `useSyncExternalStore`). |
| `useSocketEvent(event, handler, enabled?)` | Listen to a typed `ServerToClientEvents` event for the lifetime of the component. Handler is held by ref so updates don't re-subscribe. |
| `useSocketChannel(channel, enabled?)` | Join a Socket.IO room on mount, leave on unmount. Ref-counted so multiple subscribers coexist; only emits `SUBSCRIBE`/`UNSUBSCRIBE` at the boundaries. |
| `useSocketQueryBridge(event, queryKey, transform, enabled?)` | One-liner for "when this event fires, set this query data." |

The socket is a singleton. Don't construct your own `io()` instance. The connection auto-starts on first mount.

### Cache patching strategy

There are two modes:

- **Invalidate** (`queryClient.invalidateQueries`) when the server pushes "the list changed" — TanStack Query refetches with the current filters/sorts. Use this for list-level updates.
- **Surgical patch** (`queryClient.setQueriesData`) when you have the exact delta — single-row status changes, removals. Use this for high-frequency events to avoid refetch storms.

`useContainers` does both: `CONTAINERS_LIST` invalidates; `CONTAINER_STATUS` and `CONTAINER_REMOVED` patch in place.

## Long-running operations: the task tracker

Operations like certificate issuance, stack apply, container connect, and HAProxy migrations report progress through a single registry-driven UI. The architecture:

```
TaskTrackerProvider (root context, persisted to sessionStorage)
  └─ TaskEventListener subscribes to Socket.IO
       └─ matches events using Task Type Registry
            └─ updates TrackedTask state (phase, steps, errors)
                 ├─ TaskTrackerPopover  (top-nav badge + list)
                 └─ TaskDetailDialog    (step-by-step detail view)
```

### Task Type Registry — [src/lib/task-type-registry.ts](src/lib/task-type-registry.ts)

A static map: `TaskType` → Socket.IO bindings + payload normalisers. Every tracked operation needs an entry. Each entry has:

- `channel` — the Socket.IO channel to subscribe to (a `Channel.*` constant).
- `startedEvent`, `stepEvent`, `completedEvent` — the three events. `stepEvent` is `null` for operations that emit no intermediate steps.
- `failedEvent` (optional) — when success and failure are split across two events (e.g. pool spawn). When omitted, the completed handler must produce both outcomes from one payload (the stack-apply pattern).
- `getId(payload)` — extracts the task ID from the started event.
- `normalizeStarted(payload)` → `{ totalSteps, plannedStepNames }`.
- `normalizeStep(payload)` → `OperationStep`.
- `normalizeCompleted(payload)` → `{ success, steps, errors }`.
- `invalidateKeys(taskId)` (optional) — TanStack Query keys to invalidate when the task completes.

Entries are built with `defineTaskTypeConfig()`, which infers the event-key generics so TypeScript validates each normaliser against the actual payload shape. The runtime registry erases those generics so `TaskEventListener` can iterate polymorphically.

### Adding a tracked operation

1. **Server side:** add channel + `*_STARTED` / `*_STEP` / `*_COMPLETED` constants to [lib/types/socket-events.ts](../lib/types/socket-events.ts) and emit them. See [server/ARCHITECTURE.md](../server/ARCHITECTURE.md#long-running-operations).
2. **Registry entry:** add an entry to [task-type-registry.ts](src/lib/task-type-registry.ts).
3. **Trigger:** in the component that starts the operation, call `trackTask({ id, type, label })` from `useTaskTracker()`. The tracker handles channel subscription, event matching, persistence, and UI rendering automatically.

### Local progress UI: `useOperationProgress`

When a dialog needs its own live step list (e.g. the certificate issuance dialog showing each ACME step), use [src/hooks/use-operation-progress.ts](src/hooks/use-operation-progress.ts) instead of writing one-off socket listeners:

```ts
const progress = useOperationProgress({
  channel: Channel.TLS,
  startedEvent: ServerEvent.CERT_ISSUANCE_STARTED,
  stepEvent: ServerEvent.CERT_ISSUANCE_STEP,
  completedEvent: ServerEvent.CERT_ISSUANCE_COMPLETED,
  operationId,
  getOperationId: (p) => p.operationId,
  getTotalSteps: (p) => p.totalSteps,
  getStep: (p) => p.step,
  getResult: (p) => ({ success: p.success, steps: p.steps, errors: p.errors }),
  tracker: { type: "cert-issuance", label: "Issuing certificate" }, // optional global tracking
  invalidateKeys: [["certificates"]],
  toasts: { success: "Certificate issued", error: "Issuance failed" },
  timeoutMs: 300_000,
});
```

It returns `{ phase, steps, totalSteps, errors, completedCount }` and handles subscription, cleanup, timeout, query invalidation, and toasts.

### Task tracker behaviours

- Active tasks are persisted to `sessionStorage` and survive page reloads.
- Completed tasks auto-dismiss after 5 minutes.
- Tasks restored from `sessionStorage` time out after 30 seconds if no events arrive (the operation likely finished while the tab was closed).
- `useOperationProgress` defaults to a 5-minute operation timeout.

## Cross-cutting concerns

### Cancellation

There are two flavours of cancellation, and only one of them is supported.

**In-flight queries** are cancellable via `queryClient.cancelQueries(...)`. We use this implicitly when a query refetches with new params — TanStack Query aborts the stale request. We don't expose user-driven query cancellation; it's not a UX we've needed.

**Long-running server operations** (stack apply, certificate issuance, etc.) **cannot be cancelled** from the UI. The reasoning is the same as the server's: each step has external state that a partial cancel would corrupt. The right pattern is to let the operation finish and then trigger a corrective action. `useOperationProgress` does enforce a timeout (default 5 minutes); on timeout the local UI gives up and shows an error, but the server-side work continues.

### Testing

Tests live in [src/__tests__/](src/__tests__/) and (sometimes) alongside the code. The toolchain is vitest. Component tests use [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/).

The most useful tests are around resource hooks — they exercise the TanStack Query + Socket.IO interaction that's hard to verify by inspection. Form schemas (Zod) are also valuable test targets because they double as runtime validation.

### Error handling

Three principles, in order:

1. **Network failures surface to the user.** TanStack Query's `error` state propagates to the component, which renders an error UI. We use sonner toasts ([@/components/ui/sonner](src/components/ui/sonner.tsx)) for transient errors and inline error states for in-page failures.
2. **Auth errors redirect.** [src/components/auth-error-boundary.tsx](src/components/auth-error-boundary.tsx) wraps every route and catches auth-shaped errors anywhere in the tree, forcing a clean redirect to `/login`. Don't catch 401s manually — let them bubble.
3. **Operation failures appear in the task tracker.** Long-running ops emit `*_COMPLETED` with `success: false` and `errors[]`. The tracker surfaces them in the popover and the detail dialog. Local progress dialogs (via `useOperationProgress`) get the same data and can render their own error UI.

### Observability

The client doesn't have a metrics or telemetry layer beyond the browser's devtools. The mental model:

- **Network panel** for HTTP traffic. Every request sets an `X-Correlation-ID` header so server logs can be tied back to a specific UI action.
- **Console** for client-side errors. We don't ship a Sentry-like crash reporter today.
- **Server logs** are the source of truth for any cross-cutting issue. The `requestId` and `operationId` machinery on the server side does the heavy lifting; the client's job is to make sure each request carries enough context.

For agent-related debugging, the agent sidecar's container logs are accessible from the Logs page in the app.

## Forms

Forms use [React Hook Form](https://react-hook-form.com/) + [Zod](https://zod.dev/) for schema validation. The Zod schemas often live next to the form (`src/lib/application-schemas.ts` is a representative example). When a server route validates the same shape, prefer sharing the schema via [@mini-infra/types](../lib/types/) so client and server can't drift.

## Auth and permissions

`AuthProvider` ([src/lib/auth-context.tsx](src/lib/auth-context.tsx)) wraps the router and exposes `useAuth()`. The auth context holds the current user, their permission scopes, and helpers for login/logout/refresh.

Permissions are scope strings of the form `resource:action`, defined in [@mini-infra/types/permissions](../lib/types/permissions.ts). Gate UI by checking scopes from auth context — never assume role names. The same scopes are enforced server-side, so the UI gate is for UX (hide/disable rather than silently fail).

## Vite and dev topology

[vite.config.ts](vite.config.ts) configures the build:

- **Dev server:** `0.0.0.0:3005`. Proxies `/api`, `/auth`, and `/socket.io` to `http://localhost:5005`. WebSocket proxying is enabled for `/socket.io` (and `/api` so SSE through `/api/.../logs/stream` works).
- **Aliases:** `@` → `./src`, `@mini-infra/types` → `../lib/types`. The types package is `optimizeDeps.exclude`d so Vite reads it directly from source instead of pre-bundling.
- **YAML import plugin:** lets `.yaml`/`.yml` files be imported as default JSON exports.
- **Build output:** `../server/public/`. The Express server statics-serves this directory in production, so `pnpm build` produces a deployable bundle without further wiring.

Worktree dev: each git worktree has its own VM, its own port allocation, and its own `environment-details.xml` at the worktree root. Read the UI URL from there rather than hard-coding `localhost:3005`. See the root [CLAUDE.md](../CLAUDE.md) for the worktree workflow.

## Adding a page

A typical end-to-end change:

1. **Route definition:** add to `createBrowserRouter()` in [src/lib/routes.tsx](src/lib/routes.tsx). Match the path style of nearby routes; nested params follow `[id]` folders under [src/app/](src/app/).
2. **Route metadata:** add an entry to [src/lib/route-config.ts](src/lib/route-config.ts) with `title`, `icon`, `parent` (for breadcrumbs), `showInNav` + `navGroup`/`navSection`, and `helpDoc` if relevant.
3. **Page component:** `src/app/<path>/page.tsx`. Keep it thin — assemble components and hooks.
4. **Feature components:** in [src/components/<feature>/](src/components/). Co-locate dialogs, tables, forms.
5. **Data hooks:** in [src/hooks/](src/hooks/). Follow the [useContainers.ts](src/hooks/useContainers.ts) pattern: TanStack Query + `useSocketChannel` + `useSocketEvent`, no polling when connected, `refetchOnReconnect: true`.
6. **User docs:** add a Markdown file under [src/user-docs/](src/user-docs/) and reference it via `helpDoc` in `route-config.ts`.
7. **`data-tour` IDs:** add them to interactive elements that the agent should be able to point at, then run `pnpm generate:ui-manifest`.
8. **Lint:** `pnpm --filter mini-infra-client lint` before opening a PR.

## Where to next

- [CLAUDE.md](CLAUDE.md) — task tracker and data-fetching pattern reference.
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — repo-wide context.
- [../server/ARCHITECTURE.md](../server/ARCHITECTURE.md) — the API and Socket.IO contracts the client consumes.
- [../lib/types/](../lib/types/) — shared types, event constants, permission scopes.
