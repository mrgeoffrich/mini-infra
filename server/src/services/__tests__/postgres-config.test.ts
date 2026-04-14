import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma/client";
import { PostgresDatabaseManager } from "../postgres";
import {
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  DatabaseConnectionConfig,
  PostgreSSLMode,
} from "@mini-infra/types";
import * as pg from "pg";

const { mockCryptoJS, mockPgClient } = vi.hoisted(() => ({
  mockCryptoJS: {
    AES: {
      encrypt: vi.fn(),
      decrypt: vi.fn(),
    },
    enc: {
      Utf8: "utf8",
    },
  },
  mockPgClient: {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  },
}));

// Mock crypto-js
vi.mock("crypto-js", () => ({
  default: mockCryptoJS,
  ...mockCryptoJS,
}));

vi.mock("pg", () => ({
  default: { Client: vi.fn().mockImplementation(function() { return mockPgClient; }) },
  Client: vi.fn().mockImplementation(function() { return mockPgClient; }),
}));

// Mock logger
vi.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    appLogger: vi.fn(function() { return mockLoggerInstance; }),
    servicesLogger: vi.fn(function() { return mockLoggerInstance; }),
    httpLogger: vi.fn(function() { return mockLoggerInstance; }),
    prismaLogger: vi.fn(function() { return mockLoggerInstance; }),
    default: vi.fn(function() { return mockLoggerInstance; }),
  };
});

// Get reference to the mocked logger (defined in vi.mock factory above)
import * as loggerFactory from "../../lib/logger-factory";
const mockLogger = (vi.mocked(loggerFactory).servicesLogger as any)();

// Mock Prisma client
const mockPrisma = {
  postgresDatabase: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
} as unknown as typeof prisma;

