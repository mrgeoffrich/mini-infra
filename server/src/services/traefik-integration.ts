import { servicesLogger } from "../lib/logger-factory";
import {
  TraefikConfig,
  ContainerConfig,
} from "@mini-infra/types";

// ====================
// Traefik Integration Types (Minimal for Stub)
// ====================

export interface TrafficSwitchOptions {
  applicationName: string;
  fromContainerId: string;
  toContainerId: string;
  traefikConfig: TraefikConfig;
  gradual?: boolean;
  healthCheckUrl?: string;
}

// ====================
// Traefik Integration Service (Stubbed)
// ====================

/**
 * TraefikIntegrationService - Stubbed implementation
 *
 * This is a minimal stub that replaces the full Traefik integration service.
 * All operations are logged but no actual Traefik configuration is performed.
 *
 * This stub maintains the same interface as the original service to prevent
 * breaking changes in the deployment orchestrator while the service is being
 * replaced with a new implementation.
 */
export class TraefikIntegrationService {

  constructor() {
    servicesLogger().info("TraefikIntegrationService initialized as stub - no Traefik operations will be performed");
  }

  /**
   * Stub: Switch traffic between blue and green containers
   */
  async switchTraffic(options: TrafficSwitchOptions): Promise<void> {
    servicesLogger().info(
      {
        applicationName: options.applicationName,
        fromContainerId: options.fromContainerId,
        toContainerId: options.toContainerId,
        gradual: options.gradual || false,
      },
      "Traefik traffic switching stubbed - no operation performed"
    );

    // Simulate brief delay as if performing operation
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Stub: Update container labels (Docker labels are immutable after creation)
   */
  async updateContainerLabels(
    containerId: string,
    labels: Record<string, string>,
  ): Promise<void> {
    servicesLogger().info(
      {
        containerId,
        labelsCount: Object.keys(labels).length,
        sampleLabels: Object.keys(labels).slice(0, 3),
      },
      "Traefik container label update stubbed - no operation performed"
    );

    // Simulate brief delay as if performing operation
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export default TraefikIntegrationService;