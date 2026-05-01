/**
 * Tests for /api/storage/* routes (Phase 1: Azure-only).
 *
 * These tests focus on the HTTP contract — wiring, validation, and the shape
 * of responses — using a mocked AzureStorageBackend so the suite is fast and
 * doesn't reach the Azure SDK.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Hoist all mock objects so vi.mock factory bodies can read them.
const {
  mockPrisma,
  azureBackendMethods,
  storageServiceMethods,
} = vi.hoisted(() => ({
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
    selfBackup: {
      count: vi.fn().mockResolvedValue(0),
    },
    backupOperation: {
      count: vi.fn().mockResolvedValue(0),
    },
    userEvent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  azureBackendMethods: {
    getConnectionString: vi.fn().mockResolvedValue(null),
    getStorageAccountName: vi.fn().mockResolvedValue(null),
    getHealthStatus: vi.fn().mockResolvedValue({
      service: "storage",
      status: "failed",
      lastChecked: new Date(),
    }),
    setConnectionString: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    removeConfiguration: vi.fn().mockResolvedValue(undefined),
    validate: vi.fn().mockResolvedValue({ isValid: true, message: "ok" }),
    listLocations: vi.fn().mockResolvedValue([]),
    testLocationAccess: vi.fn().mockResolvedValue({
      id: "demo",
      displayName: "demo",
      accessible: true,
      metadata: { responseTimeMs: 10 },
    }),
  },
  storageServiceMethods: {
    getActiveProviderId: vi.fn().mockResolvedValue(null),
    setActiveProviderId: vi.fn().mockResolvedValue(undefined),
  },
}));

// Auth middleware — pass-through so route handlers see a fixed user.
vi.mock("../../middleware/auth", () => {
  const passthrough: express.RequestHandler = (req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "test-user" };
    next();
  };
  return {
    requirePermission: () => passthrough,
    getAuthenticatedUser: (req: express.Request) =>
      (req as unknown as { user?: { id: string } }).user ?? null,
  };
});

vi.mock("../../lib/prisma", () => ({ default: mockPrisma }));

vi.mock("../../services/storage/providers/azure/azure-storage-backend", () => ({
  AzureStorageBackend: vi.fn(function () { return azureBackendMethods; }),
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

// Imports happen AFTER the vi.mock calls so the route module sees the mocks.
import storageSettingsRouter from "../storage-settings";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/storage", storageSettingsRouter);
  return app;
}

describe("storage settings routes", () => {
  beforeEach(() => {
    // Reset call counts only — the method bodies are the shared mocks above.
    azureBackendMethods.getConnectionString.mockReset().mockResolvedValue(null);
    azureBackendMethods.getStorageAccountName.mockReset().mockResolvedValue(null);
    azureBackendMethods.getHealthStatus.mockReset().mockResolvedValue({
      service: "storage",
      status: "failed",
      lastChecked: new Date(),
    });
    azureBackendMethods.setConnectionString.mockReset().mockResolvedValue(undefined);
    azureBackendMethods.set.mockReset().mockResolvedValue(undefined);
    azureBackendMethods.removeConfiguration.mockReset().mockResolvedValue(undefined);
    azureBackendMethods.validate.mockReset().mockResolvedValue({
      isValid: true,
      message: "ok",
    });
    azureBackendMethods.listLocations.mockReset().mockResolvedValue([]);
    azureBackendMethods.testLocationAccess.mockReset().mockResolvedValue({
      id: "demo",
      displayName: "demo",
      accessible: true,
      metadata: { responseTimeMs: 10 },
    });
    storageServiceMethods.getActiveProviderId.mockReset().mockResolvedValue(null);
    storageServiceMethods.setActiveProviderId.mockReset().mockResolvedValue(undefined);
    mockPrisma.systemSettings.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.systemSettings.upsert.mockReset();
    mockPrisma.systemSettings.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    mockPrisma.tlsCertificate.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.tlsCertificate.count.mockReset().mockResolvedValue(0);
    mockPrisma.selfBackup.count.mockReset().mockResolvedValue(0);
    mockPrisma.backupOperation.count.mockReset().mockResolvedValue(0);
    mockPrisma.userEvent.findMany.mockReset().mockResolvedValue([]);
  });

  it("GET / returns active provider + slot map", async () => {
    storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
    mockPrisma.systemSettings.findMany.mockResolvedValueOnce([
      {
        category: "storage",
        key: "locations.postgres_backup",
        value: "pg-backups",
      },
      {
        category: "storage",
        key: "locations.self_backup",
        value: "self-backups",
      },
    ]);

    const res = await request(buildApp()).get("/api/storage/").expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.activeProviderId).toBe("azure");
    expect(res.body.data.locations.postgresBackup).toBe("pg-backups");
    expect(res.body.data.locations.selfBackup).toBe("self-backups");
    expect(res.body.data.locations.tlsCertificates).toBeNull();
  });

  it("PUT /active-provider validates and persists provider id", async () => {
    const res = await request(buildApp())
      .put("/api/storage/active-provider")
      .send({ providerId: "azure" })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(storageServiceMethods.setActiveProviderId).toHaveBeenCalledWith(
      "azure",
      "test-user",
    );
  });

  it("PUT /active-provider rejects unknown provider id", async () => {
    const res = await request(buildApp())
      .put("/api/storage/active-provider")
      .send({ providerId: "definitely-not-a-real-provider" })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("PUT /azure stores connection string when valid", async () => {
    const validConn =
      "DefaultEndpointsProtocol=https;AccountName=acc;AccountKey=k==;EndpointSuffix=core.windows.net";
    azureBackendMethods.getConnectionString.mockResolvedValueOnce(validConn);
    azureBackendMethods.getStorageAccountName.mockResolvedValueOnce("acc");

    const res = await request(buildApp())
      .put("/api/storage/azure")
      .send({ connectionString: validConn })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(azureBackendMethods.setConnectionString).toHaveBeenCalledWith(
      validConn,
      "test-user",
    );
    expect(storageServiceMethods.setActiveProviderId).toHaveBeenCalledWith(
      "azure",
      "test-user",
    );
  });

  it("PUT /azure rejects malformed connection string", async () => {
    const res = await request(buildApp())
      .put("/api/storage/azure")
      .send({ connectionString: "not-a-real-conn-string" })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("DELETE /azure wipes provider config", async () => {
    const res = await request(buildApp()).delete("/api/storage/azure").expect(200);
    expect(res.body.success).toBe(true);
    expect(azureBackendMethods.removeConfiguration).toHaveBeenCalledWith("test-user");
  });

  it("POST /azure/validate forwards to backend", async () => {
    azureBackendMethods.validate.mockResolvedValueOnce({
      isValid: true,
      message: "Azure Storage connection successful (acc)",
      responseTimeMs: 50,
      metadata: { accountName: "acc", containerCount: 3 },
    });
    const res = await request(buildApp())
      .post("/api/storage/azure/validate")
      .send({})
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isValid).toBe(true);
    expect(azureBackendMethods.validate).toHaveBeenCalled();
  });

  it("GET /azure/locations returns Azure-shaped container list", async () => {
    azureBackendMethods.listLocations.mockResolvedValueOnce([
      {
        id: "container-a",
        displayName: "container-a",
        accessible: true,
        lastModified: new Date().toISOString(),
        metadata: { leaseStatus: "unlocked", leaseState: "available" },
      },
    ]);
    azureBackendMethods.getStorageAccountName.mockResolvedValueOnce("acc");
    const res = await request(buildApp())
      .get("/api/storage/azure/locations")
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.containerCount).toBe(1);
    expect(res.body.data.containers[0].name).toBe("container-a");
  });

  it("POST /azure/test-location proxies to backend", async () => {
    const res = await request(buildApp())
      .post("/api/storage/azure/test-location")
      .send({ locationId: "demo" })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(azureBackendMethods.testLocationAccess).toHaveBeenCalledWith({
      id: "demo",
    });
  });

  it("PUT /locations/:slot upserts the slot mapping", async () => {
    const res = await request(buildApp())
      .put("/api/storage/locations/locations.postgres_backup")
      .send({ locationId: "pg-backups" })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(mockPrisma.systemSettings.upsert).toHaveBeenCalled();
  });

  // ============================================================
  // Phase 4 — switch precheck
  // ============================================================
  describe("GET /switch-precheck", () => {
    it("rejects unknown target provider", async () => {
      const res = await request(buildApp())
        .get("/api/storage/switch-precheck?targetProvider=not-a-thing")
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it("returns canSwitch=true with empty lists when no certs/backups/in-flight", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      const res = await request(buildApp())
        .get("/api/storage/switch-precheck?targetProvider=google-drive")
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.canSwitch).toBe(true);
      expect(res.body.data.blockReasons).toEqual([]);
      expect(res.body.data.inFlightOperations).toEqual([]);
      expect(res.body.data.activeCerts.count).toBe(0);
      expect(res.body.data.acme.hasInFlightChallenge).toBe(false);
    });

    it("hard-blocks when there is an in-flight backup operation", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      mockPrisma.userEvent.findMany.mockResolvedValueOnce([
        {
          id: "evt-1",
          eventType: "backup",
          status: "running",
          startedAt: new Date("2026-04-01T00:00:00Z"),
        },
      ]);
      const res = await request(buildApp())
        .get("/api/storage/switch-precheck?targetProvider=google-drive")
        .expect(200);
      expect(res.body.data.canSwitch).toBe(false);
      expect(res.body.data.inFlightOperations).toHaveLength(1);
      expect(res.body.data.blockReasons[0]).toMatch(/in flight/);
    });

    it("hard-blocks when ACME has an in-flight challenge (PENDING/RENEWING)", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      mockPrisma.tlsCertificate.count.mockResolvedValueOnce(2);
      const res = await request(buildApp())
        .get("/api/storage/switch-precheck?targetProvider=google-drive")
        .expect(200);
      expect(res.body.data.canSwitch).toBe(false);
      expect(res.body.data.acme.hasInFlightChallenge).toBe(true);
      expect(res.body.data.blockReasons.join("\n")).toMatch(/ACME challenge/);
    });

    it("emits a warning when an active cert is within 30 days of expiry", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      // Cert expires in 10 days — within 30-day window.
      const tenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      mockPrisma.tlsCertificate.findMany.mockResolvedValueOnce([
        { id: "cert-1", notAfter: tenDays },
      ]);
      const res = await request(buildApp())
        .get("/api/storage/switch-precheck?targetProvider=google-drive")
        .expect(200);
      expect(res.body.data.canSwitch).toBe(true);
      expect(res.body.data.activeCerts.anyWithin30Days).toBe(true);
      expect(res.body.data.warnings.length).toBeGreaterThan(0);
      expect(res.body.data.warnings.join("\n")).toMatch(/30 days/);
    });

    it("includes history counts on the outgoing provider", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      mockPrisma.backupOperation.count.mockResolvedValueOnce(7);
      mockPrisma.selfBackup.count.mockResolvedValueOnce(3);
      const res = await request(buildApp())
        .get("/api/storage/switch-precheck?targetProvider=google-drive")
        .expect(200);
      expect(res.body.data.postgresBackupHistoryCount).toBe(7);
      expect(res.body.data.selfBackupHistoryCount).toBe(3);
      expect(mockPrisma.backupOperation.count).toHaveBeenCalledWith({
        where: { storageProviderAtCreation: "azure" },
      });
    });

    it("returns trivial OK when target equals active", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      const res = await request(buildApp())
        .get("/api/storage/switch-precheck?targetProvider=azure")
        .expect(200);
      expect(res.body.data.canSwitch).toBe(true);
      expect(res.body.data.blockReasons).toEqual([]);
      expect(mockPrisma.tlsCertificate.findMany).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Phase 4 — provider forget
  // ============================================================
  describe("POST /:provider/forget", () => {
    it("returns 409 when the provider is currently active", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      const res = await request(buildApp())
        .post("/api/storage/azure/forget")
        .send({})
        .expect(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/active/i);
      expect(mockPrisma.systemSettings.deleteMany).not.toHaveBeenCalled();
    });

    it("returns 409 with referencing-row count when there is history and force is missing", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      mockPrisma.backupOperation.count.mockResolvedValueOnce(2);
      mockPrisma.selfBackup.count.mockResolvedValueOnce(1);
      const res = await request(buildApp())
        .post("/api/storage/google-drive/forget")
        .send({})
        .expect(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("PROVIDER_HAS_REFERENCING_ROWS");
      expect(res.body.data.referencingRowCount).toBe(3);
      expect(mockPrisma.systemSettings.deleteMany).not.toHaveBeenCalled();
    });

    it("wipes provider config when force=true even if rows reference it", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      mockPrisma.backupOperation.count.mockResolvedValueOnce(2);
      mockPrisma.selfBackup.count.mockResolvedValueOnce(1);
      mockPrisma.systemSettings.deleteMany.mockResolvedValueOnce({ count: 4 });
      const res = await request(buildApp())
        .post("/api/storage/google-drive/forget?force=true")
        .send({})
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.referencingRowCount).toBe(3);
      expect(res.body.data.deletedConfigRowCount).toBe(4);
      expect(res.body.data.forced).toBe(true);
      expect(mockPrisma.systemSettings.deleteMany).toHaveBeenCalledWith({
        where: { category: "storage-google-drive" },
      });
    });

    it("wipes provider config when there are no referencing rows", async () => {
      storageServiceMethods.getActiveProviderId.mockResolvedValueOnce("azure");
      // counts default to 0 already
      mockPrisma.systemSettings.deleteMany.mockResolvedValueOnce({ count: 2 });
      const res = await request(buildApp())
        .post("/api/storage/google-drive/forget")
        .send({})
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.referencingRowCount).toBe(0);
      expect(res.body.data.deletedConfigRowCount).toBe(2);
      expect(mockPrisma.systemSettings.deleteMany).toHaveBeenCalledWith({
        where: { category: "storage-google-drive" },
      });
    });

    it("rejects unknown provider", async () => {
      const res = await request(buildApp())
        .post("/api/storage/not-a-provider/forget")
        .send({})
        .expect(400);
      expect(res.body.success).toBe(false);
    });
  });
});
