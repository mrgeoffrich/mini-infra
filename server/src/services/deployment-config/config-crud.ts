import { PrismaClient } from "../../lib/prisma";
import { servicesLogger } from "../../lib/logger-factory";
import NodeCache from "node-cache";
import {
  DeploymentConfigurationInfo,
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  DeploymentConfigFilter,
  DeploymentConfigSortOptions,
} from "@mini-infra/types";
import { ConfigValidator } from "./config-validator";
import { toConfigurationInfo } from "./mappers";

export class ConfigCrudOperations {
  private prisma: PrismaClient;
  private cache: NodeCache;
  private configValidator: ConfigValidator;

  constructor(
    prisma: PrismaClient,
    cache: NodeCache,
    configValidator: ConfigValidator,
  ) {
    this.prisma = prisma;
    this.cache = cache;
    this.configValidator = configValidator;
  }

  /**
   * Create a new deployment configuration
   */
  async createDeploymentConfig(
    request: CreateDeploymentConfigRequest,
  ): Promise<DeploymentConfigurationInfo> {
    try {
      // Validate input
      this.configValidator.validateDeploymentConfigRequest(request);

      // Validate environment exists and user has access (environments are not user-scoped)
      const environment = await this.prisma.environment.findUnique({
        where: {
          id: request.environmentId,
        },
      });

      if (!environment) {
        throw new Error(
          `Environment with ID '${request.environmentId}' not found`,
        );
      }

      if (!environment.isActive) {
        throw new Error(
          `Environment '${environment.name}' is not active`,
        );
      }

      // Check for duplicate application name in this environment
      const existing = await this.prisma.deploymentConfiguration.findFirst({
        where: {
          applicationName: request.applicationName,
          environmentId: request.environmentId,
        },
      });

      if (existing) {
        throw new Error(
          `Deployment configuration for application '${request.applicationName}' already exists in environment '${environment.name}'`,
        );
      }

      // Auto-adjust listeningPort based on SSL setting if not explicitly provided
      const listeningPort = request.listeningPort !== undefined
        ? request.listeningPort
        : (request.enableSsl ? 443 : 80);

      // Create deployment configuration
      const created = await this.prisma.deploymentConfiguration.create({
        data: {
          applicationName: request.applicationName,
          dockerImage: request.dockerImage,
          dockerTag: request.dockerTag || "latest",
          dockerRegistry: request.dockerRegistry,
          containerConfig: request.containerConfig as any,
          healthCheckConfig: request.healthCheckConfig as any,
          rollbackConfig: request.rollbackConfig as any,
          listeningPort: listeningPort,
          hostname: request.hostname,
          enableSsl: request.enableSsl || false,
          environmentId: request.environmentId,
          isActive: true,
        },
      });

      // Clear cache since we added a new configuration
      this.clearCache();

      servicesLogger().info(
        {
          configId: created.id,
          applicationName: created.applicationName,
        },
        "Deployment configuration created",
      );

      return toConfigurationInfo(created);
    } catch (error) {
      servicesLogger().error(
        {
          applicationName: request.applicationName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to create deployment configuration",
      );
      throw error;
    }
  }

  /**
   * Update an existing deployment configuration
   */
  async updateDeploymentConfig(
    configId: string,
    request: UpdateDeploymentConfigRequest,
  ): Promise<DeploymentConfigurationInfo> {
    try {
      // Get existing configuration
      const existing = await this.prisma.deploymentConfiguration.findFirst({
        where: {
          id: configId,
        },
      });

      if (!existing) {
        throw new Error("Deployment configuration not found");
      }

      // Check for duplicate application name if name is being changed
      if (
        request.applicationName &&
        request.applicationName !== existing.applicationName
      ) {
        const duplicate = await this.prisma.deploymentConfiguration.findFirst({
          where: {
            applicationName: request.applicationName,
            id: { not: configId },
          },
        });

        if (duplicate) {
          throw new Error(
            `Deployment configuration for application '${request.applicationName}' already exists`,
          );
        }
      }

      // Prepare update data
      const updateData: any = {
        updatedAt: new Date(),
      };

      if (request.applicationName)
        updateData.applicationName = request.applicationName;
      if (request.dockerImage) updateData.dockerImage = request.dockerImage;
      if (request.dockerTag !== undefined)
        updateData.dockerTag = request.dockerTag;
      if (request.dockerRegistry !== undefined)
        updateData.dockerRegistry = request.dockerRegistry;
      if (request.containerConfig)
        updateData.containerConfig = request.containerConfig;
      if (request.healthCheckConfig)
        updateData.healthCheckConfig = request.healthCheckConfig;
      if (request.rollbackConfig)
        updateData.rollbackConfig = request.rollbackConfig;
      if (request.listeningPort !== undefined)
        updateData.listeningPort = request.listeningPort;
      if (request.hostname !== undefined)
        updateData.hostname = request.hostname;
      if (request.enableSsl !== undefined) {
        updateData.enableSsl = request.enableSsl;
        // Auto-adjust listeningPort when SSL is toggled (unless explicitly provided)
        if (request.listeningPort === undefined) {
          updateData.listeningPort = request.enableSsl ? 443 : 80;
        }
      }
      if (request.isActive !== undefined)
        updateData.isActive = request.isActive;

      // Update configuration
      const updated = await this.prisma.deploymentConfiguration.update({
        where: { id: configId },
        data: updateData,
      });

      // Clear cache
      this.clearCache();

      servicesLogger().info(
        {
          configId: updated.id,
          applicationName: updated.applicationName,
        },
        "Deployment configuration updated",
      );

      return toConfigurationInfo(updated);
    } catch (error) {
      servicesLogger().error(
        {
          configId: configId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to update deployment configuration",
      );
      throw error;
    }
  }

  /**
   * Get a deployment configuration by ID
   */
  async getDeploymentConfig(
    configId: string,
  ): Promise<DeploymentConfigurationInfo | null> {
    try {
      const cacheKey = `config:${configId}`;
      const cached = this.cache.get<DeploymentConfigurationInfo>(cacheKey);

      if (cached) {
        return cached;
      }

      const config = await this.prisma.deploymentConfiguration.findFirst({
        where: {
          id: configId,
        },
        include: {
          dnsRecords: true,
          haproxyFrontend: true,
        },
      });

      if (!config) {
        return null;
      }

      const result = toConfigurationInfo(config);
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      servicesLogger().error(
        {
          configId: configId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get deployment configuration",
      );
      throw error;
    }
  }

  /**
   * Get a deployment configuration by application name
   */
  async getDeploymentConfigByName(
    applicationName: string,
  ): Promise<DeploymentConfigurationInfo | null> {
    try {
      const cacheKey = `config:name:${applicationName}`;
      const cached = this.cache.get<DeploymentConfigurationInfo>(cacheKey);

      if (cached) {
        return cached;
      }

      const config = await this.prisma.deploymentConfiguration.findFirst({
        where: {
          applicationName: applicationName,
        },
        include: {
          dnsRecords: true,
          haproxyFrontend: true,
        },
      });

      if (!config) {
        return null;
      }

      const result = toConfigurationInfo(config);
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      servicesLogger().error(
        {
          applicationName: applicationName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get deployment configuration by name",
      );
      throw error;
    }
  }

  /**
   * List deployment configurations
   */
  async listDeploymentConfigs(
    filter?: DeploymentConfigFilter,
    sort?: DeploymentConfigSortOptions,
    limit?: number,
    offset?: number,
  ): Promise<DeploymentConfigurationInfo[]> {
    try {
      // Build cache key
      const cacheKey = `list:${JSON.stringify({ filter, sort, limit, offset })}`;
      const cached = this.cache.get<DeploymentConfigurationInfo[]>(cacheKey);

      if (cached) {
        return cached;
      }

      // Build where clause
      const where: any = {};

      if (filter) {
        if (filter.applicationName) {
          // Use case-insensitive filtering for both SQLite and PostgreSQL
          if (process.env.DATABASE_URL?.includes('postgresql')) {
            where.applicationName = {
              contains: filter.applicationName,
              mode: "insensitive",
            };
          } else {
            // SQLite doesn't support mode parameter, but LIKE is case-insensitive by default
            where.applicationName = {
              contains: filter.applicationName,
            };
          }
        }
        if (filter.dockerImage) {
          // Use case-insensitive filtering for both SQLite and PostgreSQL
          if (process.env.DATABASE_URL?.includes('postgresql')) {
            where.dockerImage = {
              contains: filter.dockerImage,
              mode: "insensitive",
            };
          } else {
            // SQLite doesn't support mode parameter, but LIKE is case-insensitive by default
            where.dockerImage = {
              contains: filter.dockerImage,
            };
          }
        }
        if (filter.isActive !== undefined) {
          where.isActive = filter.isActive;
        }
        if (filter.environmentId) {
          where.environmentId = filter.environmentId;
        }
      }

      // Build order by clause
      let orderBy: any = { createdAt: "desc" }; // Default sort

      if (sort) {
        orderBy = { [sort.field]: sort.order };
      }

      // Query configurations
      const configs = await this.prisma.deploymentConfiguration.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
        include: {
          dnsRecords: true,
          haproxyFrontend: true,
        },
      });

      const result = configs.map((config: any) => toConfigurationInfo(config));

      // Cache for 5 minutes
      this.cache.set(cacheKey, result, 300);

      return result;
    } catch (error) {
      servicesLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to list deployment configurations",
      );
      throw error;
    }
  }

  /**
   * Activate/deactivate a deployment configuration
   */
  async setConfigurationActive(
    configId: string,
    isActive: boolean,
  ): Promise<DeploymentConfigurationInfo> {
    return this.updateDeploymentConfig(configId, { isActive });
  }

  /**
   * Clear the configuration cache
   */
  clearCache(): void {
    this.cache.flushAll();
  }
}
