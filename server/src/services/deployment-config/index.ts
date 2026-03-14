import { PrismaClient } from "../../lib/prisma";
import { ConfigurationService } from "../configuration-base";
import { ContainerLifecycleManager } from "../container";
import DockerService from "../docker";
import NodeCache from "node-cache";
import { SettingsCategory } from "@mini-infra/types";
import {
  DeploymentConfigurationInfo,
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  DeploymentConfigFilter,
  DeploymentConfigSortOptions,
  DeploymentConfigValidationResult,
  ValidationResult,
  ServiceHealthStatus,
  ContainerConfig,
  HostnameValidationResult,
} from "@mini-infra/types";
import { CloudflareService } from "../cloudflare";
import { DnsCacheService } from "../dns";
import { DeploymentOrchestrator } from "../deployment-orchestrator";

import { ConfigValidator } from "./config-validator";
import { ConfigCrudOperations } from "./config-crud";
import { ConfigDeletionManager } from "./config-deletion";
import { HostnameValidator } from "./hostname-validator";
import {
  ContainerQueryService,
  toConfigurationInfo,
  toDeploymentContainerInfo,
  serializeContainerConfiguration,
} from "./mappers";

// Re-export schemas for consumers
export { createDeploymentConfigSchema, updateDeploymentConfigSchema } from "./schemas";

// Re-export sub-modules for advanced usage
export { ConfigValidator } from "./config-validator";
export { ConfigCrudOperations } from "./config-crud";
export { ConfigDeletionManager } from "./config-deletion";
export { HostnameValidator } from "./hostname-validator";
export { ContainerQueryService, toConfigurationInfo, toDeploymentContainerInfo, serializeContainerConfiguration } from "./mappers";

export class DeploymentConfigurationManager extends ConfigurationService {
  private configValidator: ConfigValidator;
  private crud: ConfigCrudOperations;
  private deletion: ConfigDeletionManager;
  private hostnameValidator: HostnameValidator;
  private containerQueryService: ContainerQueryService;

  constructor(prismaInstance: PrismaClient, encryptionKey?: string) {
    super(prismaInstance, "deployments" as SettingsCategory);

    // Initialize cache with 5 minute TTL for deployment configurations
    const cache = new NodeCache({
      stdTTL: 300, // 5 minutes
      checkperiod: 60, // check for expired keys every 60 seconds
      useClones: false,
    });

    // Initialize sub-modules
    this.configValidator = new ConfigValidator();

    this.crud = new ConfigCrudOperations(
      prismaInstance,
      cache,
      this.configValidator,
    );

    const dockerService = DockerService.getInstance();
    const containerManager = new ContainerLifecycleManager();
    const deploymentOrchestrator = new DeploymentOrchestrator();

    this.deletion = new ConfigDeletionManager(
      prismaInstance,
      dockerService,
      containerManager,
      deploymentOrchestrator,
      () => this.crud.clearCache(),
    );

    const cloudflareService = new CloudflareService(prismaInstance);
    this.hostnameValidator = new HostnameValidator(prismaInstance, cloudflareService, DnsCacheService.getInstance());

    this.containerQueryService = new ContainerQueryService(prismaInstance);
  }

  // ====================
  // ConfigurationService Implementation (stays on facade)
  // ====================

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
  // CRUD Operations (delegated)
  // ====================

  async createDeploymentConfig(
    request: CreateDeploymentConfigRequest,
  ): Promise<DeploymentConfigurationInfo> {
    return this.crud.createDeploymentConfig(request);
  }

  async updateDeploymentConfig(
    configId: string,
    request: UpdateDeploymentConfigRequest,
  ): Promise<DeploymentConfigurationInfo> {
    return this.crud.updateDeploymentConfig(configId, request);
  }

  async getDeploymentConfig(
    configId: string,
  ): Promise<DeploymentConfigurationInfo | null> {
    return this.crud.getDeploymentConfig(configId);
  }

  async getDeploymentConfigByName(
    applicationName: string,
  ): Promise<DeploymentConfigurationInfo | null> {
    return this.crud.getDeploymentConfigByName(applicationName);
  }

  async listDeploymentConfigs(
    filter?: DeploymentConfigFilter,
    sort?: DeploymentConfigSortOptions,
    limit?: number,
    offset?: number,
  ): Promise<DeploymentConfigurationInfo[]> {
    return this.crud.listDeploymentConfigs(filter, sort, limit, offset);
  }

  async setConfigurationActive(
    configId: string,
    isActive: boolean,
  ): Promise<DeploymentConfigurationInfo> {
    return this.crud.setConfigurationActive(configId, isActive);
  }

  // ====================
  // Deletion (delegated)
  // ====================

  async deleteDeploymentConfig(
    configId: string,
    triggeredBy?: string,
  ): Promise<{ removalId: string }> {
    return this.deletion.deleteDeploymentConfig(configId, triggeredBy);
  }

  // ====================
  // Hostname Validation (delegated)
  // ====================

  async validateHostname(hostname: string, excludeConfigId?: string): Promise<HostnameValidationResult> {
    return this.hostnameValidator.validateHostname(hostname, excludeConfigId);
  }

  // ====================
  // Container Queries (delegated)
  // ====================

  async getDeploymentContainers(deploymentId: string): Promise<any[]> {
    return this.containerQueryService.getDeploymentContainers(deploymentId);
  }

  async getConfigurationContainers(configurationId: string): Promise<any[]> {
    return this.containerQueryService.getConfigurationContainers(configurationId);
  }

  serializeContainerConfiguration(config: ContainerConfig): any {
    return serializeContainerConfiguration(config);
  }

  // ====================
  // Validation (delegated)
  // ====================

  validateDeploymentConfiguration(
    config: CreateDeploymentConfigRequest,
  ): DeploymentConfigValidationResult {
    return this.configValidator.validateDeploymentConfiguration(config);
  }

  validateWithZod(data: CreateDeploymentConfigRequest): {
    isValid: boolean;
    errors?: string[];
  } {
    return this.configValidator.validateWithZod(data);
  }

  validateUpdateWithZod(data: UpdateDeploymentConfigRequest): {
    isValid: boolean;
    errors?: string[];
  } {
    return this.configValidator.validateUpdateWithZod(data);
  }
}
