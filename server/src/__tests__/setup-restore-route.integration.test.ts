/**
 * Integration tests for the public, setup-scoped "Load from Backup" restore
 * routes (`/auth/setup/restore/*`).
 *
 * Covers the three properties that matter at the HTTP boundary:
 *   - the whole surface 403s once a user exists (the setup window has closed),
 *   - `/backups` returns only recognisable `mini-infra-*.db.zip` artifacts,
 *   - `/execute` schedules a restart on success and maps a newer-than-image
 *     backup to a 409 without restarting.
 *
 * The storage backend and the restore engine are mocked — the staging/guard
 * logic itself is unit-tested in `services/backup/__tests__/self-restore-executor.test.ts`.
 */

import supertest from "supertest";
import express from "express";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testPrisma,
  truncateIntegrationTestDatabase,
  createTestUser,
} from "./integration-test-helpers";

vi.mock("../lib/prisma", () => ({ default: testPrisma }));

// Keep the real error classes; stub the two functions with real side effects
// (network download + process restart) so tests stay hermetic.
vi.mock("../services/backup/self-restore-executor", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../services/backup/self-restore-executor")
  >();
  return {
    ...actual,
    stageRestore: vi.fn(),
    triggerRestoreRestart: vi.fn(),
  };
});

import setupRestoreRoutes from "../routes/setup-restore";
import { StorageService } from "../services/storage/storage-service";
import {
  stageRestore,
  triggerRestoreRestart,
  BackupNewerThanImageError,
} from "../services/backup/self-restore-executor";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/auth/setup/restore", setupRestoreRoutes);
  return app;
}

interface FakeBackend {
  list: ReturnType<typeof vi.fn>;
}

function stubStorage(backend: Partial<FakeBackend> = {}) {
  const fakeService = {
    getBackendByProviderIdOrThrow: vi.fn().mockResolvedValue(backend),
    setActiveProviderId: vi.fn().mockResolvedValue(undefined),
    isProviderConfigured: vi.fn().mockResolvedValue(false),
  };
  vi.spyOn(StorageService, "getInstance").mockReturnValue(
    fakeService as unknown as StorageService,
  );
  return fakeService;
}

describe("setup-restore route — setup-in-progress gate", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateIntegrationTestDatabase();
  });

  it("403s once a user exists", async () => {
    await createTestUser();
    stubStorage();
    const res = await supertest(buildApp())
      .post("/auth/setup/restore/backups")
      .send({ providerId: "azure", locationId: "backups" })
      .expect(403);
    expect(res.body).toMatchObject({ success: false });
  });

  it("allows access when no user exists yet", async () => {
    stubStorage({ list: vi.fn().mockResolvedValue({ objects: [], hasMore: false }) });
    const res = await supertest(buildApp())
      .post("/auth/setup/restore/backups")
      .send({ providerId: "azure", locationId: "backups" })
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { backups: [] } });
  });
});

describe("setup-restore route — /backups filtering", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateIntegrationTestDatabase();
  });

  it("returns only mini-infra-*.db.zip artifacts, newest first", async () => {
    const list = vi.fn().mockResolvedValue({
      objects: [
        {
          name: "mini-infra-2026-07-01T00-00-00.db.zip",
          size: 100,
          lastModified: new Date("2026-07-01T00:00:00Z"),
        },
        { name: "some-other-file.txt", size: 5, lastModified: new Date() },
        {
          name: "mini-infra-2026-07-05T00-00-00.db.zip",
          size: 200,
          lastModified: new Date("2026-07-05T00:00:00Z"),
        },
        { name: "postgres-backup.dump", size: 9, lastModified: new Date() },
      ],
      hasMore: false,
    });
    stubStorage({ list });

    const res = await supertest(buildApp())
      .post("/auth/setup/restore/backups")
      .send({ providerId: "azure", locationId: "backups" })
      .expect(200);

    const names = res.body.data.backups.map(
      (b: { objectName: string }) => b.objectName,
    );
    expect(names).toEqual([
      "mini-infra-2026-07-05T00-00-00.db.zip",
      "mini-infra-2026-07-01T00-00-00.db.zip",
    ]);
    expect(list).toHaveBeenCalledWith(
      { id: "backups" },
      expect.objectContaining({ prefix: "mini-infra-" }),
    );
  });
});

describe("setup-restore route — /execute", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateIntegrationTestDatabase();
  });

  it("stages the restore and schedules a restart on success", async () => {
    stubStorage();
    vi.mocked(stageRestore).mockResolvedValue({
      stagedDbPath: "/app/data/restore-pending.db",
      markerPath: "/app/data/.restore-pending",
      sizeBytes: 4096,
    });

    const res = await supertest(buildApp())
      .post("/auth/setup/restore/execute")
      .send({
        providerId: "azure",
        locationId: "backups",
        objectName: "mini-infra-2026-07-05T00-00-00.db.zip",
      })
      .expect(202);

    expect(res.body).toEqual({
      success: true,
      data: { staged: true, sizeBytes: 4096 },
    });
    expect(vi.mocked(stageRestore)).toHaveBeenCalledOnce();
    expect(vi.mocked(triggerRestoreRestart)).toHaveBeenCalledOnce();
  });

  it("maps a newer-than-image backup to 409 without restarting", async () => {
    stubStorage();
    vi.mocked(stageRestore).mockRejectedValue(
      new BackupNewerThanImageError("9999_from_the_future"),
    );

    const res = await supertest(buildApp())
      .post("/auth/setup/restore/execute")
      .send({
        providerId: "azure",
        locationId: "backups",
        objectName: "mini-infra-9999.db.zip",
      })
      .expect(409);

    expect(res.body).toMatchObject({
      success: false,
      errorCode: "BACKUP_NEWER_THAN_IMAGE",
    });
    expect(vi.mocked(triggerRestoreRestart)).not.toHaveBeenCalled();
  });
});
