#!/usr/bin/env node
/**
 * Regenerates `lib/types/api-routes.generated.ts` — the flat `ALL_API_ROUTES`
 * enumeration of every route the live Express app registers. This is the
 * drift-check's source of truth: `server/src/__tests__/api-routes-drift.test.ts`
 * boots the app the exact same deterministic way and asserts the live route
 * set is *exactly* equal to this file's contents.
 *
 * Run via `pnpm gen:api-routes` (wraps this in `tsx` so it can import the
 * TypeScript server source — `server/src/app-factory.ts` and
 * `server/src/lib/route-enumerator.ts` — directly, no separate build step).
 * `pnpm build:lib` must have already run at least once so `@mini-infra/types`
 * resolves to a real `dist/` when the server's route files import it.
 *
 * ## Deterministic pinned env (must match the drift-check test exactly)
 *
 *   NODE_ENV=test                — keeps the dev-only `GET /` index route and
 *                                  the prod-only SPA catch-all out of the
 *                                  mount table (see app-factory.ts).
 *   LOG_LEVEL=silent             — quiets logger output during the boot.
 *   DATABASE_URL=<in-memory>     — route *registration* never touches the DB
 *                                  (handlers aren't invoked at mount time —
 *                                  only mounted), but several modules resolve
 *                                  Prisma at import time and throw if
 *                                  DATABASE_URL is unset. Same trick as
 *                                  `server/src/__tests__/setup-unit.ts`.
 *   ENABLE_DEV_API_KEY_ENDPOINT  — explicitly deleted/unset, so the
 *                                  dev-only `/api/dev` mount is OFF (the
 *                                  canonical "dev endpoints off" choice).
 *
 * See `server/src/lib/route-enumerator.ts` for why this doesn't reuse
 * `express-list-endpoints` (it silently drops mount prefixes on Express 5).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OUTPUT_PATH = resolve(REPO_ROOT, "lib/types/api-routes.generated.ts");
const SERVER_ROOT = resolve(REPO_ROOT, "server");
const ROUTE_ENUMERATOR_PATH = resolve(
  SERVER_ROOT,
  "src/lib/route-enumerator.ts",
);
const APP_FACTORY_PATH = resolve(SERVER_ROOT, "src/app-factory.ts");

// The server resolves config files (e.g. config/logging.json) relative to
// process.cwd(), which is normally `server/` when the server runs via
// `pnpm --filter mini-infra-server ...`. Match that so config loading
// behaves the same here as it does for the server itself and for the
// drift-check test (vitest's root is also `server/`).
process.chdir(SERVER_ROOT);

// Pin the deterministic env BEFORE any dynamic import below touches the
// server source (module-scope code in app-factory.ts and the route files it
// imports reads these at evaluation time).
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "file::memory:?cache=shared";
delete process.env.ENABLE_DEV_API_KEY_ENDPOINT;

async function main() {
  // `beginRouteMountTracking()` patches `Router.prototype.use` to tag nested
  // router mounts with their literal path. It MUST run before app-factory.ts
  // (and every route file it imports) is evaluated, because route files call
  // `router.use(prefix, subRouter)` at module-evaluation time — i.e. as soon
  // as they're first imported, not when `createApp()` runs.
  const { beginRouteMountTracking, enumerateRoutes } = await import(
    pathToFileURL(ROUTE_ENUMERATOR_PATH).href
  );

  const stopTracking = beginRouteMountTracking();
  const { createApp } = await import(pathToFileURL(APP_FACTORY_PATH).href);
  const app = createApp({ quiet: true });
  const routes = enumerateRoutes(app);
  stopTracking();

  if (routes.length === 0) {
    throw new Error(
      "enumerateRoutes() returned zero routes — something is wrong with the app boot or the enumerator; refusing to write an empty registry.",
    );
  }

  const lines = routes
    .map((r) => `  { method: "${r.method}", path: "${r.path}" },`)
    .join("\n");

  const contents = `/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Run \`pnpm gen:api-routes\` to regenerate from the live Express app (see
 * \`scripts/gen-api-routes.mjs\` and \`server/src/lib/route-enumerator.ts\`).
 */

export type ApiRouteEntry = { method: string; path: string };

export const ALL_API_ROUTES: readonly ApiRouteEntry[] = [
${lines}
] as const;
`;

  writeFileSync(OUTPUT_PATH, contents);
  console.log(`Wrote ${routes.length} routes to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
