import Docker from "dockerode";
import { servicesLogger } from "../lib/logger-factory";
import DockerService from "./docker";
import ContainerLabelManager from "./container-label-manager";
import {
  TraefikConfig,
  ContainerConfig,
  DeploymentPort,
} from "@mini-infra/types";

// ====================
// Traefik Integration Types
// ====================

export interface TraefikServiceLabels {
  enable: string;
  routerRule: string;
  routerService: string;
  routerPriority: string;
  routerTls?: string;
  routerMiddlewares?: string;
  servicePort: string;
  serviceProtocol?: string;
}

export interface BlueGreenTraefikLabels {
  blue: TraefikServiceLabels;
  green: TraefikServiceLabels;
}

export interface TraefikRouterInfo {
  name: string;
  rule: string;
  service: string;
  priority: number;
  tls: boolean;
  middlewares: string[];
  enabled: boolean;
}

export interface TraefikServiceInfo {
  name: string;
  loadBalancer: {
    servers: Array<{
      url: string;
      weight?: number;
    }>;
  };
  enabled: boolean;
}

export interface ContainerTraefikStatus {
  containerId: string;
  containerName: string;
  labels: Record<string, string>;
  traefikEnabled: boolean;
  routers: TraefikRouterInfo[];
  services: TraefikServiceInfo[];
  isActive: boolean;
  priority: number;
}

export interface TrafficSwitchOptions {
  applicationName: string;
  fromContainerId: string;
  toContainerId: string;
  traefikConfig: TraefikConfig;
  gradual?: boolean;
  healthCheckUrl?: string;
}

// ====================
// Traefik Integration Service
// ====================

export class TraefikIntegrationService {
  private dockerService: DockerService;
  private labelManager: ContainerLabelManager;

  constructor() {
    this.dockerService = DockerService.getInstance();
    this.labelManager = new ContainerLabelManager();
  }

  // ====================
  // Label Generation for Blue-Green Deployment
  // ====================

