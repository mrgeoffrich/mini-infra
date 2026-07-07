/**
 * Phase 8 (HAProxy domain) of the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md) pins the
 * domain's canonical not-found/conflict actions at the HTTP boundary: the
 * central error middleware (server/src/lib/error-handler.ts) must turn a
 * manual-frontend action against a missing frontend, and a route update that
 * collides with an existing hostname, into the shared envelope with a
 * stable machine `code`, `resource`, and `action` — not a raw 404/409 with an
 * ad-hoc body shape (the pre-migration behaviour).
 */
import supertest from "supertest";
import type { Application } from "express";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

// Route through the real Prisma-backed test database instead of the
// production singleton (same pattern as postgres-backup-quick-setup-conflict.integration.test.ts).
vi.mock("../lib/prisma", () => ({ default: testPrisma }));

// Bypass real session/API-key authentication — these tests exercise the
// HAProxy route handlers' own error taxonomy, not the auth layer. Every
// export of the barrel is provided because `createApp()` eagerly imports
// (and registers route middleware for) every router in the app, not just
// the haproxy ones — same shape already proven safe in
// registry-credentials-api.integration.test.ts.
vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  getCurrentUserId: () => "test-user-id",
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getAuthenticatedUser: () => ({ id: "test-user-id", email: "haproxy-test@example.com" }),
}));

import { createApp } from "../app-factory";

describe("HAProxy domain — canonical not-found/conflict error envelopes", () => {
  let app: Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp({ quiet: true });
  });

  it("PUT /api/haproxy/manual-frontends/:frontendName returns 404 HAPROXY_FRONTEND_NOT_FOUND for a missing frontend", async () => {
    const missingFrontendName = `manual_missing_${createId().slice(0, 8)}`;

    const response = await supertest(app)
      .put(`/api/haproxy/manual-frontends/${missingFrontendName}`)
      .send({ hostname: "new-hostname.example.com" })
      .expect(404);

    expect(response.body).toMatchObject({
      error: "HAPROXY_FRONTEND_NOT_FOUND",
      message: expect.stringContaining(missingFrontendName),
      resource: { type: "haproxyFrontend", name: missingFrontendName },
      action: expect.any(String),
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it("DELETE /api/haproxy/manual-frontends/:frontendName returns 404 HAPROXY_FRONTEND_NOT_FOUND for a missing frontend", async () => {
    const missingFrontendName = `manual_missing_${createId().slice(0, 8)}`;

    const response = await supertest(app)
      .delete(`/api/haproxy/manual-frontends/${missingFrontendName}`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: "HAPROXY_FRONTEND_NOT_FOUND",
      resource: { type: "haproxyFrontend", name: missingFrontendName },
    });
  });

  it("PATCH /api/haproxy/frontends/:frontendName/routes/:routeId returns 409 HAPROXY_HOSTNAME_IN_USE for a duplicate hostname on the same shared frontend", async () => {
    const sharedFrontend = await testPrisma.hAProxyFrontend.create({
      data: {
        frontendType: "shared",
        frontendName: `shared-test-${createId().slice(0, 8)}`,
        backendName: "placeholder-backend",
        hostname: "placeholder.internal",
        isSharedFrontend: true,
        status: "active",
      },
    });

    const existingRoute = await testPrisma.hAProxyRoute.create({
      data: {
        sharedFrontendId: sharedFrontend.id,
        hostname: "existing.example.com",
        aclName: "acl_existing_example_com",
        backendName: "be_existing",
        sourceType: "manual",
        status: "active",
      },
    });

    const routeToUpdate = await testPrisma.hAProxyRoute.create({
      data: {
        sharedFrontendId: sharedFrontend.id,
        hostname: "other.example.com",
        aclName: "acl_other_example_com",
        backendName: "be_other",
        sourceType: "manual",
        status: "active",
      },
    });

    // Renaming routeToUpdate onto existingRoute's hostname collides — the
    // domain's canonical "hostname already in use" conflict.
    const response = await supertest(app)
      .patch(`/api/haproxy/frontends/${sharedFrontend.frontendName}/routes/${routeToUpdate.id}`)
      .send({ hostname: existingRoute.hostname })
      .expect(409);

    expect(response.body).toMatchObject({
      error: "HAPROXY_HOSTNAME_IN_USE",
      message: expect.stringContaining("already exists"),
      resource: { type: "haproxyRoute", name: existingRoute.hostname },
      action: expect.any(String),
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });
});
