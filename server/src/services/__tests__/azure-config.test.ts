import { jest } from "@jest/globals";
import { PrismaClient } from "../../generated/prisma";
import { ValidationResult, ServiceHealthStatus } from "@mini-infra/types";
import { AzureConfigService } from "../azure-config";

// Mock Azure Storage SDK
const mockBlobServiceClient = {
  getAccountInfo: jest.fn(),
  listContainers: jest.fn(),
  getContainerClient: jest.fn(),
};

const mockContainerClient = {
  listBlobsFlat: jest.fn(),
};

const mockFromConnectionString = jest.fn();

jest.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: mockFromConnectionString,
  },
}));

// Mock logger
jest.mock("../../lib/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock Prisma client
const mockPrisma = {
  systemSettings: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
  },
  connectivityStatus: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  settingsAudit: {
    create: jest.fn(),
  },
} as unknown as PrismaClient;

// Import the mock after the jest.mock calls
import mockLogger from "../../lib/logger";

describe("AzureConfigService", () => {
  let azureConfigService: AzureConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    azureConfigService = new AzureConfigService(mockPrisma);
    mockFromConnectionString.mockReturnValue(mockBlobServiceClient);
    mockBlobServiceClient.getContainerClient.mockReturnValue(
      mockContainerClient,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  describe("Constructor", () => {
    it("should initialize with correct category", () => {
      expect(azureConfigService).toBeInstanceOf(AzureConfigService);
      expect((azureConfigService as any).category).toBe("azure");
    });
  });

  describe("validate", () => {
    it("should fail validation when connection string is not configured", async () => {
      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue(null);
      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result: ValidationResult = await azureConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toBe(
        "Azure Storage connection string not configured",
      );
      expect(result.errorCode).toBe("MISSING_CONNECTION_STRING");
      expect(result.responseTimeMs).toBeGreaterThan(0);

      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "azure",
          status: "failed",
          responseTimeMs: expect.any(Number),
          errorMessage: "Azure Storage connection string not configured",
          errorCode: "MISSING_CONNECTION_STRING",
          checkInitiatedBy: null,
          checkedAt: expect.any(Date),
          lastSuccessfulAt: null,
        },
      });
    });

    it("should validate successfully with valid connection string", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: connectionString,
      });

      // Mock successful Azure operations
      const mockAccountInfo = {
        skuName: "Standard_LRS",
        accountKind: "StorageV2",
      };
      mockBlobServiceClient.getAccountInfo.mockResolvedValue(mockAccountInfo);

      // Mock container listing
      const mockContainers = [
        { name: "container1" },
        { name: "container2" },
        { name: "container3" },
      ];
      const mockContainerIterator = {
        [Symbol.asyncIterator]: async function* () {
          for (const container of mockContainers) {
            yield container;
          }
        },
      };
      mockBlobServiceClient.listContainers.mockReturnValue(
        mockContainerIterator,
      );

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Mock parent set method for account name storage
      const parentSetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      const result = await azureConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(result.message).toBe(
        "Azure Storage connection successful (teststorage)",
      );
      expect(result.responseTimeMs).toBeGreaterThan(0);
      expect(result.metadata).toMatchObject({
        accountName: "teststorage",
        skuName: "Standard_LRS",
        accountKind: "StorageV2",
        containerCount: 3,
        containers: ["container1", "container2", "container3"],
      });

      // Verify account name was stored
      expect(parentSetSpy).toHaveBeenCalledWith(
        "storage_account_name",
        "teststorage",
        "system",
      );

      // Verify success was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "azure",
          status: "connected",
          responseTimeMs: expect.any(Number),
          errorMessage: undefined,
          errorCode: undefined,
          metadata: JSON.stringify(result.metadata),
          checkInitiatedBy: null,
          checkedAt: expect.any(Date),
          lastSuccessfulAt: expect.any(Date),
        },
      });

      parentSetSpy.mockRestore();
    });

    it("should handle container listing failure gracefully", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: connectionString,
      });

      const mockAccountInfo = {
        skuName: "Standard_LRS",
        accountKind: "StorageV2",
      };
      mockBlobServiceClient.getAccountInfo.mockResolvedValue(mockAccountInfo);

      // Mock container listing failure
      const containerError = new Error("Container access denied");
      mockBlobServiceClient.listContainers.mockImplementation(() => {
        throw containerError;
      });

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const parentSetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      const result = await azureConfigService.validate();

      expect(result.isValid).toBe(true);
      expect(result.metadata?.containerCount).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          accountName: "teststorage",
          error: "Container access denied",
        },
        "Failed to list containers, but connection is valid",
      );

      parentSetSpy.mockRestore();
    });

    it("should handle API timeout", async () => {
      jest.useFakeTimers();

      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: connectionString,
      });

      // Mock timeout scenario
      mockBlobServiceClient.getAccountInfo.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 20000); // 20 seconds, longer than timeout
          }),
      );

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const validatePromise = azureConfigService.validate();

      // Fast-forward past timeout
      jest.advanceTimersByTime(16000);

      const result = await validatePromise;

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("Azure API request timeout");
      expect(result.errorCode).toBe("TIMEOUT");

      jest.useRealTimers();
    });

    it("should handle authentication failures", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=invalidkey==;EndpointSuffix=core.windows.net";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: connectionString,
      });

      const authError = new Error("AuthenticationFailed");
      mockBlobServiceClient.getAccountInfo.mockRejectedValue(authError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await azureConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.message).toContain("AuthenticationFailed");
      expect(result.errorCode).toBe("INVALID_CREDENTIALS");
    });

    it("should handle network errors", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: connectionString,
      });

      const networkError = new Error(
        "ENOTFOUND teststorage.blob.core.windows.net",
      );
      mockBlobServiceClient.getAccountInfo.mockRejectedValue(networkError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await azureConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("NETWORK_ERROR");

      // Verify unreachable status was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "azure",
          status: "unreachable",
          responseTimeMs: expect.any(Number),
          errorMessage: expect.stringContaining("ENOTFOUND"),
          errorCode: "NETWORK_ERROR",
          checkInitiatedBy: null,
          checkedAt: expect.any(Date),
          lastSuccessfulAt: null,
        },
      });
    });

    it("should handle invalid connection string format", async () => {
      const invalidConnectionString = "InvalidConnectionString";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: invalidConnectionString,
      });

      const uriError = new Error("InvalidUri");
      mockFromConnectionString.mockImplementation(() => {
        throw uriError;
      });

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await azureConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("INVALID_CONNECTION_STRING");
    });

    it("should handle rate limiting", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: connectionString,
      });

      const rateLimitError = new Error("Rate exceeded");
      mockBlobServiceClient.getAccountInfo.mockRejectedValue(rateLimitError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await azureConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("RATE_LIMITED");
    });
  });

  describe("getHealthStatus", () => {
    it("should return health status from latest connectivity record", async () => {
      const mockConnectivityStatus = {
        service: "azure",
        status: "connected",
        responseTimeMs: 500,
        errorMessage: null,
        errorCode: null,
        checkedAt: new Date("2023-01-01T12:00:00Z"),
        lastSuccessfulAt: new Date("2023-01-01T12:00:00Z"),
        metadata: JSON.stringify({
          accountName: "teststorage",
          containerCount: 3,
        }),
      };

      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(mockConnectivityStatus);

      const result: ServiceHealthStatus =
        await azureConfigService.getHealthStatus();

      expect(result).toEqual({
        service: "azure",
        status: "connected",
        lastChecked: new Date("2023-01-01T12:00:00Z"),
        lastSuccessful: new Date("2023-01-01T12:00:00Z"),
        responseTime: 500,
        errorMessage: undefined,
        errorCode: undefined,
        metadata: {
          accountName: "teststorage",
          containerCount: 3,
        },
      });
    });

    it("should perform validation when no connectivity data exists", async () => {
      mockPrisma.connectivityStatus.findFirst = jest
        .fn()
        .mockResolvedValue(null);

      // Mock validation call
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: connectionString,
      });

      const mockAccountInfo = {
        skuName: "Standard_LRS",
        accountKind: "StorageV2",
      };
      mockBlobServiceClient.getAccountInfo.mockResolvedValue(mockAccountInfo);

      mockBlobServiceClient.listContainers.mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { name: "test-container" };
        },
      });

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const parentSetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      const result = await azureConfigService.getHealthStatus();

      expect(result.service).toBe("azure");
      expect(result.status).toBe("connected");
      expect(result.lastChecked).toBeInstanceOf(Date);

      parentSetSpy.mockRestore();
    });
  });

  describe("setConnectionString", () => {
    it("should set connection string successfully", async () => {
      const validConnectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      const parentSetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "set",
      );
      parentSetSpy.mockResolvedValue(undefined);

      const parentCreateAuditLogSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "createAuditLog",
      );
      parentCreateAuditLogSpy.mockResolvedValue(undefined);

      await azureConfigService.setConnectionString(
        validConnectionString,
        "user1",
      );

      expect(parentSetSpy).toHaveBeenCalledWith(
        "connection_string",
        validConnectionString,
        "user1",
      );

      expect(parentCreateAuditLogSpy).toHaveBeenCalledWith(
        "update",
        "connection_string",
        "[REDACTED]",
        "[REDACTED]",
        "user1",
        undefined,
        undefined,
        true,
      );

      parentSetSpy.mockRestore();
      parentCreateAuditLogSpy.mockRestore();
    });

    it("should reject empty connection string", async () => {
      await expect(
        azureConfigService.setConnectionString("", "user1"),
      ).rejects.toThrow("Connection string cannot be empty");

      await expect(
        azureConfigService.setConnectionString("   ", "user1"),
      ).rejects.toThrow("Connection string cannot be empty");
    });

    it("should validate connection string format", async () => {
      const invalidConnectionString = "InvalidFormat";

      await expect(
        azureConfigService.setConnectionString(
          invalidConnectionString,
          "user1",
        ),
      ).rejects.toThrow(
        "Invalid connection string format. Missing: DefaultEndpointsProtocol, AccountName, AccountKey",
      );
    });

    it("should validate partial connection string format", async () => {
      const partialConnectionString =
        "DefaultEndpointsProtocol=https;AccountName=test";

      await expect(
        azureConfigService.setConnectionString(
          partialConnectionString,
          "user1",
        ),
      ).rejects.toThrow(
        "Invalid connection string format. Missing: AccountKey",
      );
    });
  });

  describe("getConnectionString and getStorageAccountName", () => {
    it("should retrieve connection string from settings", async () => {
      const parentGetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue("stored-connection-string");

      const result = await azureConfigService.getConnectionString();

      expect(result).toBe("stored-connection-string");
      expect(parentGetSpy).toHaveBeenCalledWith("connection_string");

      parentGetSpy.mockRestore();
    });

    it("should retrieve storage account name from settings", async () => {
      const parentGetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue("teststorage");

      const result = await azureConfigService.getStorageAccountName();

      expect(result).toBe("teststorage");
      expect(parentGetSpy).toHaveBeenCalledWith("storage_account_name");

      parentGetSpy.mockRestore();
    });
  });

  describe("getContainerInfo", () => {
    it("should retrieve container information successfully", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      // Mock container iterator with metadata
      const mockContainersWithMetadata = [
        {
          name: "container1",
          properties: {
            lastModified: new Date("2023-01-01"),
            etag: "etag1",
            leaseStatus: "unlocked",
            leaseState: "available",
            hasImmutabilityPolicy: false,
            hasLegalHold: false,
          },
          metadata: { environment: "production" },
        },
        {
          name: "container2",
          properties: {
            lastModified: new Date("2023-01-02"),
            etag: "etag2",
            leaseStatus: "locked",
            leaseState: "leased",
            hasImmutabilityPolicy: true,
            hasLegalHold: false,
          },
          metadata: { environment: "staging" },
        },
      ];

      const mockContainerIterator = {
        [Symbol.asyncIterator]: async function* () {
          for (const container of mockContainersWithMetadata) {
            yield container;
          }
        },
      };

      mockBlobServiceClient.listContainers.mockReturnValue(
        mockContainerIterator,
      );

      const result = await azureConfigService.getContainerInfo();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        name: "container1",
        lastModified: new Date("2023-01-01"),
        etag: "etag1",
        leaseStatus: "unlocked",
        leaseState: "available",
        hasImmutabilityPolicy: false,
        hasLegalHold: false,
        metadata: { environment: "production" },
      });

      expect(mockBlobServiceClient.listContainers).toHaveBeenCalledWith({
        includeMetadata: true,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          containerCount: 2,
        },
        "Successfully retrieved Azure Storage container information",
      );
    });

    it("should return empty array when connection string not configured", async () => {
      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(null);

      const result = await azureConfigService.getContainerInfo();

      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Cannot retrieve container info: Connection string not configured",
      );
    });

    it("should handle container listing timeout", async () => {
      jest.useFakeTimers();

      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      // Mock timeout scenario
      mockBlobServiceClient.listContainers.mockImplementation(() => ({
        [Symbol.asyncIterator]: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 20000));
          yield { name: "container1" };
        },
      }));

      const getContainerInfoPromise = azureConfigService.getContainerInfo();

      jest.advanceTimersByTime(16000);

      const result = await getContainerInfoPromise;

      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          error: "Container listing timeout",
        },
        "Failed to retrieve Azure Storage container information",
      );

      jest.useRealTimers();
    });

    it("should limit container results to prevent excessive data", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      // Mock 60 containers (more than the 50 limit)
      const manyContainers = Array.from({ length: 60 }, (_, i) => ({
        name: `container${i + 1}`,
        properties: {
          lastModified: new Date(),
          etag: `etag${i + 1}`,
          leaseStatus: "unlocked",
          leaseState: "available",
          hasImmutabilityPolicy: false,
          hasLegalHold: false,
        },
        metadata: {},
      }));

      const mockContainerIterator = {
        [Symbol.asyncIterator]: async function* () {
          for (const container of manyContainers) {
            yield container;
          }
        },
      };

      mockBlobServiceClient.listContainers.mockReturnValue(
        mockContainerIterator,
      );

      const result = await azureConfigService.getContainerInfo();

      // Should be limited to 50 containers
      expect(result).toHaveLength(50);
      expect(result[49].name).toBe("container50");
    });
  });

  describe("testContainerAccess", () => {
    it("should successfully test container access", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      // Mock successful blob listing
      const mockBlobIterator = {
        next: jest
          .fn()
          .mockResolvedValue({ done: false, value: { name: "test-blob" } }),
      };
      mockContainerClient.listBlobsFlat.mockReturnValue(mockBlobIterator);

      const result =
        await azureConfigService.testContainerAccess("test-container");

      expect(result).toBe(true);
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith(
        "test-container",
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { containerName: "test-container" },
        "Container access test successful",
      );
    });

    it("should return false when connection string not configured", async () => {
      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(null);

      const result =
        await azureConfigService.testContainerAccess("test-container");

      expect(result).toBe(false);
    });

    it("should handle container access timeout", async () => {
      jest.useFakeTimers();

      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      // Mock timeout scenario
      const mockBlobIterator = {
        next: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ done: true }), 10000);
            }),
        ),
      };
      mockContainerClient.listBlobsFlat.mockReturnValue(mockBlobIterator);

      const testAccessPromise =
        azureConfigService.testContainerAccess("test-container");

      jest.advanceTimersByTime(6000);

      const result = await testAccessPromise;

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          containerName: "test-container",
          error: "Container access test timeout",
        },
        "Container access test failed",
      );

      jest.useRealTimers();
    });

    it("should handle container access errors", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      const accessError = new Error("Container not found");
      mockContainerClient.listBlobsFlat.mockImplementation(() => {
        throw accessError;
      });

      const result =
        await azureConfigService.testContainerAccess("non-existent");

      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          containerName: "non-existent",
          error: "Container not found",
        },
        "Container access test failed",
      );
    });
  });

  describe("removeConfiguration", () => {
    it("should remove both connection string and storage account name", async () => {
      const parentDeleteSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "delete",
      );
      parentDeleteSpy.mockResolvedValue(undefined);

      const parentGetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue("old-storage-account");

      const parentCreateAuditLogSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "createAuditLog",
      );
      parentCreateAuditLogSpy.mockResolvedValue(undefined);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      await azureConfigService.removeConfiguration("user1");

      expect(parentDeleteSpy).toHaveBeenCalledWith(
        "connection_string",
        "user1",
      );
      expect(parentDeleteSpy).toHaveBeenCalledWith(
        "storage_account_name",
        "user1",
      );

      expect(parentCreateAuditLogSpy).toHaveBeenCalledWith(
        "delete",
        "connection_string",
        "[REDACTED]",
        null,
        "user1",
        undefined,
        undefined,
        true,
      );

      expect(parentCreateAuditLogSpy).toHaveBeenCalledWith(
        "delete",
        "storage_account_name",
        "old-storage-account",
        null,
        "user1",
        undefined,
        undefined,
        true,
      );

      // Verify disconnection was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "azure",
          status: "failed",
          responseTimeMs: undefined,
          errorMessage: "Configuration removed by user",
          errorCode: "CONFIG_REMOVED",
          metadata: undefined,
          checkInitiatedBy: "user1",
          checkedAt: expect.any(Date),
          lastSuccessfulAt: null,
        },
      });

      parentDeleteSpy.mockRestore();
      parentGetSpy.mockRestore();
      parentCreateAuditLogSpy.mockRestore();
    });

    it("should continue even if connection string or account name deletion fails", async () => {
      const parentDeleteSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "delete",
      );
      parentDeleteSpy
        .mockRejectedValueOnce(new Error("Connection string not found"))
        .mockRejectedValueOnce(new Error("Account name not found"));

      const parentGetSpy = jest.spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(azureConfigService)),
        "get",
      );
      parentGetSpy.mockResolvedValue(null);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      // Should not throw
      await expect(
        azureConfigService.removeConfiguration("user1"),
      ).resolves.toBeUndefined();

      // Should still record disconnection
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalled();

      parentDeleteSpy.mockRestore();
      parentGetSpy.mockRestore();
    });
  });
});
