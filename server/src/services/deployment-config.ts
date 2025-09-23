import prisma, { PrismaClient } from "../lib/prisma";
import { servicesLogger } from "../lib/logger-factory";
import { ConfigurationService } from "./configuration-base";
import { ContainerLifecycleManager } from "./container-lifecycle-manager";
import DockerService from "./docker";
import NodeCache from "node-cache";
import { z } from "zod";
import { SettingsCategory } from "@mini-infra/types";
import {
  DeploymentConfiguration,
  DeploymentConfigurationInfo,
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  DeploymentConfigFilter,
  DeploymentConfigSortOptions,
  DeploymentConfigValidationResult,
  ValidationResult,
  ServiceHealthStatus,
  ContainerConfig,
  HealthCheckConfig,
  RollbackConfig,
  HostnameValidationResult,
} from "@mini-infra/types";
import { CloudflareConfigService } from "./cloudflare-config";

// ====================
// Zod Validation Schemas
// ====================

const deploymentPortSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
});

const deploymentVolumeSchema = z.object({
  hostPath: z.string().min(1),
  containerPath: z.string().min(1),
  mode: z.enum(["rw", "ro"]).optional(),
});

const containerEnvVarSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

const containerConfigSchema = z.object({
  ports: z.array(deploymentPortSchema),
  volumes: z.array(deploymentVolumeSchema),
  environment: z.array(containerEnvVarSchema),
  labels: z.record(z.string(), z.string()),
  networks: z.array(z.string()),
});

const healthCheckConfigSchema = z.object({
  endpoint: z.string().min(1),
  method: z.enum(["GET", "POST"]),
  expectedStatus: z.array(z.number().int().min(100).max(599)),
  responseValidation: z.string().optional(),
  timeout: z.number().int().min(1000),
  retries: z.number().int().min(1),
  interval: z.number().int().min(1000),
});


const rollbackConfigSchema = z.object({
  enabled: z.boolean(),
  maxWaitTime: z.number().int().min(1000),
  keepOldContainer: z.boolean(),
});

export const createDeploymentConfigSchema = z.object({
  applicationName: z
    .string()
    .min(1, "Application name is required")
    .max(100, "Application name must be 100 characters or less")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Application name can only contain letters, numbers, hyphens, and underscores",
    ),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerRegistry: z.string().optional(),
  containerConfig: containerConfigSchema,
  healthCheckConfig: healthCheckConfigSchema,
  rollbackConfig: rollbackConfigSchema,
  listeningPort: z.number().int().min(1).max(65535).optional(),
  hostname: z
    .string()
    .min(1, "Hostname cannot be empty")
    .max(253, "Hostname must be 253 characters or less")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/,
      "Hostname must be a valid domain name (e.g., example.com, api.example.com)",
    )
    .optional(),
  environmentId: z.string().min(1, "Environment ID is required"),
});

export const updateDeploymentConfigSchema = z.object({
  applicationName: z
    .string()
    .min(1, "Application name is required")
    .max(100, "Application name must be 100 characters or less")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Application name can only contain letters, numbers, hyphens, and underscores",
    )
    .optional(),
  dockerImage: z.string().min(1, "Docker image is required").optional(),
  dockerRegistry: z.string().optional(),
  containerConfig: containerConfigSchema.optional(),
  healthCheckConfig: healthCheckConfigSchema.optional(),
  rollbackConfig: rollbackConfigSchema.optional(),
  listeningPort: z.number().int().min(1).max(65535).optional(),
  hostname: z
    .string()
    .min(1, "Hostname cannot be empty")
    .max(253, "Hostname must be 253 characters or less")
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/,
      "Hostname must be a valid domain name (e.g., example.com, api.example.com)",
    )
    .optional(),
  isActive: z.boolean().optional(),
});

export class DeploymentConfigService extends ConfigurationService {
  private cache: NodeCache;
  private dockerService: DockerService;
  private containerManager: ContainerLifecycleManager;
  private cloudflareService: CloudflareConfigService;

