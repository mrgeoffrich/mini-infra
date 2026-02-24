import { z } from "zod";
import {
  CreateDeploymentConfigRequest,
  UpdateDeploymentConfigRequest,
  DeploymentConfigValidationResult,
  ContainerConfig,
  HealthCheckConfig,
  RollbackConfig,
} from "@mini-infra/types";
import {
  createDeploymentConfigSchema,
  updateDeploymentConfigSchema,
} from "./schemas";

export class ConfigValidator {
  /**
   * Validate a deployment configuration (manual field-level validation)
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

  /**
   * Validate deployment config request using Zod (throws on failure)
   */
  validateDeploymentConfigRequest(
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
}
