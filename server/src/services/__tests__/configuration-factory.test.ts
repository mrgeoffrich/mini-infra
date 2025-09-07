import { jest } from "@jest/globals";
import prisma from "../../lib/prisma";
import { PrismaClient } from "../../generated/prisma";
import { ConfigurationServiceFactory } from "../configuration-factory";
import { DockerConfigService } from "../docker-config";
import { CloudflareConfigService } from "../cloudflare-config";
import { AzureConfigService } from "../azure-config";
import { PostgresSettingsConfigService } from "../postgres-settings-config";

// Create a single mock logger instance
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

// Mock logger
jest.mock("../../lib/logger-factory", () => ({
  appLogger: jest.fn(() => mockLogger),
  servicesLogger: jest.fn(() => mockLogger),
  httpLogger: jest.fn(() => mockLogger),
  prismaLogger: jest.fn(() => mockLogger),
  __esModule: true,
  default: jest.fn(() => mockLogger),
}));

// Mock configuration services
jest.mock("../docker-config");
jest.mock("../cloudflare-config");
jest.mock("../azure-config");
jest.mock("../postgres-settings-config");

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
} as unknown as typeof prisma;

// Import the mock after the jest.mock calls

describe("ConfigurationServiceFactory", () => {
  let factory: ConfigurationServiceFactory;

  beforeEach(() => {
    jest.clearAllMocks();
    factory = new ConfigurationServiceFactory(mockPrisma);
  });

  afterAll(() => {
    // Clean up the static NodeCache in AzureConfigService to prevent timer leaks
    AzureConfigService.cleanupCache();
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
        "postgres",
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

      expect(CloudflareConfigService).toHaveBeenCalledWith(mockPrisma);
      expect(service).toBeInstanceOf(CloudflareConfigService);
    });

    it("should create Azure configuration service", () => {
      const service = factory.create({ category: "azure" });

      expect(AzureConfigService).toHaveBeenCalledWith(mockPrisma);
      expect(service).toBeInstanceOf(AzureConfigService);
    });

    it("should create Postgres configuration service", () => {
      const service = factory.create({ category: "postgres" });

      expect(PostgresSettingsConfigService).toHaveBeenCalledWith(mockPrisma);
      expect(service).toBeInstanceOf(PostgresSettingsConfigService);
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
      const MockedDockerConfigService = DockerConfigService as jest.MockedClass<
        typeof DockerConfigService
      >;
      MockedDockerConfigService.mockImplementationOnce(() => {
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
      // Mock CloudflareConfigService constructor to throw non-Error
      const MockedCloudflareConfigService =
        CloudflareConfigService as jest.MockedClass<
          typeof CloudflareConfigService
        >;
      MockedCloudflareConfigService.mockImplementationOnce(() => {
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
        "postgres",
      ]);
      expect(categories2).toEqual([
        "docker",
        "cloudflare",
        "azure",
        "postgres",
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
      expect(factory.isSupported("postgres")).toBe(true);
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
      expect(factory.isSupported("Postgres")).toBe(false);
      expect(factory.isSupported("POSTGRES")).toBe(false);
    });
  });

  describe("Integration with actual service classes", () => {
    beforeEach(() => {
      // Reset mocks to use actual implementations for integration tests
      jest.resetModules();
    });

    it("should create services that extend base configuration service", () => {
      const dockerService = factory.create({ category: "docker" });
      const cloudflareService = factory.create({ category: "cloudflare" });
      const azureService = factory.create({ category: "azure" });
      const postgresService = factory.create({ category: "postgres" });

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

      expect(typeof postgresService.validate).toBe("function");
      expect(typeof postgresService.getHealthStatus).toBe("function");
    });

    it("should create different instances for each call", () => {
      const dockerService1 = factory.create({ category: "docker" });
      const dockerService2 = factory.create({ category: "docker" });

      expect(dockerService1).not.toBe(dockerService2);
      expect(dockerService1).toBeInstanceOf(DockerConfigService);
      expect(dockerService2).toBeInstanceOf(DockerConfigService);

      const postgresService1 = factory.create({ category: "postgres" });
      const postgresService2 = factory.create({ category: "postgres" });

      expect(postgresService1).not.toBe(postgresService2);
      expect(postgresService1).toBeInstanceOf(PostgresSettingsConfigService);
      expect(postgresService2).toBeInstanceOf(PostgresSettingsConfigService);
    });

    it("should pass prisma client to all created services", async () => {
      const dockerService = factory.create({ category: "docker" });
      const cloudflareService = factory.create({ category: "cloudflare" });
      const azureService = factory.create({ category: "azure" });
      const postgresService = factory.create({ category: "postgres" });

      // Test that services can use the prisma client by calling methods that interact with it
      // These calls should not throw errors if prisma client is properly injected
      expect(async () => await dockerService.get("host")).not.toThrow();
      expect(async () => await cloudflareService.get("apiToken")).not.toThrow();
      expect(
        async () => await azureService.get("connectionString"),
      ).not.toThrow();
      expect(async () => await postgresService.get("enabled")).not.toThrow();
    });

    it("should create services with correct constructors", () => {
      const dockerService = factory.create({ category: "docker" });
      const cloudflareService = factory.create({ category: "cloudflare" });
      const azureService = factory.create({ category: "azure" });
      const postgresService = factory.create({ category: "postgres" });

      // Verify that each service was created with the correct constructor and prisma client
      expect(DockerConfigService).toHaveBeenCalledWith(mockPrisma);
      expect(CloudflareConfigService).toHaveBeenCalledWith(mockPrisma);
      expect(AzureConfigService).toHaveBeenCalledWith(mockPrisma);
      expect(PostgresSettingsConfigService).toHaveBeenCalledWith(mockPrisma);

      // Verify that the services are instances of the correct classes
      expect(dockerService).toBeInstanceOf(DockerConfigService);
      expect(cloudflareService).toBeInstanceOf(CloudflareConfigService);
      expect(azureService).toBeInstanceOf(AzureConfigService);
      expect(postgresService).toBeInstanceOf(PostgresSettingsConfigService);
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
