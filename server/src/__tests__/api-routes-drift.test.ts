/**
 * Phase 2 of the frontend/backend contract migration
 * (docs/planning/not-shipped/frontend-backend-contract-plan.md): asserts the
 * live Express route set exactly equals the generated `ALL_API_ROUTES`
 * registry in `@mini-infra/types`, and that the ergonomic `ApiBase`/
 * `ApiRoute` layers can't silently drift from that flat list either.
 *
 * If this test fails after you added, removed, or renamed a route, run
 * `pnpm gen:api-routes` to regenerate `lib/types/api-routes.generated.ts`,
 * then `pnpm build:lib`, then re-run this test.
 *
 * IMPORTANT: this file must NOT statically import `../app-factory` (or any
 * route file). Route files call `router.use(prefix, subRouter)` at
 * module-evaluation time (e.g. `routes/agent.ts` mounts its settings
 * sub-router as soon as it's first imported), which happens as soon as
 * `app-factory.ts` is imported — before `createApp()` even runs. The mount
 * mount-path tracking patch installed by `beginRouteMountTracking()` must be
 * in place *before* that first import, so `createApp` is loaded via a
 * dynamic `import()` inside `beforeAll`, after tracking begins. See
 * `server/src/lib/route-enumerator.ts` for the full rationale (including why
 * this doesn't just use `express-list-endpoints`, which silently drops mount
 * prefixes on Express 5).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ALL_API_ROUTES, ApiBase, ApiRoute } from "@mini-infra/types";
import type { ContainerAction } from "@mini-infra/types/containers";
import {
  beginRouteMountTracking,
  enumerateRoutes,
  type RawRoute,
} from "../lib/route-enumerator";

describe("API route registry drift-check", () => {
  let liveRoutes: RawRoute[];

  beforeAll(async () => {
    const stopTracking = beginRouteMountTracking();
    const { createApp } = await import("../app-factory");
    const app = createApp({ quiet: true });
    liveRoutes = enumerateRoutes(app);
    stopTracking();
  });

  it("boots with a non-trivial route set (sanity check on the harness itself)", () => {
    expect(liveRoutes.length).toBeGreaterThan(100);
  });

  it("matches ALL_API_ROUTES exactly — no route added, removed, or renamed without regenerating", () => {
    const live = liveRoutes.map((r) => `${r.method} ${r.path}`).sort();
    const registry = ALL_API_ROUTES.map((r) => `${r.method} ${r.path}`).sort();

    const onlyLive = live.filter((r) => !registry.includes(r));
    const onlyRegistry = registry.filter((r) => !live.includes(r));

    if (onlyLive.length > 0 || onlyRegistry.length > 0) {
      const parts: string[] = [
        "ALL_API_ROUTES (lib/types/api-routes.generated.ts) has drifted from the live Express route set.",
        "Fix: run `pnpm gen:api-routes`, then `pnpm build:lib`, and commit the regenerated file.",
      ];
      if (onlyLive.length > 0) {
        parts.push(
          `\nLive but missing from ALL_API_ROUTES:\n  ${onlyLive.join("\n  ")}`,
        );
      }
      if (onlyRegistry.length > 0) {
        parts.push(
          `\nIn ALL_API_ROUTES but no longer live (stale):\n  ${onlyRegistry.join("\n  ")}`,
        );
      }
      throw new Error(parts.join("\n"));
    }

    expect(live).toEqual(registry);
  });

  it("does not mount the dev-only /api/dev endpoint under the pinned deterministic env", () => {
    // The drift-check (and the generator, scripts/gen-api-routes.mjs) pin
    // ENABLE_DEV_API_KEY_ENDPOINT unset — see server/src/__tests__/setup-unit.ts
    // for the rest of the pinned env (NODE_ENV=test, in-memory DATABASE_URL).
    const devRoutes = liveRoutes.filter((r) =>
      r.path.startsWith(ApiBase.devApiKey),
    );
    expect(devRoutes).toEqual([]);
  });
});

describe("ApiBase / ApiRoute consistency with ALL_API_ROUTES", () => {
  const registryKeys = new Set(
    ALL_API_ROUTES.map((r) => `${r.method} ${r.path}`),
  );
  const registryPaths = ALL_API_ROUTES.map((r) => r.path);

  it("every ApiBase value has at least one matching route in ALL_API_ROUTES", () => {
    for (const [id, base] of Object.entries(ApiBase)) {
      // devApiKey is intentionally excluded from ALL_API_ROUTES under the
      // pinned generator/drift-check env (see the dedicated test above) —
      // it's still a real mount in production when the env var is set.
      if (id === "devApiKey") continue;

      const hasMatch = registryPaths.some(
        (path) => path === base || path.startsWith(`${base}/`),
      );
      expect(
        hasMatch,
        `ApiBase.${id} (${base}) has no matching entry in ALL_API_ROUTES`,
      ).toBe(true);
    }
  });

  it("every ApiRoute.containers.* builder renders a path present in ALL_API_ROUTES", () => {
    // Placeholder segments render the ":param" form so the output matches
    // ALL_API_ROUTES' normalized shape exactly.
    const rendered: Array<{ method: string; path: string }> = [
      { method: "GET", path: ApiRoute.containers.list() },
      { method: "GET", path: ApiRoute.containers.postgres() },
      { method: "GET", path: ApiRoute.containers.managedIds() },
      { method: "GET", path: ApiRoute.containers.get(":id") },
      { method: "GET", path: ApiRoute.containers.env(":id") },
      { method: "GET", path: ApiRoute.containers.cacheStats() },
      { method: "POST", path: ApiRoute.containers.flushCache() },
      { method: "GET", path: ApiRoute.containers.logsStream(":id") },
      {
        method: "POST",
        path: ApiRoute.containers.action(":id", ":action" as ContainerAction),
      },
    ];

    for (const { method, path } of rendered) {
      const key = `${method} ${path}`;
      expect(
        registryKeys.has(key),
        `${key} (from an ApiRoute.containers builder) is missing from ALL_API_ROUTES`,
      ).toBe(true);
    }
  });
});