  constructor(prismaInstance: PrismaClient, encryptionKey?: string) {
    super(prismaInstance, "deployments" as SettingsCategory);

    // Initialize cache with 5 minute TTL for deployment configurations
    this.cache = new NodeCache({
      stdTTL: 300, // 5 minutes
      checkperiod: 60, // check for expired keys every 60 seconds
      useClones: false,
    });

    // Initialize Docker service and container manager for cleanup operations
    this.dockerService = DockerService.getInstance();
    this.containerManager = new ContainerLifecycleManager();
    this.cloudflareService = new CloudflareConfigService(prismaInstance);
  }

  // ====================
  // ConfigurationService Implementation
  // ====================

  /**
   * Validate deployment configuration service
   */
  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      // Test database connection by counting deployment configurations
      const count = await this.prisma.deploymentConfiguration.count();
      const responseTimeMs = Date.now() - startTime;

      await this.recordConnectivityStatus(
        "connected",
        responseTimeMs,
        undefined,
        undefined,
        { configurationsCount: count },
      );

      return {
        isValid: true,
        message: `Deployment service connected successfully. ${count} configurations found.`,
        responseTimeMs,
        metadata: { configurationsCount: count },
      };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      await this.recordConnectivityStatus(
        "failed",
        responseTimeMs,
        errorMessage,
        "DATABASE_CONNECTION_FAILED",
      );

