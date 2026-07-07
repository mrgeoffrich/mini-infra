/**
 * HTTP-level reference test for Phase 9 of the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md) — the api-keys
 * domain's canonical not-found case: revoking/rotating/deleting an API key
 * that doesn't exist (or isn't owned by the caller) must come back as a 404
 * carrying the standard envelope, not the legacy `{ error: "Not found",
 * message: "..." }` shape the route used to hand-roll.
 */
import supertest from "supertest";
import type { Application } from "express";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma, createTestUser } from "./integration-test-helpers";

const { authState } = vi.hoisted(() => ({ authState: { userId: "" } }));

// Route through the real Prisma-backed test database instead of the
// production singleton (same pattern as postgres-backup-quick-setup-conflict).
vi.mock("../lib/prisma", () => ({ default: testPrisma }));

// Bypass permission checks — this test exercises the api-key-service error
// taxonomy, not the permission layer. Every export of the barrel is provided
// because `createApp()` eagerly imports every router in the app.
vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  getCurrentUserId: () => authState.userId,
  getCurrentUser: () => ({ id: authState.userId }),
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getAuthenticatedUser: () => ({
    id: authState.userId,
    email: "api-keys-test@example.com",
  }),
}));

import { createApp } from "../app-factory";

describe("PATCH /api/keys/:keyId/revoke — not-found/not-owned attribution", () => {
  let app: Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp({ quiet: true });

    const user = await createTestUser();
    authState.userId = user.id;
  });

  it("returns 404 API_KEY_NOT_FOUND with the standard envelope for a key that doesn't exist", async () => {
    const missingKeyId = createId();

    const response = await supertest(app)
      .patch(`/api/keys/${missingKeyId}/revoke`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: "API_KEY_NOT_FOUND",
      message: expect.stringContaining("not found"),
      resource: { type: "apiKey", id: missingKeyId },
      action: expect.any(String),
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it("returns the same 404 envelope for a key owned by a different user", async () => {
    const otherUser = await createTestUser();
    const otherKey = await testPrisma.apiKey.create({
      data: {
        id: createId(),
        name: "Someone else's key",
        key: `mk_${createId().padEnd(64, "0")}`,
        userId: otherUser.id,
        active: true,
      },
    });

    const response = await supertest(app)
      .patch(`/api/keys/${otherKey.id}/revoke`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: "API_KEY_NOT_FOUND",
      message: expect.stringContaining("not owned"),
      resource: { type: "apiKey", id: otherKey.id },
    });
  });
});
