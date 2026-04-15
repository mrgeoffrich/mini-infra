import request from "supertest";
import type { Application } from "express";

// Mock logger factory first (before other imports)
vi.mock("../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function() { return mockLoggerInstance; }), // Required for pino-http
    level: "info",
    levels: {
      values: {
        fatal: 60,
        error: 50,
        warn: 40,
        info: 30,
        debug: 20,
        trace: 10,
      },
    },
    silent: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };

  return {
    getLogger: vi.fn(function() { return mockLoggerInstance; }),
    createLogger: vi.fn(function() { return mockLoggerInstance; }),
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    loadbalancerLogger: vi.fn(function() { return mockLoggerInstance; }),
    deploymentLogger: vi.fn(function() { return mockLoggerInstance; }),
    dockerExecutorLogger: vi.fn(function() { return mockLoggerInstance; }),
    selfBackupLogger: vi.fn(function() { return mockLoggerInstance; }),
    tlsLogger: vi.fn(function() { return mockLoggerInstance; }),
    agentLogger: vi.fn(function() { return mockLoggerInstance; }),
    clearLoggerCache: vi.fn(),
    createChildLogger: vi.fn(function() { return mockLoggerInstance; }),
    serializeError: (e: unknown) => e,
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Mock auth middleware to bypass authentication
vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id" };
    next();
  },
  requirePermission: () => (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id" };
    next();
  },
  getCurrentUserId: (req: any) => "test-user-id",
  requireAuth: (req: any, res: any, next: any) => next(),
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id" }),
}));

// Mock self-backup services to avoid better-sqlite3 dependency
vi.mock("../services/backup/self-backup-executor", () => ({
  SelfBackupExecutor: vi.fn(),
}));

vi.mock("../services/backup/self-backup-scheduler", () => ({
  SelfBackupScheduler: vi.fn(),
}));

import { testPrisma, createTestUser } from "./integration-test-helpers";
import { createApp } from "../app-factory";
import createRegistryCredentialsRouter from "../routes/registry-credentials";
import { RegistryCredentialService } from "../services/registry-credential";
import { buildRegistryCredentialRequest } from "./test-data-factories";

