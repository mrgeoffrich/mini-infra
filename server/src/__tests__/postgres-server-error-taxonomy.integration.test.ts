/**
 * Phase 11 (enforcement sweep) of the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md) migrates the
 * postgres-server domain (PG server/database/user/grant management — not to
 * be confused with the `postgres` backup domain) off raw
 * `throw new Error(...)` and off the routes' `error.message === "..."`
 * string-matching. This test pins the domain's canonical not-found actions
 * at the HTTP boundary: the central error middleware
 * (server/src/lib/error-handler.ts) must turn a lookup against a missing
 * server/database into the shared envelope with a stable machine `code`,
 * `resource`, and `action` — not a raw 404 with an ad-hoc body shape (the
 * pre-migration behaviour), and not a 500 (the routes previously fell
 * through to a generic 500 handler for anything that wasn't string-matched).
 */
import supertest from "supertest";
import type { Application } from "express";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma, createTestUser } from "./integration-test-helpers";

// A mutable ref the hoisted auth mock reads from — set per-test once the
// test user exists, so `getCurrentUserId()` returns a real userId that
// satisfies the `PostgresServer.userId` ownership check in
// `PostgresServerService.getServer()`.
const { authState } = vi.hoisted(() => ({ authState: { userId: "" } }));

// Route through the real Prisma-backed test database instead of the
// production singleton (same pattern as postgres-backup-quick-setup-conflict.integration.test.ts).
vi.mock("../lib/prisma", () => ({ default: testPrisma }));

// Bypass real session/API-key authentication — these tests exercise the
// postgres-server route handlers' own error taxonomy, not the auth layer.
// Every export of the barrel is provided because `createApp()` eagerly
// imports (and registers route middleware for) every router in the app, not
// just the postgres-server ones — same shape already proven safe in
// registry-credentials-api.integration.test.ts.
vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  getCurrentUserId: () => authState.userId,
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getAuthenticatedUser: () => ({
    id: authState.userId,
    email: "postgres-server-taxonomy-test@example.com",
  }),
}));

import { createApp } from "../app-factory";

describe("Postgres-server domain — canonical not-found error envelopes", () => {
  let app: Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createApp({ quiet: true });

    const user = await createTestUser();
    authState.userId = user.id;
  });

  it("GET /api/postgres-server/servers/:id returns 404 PG_SERVER_NOT_FOUND for a missing server", async () => {
    const missingServerId = `missing-server-${createId().slice(0, 8)}`;

    const response = await supertest(app)
      .get(`/api/postgres-server/servers/${missingServerId}`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: "PG_SERVER_NOT_FOUND",
      message: "Server not found",
      resource: { type: "postgresServer", id: missingServerId },
      action: expect.any(String),
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it("GET /api/postgres-server/servers/:serverId/databases/:dbId returns 404 PG_DATABASE_NOT_FOUND for a missing database on an existing server", async () => {
    const server = await testPrisma.postgresServer.create({
      data: {
        name: `pg-server-${createId().slice(0, 8)}`,
        host: "127.0.0.1",
        port: 5432,
        adminUsername: "postgres",
        connectionString:
          "postgresql://postgres:test-admin-pw@127.0.0.1:5432/postgres?sslmode=prefer",
        sslMode: "prefer",
        userId: authState.userId,
      },
    });

    const missingDatabaseId = `missing-db-${createId().slice(0, 8)}`;

    const response = await supertest(app)
      .get(`/api/postgres-server/servers/${server.id}/databases/${missingDatabaseId}`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: "PG_DATABASE_NOT_FOUND",
      message: "Database not found",
      resource: { type: "postgresManagedDatabase", id: missingDatabaseId },
      action: expect.any(String),
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });
});
