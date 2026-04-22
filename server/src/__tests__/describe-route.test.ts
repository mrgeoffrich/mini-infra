import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router, RequestHandler } from "express";
import { z } from "zod";

// Mock permission-middleware so the wrapper doesn't pull in DB/auth deps.
// The mock returns a labeled middleware we can identity-check in assertions.
const mockPermissionMiddleware: RequestHandler = (_req, _res, next) => next();
vi.mock("../lib/permission-middleware", () => ({
  requirePermission: vi.fn(() => mockPermissionMiddleware),
}));

import { createRouteDescriber } from "../lib/describe-route";
import {
  openApiRegistry,
  listRouteMeta,
  getRouteMeta,
} from "../lib/openapi-registry";
import { requirePermission } from "../lib/permission-middleware";

function makeRouterStub() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as Router & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
}

describe("describeRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the route on the Express router with requirePermission injected first", () => {
    const router = makeRouterStub();
    const describe = createRouteDescriber(router, "/api/test");
    const handler: RequestHandler = (_req, res) => {
      res.json({ ok: true });
    };

    describe(
      "get",
      "/widgets",
      {
        summary: "List widgets",
        tags: ["Widgets"],
        permission: "settings:read",
        sideEffects: "none",
        response: z.object({ ok: z.boolean() }),
      },
      handler,
    );

    expect(requirePermission).toHaveBeenCalledWith("settings:read");
    expect(router.get).toHaveBeenCalledTimes(1);
    const call = router.get.mock.calls[0];
    expect(call[0]).toBe("/widgets");
    expect(call[1]).toBe(mockPermissionMiddleware);
    expect(call[2]).toBe(handler);
  });

  it("registers the route with the OpenAPI registry at the full mount path", () => {
    const router = makeRouterStub();
    const describe = createRouteDescriber(router, "/api/test");

    const before = openApiRegistry.definitions.length;
    describe(
      "post",
      "/widgets",
      {
        summary: "Create a widget",
        tags: ["Widgets"],
        permission: ["settings:write"],
        sideEffects: "writes a widget to the DB",
        request: { body: z.object({ name: z.string() }) },
        response: z.object({ id: z.string() }),
      },
      ((_req, _res) => undefined) as RequestHandler,
    );

    const definitions = openApiRegistry.definitions.slice(before);
    const routeDef = definitions.find(
      (d) => d.type === "route" && d.route.path === "/api/test/widgets",
    );
    expect(routeDef).toBeDefined();
  });

  it("remembers metadata keyed by method+full path for /api/routes enrichment", () => {
    const router = makeRouterStub();
    const describe = createRouteDescriber(router, "/api/test");

    describe(
      "get",
      "/alpha",
      {
        summary: "Alpha endpoint",
        tags: ["Alpha"],
        permission: "settings:read",
        sideEffects: "none",
      },
      ((_req, _res) => undefined) as RequestHandler,
    );

    const meta = getRouteMeta("GET", "/api/test/alpha");
    expect(meta).toMatchObject({
      method: "get",
      path: "/api/test/alpha",
      summary: "Alpha endpoint",
      tags: ["Alpha"],
      permission: "settings:read",
      sideEffects: "none",
    });
    expect(listRouteMeta().some((m) => m.path === "/api/test/alpha")).toBe(true);
  });

  it("joins nested routes under their mount path correctly", () => {
    const router = makeRouterStub();
    const describe = createRouteDescriber(router, "/api/test/");

    describe(
      "get",
      "/beta",
      {
        summary: "Beta",
        permission: "settings:read",
        sideEffects: "none",
      },
      ((_req, _res) => undefined) as RequestHandler,
    );

    expect(getRouteMeta("GET", "/api/test/beta")).toBeDefined();
  });
});
