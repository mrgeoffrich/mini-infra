import request from "supertest";

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
    createLogger: vi.fn(function() { return mockLoggerInstance; }),
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    loadbalancerLogger: vi.fn(function() { return mockLoggerInstance; }),
    deploymentLogger: vi.fn(function() { return mockLoggerInstance; }),
    dockerExecutorLogger: vi.fn(function() { return mockLoggerInstance; }),
    tlsLogger: vi.fn(function() { return mockLoggerInstance; }),
    agentLogger: vi.fn(function() { return mockLoggerInstance; }),
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Mock auth middleware to bypass authentication
vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
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

import { testPrisma, createTestUser } from "./setup";

// Mock prisma to use testPrisma
vi.mock("../lib/prisma", async () => {
  const { testPrisma: tp } = await import("./setup");
  return { default: tp };
});

import app from "../app";
import { RegistryCredentialService } from "../services/registry-credential";

describe("Registry Credentials API", () => {
  let authToken: string;
  let userId: string;
  let registryCredentialService: RegistryCredentialService;

  beforeEach(async () => {
    registryCredentialService = new RegistryCredentialService(testPrisma);

    // Clean up existing test data
    await testPrisma.registryCredential.deleteMany({});

    // Create test user
    const user = await createTestUser();
    userId = user.id;

    // Mock JWT token for authentication
    authToken = `Bearer test-token-${userId}`;
  });

  afterEach(async () => {
    // Clean up test data
    await testPrisma.registryCredential.deleteMany({});
  });

  describe("POST /api/registry-credentials", () => {
    test("should create a new registry credential", async () => {
      const credentialData = {
        name: "Test Registry",
        registryUrl: "ghcr.io",
        username: "testuser",
        password: "testpassword123",
        description: "Test description",
      };

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

    test("should require authentication", async () => {
      const credentialData = {
        name: "Test Registry",
        registryUrl: "ghcr.io",
        username: "testuser",
        password: "testpassword123",
      };

      await request(app)
        .post("/api/registry-credentials")
        .send(credentialData)
        .expect(401);
    });
  });

  describe("GET /api/registry-credentials", () => {
    test("should return all active credentials", async () => {
      // Create test credentials
      await registryCredentialService.createCredential(
        {
          name: "Registry 1",
          registryUrl: "registry1.example.com",
          username: "user1",
          password: "pass1",
          isActive: true,
        },
        userId,
      );

      await registryCredentialService.createCredential(
        {
          name: "Registry 2",
          registryUrl: "registry2.example.com",
          username: "user2",
          password: "pass2",
          isActive: true,
        },
        userId,
      );

      const response = await request(app)
        .get("/api/registry-credentials")
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].password).toBeUndefined(); // Passwords should not be returned
    });

    test("should exclude inactive credentials by default", async () => {
      await registryCredentialService.createCredential(
        {
          name: "Active Registry",
          registryUrl: "active.example.com",
          username: "user",
          password: "pass",
          isActive: true,
        },
        userId,
      );

      await registryCredentialService.createCredential(
        {
          name: "Inactive Registry",
          registryUrl: "inactive.example.com",
          username: "user",
          password: "pass",
          isActive: false,
        },
        userId,
      );

      const response = await request(app)
        .get("/api/registry-credentials")
        .set("Authorization", authToken)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].name).toBe("Active Registry");
    });

    test("should include inactive credentials when requested", async () => {
      await registryCredentialService.createCredential(
        {
          name: "Active Registry",
          registryUrl: "active.example.com",
          username: "user",
          password: "pass",
          isActive: true,
        },
        userId,
      );

      await registryCredentialService.createCredential(
        {
          name: "Inactive Registry",
          registryUrl: "inactive.example.com",
          username: "user",
          password: "pass",
          isActive: false,
        },
        userId,
      );

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
      const credential = await registryCredentialService.createCredential(
        {
          name: "Test Registry",
          registryUrl: "test.example.com",
          username: "testuser",
          password: "testpass",
        },
        userId,
      );

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
      const credential = await registryCredentialService.createCredential(
        {
          name: "Original Name",
          registryUrl: "test.example.com",
          username: "originaluser",
          password: "originalpass",
        },
        userId,
      );

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
      const credential = await registryCredentialService.createCredential(
        {
          name: "Test Registry",
          registryUrl: "test.example.com",
          username: "user",
          password: "oldpassword",
        },
        userId,
      );

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
      const credential = await registryCredentialService.createCredential(
        {
          name: "To Delete",
          registryUrl: "delete.example.com",
          username: "user",
          password: "pass",
        },
        userId,
      );

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
      const credential = await registryCredentialService.createCredential(
        {
          name: "Test Registry",
          registryUrl: "test.example.com",
          username: "user",
          password: "pass",
          isDefault: false,
        },
        userId,
      );

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
      const first = await registryCredentialService.createCredential(
        {
          name: "First Registry",
          registryUrl: "first.example.com",
          username: "user",
          password: "pass",
          isDefault: true,
        },
        userId,
      );

      const second = await registryCredentialService.createCredential(
        {
          name: "Second Registry",
          registryUrl: "second.example.com",
          username: "user",
          password: "pass",
          isDefault: false,
        },
        userId,
      );

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
      const credential = await registryCredentialService.createCredential(
        {
          name: "Test Registry",
          registryUrl: "test.example.com",
          username: "user",
          password: "pass",
        },
        userId,
      );

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
      const testData = {
        registryUrl: "ghcr.io",
        username: "testuser",
        password: "testpass",
      };

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
