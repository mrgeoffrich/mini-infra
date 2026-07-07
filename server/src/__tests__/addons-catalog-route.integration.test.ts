/**
 * Integration test for the addon catalog endpoint (addon-authoring-ui plan,
 * Phase 2). Exercises `GET /api/addons` over the real router through
 * supertest, asserting it returns the three registered addons projected into
 * `AddonCatalogEntry` shape.
 *
 * The NON-EMPTY assertions are load-bearing: they prove the route module
 * pulled `productionAddonRegistry` from the `stack-addons` BARREL (whose
 * side-effect imports register the addons) rather than from `registry.ts`
 * directly (which would yield an empty list). See `routes/addons.ts`.
 *
 * `requirePermission` is mocked to a pass-through so the test targets the
 * handler + registry projection, not the auth middleware (the permission wire-
 * up is covered structurally by the route + the api-routes drift check).
 */
import supertest from "supertest";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { describe, it, expect, vi } from "vitest";
import type { AddonCatalogEntry, AddonCatalogResponse } from "@mini-infra/types";
import { errorHandler } from "../lib/error-handler";

vi.mock("../middleware/auth", () => ({
  requirePermission:
    () => (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: { id: string } }).user = { id: "session-user" };
      next();
    },
}));

// Imported after the mock so the router picks up the mocked middleware.
import addonsRoutes from "../routes/addons";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/addons", addonsRoutes);
  app.use(errorHandler);
  return app;
}

function getById(
  addons: AddonCatalogEntry[],
  id: string,
): AddonCatalogEntry {
  const entry = addons.find((a) => a.id === id);
  if (!entry) throw new Error(`addon "${id}" missing from catalog`);
  return entry;
}

describe("GET /api/addons — addon catalog", () => {
  it("returns the three registered addons (registry is populated)", async () => {
    const res = await supertest(buildApp()).get("/api/addons").expect(200);
    const body = res.body as AddonCatalogResponse;

    expect(Array.isArray(body.addons)).toBe(true);
    // Load-bearing: a non-empty list proves the barrel side-effects ran.
    expect(body.addons.length).toBe(3);
    expect(body.addons.map((a) => a.id).sort()).toEqual([
      "claude-shell",
      "tailscale-ssh",
      "tailscale-web",
    ]);
  });

  it("projects tailscale-ssh with sidecar mode, Pool support, and its config field", async () => {
    const res = await supertest(buildApp()).get("/api/addons").expect(200);
    const entry = getById((res.body as AddonCatalogResponse).addons, "tailscale-ssh");

    expect(entry.mode).toBe("sidecar");
    expect(entry.requiresConnectedService).toBe("tailscale");
    expect(entry.appliesTo).toEqual(
      expect.arrayContaining(["Stateful", "StatelessWeb", "Pool"]),
    );
    expect(entry.configFields.map((f) => f.name)).toEqual(["extraTags"]);
    expect(entry.configFields.every((f) => f.required === false)).toBe(true);
  });

  it("projects tailscale-web with a required numeric port field", async () => {
    const res = await supertest(buildApp()).get("/api/addons").expect(200);
    const entry = getById((res.body as AddonCatalogResponse).addons, "tailscale-web");

    expect(entry.mode).toBe("sidecar");
    expect(entry.requiresConnectedService).toBe("tailscale");
    const port = entry.configFields.find((f) => f.name === "port");
    expect(port).toMatchObject({
      type: "number",
      required: true,
      min: 1,
      max: 65535,
    });
    expect(entry.configFields.map((f) => f.name).sort()).toEqual([
      "extraTags",
      "path",
      "port",
    ]);
  });

  it("projects claude-shell as env-injection mode without Pool support", async () => {
    const res = await supertest(buildApp()).get("/api/addons").expect(200);
    const entry = getById((res.body as AddonCatalogResponse).addons, "claude-shell");

    expect(entry.mode).toBe("env-injection");
    expect(entry.requiresConnectedService).toBe("tailscale");
    expect(entry.appliesTo).toEqual(["Stateful", "StatelessWeb"]);
    expect(entry.appliesTo).not.toContain("Pool");
    expect(entry.configFields.length).toBeGreaterThan(0);
    expect(entry.configFields.map((f) => f.name).sort()).toEqual([
      "extraTags",
      "gitRepo",
    ]);
  });
});
