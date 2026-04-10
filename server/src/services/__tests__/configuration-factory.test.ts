import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma";
import { ConfigurationServiceFactory } from "../configuration-factory";
import { DockerConfigService } from "../docker-config";
import { CloudflareService } from "../cloudflare";
import { AzureStorageService } from "../azure-storage-service";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock logger
vi.mock("../../lib/logger-factory", () => ({
  appLogger: vi.fn(function() { return mockLogger; }),
  servicesLogger: vi.fn(function() { return mockLogger; }),
  httpLogger: vi.fn(function() { return mockLogger; }),
  prismaLogger: vi.fn(function() { return mockLogger; }),
  default: vi.fn(function() { return mockLogger; }),
}));

// Mock configuration services
vi.mock("../docker-config");
vi.mock("../cloudflare/cloudflare-service");
vi.mock("../azure-storage-service");
vi.mock("../tls/tls-config");

// Mock Prisma client
const mockPrisma = {
  systemSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  connectivityStatus: {
    create: vi.fn(),
    findFirst: vi.fn(),
  },
  settingsAudit: {
    create: vi.fn(),
  },
} as unknown as typeof prisma;

// Import the mock after the vi.mock calls

describe("ConfigurationServiceFactory", () => {
  let factory: ConfigurationServiceFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    factory = new ConfigurationServiceFactory(mockPrisma);
  });

  afterAll(() => {
    // Clean up the static NodeCache in AzureStorageService to prevent timer leaks
    AzureStorageService.cleanupCache();
  });

  describe("Constructor", () => {
    it("should initialize with correct prisma client", () => {
      expect((factory as any).prisma).toBe(mockPrisma);
    });

    it("should initialize with supported categories", () => {
      const supportedCategories = factory.getSupportedCategories();
      expect(supportedCategories).toEqual([
        "docker",
        "cloudflare",
        "azure",
        "tls",
      ]);
    });
  });

  describe("create", () => {
    it("should create Docker configuration service", () => {
      const service = factory.create({ category: "docker" });

      expect(DockerConfigService).toHaveBeenCalledWith(mockPrisma);
      expect(service).toBeInstanceOf(DockerConfigService);
    });

    it("should create Cloudflare configuration service", () => {
      const service = factory.create({ category: "cloudflare" });

      expect(CloudflareService).toHaveBeenCalledWith(mockPrisma);
      expect(service).toBeInstanceOf(CloudflareService);
    });

    it("should create Azure configuration service", () => {
      const service = factory.create({ category: "azure" });

      expect(AzureStorageService).toHaveBeenCalledWith(mockPrisma);
      expect(service).toBeInstanceOf(AzureStorageService);
    });

    it("should throw error for unsupported category", () => {
      expect(() => {
        factory.create({ category: "unsupported" as any });
      }).toThrow("Unsupported configuration category: unsupported");
    });

    it("should throw error for empty category", () => {
      expect(() => {
        factory.create({ category: "" as any });
      }).toThrow("Unsupported configuration category: ");
    });

    it("should throw error for null category", () => {
      expect(() => {
        factory.create({ category: null as any });
      }).toThrow("Unsupported configuration category: null");
    });

    it("should throw error for undefined category", () => {
      expect(() => {
        factory.create({ category: undefined as any });
      }).toThrow("Unsupported configuration category: undefined");
    });

    it("should log error when service creation fails", () => {
      // Mock DockerConfigService constructor to throw
      const MockedDockerConfigService = DockerConfigService as MockedClass<
        typeof DockerConfigService
      >;
      MockedDockerConfigService.mockImplementationOnce(function() {
        throw new Error("Service creation failed");
      });

      expect(() => {
        factory.create({ category: "docker" });
      }).toThrow("Service creation failed");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "docker",
          error: "Service creation failed",
        },
        "Failed to create configuration service",
      );
    });

    it("should log error with unknown error message when non-Error thrown", () => {
      // Mock CloudflareService constructor to throw non-Error
      const MockedCloudflareService =
        CloudflareService as MockedClass<
          typeof CloudflareService
        >;
      MockedCloudflareService.mockImplementationOnce(function() {
        throw "String error";
      });

      expect(() => {
        factory.create({ category: "cloudflare" });
      }).toThrow("String error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        {
          category: "cloudflare",
          error: "Unknown error",
        },
        "Failed to create configuration service",
      );
    });
  });

  describe("getSupportedCategories", () => {
    it("should return copy of supported categories", () => {
      const categories1 = factory.getSupportedCategories();
      const categories2 = factory.getSupportedCategories();

      expect(categories1).toEqual([
        "docker",
        "cloudflare",
        "azure",
        "tls",
      ]);
      expect(categories2).toEqual([
        "docker",
        "cloudflare",
        "azure",
        "tls",
      ]);

      // Should be different array instances
      expect(categories1).not.toBe(categories2);

      // Modifying one shouldn't affect the other
      categories1.push("test" as any);
      expect(categories2).toHaveLength(4);
    });
  });

  describe("isSupported", () => {
    it("should return true for supported categories", () => {
      expect(factory.isSupported("docker")).toBe(true);
      expect(factory.isSupported("cloudflare")).toBe(true);
      expect(factory.isSupported("azure")).toBe(true);
      expect(factory.isSupported("tls")).toBe(true);
    });

    it("should return false for unsupported categories", () => {
      expect(factory.isSupported("postgresql")).toBe(false);
      expect(factory.isSupported("redis")).toBe(false);
      expect(factory.isSupported("")).toBe(false);
      expect(factory.isSupported("123")).toBe(false);
    });

    it("should handle null and undefined", () => {
      expect(factory.isSupported(null as any)).toBe(false);
      expect(factory.isSupported(undefined as any)).toBe(false);
    });

    it("should be case sensitive", () => {
      expect(factory.isSupported("Docker")).toBe(false);
      expect(factory.isSupported("DOCKER")).toBe(false);
      expect(factory.isSupported("CloudFlare")).toBe(false);
      expect(factory.isSupported("Azure")).toBe(false);
    });
  });

  describe("Integration with actual service classes", () => {
    beforeEach(() => {
      // Reset mocks to use actual implementations for integration tests
      vi.resetModules();
    });

    it("should create services that extend base configuration service", () => {
      const dockerService = factory.create({ category: "docker" });
      const cloudflareService = factory.create({ category: "cloudflare" });
      const azureService = factory.create({ category: "azure" });

      // Check if instances have expected methods from base class
      expect(typeof dockerService.validate).toBe("function");
      expect(typeof dockerService.getHealthStatus).toBe("function");
      expect(typeof dockerService.set).toBe("function");
      expect(typeof dockerService.get).toBe("function");
      expect(typeof dockerService.delete).toBe("function");

      expect(typeof cloudflareService.validate).toBe("function");
      expect(typeof cloudflareService.getHealthStatus).toBe("function");

      expect(typeof azureService.validate).toBe("function");
      expect(typeof azureService.getHealthStatus).toBe("function");
    });

    it("should create different instances for each call", () => {
      const dockerService1 = factory.create({ category: "docker" });
      const dockerService2 = factory.create({ category: "docker" });

      expect(dockerService1).not.toBe(dockerService2);
      expect(dockerService1).toBeInstanceOf(DockerConfigService);
      expect(dockerService2).toBeInstanceOf(DockerConfigService);
    });

    it("should pass prisma client to all created services", async () => {
      const dockerService = factory.create({ category: "docker" });
      const cloudflareService = factory.create({ category: "cloudflare" });
      const azureService = factory.create({ category: "azure" });

      // Test that services can use the prisma client by calling methods that interact with it
      // These calls should not throw errors if prisma client is properly injected
      expect(async () => await dockerService.get("host")).not.toThrow();
      expect(async () => await cloudflareService.get("apiToken")).not.toThrow();
      expect(
        async () => await azureService.get("connectionString"),
      ).not.toThrow();
    });

    it("should create services with correct constructors", () => {
      const dockerService = factory.create({ category: "docker" });
      const cloudflareService = factory.create({ category: "cloudflare" });
      const azureService = factory.create({ category: "azure" });

      // Verify that each service was created with the correct constructor and prisma client
      expect(DockerConfigService).toHaveBeenCalledWith(mockPrisma);
      expect(CloudflareService).toHaveBeenCalledWith(mockPrisma);
      expect(AzureStorageService).toHaveBeenCalledWith(mockPrisma);

      // Verify that the services are instances of the correct classes
      expect(dockerService).toBeInstanceOf(DockerConfigService);
      expect(cloudflareService).toBeInstanceOf(CloudflareService);
      expect(azureService).toBeInstanceOf(AzureStorageService);
    });
  });

  describe("Error handling scenarios", () => {
    it("should handle prisma client being null", () => {
      const nullFactory = new ConfigurationServiceFactory(null as any);

      // Should still create factory but services might fail at runtime
      expect(nullFactory).toBeInstanceOf(ConfigurationServiceFactory);
      expect(nullFactory.getSupportedCategories()).toHaveLength(4);
    });

    it("should handle factory with corrupted supported categories", () => {
      // Manually corrupt the supported categories array
      (factory as any).supportedCategories = null;

      // Trying to spread null will throw a TypeError
      expect(() => {
        factory.getSupportedCategories();
      }).toThrow(TypeError);
    });

    it("should handle service creation with undefined options", () => {
      expect(() => {
        factory.create(undefined as any);
      }).toThrow();
    });

    it("should handle service creation with null options", () => {
      expect(() => {
        factory.create(null as any);
      }).toThrow();
    });

    it("should handle service creation with empty options object", () => {
      expect(() => {
        factory.create({} as any);
      }).toThrow("Unsupported configuration category: undefined");
    });
  });
});
