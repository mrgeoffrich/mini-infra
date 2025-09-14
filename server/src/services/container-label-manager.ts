import { TraefikConfig, ContainerConfig } from "@mini-infra/types";
import { servicesLogger } from "../lib/logger-factory";

// ====================
// Container Labeling Types
// ====================

export interface BaseContainerLabelOptions {
  // Core mini-infra labels
  managed?: boolean;
  createdAt?: Date;
  
  // Application/deployment context
  applicationName?: string;
  deploymentId?: string;
  deploymentColor?: "blue" | "green";
  
  // Docker Compose-style project grouping
  projectName?: string;
  serviceName?: string;
  
  // Container purpose and lifecycle
  containerPurpose?: "deployment" | "task" | "backup" | "restore" | "utility";
  isActive?: boolean;
  isTemporary?: boolean;
  
  // Custom labels
  customLabels?: Record<string, string>;
}

export interface TraefikLabelOptions extends BaseContainerLabelOptions {
  traefikConfig: TraefikConfig;
  containerConfig: ContainerConfig;
  priority?: number;
}

export interface TaskExecutionLabelOptions extends BaseContainerLabelOptions {
  taskType?: string;
  taskId?: string;
  outputCapture?: boolean;
  timeout?: number;
}

export interface DeploymentLabelOptions extends BaseContainerLabelOptions {
  // Deployment-specific options are inherited from BaseContainerLabelOptions
  traefikConfig?: TraefikConfig;
  containerConfig?: ContainerConfig;
}

// ====================
// Container Label Manager
// ====================

/**
 * ContainerLabelManager - Centralized container labeling and metadata management
 * 
 * This service provides a unified, consistent labeling scheme for all Docker containers
 * created by the mini-infra application, ensuring proper identification, categorization,
 * and lifecycle management across different container types and purposes.
 * 
 * Key characteristics:
 * - Standardized label schema across all container types
 * - Purpose-specific label generators for different use cases
 * - Docker Compose-style compatibility for project grouping
 * - Traefik integration labels for routing and load balancing
 * - Container metadata parsing and analysis utilities
 * - Cleanup decision logic based on container labels
 * - Label validation following Docker conventions
 * 
 * Primary use cases:
 * - Generating deployment container labels with Traefik configuration
 * - Creating task execution labels for backup/restore operations
 * - Adding consistent base labels to all mini-infra managed containers
 * - Parsing container metadata from existing labels
 * - Determining container cleanup eligibility
 * - Validating label key formats and conventions
 * 
 * Label categories managed:
 * - Core mini-infra identification (managed, created, version)
 * - Application context (app name, deployment ID, color)
 * - Container purpose (deployment, task, backup, restore, utility)
 * - Docker Compose compatibility (project, service, config hash)
 * - Traefik routing configuration (routers, services, priorities)
 * - Lifecycle metadata (active status, temporary flag, cleanup markers)
 * 
 * Do NOT use for:
 * - Runtime container modification (Docker labels are immutable after creation)
 * - Storing large amounts of data (labels have size limitations)
 * - Sensitive information (labels are visible in container metadata)
 */
export class ContainerLabelManager {
  private static readonly MINI_INFRA_PREFIX = "mini-infra";
  private static readonly COMPOSE_PREFIX = "com.docker.compose";
  private static readonly TRAEFIK_PREFIX = "traefik";
  
  // ====================
  // Core Label Generation
  // ====================
  
  /**
   * Generate base labels that should be present on all mini-infra managed containers
   */
  generateBaseLabels(options: BaseContainerLabelOptions = {}): Record<string, string> {
    const labels: Record<string, string> = {
      // Core mini-infra identification
      [`${ContainerLabelManager.MINI_INFRA_PREFIX}.managed`]: (options.managed !== false).toString(),
      [`${ContainerLabelManager.MINI_INFRA_PREFIX}.created`]: (options.createdAt || new Date()).toISOString(),
      [`${ContainerLabelManager.MINI_INFRA_PREFIX}.version`]: "1.0", // Version of labeling scheme
    };

    // Application context
    if (options.applicationName) {
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.application`] = options.applicationName;
    }

    if (options.deploymentId) {
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.deployment.id`] = options.deploymentId;
    }