describe("PostgresDatabaseManager", () => {
  let databaseConfigService: PostgresDatabaseManager;
  const testEncryptionKey = "test-encryption-key";

  beforeEach(() => {
    vi.clearAllMocks();
    databaseConfigService = new PostgresDatabaseManager(
      mockPrisma,
      testEncryptionKey,
    );
  });

  describe("constructor", () => {
    it("should initialize with provided encryption key", () => {
      expect(databaseConfigService).toBeInstanceOf(PostgresDatabaseManager);
    });

    it("should use API_KEY_SECRET from env if no key provided", () => {
      process.env.API_KEY_SECRET = "env-key";
      const service = new PostgresDatabaseManager(mockPrisma);
      expect(service).toBeInstanceOf(PostgresDatabaseManager);
      delete process.env.API_KEY_SECRET;
    });

    it("should use default key if no env or provided key", () => {
      delete process.env.API_KEY_SECRET;
      const service = new PostgresDatabaseManager(mockPrisma);
      expect(service).toBeInstanceOf(PostgresDatabaseManager);
    });
  });

  describe("createDatabase", () => {
    const validRequest: CreatePostgresDatabaseRequest = {
      name: "test-db",
      host: "localhost",
      port: 5432,
      database: "testdb",
      username: "testuser",
      password: "testpass",
      sslMode: "prefer",
      tags: ["test", "development"],
    };

    beforeEach(() => {
      // Mock encryption
      mockCryptoJS.AES.encrypt.mockReturnValue({
        toString: () => "encrypted-connection-string",
      });
    });

    it("should create database configuration successfully", async () => {
      const userId = "user-123";
      const mockCreatedDb = {
        id: "db-123",
        name: "test-db",
        connectionString: "encrypted-connection-string",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        sslMode: "prefer",
        tags: '["test","development"]',
        createdAt: new Date("2023-01-01T00:00:00Z"),
        updatedAt: new Date("2023-01-01T00:00:00Z"),
        lastHealthCheck: null,
        healthStatus: "unknown",
        userId,
      };

      mockPrisma.postgresDatabase.findUnique = vi
        .fn()
        .mockResolvedValueOnce(null) // For duplicate check
        .mockResolvedValueOnce(mockCreatedDb); // For fetching after health check (fallback to original)
      mockPrisma.postgresDatabase.create = vi
        .fn()
        .mockResolvedValue(mockCreatedDb);

      // Mock the health check to fail silently so we get original behavior for this test
      const healthCheckSpy = vi.spyOn(databaseConfigService, 'performHealthCheck')
        .mockRejectedValue(new Error('Health check skipped in test'));

      const result = await databaseConfigService.createDatabase(
        validRequest,
        userId,
      );

      expect(result).toEqual({
        id: "db-123",
        name: "test-db",
        connectionString: "[ENCRYPTED]",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        sslMode: "prefer",
        tags: ["test", "development"],
        createdAt: "2023-01-01T00:00:00.000Z",
        updatedAt: "2023-01-01T00:00:00.000Z",
        lastHealthCheck: null,
        healthStatus: "unknown",
      });

      // Verify health check was attempted
      expect(healthCheckSpy).toHaveBeenCalledWith("db-123");
      healthCheckSpy.mockRestore();

      expect(mockCryptoJS.AES.encrypt).toHaveBeenCalledWith(
        "postgresql://testuser:testpass@localhost:5432/testdb?sslmode=prefer",
        testEncryptionKey,
      );

      expect(mockPrisma.postgresDatabase.create).toHaveBeenCalledWith({
        data: {
          name: "test-db",
          connectionString: "encrypted-connection-string",
          host: "localhost",
          port: 5432,
          database: "testdb",
          username: "testuser",
          sslMode: "prefer",
          tags: '["test","development"]',
          healthStatus: "unknown",
        },
      });
    });

    it("should throw error for duplicate database name", async () => {
      const userId = "user-123";
      const existingDb = { id: "existing-id", name: "test-db" };

      mockPrisma.postgresDatabase.findUnique = vi
        .fn()
        .mockResolvedValue(existingDb);

      await expect(
        databaseConfigService.createDatabase(validRequest, userId),
      ).rejects.toThrow(
        "Database configuration with name 'test-db' already exists",
      );
    });

    it("should validate required fields", async () => {
      const invalidRequest = { ...validRequest, name: "" };

      await expect(
        databaseConfigService.createDatabase(invalidRequest, "user-123"),
      ).rejects.toThrow("Database name is required");
    });

    it("should validate port range", async () => {
      const invalidRequest = { ...validRequest, port: 70000 };

      await expect(
        databaseConfigService.createDatabase(invalidRequest, "user-123"),
      ).rejects.toThrow("Port must be between 1 and 65535");
    });

    it("should validate database name format", async () => {
      const invalidRequest = { ...validRequest, name: "invalid name!" };

      await expect(
        databaseConfigService.createDatabase(invalidRequest, "user-123"),
      ).rejects.toThrow(
        "Database name can only contain letters, numbers, hyphens, and underscores",
      );
    });

    it("should handle encryption failure", async () => {
      mockCryptoJS.AES.encrypt.mockImplementation(() => {
        throw new Error("Encryption failed");
      });

      await expect(
        databaseConfigService.createDatabase(validRequest, "user-123"),
      ).rejects.toThrow("Encryption failed");
    });
  });

  describe("updateDatabase", () => {
    const updateRequest: UpdatePostgresDatabaseRequest = {
      name: "updated-db",
      host: "newhost",
      port: 5433,
    };

    const existingDb = {
      id: "db-123",
      name: "test-db",
      connectionString: "encrypted-connection-string",
      host: "localhost",
      port: 5432,
      database: "testdb",
      username: "testuser",
      sslMode: "prefer",
      tags: "[]",
      userId: "user-123",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastHealthCheck: null,
      healthStatus: "unknown",
    };

    beforeEach(() => {
      mockCryptoJS.AES.decrypt.mockReturnValue({
        toString: () =>
          "postgresql://testuser:testpass@localhost:5432/testdb?sslmode=prefer",
      });
      mockCryptoJS.AES.encrypt.mockReturnValue({
        toString: () => "new-encrypted-connection-string",
      });
    });

    it("should update database configuration successfully", async () => {
      const updatedDb = { ...existingDb, ...updateRequest };

      mockPrisma.postgresDatabase.findUnique = vi
        .fn()
        .mockResolvedValueOnce(existingDb) // For checking existing
        .mockResolvedValueOnce(null); // For checking name conflict

      mockPrisma.postgresDatabase.update = vi
        .fn()
        .mockResolvedValue(updatedDb);

      const result = await databaseConfigService.updateDatabase(
        "db-123",
        updateRequest,
        "user-123",
      );

      expect(result.name).toBe("updated-db");
      expect(result.host).toBe("newhost");
      expect(result.port).toBe(5433);

      expect(mockPrisma.postgresDatabase.update).toHaveBeenCalledWith({
        where: { id: "db-123" },
        data: expect.objectContaining({
          name: "updated-db",
          host: "newhost",
          port: 5433,
          healthStatus: "unknown",
          lastHealthCheck: null,
        }),
      });
    });

    it("should throw error for non-existent database", async () => {
      mockPrisma.postgresDatabase.findUnique = vi
        .fn()
        .mockResolvedValue(null);

      await expect(
        databaseConfigService.updateDatabase(
          "nonexistent",
          updateRequest,
          "user-123",
        ),
      ).rejects.toThrow("Database configuration not found");
    });

    it("should handle name conflict during update", async () => {
      const conflictingDb = { id: "other-db", name: "updated-db" };

      mockPrisma.postgresDatabase.findUnique = vi
        .fn()
        .mockResolvedValueOnce(existingDb) // For checking existing
        .mockResolvedValueOnce(conflictingDb); // For checking name conflict

      await expect(
        databaseConfigService.updateDatabase(
          "db-123",
          updateRequest,
          "user-123",
        ),
      ).rejects.toThrow(
        "Database configuration with name 'updated-db' already exists",
      );
    });
  });

  describe("getDatabaseById", () => {
    it("should return database configuration", async () => {
      const mockDb = {
        id: "db-123",
        name: "test-db",
        connectionString: "encrypted",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        sslMode: "prefer",
        tags: "[]",
        createdAt: new Date("2023-01-01T00:00:00Z"),
        updatedAt: new Date("2023-01-01T00:00:00Z"),
        lastHealthCheck: null,
        healthStatus: "unknown",
        userId: "user-123",
      };

      mockPrisma.postgresDatabase.findFirst = vi
        .fn()
        .mockResolvedValue(mockDb);

      const result = await databaseConfigService.getDatabaseById(
        "db-123",
        "user-123",
      );

      expect(result).toEqual({
        id: "db-123",
        name: "test-db",
        connectionString: "[ENCRYPTED]",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        sslMode: "prefer",
        tags: [],
        createdAt: "2023-01-01T00:00:00.000Z",
        updatedAt: "2023-01-01T00:00:00.000Z",
        lastHealthCheck: null,
        healthStatus: "unknown",
      });
    });

    it("should return null for non-existent database", async () => {
      mockPrisma.postgresDatabase.findFirst = vi.fn().mockResolvedValue(null);

      const result = await databaseConfigService.getDatabaseById(
        "nonexistent",
        "user-123",
      );

      expect(result).toBeNull();
    });
  });

  describe("listDatabases", () => {
    const mockDatabases = [
      {
        id: "db-1",
        name: "db1",
        connectionString: "encrypted1",
        host: "host1",
        port: 5432,
        database: "db1",
        username: "user1",
        sslMode: "prefer",
        tags: "[]",
        createdAt: new Date("2023-01-01T00:00:00Z"),
        updatedAt: new Date("2023-01-01T00:00:00Z"),
        lastHealthCheck: null,
        healthStatus: "healthy",
        userId: "user-123",
      },
      {
        id: "db-2",
        name: "db2",
        connectionString: "encrypted2",
        host: "host2",
        port: 5432,
        database: "db2",
        username: "user2",
        sslMode: "require",
        tags: '["production"]',
        createdAt: new Date("2023-01-02T00:00:00Z"),
        updatedAt: new Date("2023-01-02T00:00:00Z"),
        lastHealthCheck: new Date("2023-01-02T01:00:00Z"),
        healthStatus: "unhealthy",
        userId: "user-123",
      },
    ];

    it("should list all databases for user", async () => {
      mockPrisma.postgresDatabase.findMany = vi
        .fn()
        .mockResolvedValue(mockDatabases);

      const result = await databaseConfigService.listDatabases();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("db1");
      expect(result[1].name).toBe("db2");
      expect(result[1].tags).toEqual(["production"]);
    });

    it("should filter databases by name", async () => {
      mockPrisma.postgresDatabase.findMany = vi
        .fn()
        .mockResolvedValue([mockDatabases[0]]);

      const result = await databaseConfigService.listDatabases({
        name: "db1",
      });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("db1");

      expect(mockPrisma.postgresDatabase.findMany).toHaveBeenCalledWith({
        where: {
          name: {
            contains: "db1",
          },
        },
        orderBy: { createdAt: "desc" },
        take: undefined,
        skip: undefined,
      });
    });

    it("should filter databases by health status", async () => {
      mockPrisma.postgresDatabase.findMany = vi
        .fn()
        .mockResolvedValue([mockDatabases[0]]);

      await databaseConfigService.listDatabases({
        healthStatus: "healthy",
      });

      expect(mockPrisma.postgresDatabase.findMany).toHaveBeenCalledWith({
        where: {
          healthStatus: "healthy",
        },
        orderBy: { createdAt: "desc" },
        take: undefined,
        skip: undefined,
      });
    });

    it("should filter databases by tags", async () => {
      mockPrisma.postgresDatabase.findMany = vi
        .fn()
        .mockResolvedValue([mockDatabases[1]]);

      await databaseConfigService.listDatabases({
        tags: ["production"],
      });

      expect(mockPrisma.postgresDatabase.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            {
              tags: {
                contains: '"production"',
              },
            },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: undefined,
        skip: undefined,
      });
    });

    it("should apply pagination", async () => {
      mockPrisma.postgresDatabase.findMany = vi
        .fn()
        .mockResolvedValue([mockDatabases[0]]);

      await databaseConfigService.listDatabases(
        {},
        { field: "name", order: "asc" },
        10,
        5,
      );

      expect(mockPrisma.postgresDatabase.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { name: "asc" },
        take: 10,
        skip: 5,
      });
    });
  });

  describe("deleteDatabase", () => {
    const existingDb = {
      id: "db-123",
      name: "test-db",
      userId: "user-123",
    };

    it("should delete database successfully", async () => {
      mockPrisma.postgresDatabase.findFirst = vi
        .fn()
        .mockResolvedValue(existingDb);
      mockPrisma.postgresDatabase.delete = vi.fn().mockResolvedValue({});

      await databaseConfigService.deleteDatabase("db-123");

      expect(mockPrisma.postgresDatabase.delete).toHaveBeenCalledWith({
        where: { id: "db-123" },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          databaseId: "db-123",
          name: "test-db",
        },
        "Database configuration deleted",
      );
    });

    it("should throw error for non-existent database", async () => {
      mockPrisma.postgresDatabase.findFirst = vi.fn().mockResolvedValue(null);

      await expect(
        databaseConfigService.deleteDatabase("nonexistent"),
      ).rejects.toThrow("Database configuration not found");
    });
  });

  describe("testConnection", () => {
    const connectionConfig: DatabaseConnectionConfig = {
      host: "localhost",
      port: 5432,
      database: "testdb",
      username: "testuser",
      password: "testpass",
      sslMode: "prefer",
    };

    it("should test connection successfully", async () => {
      const mockQueryResult = {
        rows: [
          {
            version: "PostgreSQL 15.0",
            current_database: "testdb",
          },
        ],
      };

      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query.mockResolvedValue(mockQueryResult);
      mockPgClient.end.mockResolvedValue(undefined);

      const result =
        await databaseConfigService.testConnection(connectionConfig);

      expect(result.isValid).toBe(true);
      expect(result.message).toBe("Connection successful");
      expect(result.serverVersion).toBe("PostgreSQL 15.0");
      expect(result.databaseName).toBe("testdb");
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle connection timeout", async () => {
      mockPgClient.connect.mockRejectedValue(new Error("connection timeout"));

      const result =
        await databaseConfigService.testConnection(connectionConfig);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("TIMEOUT");
      expect(result.message).toContain("timeout");
    });

    it("should handle authentication failure", async () => {
      mockPgClient.connect.mockRejectedValue(
        new Error("password authentication failed"),
      );

      const result =
        await databaseConfigService.testConnection(connectionConfig);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("AUTHENTICATION_FAILED");
      expect(result.message).toContain("authentication");
    });

    it("should handle database not found error", async () => {
      mockPgClient.connect.mockRejectedValue(
        new Error('database "nonexistent" does not exist'),
      );

      const result =
        await databaseConfigService.testConnection(connectionConfig);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("DATABASE_NOT_FOUND");
      expect(result.message).toContain("does not exist");
    });

    it("should handle connection refused error", async () => {
      mockPgClient.connect.mockRejectedValue(new Error("connection refused"));

      const result =
        await databaseConfigService.testConnection(connectionConfig);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("CONNECTION_REFUSED");
      expect(result.message).toContain("refused");
    });

    it("should clean up connection on success", async () => {
      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query.mockResolvedValue({ rows: [{}] });
      mockPgClient.end.mockResolvedValue(undefined);

      await databaseConfigService.testConnection(connectionConfig);

      expect(mockPgClient.end).toHaveBeenCalled();
    });

    it("should clean up connection on failure", async () => {
      mockPgClient.connect.mockRejectedValue(new Error("test error"));
      mockPgClient.end.mockResolvedValue(undefined);

      await databaseConfigService.testConnection(connectionConfig);

      expect(mockPgClient.end).toHaveBeenCalled();
    });
  });

  describe("testDatabaseConnection", () => {
    const existingDb = {
      id: "db-123",
      connectionString: "encrypted-connection-string",
      userId: "user-123",
    };

    beforeEach(() => {
      mockCryptoJS.AES.decrypt.mockReturnValue({
        toString: () =>
          "postgresql://testuser:testpass@localhost:5432/testdb?sslmode=prefer",
      });
    });

    it("should test existing database connection", async () => {
      mockPrisma.postgresDatabase.findFirst = vi
        .fn()
        .mockResolvedValue(existingDb);
      mockPrisma.postgresDatabase.update = vi.fn().mockResolvedValue({});

      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query.mockResolvedValue({
        rows: [{ version: "PostgreSQL 15.0", current_database: "testdb" }],
      });
      mockPgClient.end.mockResolvedValue(undefined);

      const result = await databaseConfigService.testDatabaseConnection(
        "db-123",
      );

      expect(result.isValid).toBe(true);
      expect(mockPrisma.postgresDatabase.update).toHaveBeenCalledWith({
        where: { id: "db-123" },
        data: {
          healthStatus: "healthy",
          lastHealthCheck: expect.any(Date),
        },
      });
    });

    it("should throw error for non-existent database", async () => {
      mockPrisma.postgresDatabase.findFirst = vi.fn().mockResolvedValue(null);

      await expect(
        databaseConfigService.testDatabaseConnection("nonexistent"),
      ).rejects.toThrow("Database configuration not found");
    });
  });

  describe("performHealthCheck", () => {
    const existingDb = {
      id: "db-123",
      connectionString: "encrypted-connection-string",
    };

    beforeEach(() => {
      mockCryptoJS.AES.decrypt.mockReturnValue({
        toString: () =>
          "postgresql://testuser:testpass@localhost:5432/testdb?sslmode=prefer",
      });
    });

    it("should perform health check successfully", async () => {
      mockPrisma.postgresDatabase.findUnique = vi
        .fn()
        .mockResolvedValue(existingDb);
      mockPrisma.postgresDatabase.update = vi.fn().mockResolvedValue({});

      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query.mockResolvedValue({
        rows: [{ version: "PostgreSQL 15.0", current_database: "testdb" }],
      });
      mockPgClient.end.mockResolvedValue(undefined);

      const result = await databaseConfigService.performHealthCheck("db-123");

      expect(result.databaseId).toBe("db-123");
      expect(result.healthStatus).toBe("healthy");
      expect(result.serverVersion).toBe("PostgreSQL 15.0");
      expect(result.lastChecked).toBeInstanceOf(Date);
    });

    it("should handle unhealthy database", async () => {
      mockPrisma.postgresDatabase.findUnique = vi
        .fn()
        .mockResolvedValue(existingDb);
      mockPrisma.postgresDatabase.update = vi.fn().mockResolvedValue({});

      mockPgClient.connect.mockRejectedValue(new Error("Connection failed"));
      mockPgClient.end.mockResolvedValue(undefined);

      const result = await databaseConfigService.performHealthCheck("db-123");

      expect(result.healthStatus).toBe("unhealthy");
      expect(result.errorMessage).toContain("Connection failed");
    });
  });

  describe("getConnectionConfig", () => {
    const existingDb = {
      id: "db-123",
      connectionString: "encrypted-connection-string",
      userId: "user-123",
    };

    beforeEach(() => {
      mockCryptoJS.AES.decrypt.mockReturnValue({
        toString: () =>
          "postgresql://testuser:testpass@localhost:5432/testdb?sslmode=prefer",
      });
    });

    it("should return decrypted connection config", async () => {
      mockPrisma.postgresDatabase.findFirst = vi
        .fn()
        .mockResolvedValue(existingDb);

      const result = await databaseConfigService.getConnectionConfig(
        "db-123",
        "user-123",
      );

      expect(result).toEqual({
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
      });
    });

    it("should throw error when database not found", async () => {
      mockPrisma.postgresDatabase.findFirst = vi.fn().mockResolvedValue(null);

      await expect(
        databaseConfigService.getConnectionConfig("db-123"),
      ).rejects.toThrow("Database not found");
    });

    it("should handle decryption failure", async () => {
      mockPrisma.postgresDatabase.findFirst = vi
        .fn()
        .mockResolvedValue(existingDb);

      mockCryptoJS.AES.decrypt.mockImplementation(() => {
        throw new Error("Decryption failed");
      });

      await expect(
        databaseConfigService.getConnectionConfig("db-123", "user-123"),
      ).rejects.toThrow("Decryption failed");
    });
  });

  describe("encryption/decryption", () => {
    it("should encrypt connection string", () => {
      mockCryptoJS.AES.encrypt.mockReturnValue({
        toString: () => "encrypted-string",
      });

      const result = (databaseConfigService as any).encryptConnectionString(
        "postgresql://user:pass@host:5432/db",
      );

      expect(result).toBe("encrypted-string");
      expect(mockCryptoJS.AES.encrypt).toHaveBeenCalledWith(
        "postgresql://user:pass@host:5432/db",
        testEncryptionKey,
      );
    });

    it("should decrypt connection string", () => {
      mockCryptoJS.AES.decrypt.mockReturnValue({
        toString: () => "postgresql://user:pass@host:5432/db",
      });

      const result = (databaseConfigService as any).decryptConnectionString(
        "encrypted-string",
      );

      expect(result).toBe("postgresql://user:pass@host:5432/db");
      expect(mockCryptoJS.AES.decrypt).toHaveBeenCalledWith(
        "encrypted-string",
        testEncryptionKey,
      );
    });

    it("should handle encryption failure", () => {
      mockCryptoJS.AES.encrypt.mockImplementation(() => {
        throw new Error("Encryption error");
      });

      expect(() =>
        (databaseConfigService as any).encryptConnectionString("test"),
      ).toThrow("Encryption failed");
    });

    it("should handle decryption failure", () => {
      mockCryptoJS.AES.decrypt.mockImplementation(() => {
        throw new Error("Decryption error");
      });

      expect(() =>
        (databaseConfigService as any).decryptConnectionString("encrypted"),
      ).toThrow("Decryption failed");
    });

    it("should handle empty decryption result", () => {
      mockCryptoJS.AES.decrypt.mockReturnValue({
        toString: () => "",
      });

      expect(() =>
        (databaseConfigService as any).decryptConnectionString("encrypted"),
      ).toThrow("Decryption failed");
    });
  });

  describe("connection string utilities", () => {
    it("should build connection string correctly", () => {
      const config: DatabaseConnectionConfig = {
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
      };

      const result = (databaseConfigService as any).buildConnectionString(
        config,
      );

      expect(result).toBe(
        "postgresql://testuser:testpass@localhost:5432/testdb?sslmode=prefer",
      );
    });

    it("should encode special characters in credentials", () => {
      const config: DatabaseConnectionConfig = {
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "test@user",
        password: "test:pass",
        sslMode: "prefer",
      };

      const result = (databaseConfigService as any).buildConnectionString(
        config,
      );

      expect(result).toBe(
        "postgresql://test%40user:test%3Apass@localhost:5432/testdb?sslmode=prefer",
      );
    });

    it("should parse connection string correctly", () => {
      const connectionString =
        "postgresql://testuser:testpass@localhost:5432/testdb?sslmode=require";

      const result = (databaseConfigService as any).parseConnectionString(
        connectionString,
      );

      expect(result).toEqual({
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "require",
      });
    });

    it("should handle default port and ssl mode", () => {
      const connectionString =
        "postgresql://testuser:testpass@localhost/testdb";

      const result = (databaseConfigService as any).parseConnectionString(
        connectionString,
      );

      expect(result).toEqual({
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
      });
    });

    it("should decode special characters", () => {
      const connectionString =
        "postgresql://test%40user:test%3Apass@localhost:5432/testdb";

      const result = (databaseConfigService as any).parseConnectionString(
        connectionString,
      );

      expect(result.username).toBe("test@user");
      expect(result.password).toBe("test:pass");
    });

    it("should handle invalid connection string", () => {
      expect(() =>
        (databaseConfigService as any).parseConnectionString("invalid-url"),
      ).toThrow("Invalid connection string format");
    });
  });

  describe("validation", () => {
    it("should validate all required fields", () => {
      const invalidRequests = [
        {
          name: "",
          host: "localhost",
          port: 5432,
          database: "db",
          username: "user",
          password: "pass",
          sslMode: "prefer" as PostgreSSLMode,
        },
        {
          name: "db",
          host: "",
          port: 5432,
          database: "db",
          username: "user",
          password: "pass",
          sslMode: "prefer" as PostgreSSLMode,
        },
        {
          name: "db",
          host: "localhost",
          port: 0,
          database: "db",
          username: "user",
          password: "pass",
          sslMode: "prefer" as PostgreSSLMode,
        },
        {
          name: "db",
          host: "localhost",
          port: 5432,
          database: "",
          username: "user",
          password: "pass",
          sslMode: "prefer" as PostgreSSLMode,
        },
        {
          name: "db",
          host: "localhost",
          port: 5432,
          database: "db",
          username: "",
          password: "pass",
          sslMode: "prefer" as PostgreSSLMode,
        },
        {
          name: "db",
          host: "localhost",
          port: 5432,
          database: "db",
          username: "user",
          password: "",
          sslMode: "prefer" as PostgreSSLMode,
        },
        {
          name: "db",
          host: "localhost",
          port: 5432,
          database: "db",
          username: "user",
          password: "pass",
          sslMode: "invalid" as PostgreSSLMode,
        },
      ];

      for (const request of invalidRequests) {
        expect(() =>
          (databaseConfigService as any).validateDatabaseRequest(request),
        ).toThrow();
      }
    });

    it("should validate name length", () => {
      const longName = "a".repeat(101);
      const request = {
        name: longName,
        host: "localhost",
        port: 5432,
        database: "db",
        username: "user",
        password: "pass",
        sslMode: "prefer" as PostgreSSLMode,
      };

      expect(() =>
        (databaseConfigService as any).validateDatabaseRequest(request),
      ).toThrow("Database name must be 100 characters or less");
    });

    it("should pass validation for valid request", () => {
      const validRequest: CreatePostgresDatabaseRequest = {
        name: "valid_db-name",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
      };

      expect(() =>
        (databaseConfigService as any).validateDatabaseRequest(validRequest),
      ).not.toThrow();
    });
  });

  describe("discoverDatabases", () => {
    const discoveryRequest = {
      host: "localhost",
      port: 5432,
      username: "postgres",
      password: "password",
      sslMode: "prefer" as PostgreSSLMode,
    };

    beforeEach(() => {
      mockPgClient.connect.mockClear();
      mockPgClient.query.mockClear();
      mockPgClient.end.mockClear();
    });

    it("should successfully discover databases", async () => {
      const mockVersionResult = {
        rows: [{ version: "PostgreSQL 14.5 on x86_64-pc-linux-gnu" }],
      };

      const mockDatabasesResult = {
        rows: [
          {
            name: "myapp_production",
            is_template: false,
            allow_connections: true,
            encoding: "UTF8",
            collation: "en_US.UTF-8",
            character_classification: "en_US.UTF-8",
            size_pretty: "45 MB",
            description: "Production database",
          },
          {
            name: "myapp_staging",
            is_template: false,
            allow_connections: true,
            encoding: "UTF8",
            collation: "en_US.UTF-8",
            character_classification: "en_US.UTF-8",
            size_pretty: "12 MB",
            description: null,
          },
        ],
      };

      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query
        .mockResolvedValueOnce(mockVersionResult)
        .mockResolvedValueOnce(mockDatabasesResult);
      mockPgClient.end.mockResolvedValue(undefined);

      const result = await databaseConfigService.discoverDatabases(discoveryRequest);

      expect(result).toEqual({
        databases: [
          {
            name: "myapp_production",
            isTemplate: false,
            allowConnections: true,
            encoding: "UTF8",
            collation: "en_US.UTF-8",
            characterClassification: "en_US.UTF-8",
            sizePretty: "45 MB",
            description: "Production database",
          },
          {
            name: "myapp_staging",
            isTemplate: false,
            allowConnections: true,
            encoding: "UTF8",
            collation: "en_US.UTF-8",
            characterClassification: "en_US.UTF-8",
            sizePretty: "12 MB",
            description: null,
          },
        ],
        serverVersion: "PostgreSQL 14.5 on x86_64-pc-linux-gnu",
        responseTimeMs: expect.any(Number),
      });

      expect(mockPgClient.connect).toHaveBeenCalledTimes(1);
      expect(mockPgClient.query).toHaveBeenCalledTimes(2);
      expect(mockPgClient.end).toHaveBeenCalledTimes(1);
    });

    it("should handle empty database list", async () => {
      const mockVersionResult = {
        rows: [{ version: "PostgreSQL 14.5" }],
      };

      const mockDatabasesResult = {
        rows: [],
      };

      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query
        .mockResolvedValueOnce(mockVersionResult)
        .mockResolvedValueOnce(mockDatabasesResult);
      mockPgClient.end.mockResolvedValue(undefined);

      const result = await databaseConfigService.discoverDatabases(discoveryRequest);

      expect(result.databases).toEqual([]);
      expect(result.serverVersion).toBe("PostgreSQL 14.5");
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle connection failures", async () => {
      const connectionError = new Error("Connection refused");
      mockPgClient.connect.mockRejectedValue(connectionError);

      await expect(
        databaseConfigService.discoverDatabases(discoveryRequest)
      ).rejects.toThrow("Connection refused");

      expect(mockPgClient.end).toHaveBeenCalledTimes(1);
    });

    it("should handle query failures", async () => {
      const queryError = new Error("Query failed");
      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query.mockRejectedValue(queryError);

      await expect(
        databaseConfigService.discoverDatabases(discoveryRequest)
      ).rejects.toThrow("Query failed");

      expect(mockPgClient.connect).toHaveBeenCalledTimes(1);
      expect(mockPgClient.end).toHaveBeenCalledTimes(1);
    });

    it("should always close connection even if end() fails", async () => {
      const endError = new Error("End failed");
      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query
        .mockResolvedValueOnce({ rows: [{ version: "PostgreSQL 14.5" }] })
        .mockResolvedValueOnce({ rows: [] });
      mockPgClient.end.mockRejectedValue(endError);

      const result = await databaseConfigService.discoverDatabases(discoveryRequest);

      expect(result.databases).toEqual([]);
      expect(mockPgClient.end).toHaveBeenCalledTimes(1);
    });

    it("should connect to postgres database for discovery", async () => {
      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query
        .mockResolvedValueOnce({ rows: [{ version: "PostgreSQL 14.5" }] })
        .mockResolvedValueOnce({ rows: [] });
      mockPgClient.end.mockResolvedValue(undefined);

      await databaseConfigService.discoverDatabases(discoveryRequest);

      // Check that the connection string uses the postgres database
      const Client = pg.Client;
      expect(Client).toHaveBeenCalledWith({
        connectionString: expect.stringContaining("/postgres?sslmode="),
        connectionTimeoutMillis: 10000,
        query_timeout: 5000,
      });
    });
  });
});
