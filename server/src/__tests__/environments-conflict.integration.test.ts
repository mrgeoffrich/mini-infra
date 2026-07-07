/**
 * Phase 4 integration test for the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md) — the
 * environments/networks domain.
 *
 * Canonical failure per the plan's Phase 4 "Done when": creating an
 * environment with a duplicate name must yield a typed, actionable 409 —
 * not a 500 derived from string-matching Prisma's own "Unique constraint"
 * error text (the bug the route used to have). This test pins the fix at
 * the HTTP boundary, through the real Express app and the real central
 * error middleware, mirroring the Phase 1 reference test
 * (postgres-backup-quick-setup-conflict.integration.test.ts).
 *
 * Also covers the sibling canonical not-found case (GET a nonexistent
 * environment id) since both are one HTTP round-trip away from each other
 * in this domain and share the same envelope contract.
 */
import supertest from "supertest";
import type { Application } from "express";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";

// Route through the real Prisma-backed test database instead of the
// production singleton (same pattern as the Phase 1 reference test).
vi.mock("../lib/prisma", () => ({ default: testPrisma }));

// Bypass real session/API-key authentication — this test exercises the
// environments route's error taxonomy, not the auth layer.
vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  getCurrentUserId: () => "test-user",
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getAuthenticatedUser: () => ({ id: "test-user", email: "test@example.com" }),
}));

import { createApp } from "../app-factory";

describe("Environments API — canonical conflict/not-found envelopes (Phase 4)", () => {
  let app: Application;

  beforeEach(() => {
    app = createApp({ quiet: true });
  });

  it("returns 409 ENVIRONMENT_NAME_EXISTS (not a raw 500) for a duplicate environment name", async () => {
    const name = `env-${createId().slice(0, 8)}`;

    // First create succeeds as the 'local' environment.
    await supertest(app)
      .post("/api/environments")
      .send({ name, type: "nonproduction", networkType: "local" })
      .expect(201);

    // Re-running the same name but as the 'internet' networkType sidesteps
    // the route's separate "one environment per networkType" precheck (its
    // own, correctly-attributed 409 — see the network-type-conflict test
    // below) so this asserts the *name* conflict in isolation: it still
    // hits the `Environment.name` unique constraint — a raw Prisma error
    // the route used to string-match for 'Unique constraint'; now the
    // service (environment-manager.ts) attributes it directly.
    const response = await supertest(app)
      .post("/api/environments")
      .send({ name, type: "nonproduction", networkType: "internet" })
      .expect(409);

    expect(response.body).toMatchObject({
      error: "ENVIRONMENT_NAME_EXISTS",
      message: expect.stringContaining(name),
      resource: { type: "environment", name },
      action: expect.any(String),
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it("returns 409 ENVIRONMENT_NETWORK_TYPE_CONFLICT for a second environment of the same networkType", async () => {
    const first = `env-${createId().slice(0, 8)}`;
    const second = `env-${createId().slice(0, 8)}`;

    await supertest(app)
      .post("/api/environments")
      .send({ name: first, type: "nonproduction", networkType: "local" })
      .expect(201);

    const response = await supertest(app)
      .post("/api/environments")
      .send({ name: second, type: "nonproduction", networkType: "local" })
      .expect(409);

    expect(response.body).toMatchObject({
      error: "ENVIRONMENT_NETWORK_TYPE_CONFLICT",
      message: expect.stringContaining(first),
      resource: { type: "environment", name: first },
      action: expect.any(String),
    });
  });

  it("returns 404 ENVIRONMENT_NOT_FOUND for a nonexistent environment id", async () => {
    const missingId = `missing-${createId()}`;

    const response = await supertest(app)
      .get(`/api/environments/${missingId}`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: "ENVIRONMENT_NOT_FOUND",
      message: expect.stringContaining(missingId),
      resource: { type: "environment", id: missingId },
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });
});