    if (options.deploymentColor) {
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.deployment.color`] = options.deploymentColor;
    }

    // Container purpose and lifecycle
    if (options.containerPurpose) {
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.purpose`] = options.containerPurpose;
    }

    if (options.isActive !== undefined) {
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.is-active`] = options.isActive.toString();
    }

    if (options.isTemporary !== undefined) {
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.temporary`] = options.isTemporary.toString();
    }

    // Add custom labels
    if (options.customLabels) {
      Object.assign(labels, options.customLabels);
    }

    return labels;
  }

  /**
   * Generate Docker Compose-style labels for project and service grouping
   */
  generateComposeLabels(
    projectName?: string,
    serviceName?: string,
    additionalOptions?: {
      containerNumber?: number;
      oneoff?: boolean;
      version?: string;
    }
  ): Record<string, string> {
    const labels: Record<string, string> = {};

    if (projectName) {
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.project`] = projectName;
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.project`] = projectName;
      
      // Generate config hash for compose compatibility
      const configHash = this.generateConfigHash(projectName);
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.config-hash`] = configHash;
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.container-number`] = (additionalOptions?.containerNumber || 1).toString();
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.oneoff`] = (additionalOptions?.oneoff || false).toString();
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.version`] = additionalOptions?.version || "2.32.4";
    }

    if (serviceName) {
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.service`] = serviceName;
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.service`] = serviceName;
    }

    return labels;
  }

  // ====================
  // Specialized Label Generators
  // ====================

  /**
   * Generate labels for deployment containers with Traefik configuration
   */
  generateDeploymentLabels(options: DeploymentLabelOptions): Record<string, string> {
    try {
      servicesLogger().info(
        {
          applicationName: options.applicationName,
          deploymentId: options.deploymentId,
          deploymentColor: options.deploymentColor,
          hasTraefik: !!options.traefikConfig,
        },
        "Generating deployment container labels"
      );

      // Start with base labels
      const labels = this.generateBaseLabels({
        ...options,
        containerPurpose: "deployment",
        managed: true,
      });

      // Add compose-style labels
      const composeLabels = this.generateComposeLabels(
        options.projectName,
        options.serviceName
      );
      Object.assign(labels, composeLabels);

      // Add Traefik labels if configuration is provided
      if (options.traefikConfig && options.containerConfig) {
        const traefikLabels = this.generateTraefikLabels({
          ...options,
          traefikConfig: options.traefikConfig,
          containerConfig: options.containerConfig,
        });
        Object.assign(labels, traefikLabels);
      }

      servicesLogger().debug(
        {
          applicationName: options.applicationName,
          deploymentId: options.deploymentId,
          labelsCount: Object.keys(labels).length,
        },
        "Deployment labels generated successfully"
      );

      return labels;
    } catch (error) {
      servicesLogger().error(
        {
          applicationName: options.applicationName,
          deploymentId: options.deploymentId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to generate deployment labels"
      );
      throw error;
    }
  }

  /**
   * Generate labels for task execution containers (backup, restore, utility tasks)
   */
  generateTaskExecutionLabels(options: TaskExecutionLabelOptions): Record<string, string> {
    try {
      servicesLogger().info(
        {
          taskType: options.taskType,
          taskId: options.taskId,
          projectName: options.projectName,
          serviceName: options.serviceName,
        },
        "Generating task execution container labels"
      );

      // Start with base labels
      const labels = this.generateBaseLabels({
        ...options,
        containerPurpose: options.containerPurpose || "task",
        managed: true,
        isTemporary: options.isTemporary !== false, // Default to temporary for tasks
      });

      // Add compose-style labels for project grouping
      const composeLabels = this.generateComposeLabels(
        options.projectName,
        options.serviceName,
        { oneoff: true } // Task containers are typically one-off
      );
      Object.assign(labels, composeLabels);

      // Add task-specific labels
      if (options.taskType) {
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.task.type`] = options.taskType;
      }

      if (options.taskId) {
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.task.id`] = options.taskId;
      }

      if (options.outputCapture !== undefined) {
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.task.output-capture`] = options.outputCapture.toString();
      }

      if (options.timeout) {
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.task.timeout`] = options.timeout.toString();
      }

      servicesLogger().debug(
        {
          taskType: options.taskType,
          taskId: options.taskId,
          labelsCount: Object.keys(labels).length,
        },
        "Task execution labels generated successfully"
      );

      return labels;
    } catch (error) {
      servicesLogger().error(
        {
          taskType: options.taskType,
          taskId: options.taskId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to generate task execution labels"
      );
      throw error;
    }
  }

  /**
   * Generate Traefik labels for container routing configuration
   */
  generateTraefikLabels(options: TraefikLabelOptions): Record<string, string> {
    try {
      const { traefikConfig, containerConfig, deploymentColor, isActive } = options;
      
      servicesLogger().info(
        {
          routerName: traefikConfig.routerName,
          serviceName: traefikConfig.serviceName,
          deploymentColor,
          isActive,
        },
        "Generating Traefik labels for container routing"
      );

      const labels: Record<string, string> = {};
      
      // Determine router and service names (add color suffix for blue-green deployment)
      const routerName = deploymentColor 
        ? `${traefikConfig.routerName}-${deploymentColor}`
        : traefikConfig.routerName;
      const serviceName = deploymentColor
        ? `${traefikConfig.serviceName}-${deploymentColor}`
        : traefikConfig.serviceName;

      // Enable Traefik
      labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.enable`] = "true";

      // Router configuration
      labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.http.routers.${routerName}.rule`] = traefikConfig.rule;
      labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.http.routers.${routerName}.service`] = serviceName;

      // Set priority
      const priority = this.calculateTraefikPriority(traefikConfig.rule, isActive, options.priority);
      labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.http.routers.${routerName}.priority`] = priority.toString();

      // TLS configuration
      if (traefikConfig.tls) {
        labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.http.routers.${routerName}.tls`] = "true";
      }

      // Middlewares
      if (traefikConfig.middlewares && traefikConfig.middlewares.length > 0) {
        labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.http.routers.${routerName}.middlewares`] = 
          traefikConfig.middlewares.join(",");
      }

      // Service configuration - use first port from container config
      if (containerConfig.ports.length > 0) {
        const port = containerConfig.ports[0];
        labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.http.services.${serviceName}.loadbalancer.server.port`] = 
          port.containerPort.toString();

        // Set protocol if specified
        if (port.protocol && port.protocol !== "tcp") {
          labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.http.services.${serviceName}.loadbalancer.server.scheme`] = 
            port.protocol === "udp" ? "udp" : "http";
        }
      }

      // Add Traefik-specific mini-infra labels
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.traefik.router-name`] = routerName;
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.traefik.service-name`] = serviceName;
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.traefik.generated-at`] = new Date().toISOString();

      if (deploymentColor) {
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.traefik.deployment-color`] = deploymentColor;
      }

      if (isActive !== undefined) {
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.traefik.is-active`] = isActive.toString();
      }

      servicesLogger().debug(
        {
          routerName,
          serviceName,
          priority,
          labelsCount: Object.keys(labels).length,
        },
        "Traefik labels generated successfully"
      );

      return labels;
    } catch (error) {
      servicesLogger().error(
        {
          routerName: options.traefikConfig.routerName,
          serviceName: options.traefikConfig.serviceName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to generate Traefik labels"
      );
      throw error;
    }
  }

  // ====================
  // Label Parsing and Analysis
  // ====================

  /**
   * Parse container labels to extract mini-infra metadata
   */
  parseContainerLabels(labels: Record<string, string>): {
    isMiniInfraManaged: boolean;
    applicationName?: string;
    deploymentId?: string;
    deploymentColor?: "blue" | "green";
    projectName?: string;
    serviceName?: string;
    containerPurpose?: string;
    isActive?: boolean;
    isTemporary?: boolean;
    traefikEnabled: boolean;
    createdAt?: Date;
  } {
    const prefix = ContainerLabelManager.MINI_INFRA_PREFIX;
    
    return {
      isMiniInfraManaged: labels[`${prefix}.managed`] === "true",
      applicationName: labels[`${prefix}.application`],
      deploymentId: labels[`${prefix}.deployment.id`],
      deploymentColor: labels[`${prefix}.deployment.color`] as "blue" | "green" | undefined,
      projectName: labels[`${prefix}.project`] || labels[`${ContainerLabelManager.COMPOSE_PREFIX}.project`],
      serviceName: labels[`${prefix}.service`] || labels[`${ContainerLabelManager.COMPOSE_PREFIX}.service`],
      containerPurpose: labels[`${prefix}.purpose`],
      isActive: labels[`${prefix}.is-active`] === "true",
      isTemporary: labels[`${prefix}.temporary`] === "true",
      traefikEnabled: labels[`${ContainerLabelManager.TRAEFIK_PREFIX}.enable`] === "true",
      createdAt: labels[`${prefix}.created`] ? new Date(labels[`${prefix}.created`]) : undefined,
    };
  }

  /**
   * Check if container labels indicate it should be cleaned up
   */
  shouldCleanupContainer(
    labels: Record<string, string>,
    maxAgeHours: number = 24
  ): { shouldCleanup: boolean; reason?: string } {
    const parsed = this.parseContainerLabels(labels);

    // Only cleanup mini-infra managed containers
    if (!parsed.isMiniInfraManaged) {
      return { shouldCleanup: false };
    }

    // Check for explicit cleanup marker
    if (labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.cleanup`] === "true") {
      return { shouldCleanup: true, reason: "Container marked for cleanup" };
    }

    // Check age for temporary containers
    if (parsed.isTemporary && parsed.createdAt) {
      const ageHours = (Date.now() - parsed.createdAt.getTime()) / (1000 * 60 * 60);
      if (ageHours > maxAgeHours) {
        return { 
          shouldCleanup: true, 
          reason: `Temporary container older than ${maxAgeHours} hours` 
        };
      }
    }

    return { shouldCleanup: false };
  }

  // ====================
  // Utility Methods
  // ====================

  /**
   * Generate a simple configuration hash for Docker Compose compatibility
   */
  private generateConfigHash(projectName: string): string {
    const configString = `${projectName}-${Date.now()}`;
    return Buffer.from(configString).toString('base64').substring(0, 12);
  }

  /**
   * Calculate Traefik router priority based on rule complexity and deployment state
   */
  private calculateTraefikPriority(
    rule: string,
    isActive?: boolean,
    basePriority?: number
  ): number {
    let priority = basePriority || 100;

    // Active containers get higher priority
    if (isActive) {
      priority += 10;
    }

    // Calculate rule complexity bonus
    let complexity = 0;
    if (rule.includes("Host(")) complexity += 1;
    if (rule.includes("PathPrefix(")) complexity += 2;
    if (rule.includes("Path(")) complexity += 3;
    if (rule.includes("Method(")) complexity += 1;
    if (rule.includes("Headers(")) complexity += 2;

    // Count logical operators
    complexity += (rule.match(/&&/g) || []).length * 2;
    complexity += (rule.match(/\|\|/g) || []).length * 1;

    priority += Math.min(complexity, 20);

    return priority;
  }

  /**
   * Merge multiple label sets with conflict resolution
   */
  mergeLabels(...labelSets: Record<string, string>[]): Record<string, string> {
    const merged: Record<string, string> = {};
    
    for (const labelSet of labelSets) {
      Object.assign(merged, labelSet);
    }

    return merged;
  }

  /**
   * Validate label keys to ensure they follow Docker label conventions
   */
  validateLabelKeys(labels: Record<string, string>): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];
    
    for (const key of Object.keys(labels)) {
      // Check key format (RFC 1123 subdomain)
      if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9.-]*[a-z0-9])?)*$/.test(key)) {
        errors.push(`Invalid label key format: ${key}`);
      }

      // Check key length
      if (key.length > 253) {
        errors.push(`Label key too long: ${key} (max 253 characters)`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

export default ContainerLabelManager;