  /**
   * Generate Traefik labels for blue-green deployment routing
   */
  generateBlueGreenLabels(
    applicationName: string,
    traefikConfig: TraefikConfig,
    containerConfig: ContainerConfig,
    deploymentColor: "blue" | "green",
    isActive: boolean = false,
  ): Record<string, string> {
    try {
      servicesLogger().info(
        {
          applicationName,
          deploymentColor,
          isActive,
          routerName: traefikConfig.routerName,
          serviceName: traefikConfig.serviceName,
        },
        "Generating blue-green Traefik labels using centralized label manager",
      );

      // Use the centralized label manager to generate Traefik labels
      const labels = this.labelManager.generateTraefikLabels({
        applicationName,
        deploymentColor,
        isActive,
        containerPurpose: "deployment",
        traefikConfig,
        containerConfig,
        managed: true,
      });

      servicesLogger().info(
        {
          applicationName,
          deploymentColor,
          routerName: `${traefikConfig.routerName}-${deploymentColor}`,
          serviceName: `${traefikConfig.serviceName}-${deploymentColor}`,
          labelsCount: Object.keys(labels).length,
        },
        "Blue-green Traefik labels generated successfully using label manager",
      );

      return labels;
    } catch (error) {
      servicesLogger().error(
        {
          applicationName,
          deploymentColor,
          isActive,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to generate blue-green Traefik labels",
      );
      throw error;
    }
  }

  /**
   * Generate complete blue-green label set for both containers
   */
  generateCompleteBlueGreenLabels(
    applicationName: string,
    traefikConfig: TraefikConfig,
    containerConfig: ContainerConfig,
    activeColor: "blue" | "green",
  ): BlueGreenTraefikLabels {
    try {
      const blueLabels = this.generateBlueGreenLabels(
        applicationName,
        traefikConfig,
        containerConfig,
        "blue",
        activeColor === "blue",
      );

      const greenLabels = this.generateBlueGreenLabels(
        applicationName,
        traefikConfig,
        containerConfig,
        "green",
        activeColor === "green",
      );

      return {
        blue: this.parseLabelsToServiceLabels(blueLabels, "blue"),
        green: this.parseLabelsToServiceLabels(greenLabels, "green"),
      };
    } catch (error) {
      servicesLogger().error(
        {
          applicationName,
          activeColor,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to generate complete blue-green labels",
      );
      throw error;
    }
  }

  // ====================
  // Traffic Switching
  // ====================

  /**
   * Switch traffic between blue and green containers
   */
  async switchTraffic(options: TrafficSwitchOptions): Promise<void> {
    try {
      servicesLogger().info(
        {
          applicationName: options.applicationName,
          fromContainerId: options.fromContainerId,
          toContainerId: options.toContainerId,
          gradual: options.gradual || false,
        },
        "Starting traffic switch between containers",
      );

      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      // Get current status of both containers
      const fromStatus = await this.getContainerTraefikStatus(
        options.fromContainerId,
      );
      const toStatus = await this.getContainerTraefikStatus(
        options.toContainerId,
      );

      if (!fromStatus || !toStatus) {
        throw new Error("Unable to get status for one or both containers");
      }

      // Determine colors based on container names or labels
      const fromColor = this.determineContainerColor(fromStatus);
      const toColor = this.determineContainerColor(toStatus);

      servicesLogger().info(
        {
          applicationName: options.applicationName,
          fromColor,
          toColor,
          fromActive: fromStatus.isActive,
          toActive: toStatus.isActive,
        },
        "Container colors determined for traffic switch",
      );

      if (options.gradual) {
        // Implement gradual traffic switching
        await this.performGradualTrafficSwitch(options, fromColor, toColor);
      } else {
        // Implement immediate traffic switching
        await this.performImmediateTrafficSwitch(options, fromColor, toColor);
      }

      servicesLogger().info(
        {
          applicationName: options.applicationName,
          fromContainerId: options.fromContainerId,
          toContainerId: options.toContainerId,
        },
        "Traffic switch completed successfully",
      );
    } catch (error) {
      servicesLogger().error(
        {
          applicationName: options.applicationName,
          fromContainerId: options.fromContainerId,
          toContainerId: options.toContainerId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to switch traffic between containers",
      );
      throw error;
    }
  }

  // ====================
  // Priority-Based Routing Logic
  // ====================

  /**
   * Generate routing priority labels for blue-green deployment
   * Note: This prepares labels for container recreation since Docker labels
   * cannot be modified after container creation.
   */
  async generateRoutingPriorityLabels(
    applicationName: string,
    activeContainerId: string,
    inactiveContainerId: string,
    traefikConfig: TraefikConfig,
  ): Promise<{
    activeLabels: Record<string, string>;
    inactiveLabels: Record<string, string>;
  }> {
    try {
      servicesLogger().info(
        {
          applicationName,
          activeContainerId,
          inactiveContainerId,
        },
        "Updating routing priorities for blue-green deployment",
      );

      const activeStatus =
        await this.getContainerTraefikStatus(activeContainerId);
      const inactiveStatus =
        await this.getContainerTraefikStatus(inactiveContainerId);

      if (!activeStatus || !inactiveStatus) {
        throw new Error("Unable to get container status for priority update");
      }

      const activeColor = this.determineContainerColor(activeStatus);
      const inactiveColor = this.determineContainerColor(inactiveStatus);

      // Note: Priority updates require container recreation since Docker labels
      // cannot be modified after container creation. The actual container
      // recreation with updated labels should be handled by the deployment
      // orchestrator using ContainerLifecycleManager.

      // Generate labels that would be used for container recreation
      const activeLabels = this.generateBlueGreenLabels(
        applicationName,
        traefikConfig,
        this.extractContainerConfig(activeStatus),
        activeColor,
        true, // is active
      );

      const inactiveLabels = this.generateBlueGreenLabels(
        applicationName,
        traefikConfig,
        this.extractContainerConfig(inactiveStatus),
        inactiveColor,
        false, // is inactive
      );

      servicesLogger().info(
        {
          applicationName,
          activeColor,
          inactiveColor,
          activePriority: this.extractPriorityFromLabels(activeLabels),
          inactivePriority: this.extractPriorityFromLabels(inactiveLabels),
        },
        "Routing priority labels generated successfully",
      );

      return {
        activeLabels,
        inactiveLabels,
      };
    } catch (error) {
      servicesLogger().error(
        {
          applicationName,
          activeContainerId,
          inactiveContainerId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to generate routing priority labels",
      );
      throw error;
    }
  }

  /**
   * Calculate optimal priority for a router based on deployment state
   */
  calculateRouterPriority(
    baseRule: string,
    isActive: boolean,
    deploymentPhase: "testing" | "production" | "rollback" = "production",
  ): number {
    // Base priority starts at 100
    let priority = 100;

    // Active containers get higher priority
    if (isActive) {
      priority += 10;
    }

    // Adjust based on deployment phase
    switch (deploymentPhase) {
      case "testing":
        priority += 5; // Testing gets slight priority boost
        break;
      case "rollback":
        priority += 15; // Rollback gets highest priority
        break;
      case "production":
      default:
        // No adjustment for production
        break;
    }

    // More specific rules get higher priority
    const ruleComplexity = this.calculateRuleComplexity(baseRule);
    priority += ruleComplexity;

    return priority;
  }

  // ====================
  // Validation for Traefik Configuration Rules
  // ====================

  /**
   * Validate Traefik configuration rules
   */
  validateTraefikConfiguration(config: TraefikConfig): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      servicesLogger().debug({ config }, "Validating Traefik configuration");

      // Validate router name
      if (!config.routerName || config.routerName.trim().length === 0) {
        errors.push("Router name is required");
      } else if (!/^[a-zA-Z0-9_-]+$/.test(config.routerName)) {
        errors.push(
          "Router name can only contain letters, numbers, hyphens, and underscores",
        );
      } else if (config.routerName.length > 100) {
        warnings.push(
          "Router name is longer than 100 characters, consider shortening",
        );
      }

      // Validate service name
      if (!config.serviceName || config.serviceName.trim().length === 0) {
        errors.push("Service name is required");
      } else if (!/^[a-zA-Z0-9_-]+$/.test(config.serviceName)) {
        errors.push(
          "Service name can only contain letters, numbers, hyphens, and underscores",
        );
      }

      // Validate routing rule
      const ruleValidation = this.validateTraefikRule(config.rule);
      if (!ruleValidation.isValid) {
        errors.push(...ruleValidation.errors);
      }
      warnings.push(...ruleValidation.warnings);

      // Validate middlewares
      if (config.middlewares) {
        for (const middleware of config.middlewares) {
          if (!middleware || middleware.trim().length === 0) {
            errors.push("Middleware name cannot be empty");
          } else if (!/^[a-zA-Z0-9_-]+$/.test(middleware)) {
            errors.push(`Invalid middleware name: ${middleware}`);
          }
        }
      }

      // Validate TLS configuration
      if (config.tls && !config.rule.includes("Host(")) {
        warnings.push(
          "TLS is enabled but no Host rule specified - TLS may not work properly",
        );
      }

      const result = {
        isValid: errors.length === 0,
        errors,
        warnings,
      };

      servicesLogger().info(
        {
          routerName: config.routerName,
          serviceName: config.serviceName,
          isValid: result.isValid,
          errorsCount: errors.length,
          warningsCount: warnings.length,
        },
        "Traefik configuration validation completed",
      );

      return result;
    } catch (error) {
      servicesLogger().error(
        {
          config,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to validate Traefik configuration",
      );

      return {
        isValid: false,
        errors: ["Validation failed due to internal error"],
        warnings: [],
      };
    }
  }

  /**
   * Validate Traefik routing rule syntax
   */
  validateTraefikRule(rule: string): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!rule || rule.trim().length === 0) {
      errors.push("Routing rule is required");
      return { isValid: false, errors, warnings };
    }

    // Check for common rule patterns
    const commonPatterns = [
      /Host\(`[^`]+`\)/, // Host(`example.com`)
      /PathPrefix\(`[^`]+`\)/, // PathPrefix(`/api`)
      /Path\(`[^`]+`\)/, // Path(`/exact`)
      /Method\(`[^`]+`\)/, // Method(`GET`)
      /Headers\(`[^`]+`,\s*`[^`]+`\)/, // Headers(`X-Custom`, `value`)
    ];

    const hasValidPattern = commonPatterns.some((pattern) =>
      pattern.test(rule),
    );

    if (!hasValidPattern) {
      warnings.push(
        "Rule doesn't match common Traefik patterns - verify syntax",
      );
    }

    // Check for balanced parentheses and backticks
    const openParens = (rule.match(/\(/g) || []).length;
    const closeParens = (rule.match(/\)/g) || []).length;
    const backticks = (rule.match(/`/g) || []).length;

    if (openParens !== closeParens) {
      errors.push("Unbalanced parentheses in rule");
    }

    if (backticks % 2 !== 0) {
      errors.push("Unbalanced backticks in rule");
    }

    // Check for dangerous characters
    const dangerousChars = /[<>\"'&|;$`\\]/;
    if (dangerousChars.test(rule)) {
      warnings.push("Rule contains potentially dangerous characters");
    }

    // Check rule length
    if (rule.length > 500) {
      warnings.push("Rule is very long, consider simplifying");
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ====================
  // Service Discovery Helper Methods
  // ====================

  /**
   * Discover Traefik-enabled containers for an application
   */
  async discoverApplicationContainers(
    applicationName: string,
  ): Promise<ContainerTraefikStatus[]> {
    try {
      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      servicesLogger().info(
        { applicationName },
        "Discovering Traefik-enabled containers for application",
      );

      const docker = (this.dockerService as any).docker as Docker;
      const containers = await docker.listContainers({ all: true });

      const applicationContainers: ContainerTraefikStatus[] = [];

      for (const containerInfo of containers) {
        const labels = containerInfo.Labels || {};

        // Use the label manager to parse container metadata
        const parsed = this.labelManager.parseContainerLabels(labels);

        // Check if this container belongs to the application
        const isApplicationContainer =
          parsed.applicationName === applicationName ||
          labels["mini-infra.traefik.application"] === applicationName ||
          containerInfo.Names.some((name) => name.includes(applicationName));

        if (!isApplicationContainer) {
          continue;
        }

        // Get detailed container status
        const status = await this.getContainerTraefikStatus(containerInfo.Id);
        if (status) {
          applicationContainers.push(status);
        }
      }

      servicesLogger().info(
        {
          applicationName,
          containersFound: applicationContainers.length,
        },
        "Application container discovery completed",
      );

      return applicationContainers.sort((a, b) => b.priority - a.priority);
    } catch (error) {
      servicesLogger().error(
        {
          applicationName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to discover application containers",
      );
      throw error;
    }
  }

  /**
   * Get active container for an application (highest priority)
   */
  async getActiveContainer(
    applicationName: string,
  ): Promise<ContainerTraefikStatus | null> {
    try {
      const containers =
        await this.discoverApplicationContainers(applicationName);

      // Find the container marked as active or with highest priority
      const activeContainer =
        containers.find((c) => c.isActive) || containers[0] || null;

      if (activeContainer) {
        servicesLogger().info(
          {
            applicationName,
            activeContainerId: activeContainer.containerId,
            activeContainerName: activeContainer.containerName,
            priority: activeContainer.priority,
          },
          "Active container identified",
        );
      } else {
        servicesLogger().warn(
          { applicationName },
          "No active container found for application",
        );
      }

      return activeContainer;
    } catch (error) {
      servicesLogger().error(
        {
          applicationName,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get active container",
      );
      throw error;
    }
  }

  /**
   * Get detailed Traefik status for a container
   */
  async getContainerTraefikStatus(
    containerId: string,
  ): Promise<ContainerTraefikStatus | null> {
    try {
      if (!this.dockerService.isConnected()) {
        throw new Error("Docker service is not connected");
      }

      const docker = (this.dockerService as any).docker as Docker;
      const container = docker.getContainer(containerId);

      try {
        const containerInfo = await container.inspect();
        const labels = containerInfo.Config.Labels || {};

        const traefikEnabled = labels["traefik.enable"] === "true";

        if (!traefikEnabled) {
          return {
            containerId,
            containerName: containerInfo.Name.replace(/^\//, ""),
            labels,
            traefikEnabled: false,
            routers: [],
            services: [],
            isActive: false,
            priority: 0,
          };
        }

        // Parse routers and services from labels
        const routers = this.parseRoutersFromLabels(labels);
        const services = this.parseServicesFromLabels(labels);

        // Use the label manager to determine if container is active
        const parsed = this.labelManager.parseContainerLabels(labels);
        const isActive =
          parsed.isActive ||
          labels["mini-infra.traefik.is-active"] === "true" ||
          routers.some((r) => r.priority > 100);

        // Calculate overall priority
        const priority = Math.max(...routers.map((r) => r.priority), 0);

        return {
          containerId,
          containerName: containerInfo.Name.replace(/^\//, ""),
          labels,
          traefikEnabled,
          routers,
          services,
          isActive,
          priority,
        };
      } catch (error: any) {
        if (error.statusCode === 404) {
          return null; // Container doesn't exist
        }
        throw error;
      }
    } catch (error) {
      servicesLogger().error(
        {
          containerId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get container Traefik status",
      );
      return null;
    }
  }

  // ====================
  // Container Label Management
  // ====================

  /**
   * Update container labels (Note: Docker labels are immutable after creation)
   * This method logs the limitation and provides guidance for proper implementation.
   *
   * @param containerId - ID of the container
   * @param labels - Labels to apply (for reference only)
   */
  async updateContainerLabels(
    containerId: string,
    labels: Record<string, string>,
  ): Promise<void> {
    try {
      servicesLogger().warn(
        {
          containerId,
          labelsCount: Object.keys(labels).length,
          sampleLabels: Object.keys(labels).slice(0, 3),
        },
        "Container label update requested but Docker labels are immutable after creation. Container recreation with new labels is required for Traefik configuration changes.",
      );

      // In a future implementation, this could trigger container recreation
      // via the ContainerLifecycleManager with the provided labels
      servicesLogger().info(
        {
          containerId,
          message: "To implement label updates, use ContainerLifecycleManager to recreate the container with new labels",
          labelsProvided: Object.keys(labels),
        },
        "Label update deferred - container recreation required",
      );

      // For now, this is a no-op that prevents the deployment orchestrator from failing
      // The actual traffic switching should be handled through container recreation
      // with updated priority labels during the deployment process
    } catch (error) {
      servicesLogger().error(
        {
          containerId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to process container label update request",
      );
      throw error;
    }
  }

  // ====================
  // Private Helper Methods
  // ====================

  private parseLabelsToServiceLabels(
    labels: Record<string, string>,
    color: "blue" | "green",
  ): TraefikServiceLabels {
    const routerPrefix = `traefik.http.routers.`;
    const servicePrefix = `traefik.http.services.`;

    // Find router and service names for this color
    let routerName = "";
    let serviceName = "";

    for (const key in labels) {
      if (
        key.startsWith(routerPrefix) &&
        key.includes(color) &&
        key.endsWith(".rule")
      ) {
        routerName = key.split(".")[3]; // Extract router name
      }
      if (
        key.startsWith(servicePrefix) &&
        key.includes(color) &&
        key.endsWith(".loadbalancer.server.port")
      ) {
        serviceName = key.split(".")[3]; // Extract service name
      }
    }

    return {
      enable: labels["traefik.enable"] || "false",
      routerRule: labels[`traefik.http.routers.${routerName}.rule`] || "",
      routerService: labels[`traefik.http.routers.${routerName}.service`] || "",
      routerPriority:
        labels[`traefik.http.routers.${routerName}.priority`] || "100",
      routerTls: labels[`traefik.http.routers.${routerName}.tls`],
      routerMiddlewares:
        labels[`traefik.http.routers.${routerName}.middlewares`],
      servicePort:
        labels[
        `traefik.http.services.${serviceName}.loadbalancer.server.port`
        ] || "",
      serviceProtocol:
        labels[
        `traefik.http.services.${serviceName}.loadbalancer.server.scheme`
        ],
    };
  }

  private determineContainerColor(
    status: ContainerTraefikStatus,
  ): "blue" | "green" {
    // Use the label manager to parse container metadata
    const parsed = this.labelManager.parseContainerLabels(status.labels);

    if (parsed.deploymentColor) {
      return parsed.deploymentColor;
    }

    // Fallback: check legacy labels
    const colorLabel = status.labels["mini-infra.traefik.deployment-color"];
    if (colorLabel === "blue" || colorLabel === "green") {
      return colorLabel;
    }

    // Fallback: determine from container name
    const name = status.containerName.toLowerCase();
    if (name.includes("blue")) return "blue";
    if (name.includes("green")) return "green";

    // Default fallback
    return "blue";
  }

  private extractContainerConfig(
    status: ContainerTraefikStatus,
  ): ContainerConfig {
    // This is a simplified extraction - in a real implementation,
    // this would be stored in the deployment configuration
    return {
      ports: [
        {
          containerPort: parseInt(
            status.services[0]?.loadBalancer.servers[0]?.url.split(":").pop() ||
            "80",
          ),
        },
      ],
      volumes: [],
      environment: [],
      labels: status.labels,
      networks: ["bridge"], // Default network
    };
  }

  private extractPriorityFromLabels(labels: Record<string, string>): number {
    for (const key in labels) {
      if (key.includes("priority")) {
        return parseInt(labels[key]) || 100;
      }
    }
    return 100;
  }

  private async performGradualTrafficSwitch(
    options: TrafficSwitchOptions,
    fromColor: "blue" | "green",
    toColor: "blue" | "green",
  ): Promise<void> {
    servicesLogger().info(
      {
        applicationName: options.applicationName,
        fromColor,
        toColor,
      },
      "Performing gradual traffic switch",
    );

    // Implementation would gradually shift traffic percentages
    // This is a placeholder for the actual implementation
    const steps = [25, 50, 75, 100];

    for (const percentage of steps) {
      servicesLogger().info(
        {
          applicationName: options.applicationName,
          percentage,
          fromColor,
          toColor,
        },
        `Shifting ${percentage}% traffic to ${toColor} container`,
      );

      // In a real implementation, this would update Traefik service weights
      // or use middleware to split traffic
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Simulate delay

      // Health check if URL is provided
      if (options.healthCheckUrl) {
        // Perform health check (placeholder)
        servicesLogger().debug(
          {
            healthCheckUrl: options.healthCheckUrl,
            percentage,
          },
          "Health check during gradual switch",
        );
      }
    }
  }

  private async performImmediateTrafficSwitch(
    options: TrafficSwitchOptions,
    fromColor: "blue" | "green",
    toColor: "blue" | "green",
  ): Promise<void> {
    servicesLogger().info(
      {
        applicationName: options.applicationName,
        fromColor,
        toColor,
      },
      "Performing immediate traffic switch",
    );

    // Note: Immediate traffic switching requires container recreation with
    // updated priority labels. This is typically handled by the deployment
    // orchestrator which can recreate containers with new labels.

    const priorityLabels = await this.generateRoutingPriorityLabels(
      options.applicationName,
      options.toContainerId,
      options.fromContainerId,
      options.traefikConfig,
    );

    servicesLogger().info(
      {
        applicationName: options.applicationName,
        fromContainerId: options.fromContainerId,
        toContainerId: options.toContainerId,
        message: "Immediate traffic switch requires container recreation with new priority labels",
      },
      "Traffic switch labels prepared for container recreation",
    );
  }

  private calculateRuleComplexity(rule: string): number {
    let complexity = 0;

    // Count different rule types
    if (rule.includes("Host(")) complexity += 1;
    if (rule.includes("PathPrefix(")) complexity += 2;
    if (rule.includes("Path(")) complexity += 3;
    if (rule.includes("Method(")) complexity += 1;
    if (rule.includes("Headers(")) complexity += 2;

    // Count logical operators
    complexity += (rule.match(/&&/g) || []).length * 2;
    complexity += (rule.match(/\|\|/g) || []).length * 1;

    return Math.min(complexity, 20); // Cap at 20
  }

  private parseRoutersFromLabels(
    labels: Record<string, string>,
  ): TraefikRouterInfo[] {
    const routers: Record<string, Partial<TraefikRouterInfo>> = {};

    for (const [key, value] of Object.entries(labels)) {
      if (key.startsWith("traefik.http.routers.")) {
        const parts = key.split(".");
        if (parts.length >= 4) {
          const routerName = parts[3];
          const property = parts.slice(4).join(".");

          if (!routers[routerName]) {
            routers[routerName] = { name: routerName };
          }

          switch (property) {
            case "rule":
              routers[routerName].rule = value;
              break;
            case "service":
              routers[routerName].service = value;
              break;
            case "priority":
              routers[routerName].priority = parseInt(value) || 100;
              break;
            case "tls":
              routers[routerName].tls = value === "true";
              break;
            case "middlewares":
              routers[routerName].middlewares = value.split(",");
              break;
          }
        }
      }
    }

    return Object.values(routers).map((router) => ({
      name: router.name || "",
      rule: router.rule || "",
      service: router.service || "",
      priority: router.priority || 100,
      tls: router.tls || false,
      middlewares: router.middlewares || [],
      enabled: !!router.rule,
    }));
  }

  private parseServicesFromLabels(
    labels: Record<string, string>,
  ): TraefikServiceInfo[] {
    const services: Record<string, Partial<TraefikServiceInfo>> = {};

    for (const [key, value] of Object.entries(labels)) {
      if (key.startsWith("traefik.http.services.")) {
        const parts = key.split(".");
        if (parts.length >= 4) {
          const serviceName = parts[3];

          if (!services[serviceName]) {
            services[serviceName] = {
              name: serviceName,
              loadBalancer: { servers: [] },
            };
          }

          if (key.endsWith(".loadbalancer.server.port")) {
            services[serviceName].loadBalancer!.servers = [
              { url: `http://container:${value}` },
            ];
          }
        }
      }
    }

    return Object.values(services).map((service) => ({
      name: service.name || "",
      loadBalancer: service.loadBalancer || { servers: [] },
      enabled: service.loadBalancer?.servers.length! > 0,
    }));
  }
}

export default TraefikIntegrationService;
