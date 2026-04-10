import prisma, { PrismaClient } from "../lib/prisma";
import {
  IConfigurationService,
  IConfigurationServiceFactory,
  ServiceFactoryOptions,
  SettingsCategory,
} from "@mini-infra/types";
import { servicesLogger } from "../lib/logger-factory";
import { DockerConfigService } from "./docker-config";
import { CloudflareService } from "./cloudflare";
import { AzureStorageService } from "./azure-storage-service";
import { TlsConfigService } from "./tls/tls-config";

export class ConfigurationServiceFactory
  implements IConfigurationServiceFactory
{
  private prisma: PrismaClient;
  private supportedCategories: SettingsCategory[] = [
    "docker",
    "cloudflare",
    "azure",
    "tls",
  ];

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Create a configuration service instance for the specified category
   * @param options - Service factory options including category
   * @returns Configuration service instance
   */
  create(options: ServiceFactoryOptions): IConfigurationService {
    const { category } = options;

    if (!this.supportedCategories.includes(category)) {
      throw new Error(`Unsupported configuration category: ${category}`);
    }

    try {
      switch (category) {
        case "docker":
          return new DockerConfigService(this.prisma);

        case "cloudflare":
          return new CloudflareService(this.prisma);

        case "azure":
          return new AzureStorageService(this.prisma);

        case "tls":
          return new TlsConfigService(this.prisma);

        default:
          throw new Error(`Unknown configuration category: ${category}`);
      }
    } catch (error) {
      servicesLogger().error(
        {
          category: category,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to create configuration service",
      );
      throw error;
    }
  }

  /**
   * Get list of supported configuration categories
   * @returns Array of supported categories
   */
  getSupportedCategories(): SettingsCategory[] {
    return [...this.supportedCategories];
  }

  /**
   * Check if a category is supported
   * @param category - Category to check
   * @returns True if category is supported
   */
  isSupported(category: string): category is SettingsCategory {
    return this.supportedCategories.includes(category as SettingsCategory);
  }
}
