import type { Application } from "express";
import { Router } from "express";

export type RawRoute = { method: string; path: string };

const MOUNT_PATH = Symbol("mountPath");

type StackHolder = { stack: unknown[] };
type UseFn = (this: StackHolder, ...args: unknown[]) => unknown;

/**
 * Enumerates every registered (method, path) pair on a live Express
 * application built by `createApp()` — the source of truth backing
 * `ALL_API_ROUTES` (see `scripts/gen-api-routes.mjs` and the drift-check test
 * in `server/src/__tests__`).
 *
 * ## Why not `express-list-endpoints`
 *
 * That library (still the runtime enumerator behind `GET /api/routes`, see
 * `routes/api-routes.ts`) recovers a mounted router's prefix by parsing the
 * `RegExp` text that Express 4's `path-to-regexp` used to attach to each
 * router `Layer`. Express 5 replaced that internal router with the
 * standalone `router` package, whose `Layer` only stores opaque matcher
 * *functions* — there is no `.regexp` (or any other inspectable property) to
 * recover the literal mount-path string from once it's compiled.
 *
 * Verified empirically while building this generator:
 * `expressListEndpoints(app)` against this app returns every route with its
 * mount prefix silently dropped (e.g. `/containers` instead of
 * `/api/containers`) — so `GET /api/routes` is already degraded on Express 5.
 * That's a pre-existing bug, tracked separately, and out of scope for this
 * drift-check (see Phase 2 report).
 *
 * `Route.path` — the leaf handler path passed to `router.get()` / `.post()` /
 * etc. — is untouched by that change and remains reliable on every Express
 * version. So this walker reads leaf paths from `layer.route.path` directly.
 * For *nested* router mounts (`router.use(path, subRouter)`, e.g.
 * `postgres-server/servers.ts`'s `/:serverId/databases`), the literal
 * mount-path string is recovered via a narrowly-scoped monkeypatch of
 * `Router.prototype.use` that tags each newly-pushed `Layer` with the raw
 * path argument before it gets compiled away. The patch never touches
 * dispatch behavior (routing/matching is untouched) — it only attaches an
 * extra property, used solely for this enumeration pass.
 *
 * ## Usage — patch BEFORE importing route modules
 *
 * Route files call `router.use(prefix, subRouter)` at module-evaluation time
 * (e.g. `agent.ts` does `router.use("/settings", agentSettingsRouter)` at the
 * top level), which happens as soon as `app-factory.ts` (or any route file)
 * is imported — i.e. *before* `createApp()` runs. The tracking patch must
 * therefore be installed before that first import, not just before calling
 * `createApp()`:
 *
 * ```ts
 * import { beginRouteMountTracking, enumerateRoutes } from "./route-enumerator";
 *
 * const stopTracking = beginRouteMountTracking();
 * const { createApp } = await import("./app-factory"); // dynamic import — must come after
 * const app = createApp({ quiet: true });
 * const routes = enumerateRoutes(app);
 * stopTracking();
 * ```
 */
export function beginRouteMountTracking(): () => void {
  const RouterCtor = Router as unknown as { prototype: { use: UseFn } };
  const originalUse = RouterCtor.prototype.use;

  RouterCtor.prototype.use = function (this: StackHolder, ...args: unknown[]) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);

    let path: string | undefined;
    if (typeof args[0] !== "function") {
      let arg: unknown = args[0];
      while (Array.isArray(arg) && arg.length > 0) arg = arg[0];
      if (typeof arg !== "function") path = args[0] as string;
    }

    if (path && path !== "/") {
      for (let i = before; i < this.stack.length; i++) {
        (this.stack[i] as Record<symbol, unknown>)[MOUNT_PATH] = path;
      }
    }

    return result;
  };

  return () => {
    RouterCtor.prototype.use = originalUse;
  };
}

function joinMountPath(base: string, segment: string | undefined): string {
  if (!segment || segment === "/") return base;
  const b = base.replace(/\/$/, "");
  const s = segment.startsWith("/") ? segment : `/${segment}`;
  return `${b}${s}`;
}

/**
 * Walk the (already-tagged, see `beginRouteMountTracking`) router stack of a
 * live app and return the flat, deduplicated (method, path) list.
 */
export function enumerateRoutes(app: Application): RawRoute[] {
  const routes: RawRoute[] = [];
  const seen = new Map<string, Set<string>>();

  function record(method: string, path: string): void {
    const normalized = path.replace(/\/{2,}/g, "/") || "/";
    const methods = seen.get(normalized) ?? new Set<string>();
    if (!methods.has(method)) {
      methods.add(method);
      routes.push({ method, path: normalized });
    }
    seen.set(normalized, methods);
  }

  function walk(stack: unknown[], basePath: string): void {
    for (const layer of stack as Array<Record<string | symbol, unknown>>) {
      const route = layer.route as
        | { path: string; methods: Record<string, boolean> }
        | undefined;

      if (route) {
        const methods = Object.keys(route.methods)
          .filter((m) => m !== "_all")
          .map((m) => m.toUpperCase());
        const fullPath = joinMountPath(basePath, route.path);
        for (const method of methods) record(method, fullPath);
        continue;
      }

      const handle = layer.handle as { stack?: unknown[] } | undefined;
      if (handle && Array.isArray(handle.stack)) {
        const mountPath = layer[MOUNT_PATH] as string | undefined;
        walk(handle.stack, joinMountPath(basePath, mountPath));
      }
    }
  }

  const appRouter = (app as unknown as { router: StackHolder }).router;
  walk(appRouter.stack, "");

  routes.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
  return routes;
}
