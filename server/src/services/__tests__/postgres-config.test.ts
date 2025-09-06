import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import { DatabaseConfigService } from "../postgres-config";
import {
  CreatePostgresDatabaseRequest,
  UpdatePostgresDatabaseRequest,
  DatabaseConnectionConfig,
  PostgreSSLMode,
} from "@mini-infra/types";

// Mock crypto-js
jest.mock("crypto-js", () => ({
  AES: {
    encrypt: jest.fn(),
    decrypt: jest.fn(),
  },
  enc: {
    Utf8: "utf8",
  },
}));

// Get the mocked crypto-js
const mockCryptoJS = jest.requireMock("crypto-js") as any;

// Mock pg client
const mockPgClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => mockPgClient),
}));

// Mock logger
jest.mock("../../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
  return {
    appLogger: jest.fn(() => mockLoggerInstance),
    servicesLogger: jest.fn(() => mockLoggerInstance),
    httpLogger: jest.fn(() => mockLoggerInstance),
    prismaLogger: jest.fn(() => mockLoggerInstance),
    __esModule: true,
    default: jest.fn(() => mockLoggerInstance),
  };
});

// Get reference to the mocked logger
const { servicesLogger } = jest.requireMock("../../lib/logger-factory") as any;
const mockLogger = servicesLogger();

// Mock Prisma client
const mockPrisma = {
  postgresDatabase: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
} as unknown as PrismaClient;


