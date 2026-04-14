# Zod-OpenAPI Route Metadata — Design Note

Status: **proposal, not implemented**. Captures the approach so we can pick it up later.

## Problem

The agent sidecar discovers Mini Infra's API surface by calling `GET /api/routes`, which uses `express-list-endpoints` to introspect the Express router. That gives the agent method + path + middleware names, but **no semantics** — it can't tell the agent what an endpoint does, what its side effects are, or when to use it.

Example: the new `POST /api/diagnostics/heap-snapshot` endpoint briefly pauses the event loop and returns a multi-hundred-MB file. The agent has no way to know that from the route listing alone.

We want a single source of truth where:

- route metadata (summary, tags, side effects, auth requirements) lives next to the route handler
- request/response shapes are typed and validated at runtime
- the same definitions feed `/api/routes` output consumed by the agent
- (optionally) we can emit a full OpenAPI 3.1 spec and host a Swagger UI

## Why zod-openapi

Two candidates were considered — `tsoa` and `zod-openapi`:

| | tsoa | zod-openapi |
|---|---|---|
| Style | Decorators on controller classes, AST codegen | Zod schemas + explicit `registry.registerPath()` |
| Routing | Owns your routing layer (generates `routes.ts`) | Drop-in — keeps existing Express routers |
| Build step | Required (`tsoa spec-and-routes`) | None — runtime only |
| Migration cost | High — every route becomes a controller | Low — adopt per-route, leave others alone |
| Agent fit | Gives full OpenAPI spec | Gives full OpenAPI spec |

We prefer **`zod-openapi`** (specifically `@asteasolutions/zod-to-openapi`) because it slots into the existing `Router` setup route-by-route. Routes that haven't been migrated still work; they just render without rich metadata.

## Design

### 1. Package

Install `@asteasolutions/zod-to-openapi` (extends Zod's prototype with `.openapi()`).

### 2. Shared schemas with metadata

Define request/response schemas as Zod types, annotated with OpenAPI descriptions:

```ts
// server/src/routes/diagnostics.schemas.ts
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const MemoryDiagnostics = z
  .object({
    timestamp: z.string().datetime(),
    uptimeSeconds: z.number().openapi({ description: "Process uptime in seconds" }),
    pid: z.number(),
    nodeVersion: z.string(),
    process: z.object({
      rss: z.number().openapi({ description: "Resident Set Size in bytes" }),
      heapTotal: z.number(),
      heapUsed: z.number(),
      external: z.number(),
      arrayBuffers: z.number(),
    }),
    // ...heap, heapSpaces
  })
  .openapi("MemoryDiagnostics");
```

### 3. A central registry

```ts
// server/src/lib/openapi-registry.ts
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

export const openApiRegistry = new OpenAPIRegistry();
```

### 4. Route-side registration

Each route registers its metadata next to the handler. Two ergonomic options:

**Option A — explicit `registerPath` calls alongside the route:**

```ts
// server/src/routes/diagnostics.ts
import { openApiRegistry } from "../lib/openapi-registry";
import { MemoryDiagnostics } from "./diagnostics.schemas";

openApiRegistry.registerPath({
  method: "get",
  path: "/api/diagnostics/memory",
  summary: "Current server process memory and V8 heap statistics",
  description:
    "Returns a snapshot of process.memoryUsage(), v8.getHeapStatistics(), and heap spaces. Safe to poll — no side effects.",
  tags: ["Diagnostics"],
  security: [{ permission: ["settings:read"] }],
  responses: {
    200: {
      description: "Memory snapshot",
      content: { "application/json": { schema: MemoryDiagnostics } },
    },
  },
});

router.get("/memory", requirePermission("settings:read"), handler);
```

**Option B — thin wrapper that does both:**

```ts
describeRoute(router, "get", "/memory", {
  summary: "Current server process memory and V8 heap statistics",
  tags: ["Diagnostics"],
  permission: "settings:read",
  sideEffects: "none",
  response: MemoryDiagnostics,
}, handler);
```

The wrapper calls `router.get(...)` **and** `openApiRegistry.registerPath(...)` so you can't forget one. Recommended.

### 5. Serving the spec and enriching `/api/routes`

- `GET /api/openapi.json` — emits the full OpenAPI document from the registry.
- `GET /api/routes` — rewritten to merge `express-list-endpoints` output with the registry, so each row shows summary, tags, side effects, and required permissions. This is what the agent will read.
- Optional: mount Swagger UI at `/api/docs` for human consumption.

### 6. Runtime validation (bonus)

Because the schemas are Zod, the same definitions can validate incoming request bodies / params via a small middleware — closing the gap between "documented" and "actually enforced".

## What rich metadata unlocks for the agent

With this in place, the agent sees entries like:

```
POST /api/diagnostics/heap-snapshot
  Summary: Capture a V8 heap snapshot and stream it to the caller
  Tags: Diagnostics
  Permission: settings:write
  Side effects: briefly pauses the event loop; produces a 50–500 MB file
  Request: (none)
  Response: application/octet-stream (.heapsnapshot)
```

…which lets it answer "how do I debug a memory leak?" correctly instead of guessing.

## Migration plan (when we pick this up)

1. Add `@asteasolutions/zod-to-openapi`, create the registry, define the `describeRoute` wrapper.
2. Adopt on `server/src/routes/diagnostics.ts` first — smallest surface, clear win for the agent.
3. Update `server/src/routes/api-routes.ts` to merge registry metadata into `/api/routes`.
4. Serve `/api/openapi.json` (and optionally Swagger UI).
5. Migrate remaining routes opportunistically — touch a file, convert its routes. Unmigrated routes keep working.

## Tradeoffs / things to watch

- **Drift**: nothing forces you to call `describeRoute` over `router.get`. A lint rule or a startup check comparing `express-list-endpoints` output against the registry would catch omissions.
- **Zod version alignment**: `@asteasolutions/zod-to-openapi` needs to match the installed Zod major. Pin accordingly.
- **Bundle/runtime cost**: negligible on the server; registry is populated at import time.
- **Schema duplication with `@mini-infra/types`**: shared types currently live in `lib/`. Either move the relevant Zod schemas there (and `z.infer` the TS types), or keep Zod schemas server-side and only share the inferred TS types with the client. The former is cleaner long-term.