      return {
        isValid: false,
        message: errorMessage,
        errorCode: "DATABASE_CONNECTION_FAILED",
        responseTimeMs,
      };
    }
  }

  /**
   * Get health status of deployment configuration service
   */
  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const latestStatus = await this.getLatestConnectivityStatus();

    return {
      service: "deployments",
      status: latestStatus?.status === "connected" ? "connected" : "failed",
      lastChecked: new Date(),
      lastSuccessful: latestStatus?.lastSuccessfulAt || undefined,
      responseTime: latestStatus?.responseTimeMs
        ? Number(latestStatus.responseTimeMs)
        : undefined,
      errorMessage: latestStatus?.errorMessage || undefined,
      errorCode: latestStatus?.errorCode || undefined,
      metadata: latestStatus?.metadata
        ? JSON.parse(latestStatus.metadata)
        : undefined,
    };
  }

  // ====================
  // Deployment Configuration CRUD Operations
  // ====================

  /**
   * Create a new deployment configuration
   */
  async createDeploymentConfig(
    request: CreateDeploymentConfigRequest,
  ): Promise<DeploymentConfigurationInfo> {
    try {
      // Validate input
      this.validateDeploymentConfigRequest(request);

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

      // Create deployment configuration
      const created = await this.prisma.deploymentConfiguration.create({
        data: {
          applicationName: request.applicationName,
          dockerImage: request.dockerImage,
          dockerRegistry: request.dockerRegistry,
          containerConfig: request.containerConfig as any,
          healthCheckConfig: request.healthCheckConfig as any,
          rollbackConfig: request.rollbackConfig as any,
          listeningPort: request.listeningPort,
          hostname: request.hostname,
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

      return this.toConfigurationInfo(created);
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

      return this.toConfigurationInfo(updated);
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
      });

      if (!config) {
        return null;
      }

      const result = this.toConfigurationInfo(config);
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
      });

      if (!config) {
        return null;
      }

      const result = this.toConfigurationInfo(config);
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
      });

      const result = configs.map((config: any) => this.toConfigurationInfo(config));

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
   * Delete a deployment configuration
   */
  async deleteDeploymentConfig(
    configId: string,
  ): Promise<void> {
    try {
      // Verify existence
      const config = await this.prisma.deploymentConfiguration.findFirst({
        where: {
          id: configId,
        },
      });

      if (!config) {
        throw new Error("Deployment configuration not found");
      }

      const logger = servicesLogger();
      const applicationName = config.applicationName;

      logger.info(
        {
          configId: configId,
          applicationName,
        },
        "Starting deployment configuration deletion with container cleanup",
      );

      // Clean up any running containers for this application before deletion
      try {
        await this.cleanupApplicationContainers(applicationName);
        logger.info(
          {
            configId: configId,
            applicationName,
          },
          "Successfully cleaned up application containers",
        );
      } catch (cleanupError) {
        // Log cleanup error but continue with deletion
        logger.warn(
          {
            configId: configId,
            applicationName,
            error: cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup error",
          },
          "Failed to cleanup containers during deletion - continuing with database deletion",
        );
      }

      // Delete configuration (cascade will handle related deployments)
      await this.prisma.deploymentConfiguration.delete({
        where: { id: configId },
      });

      // Clear cache
      this.clearCache();

      logger.info(
        {
          configId: configId,
          applicationName,
        },
        "Deployment configuration deleted successfully",
      );
    } catch (error) {
      servicesLogger().error(
        {
          configId: configId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to delete deployment configuration",
      );
      throw error;
    }
  }

  /**
   * Clean up all containers for a given application
   */
  private async cleanupApplicationContainers(applicationName: string): Promise<void> {
    const logger = servicesLogger();
    
    try {
      // Find all containers with the application label
      const containers = await this.dockerService.listContainers();
      const appContainers = containers.filter((container: any) => {
        const labels = container.labels || {};
        return labels["mini-infra.application"] === applicationName;
      });

      if (appContainers.length === 0) {
        logger.info(
          { applicationName },
          "No containers found for application - skipping cleanup",
        );
        return;
      }

      logger.info(
        { 
          applicationName, 
          containerCount: appContainers.length,
          containerIds: appContainers.map((c: any) => c.id.slice(0, 12)),
        },
        "Found containers to clean up for application",
      );

      // Stop and remove each container
      for (const container of appContainers) {
        const containerId = container.id;
        const containerName = container.name || containerId;
        
        try {
          logger.info(
            { applicationName, containerId: containerId.slice(0, 12), containerName },
            "Stopping and removing container",
          );
          
          // Stop the container with a 30 second timeout
          await this.containerManager.stopContainer(containerId, 30);
          
          // Remove the container (force=true to handle any remaining processes)
          await this.containerManager.removeContainer(containerId, true);
          
          logger.info(
            { applicationName, containerId: containerId.slice(0, 12), containerName },
            "Successfully cleaned up container",
          );
        } catch (containerError) {
          logger.warn(
            { 
              applicationName, 
              containerId: containerId.slice(0, 12),
              containerName,
              error: containerError instanceof Error ? containerError.message : "Unknown error",
            },
            "Failed to cleanup individual container - continuing with others",
          );
        }
      }
    } catch (error) {
      logger.error(
        {
          applicationName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to cleanup application containers",
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

  // ====================
  // Hostname Validation Methods
  // ====================

  /**
   * Generate basic hostname suggestions for invalid formats
   */
  private generateBasicHostnameSuggestions(hostname: string): string[] {
    const suggestions: string[] = [];

    // Clean up common issues
    const cleaned = hostname
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '-') // Replace invalid chars with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/\.+/g, '.') // Replace multiple dots with single
      .replace(/^\.+|\.+$/g, ''); // Remove leading/trailing dots

    if (cleaned && cleaned !== hostname && cleaned.length <= 253) {
      suggestions.push(cleaned);
    }

    // Suggest common domain patterns if it looks like a single word
    if (!hostname.includes('.') && hostname.length > 0) {
      const clean = hostname.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean) {
        suggestions.push(`${clean}.example.com`);
        suggestions.push(`api.${clean}.com`);
        suggestions.push(`app.${clean}.com`);
      }
    }

    return suggestions.slice(0, 3); // Limit to 3 basic suggestions
  }

  /**
   * Generate hostname suggestions based on conflict type
   */
  private generateHostnameSuggestions(hostname: string, conflictType: "deployment_config" | "cloudflare"): string[] {
    const parts = hostname.split('.');
    const subdomain = parts[0];
    const domain = parts.slice(1).join('.');

    const suggestions: string[] = [];

    if (conflictType === "deployment_config") {
      // For deployment config conflicts, suggest versioning and staging variants
      suggestions.push(`${subdomain}-v2.${domain}`);
      suggestions.push(`${subdomain}-new.${domain}`);
      suggestions.push(`${subdomain}-staging.${domain}`);
      suggestions.push(`${subdomain}-dev.${domain}`);
      suggestions.push(`api-${subdomain}.${domain}`);
    } else if (conflictType === "cloudflare") {
      // For Cloudflare conflicts, suggest alternative subdomains
      suggestions.push(`api.${hostname}`);
      suggestions.push(`app.${hostname}`);
      suggestions.push(`service.${hostname}`);
      suggestions.push(`${subdomain}-app.${domain}`);
      suggestions.push(`${subdomain}-service.${domain}`);
    }

    // Add generic alternatives
    if (domain && parts.length > 1) {
      suggestions.push(`new.${hostname}`);
      suggestions.push(`v2.${hostname}`);
    }

    // Remove duplicates and filter valid ones
    return [...new Set(suggestions)]
      .filter(s => s !== hostname && s.length <= 253)
      .slice(0, 6); // Limit to 6 suggestions
  }

  /**
   * Validate a hostname for deployment configuration
   * Checks if hostname is available and not conflicting with existing configs or Cloudflare
   */
  async validateHostname(hostname: string, excludeConfigId?: string): Promise<HostnameValidationResult> {
    const logger = servicesLogger();

    try {
      // Handle empty hostname
      if (!hostname || hostname.trim().length === 0) {
        throw new Error("Hostname is required and cannot be empty");
      }

      // Check length first
      if (hostname.length > 253) {
        return {
          isValid: false,
          isAvailable: false,
          message: `Hostname must be 253 characters or less (currently ${hostname.length} characters)`,
          suggestions: []
        };
      }

      // Basic hostname format validation - updated to allow single word hostnames
      const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
      if (!hostnameRegex.test(hostname)) {
        let errorMessage = "Invalid hostname format.";

        // Provide specific error messages for common issues
        if (hostname.startsWith('-') || hostname.endsWith('-')) {
          errorMessage += " Hostname cannot start or end with a hyphen.";
        } else if (hostname.includes('..')) {
          errorMessage += " Hostname cannot contain consecutive dots.";
        } else if (hostname.startsWith('.') || hostname.endsWith('.')) {
          errorMessage += " Hostname cannot start or end with a dot.";
        } else if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
          errorMessage += " Hostname can only contain letters, numbers, dots, and hyphens.";
        } else {
          errorMessage += " Must be a valid domain name (e.g., example.com, api.example.com).";
        }

        return {
          isValid: false,
          isAvailable: false,
          message: errorMessage,
          suggestions: this.generateBasicHostnameSuggestions(hostname)
        };
      }

      // Check if hostname already exists in deployment configurations
      const existingConfig = await this.prisma.deploymentConfiguration.findFirst({
        where: {
          hostname: hostname,
          ...(excludeConfigId ? { id: { not: excludeConfigId } } : {})
        },
        select: {
          id: true,
          applicationName: true,
        }
      });

      const conflictDetails = {
        existsInCloudflare: false,
        existsInDeploymentConfigs: !!existingConfig,
        cloudflareZone: undefined as string | undefined,
        conflictingConfigId: existingConfig?.id,
        conflictingConfigName: existingConfig?.applicationName,
      };

      if (existingConfig) {
        return {
          isValid: true, // hostname format is valid
          isAvailable: false,
          message: `Hostname '${hostname}' is already used by deployment configuration '${existingConfig.applicationName}'`,
          conflictDetails,
          suggestions: this.generateHostnameSuggestions(hostname, "deployment_config")
        };
      }

      // Check Cloudflare for existing hostname usage
      let cloudflareConflict = false;
      let cloudflareZone: string | undefined;

      try {
        // Get tunnel information to check for hostname conflicts
        const tunnels = await this.cloudflareService.getTunnelInfo();

        for (const tunnel of tunnels) {
          // Get tunnel configuration to check ingress rules
          try {
            const config = await this.cloudflareService.getTunnelConfig(tunnel.id);
            if (config?.config?.ingress) {
              const hasHostname = config.config.ingress.some((rule: any) =>
                rule.hostname === hostname
              );
              if (hasHostname) {
                cloudflareConflict = true;
                cloudflareZone = tunnel.name; // Use tunnel name as zone identifier
                break;
              }
            }
          } catch (configError) {
            // Log but continue checking other tunnels
            logger.debug({
              tunnelId: tunnel.id,
              error: configError instanceof Error ? configError.message : "Unknown error"
            }, "Failed to retrieve tunnel config during hostname validation");
          }
        }
      } catch (cloudflareError) {
        // Log error but don't fail validation - Cloudflare might not be configured
        logger.warn({
          hostname,
          error: cloudflareError instanceof Error ? cloudflareError.message : "Unknown error"
        }, "Failed to check Cloudflare for hostname conflicts");
      }

      conflictDetails.existsInCloudflare = cloudflareConflict;
      conflictDetails.cloudflareZone = cloudflareZone;

      if (cloudflareConflict) {
        return {
          isValid: true,
          isAvailable: false,
          message: `Hostname '${hostname}' is already configured in Cloudflare tunnel${cloudflareZone ? ` (${cloudflareZone})` : ''}`,
          conflictDetails,
          suggestions: this.generateHostnameSuggestions(hostname, "cloudflare")
        };
      }

      // Hostname is available
      return {
        isValid: true,
        isAvailable: true,
        message: `Hostname '${hostname}' is available for use`,
        conflictDetails,
        suggestions: []
      };

    } catch (error) {
      // Re-throw validation errors (like empty hostname)
      if (error instanceof Error && error.message.includes("required and cannot be empty")) {
        throw error;
      }

      logger.error({
        hostname,
        error: error instanceof Error ? error.message : "Unknown error"
      }, "Failed to validate hostname");

      return {
        isValid: false,
        isAvailable: false,
        message: "Failed to validate hostname due to internal error",
        suggestions: []
      };
    }
  }

  // ====================
  // Validation Methods
  // ====================

  /**
   * Validate a deployment configuration
   */
  validateDeploymentConfiguration(
    config: CreateDeploymentConfigRequest,
  ): DeploymentConfigValidationResult {
    const errors: { field: string; message: string }[] = [];

    // Validate application name
    if (!config.applicationName || config.applicationName.trim().length === 0) {
      errors.push({
        field: "applicationName",
        message: "Application name is required",
      });
    } else if (!/^[a-zA-Z0-9_-]+$/.test(config.applicationName)) {
      errors.push({
        field: "applicationName",
        message:
          "Application name can only contain letters, numbers, hyphens, and underscores",
      });
    } else if (config.applicationName.length > 100) {
      errors.push({
        field: "applicationName",
        message: "Application name must be 100 characters or less",
      });
    }

    // Validate docker image
    if (!config.dockerImage || config.dockerImage.trim().length === 0) {
      errors.push({
        field: "dockerImage",
        message: "Docker image is required",
      });
    }

    // Validate container config
    this.validateContainerConfig(config.containerConfig, errors);

    // Validate health check config
    this.validateHealthCheckConfig(config.healthCheckConfig, errors);


    // Validate rollback config
    this.validateRollbackConfig(config.rollbackConfig, errors);

    return {
      isValid: errors.length === 0,
      message:
        errors.length === 0
          ? "Configuration is valid"
          : "Configuration has validation errors",
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // ====================
  // Private Utility Methods
  // ====================

  private validateDeploymentConfigRequest(
    request: CreateDeploymentConfigRequest,
  ): void {
    try {
      createDeploymentConfigSchema.parse(request);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.issues
          .map((e: any) => `${e.path.join(".")}: ${e.message}`)
          .join(", ");
        throw new Error(`Validation failed: ${errorMessages}`);
      }
      throw error;
    }
  }

  /**
   * Validate deployment configuration using Zod schema
   */
  validateWithZod(data: CreateDeploymentConfigRequest): {
    isValid: boolean;
    errors?: string[];
  } {
    try {
      createDeploymentConfigSchema.parse(data);
      return { isValid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.issues.map(
          (e: any) => `${e.path.join(".")}: ${e.message}`,
        );
        return { isValid: false, errors };
      }
      return { isValid: false, errors: ["Unknown validation error"] };
    }
  }

  /**
   * Validate update request using Zod schema
   */
  validateUpdateWithZod(data: UpdateDeploymentConfigRequest): {
    isValid: boolean;
    errors?: string[];
  } {
    try {
      updateDeploymentConfigSchema.parse(data);
      return { isValid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.issues.map(
          (e: any) => `${e.path.join(".")}: ${e.message}`,
        );
        return { isValid: false, errors };
      }
      return { isValid: false, errors: ["Unknown validation error"] };
    }
  }

  private validateContainerConfig(
    config: ContainerConfig,
    errors: { field: string; message: string }[],
  ): void {
    if (!config.ports || !Array.isArray(config.ports)) {
      errors.push({
        field: "containerConfig.ports",
        message: "Ports array is required",
      });
    } else {
      config.ports.forEach((port, index) => {
        if (
          !port.containerPort ||
          port.containerPort < 1 ||
          port.containerPort > 65535
        ) {
          errors.push({
            field: `containerConfig.ports[${index}].containerPort`,
            message: "Container port must be between 1 and 65535",
          });
        }
        if (port.hostPort && (port.hostPort < 1 || port.hostPort > 65535)) {
          errors.push({
            field: `containerConfig.ports[${index}].hostPort`,
            message: "Host port must be between 1 and 65535",
          });
        }
      });
    }

    if (!config.volumes || !Array.isArray(config.volumes)) {
      errors.push({
        field: "containerConfig.volumes",
        message: "Volumes array is required",
      });
    }

    if (!config.environment || !Array.isArray(config.environment)) {
      errors.push({
        field: "containerConfig.environment",
        message: "Environment variables array is required",
      });
    }

    if (!config.labels || typeof config.labels !== "object") {
      errors.push({
        field: "containerConfig.labels",
        message: "Labels object is required",
      });
    }

    if (!config.networks || !Array.isArray(config.networks)) {
      errors.push({
        field: "containerConfig.networks",
        message: "Networks array is required",
      });
    }
  }

  private validateHealthCheckConfig(
    config: HealthCheckConfig,
    errors: { field: string; message: string }[],
  ): void {
    if (!config.endpoint || config.endpoint.trim().length === 0) {
      errors.push({
        field: "healthCheckConfig.endpoint",
        message: "Health check endpoint is required",
      });
    }

    if (!config.method || !["GET", "POST"].includes(config.method)) {
      errors.push({
        field: "healthCheckConfig.method",
        message: "Method must be GET or POST",
      });
    }

    if (!config.expectedStatus || !Array.isArray(config.expectedStatus)) {
      errors.push({
        field: "healthCheckConfig.expectedStatus",
        message: "Expected status codes array is required",
      });
    }

    if (!config.timeout || config.timeout < 1000) {
      errors.push({
        field: "healthCheckConfig.timeout",
        message: "Timeout must be at least 1000ms",
      });
    }

    if (!config.retries || config.retries < 1) {
      errors.push({
        field: "healthCheckConfig.retries",
        message: "Retries must be at least 1",
      });
    }

    if (!config.interval || config.interval < 1000) {
      errors.push({
        field: "healthCheckConfig.interval",
        message: "Interval must be at least 1000ms",
      });
    }
  }


  private validateRollbackConfig(
    config: RollbackConfig,
    errors: { field: string; message: string }[],
  ): void {
    if (config.enabled === undefined) {
      errors.push({
        field: "rollbackConfig.enabled",
        message: "Rollback enabled flag is required",
      });
    }

    if (!config.maxWaitTime || config.maxWaitTime < 1000) {
      errors.push({
        field: "rollbackConfig.maxWaitTime",
        message: "Max wait time must be at least 1000ms",
      });
    }

    if (config.keepOldContainer === undefined) {
      errors.push({
        field: "rollbackConfig.keepOldContainer",
        message: "Keep old container flag is required",
      });
    }
  }

  private toConfigurationInfo(config: any): DeploymentConfigurationInfo {
    return {
      id: config.id,
      applicationName: config.applicationName,
      dockerImage: config.dockerImage,
      dockerRegistry: config.dockerRegistry,
      containerConfig: config.containerConfig as ContainerConfig,
      healthCheckConfig: config.healthCheckConfig as HealthCheckConfig,
      rollbackConfig: config.rollbackConfig as RollbackConfig,
      listeningPort: config.listeningPort,
      hostname: config.hostname,
      isActive: config.isActive,
      environmentId: config.environmentId,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  private clearCache(): void {
    this.cache.flushAll();
  }
}