describe("DatabaseConfigService", () => {
  let databaseConfigService: DatabaseConfigService;
  const testEncryptionKey = "test-encryption-key";

  beforeEach(() => {
    jest.clearAllMocks();
    databaseConfigService = new DatabaseConfigService(
      mockPrisma,
      testEncryptionKey,
    );
  });

  describe("constructor", () => {
    it("should initialize with provided encryption key", () => {
      expect(databaseConfigService).toBeInstanceOf(DatabaseConfigService);
    });

    it("should use API_KEY_SECRET from env if no key provided", () => {
      process.env.API_KEY_SECRET = "env-key";
      const service = new DatabaseConfigService(mockPrisma);
      expect(service).toBeInstanceOf(DatabaseConfigService);
      delete process.env.API_KEY_SECRET;
    });

    it("should use default key if no env or provided key", () => {
      delete process.env.API_KEY_SECRET;
      const service = new DatabaseConfigService(mockPrisma);
      expect(service).toBeInstanceOf(DatabaseConfigService);
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

      mockPrisma.postgresDatabase.findUnique = jest
        .fn()
        .mockResolvedValue(null);
      mockPrisma.postgresDatabase.create = jest
        .fn()
        .mockResolvedValue(mockCreatedDb);

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
        userId,
      });

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
          userId,
        },
      });
    });

    it("should throw error for duplicate database name", async () => {
      const userId = "user-123";
      const existingDb = { id: "existing-id", name: "test-db" };

      mockPrisma.postgresDatabase.findUnique = jest
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

      mockPrisma.postgresDatabase.findUnique = jest
        .fn()
        .mockResolvedValueOnce(existingDb) // For checking existing
        .mockResolvedValueOnce(null); // For checking name conflict

      mockPrisma.postgresDatabase.update = jest
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
      mockPrisma.postgresDatabase.findUnique = jest
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

    it("should throw error for unauthorized access", async () => {
      const unauthorizedDb = { ...existingDb, userId: "other-user" };
      mockPrisma.postgresDatabase.findUnique = jest
        .fn()
        .mockResolvedValue(unauthorizedDb);

      await expect(
        databaseConfigService.updateDatabase(
          "db-123",
          updateRequest,
          "user-123",
        ),
      ).rejects.toThrow(
        "Access denied: You can only update your own database configurations",
      );
    });

    it("should handle name conflict during update", async () => {
      const conflictingDb = { id: "other-db", name: "updated-db" };

      mockPrisma.postgresDatabase.findUnique = jest
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

      mockPrisma.postgresDatabase.findFirst = jest
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
        userId: "user-123",
      });
    });

    it("should return null for non-existent database", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(null);

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
      mockPrisma.postgresDatabase.findMany = jest
        .fn()
        .mockResolvedValue(mockDatabases);

      const result = await databaseConfigService.listDatabases("user-123");

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("db1");
      expect(result[1].name).toBe("db2");
      expect(result[1].tags).toEqual(["production"]);
    });

    it("should filter databases by name", async () => {
      mockPrisma.postgresDatabase.findMany = jest
        .fn()
        .mockResolvedValue([mockDatabases[0]]);

      const result = await databaseConfigService.listDatabases("user-123", {
        name: "db1",
      });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("db1");

      expect(mockPrisma.postgresDatabase.findMany).toHaveBeenCalledWith({
        where: {
          userId: "user-123",
          name: {
            contains: "db1",
            mode: "insensitive",
          },
        },
        orderBy: { createdAt: "desc" },
        take: undefined,
        skip: undefined,
      });
    });

    it("should filter databases by health status", async () => {
      mockPrisma.postgresDatabase.findMany = jest
        .fn()
        .mockResolvedValue([mockDatabases[0]]);

      await databaseConfigService.listDatabases("user-123", {
        healthStatus: "healthy",
      });

      expect(mockPrisma.postgresDatabase.findMany).toHaveBeenCalledWith({
        where: {
          userId: "user-123",
          healthStatus: "healthy",
        },
        orderBy: { createdAt: "desc" },
        take: undefined,
        skip: undefined,
      });
    });

    it("should filter databases by tags", async () => {
      mockPrisma.postgresDatabase.findMany = jest
        .fn()
        .mockResolvedValue([mockDatabases[1]]);

      await databaseConfigService.listDatabases("user-123", {
        tags: ["production"],
      });

      expect(mockPrisma.postgresDatabase.findMany).toHaveBeenCalledWith({
        where: {
          userId: "user-123",
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
      mockPrisma.postgresDatabase.findMany = jest
        .fn()
        .mockResolvedValue([mockDatabases[0]]);

      await databaseConfigService.listDatabases(
        "user-123",
        {},
        { field: "name", order: "asc" },
        10,
        5,
      );

      expect(mockPrisma.postgresDatabase.findMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
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
      mockPrisma.postgresDatabase.findFirst = jest
        .fn()
        .mockResolvedValue(existingDb);
      mockPrisma.postgresDatabase.delete = jest.fn().mockResolvedValue({});

      await databaseConfigService.deleteDatabase("db-123", "user-123");

      expect(mockPrisma.postgresDatabase.delete).toHaveBeenCalledWith({
        where: { id: "db-123" },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          databaseId: "db-123",
          name: "test-db",
          userId: "user-123",
        },
        "Database configuration deleted",
      );
    });

    it("should throw error for non-existent database", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(null);

      await expect(
        databaseConfigService.deleteDatabase("nonexistent", "user-123"),
      ).rejects.toThrow("Database configuration not found or access denied");
    });

    it("should throw error for unauthorized access", async () => {
      const unauthorizedDb = { ...existingDb, userId: "other-user" };
      mockPrisma.postgresDatabase.findFirst = jest
        .fn()
        .mockResolvedValue(unauthorizedDb);

      await expect(
        databaseConfigService.deleteDatabase("db-123", "user-123"),
      ).rejects.toThrow("Database configuration not found or access denied");
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
      mockPrisma.postgresDatabase.findFirst = jest
        .fn()
        .mockResolvedValue(existingDb);
      mockPrisma.postgresDatabase.update = jest.fn().mockResolvedValue({});

      mockPgClient.connect.mockResolvedValue(undefined);
      mockPgClient.query.mockResolvedValue({
        rows: [{ version: "PostgreSQL 15.0", current_database: "testdb" }],
      });
      mockPgClient.end.mockResolvedValue(undefined);

      const result = await databaseConfigService.testDatabaseConnection(
        "db-123",
        "user-123",
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
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(null);

      await expect(
        databaseConfigService.testDatabaseConnection("nonexistent", "user-123"),
      ).rejects.toThrow("Database configuration not found or access denied");
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
      mockPrisma.postgresDatabase.findUnique = jest
        .fn()
        .mockResolvedValue(existingDb);
      mockPrisma.postgresDatabase.update = jest.fn().mockResolvedValue({});

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
      mockPrisma.postgresDatabase.findUnique = jest
        .fn()
        .mockResolvedValue(existingDb);
      mockPrisma.postgresDatabase.update = jest.fn().mockResolvedValue({});

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
      mockPrisma.postgresDatabase.findFirst = jest
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

    it("should throw error for unauthorized access", async () => {
      mockPrisma.postgresDatabase.findFirst = jest.fn().mockResolvedValue(null);

      await expect(
        databaseConfigService.getConnectionConfig("db-123", "user-123"),
      ).rejects.toThrow("Database not found or access denied");
    });

    it("should handle decryption failure", async () => {
      mockPrisma.postgresDatabase.findFirst = jest
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
});
