/**
 * HTTP-level integration test for Phase 5 of the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md).
 *
 * The domain's canonical failure — acting on a certificate ID that doesn't
 * exist (e.g. renewing/deleting a missing certificate) — must surface as a
 * typed 404 through the central error middleware
 * (server/src/lib/error-handler.ts), not a bespoke ad-hoc JSON body. This
 * pins that at the HTTP boundary for both the DELETE and GET routes in
 * server/src/routes/tls-certificates.ts.
 */
import supertest from "supertest";
import type { Application } from "express";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma, createTestUser } from "./integration-test-helpers";

const { authState } = vi.hoisted(() => ({ authState: { userId: "" } }));

// Route through the real Prisma-backed test database instead of the
// production singleton (same pattern as postgres-backup-quick-setup-conflict.integration.test.ts).
vi.mock("../lib/prisma", () => ({ default: testPrisma }));

// Bypass real session/API-key authentication — this test exercises the
// certificates route's error taxonomy, not the auth layer.
vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  getCurrentUserId: () => authState.userId,
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getAuthenticatedUser: () => ({
    id: authState.userId,
    email: "tls-certificate-test@example.com",
  }),
}));

import { createApp } from "../app-factory";

describe("TLS certificate routes — missing certificate ID envelope", () => {
  let app: Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp({ quiet: true });

    const user = await createTestUser();
    authState.userId = user.id;
  });

  it("DELETE /api/tls/certificates/:id returns 404 TLS_CERTIFICATE_NOT_FOUND for an unknown ID", async () => {
    const missingId = createId();

    const response = await supertest(app)
      .delete(`/api/tls/certificates/${missingId}`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: "TLS_CERTIFICATE_NOT_FOUND",
      message: expect.stringContaining(missingId),
      resource: { type: "tlsCertificate", id: missingId },
      action: expect.any(String),
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it("GET /api/tls/certificates/:id returns 404 TLS_CERTIFICATE_NOT_FOUND for an unknown ID", async () => {
    const missingId = createId();

    const response = await supertest(app)
      .get(`/api/tls/certificates/${missingId}`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: "TLS_CERTIFICATE_NOT_FOUND",
      message: expect.stringContaining(missingId),
      resource: { type: "tlsCertificate", id: missingId },
      action: expect.any(String),
    });
  });
});
