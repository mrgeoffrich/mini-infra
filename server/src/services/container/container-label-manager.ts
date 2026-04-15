import { ContainerConfig } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";

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
  environmentId?: string;

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


export interface TaskExecutionLabelOptions extends BaseContainerLabelOptions {
  taskType?: string;
  taskId?: string;
  outputCapture?: boolean;
  timeout?: number;
}

export interface DeploymentLabelOptions extends BaseContainerLabelOptions {
  // Deployment-specific options are inherited from BaseContainerLabelOptions
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
 * - Container metadata parsing and analysis utilities
 * - Cleanup decision logic based on container labels
 * - Label validation following Docker conventions
 * 
 * Primary use cases:
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

    if (options.environmentId) {
      labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.environment`] = options.environmentId;
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
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.depends_on`] = "";
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.image`] = `${projectName}_${serviceName}:latest`;
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.project.config_files`] = `config_${projectName}`;
      labels[`${ContainerLabelManager.COMPOSE_PREFIX}.project.working_dir`] = `workingdir_${projectName}`;
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
   * Generate labels for deployment containers
   */
  generateDeploymentLabels(options: DeploymentLabelOptions): Record<string, string> {
    try {
      getLogger("docker", "container-label-manager").info(
        {
          applicationName: options.applicationName,
          deploymentId: options.deploymentId,
          deploymentColor: options.deploymentColor,
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

      // Re-apply custom labels so caller-provided values (e.g. mini-infra.service
      // from stack reconciler) take precedence over compose-generated labels
      if (options.customLabels) {
        Object.assign(labels, options.customLabels);
      }

      // Add deployment tracking specific labels
      if (options.deploymentId) {
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.deployment.trackable`] = "true";
      }

      // Add container configuration metadata for deployment tracking
      if (options.containerConfig) {
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.config.ports-count`] =
          options.containerConfig.ports.length.toString();
        labels[`${ContainerLabelManager.MINI_INFRA_PREFIX}.config.volumes-count`] =
          options.containerConfig.volumes.length.toString();
      }

      getLogger("docker", "container-label-manager").debug(
        {
          applicationName: options.applicationName,
          deploymentId: options.deploymentId,
          labelsCount: Object.keys(labels).length,
        },
        "Deployment labels generated successfully"
      );

      return labels;
    } catch (error) {
      getLogger("docker", "container-label-manager").error(
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
      getLogger("docker", "container-label-manager").info(
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
        { oneoff: options.isTemporary } // Task containers are typically one-off
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

      getLogger("docker", "container-label-manager").debug(
        {
          taskType: options.taskType,
          taskId: options.taskId,
          labelsCount: Object.keys(labels).length,
        },
        "Task execution labels generated successfully"
      );

      return labels;
    } catch (error) {
      getLogger("docker", "container-label-manager").error(
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
   * Generate labels for HAProxy infrastructure containers
   */
  generateHAProxyLabels(options: {
    environmentId: string;
    projectName?: string;
    serviceName?: string;
    customLabels?: Record<string, string>;
  }): Record<string, string> {
    try {
      getLogger("docker", "container-label-manager").info(
        {
          environmentId: options.environmentId,
          projectName: options.projectName,
          serviceName: options.serviceName
        },
        "Generating HAProxy container labels"
      );

      // Start with base labels
      const labels = this.generateBaseLabels({
        environmentId: options.environmentId,
        containerPurpose: "utility",
        managed: true,
        isTemporary: false,
        isActive: true,
        customLabels: options.customLabels
      });

      // Add compose-style labels
      const composeLabels = this.generateComposeLabels(
        options.projectName,
        options.serviceName || "haproxy"
      );
      Object.assign(labels, composeLabels);

      getLogger("docker", "container-label-manager").debug(
        {
          environmentId: options.environmentId,
          labelsCount: Object.keys(labels).length
        },
        "HAProxy labels generated successfully"
      );

      return labels;
    } catch (error) {
      getLogger("docker", "container-label-manager").error(
        {
          environmentId: options.environmentId,
          error: error instanceof Error ? error.message : "Unknown error"
        },
        "Failed to generate HAProxy labels"
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
    environmentId?: string;
    projectName?: string;
    serviceName?: string;
    containerPurpose?: string;
    isActive?: boolean;
    isTemporary?: boolean;
    isTrackable?: boolean;
    createdAt?: Date;
    configMetadata?: {
      portsCount?: number;
      volumesCount?: number;
    };
  } {
    const prefix = ContainerLabelManager.MINI_INFRA_PREFIX;

    return {
      isMiniInfraManaged: labels[`${prefix}.managed`] === "true",
      applicationName: labels[`${prefix}.application`],
      deploymentId: labels[`${prefix}.deployment.id`],
      deploymentColor: labels[`${prefix}.deployment.color`] as "blue" | "green" | undefined,
      environmentId: labels[`${prefix}.environment`],
      projectName: labels[`${prefix}.project`] || labels[`${ContainerLabelManager.COMPOSE_PREFIX}.project`],
      serviceName: labels[`${prefix}.service`] || labels[`${ContainerLabelManager.COMPOSE_PREFIX}.service`],
      containerPurpose: labels[`${prefix}.purpose`],
      isActive: labels[`${prefix}.is-active`] === "true",
      isTemporary: labels[`${prefix}.temporary`] === "true",
      isTrackable: labels[`${prefix}.deployment.trackable`] === "true",
      createdAt: labels[`${prefix}.created`] ? new Date(labels[`${prefix}.created`]) : undefined,
      configMetadata: {
        portsCount: labels[`${prefix}.config.ports-count`] ? parseInt(labels[`${prefix}.config.ports-count`]) : undefined,
        volumesCount: labels[`${prefix}.config.volumes-count`] ? parseInt(labels[`${prefix}.config.volumes-count`]) : undefined,
      },
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