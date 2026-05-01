/**
 * Auth-gating regression tests for /api/storage/* routes.
 *
 * These tests mount the router behind a `requirePermission` mock that rejects
 * with 403, asserting that destructive endpoints actually wire up
 * `storage:write`. A 200 from a denying middleware would mean we forgot to
 * gate the route.
 */

import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const { mockPrisma, azureBackendMethods, storageServiceMethods } = vi.hoisted(
  () => ({
    mockPrisma: {
      systemSettings: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      connectivityStatus: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      tlsCertificate: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      selfBackup: { count: vi.fn().mockResolvedValue(0) },
      backupOperation: { count: vi.fn().mockResolvedValue(0) },
      userEvent: { findMany: vi.fn().mockResolvedValue([]) },
    },
    azureBackendMethods: {
      getConnectionString: vi.fn().mockResolvedValue(null),
      getStorageAccountName: vi.fn().mockResolvedValue(null),
      getHealthStatus: vi.fn().mockResolvedValue({}),
      setConnectionString: vi.fn().mockResolvedValue(undefined),
      removeConfiguration: vi.fn().mockResolvedValue(undefined),
      validate: vi.fn().mockResolvedValue({ isValid: true }),
      listLocations: vi.fn().mockResolvedValue([]),
      testLocationAccess: vi.fn().mockResolvedValue({ accessible: true }),
    },
    storageServiceMethods: {
      getActiveProviderId: vi.fn().mockResolvedValue(null),
      setActiveProviderId: vi.fn().mockResolvedValue(undefined),
    },
  }),
);

// `requirePermission` mock that always denies — exercises the gate without
// needing a full role/permission setup.
vi.mock("../../middleware/auth", () => {
  const denyAll: express.RequestHandler = (_req, res) => {
    res.status(403).json({ success: false, error: "Forbidden" });
  };
  return {
    requirePermission: () => denyAll,
    getAuthenticatedUser: () => ({ id: "test-user" }),
  };
});

vi.mock("../../lib/prisma", () => ({ default: mockPrisma }));

vi.mock("../../services/storage/providers/azure/azure-storage-backend", () => ({
  AzureStorageBackend: vi.fn(function () {
    return azureBackendMethods;
  }),
}));

vi.mock("../../services/storage/storage-service", () => ({
  StorageService: { getInstance: () => storageServiceMethods },
  StorageNotConfiguredError: class extends Error {},
  StorageProviderUnregisteredError: class extends Error {},
  ProviderNoLongerConfiguredError: class extends Error {},
  STORAGE_LOCATION_KEYS: {
    POSTGRES_BACKUP: "locations.postgres_backup",
    SELF_BACKUP: "locations.self_backup",
    TLS_CERTIFICATES: "locations.tls_certificates",
  },
}));

import storageSettingsRouter from "../storage-settings";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/storage", storageSettingsRouter);
  return app;
}

describe("storage settings auth gating", () => {
  it("denies PUT /active-provider without storage:write", async () => {
    await request(buildApp())
      .put("/api/storage/active-provider")
      .send({ providerId: "azure" })
      .expect(403);
  });

  it("denies PUT /azure without storage:write", async () => {
    await request(buildApp()).put("/api/storage/azure").send({}).expect(403);
  });

  it("denies POST /:provider/forget without storage:write", async () => {
    await request(buildApp())
      .post("/api/storage/google-drive/forget")
      .send({})
      .expect(403);
  });
});