describe("Registry Credentials API", () => {
  let app: Application;
  let authToken: string;
  let userId: string;
  let registryCredentialService: RegistryCredentialService;

  beforeEach(async () => {
    registryCredentialService = new RegistryCredentialService(testPrisma);
    app = createApp({
      includeRouteIds: ["registryCredentials"],
      routeOverrides: {
        registryCredentials: createRegistryCredentialsRouter({
          registryCredentialService,
        }),
      },
      quiet: true,
    });

    // Create test user
    const user = await createTestUser();
    userId = user.id;

    // Mock JWT token for authentication
    authToken = `Bearer test-token-${userId}`;
  });

  function buildCredentialPayload(
    overrides: Parameters<typeof buildRegistryCredentialRequest>[0] = {},
  ) {
    return buildRegistryCredentialRequest(overrides);
  }

  function createCredential(
    overrides: Parameters<typeof buildRegistryCredentialRequest>[0] = {},
  ) {
    return registryCredentialService.createCredential(
      buildCredentialPayload(overrides),
      userId,
    );
  }

  describe("POST /api/registry-credentials", () => {
    test("should create a new registry credential", async () => {
      const credentialData = buildCredentialPayload({
        name: "Test Registry",
        registryUrl: "ghcr.io",
        username: "testuser",
        password: "testpassword123",
        description: "Test description",
      });

      const response = await request(app)
        .post("/api/registry-credentials")
        .set("Authorization", authToken)
        .send(credentialData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.name).toBe(credentialData.name);
      expect(response.body.data.registryUrl).toBe(credentialData.registryUrl);
      expect(response.body.data.username).toBe(credentialData.username);
      expect(response.body.data.password).toBeUndefined(); // Password should not be returned
    });

    test("should validate required fields", async () => {
      const invalidData = {
        name: "Test Registry",
        // Missing registryUrl, username, password
      };

      const response = await request(app)
        .post("/api/registry-credentials")
        .set("Authorization", authToken)
        .send(invalidData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation failed");
    });

    test("should succeed without explicit auth header (auth middleware is mocked)", async () => {
      const credentialData = buildCredentialPayload({
        name: "Test Registry",
        registryUrl: "ghcr.io",
        username: "testuser",
        password: "testpassword123",
      });

      // Auth middleware is mocked to always authenticate,
      // so requests without explicit auth headers still succeed
      await request(app)
        .post("/api/registry-credentials")
        .send(credentialData)
        .expect(201);
    });
  });

  describe("GET /api/registry-credentials", () => {
    test("should return all active credentials", async () => {
      // Create test credentials
      await createCredential({
        name: "Registry 1",
        registryUrl: "registry1.example.com",
        username: "user1",
        password: "pass1",
        isActive: true,
      });

      await createCredential({
        name: "Registry 2",
        registryUrl: "registry2.example.com",
        username: "user2",
        password: "pass2",
        isActive: true,
      });

      const response = await request(app)
        .get("/api/registry-credentials")
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].password).toBeUndefined(); // Passwords should not be returned
    });

    test("should exclude inactive credentials by default", async () => {
      await createCredential({
        name: "Active Registry",
        registryUrl: "active.example.com",
        username: "user",
        password: "pass",
        isActive: true,
      });

      await createCredential({
        name: "Inactive Registry",
        registryUrl: "inactive.example.com",
        username: "user",
        password: "pass",
        isActive: false,
      });

      const response = await request(app)
        .get("/api/registry-credentials")
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].name).toBe("Active Registry");
    });

    test("should include inactive credentials when requested", async () => {
      await createCredential({
        name: "Active Registry",
        registryUrl: "active.example.com",
        username: "user",
        password: "pass",
        isActive: true,
      });

      await createCredential({
        name: "Inactive Registry",
        registryUrl: "inactive.example.com",
        username: "user",
        password: "pass",
        isActive: false,
      });

      const response = await request(app)
        .get("/api/registry-credentials?includeInactive=true")
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
    });
  });

  describe("GET /api/registry-credentials/:id", () => {
    test("should return a specific credential", async () => {
      const credential = await createCredential({
        name: "Test Registry",
        registryUrl: "test.example.com",
        username: "testuser",
        password: "testpass",
      });

      const response = await request(app)
        .get(`/api/registry-credentials/${credential.id}`)
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(credential.id);
      expect(response.body.data.name).toBe("Test Registry");
      expect(response.body.data.password).toBeUndefined(); // Password should not be returned
    });

    test("should return 404 for non-existent credential", async () => {
      const response = await request(app)
        .get("/api/registry-credentials/non-existent-id")
        .set("Authorization", authToken)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Credential not found");
    });
  });

  describe("PUT /api/registry-credentials/:id", () => {
    test("should update a credential", async () => {
      const credential = await createCredential({
        name: "Original Name",
        registryUrl: "test.example.com",
        username: "originaluser",
        password: "originalpass",
      });

      const updateData = {
        name: "Updated Name",
        username: "updateduser",
      };

      const response = await request(app)
        .put(`/api/registry-credentials/${credential.id}`)
        .set("Authorization", authToken)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe("Updated Name");
      expect(response.body.data.username).toBe("updateduser");
    });

    test("should update password", async () => {
      const credential = await createCredential({
        name: "Test Registry",
        registryUrl: "test.example.com",
        username: "user",
        password: "oldpassword",
      });

      const updateData = {
        password: "newpassword123",
      };

      const response = await request(app)
        .put(`/api/registry-credentials/${credential.id}`)
        .set("Authorization", authToken)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify password was updated by checking the database
      const updated = await registryCredentialService.getCredential(
        credential.id,
      );
      expect(updated?.password).not.toBe(credential.password);
    });
  });

  describe("DELETE /api/registry-credentials/:id", () => {
    test("should soft delete a credential", async () => {
      const credential = await createCredential({
        name: "To Delete",
        registryUrl: "delete.example.com",
        username: "user",
        password: "pass",
      });

      const response = await request(app)
        .delete(`/api/registry-credentials/${credential.id}`)
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify it was soft deleted
      const deleted = await registryCredentialService.getCredential(
        credential.id,
      );
      expect(deleted?.isActive).toBe(false);
    });
  });

  describe("POST /api/registry-credentials/:id/set-default", () => {
    test("should set a credential as default", async () => {
      const credential = await createCredential({
        name: "Test Registry",
        registryUrl: "test.example.com",
        username: "user",
        password: "pass",
        isDefault: false,
      });

      const response = await request(app)
        .post(`/api/registry-credentials/${credential.id}/set-default`)
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify it was set as default
      const updated = await registryCredentialService.getCredential(
        credential.id,
      );
      expect(updated?.isDefault).toBe(true);
    });

    test("should unset previous default when setting new default", async () => {
      const first = await createCredential({
        name: "First Registry",
        registryUrl: "first.example.com",
        username: "user",
        password: "pass",
        isDefault: true,
      });

      const second = await createCredential({
        name: "Second Registry",
        registryUrl: "second.example.com",
        username: "user",
        password: "pass",
        isDefault: false,
      });

      await request(app)
        .post(`/api/registry-credentials/${second.id}/set-default`)
        .set("Authorization", authToken)
        .expect(200);

      // Verify first is no longer default
      const updatedFirst = await registryCredentialService.getCredential(
        first.id,
      );
      expect(updatedFirst?.isDefault).toBe(false);

      // Verify second is now default
      const updatedSecond = await registryCredentialService.getCredential(
        second.id,
      );
      expect(updatedSecond?.isDefault).toBe(true);
    });
  });

  describe("POST /api/registry-credentials/:id/test", () => {
    test("should test a credential", async () => {
      const credential = await createCredential({
        name: "Test Registry",
        registryUrl: "test.example.com",
        username: "user",
        password: "pass",
      });

      const response = await request(app)
        .post(`/api/registry-credentials/${credential.id}/test`)
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.registryUrl).toBe("test.example.com");
    });
  });

  describe("POST /api/registry-credentials/test-connection", () => {
    test("should test a connection without saving", async () => {
      const testData = buildCredentialPayload({
        registryUrl: "ghcr.io",
        username: "testuser",
        password: "testpass",
      });

      const response = await request(app)
        .post("/api/registry-credentials/test-connection")
        .set("Authorization", authToken)
        .send(testData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.registryUrl).toBe("ghcr.io");
    });

    test("should validate test connection data", async () => {
      const invalidData = {
        registryUrl: "ghcr.io",
        // Missing username and password
      };

      const response = await request(app)
        .post("/api/registry-credentials/test-connection")
        .set("Authorization", authToken)
        .send(invalidData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation failed");
    });
  });
});
