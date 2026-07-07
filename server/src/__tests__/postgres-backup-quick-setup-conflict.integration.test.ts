/**
 * Reference integration test for Phase 1 of the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md).
 *
 * The reported incident: a duplicate POST /api/postgres/backup-configs/quick-setup
 * surfaced as "Database configuration with name '...' already exists" — a
 * database-config error, even though the user's action was "set up a
 * backup". This test pins the fix at the HTTP boundary: the central error
 * middleware (server/src/lib/error-handler.ts) must turn the duplicate
 * request into a 409 whose envelope correctly attributes the conflict to
 * the *backup config*, not the underlying database row.
 */
import supertest from "supertest";
import type { Application } from "express";
import { createId } from "@paralleldrive/cuid2";
import { testPrisma, createTestUser } from "./integration-test-helpers";

// A mutable ref the hoisted auth mock reads from — set per-test once the
// test user exists, so `getAuthenticatedUser()` returns a real userId that
// satisfies the `PostgresServer.userId` ownership check in
// `PostgresServerService.getServer()`.
const { authState } = vi.hoisted(() => ({ authState: { userId: "" } }));

// Route through the real Prisma-backed test database instead of the
// production singleton (same pattern as setup-restore-route.integration.test.ts).
vi.mock("../lib/prisma", () => ({ default: testPrisma }));

// Bypass real session/API-key authentication — this test exercises the
// quick-setup handler's own error taxonomy, not the auth layer. Every
// export of the barrel is provided because `createApp()` eagerly imports
// (and registers route middleware for) every router in the app, not just
// the postgres-backup-configs one; this is the same shape already proven
// safe in registry-credentials-api.integration.test.ts.
vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  getCurrentUserId: () => authState.userId,
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getAuthenticatedUser: () => ({
    id: authState.userId,
    email: "quick-setup-test@example.com",
  }),
}));

import { createApp } from "../app-factory";
import { StorageService } from "../services/storage/storage-service";

function stubAccessibleStorage(): void {
  vi.spyOn(StorageService, "getInstance").mockReturnValue({
    getActiveBackend: vi.fn().mockResolvedValue({
      providerId: "azure",
      testLocationAccess: vi.fn().mockResolvedValue({
        accessible: true,
        id: "postgres-backups",
        displayName: "postgres-backups",
      }),
    }),
  } as unknown as StorageService);
}

describe("POST /api/postgres/backup-configs/quick-setup — duplicate conflict attribution", () => {
  let app: Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    stubAccessibleStorage();
    app = createApp({ quiet: true });

    const user = await createTestUser();
    authState.userId = user.id;
  });

  it("returns 409 POSTGRES_BACKUP_CONFIG_EXISTS (not a database-config conflict) for a duplicate quick-setup", async () => {
    const environment = await testPrisma.environment.create({
      data: {
        name: `env-${createId().slice(0, 8)}`,
        type: "nonproduction",
        networkType: "local",
      },
    });

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

    const requestBody = {
      serverId: server.id,
      databaseName: "kumiko",
      environmentId: environment.id,
    };

    // First quick-setup succeeds — creates the PostgresDatabase row and its
    // attached BackupConfiguration.
    await supertest(app)
      .post("/api/postgres/backup-configs/quick-setup")
      .send(requestBody)
      .expect(201);

    // Re-running the exact same quick-setup deterministically maps to the
    // same database row. From the user's POV this is "I already set up a
    // backup for this" — the response must attribute the conflict to the
    // backup config, not the database config underneath it.
    const response = await supertest(app)
      .post("/api/postgres/backup-configs/quick-setup")
      .send(requestBody)
      .expect(409);

    expect(response.body).toMatchObject({
      error: "POSTGRES_BACKUP_CONFIG_EXISTS",
      message: expect.stringContaining("kumiko"),
      resource: { type: "postgresBackupConfig", name: "kumiko" },
      action: expect.any(String),
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });
});
