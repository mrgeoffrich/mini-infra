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
  getProperties: jest.fn(),
};

jest.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: jest.fn(),
  },
}));

// Mock logger
jest.mock("../../lib/logger-factory", () => ({
  appLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  servicesLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  httpLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  prismaLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  __esModule: true,
  default: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
}));

// Get reference to the mocked logger
const mockLogger = require("../../lib/logger-factory").servicesLogger();

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
} as unknown as PrismaClient;

// Import the mock after the jest.mock calls
import { BlobServiceClient } from "@azure/storage-blob";

const mockFromConnectionString = BlobServiceClient.fromConnectionString as jest.MockedFunction<typeof BlobServiceClient.fromConnectionString>;

describe("AzureConfigService", () => {
  let azureConfigService: AzureConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    azureConfigService = new AzureConfigService(mockPrisma);
    mockFromConnectionString.mockReturnValue(mockBlobServiceClient);
    mockBlobServiceClient.getContainerClient.mockReturnValue(
      mockContainerClient,
    );
    // Clear the static container access cache
    (AzureConfigService as any).containerAccessCache.flushAll();
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
      expect(typeof result.responseTimeMs).toBe('number');
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);

      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "azure",
            status: "failed",
            errorMessage: "Azure Storage connection string not configured",
            errorCode: "MISSING_CONNECTION_STRING",
          }),
        }),
      );
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
      expect(typeof result.responseTimeMs).toBe('number');
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
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
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "azure",
            status: "connected",
            errorMessage: null,
            errorCode: null,
          }),
        }),
      );

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

      parentSetSpy.mockRestore();
    });

    it("should handle API timeout", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      mockPrisma.systemSettings.findUnique = jest.fn().mockResolvedValue({
        value: connectionString,
      });

      // Mock timeout scenario by rejecting with timeout error
      const timeoutError = new Error("Request timeout");
      timeoutError.name = "TimeoutError";
      mockBlobServiceClient.getAccountInfo.mockRejectedValue(timeoutError);

      mockPrisma.connectivityStatus.create = jest.fn().mockResolvedValue({});

      const result = await azureConfigService.validate();

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("TIMEOUT");
    }, 15000);

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
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            service: "azure",
            status: "unreachable",
            errorMessage: "Azure Storage validation failed: ENOTFOUND teststorage.blob.core.windows.net",
            errorCode: "NETWORK_ERROR",
          }),
        }),
      );
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

      await azureConfigService.setConnectionString(
        validConnectionString,
        "user1",
      );

      expect(parentSetSpy).toHaveBeenCalledWith(
        "connection_string",
        validConnectionString,
        "user1",
      );


      parentSetSpy.mockRestore();
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

      // Container info should be retrieved successfully
      expect(mockBlobServiceClient.listContainers).toHaveBeenCalledWith({
        includeMetadata: true,
      });
    });

    it("should return empty array when connection string not configured", async () => {
      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(null);

      const result = await azureConfigService.getContainerInfo();

      expect(result).toEqual([]);
    });

    it("should handle container listing timeout", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      // Mock timeout scenario
      const timeoutError = new Error("Container listing timeout");
      mockBlobServiceClient.listContainers.mockImplementation(() => {
        throw timeoutError;
      });

      const result = await azureConfigService.getContainerInfo();

      expect(result).toEqual([]);
    }, 15000);

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

      // Mock successful container properties call
      mockContainerClient.getProperties.mockResolvedValue({
        lastModified: new Date(),
        etag: "test-etag",
      });

      const result =
        await azureConfigService.testContainerAccess("test-container");

      expect(result.accessible).toBe(true);
      expect(typeof result.responseTimeMs).toBe('number');
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.cached).toBeUndefined(); // cached property is only added when result is from cache
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith(
        "test-container",
      );
    });

    it("should return false when connection string not configured", async () => {
      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(null);

      const result =
        await azureConfigService.testContainerAccess("test-container");

      expect(result.accessible).toBe(false);
      expect(result.error).toBe("No connection string configured");
      expect(result.errorCode).toBe("MISSING_CONNECTION_STRING");
      expect(typeof result.responseTimeMs).toBe('number');
    });

    it("should handle container access timeout", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      // Mock timeout scenario
      const timeoutError = new Error("Container access test timeout");
      mockContainerClient.getProperties.mockRejectedValue(timeoutError);

      const result =
        await azureConfigService.testContainerAccess("test-container");

      expect(result.accessible).toBe(false);
      expect(result.error).toBe("Container access test timeout");
      expect(result.errorCode).toBe("TIMEOUT");
      expect(typeof result.responseTimeMs).toBe('number');
    }, 15000);

    it("should handle container access errors", async () => {
      const connectionString =
        "DefaultEndpointsProtocol=https;AccountName=teststorage;AccountKey=testkey123==;EndpointSuffix=core.windows.net";

      jest
        .spyOn(azureConfigService, "getConnectionString")
        .mockResolvedValue(connectionString);

      const accessError = new Error("Container not found");
      mockContainerClient.getProperties.mockRejectedValue(accessError);

      const result =
        await azureConfigService.testContainerAccess("non-existent");

      expect(result.accessible).toBe(false);
      expect(result.error).toBe("Container not found");
      expect(result.errorCode).toBe("CONTAINER_ACCESS_ERROR");
      expect(typeof result.responseTimeMs).toBe('number');
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

      // Verify disconnection was recorded
      expect(mockPrisma.connectivityStatus.create).toHaveBeenCalledWith({
        data: {
          service: "azure",
          status: "failed",
          responseTimeMs: null,
          errorMessage: "Configuration removed by user",
          errorCode: "CONFIG_REMOVED",
          metadata: null,
          checkInitiatedBy: "user1",
          checkedAt: expect.any(Date),
          lastSuccessfulAt: null,
        },
      });

      parentDeleteSpy.mockRestore();
      parentGetSpy.mockRestore();
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
